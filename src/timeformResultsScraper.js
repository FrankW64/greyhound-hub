'use strict';

/**
 * timeformResultsScraper.js — scrapes full finishing positions from Timeform.
 *
 * Timeform results pages are server-side rendered and include all runners
 * (positions 1–6+) with trap, dog name, and run time for each race.
 *
 * URL patterns:
 *   Listing:  https://www.timeform.com/greyhound-racing/results/YYYY-MM-DD
 *   Race:     https://www.timeform.com/greyhound-racing/results/[venue]/[HHMM]/[date]/[id]
 *
 * Returns:
 *   allRunners: [{ raceDate, venue, raceTime, grade, distance, dogName, trap, position, runTime }]
 */

const axios   = require('axios');
const cheerio = require('cheerio');

const BASE = 'https://www.timeform.com';

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,*/*',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Cache-Control':   'no-cache',
};

async function fetchHtml(url, retries = 4, delayMs = 15000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const { data } = await axios.get(url, {
        headers:      HEADERS,
        timeout:      20000,
        maxRedirects: 5,
      });
      return data;
    } catch (err) {
      const status = err.response?.status;
      if (attempt < retries && (status === 429 || status === 503 || status === 502)) {
        const wait = delayMs * attempt; // 15s, 30s, 45s
        console.warn(`[TFResults] ${status} on attempt ${attempt}, retrying in ${wait / 1000}s…`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        throw err;
      }
    }
  }
}

// ── Venue slug → display name (mirrors racecardScraper) ───────────────────────

const SLUG_TO_VENUE = {
  'romford':        'Romford',
  'hove':           'Hove',
  'belle-vue':      'Belle Vue',
  'nottingham':     'Nottingham',
  'swindon':        'Swindon',
  'monmore':        'Monmore',
  'oxford':         'Oxford',
  'perry-barr':     'Perry Barr',
  'poole':          'Poole',
  'sheffield':      'Sheffield',
  'towcester':      'Towcester',
  'newcastle':      'Newcastle',
  'doncaster':      'Doncaster',
  'yarmouth':       'Yarmouth',
  'kinsley':        'Kinsley',
  'coventry':       'Coventry',
  'henlow':         'Henlow',
  'peterborough':   'Peterborough',
  'harlow':         'Harlow',
  'crayford':       'Crayford',
  'wimbledon':      'Wimbledon',
  'central-park':   'Central Park',
  'dunstall-park':  'Dunstall Park',
  'pelaw-grange':   'Pelaw Grange',
  'suffolk-downs':  'Suffolk Downs',
  'the-valley':     'The Valley',
  'valley':         'The Valley',
  'sunderland':     'Sunderland',
};

function slugToVenue(slug) {
  return SLUG_TO_VENUE[(slug || '').toLowerCase()] || '';
}

// ── Text extraction helpers ───────────────────────────────────────────────────

function normalise(str) {
  return (str || '').replace(/\s+/g, ' ').trim();
}

function extractDistance(text) {
  const m = (text || '').match(/\b(\d{3,4})\s*m\b/i);
  return m ? parseInt(m[1], 10) : null;
}

function extractGrade(text) {
  const m = (text || '').match(/\b([ASOHaosh]\d{1,2}|OR|OPEN|OA|S|H)\b/);
  return m ? m[1].toUpperCase() : null;
}

function normaliseTime(t) {
  if (!t) return '';
  const padded = t.padStart(4, '0');
  return `${padded.slice(0, 2)}:${padded.slice(2)}`;
}

// ── Step 1: fetch all race result URLs for a date ─────────────────────────────

async function fetchResultUrls(date) {
  const html = await fetchHtml(`${BASE}/greyhound-racing/results/${date}`);
  const $    = cheerio.load(html);
  const links = [];
  const seen  = new Set();

  $('a[href*="/greyhound-racing/results/"]').each((_, el) => {
    const href  = $(el).attr('href') || '';
    // Pattern: /greyhound-racing/results/venue-slug/HHMM/YYYY-MM-DD/raceId
    const match = href.match(
      /\/greyhound-racing\/results\/([^/]+)\/(\d{3,4})\/(\d{4}-\d{2}-\d{2})\/(\d+)/
    );
    if (!match) return;

    const [, venueSlug, timePart, d, raceId] = match;
    if (d !== date) return;

    const venue = slugToVenue(venueSlug);
    if (!venue) return;
    if (seen.has(raceId)) return;
    seen.add(raceId);

    links.push({
      url:    `${BASE}${href}`,
      venue,
      time:   normaliseTime(timePart),
      date,
      raceId,
    });
  });

  return links;
}

// ── Step 2: parse runners from a single race result page ──────────────────────

/**
 * Parse all runners from a race result page.
 *
 * Timeform results HTML confirmed structure (verified Apr 2026):
 *   Each runner has TWO rows:
 *     rrb-runner-details-1: trap image + dog name link (all runners in finishing order)
 *     rrb-runner-details-2: run time span + trainer name (all runners, same order)
 *
 *   The N in rrb-runner-details-N is the ROW TYPE (1=name row, 2=time row),
 *   NOT the finishing position.
 *
 * @returns {Array<{ position, trap, dogName, runTime }>}
 */
