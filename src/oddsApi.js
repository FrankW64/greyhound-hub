'use strict';

/**
 * The Odds API client  (the-odds-api.com)
 *
 * Fetches best-available odds across traditional bookmakers (Bet365, William
 * Hill, Ladbrokes, Sky Bet, etc.) for UK greyhound races.
 *
 * Free tier: 500 requests/month.  Each call to getGreyhoundOdds() costs 1
 * request.  At one poll per minute the monthly budget covers ~8 hours of live
 * racing — plan your POLL_INTERVAL accordingly, or only call this once per
 * race-day session and cache the result.
 *
 * API docs: https://the-odds-api.com/liveapi/guides/v4/
 */

const axios = require('axios');

const BASE_URL = 'https://api.the-odds-api.com/v4';

// The Odds API sport keys to try for UK greyhound racing (in priority order)
const SPORT_KEYS = [
  'greyhound_racing_uk',
  'greyhound_racing',
];

// Bookmakers to request — all available in the UK region
const UK_BOOKMAKERS = [
  'bet365',
  'williamhill',
  'ladbrokes',
  'paddypower',
  'skybet',
  'coral',
  'betvictor',
  'unibet_uk',
  'betfair_sb',   // Betfair Sportsbook (not the Exchange)
].join(',');

// Human-readable names keyed by The Odds API bookmaker key
const BOOKIE_LABELS = {
  bet365:      'Bet365',
  williamhill: 'William Hill',
  ladbrokes:   'Ladbrokes',
  paddypower:  'Paddy Power',
  skybet:      'Sky Bet',
  coral:       'Coral',
  betvictor:   'BetVictor',
  unibet_uk:   'Unibet',
  betfair_sb:  'Betfair SB',
};

class OddsApiClient {
  constructor({ apiKey }) {
    this.apiKey = apiKey;
    this._sportKey = null; // cached once we find a working key

    // Exposed for /api/health and the status indicator
    this.status = {
      connected:         false,
      lastSuccess:       null,
      lastError:         null,
      remainingRequests: null,
      usedRequests:      null,
      sport:             null,
    };
  }

  // ── Public ──────────────────────────────────────────────────────────────────

  /**
   * Fetch today's UK greyhound odds from all configured bookmakers.
   *
   * Returns a flat array of runner-level records:
   * [{
   *   venue, raceTime, normName,
   *   bestBookmakerOdds: { bookmakerName, price },
   *   allBookmakerOdds:  [{ bookmakerName, price }, …]   // sorted best→worst
   * }]
   */
  async getGreyhoundOdds() {
    const keys = this._sportKey ? [this._sportKey] : SPORT_KEYS;

    for (const sportKey of keys) {
      try {
        const raw = await this._fetchOdds(sportKey);
        if (raw && raw.length > 0) {
          this._sportKey = sportKey; // remember for next poll
          return this._normalise(raw);
        }
      } catch (err) {
        // 404 → this sport key doesn't exist; try the next one
        if (err.response?.status === 404) continue;
        this._setError(err.message);
        throw err;
      }
    }

    // No results — possibly no races today or sport not in plan
    console.warn('[OddsAPI] No greyhound events found');
    return [];
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  async _fetchOdds(sportKey) {
    const res = await axios.get(`${BASE_URL}/sports/${sportKey}/odds/`, {
      params: {
        apiKey:      this.apiKey,
        regions:     'uk',
        markets:     'h2h',       // win market (multi-runner uses h2h outcomes)
        oddsFormat:  'decimal',
        dateFormat:  'iso',
        bookmakers:  UK_BOOKMAKERS,
      },
      timeout: 15000,
    });

    // Record quota from response headers
    this.status.remainingRequests = parseInt(res.headers['x-requests-remaining'] ?? '-1', 10);
    this.status.usedRequests      = parseInt(res.headers['x-requests-used']      ?? '-1', 10);

    this._setSuccess(sportKey);
    return res.data;
  }

  /**
   * Convert The Odds API response into our internal runner-odds format.
   *
   * The Odds API represents greyhound races as "events" where each
   * outcome in the h2h market is a runner (dog name).
   */
  _normalise(events) {
    const results = [];

    for (const event of events) {
      const venue    = this._extractVenue(event);
      const raceTime = isoToHHMM(event.commence_time);

      // Aggregate odds per runner across all bookmakers
      const byRunner = {}; // normName → [{bookmakerName, price}]

      for (const bm of (event.bookmakers || [])) {
        const label = BOOKIE_LABELS[bm.key] || bm.title || bm.key;

        for (const market of (bm.markets || [])) {
          for (const outcome of (market.outcomes || [])) {
            const norm = normaliseName(outcome.name);
            if (!byRunner[norm]) byRunner[norm] = [];
            byRunner[norm].push({ bookmakerName: label, price: outcome.price });
          }
        }
      }

      // Build a record per runner
      for (const [normName, odds] of Object.entries(byRunner)) {
        odds.sort((a, b) => b.price - a.price); // best price first
        results.push({
          venue,
          raceTime,
          normName,
          bestBookmakerOdds: odds[0] || null,
          allBookmakerOdds:  odds,
        });
      }
    }

    return results;
  }

  _extractVenue(event) {
    // The Odds API typically puts the track name in home_team or the event name
    return event.home_team || event.sport_title || '';
  }

  _setSuccess(sportKey) {
    this.status.connected   = true;
    this.status.lastSuccess = new Date().toISOString();
    this.status.lastError   = null;
    this.status.sport       = sportKey;
  }

  _setError(msg) {
    this.status.connected = false;
    this.status.lastError = msg;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isoToHHMM(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function normaliseName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

module.exports = OddsApiClient;
