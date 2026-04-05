'use strict';

/**
 * At The Races greyhound verdict scraper.
 *
 * The ATR tips listing page (/tips) is blocked by Fastly bot protection.
 * Individual racecard pages load fine with Puppeteer.
 *
 * Strategy:
 *   1. Receive today's races (already scraped from Timeform) as input.
 *   2. Construct an ATR racecard URL for each race using venue + date + time.
 *      URL format: /racecard/GB/{venue}/{DD-Month-YYYY}/{HHMM}
 *   3. Open ONE browser, reuse a single page, navigate to each racecard URL.
 *   4. Wait for React to hydrate, parse the "1st-2nd-3rd:" verdict section.
 *   5. Return tip objects with source='attheraces'.
 *
 * Confirmed verdict HTML structure (from atrVerdictDebug.js output):
 *   <h3 class="font-bold">1st-2nd-3rd:</h3>
 *   <div>
 *     <div class="flex bg-brand-navy">           ← one pick row per position
 *       <!-- position badge -->
 *       <span class="type-heading-b">1</span>
 *       <!-- trap circle -->
 *       <span data-theme="trap-2">2</span>
 *       <!-- dog name -->
 *       <h3 class="inline type-heading-e"><span>Salacres Tipster</span></h3>
 *     </div>
 *     ... repeated for 2nd and 3rd
 *   </div>
 */

let puppeteer;
try { puppeteer = require('puppeteer'); } catch (_) { puppeteer = null; }

const SOURCE      = 'attheraces';
const SOURCE_NAME = 'At The Races';
const BASE_URL    = 'https://greyhounds.attheraces.com';

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
    console.log(`[ATRScraper] Using system Chromium: ${executablePath}`);
  }
  return puppeteer.launch(opts);
}

// ── URL construction ──────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

/**
 * Build an ATR racecard URL from a race object.
 * race.date = "YYYY-MM-DD", race.time = "HH:MM", race.venue = "Towcester"
 * → https://greyhounds.attheraces.com/racecard/GB/towcester/05-April-2026/1743
 */
function buildAtrUrl(race) {
  const venueSlug = (race.venue || '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');

  const [year, month, day] = (race.date || '').split('-');
  if (!year || !month || !day) return null;

  const monthName = MONTH_NAMES[parseInt(month, 10) - 1];
  if (!monthName) return null;

  const dateStr = `${day}-${monthName}-${year}`;
  const timeStr = (race.time || '').replace(':', '');

  if (!venueSlug || !timeStr) return null;

  return `${BASE_URL}/racecard/GB/${venueSlug}/${dateStr}/${timeStr}`;
}

// ── Verdict page parser (runs inside page.evaluate) ──────────────────────────

function parseVerdictFromPage() {
  const results = [];

  // Find the "1st-2nd-3rd:" heading
  const header = [...document.querySelectorAll('h3')]
    .find(h => h.textContent.trim() === '1st-2nd-3rd:');

  if (!header) return results;

  // Picks container is the next sibling element
  const picksContainer = header.nextElementSibling;
  if (!picksContainer) return results;

  // Each pick row has bg-brand-navy in its classes
  const pickRows = [...picksContainer.querySelectorAll('div')]
    .filter(d => typeof d.className === 'string' && d.className.includes('bg-brand-navy'));

  for (const row of pickRows) {
    // Position: span.type-heading-b — contains "1", "2", or "3"
    const posEl    = row.querySelector('span.type-heading-b');
    const position = parseInt(posEl?.textContent?.trim() || '0', 10);
    if (!position || position > 3) continue;

    // Trap: span with data-theme="trap-N"
    const trapEl  = row.querySelector('[data-theme^="trap-"]');
    const trapStr = trapEl ? trapEl.getAttribute('data-theme').replace('trap-', '') : '';
    const trap    = trapStr ? parseInt(trapStr, 10) : null;

    // Dog name: first h3 inside the row → first span text
    const nameH3  = row.querySelector('h3');
    const dogName = (
      nameH3?.querySelector('span')?.textContent ||
      nameH3?.textContent || ''
    ).trim();

    if (!dogName || dogName.length < 2) continue;

    results.push({ position, trap, dogName });
  }

  return results;
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * @param {Array} races  — today's race objects from Timeform (need .venue, .date, .time)
 */
async function scrapeAtTheRacesTips(races) {
  if (!puppeteer) {
    console.warn('[ATRScraper] puppeteer not installed — skipping ATR tips');
    return [];
  }

  if (!races || !races.length) {
    console.warn('[ATRScraper] No races provided — skipping');
    return [];
  }

  const tips    = [];
  let   browser;

  try {
    browser = await launchBrowser();
    const page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-GB,en;q=0.9' });

    // Block images/fonts/media to save memory
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (['image', 'font', 'media'].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    let pagesLoaded = 0;

    for (const race of races) {
      const url = buildAtrUrl(race);
      if (!url) continue;

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        // Wait for React to render the verdict section
        await new Promise(r => setTimeout(r, 4000));

        const picks = await page.evaluate(parseVerdictFromPage);

        if (picks.length) {
          console.log(`[ATRScraper] ${race.venue} ${race.time}: ${picks.length} picks`);
          for (const pick of picks) {
            tips.push({
              source:     SOURCE,
              sourceName: SOURCE_NAME,
              dogName:    pick.dogName,
              venue:      race.venue,
              raceTime:   race.time,
              position:   pick.position,
            });
          }
        }

        pagesLoaded++;
      } catch (err) {
        console.warn(`[ATRScraper] ${race.venue} ${race.time} failed: ${err.message}`);
      }
    }

    console.log(`[ATRScraper] Scraped ${pagesLoaded} pages, ${tips.length} total tips`);

  } catch (err) {
    console.error('[ATRScraper] Fatal error:', err.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  return tips;
}

module.exports = { scrapeAtTheRacesTips };
