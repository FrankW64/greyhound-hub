'use strict';

/**
 * Racing Post greyhound tips scraper.
 *
 * Strategy:
 *   1. Load the meeting list page → intercept /meeting/blocks.sd response
 *      which contains all meetings and their race IDs grouped by venue.
 *   2. For each meeting, navigate to its tips tab:
 *        #card/race_id={firstRaceId}&r_date={today}&tab=tips&races_ids={meetingRaceIds}
 *      and intercept the /card/blocks.sd?...tab=tips response.
 *   3. Accumulate tips from every meeting's API response.
 *   4. Parse each entry: first/second/third are trap numbers.
 *      Match to our Timeform race cards by time to look up dog names.
 *
 * The key fix vs the old scraper: previously we used ALL race IDs from
 * every venue in a single request — the API only returns tips for the
 * meeting that race_id belongs to, so most venues got skipped.
 * Now we make one request per meeting so every venue is covered.
 */

let puppeteer;
try { puppeteer = require('puppeteer'); } catch (_) { puppeteer = null; }

const SOURCE      = 'racingpost';
const SOURCE_NAME = 'Racing Post';
const BASE_URL    = 'https://greyhoundbet.racingpost.com';
const TODAY       = () => new Date().toISOString().split('T')[0];

const CHROMIUM_PATHS = [
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
];

function findChromium() {
  const fs = require('fs');
  for (const p of CHROMIUM_PATHS) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return null;
}

async function launchBrowser() {
  const executablePath = findChromium();
  const opts = {
    headless: 'new',
    protocolTimeout: 60000,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--no-zygote', '--disable-extensions',
      '--disable-background-networking', '--disable-default-apps',
      '--mute-audio', '--no-first-run',
    ],
  };
  if (executablePath) {
    opts.executablePath = executablePath;
    console.log(`[RPScraper] Using system Chromium: ${executablePath}`);
  }
  return puppeteer.launch(opts);
}

// ── Main entry point ──────────────────────────────────────────────────────────