function parseRaceRunners($) {
  const runners = [];
  const seen    = new Set();

  // Collect dog name rows and run time rows (appear in finishing position order)
  const dogRows  = $('.rrb-runner-details-1').toArray();
  const timeRows = $('.rrb-runner-details-2').toArray();

  for (let i = 0; i < dogRows.length; i++) {
    const dogRow  = $(dogRows[i]);
    const timeRow = timeRows[i] ? $(timeRows[i]) : null;

    const trap    = parseInt(dogRow.find('img.rrb-trap').first().attr('alt') || '0', 10) || null;
    const dogName = normalise(dogRow.find('a.rrb-greyhound').first().text());

    if (!dogName || dogName.length < 2 || seen.has(dogName.toLowerCase())) continue;
    seen.add(dogName.toLowerCase());

    let runTime = null;
    if (timeRow) {
      timeRow.find('span[title="The official run time of the greyhound in this race"]').each((_, span) => {
        const val = parseFloat($(span).text().trim());
        if (!isNaN(val) && val > 10 && val < 100) runTime = val;
      });
    }

    runners.push({ position: i + 1, trap, dogName, runTime });
  }

  return runners;
}

// ── Step 3: fetch and parse a single race result page ────────────────────────

async function fetchRaceResult({ url, venue, time, date, raceId }) {
  try {
    const html = await fetchHtml(url);
    const $    = cheerio.load(html);

    // Extract grade and distance from page text
    const pageText = $('h1, [class*="race-header"], [class*="racecard-header"], [class*="race-title"]')
      .first().text();
    const bodyText = $('body').text();

    const grade    = extractGrade(pageText)    || extractGrade(bodyText);
    const distance = extractDistance(pageText) || extractDistance(bodyText);

    const rawRunners = parseRaceRunners($);
    if (!rawRunners.length) {
      console.warn(`[TFResults] No runners parsed for ${venue} ${time} (${raceId})`);
      return [];
    }

    return rawRunners.map(r => ({
      raceDate:  date,
      venue,
      raceTime:  time,
      grade:     grade || null,
      distance:  distance || null,
      dogName:   r.dogName,
      trap:      r.trap,
      position:  r.position,
      runTime:   r.runTime,
    }));
  } catch (err) {
    console.warn(`[TFResults] Race ${raceId} (${venue} ${time}) failed: ${err.message}`);
    return [];
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Fetch all runners with full finishing positions from Timeform for a given date.
 *
 * @param {string} date  YYYY-MM-DD
 * @returns {Promise<Array>}  allRunners in dog_run_history format
 */
async function fetchTimeformResults(date, { limit = null } = {}) {
  let raceLinks;
  try {
    raceLinks = await fetchResultUrls(date);
  } catch (err) {
    console.warn(`[TFResults] Listing page failed for ${date}: ${err.message}`);
    return [];
  }

  if (!raceLinks.length) {
    console.log(`[TFResults] No race URLs found for ${date}`);
    return [];
  }

  const racesToFetch = limit ? raceLinks.slice(0, limit) : raceLinks;
  console.log(`[TFResults] ${racesToFetch.length} races to fetch for ${date}${limit ? ` (limited from ${raceLinks.length})` : ''}`);

  const allRunners = [];

  // Sequential fetching with generous delay — Timeform rate-limits aggressive scrapers
  for (let i = 0; i < racesToFetch.length; i++) {
    const runners = await fetchRaceResult(racesToFetch[i]);
    allRunners.push(...runners);

    // Polite delay between every request — slow enough to avoid 429s
    if (i < racesToFetch.length - 1) {
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  console.log(`[TFResults] ${date}: ${allRunners.length} runners across ${raceLinks.length} races`);
  return allRunners;
}

module.exports = { fetchTimeformResults };
