'use strict';
// node src/rpDebug.js
// Discovers the Racing Post greyhound tips API endpoint

const axios   = require('axios');
const cheerio = require('cheerio');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/json,*/*',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Referer': 'https://greyhoundbet.racingpost.com/',
};

const today = new Date().toISOString().split('T')[0];
const [year, month, day] = today.split('-');
const rpDate = `${year}-${month}-${day}`;

// Candidate API patterns to try
const CANDIDATES = [
  // Page-name.sd pattern (matches hash routing)
  `https://greyhoundbet.racingpost.com/meeting-list.sd`,
  `https://greyhoundbet.racingpost.com/meeting-list.sd?r_date=${rpDate}`,
  `https://greyhoundbet.racingpost.com/tips.sd`,
  `https://greyhoundbet.racingpost.com/tab-tips.sd`,
  `https://greyhoundbet.racingpost.com/race-tips.sd`,
  `https://greyhoundbet.racingpost.com/card.sd`,
  `https://greyhoundbet.racingpost.com/results-list.sd`,
  // Subdirectory patterns
  `https://greyhoundbet.racingpost.com/greyhound/tips`,
  `https://greyhoundbet.racingpost.com/greyhound/tips?date=${rpDate}`,
  `https://greyhoundbet.racingpost.com/greyhound/meeting-list`,
  `https://greyhoundbet.racingpost.com/greyhound/meeting-list?r_date=${rpDate}`,
  // JSON endpoint variations
  `https://greyhoundbet.racingpost.com/json/tips`,
  `https://greyhoundbet.racingpost.com/json/meeting-list`,
  `https://greyhoundbet.racingpost.com/ajax/tips`,
  `https://greyhoundbet.racingpost.com/ajax/meeting-list`,
  // With r_date param (used in hash links)
  `https://greyhoundbet.racingpost.com/meeting-list?r_date=${rpDate}`,
  `https://greyhoundbet.racingpost.com/tips?r_date=${rpDate}`,
  // API subdomain
  `https://api.greyhoundbet.racingpost.com/tips`,
  `https://api.greyhoundbet.racingpost.com/meeting-list`,
];

async function tryUrl(url) {
  try {
    const res = await axios.get(url, {
      headers: HEADERS,
      timeout: 8000,
      maxRedirects: 3,
      validateStatus: () => true, // don't throw on non-2xx
    });
    return { url, status: res.status, contentType: res.headers['content-type'] || '', body: String(res.data).slice(0, 500) };
  } catch (err) {
    return { url, status: 'ERROR', contentType: '', body: err.message };
  }
}

async function tryMainPage() {
  console.log('\n=== MAIN PAGE EMBEDDED DATA ===');
  try {
    const { data: html } = await axios.get('https://greyhoundbet.racingpost.com/', { headers: HEADERS, timeout: 10000 });
    const $ = cheerio.load(html);

    // Look for any JSON blobs in script tags
    $('script').each((_, el) => {
      const content = $(el).html() || '';
      if (content.includes('dog_name') || content.includes('race_time') || content.includes('tip')) {
        console.log('Found relevant script tag (first 800 chars):');
        console.log(content.slice(0, 800));
        console.log('---');
      }
    });

    // Look for data- attributes
    $('[data-tips], [data-race], [data-meeting]').each((_, el) => {
      console.log('Data attribute element:', $(el).attr('data-tips') || $(el).attr('data-race') || $(el).attr('data-meeting'));
    });

    // Print all script src URLs
    console.log('\nScript src URLs:');
    $('script[src]').each((_, el) => console.log(' ', $(el).attr('src')));

  } catch (err) {
    console.log('Main page error:', err.message);
  }
}

async function tryMainAppJs() {
  console.log('\n=== GREYHOUNDBET.MIN.JS - URL PATTERNS ===');
  try {
    const { data } = await axios.get('https://greyhoundbet.racingpost.com/js/greyhoundbet.min.js', { headers: HEADERS, timeout: 15000 });
    const content  = String(data);
    // Extract strings that look like URL paths
    const urlMatches = content.match(/["'`][/][a-z][a-z0-9\-._/]*\.sd[^"'`]*/gi) || [];
    const urlMatches2 = content.match(/url\s*[:=]\s*["'`][^"'`]+["'`]/gi) || [];
    const tipsMatches = content.match(/.{0,80}tips.{0,80}/gi) || [];
    console.log('SD file references:');
    [...new Set(urlMatches)].forEach(m => console.log(' ', m));
    console.log('\nurl: patterns:');
    [...new Set(urlMatches2)].slice(0, 20).forEach(m => console.log(' ', m));
    console.log('\ntips context:');
    [...new Set(tipsMatches)].slice(0, 10).forEach(m => console.log(' ', m));
  } catch (err) {
    console.log('greyhoundbet.min.js error:', err.message);
  }
}

async function tryConstantsJs() {
  console.log('\n=== CONSTANTS.JS.SD - LOOKING FOR API URLS ===');
  try {
    const { data } = await axios.get('https://greyhoundbet.racingpost.com/js/constants.js.sd', { headers: HEADERS, timeout: 10000 });
    const content  = String(data);
    // Print lines containing 'url', 'api', 'data', 'tips', 'http'
    const lines = content.split('\n');
    lines.forEach(line => {
      if (/url|api|data|tips|\.sd|http/i.test(line) && line.length < 300) {
        console.log(line.trim());
      }
    });
  } catch (err) {
    console.log('constants.js error:', err.message);
  }
}

(async () => {
  console.log(`Probing Racing Post greyhound tips API (date: ${rpDate})\n`);

  // Try candidate URLs in parallel
  console.log('=== CANDIDATE ENDPOINT PROBE ===');
  const results = await Promise.all(CANDIDATES.map(tryUrl));
  for (const r of results) {
    const ok = r.status === 200;
    console.log(`\n[${r.status}] ${r.url}`);
    if (ok) {
      console.log('  Content-Type:', r.contentType);
      console.log('  Body preview:', r.body);
    }
  }

  await tryMainPage();
  await tryConstantsJs();
  await tryMainAppJs();

})().catch(err => { console.error(err.message); process.exit(1); });
