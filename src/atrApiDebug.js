'use strict';
/**
 * Debug script — captures all API/JSON requests made by the ATR tips page.
 * Run on VPS: node src/atrApiDebug.js
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

  // Capture ALL network requests and responses
  const captured = [];

  page.on('request', req => {
    const url = req.url();
    const rt  = req.resourceType();
    if (['xhr', 'fetch', 'document'].includes(rt)) {
      captured.push({ type: 'request', url, resourceType: rt });
    }
  });

  page.on('response', async resp => {
    const url = resp.url();
    const ct  = resp.headers()['content-type'] || '';
    if (!ct.includes('json') && !ct.includes('javascript')) return;
    try {
      const text = await resp.text();
      // Only capture if it mentions dogs/picks/verdict/tips
      if (/verdict|selection|first|second|third|trap|greyhound|tips|racecard/i.test(text)) {
        captured.push({ type: 'response', url, ct, body: text.slice(0, 3000) });
      }
    } catch (_) {}
  });

  console.log('Loading ATR tips page...');
  await page.goto('https://greyhounds.attheraces.com/tips', {
    waitUntil: 'domcontentloaded', timeout: 30000,
  });
  await new Promise(r => setTimeout(r, 8000));

  console.log('\n=== All XHR/Fetch requests ===');
  for (const c of captured) {
    if (c.type === 'request') {
      console.log(`[${c.resourceType}] ${c.url}`);
    }
  }

  console.log('\n=== JSON responses mentioning greyhound/verdict/tips ===');
  for (const c of captured) {
    if (c.type === 'response') {
      console.log(`\nURL: ${c.url}`);
      console.log(`Content-Type: ${c.ct}`);
      console.log(`Body: ${c.body}`);
    }
  }

  await browser.close();
})().catch(err => console.error('Error:', err.message));