async function scrapeRacingPostTips(races) {
  if (!puppeteer) {
    console.warn('[RPScraper] puppeteer not installed — skipping Racing Post tips');
    return [];
  }

  const tips  = [];
  const today = TODAY();
  let browser;

  try {
    browser = await launchBrowser();
    const page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-GB,en;q=0.9' });

    await page.setRequestInterception(true);
    page.on('request', req => {
      if (['image', 'font', 'media'].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    // ── Step 1: Load meeting list — captures meeting JSON + session cookies ─────
    let meetingJson    = null;
    const allTipsJsons = [];

    page.on('response', async resp => {
      try {
        if (resp.url().includes('/meeting/blocks.sd')) {
          meetingJson = JSON.parse(await resp.text());
        }
      } catch (_) {}
    });

    const meetingListUrl = `${BASE_URL}/#meeting-list/r_date=${today}`;
    console.log('[RPScraper] Loading meeting list…');
    await page.goto(meetingListUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await waitForCondition(() => meetingJson !== null, 10000).catch(() => {});

    // ── Step 2: Extract race IDs grouped by meeting ──────────────────────────
    const meetingGroups = extractMeetingGroups(meetingJson);
    console.log(`[RPScraper] ${meetingGroups.length} meetings found`);

    if (!meetingGroups.length) {
      console.warn('[RPScraper] No meeting groups found — aborting');
      return [];
    }

    // ── Step 3: Fetch tips for each meeting via direct API call ──────────────
    // Rather than relying on SPA navigation (which only triggers the API for
    // some meetings due to caching), we call the tips endpoint directly using
    // fetch() from within the page context.  This uses the browser's session
    // cookies so auth/CSRF works automatically.
    //
    // We try three candidate URL paths in order, stopping at the first 200 OK
    // that returns tip data.  The first successful call reveals which path the
    // RP site actually uses; subsequent calls reuse the same path.
    const TIPS_PATHS = [
      '/card/blocks.sd',
      '/api/card/blocks.sd',
      '/greyhound-racing/card/blocks.sd',
    ];
    let workingPath = null;

    for (const group of meetingGroups) {
      const { name, raceIds } = group;
      if (!raceIds.length) continue;

      const firstId = raceIds[0];
      let gotTips   = false;

      const pathsToTry = workingPath ? [workingPath] : TIPS_PATHS;

      for (const path of pathsToTry) {
        const apiUrl = `${BASE_URL}${path}?race_id=${firstId}&r_date=${today}&tab=tips&races_ids=${raceIds.join(',')}`;

        const result = await page.evaluate(async (url) => {
          try {
            const r = await fetch(url, { credentials: 'include' });
            if (!r.ok) return { status: r.status, data: null };
            const data = await r.json();
            return { status: r.status, data };
          } catch (e) { return { status: 0, data: null }; }
        }, apiUrl);

        if (result?.data?.tips) {
          allTipsJsons.push(result.data);
          if (!workingPath) workingPath = path;
          gotTips = true;
          break;
        } else {
          console.log(`[RPScraper] ${name}: path ${path} → status ${result?.status}`);
        }
      }

      console.log(`[RPScraper] ${name}: ${gotTips ? 'got tips' : 'no tips'}`);
    }

    console.log(`[RPScraper] ${allTipsJsons.length} tip responses from ${meetingGroups.length} meetings`);

    // ── Step 4: Parse all accumulated tip responses ───────────────────────────
    for (const json of allTipsJsons) {
      // Handle both { tips: { tips: [...] } } and { tips: [...] } structures
      const tipEntries = Array.isArray(json.tips?.tips) ? json.tips.tips
                       : Array.isArray(json.tips)       ? json.tips
                       : [];

      for (const entry of tipEntries) {
        const first    = parseInt(entry.first,  10) || 0;
        const second   = parseInt(entry.second, 10) || 0;
        const third    = parseInt(entry.third,  10) || 0;
        const dogName  = (entry.dog_name || '').trim();
        const raceTime = normaliseTime(entry.race_time_24 || entry.race_time || '');

        if (!first && !second && !third) continue;

        const matchedRace = findMatchingRace(races, raceTime, dogName);
        if (!matchedRace) {
          console.log(`[RPScraper] No race match: time=${raceTime} dog=${dogName}`);
        }

        const runnerName = trap => {
          if (!trap || !matchedRace) return '';
          return matchedRace.runners?.find(r => r.trap === trap)?.name || '';
        };

        if (first > 0) {
          const name = runnerName(first) || dogName;
          if (name) tips.push({ source: SOURCE, sourceName: SOURCE_NAME, dogName: name, trapNumber: first, venue: matchedRace?.venue || '', raceTime, position: 1 });
        }
        if (second > 0) {
          const name = runnerName(second);
          if (name) tips.push({ source: SOURCE, sourceName: SOURCE_NAME, dogName: name, trapNumber: second, venue: matchedRace?.venue || '', raceTime, position: 2 });
        }
        if (third > 0) {
          const name = runnerName(third);
          if (name) tips.push({ source: SOURCE, sourceName: SOURCE_NAME, dogName: name, trapNumber: third, venue: matchedRace?.venue || '', raceTime, position: 3 });
        }
      }
    }

    console.log(`[RPScraper] Total tips extracted: ${tips.length}`);

  } catch (err) {
    console.error('[RPScraper] Fatal error:', err.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  return tips;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Walk the meeting JSON and extract groups of race IDs, one array per meeting.
 * Tries multiple known RP JSON structures with fallback to flat chunking.
 */
function extractMeetingGroups(meetingJson) {
  if (!meetingJson) return [];

  const groups = [];

  // Walk looking for objects that have both a name-like field and a races array
  function walk(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 12) return;
    if (Array.isArray(obj)) { obj.forEach(i => walk(i, depth + 1)); return; }

    // Candidate: has a races/race_list array containing objects with race_id
    const racesArr = obj.races || obj.race_list || obj.raceList || obj.cards;
    if (Array.isArray(racesArr) && racesArr.length > 0) {
      const ids = racesArr
        .map(r => String(r.race_id || r.raceId || ''))
        .filter(Boolean);
      if (ids.length > 0) {
        const name = obj.track_name || obj.trackName || obj.name ||
                     obj.meeting_name || obj.meetingName || `Meeting-${groups.length + 1}`;
        groups.push({ name: String(name), raceIds: ids });
        return; // don't recurse further into this meeting
      }
    }

    Object.values(obj).forEach(v => {
      if (v && typeof v === 'object') walk(v, depth + 1);
    });
  }

  walk(meetingJson, 0);

  // Fallback: if we found NO groups but DO have race IDs, chunk them
  if (!groups.length) {
    const allIds = [];
    const extract = obj => {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) { obj.forEach(extract); return; }
      if (obj.raceId)  allIds.push(String(obj.raceId));
      if (obj.race_id) allIds.push(String(obj.race_id));
      Object.values(obj).forEach(v => { if (v && typeof v === 'object') extract(v); });
    };
    extract(meetingJson);
    const unique = [...new Set(allIds)];
    console.log(`[RPScraper] Fallback: chunking ${unique.length} race IDs into meetings of 10`);
    for (let i = 0; i < unique.length; i += 10) {
      groups.push({ name: `Chunk-${Math.floor(i / 10) + 1}`, raceIds: unique.slice(i, i + 10) });
    }
  }

  return groups;
}

/** Poll until condition() returns truthy or timeout ms elapses. */
function waitForCondition(condition, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const start    = Date.now();
    const interval = setInterval(() => {
      if (condition()) { clearInterval(interval); resolve(); }
      else if (Date.now() - start >= timeout) { clearInterval(interval); reject(new Error('timeout')); }
    }, 200);
  });
}

/** Normalise race time to HH:MM. */
function normaliseTime(t) {
  const m = (t || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : t;
}

/** Match a RP tip to one of our Timeform race cards by time (+ dog name to disambiguate). */
function findMatchingRace(races, raceTime, dogName) {
  if (!races?.length || !raceTime) return null;
  const byTime = races.filter(r => r.time === raceTime);
  if (!byTime.length) return null;
  if (byTime.length === 1) return byTime[0];
  if (dogName) {
    const norm = dogName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const hit  = byTime.find(r => r.runners?.some(ru => ru.name.toLowerCase().replace(/[^a-z0-9]/g, '') === norm));
    if (hit) return hit;
  }
  return byTime[0];
}

module.exports = { scrapeRacingPostTips };
