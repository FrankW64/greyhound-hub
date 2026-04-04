'use strict';

/**
 * Betfair Exchange API client.
 *
 * Auth flow:
 *  1. POST identitysso.betfair.com/api/login  → sessionToken
 *  2. Send X-Application (appKey) + X-Authentication (token) on every call.
 *
 * If a mid-request TOKEN_ERROR / NO_SESSION is detected the client
 * automatically re-authenticates and retries the call once.
 *
 * Greyhound Racing event type ID: 4339
 *
 * listMarketCatalogue with RUNNER_DESCRIPTION returns per-runner metadata:
 *   CLOTH_NUMBER      → trap / box number
 *   TRAINER_NAME      → trainer
 *   FORM              → recent form string e.g. "12341" or "1-2-3-4-1"
 *   OFFICIAL_RATING   → grade e.g. "A4", "S5"
 *   COLOURS_FILENAME  → jacket image filename
 *   RUNNER_PROFILE    → URL to Betfair runner profile page
 */

const axios = require('axios');

const LOGIN_URL            = 'https://identitysso.betfair.com/api/login';
const API_URL              = 'https://api.betfair.com/exchange/betting/json-rpc/v1';
const GREYHOUND_EVENT_TYPE = '4339';

const AUTH_ERROR_CODES = new Set([
  'NO_SESSION',
  'TOKEN_ERROR',
  'INVALID_SESSION_INFORMATION',
  'NO_APP_KEY',
  'INVALID_APP_KEY',
]);

class BetfairClient {
  constructor({ username, password, appKey }) {
    this.username      = username;
    this.password      = password;
    this.appKey        = appKey;
    this.sessionToken  = null;
    this.sessionExpiry = null;

    this.status = {
      connected:   false,
      lastSuccess: null,
      lastError:   null,
      errorCount:  0,
    };
  }

  // ── Authentication ──────────────────────────────────────────────────────────

  async login() {
    const body = new URLSearchParams();
    body.append('username', this.username);
    body.append('password', this.password);

    const { data } = await axios.post(LOGIN_URL, body, {
      headers: {
        'X-Application': this.appKey,
        'Content-Type':  'application/x-www-form-urlencoded',
        'Accept':        'application/json',
      },
      timeout: 15000,
    });

    if (data.status !== 'SUCCESS') {
      const msg = `Betfair login failed: ${data.error || data.status}`;
      this._setError(msg);
      throw new Error(msg);
    }

    this.sessionToken  = data.token;
    this.sessionExpiry = Date.now() + 23.5 * 60 * 60 * 1000; // re-auth 30 min before 24 h expiry
    console.log('[Betfair] Authenticated successfully');
  }

  async ensureSession() {
    if (!this.sessionToken || Date.now() >= this.sessionExpiry) {
      await this.login();
    }
  }

  // ── Low-level RPC ───────────────────────────────────────────────────────────

  async rpc(method, params, _isRetry = false) {
    await this.ensureSession();

    const body = {
      jsonrpc: '2.0',
      method:  `SportsAPING/v1.0/${method}`,
      params,
      id:      1,
    };

    let data;
    try {
      ({ data } = await axios.post(API_URL, body, {
        headers: {
          'X-Application':    this.appKey,
          'X-Authentication': this.sessionToken,
          'Content-Type':     'application/json',
          'Accept':           'application/json',
        },
        timeout: 15000,
      }));
    } catch (httpErr) {
      this._setError(httpErr.message);
      throw httpErr;
    }

    // Auto-retry once on session expiry
    const authErrCode = extractBetfairAuthError(data);
    if (authErrCode) {
      if (_isRetry) {
        const msg = `Betfair auth error after retry: ${authErrCode}`;
        this._setError(msg);
        throw new Error(msg);
      }
      console.warn(`[Betfair] Session error (${authErrCode}) — re-authenticating…`);
      this.sessionToken  = null;
      this.sessionExpiry = null;
      return this.rpc(method, params, true);
    }

    const apiError = data.error || (data.result && data.result.error);
    if (apiError) {
      const msg = typeof apiError === 'object' ? JSON.stringify(apiError) : String(apiError);
      this._setError(msg);
      throw new Error(`Betfair API error: ${msg}`);
    }

    this._setSuccess();
    return data.result;
  }

