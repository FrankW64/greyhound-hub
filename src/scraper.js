'use strict';

/**
 * Tips scraper — fetches free greyhound tips from public websites.
 *
 * Each scraper returns an array of tip objects:
 *   { source, sourceName, dogName, venue, raceTime }
 *
 * Sites are wrapped in try/catch so one failing scraper never crashes the app.
 */

const axios   = require('axios');
const cheerio = require('cheerio');

// ── Shared HTTP config ────────────────────────────────────────────────────────

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml',
  'Accept-Language': 'en-GB,en;q=0.9',
};

async function fetchHtml(url) {
  const { data } = await axios.get(url, {
    headers: HEADERS,
    timeout: 12000,
    maxRedirects: 5,
  });
  return data;
}

// ── Position extraction ───────────────────────────────────────────────────────

/**
 * Best-effort: detect a predicted finishing position from surrounding text.
 * Defaults to 1 (win selection) when no position marker is found.
 */
function extractPosition(text) {
  const t = (text || '').toLowerCase();
  if (/\b(nap|banker|1st|first|to win|win only|win tip)\b/.test(t)) return 1;
  if (/\b(2nd|second|nb\b|next best)\b/.test(t)) return 2;
  if (/\b(3rd|third|e\/w\b|each.way|ew\b|each way|place)\b/.test(t)) return 3;
  return 1; // default: assume win selection
}

// ── Source: Timeform (timeform.com) ───────────────────────────────────────────

async function scrapeTimeform() {
  const SOURCE      = 'timeform';
  const SOURCE_NAME = 'Timeform';
  const tips = [];

  try {
    // Timeform's greyhound tips page lists today's selections with race details
    const html = await fetchHtml('https://www.timeform.com/greyhound-racing/tips');
    const $ = cheerio.load(html);

    // Timeform typically renders tips in a structured list/table.
    // Each row contains the meeting, race time, and selected dog.
    $('tr.tips-row, div.tips-list__item, [data-component="tip-card"], .tf-tips__row').each((_, el) => {
      const row      = $(el);
      const venue    = normalise(row.find('.tips-meeting, .meeting-name, [class*="meeting"]').first().text());
      const time     = normalise(row.find('.tips-time, .race-time, [class*="time"]').first().text());
      const dogName  = normalise(row.find('.tips-selection, .dog-name, [class*="selection"], [class*="runner"]').first().text());
      const position = extractPosition(row.text());

      if (dogName && dogName.length > 2) {
        tips.push({ source: SOURCE, sourceName: SOURCE_NAME, dogName, venue, raceTime: formatTime(time), position });
      }
    });

    // Fallback: scan for JSON data embedded in the page
    if (!tips.length) {
      $('script[type="application/json"], script[id*="tip"], script[id*="data"]').each((_, el) => {
        try {
          const json = JSON.parse($(el).html());
          extractTipsFromJson(json, SOURCE, SOURCE_NAME, tips);
        } catch (_) {}
      });
    }

    // Second fallback: look for any anchors or spans with greyhound-style names
    if (!tips.length) {
      $('a[href*="greyhound"], [class*="tip"] [class*="name"], [class*="runner-name"]').each((_, el) => {
        const dogName = normalise($(el).text());
        if (looksLikeDogName(dogName)) {
          const ctx      = $(el).closest('[class*="race"], [class*="tip"], tr').first();
          const venue    = extractVenueFromText(ctx.text());
          const raceTime = extractTimeFromText(ctx.text());
          const position = extractPosition(ctx.text());
          tips.push({ source: SOURCE, sourceName: SOURCE_NAME, dogName, venue, raceTime, position });
        }
      });
    }

    console.log(`[Scraper] ${SOURCE_NAME}: found ${tips.length} tips`);
  } catch (err) {
    console.warn(`[Scraper] ${SOURCE_NAME} failed: ${err.message}`);
  }

  return tips;
}

// ── Aggregator ────────────────────────────────────────────────────────────────

/**
 * races parameter is optional — passed through to the Racing Post Puppeteer
 * scraper so it can match tips by trap number back to dog names.
 */
async function fetchAllTips(races) {
  const allTips = [];

  // OLBG uses plain axios — always run it
  const { scrapeOlbgTips } = require('./olbgScraper');
  const olbgTips = await scrapeOlbgTips().catch(err => {
    console.warn('[Scraper] OLBG failed:', err.message);
    return [];
  });
  allTips.push(...olbgTips);

  // RP scraper uses Puppeteer — skip on resource-constrained servers
  if (process.env.SKIP_RP_TIPS !== 'true') {
    const { scrapeRacingPostTips } = require('./racingPostScraper');
    const rpTips = await scrapeRacingPostTips(races || []).catch(err => {
      console.warn('[Scraper] RP failed:', err.message);
      return [];
    });
    allTips.push(...rpTips);
  }

  return allTips;
}

// ── Text-extraction helpers ───────────────────────────────────────────────────

function normalise(str) {
  return (str || '').replace(/\s+/g, ' ').trim();
}

function formatTime(str) {
  const m = str.match(/(\d{1,2})[:.h](\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : str;
}

const UK_VENUES = [
  'Romford','Wimbledon','Crayford','Hove','Belle Vue','Nottingham',
  'Swindon','Monmore','Oxford','Perry Barr','Poole','Sheffield',
  'Towcester','Newcastle','Doncaster','Yarmouth','Kinsley',
];

function extractVenueFromText(text) {
  for (const v of UK_VENUES) {
    if (text.toLowerCase().includes(v.toLowerCase())) return v;
  }
  return '';
}

function extractTimeFromText(text) {
  const m = text.match(/\b(\d{1,2})[:.h](\d{2})\b/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : '';
}

function extractDogNameFromText(text) {
  // Greyhound names are typically TitleCase multi-word strings (2–4 words)
  const m = text.match(/\b([A-Z][a-z]+(?:\s[A-Z][a-z]+){1,3})\b/);
  return m ? m[1].trim() : '';
}

function looksLikeDogName(str) {
  // Must be 2+ words, each capitalised, total length reasonable
  return /^[A-Z][a-z]+(\s[A-Z][a-z]+)+$/.test(str) && str.length > 4 && str.length < 50;
}

function extractTipsFromJson(json, source, sourceName, tips) {
  if (!json || typeof json !== 'object') return;
  if (Array.isArray(json)) {
    json.forEach(item => extractTipsFromJson(item, source, sourceName, tips));
    return;
  }
  const candidate = String(json.name || json.selection || json.runner || json.headline || '');
  const dogName   = extractDogNameFromText(candidate);
  if (dogName) {
    const venue = extractVenueFromText(JSON.stringify(json));
    const time  = extractTimeFromText(JSON.stringify(json));
    tips.push({ source, sourceName, dogName, venue, raceTime: time });
  }
  // Recurse into child arrays/objects
  for (const val of Object.values(json)) {
    if (val && typeof val === 'object') extractTipsFromJson(val, source, sourceName, tips);
  }
}

module.exports = { fetchAllTips };
