'use strict';

/**
 * GBGB Results scraper.
 *
 * One paginated fetch per refresh cycle produces both:
 *   - top-3 results per race   (for ResultsTracker)
 *   - all runner rows          (for dog_run_history / algorithm)
 */

const axios = require('axios');

const BASE_URL = 'https://api.gbgb.org.uk/api/results';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':     'application/json, text/plain, */*',
  'Referer':    'https://www.gbgb.org.uk/',
};

/** Fetch with up to `retries` attempts, waiting `delayMs` between each. */
async function fetchWithRetry(params, retries = 3, delayMs = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const { data } = await axios.get(BASE_URL, { params, headers: HEADERS, timeout: 15000, maxRedirects: 5 });
      return data;
    } catch (err) {
      const status = err.response?.status;
      if (attempt < retries && (status === 503 || status === 429 || status === 502)) {
        console.warn(`[GBGBResults] ${status} on attempt ${attempt}, retrying in ${delayMs}ms…`);
        await new Promise(r => setTimeout(r, delayMs));
        delayMs *= 2; // exponential backoff
      } else {
        throw err;
      }
    }
  }
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function normaliseTime(t) {
  if (!t) return '';
  return t.slice(0, 5);
}

/**
 * Single fetch — returns { results, allRunners } for a given date.
 *
 * results:    [{ raceId, venue, raceTime, winnerName, secondName, thirdName }]
 * allRunners: [{ raceDate, venue, raceTime, grade, distance, dogName, trap, position, runTime }]
 */
async function fetchGbgbData(date) {
  const targetDate = date || todayStr();

  const raceMap  = new Map(); // raceId → { venue, raceTime, positions:{} }
  const runners  = [];

  try {
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages) {
      const data = await fetchWithRetry({ date: targetDate, page });
      if (!data || !Array.isArray(data.items)) break;
      totalPages = data.meta?.pageCount || 1;

      for (const item of data.items) {
        const pos = item.resultPosition;
        if (!pos || !item.dogName) continue;

        const id = String(item.raceId);

        // Build race map for top-3 results
        if (!raceMap.has(id)) {
          raceMap.set(id, {
            raceId:    id,
            venue:     item.trackName || '',
            raceTime:  normaliseTime(item.raceTime),
            positions: {},
          });
        }
        if (pos <= 3) raceMap.get(id).positions[pos] = item.dogName;

        // All runners for history
        runners.push({
          raceDate:  targetDate,
          venue:     item.trackName    || '',
          raceTime:  normaliseTime(item.raceTime),
          grade:     item.raceClass    || null,   // API field is raceClass not raceGrade
          distance:  item.raceDistance ? Math.round(parseFloat(item.raceDistance)) : null,
          dogName:   item.dogName,
          trap:      item.trapNumber   ? parseInt(item.trapNumber, 10) : null,
          position:  pos,
          runTime:   null,  // not available in results API
        });
      }

      page++;
    }

    const results = [...raceMap.values()]
      .map(r => ({
        raceId:     r.raceId,
        venue:      r.venue,
        raceTime:   r.raceTime,
        winnerName: r.positions[1] || '',
        secondName: r.positions[2] || '',
        thirdName:  r.positions[3] || '',
      }))
      .filter(r => r.winnerName);

    console.log(`[GBGBResults] ${results.length} settled races, ${runners.length} runner rows for ${targetDate}`);
    return { results, allRunners: runners };
  } catch (err) {
    console.warn(`[GBGBResults] Fetch failed: ${err.message}`);
    return { results: [], allRunners: [] };
  }
}

// Convenience wrappers kept for any future direct callers
async function fetchGbgbResults(date) {
  const { results } = await fetchGbgbData(date);
  return results;
}

async function fetchGbgbAllRunners(date) {
  const { allRunners } = await fetchGbgbData(date);
  return allRunners;
}

module.exports = { fetchGbgbData, fetchGbgbResults, fetchGbgbAllRunners };
