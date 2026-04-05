'use strict';

/**
 * DataManager — central state hub.
 *
 * Responsibilities:
 *  • Hold the current races state (merged from all data sources)
 *  • Run the polling loop (default 60 s)
 *  • Merge race cards, live Betfair odds, The Odds API bookmaker odds, and tips
 *  • Apply best-bet / tipped badge logic
 *  • Expose API connection status for the health endpoint + header indicator
 */

const { generateMockRaces } = require('./mockData');
const BetfairClient          = require('./betfair');
const { fetchAllTips }       = require('./scraper');
const { fetchRaceCards, fetchTodaysResults } = require('./racecardScraper');
const ResultsTracker         = require('./resultsTracker');

class DataManager {
  constructor() {
    this.races       = [];
    this.lastUpdated = null;
    this.useMockData = true;
    this.isPolling   = false;

    this.betfair        = null;
    this.useScraperMode = false;
    this._refreshing    = false;  // guard against concurrent refreshes

    // Persists the first-seen Betfair price as morning odds across refreshes
    this._morningOddsCache = {};

    this._scraperStatus  = null;
    this.resultsTracker  = null;
    this._pendingResults = new Map(); // marketId → race (for result detection)
  }

  // ── Initialisation ──────────────────────────────────────────────────────────

  init() {
    const {
      USE_MOCK_DATA,
      BETFAIR_USERNAME, BETFAIR_PASSWORD, BETFAIR_APP_KEY,
      POLL_INTERVAL,
    } = process.env;

    // Mode selection:
    //   USE_MOCK_DATA=true            → mock mode (demo data, no scraping)
    //   BETFAIR_USERNAME set          → full live mode (Betfair odds + scraper tips)
    //   Neither                       → scraper mode (GBGB race cards + tip scrapers, no odds)
    const forceMock = USE_MOCK_DATA === 'true';
    this.useMockData    = forceMock;
    this.useScraperMode = !forceMock && !BETFAIR_USERNAME;

    if (this.useScraperMode) {
      console.log('[DataManager] Scraper mode — GBGB race cards + tip scrapers (no exchange odds)');
    } else if (!forceMock) {
      this.betfair = new BetfairClient({
        username: BETFAIR_USERNAME,
        password: BETFAIR_PASSWORD,
        appKey:   BETFAIR_APP_KEY,
      });
      console.log('[DataManager] Live mode — Betfair is primary source');
    } else {
      console.log('[DataManager] Mock data mode enabled');
    }

    this.resultsTracker = new ResultsTracker();
    console.log('[DataManager] Results tracker initialised');

    const intervalMs = (parseInt(POLL_INTERVAL, 10) || 60) * 1000;
    this.refresh().catch(err => console.error('[DataManager] Initial refresh error:', err));

    this.isPolling = true;
    this._pollTimer = setInterval(() => {
      this.refresh().catch(err => console.error('[DataManager] Poll error:', err));
    }, intervalMs);

    console.log(`[DataManager] Polling every ${intervalMs / 1000}s`);
  }

  stop() {
    if (this._pollTimer) clearInterval(this._pollTimer);
    this.isPolling = false;
  }

  // ── Main refresh cycle ──────────────────────────────────────────────────────

  async refresh() {
    if (this._refreshing) {
      console.log('[DataManager] Refresh already in progress — skipping');
      return;
    }
    this._refreshing = true;
    console.log('[DataManager] Refreshing…');

    try {
      let races;

      if (this.useMockData) {
        races = generateMockRaces();
        races = simulateOddsMovement(races);
      } else if (this.useScraperMode) {
        races = await this._fetchScraperRaces();
        // Publish race cards immediately so the UI isn't blank while tips load
        if (races.length) {
          this.races       = applyBadgeLogic(mergeTips(races, []));
          this.lastUpdated = new Date().toISOString();
          console.log(`[DataManager] Race cards published early — ${races.length} races`);
        }
      } else {
        races = await this._fetchLiveRaces();
      }

      // Tips: real scrape in live/scraper mode; derive from mock tipSources in demo mode
      // Pass races so Racing Post scraper can resolve trap numbers to dog names
      const tips = this.useMockData
        ? buildMockTips(races)
        : await fetchAllTips(races).catch(err => {
            console.warn('[DataManager] Tips scrape failed:', err.message);
            return [];
          });

      // Diagnostic: log sample tip names and match result
      if (tips.length) {
        const sample = [...new Set(tips.map(t => t.dogName).filter(Boolean))].slice(0, 8);
        console.log(`[DataManager] Tip dog names sample: ${sample.join(', ')}`);
      }

      races = mergeTips(races, tips);

      const tippedCount = races.flatMap(r => r.runners).filter(r => r.tipsCount > 0).length;
      console.log(`[DataManager] Tips merged: ${tips.length} tips → ${tippedCount} tipped runners`);

      races = applyBadgeLogic(races);

      // Snapshot tips for new races (persisted; first snapshot wins)
      if (this.resultsTracker) this.resultsTracker.snapshotTips(races);

      // Register live markets for post-race result detection
      if (!this.useMockData) {
        for (const race of races) {
          if (race.marketId && !this._pendingResults.has(race.marketId)) {
            this._pendingResults.set(race.marketId, race);
          }
        }
        await this._checkPendingResults();
      }

      this.races       = races;
      this.lastUpdated = new Date().toISOString();
      console.log(`[DataManager] Refresh complete — ${races.length} races`);
    } catch (err) {
      console.error('[DataManager] Refresh failed:', err.message);
      // Keep existing data so the UI stays populated
    } finally {
      this._refreshing = false;
    }
  }

