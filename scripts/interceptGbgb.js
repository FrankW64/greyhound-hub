'use strict';

/**
 * interceptGbgb.js — uses Puppeteer to intercept GBGB internal API calls.
 *
 * Navigates to the GBGB results page for a date and captures all network
 * responses that look like race/runner data.
 *
 * Usage:
 *   node scripts/interceptGbgb.js 2026-01-10
 *   node scripts/interceptGbgb.js          # defaults to yesterday
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const puppeteer = require('puppeteer');
const fs        = require('fs');
const path      = require('path');

const date = process.argv[2] || (() => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
})();

// GBGB results page URL — try common patterns
const URLS_TO_TRY = [
  `https://www.gbgb.org.uk/results/?date=${date}`,
  `https://www.gbgb.org.uk/results/${date}`,
  `https://www.gbgb.org.uk/racing-results/?date=${date}`,
];

async function main() {
  console.log(`\n🔍 Intercepting GBGB for date: ${date}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );

  const captured = [];

  // Intercept all responses
  page.on('response', async response => {
    const url    = response.url();
    const status = response.status();
    const ct     = response.headers()['content-type'] || '';

    // Only capture JSON responses from GBGB domains
    if (!url.includes('gbgb') && !url.includes('greyhound')) return;
    if (!ct.includes('json') && !ct.includes('javascript')) return;
    if (status !== 200) return;

    try {
      const json = await response.json();
      const size = JSON.stringify(json).length;

      console.log(`  ✓ [${status}] ${url}`);
      console.log(`    Content-Type: ${ct}`);
      console.log(`    Size: ${size} bytes`);

      // Check if it looks like race data
      const text = JSON.stringify(json).toLowerCase();
      const looksLikeRaceData =
        text.includes('dogname') || text.includes('dog_name') ||
        text.includes('trapnumber') || text.includes('trap_number') ||
        text.includes('raceid') || text.includes('race_id') ||
        text.includes('meetingid') || text.includes('meeting_id') ||
        text.includes('racedate') || text.includes('race_date');

      if (looksLikeRaceData) {
        console.log(`    ⭐ LOOKS LIKE RACE DATA`);
        captured.push({ url, json });
      }

      console.log('');
    } catch (_) {
      // not JSON
    }
  });

  // Try each URL pattern
  let loaded = false;
  for (const url of URLS_TO_TRY) {
    try {
      console.log(`\nNavigating to: ${url}`);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      loaded = true;
      break;
    } catch (err) {
      console.log(`  Failed: ${err.message}`);
    }
  }

  if (!loaded) {
    console.log('\nAll URL patterns failed. Trying base results page…');
    await page.goto('https://www.gbgb.org.uk/results/', { waitUntil: 'networkidle2', timeout: 30000 });
  }

  // Wait a bit for lazy-loaded requests
  await new Promise(r => setTimeout(r, 3000));

  // Also log the current page URL (in case of redirect)
  console.log(`\nFinal URL: ${page.url()}`);
  console.log(`Page title: ${await page.title()}`);

  await browser.close();

  // Save captured data
  if (captured.length) {
    const outFile = path.join(__dirname, '..', 'data', `gbgb_intercepted_${date}.json`);
    fs.writeFileSync(outFile, JSON.stringify(captured, null, 2));
    console.log(`\n✅ ${captured.length} race data responses saved to data/gbgb_intercepted_${date}.json`);
    // Show a sample of the first captured item
    console.log('\nSample data (first 3 items of first capture):');
    const first = Array.isArray(captured[0].json) ? captured[0].json : (captured[0].json.items || [captured[0].json]);
    console.log(JSON.stringify(first.slice(0, 3), null, 2));
  } else {
    console.log('\n⚠️  No race data captured. GBGB may use a different API pattern.');
    // Save the page HTML for inspection
    const html    = await page.content().catch(() => '');
    const outFile = path.join(__dirname, '..', 'data', `gbgb_page_${date}.html`);
    // Re-open browser to get content since we already closed it
    fs.writeFileSync(outFile, html);
    console.log(`Page HTML saved to data/gbgb_page_${date}.html`);
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
