'use strict';

/**
 * algorithmTipper.js — proprietary greyhound tip algorithm.
 *
 * Note: GBGB results API returns winners only (position = 1).
 * All form signals are therefore designed around winning history.
 *
 * Signals and weights:
 * ─────────────────────────────────────────────────────────────────────────────
 *  Signal              Weight  Description
 *  ──────────────────  ──────  ─────────────────────────────────────────────
 *  Win frequency       30%     Wins in last 30 days — normalised within race
 *  Win recency         25%     Days since last win — recent winners score higher
 *  Grade quality       20%     Average grade of wins — A1 wins beat A6 wins
 *  Trap bias           15%     Venue-specific trap win % (hardcoded stats)
 *  Venue wins          10%     Has this dog won at this track before?
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Dogs with no history get a neutral score (0.5) on history-based signals
 * so trap bias can still differentiate them.
 *
 * Confidence filter: only tip if score gap between 1st and 2nd > MIN_GAP.
 */

const { getWinStats } = require('./dogHistory');

// ── Trap bias table ───────────────────────────────────────────────────────────

const TRAP_BIAS = {
  'Central Park':  [15.3, 18.1, 18.4, 20.4, 16.6, 19.5],
  'Doncaster':     [22.9, 18.8, 19.8, 18.8, 17.9, 23.6],
  'Dunstall Park': [17.9, 17.8, 14.4, 18.1, 20.5, 16.2],
  'Harlow':        [18.6, 18.2, 18.6, 20.1, 16.2, 21.6],
  'Hove':          [18.4, 19.7, 19.0, 19.2, 25.0, 19.1],
  'Kinsley':       [18.4, 18.3, 18.9, 16.0, 13.0, 16.7],
  'Monmore':       [21.1, 15.2, 17.8, 15.8, 19.7, 17.2],
  'Newcastle':     [20.0, 18.2, 18.5, 18.0, 17.9, 16.5],
  'Nottingham':    [17.2, 21.9, 18.9, 19.2, 15.9, 16.3],
  'Oxford':        [18.7, 18.3, 20.0, 20.1, 22.4, 15.6],
  'Pelaw Grange':  [18.3, 18.2, 22.7, 23.5, 16.7, 17.0],
  'Romford':       [18.2, 18.4, 17.9, 18.3, 16.3, 15.9],
  'Sheffield':     [21.9, 17.0, 23.1, 20.2, 17.6, 15.3],
  'Suffolk Downs': [21.2, 26.5, 17.2, 18.7, 21.7, 18.5],
  'Sunderland':    [20.5, 19.1, 14.6, 15.6, 18.3, 18.3],
  'The Valley':    [21.9, 16.8, 15.0, 12.5, 19.5, 22.1],
  'Towcester':     [21.3, 16.3, 19.9, 20.4, 14.2, 14.7],
  'Yarmouth':      [19.0, 20.2, 20.4, 20.3, 15.9, 17.0],
};

const WEIGHTS = {
  winFrequency: 0.30,
  winRecency:   0.25,
  gradeQuality: 0.20,
  trapBias:     0.15,
  venueWins:    0.10,
};

const MIN_CONFIDENCE_GAP = 0.04;
const MAX_DAYS_SINCE_WIN = 30; // beyond this, recency score = 0

// ── Helpers ───────────────────────────────────────────────────────────────────

function normaliseValues(values) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 0.5);
  return values.map(v => (v - min) / (max - min));
}

function norm(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function trapBiasScore(venue, trap) {
  const biases = TRAP_BIAS[venue];
  if (!biases || !trap || trap < 1 || trap > biases.length) return 0.5;
  return normaliseValues(biases)[trap - 1];
}

/**
 * Recency score: 1.0 if won yesterday, decays linearly to 0 at MAX_DAYS_SINCE_WIN.
 * Dogs with no history get 0.5 (neutral).
 */
function recencyScore(daysSinceWin) {
  if (daysSinceWin === null) return 0.5;
  return Math.max(0, 1 - daysSinceWin / MAX_DAYS_SINCE_WIN);
}

// ── Per-race scoring ──────────────────────────────────────────────────────────

function scoreRace(race) {
  // Gather raw stats for each runner
  const runnerStats = race.runners.map(runner => {
    const dogNorm = norm(runner.name);
    const trap    = runner.trap || null;

    const stats = getWinStats(dogNorm, {
      days:  30,
      venue: race.venue,
      trap,
    });

    return { runner, dogNorm, trap, stats };
  });

  // Normalise win frequency and grade quality within the race
  // (so signals are relative to other runners in the same race)
  const winCounts    = runnerStats.map(r => r.stats.winCount);
  const gradScores   = runnerStats.map(r => r.stats.avgGradeScore);
  const venueWinCts  = runnerStats.map(r => r.stats.venueWins);

  const normWinCount  = normaliseValues(winCounts);
  const normGrade     = normaliseValues(gradScores);
  const normVenueWins = normaliseValues(venueWinCts);

  // Compute final weighted score per runner
  return runnerStats.map((rs, i) => {
    const { runner, trap, stats } = rs;

    const s_freq    = stats.hasHistory ? normWinCount[i]  : 0.5;
    const s_recency = recencyScore(stats.daysSinceWin);
    const s_grade   = stats.hasHistory ? normGrade[i]     : 0.5;
    const s_trap    = trapBiasScore(race.venue, trap);
    const s_venue   = stats.hasHistory ? normVenueWins[i] : 0.5;

    const score =
      s_freq    * WEIGHTS.winFrequency +
      s_recency * WEIGHTS.winRecency   +
      s_grade   * WEIGHTS.gradeQuality +
      s_trap    * WEIGHTS.trapBias     +
      s_venue   * WEIGHTS.venueWins;

    return {
      runner,
      score,
      signals: { s_freq, s_recency, s_grade, s_trap, s_venue },
      hasHistory: stats.hasHistory,
    };
  }).sort((a, b) => b.score - a.score);
}

// ── Main export ───────────────────────────────────────────────────────────────

function generateAlgorithmTips(races) {
  const tips = [];
  let skippedNoConfidence = 0;

  for (const race of races) {
    if (!race.runners || race.runners.length < 2) continue;

    const scored = scoreRace(race);
    const best   = scored[0];
    const second = scored[1];

    const gap = best.score - (second?.score ?? 0);
    if (gap < MIN_CONFIDENCE_GAP) { skippedNoConfidence++; continue; }

    tips.push({
      source:     'algorithm',
      sourceName: 'Algorithm',
      dogName:    best.runner.name,
      venue:      race.venue,
      raceTime:   race.time,
      position:   1,
      confidence: parseFloat(best.score.toFixed(3)),
    });
  }

  console.log(`[Algorithm] ${tips.length} tips from ${races.length} races (${skippedNoConfidence} skipped — low confidence)`);
  return tips;
}

module.exports = { generateAlgorithmTips };
