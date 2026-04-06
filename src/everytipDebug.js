'use strict';
/**
 * Debug script — dumps raw HTML from EveryTip greyhound tips page.
 * Run on VPS: node src/everytipDebug.js
 */
const axios   = require('axios');
const cheerio = require('cheerio');

const URL = 'https://www.everytip.co.uk/greyhound-tips.html';

(async () => {
  const { data: html } = await axios.get(URL, {
    headers: {
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-GB,en;q=0.9',
    },
    timeout: 15000,
  });

  const $ = cheerio.load(html);

  console.log('Page title:', $('title').text().trim());
  console.log('Total HTML length:', html.length);

  // Find all text nodes that contain known dog names or NAP/NB patterns
  console.log('\n=== Elements containing NAP or NB ===');
  $('*').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (/\bNAP\b|\bNB\b/.test(text) && text.length < 300) {
      console.log(`\n<${el.tagName} class="${$(el).attr('class') || ''}" id="${$(el).attr('id') || ''}">`);
      console.log('  Text:', text.slice(0, 200));
      console.log('  HTML:', $(el).html()?.slice(0, 400));
    }
  });

  // Find elements containing time-like patterns (HH:MM) near a dog name
  console.log('\n=== Elements containing time pattern (HH:MM) ===');
  const seen = new Set();
  $('*').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (/\d{1,2}:\d{2}/.test(text) && text.length < 500 && !seen.has(text.slice(0, 80))) {
      seen.add(text.slice(0, 80));
      console.log(`\n<${el.tagName} class="${$(el).attr('class') || ''}">`);
      console.log('  Text:', text.slice(0, 300));
      console.log('  HTML:', $(el).html()?.slice(0, 600));
    }
  });

  // Look for strong/b/h tags that might be venue names (all caps)
  console.log('\n=== Strong/b/h elements (likely venue names) ===');
  $('strong, b, h1, h2, h3, h4').each((_, el) => {
    const text = $(el).text().trim();
    if (text.length > 2 && text.length < 50) {
      console.log(`<${el.tagName} class="${$(el).attr('class') || ''}"> ${text}`);
    }
  });

  // Dump a chunk of the raw HTML around "NAP"
  const napIdx = html.indexOf('NAP');
  if (napIdx !== -1) {
    console.log('\n=== Raw HTML around first "NAP" ===');
    console.log(html.slice(Math.max(0, napIdx - 300), napIdx + 500));
  }
})().catch(err => console.error('Error:', err.message));
