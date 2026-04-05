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

  // Capture ALL API/JSON responses
  const captured = [];
  page.on('response', async resp => {
    const url = resp.url();
    const ct  = resp.headers()['content-type'] || '';
    if (!ct.includes('json') && !url.includes('/api/') && !url.includes('/tips') && !url.includes('/card')) return;
    try {
      const text = await resp.text();
      if (text.length > 50 && text.length < 100000) {
        captured.push({ url, status: resp.status(), body: text.slice(0, 2000) });
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

  if (!captured.length) {
    console.log('No JSON API calls captured. The page may load data differently.');
    console.log('All response URLs seen on tips page:');
    // Re-attach listener for all URLs
  }

  await browser.close();
  console.log('\nDone.');
})().catch(err => { console.error(err.message); process.exit(1); });
