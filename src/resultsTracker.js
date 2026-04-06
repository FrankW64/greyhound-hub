'use strict';

/**
 * ResultsTracker — records tip snapshots before races and results after,
 * then computes per-source accuracy statistics.
 *
 * Backed by SQLite (src/database.js) instead of the legacy JSON flat-file.
 *
 * Public API (unchanged from the JSON version):
 *   snapshotTips(races)                       → void
 *   recordResult(race, selectionId, name)     → void
 *   getTodaysResults()                        → { raceId: result, … }
 *   getAccuracyStats(days?)                   → stats object
 */

const { getDb } = require('./database');

function normaliseName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

class ResultsTracker {

  // ── Snapshot tips ────────────────────────────────────────────────────────────

  /**
   * Persist tipped runners for each unseen race.
   * Called after mergeTips + applyBadgeLogic so all flags are populated.
   * UNIQUE constraint on (race_id, race_date, dog_name_norm, source) — first write wins.
   */
  snapshotTips(races) {
    const db    = getDb();
    const today = new Date().toISOString().split('T')[0];
    const now   = new Date().toISOString();

    const insert = db.prepare(`
      INSERT OR IGNORE INTO tips
        (race_id, race_date, venue, race_time, dog_name, dog_name_norm,
         selection_id, source, position, is_best_bet, is_ew_outsider,
         win_tip_count, snapshotted_at)
      VALUES
        (@race_id, @race_date, @venue, @race_time, @dog_name, @dog_name_norm,
         @selection_id, @source, @position, @is_best_bet, @is_ew_outsider,
         @win_tip_count, @snapshotted_at)
    `);

    const run = db.transaction(() => {
      for (const race of races) {
        for (const runner of race.runners) {
          if (!(runner.tipSources?.length)) continue;
          for (const source of runner.tipSources) {
            insert.run({
              race_id:        race.id,
              race_date:      today,
              venue:          race.venue,
              race_time:      race.time,
              dog_name:       runner.name,
              dog_name_norm:  normaliseName(runner.name),
              selection_id:   runner.selectionId || null,
              source,
              position:       (runner.tipPositions || {})[source] || 1,
              is_best_bet:    runner.isBestBet    ? 1 : 0,
              is_ew_outsider: runner.isEachWayOutsider ? 1 : 0,
              win_tip_count:  runner.winTipCount  || 0,
              snapshotted_at: now,
            });
          }
        }
      }
    });

    run();
  }

  // ── Record result ─────────────────────────────────────────────────────────────

  /**
   * Record the winner of a settled race.
   * UNIQUE on (race_id, race_date) — duplicate calls are silently ignored.
   */
  recordResult(race, winnerSelectionId, winnerName) {
    const db    = getDb();
    const today = new Date().toISOString().split('T')[0];

    db.prepare(`
      INSERT OR IGNORE INTO results
        (race_id, race_date, venue, race_time, winner_name, winner_name_norm,
         winner_selection_id, settled_at)
      VALUES
        (@race_id, @race_date, @venue, @race_time, @winner_name, @winner_name_norm,
         @winner_selection_id, @settled_at)
    `).run({
      race_id:             race.id,
      race_date:           today,
      venue:               race.venue,
      race_time:           race.time,
      winner_name:         winnerName,
      winner_name_norm:    normaliseName(winnerName),
      winner_selection_id: winnerSelectionId || null,
      settled_at:          new Date().toISOString(),
    });

    // Log whether any tipped dog won this race
    this._logTipOutcome(db, race.id, today, winnerName, winnerSelectionId);
    console.log(`[ResultsTracker] Result: ${race.venue} ${race.time} → ${winnerName}`);
  }

  /** Print a log line for each tip that won (or missed) this race. */
  _logTipOutcome(db, raceId, raceDate, winnerName, winnerSelectionId) {
    const winnerNorm = normaliseName(winnerName);

    const tips = db.prepare(`
      SELECT DISTINCT source, dog_name, dog_name_norm, selection_id, position, is_best_bet
      FROM tips
      WHERE race_id = ? AND race_date = ? AND position = 1
    `).all(raceId, raceDate);

    for (const tip of tips) {
      const won = (winnerSelectionId && tip.selection_id)
        ? tip.selection_id === winnerSelectionId
        : tip.dog_name_norm === winnerNorm;

      const label = tip.is_best_bet ? '⭐ Best Bet' : '✓ Tip';
      if (won) {
        console.log(`[ResultsTracker] ✅ WINNER — ${label} [${tip.source}] ${tip.dog_name} won!`);
      } else {
        console.log(`[ResultsTracker] ❌ missed — [${tip.source}] tipped ${tip.dog_name}, winner was ${winnerName}`);
      }
    }
  }

