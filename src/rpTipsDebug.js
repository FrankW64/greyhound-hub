'use strict';
/**
 * Debug script — intercepts Racing Post API responses to find the tips data endpoint.
 * Run on VPS: node src/rpTipsDebug.js
 */
const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    protocolTimeout: 120000,
    executablePath: '/usr/bin/chromium-browser',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  const today = new Date().toISOString().split('T')[0];
  console.log('Date:', today);

  // Set realistic browser headers to avoid bot detection
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-GB,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );

  // Capture ALL responses (log URL + content-type for every one)
  const captured = [];
  const allUrls  = [];
  page.on('response', async resp => {
    const url = resp.url();
    const ct  = resp.headers()['content-type'] || '';
    allUrls.push(`[${resp.status()}] ${ct.split(';')[0].padEnd(30)} ${url}`);
    if (!ct.includes('json') && !ct.includes('text/plain')) return;
    try {
      const text = await resp.text();
      if (text.length > 20 && text.length < 200000) {
        captured.push({ url, status: resp.status(), ct, body: text.slice(0, 3000) });
      }
    } catch (_) {}
  });

  // Step 1: load meeting list
  console.log('\n=== Loading meeting list ===');
  await page.goto(`https://greyhoundbet.racingpost.com/#meeting-list/r_date=${today}`, {
    waitUntil: 'domcontentloaded', timeout: 30000,
  });
  await new Promise(r => setTimeout(r, 8000));

  // Extract race links from DOM using a short timeout evaluate
  let links = [];
  try {
    links = await Promise.race([
      page.evaluate(() =>
        [...document.querySelectorAll('a[href*="race_id"]')].slice(0, 5).map(a => a.getAttribute('href'))
      ),
      new Promise((_, reject) => setTimeout(() => reject(new Error('evaluate timeout')), 15000)),
    ]);
  } catch (e) {
    console.log('evaluate failed:', e.message);
  }

  console.log('Race links found:', links.length);
  if (!links.length) {
    console.log('\n=== API calls captured on meeting list page ===');
    captured.forEach(c => console.log(`\n${c.status} ${c.url}\n${c.body.slice(0,500)}`));
    await browser.close(); return;
  }

  const raceId = links[0].match(/race_id=(\d+)/)?.[1];
  const allIds = links.map(l => l.match(/race_id=(\d+)/)?.[1]).filter(Boolean).join(',');
  console.log('Using race_id:', raceId);

  // Step 2: navigate to tips tab and capture API responses
  captured.length = 0; // clear previous captures
  const tipUrl = `https://greyhoundbet.racingpost.com/#card/race_id=${raceId}&r_date=${today}&tab=tips&races_ids=${allIds}`;
  console.log('\n=== Loading tips page ===\n', tipUrl);
  await page.goto(tipUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log('Waiting 10s for API calls to complete…');
  await new Promise(r => setTimeout(r, 10000));

  console.log(`\n=== API responses captured: ${captured.length} ===`);
  captured.forEach((c, i) => {
    console.log(`\n--- Response ${i+1} [${c.status}] ---`);
    console.log('URL:', c.url);
    console.log('Body:', c.body);
  });

  console.log(`\n=== All URLs loaded on tips page (${allUrls.length}) ===`);
  allUrls.forEach(u => console.log(u));

  if (!captured.length) {
    console.log('\nNo JSON responses found — site may be blocking headless browser.');
  }

  await browser.close();
  console.log('\nDone.');
})().catch(err => { console.error(err.message); process.exit(1); });
