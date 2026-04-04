'use strict';

/**
 * ResultsTracker — records tip snapshots before races and results after,
 * then computes per-source accuracy statistics.
 *
 * Tip snapshots: stored on first poll that sees a race (UNIQUE on raceId+date).
 * Race results:  recorded when Betfair reports the market as CLOSED with a WINNER.
 * Accuracy:      joins snapshots → results and aggregates by source / badge type.
 */

const { load, save } = require('./store');

function normaliseName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

class ResultsTracker {
  constructor() {
    this._data = load();
  }

  // ── Snapshot ────────────────────────────────────────────────────────────────

  /**
   * Persist tipped runners for each unseen race.
   * Called after mergeTips + applyBadgeLogic so all flags are populated.
   * UNIQUE on raceId+raceDate — first snapshot wins, never overwritten.
   */
  snapshotTips(races) {
    const today = new Date().toISOString().split('T')[0];
    const existingKeys = new Set(
      this._data.snapshots.map(s => `${s.raceId}|${s.raceDate}`)
    );

    let changed = false;
    for (const race of races) {
      const key = `${race.id}|${today}`;
      if (existingKeys.has(key)) continue;

      const tippedRunners = race.runners.filter(r => r.tipsCount > 0);
      if (!tippedRunners.length) continue;

      this._data.snapshots.push({
        raceId:       race.id,
        marketId:     race.marketId || null,
        raceDate:     today,
        venue:        race.venue,
        raceTime:     race.time,
        runners:      tippedRunners.map(r => ({
          name:              r.name,
          nameNorm:          normaliseName(r.name),
          selectionId:       r.selectionId || null,
          sources:           r.tipSources || [],
          tipPositions:      r.tipPositions || {},
          isBestBet:         !!r.isBestBet,
          isEachWayOutsider: !!r.isEachWayOutsider,
        })),
        snapshottedAt: new Date().toISOString(),
      });

      existingKeys.add(key);
      changed = true;
    }

    if (changed) save(this._data);
  }

  // ── Record result ───────────────────────────────────────────────────────────

  /**
   * Record the winner of a settled race.
   * Matching priority: selectionId > normalised name.
   */
  recordResult(race, winnerSelectionId, winnerName) {
    const today = new Date().toISOString().split('T')[0];

    const alreadyRecorded = this._data.results.some(
      r => r.raceId === race.id && r.raceDate === today
    );
    if (alreadyRecorded) return;

    this._data.results.push({
      raceId:            race.id,
      raceDate:          today,
      venue:             race.venue,
      raceTime:          race.time,
      winnerName,
      winnerNameNorm:    normaliseName(winnerName),
      winnerSelectionId: winnerSelectionId || null,
      settledAt:         new Date().toISOString(),
    });

    save(this._data);
    console.log(`[ResultsTracker] Result: ${race.venue} ${race.time} → ${winnerName}`);
  }

  // ── Today's results ────────────────────────────────────────────────────────

  /** Returns a map of raceId → result for today's settled races. */
  getTodaysResults() {
    const today = new Date().toISOString().split('T')[0];
    const map   = {};
    for (const r of this._data.results) {
      if (r.raceDate === today) map[r.raceId] = r;
    }
    return map;
  }

  // ── Accuracy stats ──────────────────────────────────────────────────────────

  /**
   * Compute accuracy by joining snapshots to results.
   * @param {number} days  Look-back window (default 30 days)
   */
  getAccuracyStats(days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceStr = since.toISOString().split('T')[0];

    // Index results by raceId|raceDate for O(1) lookup
    const resultMap = new Map();
    for (const r of this._data.results) {
      if (r.raceDate >= sinceStr) {
        resultMap.set(`${r.raceId}|${r.raceDate}`, r);
      }
    }

    const stats = {
      days,
      settledRaces: resultMap.size,
      overall:    { tips: 0, wins: 0, rate: null },
      bySource:   {},
      bestBet:    { tips: 0, wins: 0, rate: null },
      ewOutsider: { tips: 0, wins: 0, rate: null },
    };

    for (const snap of this._data.snapshots) {
      if (snap.raceDate < sinceStr) continue;
      const result = resultMap.get(`${snap.raceId}|${snap.raceDate}`);
      if (!result) continue; // not yet settled

      for (const runner of snap.runners) {
        const won = result.winnerSelectionId && runner.selectionId
          ? runner.selectionId === result.winnerSelectionId
          : runner.nameNorm === result.winnerNameNorm;

        // Per-source
        for (const src of runner.sources) {
          if (!stats.bySource[src]) stats.bySource[src] = { tips: 0, wins: 0, rate: null };
          stats.bySource[src].tips++;
          if (won) stats.bySource[src].wins++;
        }

        // Overall (once per runner, not per source)
        stats.overall.tips++;
        if (won) stats.overall.wins++;

        if (runner.isBestBet) {
          stats.bestBet.tips++;
          if (won) stats.bestBet.wins++;
        }

        if (runner.isEachWayOutsider) {
          stats.ewOutsider.tips++;
          if (won) stats.ewOutsider.wins++;
        }
      }
    }

    // Compute rates
    const rate = (a, b) => b > 0 ? parseFloat((a / b * 100).toFixed(1)) : null;
    stats.overall.rate   = rate(stats.overall.wins,   stats.overall.tips);
    stats.bestBet.rate   = rate(stats.bestBet.wins,   stats.bestBet.tips);
    stats.ewOutsider.rate = rate(stats.ewOutsider.wins, stats.ewOutsider.tips);
    for (const s of Object.values(stats.bySource)) {
      s.rate = rate(s.wins, s.tips);
    }

    return stats;
  }
}

module.exports = ResultsTracker;
