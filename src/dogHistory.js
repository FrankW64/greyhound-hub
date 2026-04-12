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

// ── Signal helpers ────────────────────────────────────────────────────────────

/**
 * Convert a beaten-distance string to numeric lengths.
 * Winners (null / "-") = 0. Returns null if unparseable.
 */
function beatToLengths(beaten) {
  if (!beaten || beaten === '-') return 0;
  const lower = beaten.toLowerCase().trim();
  const shorthand = { 'sh': 0.1, 'shd': 0.1, 'hd': 0.2, 'nk': 0.4, 'snk': 0.3 };
  if (shorthand[lower] !== undefined) return shorthand[lower];
  // Handle fractions: "1¼" → 1.25, "½" → 0.5, "2¾" → 2.75
  const normalised = lower
    .replace(/¼/g, '.25').replace(/½/g, '.5').replace(/¾/g, '.75')
    .replace(/\s+/g, '');
  const n = parseFloat(normalised);
  return isNaN(n) ? null : n;
}

/**
 * Parse a run comment for starting ability.
 * Returns 0–1: higher = better/faster start.
 */
function startScore(comment) {
  if (!comment) return 0.5;
  const c = comment.toLowerCase();
  if (c.includes('vqaw'))                         return 1.0;
  if (c.includes('qaw'))                          return 0.75;
  if (c.includes('msdbrk') || c.includes('msdbk')) return 0.0;
  if (c.includes('saw'))                          return 0.25;
  return 0.5; // neutral — no start comment
}

/**
 * Return true if a run comment contains interference keywords
 * that excuse a bad result (crowded, bumped, forced to check, fell).
 */
function hasInterference(comment) {
  if (!comment) return false;
  const c = comment.toLowerCase();
  return /crd|bmp|fcdtck|fell|stumbled|checked|ck/.test(c);
}

// ── Full run stats ────────────────────────────────────────────────────────────

/**
 * Return comprehensive stats for a dog using all finishing positions.
 *
 * @param {string} dogNameNorm
 * @param {object} opts
 * @param {number} opts.days    Look-back window in days (default 30)
 * @param {string} opts.venue   Current race venue
 * @param {number} opts.trap    Current trap number
 *
 * @returns {{
 *   runCount:         number,
 *   winCount:         number,
 *   winRate:          number,   0–1
 *   avgPosition:      number,   mean finishing position (lower = better)
 *   daysSinceRun:     number|null,
 *   avgGradeScore:    number,
 *   venueWins:        number,
 *   avgSpeedIndex:    number|null,  distance/run_time averaged (higher = faster)
 *   avgBeatenLengths: number|null,  avg lengths beaten by (lower = closer to winning)
 *   avgStartScore:    number,       0–1 start ability from run comments
 *   hasFullHistory:   boolean,
 *   hasHistory:       boolean,
 * }}
 */
