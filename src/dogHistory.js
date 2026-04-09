'use strict';

/**
 * dogHistory.js — store and query per-dog form from GBGB run history.
 *
 * Important: the GBGB results API only returns winners (resultPosition = 1).
 * All queries are therefore based on winning runs only. Signals are designed
 * around what winners-only data can meaningfully tell us.
 *
 * Public API:
 *   storeRunners(runners)           → void
 *   getWinStats(dogNameNorm, opts)  → win stats object
 */

const { getDb } = require('./database');

function norm(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ── Grade scoring ─────────────────────────────────────────────────────────────

/**
 * Convert a GBGB grade string to a numeric quality score (higher = better).
 * A1 is the highest graded race; A10/B grades are lower class.
 * Open/OR races score highest.
 */
function gradeScore(grade) {
  if (!grade) return 0;
  const g = grade.toUpperCase().trim();

  // Open/OR grades — top level
  if (/^(OR|OPEN|OA|OI)/.test(g)) return 10;

  // Extract letter prefix and number
  const m = g.match(/^([A-Z]+)(\d+)?/);
  if (!m) return 0;

  const letter = m[1];
  const num    = parseInt(m[2] || '1', 10);

  const baseScore = {
    A: 8, B: 5, D: 4, S: 4, P: 2, T: 1,
  }[letter] ?? 1;

  // Within a letter group, lower number = better quality
  return Math.max(0, baseScore - (num - 1) * 0.5);
}

// ── Store runners ─────────────────────────────────────────────────────────────

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
        race_date:     r.raceDate,
        venue:         r.venue,
        race_time:     r.raceTime,
        grade:         r.grade    || null,
        distance:      r.distance || null,
        dog_name:      r.dogName,
        dog_name_norm: norm(r.dogName),
        trap:          r.trap     || null,
        position:      r.position,
        run_time:      r.runTime  || null,
        created_at:    now,
      });
    }
  });

  run();
}

// ── Win stats ─────────────────────────────────────────────────────────────────

/**
 * Return all meaningful win-based stats for a dog.
 *
 * @param {string} dogNameNorm
 * @param {object} opts
 * @param {number} opts.days    Look-back window in days (default 30)
 * @param {string} opts.venue   Current race venue (for venue signal)
 * @param {number} opts.trap    Current trap number (for trap signal)
 *
 * @returns {{
 *   winCount:       number,   total wins in window (0 = no history)
 *   daysSinceWin:   number|null,  days since most recent win (null = never)
 *   avgGradeScore:  number,   mean grade quality of wins (0–10)
 *   venueWins:      number,   wins at this specific venue
 *   trapWins:       number,   wins from this specific trap
 *   hasHistory:     boolean,
 * }}
 */
function getWinStats(dogNameNorm, { days = 30, venue = null, trap = null } = {}) {
  const db    = getDb();
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().split('T')[0];

  const wins = db.prepare(`
    SELECT race_date, venue, trap, grade
    FROM   dog_run_history
    WHERE  dog_name_norm = ?
      AND  race_date >= ?
      AND  position = 1
    ORDER  BY race_date DESC
  `).all(dogNameNorm, sinceStr);

  if (!wins.length) {
    return { winCount: 0, daysSinceWin: null, avgGradeScore: 0, venueWins: 0, trapWins: 0, hasHistory: false };
  }

  // Days since most recent win
  const latest      = new Date(wins[0].race_date);
  const today       = new Date();
  today.setHours(0, 0, 0, 0);
  const daysSinceWin = Math.floor((today - latest) / 86400000);

  // Average grade quality score
  const gradedWins   = wins.filter(w => w.grade);
  const avgGradeScore = gradedWins.length
    ? gradedWins.reduce((s, w) => s + gradeScore(w.grade), 0) / gradedWins.length
    : 0;

  // Venue and trap wins
  const venueNorm = (venue || '').toLowerCase().trim();
  const venueWins = venue
    ? wins.filter(w => (w.venue || '').toLowerCase().trim() === venueNorm).length
    : 0;
  const trapWins  = trap
    ? wins.filter(w => w.trap === trap).length
    : 0;

  return {
    winCount:      wins.length,
    daysSinceWin,
    avgGradeScore,
    venueWins,
    trapWins,
    hasHistory:    true,
  };
}

module.exports = { storeRunners, getWinStats, gradeScore };
