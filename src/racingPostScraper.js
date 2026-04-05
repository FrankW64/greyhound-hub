'use strict';

/**
 * Racing Post greyhound tips scraper.
 *
 * greyhoundbet.racingpost.com is a jQuery SPA whose tips data is fetched from
 * a JSON endpoint:
 *   /card/blocks.sd?race_id=X&r_date=Y&tab=tips&races_ids=A,B,C&blocks=...tips
 *
 * That endpoint returns 406 to plain HTTP (requires a browser session cookie
 * set by JS), so we use Puppeteer to establish the session and then intercept
 * the API response directly — no DOM parsing needed.
 *
 * Strategy:
 *   1. Load the meeting list page → waits for /meeting/blocks.sd response
 *      which contains all race IDs for today.
 *   2. Navigate to any race's tips tab with ALL race IDs in races_ids.
 *   3. Intercept the /card/blocks.sd?...tab=tips response.
 *   4. Parse the JSON: tips[].{first, second, third} are trap numbers for
 *      1st/2nd/3rd predicted finishers. race_time_24 is the race time.
 *   5. Match to our race cards by time; look up runner names by trap number.
 */

let puppeteer;
try {
  puppeteer = require('puppeteer');
} catch (_) {
  puppeteer = null;
}

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
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--mute-audio',
      '--no-first-run',
    ],
  };
  if (executablePath) {
    opts.executablePath = executablePath;
    console.log(`[RPScraper] Using system Chromium: ${executablePath}`);
  }
  return puppeteer.launch(opts);
}

