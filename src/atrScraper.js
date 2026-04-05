'use strict';

/**
 * At The Races greyhound verdict scraper.
 *
 * greyhounds.attheraces.com is a React SPA — axios/cheerio cannot render it.
 * We use Puppeteer to load the tips listing page, wait for React to hydrate,
 * then parse the Verdict / "1st-2nd-3rd:" sections from the DOM.
 *
 * Verdict HTML structure (confirmed via debug):
 *   <h3 class="font-bold">1st-2nd-3rd:</h3>
 *   <div>
 *     <div class="flex bg-brand-navy">           ← one pick row
 *       <div ...>
 *         <div class="... bg-brand-gold-dark ...">
 *           <span ...>
 *             <span class="type-heading-b">1</span>   ← position number
 *             <span class="type-body-sm font-bold">st</span>
 *           </span>
 *         </div>
 *       </div>
 *       <div class="flex items-center ... px-3 py-2.5">
 *         <span data-theme="trap-2" ...>2</span>      ← trap number
 *         <h3 class="inline type-heading-e">
 *           <span>Salacres Tipster</span>             ← dog name
 *         </h3>
 *       </div>
 *     </div>
 *     ... (2nd and 3rd pick rows follow same pattern)
 *   </div>
 */

let puppeteer;
try { puppeteer = require('puppeteer'); } catch (_) { puppeteer = null; }

const SOURCE      = 'attheraces';
const SOURCE_NAME = 'At The Races';
const TIPS_URL    = 'https://greyhounds.attheraces.com/tips';

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

// ── Main entry point ──────────────────────────────────────────────────────────

async function scrapeAtTheRacesTips() {
  if (!puppeteer) {
    console.warn('[ATRScraper] puppeteer not installed — skipping ATR tips');
    return [];
  }

  const tips = [];
  let browser;

  try {
    browser = await launchBrowser();
    const page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-GB,en;q=0.9' });

    // Block images/fonts/media
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (['image', 'font', 'media'].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    console.log('[ATRScraper] Loading ATR tips page…');
    await page.goto(TIPS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for React to render verdict sections
    await new Promise(r => setTimeout(r, 6000));

    // ── Parse all verdict sections from the rendered DOM ──────────────────────
    const rawTips = await page.evaluate(() => {
      const results = [];

      // Find every "1st-2nd-3rd:" header — one per race with a verdict
      const headers = [...document.querySelectorAll('h3')].filter(
        h => h.textContent.trim() === '1st-2nd-3rd:'
      );

      for (const header of headers) {
        // Walk up to find venue/time context (grab text from nearest section/article/div)
        let contextEl = header.parentElement;
        for (let i = 0; i < 8; i++) {
          if (!contextEl) break;
          const t = contextEl.innerText || '';
          // Stop when we have enough context (venue + time likely present)
          if (t.length > 100) break;
          contextEl = contextEl.parentElement;
        }
        const contextText = contextEl?.innerText?.replace(/\s+/g, ' ').trim().slice(0, 400) || '';

        // The picks container is the next sibling div after the h3
        const picksContainer = header.nextElementSibling;
        if (!picksContainer) continue;

        // Each pick row contains bg-brand-navy in its class list
        const pickRows = [...picksContainer.querySelectorAll('div')].filter(
          d => d.className && typeof d.className === 'string' && d.className.includes('bg-brand-navy')
        );

        for (const row of pickRows) {
          // Position: span.type-heading-b contains "1", "2", or "3"
          const posEl = row.querySelector('span.type-heading-b');
          const position = parseInt(posEl?.textContent?.trim() || '0', 10);
          if (!position || position > 3) continue;

          // Trap: span with data-theme="trap-N"
          const trapEl = row.querySelector('[data-theme^="trap-"]');
          const trapAttr = trapEl ? trapEl.getAttribute('data-theme') : '';
          const trap = trapAttr ? parseInt(trapAttr.replace('trap-', ''), 10) : null;

          // Dog name: h3 with class containing "type-heading-e" → first span text
          const nameH3 = row.querySelector('h3');
          const dogName = (nameH3?.querySelector('span')?.textContent || nameH3?.textContent || '').trim();

          if (!dogName || dogName.length < 2) continue;

          results.push({ position, trap, dogName, contextText });
        }
      }

      return results;
    });

    console.log(`[ATRScraper] ${rawTips.length} raw picks found in DOM`);

    // ── Convert raw picks to tip objects ──────────────────────────────────────
    for (const rt of rawTips) {
      const venue    = extractVenueFromText(rt.contextText);
      const raceTime = extractTimeFromText(rt.contextText);
      tips.push({
        source:     SOURCE,
        sourceName: SOURCE_NAME,
        dogName:    rt.dogName,
        venue,
        raceTime,
        position:   rt.position,
      });
    }

    console.log(`[ATRScraper] Total tips extracted: ${tips.length}`);

  } catch (err) {
    console.error('[ATRScraper] Fatal error:', err.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  return tips;
}

// ── Text helpers (duplicated from scraper.js to keep this module self-contained) ─

const UK_VENUES = [
  'Romford','Wimbledon','Crayford','Hove','Belle Vue','Nottingham',
  'Swindon','Monmore','Oxford','Perry Barr','Poole','Sheffield',
  'Towcester','Newcastle','Doncaster','Yarmouth','Kinsley',
];

function extractVenueFromText(text) {
  const t = (text || '').toLowerCase();
  for (const v of UK_VENUES) {
    if (t.includes(v.toLowerCase())) return v;
  }
  return '';
}

function extractTimeFromText(text) {
  const m = (text || '').match(/\b(\d{1,2})[:.h](\d{2})\b/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : '';
}

module.exports = { scrapeAtTheRacesTips };
