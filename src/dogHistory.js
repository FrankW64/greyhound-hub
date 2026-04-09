'use strict';

/**
 * dogHistory.js — store and query per-dog form from GBGB run history.
 *
 * Public API:
 *   storeRunners(runners)          → void   — persist today's GBGB runner rows
 *   getForm(dogNameNorm, opts)     → form   — last N runs + aggregated stats
 *   getVenueRecord(dogNameNorm, venue) → { runs, wins, avgPos }
 *   getGradeHistory(dogNameNorm)   → [{ grade, date }] newest first
 */

const { getDb } = require('./database');

function norm(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ── Store runners ─────────────────────────────────────────────────────────────

/**
 * Persist an array of runner objects (from fetchGbgbAllRunners) into
 * dog_run_history. UNIQUE constraint silently ignores duplicates.
 */
function storeRunners(runners) {
  if (!runners || !runners.length) return;
  const db  = getDb();
  const now = new Date().toISOString();

  const insert = db.prepare(`
    INSERT OR IGNORE INTO dog_run_history
      (race_date, venue, race_time, grade, distance,
       dog_name, dog_name_norm, trap, position, run_time, created_at)
    VALUES
      (@race_date, @venue, @race_time, @grade, @distance,
       @dog_name, @dog_name_norm, @trap, @position, @run_time, @created_at)
  `);

  const run = db.transaction(() => {
    for (const r of runners) {
      insert.run({
        race_date:    r.raceDate,
        venue:        r.venue,
        race_time:    r.raceTime,
        grade:        r.grade     || null,
        distance:     r.distance  || null,
        dog_name:     r.dogName,
        dog_name_norm: norm(r.dogName),
        trap:         r.trap      || null,
        position:     r.position,
        run_time:     r.runTime   || null,
        created_at:   now,
      });
    }
  });

  run();
}

// ── Query form ────────────────────────────────────────────────────────────────

/**
 * Return recent form for a dog.
 * @param {string} dogNameNorm   Normalised dog name
 * @param {object} opts
 * @param {number} opts.runs     How many recent runs to include (default 10)
 * @returns {{
 *   recentRuns: Array,
 *   winRate:    number,   // 0–1
 *   avgPos:     number,
 *   totalRuns:  number,
 *   avgTime:    number|null,
 *   bestTime:   number|null,
 * }}
 */
function getForm(dogNameNorm, { runs = 10 } = {}) {
  const db = getDb();

  const recentRuns = db.prepare(`
    SELECT race_date, venue, race_time, grade, distance, trap, position, run_time
    FROM   dog_run_history
    WHERE  dog_name_norm = ?
    ORDER  BY race_date DESC, race_time DESC
    LIMIT  ?
  `).all(dogNameNorm, runs);

  if (!recentRuns.length) {
    return { recentRuns: [], winRate: null, avgPos: null, totalRuns: 0, avgTime: null, bestTime: null };
  }

  const totalRuns = recentRuns.length;
  const wins      = recentRuns.filter(r => r.position === 1).length;
  const winRate   = wins / totalRuns;
  const avgPos    = recentRuns.reduce((s, r) => s + r.position, 0) / totalRuns;

  const timesWithData = recentRuns.filter(r => r.run_time > 0);
  const avgTime = timesWithData.length
    ? timesWithData.reduce((s, r) => s + r.run_time, 0) / timesWithData.length
    : null;
  const bestTime = timesWithData.length
    ? Math.min(...timesWithData.map(r => r.run_time))
    : null;

  return { recentRuns, winRate, avgPos, totalRuns, avgTime, bestTime };
}

// ── Venue record ──────────────────────────────────────────────────────────────

/**
 * How does this dog perform at a specific venue?
 */
function getVenueRecord(dogNameNorm, venue) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT position, run_time
    FROM   dog_run_history
    WHERE  dog_name_norm = ? AND LOWER(venue) = LOWER(?)
    ORDER  BY race_date DESC
    LIMIT  20
  `).all(dogNameNorm, venue);

  if (!rows.length) return { runs: 0, wins: 0, winRate: null, avgPos: null };

  const wins   = rows.filter(r => r.position === 1).length;
  const avgPos = rows.reduce((s, r) => s + r.position, 0) / rows.length;
  return {
    runs:    rows.length,
    wins,
    winRate: wins / rows.length,
    avgPos,
  };
}

// ── Grade trend ───────────────────────────────────────────────────────────────

/**
 * Return recent grade history for a dog, newest first.
 * Used to detect whether a dog is being raised/lowered in class.
 */
function getGradeHistory(dogNameNorm, limit = 6) {
  const db = getDb();
  return db.prepare(`
    SELECT grade, race_date, position
    FROM   dog_run_history
    WHERE  dog_name_norm = ? AND grade IS NOT NULL
    ORDER  BY race_date DESC, race_time DESC
    LIMIT  ?
  `).all(dogNameNorm, limit);
}

/**
 * Estimate grade trajectory: positive = improving (dropping in grade number),
 * negative = declining, 0 = stable or insufficient data.
 */
function gradeTrajectory(dogNameNorm) {
  const history = getGradeHistory(dogNameNorm, 4);
  if (history.length < 2) return 0;

  // Extract numeric part of grade (A1=1, A6=6, OR1=1, etc.)
  const gradeNum = g => parseInt((g || '').replace(/[^0-9]/g, ''), 10) || 0;

  const latest   = gradeNum(history[0].grade);
  const previous = gradeNum(history[history.length - 1].grade);

  if (!latest || !previous) return 0;
  // Dropping grade number = improving (A6→A5 is positive)
  return previous - latest; // positive = improving
}

// ── Trap record ───────────────────────────────────────────────────────────────

/**
 * How does this dog perform from a specific trap?
 */
function getTrapRecord(dogNameNorm, trap) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT position
    FROM   dog_run_history
    WHERE  dog_name_norm = ? AND trap = ?
    ORDER  BY race_date DESC
    LIMIT  20
  `).all(dogNameNorm, trap);

  if (!rows.length) return { runs: 0, wins: 0, winRate: null };
  const wins = rows.filter(r => r.position === 1).length;
  return { runs: rows.length, wins, winRate: wins / rows.length };
}

module.exports = { storeRunners, getForm, getVenueRecord, gradeTrajectory, getTrapRecord };
