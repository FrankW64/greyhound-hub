'use strict';

/**
 * Racing Post greyhound tips scraper using Puppeteer.
 *
 * greyhoundbet.racingpost.com is a JavaScript-rendered app whose data API
 * returns 406 to plain HTTP requests (requires a browser session cookie).
 * Puppeteer renders the page fully, picks up the session, and lets us read
 * the rendered DOM.
 *
 * Strategy:
 *   1. Load the meeting list for today to get all race_ids.
 *   2. For each race, navigate to its tips tab.
 *   3. Extract trap number → position (1st/2nd/3rd) mappings.
 *   4. Match to runners in our race cards by trap number.
 *
 * Returns tip objects in the same shape as the other scrapers:
 *   { source, sourceName, dogName, venue, raceTime, trapNumber, position }
 *
 * Memory: uses system Chromium (chromium-browser) to avoid bundling a 300 MB
 * binary. Falls back to the puppeteer bundled executable if not found.
 */

const path = require('path');

// Lazy-require puppeteer so the app still starts if it isn't installed
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

// Paths where system Chromium is typically installed on Ubuntu
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
  return null; // puppeteer will use its bundled binary
}

/**
 * Launch a minimal Puppeteer browser.
 * Uses system Chromium if available to save disk/memory.
 */
async function launchBrowser() {
  const executablePath = findChromium();
  const opts = {
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process',            // reduces memory on 1 GB VPS
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

/**
 * Main entry point.
 * Returns an array of tip objects keyed by trapNumber (not dogName).
 * DataManager will match these to runners via trap number.
 */
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

    // Block images/fonts/media to speed up loading and save memory
    await page.setRequestInterception(true);
    page.on('request', req => {
      const type = req.resourceType();
      if (['image', 'font', 'media', 'stylesheet'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setViewport({ width: 1024, height: 768 });

    // ── Step 1: load the meeting list to get race IDs ─────────────────────────
    console.log('[RPScraper] Loading meeting list…');
    await page.goto(`${BASE_URL}/#meeting-list/r_date=${today}`, {
      waitUntil: 'networkidle2',
      timeout:   30000,
    });

    // Wait for race links to appear
    await page.waitForSelector('a[href*="race_id"]', { timeout: 15000 }).catch(() => {});

    // Extract all race_id → venue + time mappings from the page
    const raceLinks = await page.evaluate(() => {
      const links = [];
      document.querySelectorAll('a[href*="race_id"]').forEach(el => {
        const href  = el.getAttribute('href') || '';
        const m     = href.match(/race_id=(\d+)/);
        const rDate = href.match(/r_date=([\d-]+)/);
        if (!m) return;
        // Try to read venue and time from surrounding text
        const row   = el.closest('tr, li, div') || el;
        const text  = row.innerText || '';
        links.push({
          race_id: m[1],
          r_date:  rDate ? rDate[1] : '',
          context: text.slice(0, 100),
          href,
        });
      });
      return links;
    });

    // Deduplicate by race_id and filter to today
    const seen      = new Set();
    const todayRaces = raceLinks.filter(r => {
      if (seen.has(r.race_id) || (r.r_date && r.r_date !== today)) return false;
      seen.add(r.race_id);
      return true;
    });

    console.log(`[RPScraper] Found ${todayRaces.length} race IDs for ${today}`);
    if (!todayRaces.length) {
      await browser.close();
      return [];
    }

    // ── Step 2: visit each race's tips tab ────────────────────────────────────
    // Build the races_ids param from all IDs (used in the URL)
    const allIds    = todayRaces.map(r => r.race_id).join(',');

    for (const raceInfo of todayRaces) {
      const tipUrl = `${BASE_URL}/#card/race_id=${raceInfo.race_id}&r_date=${today}&tab=tips&races_ids=${allIds}`;

      try {
        await page.goto(tipUrl, { waitUntil: 'networkidle2', timeout: 25000 });

        // Wait for the tips tab content to render
        await page.waitForFunction(
          () => document.querySelector('.tab-tips, [class*="tab-tips"], [id*="tips"]') !== null ||
                document.querySelectorAll('img[src*="/trap/"]').length > 0,
          { timeout: 10000 }
        ).catch(() => {});

        // Extract tips from the rendered page
        const raceTips = await page.evaluate((raceId) => {
          const results = [];

          // Strategy 1: look for tip rows that show trap + position label
          // Racing Post typically shows a table: Trap | Dog | Position label
          const rows = document.querySelectorAll(
            '.tab-tips tr, [class*="tips"] tr, [class*="tip-row"], [class*="TipRow"]'
          );

          rows.forEach(row => {
            // Trap number: from trap image src (t1.gif, t2.gif etc)
            const trapImg = row.querySelector('img[src*="/trap/"]');
            const trap = trapImg
              ? parseInt((trapImg.getAttribute('src') || '').match(/t(\d)\.gif/)?.[1] || '0', 10)
              : 0;

            if (!trap || trap < 1 || trap > 6) return;

            // Dog name from the row text
            const dogName = (row.querySelector(
              '[class*="dog"], [class*="runner"], [class*="name"], td:nth-child(2)'
            ) || row).innerText.trim().split('\n')[0].trim();

            // Position label: look for 1st / 2nd / 3rd text
            const rowText = row.innerText || '';
            let position  = 1; // default win
            if (/\b(2nd|second)\b/i.test(rowText)) position = 2;
            else if (/\b(3rd|third)\b/i.test(rowText)) position = 3;
            else if (/\b(1st|first|win|nap)\b/i.test(rowText)) position = 1;

            results.push({ trap, dogName, position, raceId });
          });

          // Strategy 2: if no rows, look for trap images anywhere on the tips tab
          if (!results.length) {
            const tipsSection = document.querySelector(
              '.tab-tips, [class*="tab-tips"], #tips, [data-tab="tips"]'
            );
            if (tipsSection) {
              const imgs = tipsSection.querySelectorAll('img[src*="/trap/"]');
              imgs.forEach((img, i) => {
                const trap = parseInt((img.getAttribute('src') || '').match(/t(\d)\.gif/)?.[1] || '0', 10);
                if (!trap || trap < 1 || trap > 6) return;
                // Infer position from order (first = 1st, second = 2nd, third = 3rd)
                const position = i + 1 <= 3 ? i + 1 : 3;
                const container = img.closest('tr, li, div') || img;
                const dogName   = container.innerText.trim().split('\n')[0].trim();
                results.push({ trap, dogName, position, raceId });
              });
            }
          }

          return results;
        }, raceInfo.race_id);

        // Try to match to our known races using context from the link
        const matchedRace = matchRaceByContext(races, raceInfo.context, today);

        for (const t of raceTips) {
          // Find the runner in matched race by trap number
          const runner = matchedRace?.runners?.find(r => r.trap === t.trap);
          const dogName = runner?.name || t.dogName || `Trap ${t.trap}`;

          tips.push({
            source:      SOURCE,
            sourceName:  SOURCE_NAME,
            dogName,
            trapNumber:  t.trap,
            venue:       matchedRace?.venue || '',
            raceTime:    matchedRace?.time  || '',
            position:    t.position,
          });
        }

        console.log(`[RPScraper] Race ${raceInfo.race_id}: ${raceTips.length} tips`);

        // Small delay between races to be polite
        await new Promise(r => setTimeout(r, 500));

      } catch (err) {
        console.warn(`[RPScraper] Race ${raceInfo.race_id} failed: ${err.message}`);
      }
    }

  } catch (err) {
    console.error('[RPScraper] Fatal error:', err.message);
  } finally {
    if (browser) await browser.close();
  }

  console.log(`[RPScraper] Total tips extracted: ${tips.length}`);
  return tips;
}

/**
 * Try to match a Racing Post race (from link context text) to one of our
 * scraped races by venue name and/or time.
 */
function matchRaceByContext(races, contextText, today) {
  if (!races || !races.length || !contextText) return null;
  const text = contextText.toLowerCase();

  // Extract time from context (HH:MM)
  const timeMatch = text.match(/(\d{1,2})[:.h](\d{2})/);
  const time      = timeMatch
    ? `${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}`
    : '';

  // Try venue match + time match
  for (const race of races) {
    const venue = race.venue.toLowerCase();
    if (time && race.time === time && text.includes(venue)) return race;
  }
  // Time only
  if (time) {
    const byTime = races.filter(r => r.time === time);
    if (byTime.length === 1) return byTime[0];
  }
  return null;
}

module.exports = { scrapeRacingPostTips };
