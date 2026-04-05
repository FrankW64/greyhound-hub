'use strict';
// node src/tfDebug.js
const axios   = require('axios');
const cheerio = require('cheerio');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*',
  'Accept-Language': 'en-GB,en;q=0.9',
};

(async () => {
  // Get first race URL
  const { data: listHtml } = await axios.get('https://www.timeform.com/greyhound-racing/racecards', { headers: HEADERS, timeout: 15000 });
  const $l = cheerio.load(listHtml);
  let firstUrl = '';
  $l('a[href*="/greyhound-racing/racecards/"]').each((_, el) => {
    const href = $l(el).attr('href') || '';
    if (!firstUrl && /\/racecards\/[^/]+\/\d+\/\d{4}-\d{2}-\d{2}\/\d+/.test(href)) {
      firstUrl = 'https://www.timeform.com' + href;
    }
  });
  console.log('Race URL:', firstUrl);

  const { data: html } = await axios.get(firstUrl, { headers: HEADERS, timeout: 15000 });
  const $ = cheerio.load(html);

  // 1. Find ALL images and print unique src patterns
  const imgSrcs = new Set();
  $('img').each((_, el) => imgSrcs.add($(el).attr('src') || ''));
  console.log('\n=== ALL UNIQUE IMG SRC PATTERNS ===');
  [...imgSrcs].filter(s => s).sort().forEach(s => console.log(' ', s));

  // 2. Print the FULL HTML of the first rpb-entry-details row AND its next sibling
  console.log('\n=== FULL RUNNER 1 ROW + NEXT SIBLING ===');
  const firstRunner = $('tr.rpb-entry-details').first();
  console.log('Row 1 HTML:\n', firstRunner.html());
  console.log('\nRow 2 (next sibling) HTML:\n', firstRunner.next('tr').html());

  // 3. Print the FULL HTML of the second runner too
  console.log('\n=== FULL RUNNER 2 ROW + NEXT SIBLING ===');
  const secondRunner = $('tr.rpb-entry-details').eq(1);
  console.log('Row 1 HTML:\n', secondRunner.html());
  console.log('\nRow 2 (next sibling) HTML:\n', secondRunner.next('tr').html());

})().catch(err => { console.error(err.message); process.exit(1); });