function getRunStats(dogNameNorm, { days = 30, venue = null, trap = null, asOf = null, distance = null } = {}) {
  const db    = getDb();
  const base  = asOf ? new Date(asOf) : new Date();
  const since = new Date(base);
  since.setDate(since.getDate() - days);
  const sinceStr  = since.toISOString().split('T')[0];
  const asOfStr   = base.toISOString().split('T')[0];

  const runs = db.prepare(`
    SELECT race_date, venue, trap, grade, position,
           run_time, distance, beaten, run_comment
    FROM   dog_run_history
    WHERE  dog_name_norm = ?
      AND  race_date >= ?
      AND  race_date <  ?
    ORDER  BY race_date DESC
  `).all(dogNameNorm, sinceStr, asOfStr);

  if (!runs.length) {
    return {
      runCount: 0, winCount: 0, winRate: 0, avgPosition: null,
      daysSinceRun: null, avgGradeScore: 0, venueWins: 0,
      avgSpeedIndex: null, avgBeatenLengths: null, avgStartScore: 0.5,
      distanceWinRate: null, distanceRunCount: 0,
      formTrajectory: null,
      hasFullHistory: false, hasHistory: false,
    };
  }

  const wins     = runs.filter(r => r.position === 1);
  const winCount = wins.length;
  const runCount = runs.length;
  const winRate  = winCount / runCount;

  // Days since most recent run (relative to asOf date)
  const latest       = new Date(runs[0].race_date);
  const refDate      = new Date(asOfStr);
  refDate.setHours(0, 0, 0, 0);
  const daysSinceRun = Math.floor((refDate - latest) / 86400000);

  // Average grade score
  const gradedRuns    = runs.filter(r => r.grade);
  const avgGradeScore = gradedRuns.length
    ? gradedRuns.reduce((s, r) => s + gradeScore(r.grade), 0) / gradedRuns.length
    : 0;

  // Average finishing position (discount interfered runs from the average)
  const cleanRuns   = runs.filter(r => !hasInterference(r.run_comment));
  const posRuns     = cleanRuns.length ? cleanRuns : runs; // fallback to all if all had interference
  const avgPosition = posRuns.reduce((s, r) => s + r.position, 0) / posRuns.length;

  // Venue wins
  const venueNorm = (venue || '').toLowerCase().trim();
  const venueWins = venue
    ? wins.filter(w => (w.venue || '').toLowerCase().trim() === venueNorm).length
    : 0;

  // Speed index: distance / run_time (metres per second — higher = faster)
  const speedRuns = runs.filter(r => r.run_time && r.distance && r.run_time > 0);
  const avgSpeedIndex = speedRuns.length
    ? speedRuns.reduce((s, r) => s + (r.distance / r.run_time), 0) / speedRuns.length
    : null;

  // Closeness score: average lengths beaten by across all runs
  // Winners count as 0, non-winners use beaten field
  const beatenRuns = runs.map(r => {
    if (r.position === 1) return 0;
    return beatToLengths(r.beaten);
  }).filter(v => v !== null);
  const avgBeatenLengths = beatenRuns.length
    ? beatenRuns.reduce((s, v) => s + v, 0) / beatenRuns.length
    : null;

  // Starting ability: average start score from run comments
  const startScores  = runs.map(r => startScore(r.run_comment));
  const avgStartScore = startScores.reduce((s, v) => s + v, 0) / startScores.length;

  // Distance suitability — win rate specifically at today's race distance
  let distanceWinRate  = null;
  let distanceRunCount = 0;
  if (distance) {
    const distRuns     = runs.filter(r => r.distance === distance);
    distanceRunCount   = distRuns.length;
    if (distanceRunCount > 0) {
      distanceWinRate  = distRuns.filter(r => r.position === 1).length / distanceRunCount;
    }
  }

  // Form trajectory — compare avg beaten lengths in last 5 runs vs previous 5 runs
  // Positive value = improving (less beaten recently), negative = declining
  let formTrajectory = null;
  if (runs.length >= 6) {
    const beatenAvg = (runSet) => {
      const vals = runSet.map(r => {
        if (r.position === 1) return 0;
        const b = beatToLengths(r.beaten);
        return b !== null ? b : 5; // default 5 lengths if unknown
      });
      return vals.reduce((s, v) => s + v, 0) / vals.length;
    };
    const recentBeaten = beatenAvg(runs.slice(0, 5));  // most recent 5
    const olderBeaten  = beatenAvg(runs.slice(5, 10)); // previous 5
    formTrajectory = olderBeaten - recentBeaten; // positive = beating less recently = improving
  }

  // Full history = any non-winner row present (Timeform data)
  const hasFullHistory = runs.some(r => r.position > 1);

  return {
    runCount,
    winCount,
    winRate,
    avgPosition,
    daysSinceRun,
    avgGradeScore,
    venueWins,
    avgSpeedIndex,
    avgBeatenLengths,
    avgStartScore,
    distanceWinRate,
    distanceRunCount,
    formTrajectory,
    hasFullHistory,
    hasHistory: true,
  };
}

module.exports = { storeRunners, getRunStats, gradeScore, beatToLengths, startScore };
