'use strict';
// One-off diagnostic — run with: node src/tfDebug.js
// Fetches one Timeform race card and prints the raw HTML of the first runner block.

const axios   = require('axios');
const cheerio = require('cheerio');

const URL = 'https://www.timeform.com/greyhound-racing/racecards';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*',
  'Accept-Language': 'en-GB,en;q=0.9',
};

(async () => {
  // Step 1 — get the listing page and find first race URL
  console.log('Fetching listing page...');
  const { data: listHtml } = await axios.get(URL, { headers: HEADERS, timeout: 15000 });
  const $list = cheerio.load(listHtml);

  let firstRaceUrl = '';
  $list('a[href*="/greyhound-racing/racecards/"]').each((_, el) => {
    const href  = $list(el).attr('href') || '';
    const match = href.match(/\/greyhound-racing\/racecards\/([^/]+)\/(\d{3,4})\/(\d{4}-\d{2}-\d{2})\/(\d+)/);
    if (match && !firstRaceUrl) {
      firstRaceUrl = `https://www.timeform.com${href}`;
    }
  });

  if (!firstRaceUrl) {
    console.log('No race card URLs found on listing page.');
    console.log('--- Listing page snippet (first 3000 chars) ---');
    console.log(listHtml.slice(0, 3000));
    return;
  }

  console.log(`\nFirst race URL: ${firstRaceUrl}\n`);

  // Step 2 — fetch the race card page
  const { data: raceHtml } = await axios.get(firstRaceUrl, { headers: HEADERS, timeout: 15000 });
  const $ = cheerio.load(raceHtml);

  // Step 3 — find trap images and print surrounding HTML
  console.log('=== TRAP IMAGE PARENTS (first 3) ===');
  let found = 0;
  $('img[src*="trap-"]').each((_, img) => {
    if (found >= 3) return false;
    const row = $(img).closest('tr, li, div, article').first();
    console.log(`\n--- Runner ${found + 1} ---`);
    console.log('Row tag:', row.prop('tagName'));
    console.log('Row classes:', row.attr('class') || '(none)');
    console.log('Row HTML (first 800 chars):\n', row.html()?.slice(0, 800));
    found++;
  });

  if (!found) {
    console.log('No trap images found! Checking for star images...');
    $('img[src*="star"]').each((_, img) => {
      console.log('Star img src:', $(img).attr('src'));
      console.log('Parent HTML:', $(img).closest('tr, div').html()?.slice(0, 400));
      return false;
    });

    console.log('\n--- Full page text (first 2000 chars) ---');
    console.log(raceHtml.slice(0, 2000));
  }

  // Step 4 — print all table structures
  console.log('\n=== ALL TABLES (structure) ===');
  $('table').each((i, table) => {
    console.log(`\nTable ${i + 1} — classes: ${$(table).attr('class') || '(none)'}`);
    $(table).find('tr').slice(0, 4).each((j, tr) => {
      console.log(`  Row ${j + 1}:`, $(tr).html()?.slice(0, 300));
    });
  });
})().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