  // ── Live data fetch ─────────────────────────────────────────────────────────

  async _fetchLiveRaces() {
    // 1. listMarketCatalogue (RUNNER_DESCRIPTION) → full race cards
    //    This single call gives us: venue, time, distance, grade, and per-runner
    //    trap number, name, trainer, form from Betfair metadata.
    const markets = await this.betfair.getTodaysRaceMarkets();
    if (!markets.length) return [];

    // 2. listMarketBook → live best-back prices, keyed by selectionId
    const oddsMap = await this.betfair.getLiveOdds(markets.map(m => m.marketId));

    // 3. Merge live odds into runners using selectionId (exact match, no fuzzy name lookup)
    const races = markets.map(market =>
      applyLiveOdds(market, oddsMap[market.marketId] || {}, this._morningOddsCache)
    );

    return races;
  }

  // ── Scraper mode race fetch ─────────────────────────────────────────────────

  async _fetchScraperRaces() {
    try {
      const races = await fetchRaceCards();
      this._scraperStatus = {
        connected:   true,
        lastSuccess: new Date().toISOString(),
        lastError:   null,
      };
      if (!races.length) {
        console.warn('[DataManager] Scraper returned 0 races — check source sites');
      }
      return races;
    } catch (err) {
      this._scraperStatus = {
        connected:   false,
        lastError:   err.message,
        lastSuccess: this._scraperStatus?.lastSuccess || null,
      };
      // Return last known races so the UI stays populated
      console.error('[DataManager] Race card scrape failed:', err.message);
      return this.races || [];
    }
  }

  // ── Results detection ───────────────────────────────────────────────────────

  async _checkPendingResults() {
    const now = Date.now();
    const toCheck = [];

    for (const [marketId, race] of this._pendingResults) {
      // Build a UTC timestamp for race start; check 4+ minutes after start
      const raceMs = new Date(`${race.date}T${race.time}:00Z`).getTime();
      if (raceMs < now - 4 * 60 * 1000) toCheck.push(marketId);
    }

    if (!toCheck.length) return;

    try {
      const settled = await this.betfair.getSettledResults(toCheck);
      for (const { marketId, winnerSelectionId } of settled) {
        const race = this._pendingResults.get(marketId);
        if (!race) continue;
        const winnerRunner = race.runners.find(r => r.selectionId === winnerSelectionId);
        const winnerName   = winnerRunner?.name || '';
        this.resultsTracker.recordResult(race, winnerSelectionId, winnerName);
        this._pendingResults.delete(marketId);
      }
    } catch (err) {
      console.warn('[DataManager] Results check error:', err.message);
    }
  }

  // ── Public getters ──────────────────────────────────────────────────────────

  getState() {
    return {
      races:       this.races,
      lastUpdated: this.lastUpdated,
      useMockData: this.useMockData,
    };
  }

  getApiStatus() {
    return {
      betfair: this.betfair
        ? this.betfair.status
        : { connected: false, lastError: 'Not configured', lastSuccess: null, errorCount: 0 },
      scraper: this.useScraperMode
        ? (this._scraperStatus || { connected: false, lastError: 'Pending first fetch', lastSuccess: null })
        : { connected: false, lastError: 'Not in scraper mode', lastSuccess: null },
    };
  }

  getGroupedByVenue() {
    const { races, lastUpdated, useMockData } = this.getState();

    // Attach today's settled results to matching races
    const todaysResults = this.useMockData
      ? this._getMockTodaysResults()
      : this.resultsTracker
        ? this.resultsTracker.getTodaysResults()
        : {};

    const venueMap = new Map();
    for (const race of races) {
      const raceWithResult = todaysResults[race.id]
        ? { ...race, result: todaysResults[race.id] }
        : race;
      if (!venueMap.has(race.venue)) venueMap.set(race.venue, []);
      venueMap.get(race.venue).push(raceWithResult);
    }

    venueMap.forEach(list => list.sort((a, b) => a.time.localeCompare(b.time)));

    const venues = [...venueMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, races]) => ({ name, races }));

    return { venues, lastUpdated, useMockData, apiStatus: this.getApiStatus() };
  }

  getAccuracyStats() {
    if (this.useMockData) return generateMockAccuracyStats();
    return this.resultsTracker ? this.resultsTracker.getAccuracyStats() : null;
  }

  // In mock mode, inject a fake settled result for the first race so the UI is demonstrable
  _getMockTodaysResults() {
    const today   = new Date().toISOString().split('T')[0];
    const races   = this.races || [];
    const first   = races[0];
    if (!first) return {};
    // Pick the first tipped runner as the mock winner, otherwise trap 1
    const winner  = first.runners.find(r => r.isBestBet) ||
                    first.runners.find(r => r.isTipped)  ||
                    first.runners[0];
    return {
      [first.id]: {
        raceId:            first.id,
        raceDate:          today,
        winnerName:        winner.name,
        winnerNameNorm:    winner.name.toLowerCase().replace(/[^a-z0-9]/g, ''),
        winnerSelectionId: winner.selectionId || null,
        settledAt:         new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      },
    };
  }
}