  // ── Public methods ──────────────────────────────────────────────────────────

  /**
   * Fetch today's UK greyhound WIN markets using listMarketCatalogue with
   * RUNNER_DESCRIPTION.  Returns fully-populated race card objects — venue,
   * time, distance, grade, and per-runner trap, name, trainer, form — ready
   * to be used as the primary race card source without any other API.
   *
   * Returns: [{
   *   marketId, id, venue, time, date, distance, grade, prize, marketName,
   *   runners: [{ selectionId, trap, name, trainer, form, grade, … }]
   * }]
   */
  async getTodaysRaceMarkets() {
    const now      = new Date();
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);

    const catalogues = await this.rpc('listMarketCatalogue', {
      filter: {
        eventTypeIds:    [GREYHOUND_EVENT_TYPE],
        marketCountries: ['GB'],
        marketTypeCodes: ['WIN'],
        marketStartTime: {
          from: now.toISOString(),
          to:   endOfDay.toISOString(),
        },
      },
      // RUNNER_DESCRIPTION populates runners[].metadata with CLOTH_NUMBER,
      // TRAINER_NAME, FORM, OFFICIAL_RATING, COLOURS_FILENAME, etc.
      marketProjection: ['RUNNER_DESCRIPTION', 'EVENT', 'MARKET_START_TIME'],
      sort:             'FIRST_TO_START',
      maxResults:       '200',
    });

    return (catalogues || []).map(market => {
      const venue    = extractVenue(market);
      const time     = isoToHHMM(market.marketStartTime);
      const date     = market.marketStartTime
        ? market.marketStartTime.split('T')[0]
        : new Date().toISOString().split('T')[0];
      const runners  = (market.runners || []).map(normaliseRunner);
      const grade    = extractGrade(market, runners);
      const distance = extractDistance(market);

      return {
        marketId:   market.marketId,
        id:         makeRaceId(venue, time),
        marketName: market.marketName,
        venue,
        time,
        date,
        distance,
        grade,
        prize:      '',        // not available from Betfair catalogue
        runners,
      };
    });
  }

  /**
   * Best available back prices for a set of markets.
   * Returns: { [marketId]: { [selectionId]: price | null } }
   */
  async getLiveOdds(marketIds) {
    if (!marketIds.length) return {};

    const allBooks = [];
    for (const chunk of chunkArray(marketIds, 200)) {
      const books = await this.rpc('listMarketBook', {
        marketIds:       chunk,
        priceProjection: {
          priceData:             ['EX_BEST_OFFERS'],
          exBestOffersOverrides: { bestPricesDepth: 1 },
        },
      });
      allBooks.push(...(books || []));
    }

    const result = {};
    for (const book of allBooks) {
      result[book.marketId] = {};
      for (const runner of (book.runners || [])) {
        if (runner.status === 'REMOVED') continue;
        const best = runner.ex?.availableToBack?.[0];
        result[book.marketId][runner.selectionId] = best ? best.price : null;
      }
    }
    return result;
  }

  /**
   * Check a set of markets for settlement.
   * Returns entries for markets that are CLOSED with a WINNER identified.
   * Used by DataManager to detect race results after start time passes.
   */
  async getSettledResults(marketIds) {
    if (!marketIds.length) return [];

    const allBooks = [];
    for (const chunk of chunkArray(marketIds, 200)) {
      const books = await this.rpc('listMarketBook', {
        marketIds: chunk,
        priceProjection: { priceData: [] },
      });
      allBooks.push(...(books || []));
    }

    return allBooks
      .filter(b => b.status === 'CLOSED')
      .map(b => {
        const winner = (b.runners || []).find(r => r.status === 'WINNER');
        return winner
          ? { marketId: b.marketId, winnerSelectionId: winner.selectionId }
          : null;
      })
      .filter(Boolean);
  }

  // ── Status helpers ──────────────────────────────────────────────────────────

  _setSuccess() {
    this.status.connected   = true;
    this.status.lastSuccess = new Date().toISOString();
    this.status.lastError   = null;
    this.status.errorCount  = 0;
  }

  _setError(msg) {
    this.status.connected  = false;
    this.status.lastError  = msg;
    this.status.errorCount += 1;
  }
}

