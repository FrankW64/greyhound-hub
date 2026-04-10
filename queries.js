'use strict';

/**
 * queries.js — ready-made query functions for the tipping algorithm.
 *
 * All functions return plain JS arrays or objects — no raw SQL outside this file.
 */

const { getDb } = require('./src/database');

// ── Runners ───────────────────────────────────────────────────────────────────

/**
 * All runners for a date with trap stats and trainer stats joined in.
 * @param {string} date  YYYY-MM-DD
 */
function getRunnersByDate(date) {
  return getDb().prepare(`
    SELECT
      m.venue,
      m.date,
      r.race_time,
      r.grade,
      r.distance,
      ru.trap_number,
      ru.dog_name,
      ru.trainer,
      ru.finish_position,
      ru.race_time_seconds,
      ts.win_percentage  AS trap_win_pct,
      tr.win_percentage  AS trainer_win_pct
    FROM   meetings m
    JOIN   races    r  ON r.meeting_id = m.meeting_id
    JOIN   runners  ru ON ru.race_id   = r.id
    LEFT JOIN trap_stats    ts ON ts.venue = m.venue AND ts.trap_number = ru.trap_number AND (ts.distance = r.distance OR ts.distance IS NULL)
    LEFT JOIN trainer_stats tr ON tr.trainer_name = ru.trainer
    WHERE  m.date = ?
    ORDER  BY m.venue, r.race_time, ru.trap_number
  `).all(date);
}

// ── Trap bias ─────────────────────────────────────────────────────────────────

/**
 * Trap win percentage for a specific venue and trap.
 * @param {string} venue
 * @param {number} trapNumber
 * @returns {{ venue, trap_number, distance, wins, total_runs, win_percentage } | null}
 */
function getTrapBias(venue, trapNumber) {
  return getDb().prepare(`
    SELECT * FROM trap_stats
    WHERE venue = ? AND trap_number = ?
    ORDER BY total_runs DESC
    LIMIT 1
  `).get(venue, trapNumber) || null;
}

// ── Trainer form ──────────────────────────────────────────────────────────────

/**
 * Trainer win rate over the last N days (from runners table, not trainer_stats snapshot).
 * @param {string} trainerName
 * @param {number} days
 */
function getTrainerForm(trainerName, days = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().split('T')[0];

  return getDb().prepare(`
    SELECT
      ru.trainer,
      COUNT(*)                                              AS total_runs,
      SUM(CASE WHEN ru.finish_position = 1 THEN 1 ELSE 0 END) AS wins,
      ROUND(
        100.0 * SUM(CASE WHEN ru.finish_position = 1 THEN 1 ELSE 0 END) / COUNT(*),
        2
      )                                                    AS win_percentage
    FROM   runners  ru
    JOIN   races    r  ON r.id        = ru.race_id
    JOIN   meetings m  ON m.meeting_id = r.meeting_id
    WHERE  ru.trainer = ?
      AND  m.date    >= ?
      AND  ru.finish_position IS NOT NULL
  `).get(trainerName, sinceStr) || { trainer: trainerName, total_runs: 0, wins: 0, win_percentage: 0 };
}

// ── Dog form ──────────────────────────────────────────────────────────────────

/**
 * A dog's last N race results.
 * @param {string} dogName
 * @param {number} limit
 */
function getDogForm(dogName, limit = 10) {
  return getDb().prepare(`
    SELECT
      m.date,
      m.venue,
      r.race_time,
      r.grade,
      r.distance,
      ru.trap_number,
      ru.finish_position,
      ru.race_time_seconds
    FROM   runners  ru
    JOIN   races    r  ON r.id         = ru.race_id
    JOIN   meetings m  ON m.meeting_id  = r.meeting_id
    WHERE  ru.dog_name = ?
    ORDER  BY m.date DESC, r.race_time DESC
    LIMIT  ?
  `).all(dogName, limit);
}

// ── Best traps at venue ───────────────────────────────────────────────────────

/**
 * Best performing traps at a venue sorted by win percentage.
 * @param {string} venue
 */
function getBestTrapsAtVenue(venue) {
  return getDb().prepare(`
    SELECT   trap_number, distance, wins, total_runs, win_percentage
    FROM     trap_stats
    WHERE    venue = ?
    ORDER    BY win_percentage DESC
  `).all(venue);
}

// ── In-form trainers ──────────────────────────────────────────────────────────

/**
 * Trainers above a win rate threshold in the last 30 days (live from runners table).
 * @param {number} minWinRate  0–100
 */
function getInFormTrainers(minWinRate = 25) {
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const sinceStr = since.toISOString().split('T')[0];

  return getDb().prepare(`
    SELECT
      ru.trainer,
      COUNT(*)                                              AS total_runs,
      SUM(CASE WHEN ru.finish_position = 1 THEN 1 ELSE 0 END) AS wins,
      ROUND(
        100.0 * SUM(CASE WHEN ru.finish_position = 1 THEN 1 ELSE 0 END) / COUNT(*),
        2
      )                                                    AS win_percentage
    FROM   runners  ru
    JOIN   races    r  ON r.id         = ru.race_id
    JOIN   meetings m  ON m.meeting_id  = r.meeting_id
    WHERE  m.date >= ?
      AND  ru.finish_position IS NOT NULL
    GROUP  BY ru.trainer
    HAVING win_percentage >= ?
       AND total_runs >= 10
    ORDER  BY win_percentage DESC
  `).all(sinceStr, minWinRate);
}

// ── Races by venue and grade ──────────────────────────────────────────────────

/**
 * Race results for a specific venue and grade.
 * @param {string} venue
 * @param {string} grade
 */
function getRacesByVenueAndGrade(venue, grade) {
  return getDb().prepare(`
    SELECT
      m.date,
      r.race_time,
      r.distance,
      ru.trap_number,
      ru.dog_name,
      ru.trainer,
      ru.finish_position,
      ru.race_time_seconds
    FROM   meetings m
    JOIN   races    r  ON r.meeting_id = m.meeting_id
    JOIN   runners  ru ON ru.race_id   = r.id
    WHERE  m.venue   = ?
      AND  r.grade   = ?
    ORDER  BY m.date DESC, r.race_time, ru.finish_position
  `).all(venue, grade);
}

module.exports = {
  getRunnersByDate,
  getTrapBias,
  getTrainerForm,
  getDogForm,
  getBestTrapsAtVenue,
  getInFormTrainers,
  getRacesByVenueAndGrade,
};
