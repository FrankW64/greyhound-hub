'use strict';

/**
 * MyRacing / Racing Post tips scraper.
 *
 * Source: https://myracing.com/free-greyhound-tips/
 *
 * Each race on myracing.com embeds the standard Racing Post verdict widget:
 *   <div class="rpf-verdict-selection">
 *     <b class="rpf-verdict-selection-prediction">1.</b>
 *     <img class="rpf-verdict-selection-trap" alt="3">
 *     <div class="rpf-verdict-selection-name"><a>DOG NAME</a></div>
 *   </div>
 *
 * The position label (1. / 2. / 3.) maps directly to win / forecast / tricast.
 * The 1st pick is sometimes only in the verdict text; we match it against runners.
 *
 * Strategy:
 *   1. Fetch listing page → extract today's racecard URLs + venue + time.
 *   2. Batch-fetch each racecard page (4 concurrent).
 *   3. Parse runners + verdict from each page.
 *   4. Emit one tip per position (1/2/3) per race.
 *
 * Server-side rendered HTML — no Puppeteer needed.
 */

const axios   = require('axios');
const cheerio = require('cheerio');

const SOURCE      = 'racingpost';
const SOURCE_NAME = 'Racing Post';
const BASE_URL    = 'https://myracing.com';
const LISTING_URL = `${BASE_URL}/free-greyhound-tips/`;

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
};

const TODAY = () => new Date().toISOString().split('T')[0];

async function fetchHtml(url) {
  const { data } = await axios.get(url, { headers: HEADERS, timeout: 12000 });
  return data;
}

// ── Main entry point ──────────────────────────────────────────────────────────

async function scrapeMyRacingTips() {
  const tips  = [];
  const today = TODAY();

  try {
    console.log('[MyRacing] Fetching tips listing…');
    const listHtml  = await fetchHtml(LISTING_URL);
    const racecards = extractRacecardLinks(listHtml, today);
    console.log(`[MyRacing] ${racecards.length} racecards found for ${today}`);

    if (!racecards.length) {
      console.log('[MyRacing] No racecards — tips may not be published yet');
      return [];
    }

    // Batch-fetch racecard pages 4 at a time
    const CONCURRENCY = 4;
    for (let i = 0; i < racecards.length; i += CONCURRENCY) {
      const batch = racecards.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async rc => {
        try {
          const html    = await fetchHtml(rc.url);
          const verdicts = parseVerdicts(html);
          for (const v of verdicts) {
            tips.push({
              source:     SOURCE,
              sourceName: SOURCE_NAME,
              dogName:    v.dogName,
              venue:      rc.venue,
              raceTime:   rc.time,
              position:   v.position,
            });
          }
        } catch (err) {
          console.warn(`[MyRacing] Failed ${rc.url}: ${err.message}`);
        }
      }));
    }

    console.log(`[MyRacing] ${tips.length} tips extracted`);
  } catch (err) {
    console.warn(`[MyRacing] Listing fetch failed: ${err.message}`);
  }

  return tips;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract all today's racecard URLs from the listing page.
 * URL pattern: /greyhounds/racecards/{raceId}/{date}/{venueId}/{HH:MM}/
 * Venue name comes from the schema.org JSON-LD or link text.
 */
function extractRacecardLinks(html, today) {
  const $    = cheerio.load(html);
  const seen = new Set();
  const out  = [];

  // Build venue map from schema.org blocks keyed by URL
  const schemaByUrl = {};
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = JSON.parse($(el).html());
      const arr = Array.isArray(raw) ? raw : [raw];
      for (const item of arr) {
        if (item['@type'] === 'SportsEvent' && item.url) {
          schemaByUrl[item.url] = item;
        }
      }
    } catch (_) {}
  });

  const re = new RegExp(`/greyhounds/racecards/(\\d+)/${today}/(\\d+)/([\\d:]+)/?$`);

  $('a[href]').each((_, el) => {
    const href    = $(el).attr('href') || '';
    const m       = href.match(re);
    if (!m) return;

    const timeRaw = m[3];
    const time    = normaliseTime(timeRaw);
    const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;

    if (seen.has(fullUrl)) return;
    seen.add(fullUrl);

    // Venue: try schema first, then strip time from schema name, then link text
    const schema = schemaByUrl[fullUrl] || schemaByUrl[href];
    let venue    = schema?.location?.name
                || (schema?.name || '').replace(/^\d{1,2}:\d{2}\s*/, '').trim()
                || $(el).text().replace(/^\d{1,2}:\d{2}\s*/, '').trim();

    if (!time || !venue) return;
    out.push({ url: fullUrl, venue, time });
  });

  return out;
}

/**
 * Parse the RP verdict widget from a racecard page.
 * Returns [{ position, dogName }] for positions 1, 2, 3.
 *
 * Widget structure:
 *   <div class="rpf-verdict-selection">
 *     <b class="rpf-verdict-selection-prediction">2.</b>
 *     <img class="rpf-verdict-selection-trap" alt="5">
 *     <div class="rpf-verdict-selection-name"><a>DOG NAME</a></div>
 *   </div>
 *
 * Position 1 is sometimes only in the verdict text — we find it by matching
 * runner names that appear in the text but weren't listed in the structured picks.
 */
function parseVerdicts(html) {
  const $       = cheerio.load(html);
  const results = [];
  const pickedNorm = new Set();

  // ── Structured picks (typically 2nd and 3rd, sometimes all three) ──────────
  $('.rpf-verdict-selection').each((_, el) => {
    const predText = $(el).find('b.rpf-verdict-selection-prediction').text().trim();
    const position = parseInt(predText, 10);
    if (!position || position > 3) return;

    const dogName = norm($(el).find('.rpf-verdict-selection-name a').text());
    if (!dogName) return;

    results.push({ position, dogName });
    pickedNorm.add(normKey(dogName));
  });

  // ── Fallback: find 1st pick from verdict prose text ───────────────────────
  const hasFirst = results.some(r => r.position === 1);
  if (!hasFirst) {
    // Collect all runner names on the page from trap rows
    const runners = [];
    $('a.rpb-greyhound, a[class*="rpb-greyhound"], .rpf-verdict-selection-name a').each((_, el) => {
      const name = norm($(el).text());
      if (name && !runners.includes(name)) runners.push(name);
    });

    const verdictText = ($('.rpf-verdict').text() || '').toLowerCase();
    if (verdictText) {
      for (const name of runners) {
        if (pickedNorm.has(normKey(name))) continue;
        if (verdictText.includes(name.toLowerCase())) {
          results.push({ position: 1, dogName: name });
          break;
        }
      }
    }
  }

  return results;
}

function norm(str) {
  return (str || '').replace(/\s+/g, ' ').trim();
}

function normKey(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normaliseTime(t) {
  const m = (t || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : t;
}

module.exports = { scrapeMyRacingTips };
