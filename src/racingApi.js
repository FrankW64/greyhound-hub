'use strict';

/**
 * Racing API (racingapi.io) client.
 *
 * Fetches today's UK greyhound race cards including venue, race time,
 * distance, grade, and full runner details (trap, name, trainer, form).
 *
 * NOTE: Adjust endpoint paths if racingapi.io changes their schema.
 *       The mapping in `normaliseRace` converts their response to our
 *       internal format.
 */

const axios = require('axios');

class RacingApiClient {
  constructor({ apiKey, baseUrl = 'https://api.racingapi.io/v1' }) {
    this.apiKey  = apiKey;
    this.baseUrl = baseUrl;
    this.http    = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'x-api-key': this.apiKey,
        'Accept':    'application/json',
      },
      timeout: 15000,
    });
  }

  /**
   * Fetch today's UK greyhound race cards.
   * Returns an array of normalised race objects matching our internal format.
   */
  async getTodaysRaceCards() {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    try {
      // Typical racingapi.io endpoint — adjust if needed
      const { data } = await this.http.get('/greyhounds/racecards', {
        params: {
          date:    today,
          country: 'GB',
        },
      });

      // data may be { racecards: [...] } or just [...]
      const cards = Array.isArray(data) ? data : (data.racecards || data.races || []);
      return cards.map(normaliseRace).filter(Boolean);
    } catch (err) {
      console.error('[RacingAPI] Failed to fetch race cards:', err.message);
      return [];
    }
  }
}

// ── Normalisation ─────────────────────────────────────────────────────────────

/**
 * Map a racingapi.io race card entry to our internal race format.
 * Field names are best-guesses; update if their actual schema differs.
 */
function normaliseRace(raw) {
  if (!raw) return null;

  const venue    = raw.track || raw.venue || raw.course || 'Unknown';
  const time     = raw.time  || raw.race_time || raw.start_time || '';
  const distance = raw.distance || '';
  const grade    = raw.grade  || raw.class    || '';
  const prize    = raw.prize  || raw.prize_money || '';

  const rawRunners = raw.runners || raw.dogs || [];
  const runners = rawRunners.map(normaliseRunner).filter(Boolean);

  if (!runners.length) return null;

  return {
    id: `${venue.toUpperCase().slice(0, 3)}-${time.replace(':', '')}`,
    venue,
    time,
    date: new Date().toISOString().split('T')[0],
    distance,
    grade,
    prize,
    runners,
    // Odds will be filled in by Betfair integration
  };
}

function normaliseRunner(raw) {
  if (!raw) return null;

  return {
    trap:        raw.trap_number || raw.trap || raw.box || 0,
    name:        raw.name        || raw.dog_name || raw.greyhound || '',
    trainer:     raw.trainer     || raw.trainer_name || '',
    form:        raw.form        || raw.recent_form  || '',
    openingOdds: parseFloat(raw.sp || raw.morning_price || 0) || null,
    currentOdds: parseFloat(raw.sp || raw.morning_price || 0) || null,
    tipSources:  [],
    tipsCount:   0,
    isTipped:    false,
    isBestBet:   false,
  };
}

module.exports = RacingApiClient;
