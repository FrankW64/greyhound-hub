'use strict';

/**
 * EveryTip greyhound tips scraper.
 *
 * https://www.everytip.co.uk/greyhound-tips.html is server-rendered WordPress
 * HTML — plain axios + cheerio, no Puppeteer needed.
 *
 * Confirmed HTML structure (from everytipDebug.js):
 *   <p>
 *     <strong data-start="0" data-end="14">SUNDERLAND</strong><br>
 *     11:27 KNOCKBROGANEXILE (NAP)<br>
 *     12:51 DOALITTLEDANCE (NB)
 *   </p>
 *
 * Each <p> block covers one venue. The <strong data-start> attribute is the
 * reliable selector that distinguishes venue names from other <strong> tags.
 * NAP = best bet → position 1 (win tip)
 * NB  = next best → position 2
 */

const axios   = require('axios');
const cheerio = require('cheerio');

const SOURCE      = 'everytip';
const SOURCE_NAME = 'EveryTip';
const TIPS_URL    = 'https://www.everytip.co.uk/greyhound-tips.html';

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
};

async function scrapeEverytipTips() {
  const tips = [];

  try {
    console.log('[EveryTip] Fetching tips page…');
    const { data: html } = await axios.get(TIPS_URL, {
      headers: HEADERS,
      timeout: 15000,
      maxRedirects: 5,
    });

    const $ = cheerio.load(html);

    // Find every <p> that contains a <strong data-start> (venue name marker)
    // and also contains (NAP) or (NB) text
    $('p').each((_, el) => {
      const p = $(el);

      // Must have a <strong data-start="..."> child — that's the venue name
      const venueEl = p.find('strong[data-start]').first();
      if (!venueEl.length) return;

      const venue = venueEl.text().trim();
      if (!venue || venue.length > 30) return;

      // Get the full inner HTML and split on <br> tags to get individual lines
      const inner = p.html() || '';
      const lines = inner
        .split(/<br[^>]*>/i)
        .map(l => cheerio.load(l).text().trim())
        .filter(Boolean);

      for (const line of lines) {
        // Match: "HH:MM DOG NAME (NAP)" or "H:MM DOG NAME (NB)"
        const m = line.match(/^(\d{1,2}):(\d{2})\s+(.+?)\s+\((NAP|NB)\)\s*$/i);
        if (!m) continue;

        const raceTime = `${m[1].padStart(2, '0')}:${m[2]}`;
        const dogName  = toTitleCase(m[3].trim());
        const position = 1; // Both NAP and NB are win tips

        tips.push({ source: SOURCE, sourceName: SOURCE_NAME, dogName, venue: toTitleCase(venue), raceTime, position });
      }
    });

    console.log(`[EveryTip] ${tips.length} tips extracted`);
  } catch (err) {
    console.warn(`[EveryTip] Failed: ${err.message}`);
  }

  return tips;
}

/** Convert "KNOCKBROGANEXILE" → "Knockbroganexile" */
function toTitleCase(str) {
  return str.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

module.exports = { scrapeEverytipTips };