// ── Runner normalisation ──────────────────────────────────────────────────────

/**
 * Convert a single Betfair catalogue runner into our internal runner format,
 * pulling all available fields out of the RUNNER_DESCRIPTION metadata.
 */
function normaliseRunner(r) {
  const meta = r.metadata || {};

  return {
    selectionId: r.selectionId,
    trap:        extractTrap(r),
    name:        cleanRunnerName(r.runnerName),
    trainer:     meta.TRAINER_NAME    || '',
    form:        normaliseForm(meta.FORM || ''),
    grade:       meta.OFFICIAL_RATING || '',
    // profile URL available for linking to Betfair runner page
    profileUrl:  meta.RUNNER_PROFILE  || null,
    // Odds are not yet known — filled later from getLiveOdds()
    openingOdds:       null,
    currentOdds:       null,
    tipSources:        [],
    tipsCount:         0,
    tipPositions:      {},
    isTipped:          false,
    isBestBet:         false,
    isEachWayOutsider: false,
    bestBookmakerOdds: null,
    allBookmakerOdds:  [],
  };
}

// ── Market-level field extraction ─────────────────────────────────────────────

function extractVenue(market) {
  // event.venue is the most reliable source
  if (market.event?.venue) return market.event.venue;
  // Some tracks omit venue; try stripping the date suffix from event.name
  // e.g. "Romford 15th Jan" → "Romford"
  if (market.event?.name) {
    return market.event.name
      .replace(/\s+\d{1,2}(st|nd|rd|th)?\s+\w+\s*$/i, '')
      .trim();
  }
  // Last resort: marketName is typically "HH:MM" — not useful for venue
  return '';
}

function extractDistance(market) {
  // Some Betfair market names include distance: "14:30 400m" or "T1-6 400m A4"
  const text = `${market.marketName || ''} ${market.event?.name || ''}`;
  const m    = text.match(/(\d{3,4})\s*m\b/i);
  return m ? `${m[1]}m` : '';
}

function extractGrade(market, normalisedRunners) {
  // Best source: first runner's OFFICIAL_RATING metadata
  const runnerGrade = normalisedRunners.find(r => r.grade)?.grade;
  if (runnerGrade) return runnerGrade;
  // Fallback: try parsing from market name (e.g. "A4", "S5", "OR75")
  const text = `${market.marketName || ''} ${market.event?.name || ''}`;
  const m    = text.match(/\b([ABS]\d+|OR\d+)\b/i);
  return m ? m[1].toUpperCase() : '';
}

// ── Runner-level field extraction ─────────────────────────────────────────────

function extractTrap(runner) {
  // CLOTH_NUMBER is the canonical trap / box number for greyhounds
  const cloth = runner.metadata?.CLOTH_NUMBER;
  if (cloth) return parseInt(cloth, 10);
  // Fallback: leading digit in runnerName "1. Dog Name"
  const m = (runner.runnerName || '').match(/^(\d+)[.\s]/);
  if (m) return parseInt(m[1], 10);
  return runner.sortPriority || 0;
}

function cleanRunnerName(name) {
  return (name || '')
    .replace(/^\d+\.\s*/,              '')   // "1. Dog Name"      → "Dog Name"
    .replace(/^Trap\s*\d+\s*[-–]\s*/i, '')   // "Trap 1 - Dog"     → "Dog"
    .trim();
}

function normaliseForm(form) {
  if (!form) return '';
  // Betfair may return "12341" (digits only) — insert dashes for readability
  if (!form.includes('-') && /^\d+$/.test(form)) {
    return form.split('').join('-');
  }
  return form;
}

// ── Misc helpers ──────────────────────────────────────────────────────────────

function makeRaceId(venue, time) {
  const v = venue.toUpperCase().replace(/\s+/g, '').slice(0, 3);
  const t = time.replace(':', '');
  return `${v}-${t}`;
}

function isoToHHMM(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function extractBetfairAuthError(data) {
  if (data?.error?.code && AUTH_ERROR_CODES.has(data.error.code)) return data.error.code;
  const exCode = data?.result?.error?.data?.APINGException?.errorCode;
  if (exCode && AUTH_ERROR_CODES.has(exCode)) return exCode;
  return null;
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

module.exports = BetfairClient;
