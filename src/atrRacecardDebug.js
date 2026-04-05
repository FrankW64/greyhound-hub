'use strict';
/**
 * Debug script — dumps the verdict section DOM from a specific ATR racecard page.
 * Run on VPS: node src/atrRacecardDebug.js
 */

let puppeteer;
try { puppeteer = require('puppeteer'); } catch (_) { puppeteer = null; }
if (!puppeteer) { console.error('puppeteer not installed'); process.exit(1); }

const CHROMIUM_PATHS = [
  '/usr/bin/chromium-browser', '/usr/bin/chromium',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
];
function findChromium() {
  const fs = require('fs');
  for (const p of CHROMIUM_PATHS) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return null;
}

// ── Change this to today's actual race URL ────────────────────────────────────
const TEST_URL = 'https://greyhounds.attheraces.com/racecard/GB/towcester/05-April-2026/1802';

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new', protocolTimeout: 60000,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
           '--disable-gpu','--no-zygote','--mute-audio','--no-first-run'],
    ...(findChromium() ? { executablePath: findChromium() } : {}),
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-GB,en;q=0.9' });

  await page.setRequestInterception(true);
  page.on('request', req => {
    if (['image','font','media'].includes(req.resourceType())) req.abort();
    else req.continue();
  });

  console.log('Loading:', TEST_URL);
  await page.goto(TEST_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Try waiting longer — up to 10 seconds
  console.log('Waiting 10s for React to render...');
  await new Promise(r => setTimeout(r, 10000));

  const result = await page.evaluate(() => {
    const out = {};

    // 1. All h2/h3 text on the page
    out.headings = [...document.querySelectorAll('h2,h3')]
      .map(h => ({ tag: h.tagName, cls: h.className, text: h.textContent.trim().slice(0, 80) }))
      .slice(0, 40);

    // 2. Search for "Verdict" anywhere in the DOM
    out.verdictH2 = null;
    const h2s = [...document.querySelectorAll('h2')];
    for (const h of h2s) {
      if (h.textContent.toLowerCase().includes('verdict')) {
        out.verdictH2 = {
          text:       h.textContent.trim(),
          cls:        h.className,
          parentCls:  h.parentElement?.className,
          parentHTML: h.parentElement?.innerHTML?.slice(0, 2000),
        };
        break;
      }
    }

    // 3. Search for "1st-2nd-3rd" h3
    out.picksH3 = null;
    const h3s = [...document.querySelectorAll('h3')];
    for (const h of h3s) {
      if (h.textContent.trim().includes('1st')) {
        out.picksH3 = {
          text:         h.textContent.trim(),
          cls:          h.className,
          nextSibHTML:  h.nextElementSibling?.innerHTML?.slice(0, 2000),
        };
        break;
      }
    }

    // 4. All elements with bg-brand-navy class
    out.navyDivs = [...document.querySelectorAll('[class*="bg-brand-navy"]')]
      .slice(0, 5)
      .map(d => ({ cls: d.className, html: d.innerHTML?.slice(0, 500) }));

    // 5. All elements with data-theme starting with "trap"
    out.trapSpans = [...document.querySelectorAll('[data-theme^="trap"]')]
      .slice(0, 6)
      .map(s => ({ theme: s.getAttribute('data-theme'), text: s.textContent.trim(), parentHTML: s.parentElement?.innerHTML?.slice(0,300) }));

    // 6. Full page text snippet around "Verdict"
    const bodyText = document.body.innerText || '';
    const idx = bodyText.toLowerCase().indexOf('verdict');
    out.verdictTextCtx = idx !== -1 ? bodyText.slice(Math.max(0, idx - 50), idx + 500) : 'NOT FOUND';

    // 7. Is the page still showing a loading/error state?
    out.bodyStart = document.body.innerHTML?.slice(0, 500);

    return out;
  });

  console.log('\n=== All H2/H3 headings ===');
  result.headings.forEach(h => console.log(`  <${h.tag} class="${h.cls}"> ${h.text}`));

  console.log('\n=== Verdict H2 ===');
  console.log(JSON.stringify(result.verdictH2, null, 2));

  console.log('\n=== 1st-2nd-3rd H3 ===');
  console.log(JSON.stringify(result.picksH3, null, 2));

  console.log('\n=== bg-brand-navy divs ===');
  result.navyDivs.forEach((d, i) => {
    console.log(`\n[${i}] class: ${d.cls}`);
    console.log('  HTML:', d.html);
  });

  console.log('\n=== trap spans ===');
  result.trapSpans.forEach((s, i) => {
    console.log(`\n[${i}] data-theme="${s.theme}" text="${s.text}"`);
    console.log('  parentHTML:', s.parentHTML);
  });

  console.log('\n=== Text around "verdict" ===');
  console.log(result.verdictTextCtx);

  console.log('\n=== Body start (first 500 chars) ===');
  console.log(result.bodyStart);

  await browser.close();
})().catch(err => console.error('Error:', err.message));
