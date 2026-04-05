'use strict';
/**
 * Test whether ATR racecard pages return SSR HTML via plain axios.
 * Run on VPS: node src/atrAxiosDebug.js
 */
const axios   = require('axios');
const cheerio = require('cheerio');

const TEST_URL = 'https://greyhounds.attheraces.com/racecard/GB/towcester/05-April-2026/1802';

// Mimic a real browser as closely as possible
const HEADERS = {
  'User-Agent':                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language':           'en-GB,en;q=0.9',
  'Accept-Encoding':           'gzip, deflate, br',
  'Cache-Control':             'no-cache',
  'Pragma':                    'no-cache',
  'Sec-Fetch-Dest':            'document',
  'Sec-Fetch-Mode':            'navigate',
  'Sec-Fetch-Site':            'none',
  'Sec-Fetch-User':            '?1',
  'Upgrade-Insecure-Requests': '1',
  'sec-ch-ua':                 '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'sec-ch-ua-mobile':          '?0',
  'sec-ch-ua-platform':        '"Windows"',
};

(async () => {
  console.log('Fetching:', TEST_URL);
  try {
    const { data, status, headers: resHeaders } = await axios.get(TEST_URL, {
      headers: HEADERS,
      timeout: 15000,
      maxRedirects: 5,
    });

    console.log('Status:', status);
    console.log('Content-Type:', resHeaders['content-type']);
    console.log('Response length:', data.length);

    const $ = cheerio.load(data);

    // Check if it's a real page or a bot-block page
    console.log('\nPage title:', $('title').text());
    console.log('H1:', $('h1').first().text().trim());

    // Look for verdict
    const bodyText = $.html();
    const verdictIdx = bodyText.toLowerCase().indexOf('verdict');
    console.log('\nContains "verdict":', verdictIdx !== -1);
    if (verdictIdx !== -1) {
      console.log('Context:', bodyText.slice(Math.max(0, verdictIdx - 100), verdictIdx + 500));
    }

    // Check for 1st/2nd/3rd
    console.log('Contains "1st-2nd-3rd":', bodyText.includes('1st-2nd-3rd'));

    // Dump first 1000 chars of body HTML
    console.log('\n=== Body HTML start ===');
    console.log($('body').html()?.slice(0, 1000));

  } catch (err) {
    console.error('Request failed:', err.message);
    if (err.response) {
      console.log('Status:', err.response.status);
      console.log('Body:', String(err.response.data).slice(0, 500));
    }
  }
})();
