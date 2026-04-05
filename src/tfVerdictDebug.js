'use strict';
/**
 * Debug script — finds the Analyst Verdict section on a Timeform racecard page.
 * Run on VPS: node src/tfVerdictDebug.js
 */
const axios   = require('axios');
const cheerio = require('cheerio');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-GB,en;q=0.9',
};

(async () => {
  // Step 1: get today's racecard listing to find one race URL
  const today = new Date().toISOString().split('T')[0];
  console.log('Fetching Timeform racecard listing for', today);

  const listHtml = await axios.get('https://www.timeform.com/greyhound-racing/racecards', {
    headers: HEADERS, timeout: 15000,
  }).then(r => r.data);

  const $list = cheerio.load(listHtml);

  // Find any racecard URL
  let raceUrl = null;
  $list('a[href*="/greyhound-racing/racecards/"]').each((_, el) => {
    const href = $list(el).attr('href') || '';
    // Match pattern: /greyhound-racing/racecards/venue/time/date/id
    if (/\/greyhound-racing\/racecards\/[^/]+\/\d{4}\//.test(href) && !raceUrl) {
      raceUrl = href.startsWith('http') ? href : `https://www.timeform.com${href}`;
    }
  });

  if (!raceUrl) {
    console.log('No racecard URL found. Trying to dump some links:');
    $list('a[href*="racecards"]').slice(0, 10).each((_, el) => {
      console.log(' ', $list(el).attr('href'));
    });
    return;
  }

  console.log('\nFetching racecard:', raceUrl);

  const html = await axios.get(raceUrl, {
    headers: HEADERS, timeout: 15000,
  }).then(r => r.data);

  const $ = cheerio.load(html);

  // Step 2: look for verdict/analyst sections
  console.log('\n=== Searching for verdict/analyst/tip sections ===');

  const keywords = ['verdict', 'analyst', 'selection', 'prediction', 'tip', 'pick', 'nap'];
  keywords.forEach(kw => {
    $(`[class*="${kw}"], [id*="${kw}"], [data-*="${kw}"]`).each((i, el) => {
      if (i > 2) return;
      const tag = el.tagName;
      const cls = $(el).attr('class') || '';
      const id  = $(el).attr('id') || '';
      const txt = $(el).text().replace(/\s+/g, ' ').trim().slice(0, 200);
      console.log(`\n[${kw}] <${tag} class="${cls}" id="${id}">`);
      console.log('  Text:', txt);
      console.log('  HTML:', $(el).html()?.slice(0, 400));
    });
  });

  // Step 3: look for headings containing verdict/analyst/tip
  console.log('\n=== Headings containing key words ===');
  $('h1,h2,h3,h4,h5,h6,strong,b').each((_, el) => {
    const txt = $(el).text().toLowerCase().trim();
    if (keywords.some(k => txt.includes(k))) {
      console.log(`\n<${el.tagName}>: "${$(el).text().trim()}"`);
      const parent = $(el).parent();
      console.log('Parent class:', parent.attr('class'));
      console.log('Parent HTML:', parent.html()?.slice(0, 600));
    }
  });

  // Step 4: dump all class names on page containing those keywords
  console.log('\n=== All classes containing key words ===');
  const allClasses = new Set();
  $('[class]').each((_, el) => {
    ($(el).attr('class') || '').split(/\s+/).forEach(c => {
      if (c && keywords.some(k => c.toLowerCase().includes(k))) allClasses.add(c);
    });
  });
  console.log([...allClasses].join('\n'));

  // Step 5: dump section around "1st" or "2nd" text
  console.log('\n=== Context around ordinal numbers (1st, 2nd, 3rd) ===');
  const bodyText = $.html();
  ['1st', '2nd', '3rd', 'first', 'second', 'third'].forEach(term => {
    const idx = bodyText.toLowerCase().indexOf(term);
    if (idx !== -1) {
      console.log(`\n-- Around "${term}" --`);
      console.log(bodyText.slice(Math.max(0, idx - 150), idx + 300));
    }
  });

})().catch(err => console.error('Error:', err.message));