// ── Tips merging ──────────────────────────────────────────────────────────────

function normaliseName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function mergeTips(races, tips) {
  return races.map(race => ({
    ...race,
    runners: race.runners.map(runner => {
      const key     = normaliseName(runner.name);
      const matched = tips.filter(t => normaliseName(t.dogName) === key);
      const sources = [...new Set(matched.map(t => t.source))];

      // Build position map: source → best (lowest) position seen from that source
      const tipPositions = {};
      for (const tip of matched) {
        const pos = tip.position || 1;
        if (tipPositions[tip.source] === undefined || pos < tipPositions[tip.source]) {
          tipPositions[tip.source] = pos;
        }
      }

      return { ...runner, tipSources: sources, tipsCount: sources.length, tipPositions };
    }),
  }));
}

function applyBadgeLogic(races) {
  const allSources = new Set();
  for (const race of races)
    for (const runner of race.runners)
      runner.tipSources.forEach(s => allSources.add(s));
  const totalSources = allSources.size || 2;

  return races.map(race => ({
    ...race,
    runners: race.runners.map(runner => {
      const isTipped         = runner.tipsCount >= 2;
      const drifted          = runner.currentOdds > runner.openingOdds;
      const isBestBet        = runner.tipsCount >= totalSources && drifted;
      const isEachWayOutsider = runner.tipsCount >= 1 && (runner.currentOdds || 0) >= 7.0;
      return { ...runner, isTipped, isBestBet, isEachWayOutsider };
    }),
  }));
}

// ── Betfair odds application ──────────────────────────────────────────────────

/**
 * Merge live prices from listMarketBook into a race that was built from
 * listMarketCatalogue.  Matching is by selectionId — exact, no fuzzy lookup.
 * The first price seen for a runner is cached as its "morning opening odds".
 */
function applyLiveOdds(market, marketOdds, morningCache) {
  const runners = market.runners.map(runner => {
    const liveOdds = marketOdds[runner.selectionId] ?? null;
    const cacheKey = `${market.venue}-${market.time}-${runner.selectionId}`;

    // Persist first-seen price as morning odds
    if (liveOdds !== null && !morningCache[cacheKey]) {
      morningCache[cacheKey] = liveOdds;
    }

    return {
      ...runner,
      openingOdds: morningCache[cacheKey] ?? liveOdds,
      currentOdds: liveOdds,
    };
  });

  return { ...market, runners };
}

// ── Mock helpers ──────────────────────────────────────────────────────────────

const SOURCE_NAMES = {
  timeform:   'Timeform',
  attheraces: 'At The Races',
  racingpost: 'Racing Post',
};

function buildMockTips(races) {
  const tips = [];
  for (const race of races)
    for (const runner of race.runners)
      for (const source of (runner.tipSources || [])) {
        const position = (runner.tipPositions || {})[source] ?? 1;
        tips.push({
          source,
          sourceName: SOURCE_NAMES[source] || source,
          dogName:    runner.name,
          venue:      race.venue,
          raceTime:   race.time,
          position,
        });
      }
  return tips;
}

function simulateOddsMovement(races) {
  return races.map(race => ({
    ...race,
    runners: race.runners.map(runner => {
      const tick    = (Math.random() - 0.5) * 0.1;
      const newOdds = Math.max(1.01, parseFloat((runner.currentOdds + tick).toFixed(2)));
      return { ...runner, currentOdds: newOdds };
    }),
  }));
}

function generateMockAccuracyStats() {
  return {
    days:         30,
    settledRaces: 47,
    overall:    { tips: 89, wins: 27, rate: 30.3 },
    bySource: {
      timeform:   { tips: 38, wins: 12, rate: 31.6 },
      attheraces: { tips: 34, wins: 10, rate: 29.4 },
      racingpost: { tips: 17, wins:  5, rate: 29.4 },
    },
    bestBet:    { tips: 8, wins: 4, rate: 50.0 },
    ewOutsider: { tips: 14, wins: 5, rate: 35.7 },
  };
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function normaliseVenue(v) {
  return (v || '').toLowerCase().replace(/\s+/g, '');
}

module.exports = DataManager;
