'use strict';

/**
 * GBGB Results scraper.
 *
 * Fetches settled race results from the GBGB public API:
 *   http://api.gbgb.org.uk/api/results?date=YYYY-MM-DD
 *
 * Returns an array of result objects:
 *   { raceId, venue, raceTime, winnerName }
 *
 * The API paginates — we fetch all pages for today's date.
 * We only return rows where resultPosition === 1 (the winner).
 */

const axios = require('axios');

const BASE_URL = 'https://api.gbgb.org.uk/api/results';

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

/** Normalise "HH:MM:SS" → "HH:MM" */
function normaliseTime(t) {
  if (!t) return '';
  return t.slice(0, 5);
}

/**
 * Fetch all winner results for a given date (defaults to today).
 * @param {string} [date]  YYYY-MM-DD
 * @returns {Promise<Array<{raceId:string, venue:string, raceTime:string, winnerName:string}>>}
 */
async function fetchGbgbResults(date) {
  const targetDate = date || todayStr();
  const results = [];

  try {
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages) {
      const { data } = await axios.get(BASE_URL, {
        params: { date: targetDate, page },
        timeout: 15000,
        maxRedirects: 5,
      });

      if (!data || !Array.isArray(data.items)) break;

      totalPages = data.meta?.pageCount || 1;

      for (const item of data.items) {
        if (item.resultPosition !== 1) continue;

        results.push({
          raceId:     String(item.raceId),
          venue:      item.trackName || '',
          raceTime:   normaliseTime(item.raceTime),
          winnerName: item.dogName   || '',
        });
      }

      page++;
    }

    console.log(`[GBGBResults] ${results.length} winners fetched for ${targetDate}`);
  } catch (err) {
    console.warn(`[GBGBResults] Fetch failed: ${err.message}`);
  }

  return results;
}

module.exports = { fetchGbgbResults };