// ── Main entry point ────────────────────────────────────────────────────────

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

    // Realistic browser headers to avoid bot detection
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-GB,en;q=0.9' });

    // Block images/fonts/media to save memory and bandwidth
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (['image', 'font', 'media'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // ── Step 1: Intercept the meeting list API to get all race IDs ───────────
    let meetingJson = null;
    let tipsJson    = null;

    page.on('response', async resp => {
      const url = resp.url();
      try {
        if (url.includes('/meeting/blocks.sd')) {
          meetingJson = JSON.parse(await resp.text());
        } else if (url.includes('/card/blocks.sd') && url.includes('tab=tips')) {
          tipsJson = JSON.parse(await resp.text());
        }
      } catch (_) {}
    });

    console.log('[RPScraper] Loading meeting list…');
    await page.goto(`${BASE_URL}/#meeting-list/r_date=${today}`, {
      waitUntil: 'domcontentloaded',
      timeout:   30000,
    });

    // Wait for the meeting API call to complete
    await waitForCondition(() => meetingJson !== null, 10000).catch(() => {});

    // ── Step 2: Extract all race IDs ─────────────────────────────────────────

    let allRaceIds = [];

    if (meetingJson) {
      // Recursively extract all raceId / race_id values from meeting JSON
      const extract = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) { obj.forEach(extract); return; }
        if (obj.raceId)  allRaceIds.push(String(obj.raceId));
        if (obj.race_id) allRaceIds.push(String(obj.race_id));
        Object.values(obj).forEach(v => { if (v && typeof v === 'object') extract(v); });
      };
      extract(meetingJson);
      allRaceIds = [...new Set(allRaceIds)];
      console.log(`[RPScraper] ${allRaceIds.length} race IDs from meeting API`);
    }

    // DOM fallback if the meeting API didn't give us IDs
    if (!allRaceIds.length) {
      allRaceIds = await page.evaluate(() =>
        [...new Set(
          [...document.querySelectorAll('a[href*="race_id"]')]
            .map(a => (a.getAttribute('href') || '').match(/race_id=(\d+)/)?.[1])
            .filter(Boolean)
        )]
      ).catch(() => []);
      console.log(`[RPScraper] ${allRaceIds.length} race IDs from DOM fallback`);
    }

    if (!allRaceIds.length) {
      console.warn('[RPScraper] No race IDs found — aborting');
      await browser.close();
      return [];
    }

    // ── Step 3: Load tips page — API returns tips for all races_ids ──────────
    console.log(`[RPScraper] Fetching tips for ${allRaceIds.length} races…`);
    const firstId    = allRaceIds[0];
    const racesParam = allRaceIds.join(',');
    const tipUrl     = `${BASE_URL}/#card/race_id=${firstId}&r_date=${today}&tab=tips&races_ids=${racesParam}`;

    await page.goto(tipUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for the tips API response
    await waitForCondition(() => tipsJson !== null, 15000).catch(() => {});

    if (!tipsJson) {
      console.warn('[RPScraper] No tips API response received');
      await browser.close();
      return [];
    }

    // ── Step 4: Parse the JSON response ──────────────────────────────────────
    const tipEntries = tipsJson.tips?.tips || [];
    console.log(`[RPScraper] ${tipEntries.length} tip entries from API`);

    for (const entry of tipEntries) {
      const first   = parseInt(entry.first,  10) || 0;
      const second  = parseInt(entry.second, 10) || 0;
      const third   = parseInt(entry.third,  10) || 0;
      const dogName = (entry.dog_name || '').trim();
      const raceTime = normaliseTime(entry.race_time_24 || entry.race_time || '');

      if (!first && !second && !third) continue; // no tip for this race

      // Match to our Timeform race card by time (+ dog name for disambiguation)
      const matchedRace = findMatchingRace(races, raceTime, dogName);

      const runnerName = (trap) => {
        if (!trap || !matchedRace) return '';
        return matchedRace.runners?.find(r => r.trap === trap)?.name || '';
      };

      if (first > 0) {
        tips.push({
          source:     SOURCE,
          sourceName: SOURCE_NAME,
          dogName:    runnerName(first) || dogName,
          trapNumber: first,
          venue:      matchedRace?.venue || '',
          raceTime,
          position:   1,
        });
      }
      if (second > 0) {
        tips.push({
          source:     SOURCE,
          sourceName: SOURCE_NAME,
          dogName:    runnerName(second),
          trapNumber: second,
          venue:      matchedRace?.venue || '',
          raceTime,
          position:   2,
        });
      }
      if (third > 0) {
        tips.push({
          source:     SOURCE,
          sourceName: SOURCE_NAME,
          dogName:    runnerName(third),
          trapNumber: third,
          venue:      matchedRace?.venue || '',
          raceTime,
          position:   3,
        });
      }
    }

    console.log(`[RPScraper] Total tips extracted: ${tips.length}`);

  } catch (err) {
    console.error('[RPScraper] Fatal error:', err.message);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }

  return tips;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Poll until condition() returns truthy or timeout ms elapses. */
function waitForCondition(condition, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const start    = Date.now();
    const interval = setInterval(() => {
      if (condition()) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - start >= timeout) {
        clearInterval(interval);
        reject(new Error('waitForCondition timed out'));
      }
    }, 200);
  });
}

/** Normalise race time to HH:MM (zero-pad single-digit hours). */
function normaliseTime(t) {
  const m = (t || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return t;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

/**
 * Match a Racing Post tip entry to one of our Timeform race cards.
 * Primary key: raceTime (HH:MM). Disambiguate by dog name if needed.
 */
function findMatchingRace(races, raceTime, dogName) {
  if (!races?.length || !raceTime) return null;

  const byTime = races.filter(r => r.time === raceTime);
  if (!byTime.length) return null;
  if (byTime.length === 1) return byTime[0];

  // Multiple races at same time — try dog name
  if (dogName) {
    const norm = dogName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const hit  = byTime.find(race =>
      race.runners?.some(r => r.name.toLowerCase().replace(/[^a-z0-9]/g, '') === norm)
    );
    if (hit) return hit;
  }

  return byTime[0];
}

module.exports = { scrapeRacingPostTips };
