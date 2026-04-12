'use strict';

/**
 * dogHistory.js — store and query per-dog race history from Timeform.
 *
 * Stores full finishing positions (1–6) for all runners scraped from
 * Timeform results pages. Used by the algorithm to compute win rate,
 * avg finishing position, grade quality, and venue wins.
 *
 * Public API:
 *   storeRunners(runners)          → void
 *   getRunStats(dogNameNorm, opts) → full stats object
 *   gradeScore(grade)              → numeric quality score
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
    INSERT INTO dog_run_history
      (race_date, venue, race_time, grade, distance,
       dog_name, dog_name_norm, trap, position, run_time,
       beaten, run_comment, created_at)
    VALUES
      (@race_date, @venue, @race_time, @grade, @distance,
       @dog_name, @dog_name_norm, @trap, @position, @run_time,
       @beaten, @run_comment, @created_at)
    ON CONFLICT(race_date, venue, race_time, dog_name_norm) DO UPDATE SET
      run_time    = COALESCE(excluded.run_time,    run_time),
      beaten      = COALESCE(excluded.beaten,      beaten),
      run_comment = COALESCE(excluded.run_comment, run_comment),
      grade       = COALESCE(excluded.grade,       grade),
      distance    = COALESCE(excluded.distance,    distance),
      trap        = COALESCE(excluded.trap,        trap)
  `);

  const run = db.transaction(() => {
    for (const r of runners) {
      insert.run({
        race_date:     r.raceDate,
        venue:         r.venue,
        race_time:     r.raceTime,
        grade:         r.grade      || null,
        distance:      r.distance   || null,
        dog_name:      r.dogName,
        dog_name_norm: norm(r.dogName),
        trap:          r.trap       || null,
        position:      r.position,
        run_time:      r.runTime    || null,
        beaten:        r.beaten     || null,
        run_comment:   r.runComment || null,
        created_at:    now,
      });
    }
  });

  run();
}

// ── Full run stats ────────────────────────────────────────────────────────────

/**
 * Return comprehensive stats for a dog using all finishing positions.
 * Falls back to wins-only signals when non-winner rows aren't present.
 *
 * @param {string} dogNameNorm
 * @param {object} opts
 * @param {number} opts.days    Look-back window in days (default 30)
 * @param {string} opts.venue   Current race venue
 * @param {number} opts.trap    Current trap number
 *
 * @returns {{
 *   runCount:       number,
 *   winCount:       number,
 *   winRate:        number,   0–1
 *   avgPosition:    number,   mean finishing position (lower = better); null if no data
 *   daysSinceRun:   number|null,
 *   avgGradeScore:  number,
 *   venueWins:      number,
 *   hasFullHistory: boolean,  true if non-winner rows exist (Timeform data)
 *   hasHistory:     boolean,
 * }}
 */
function getRunStats(dogNameNorm, { days = 30, venue = null, trap = null } = {}) {
  const db    = getDb();
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().split('T')[0];

  const runs = db.prepare(`
    SELECT race_date, venue, trap, grade, position
    FROM   dog_run_history
    WHERE  dog_name_norm = ?
      AND  race_date >= ?
    ORDER  BY race_date DESC
  `).all(dogNameNorm, sinceStr);

  if (!runs.length) {
    return {
      runCount: 0, winCount: 0, winRate: 0, avgPosition: null,
      daysSinceRun: null, avgGradeScore: 0, venueWins: 0,
      hasFullHistory: false, hasHistory: false,
    };
  }

  const wins    = runs.filter(r => r.position === 1);
  const winCount = wins.length;
  const runCount = runs.length;
  const winRate  = runCount > 0 ? winCount / runCount : 0;

  // Days since most recent run
  const latest     = new Date(runs[0].race_date);
  const today      = new Date();
  today.setHours(0, 0, 0, 0);
  const daysSinceRun = Math.floor((today - latest) / 86400000);

  // Average grade (from all runs, not just wins)
  const gradedRuns    = runs.filter(r => r.grade);
  const avgGradeScore = gradedRuns.length
    ? gradedRuns.reduce((s, r) => s + gradeScore(r.grade), 0) / gradedRuns.length
    : 0;

  // Average finishing position
  const avgPosition = runCount > 0
    ? runs.reduce((s, r) => s + r.position, 0) / runCount
    : null;

  // Venue wins
  const venueNorm = (venue || '').toLowerCase().trim();
  const venueWins = venue
    ? wins.filter(w => (w.venue || '').toLowerCase().trim() === venueNorm).length
    : 0;

  // Determine if we have full (non-winners-only) data
  // If any run has position > 1, data is from Timeform (full)
  const hasFullHistory = runs.some(r => r.position > 1);

  return {
    runCount,
    winCount,
    winRate,
    avgPosition,
    daysSinceRun,
    avgGradeScore,
    venueWins,
    hasFullHistory,
    hasHistory: true,
  };
}

module.exports = { storeRunners, getRunStats, gradeScore };
