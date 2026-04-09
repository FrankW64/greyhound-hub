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
 * Fetch all results (positions 1-3) for a given date (defaults to today).
 * Groups by raceId and returns one entry per race with winner, 2nd, 3rd.
 * @param {string} [date]  YYYY-MM-DD
 * @returns {Promise<Array<{raceId, venue, raceTime, winnerName, secondName, thirdName}>>}
 */
async function fetchGbgbResults(date) {
  const targetDate = date || todayStr();

  // raceId → { raceId, venue, raceTime, positions: { 1: name, 2: name, 3: name } }
  const raceMap = new Map();

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
        const pos = item.resultPosition;
        if (!pos || pos > 3) continue; // only care about 1st, 2nd, 3rd

        const id = String(item.raceId);
        if (!raceMap.has(id)) {
          raceMap.set(id, {
            raceId:    id,
            venue:     item.trackName || '',
            raceTime:  normaliseTime(item.raceTime),
            positions: {},
          });
        }
        raceMap.get(id).positions[pos] = item.dogName || '';
      }

      page++;
    }

    const results = [...raceMap.values()].map(r => ({
      raceId:     r.raceId,
      venue:      r.venue,
      raceTime:   r.raceTime,
      winnerName: r.positions[1] || '',
      secondName: r.positions[2] || '',
      thirdName:  r.positions[3] || '',
    }));

    const withWinner = results.filter(r => r.winnerName);
    console.log(`[GBGBResults] ${withWinner.length} races fetched for ${targetDate} (with 1st/2nd/3rd)`);
    return withWinner;
  } catch (err) {
    console.warn(`[GBGBResults] Fetch failed: ${err.message}`);
    return [];
  }
}

/**
 * Fetch all runner data (every finishing position) for a given date.
 * Used to build the dog_run_history table for form analysis.
 * Returns one entry per runner: { raceDate, venue, raceTime, grade, distance, dogName, trap, position, runTime }
 * @param {string} [date]  YYYY-MM-DD
 */
async function fetchGbgbAllRunners(date) {
  const targetDate = date || todayStr();
  const runners = [];

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
        if (!item.dogName || !item.resultPosition) continue;
        runners.push({
          raceDate:  targetDate,
          venue:     item.trackName      || '',
          raceTime:  normaliseTime(item.raceTime),
          grade:     item.raceGrade      || null,
          distance:  item.raceDistance   ? parseInt(item.raceDistance, 10) : null,
          dogName:   item.dogName,
          trap:      item.trapNumber     ? parseInt(item.trapNumber, 10) : null,
          position:  item.resultPosition,
          runTime:   item.sectionalTime  ? parseFloat(item.sectionalTime) : null,
        });
      }

      page++;
    }

    console.log(`[GBGBResults] ${runners.length} runner history rows for ${targetDate}`);
    return runners;
  } catch (err) {
    console.warn(`[GBGBResults] fetchGbgbAllRunners failed: ${err.message}`);
    return [];
  }
}

module.exports = { fetchGbgbResults, fetchGbgbAllRunners };