  // ── Today's results ───────────────────────────────────────────────────────────

  /** Returns a map of raceId → result for today's settled races. */
  getTodaysResults() {
    const db    = getDb();
    const today = new Date().toISOString().split('T')[0];
    const rows  = db.prepare('SELECT * FROM results WHERE race_date = ?').all(today);
    const map   = {};
    for (const r of rows) {
      map[r.race_id] = {
        raceId:             r.race_id,
        venue:              r.venue,
        raceTime:           r.race_time,
        winnerName:         r.winner_name,
        winnerNameNorm:     r.winner_name_norm,
        winnerSelectionId:  r.winner_selection_id,
        settledAt:          r.settled_at,
      };
    }
    return map;
  }

  // ── Accuracy stats ────────────────────────────────────────────────────────────

  /**
   * Compute accuracy by joining tips → results.
   * @param {number} days  Look-back window (default 30)
   */
  getAccuracyStats(days = 30) {
    const db = getDb();
    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceStr = since.toISOString().split('T')[0];

    // Settled races in window
    const settledRaces = db.prepare(
      'SELECT COUNT(*) AS n FROM results WHERE race_date >= ?'
    ).get(sinceStr).n;

    // Join tips to results — a tip "won" if the dog_name_norm matches the winner
    const rows = db.prepare(`
      SELECT
        t.source,
        t.is_best_bet,
        t.is_ew_outsider,
        t.dog_name_norm,
        t.selection_id    AS tip_sel,
        r.winner_name_norm,
        r.winner_selection_id,
        CASE
          WHEN t.selection_id IS NOT NULL AND r.winner_selection_id IS NOT NULL
               AND t.selection_id = r.winner_selection_id               THEN 1
          WHEN t.dog_name_norm = r.winner_name_norm                      THEN 1
          ELSE 0
        END AS won
      FROM tips t
      JOIN results r ON t.race_id = r.race_id AND t.race_date = r.race_date
      WHERE t.race_date >= ?
        AND t.position = 1
    `).all(sinceStr);

    const stats = {
      days,
      settledRaces,
      overall:    { tips: 0, wins: 0, rate: null },
      bySource:   {},
      bestBet:    { tips: 0, wins: 0, rate: null },
      ewOutsider: { tips: 0, wins: 0, rate: null },
    };

    // Deduplicate: for overall count each runner once (not once per source)
    const runnerKey = new Set();

    for (const row of rows) {
      // Per-source
      if (!stats.bySource[row.source]) {
        stats.bySource[row.source] = { tips: 0, wins: 0, rate: null };
      }
      stats.bySource[row.source].tips++;
      if (row.won) stats.bySource[row.source].wins++;

      // Overall — deduplicate by dog+race
      const key = `${row.dog_name_norm}|${row.race_date}`;
      if (!runnerKey.has(key)) {
        runnerKey.add(key);
        stats.overall.tips++;
        if (row.won) stats.overall.wins++;
      }

      if (row.is_best_bet) {
        stats.bestBet.tips++;
        if (row.won) stats.bestBet.wins++;
      }
      if (row.is_ew_outsider) {
        stats.ewOutsider.tips++;
        if (row.won) stats.ewOutsider.wins++;
      }
    }

    const rate = (w, t) => t > 0 ? parseFloat((w / t * 100).toFixed(1)) : null;
    stats.overall.rate    = rate(stats.overall.wins,    stats.overall.tips);
    stats.bestBet.rate    = rate(stats.bestBet.wins,    stats.bestBet.tips);
    stats.ewOutsider.rate = rate(stats.ewOutsider.wins, stats.ewOutsider.tips);
    for (const s of Object.values(stats.bySource)) s.rate = rate(s.wins, s.tips);

    return stats;
  }

  // ── Storage info ──────────────────────────────────────────────────────────────

  /** Returns row counts and DB file size for display/diagnostics. */
  getStorageInfo() {
    const db   = getDb();
    const tips = db.prepare('SELECT COUNT(*) AS n FROM tips').get().n;
    const res  = db.prepare('SELECT COUNT(*) AS n FROM results').get().n;
    const days = db.prepare(
      'SELECT COUNT(DISTINCT race_date) AS n FROM results'
    ).get().n;
    const { DB_FILE } = require('./database');
    let sizeKb = null;
    try {
      const fs = require('fs');
      sizeKb = Math.round(fs.statSync(DB_FILE).size / 1024);
    } catch (_) {}
    return { tips, results: res, daysOfData: days, fileSizeKb: sizeKb };
  }
}

module.exports = ResultsTracker;
