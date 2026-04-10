'use strict';

/**
 * algorithmTipper.js — proprietary greyhound tip algorithm.
 *
 * Requires full Timeform history (positions 1–6) in dog_run_history.
 * Dogs without full history receive neutral scores on history signals
 * so trap bias can still differentiate them.
 *
 *  Signal              Weight  Description
 *  ──────────────────  ──────  ────────────────────────────────────────────────
 *  Win rate            30%     Wins / total runs in last 30 days
 *  Avg position        25%     Mean finishing position (lower = better)
 *  Grade quality       20%     Avg grade of races entered (A1 beats A6)
 *  Trap bias           15%     Historical win % for this trap at this venue
 *  Venue wins          10%     Number of wins at this specific track
 *
 * All signals normalised within the race.
 * Tip only generated if top dog beats second by more than MIN_CONFIDENCE_GAP.
 */

const { getRunStats } = require('./dogHistory');

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
  winRate:    0.30,
  avgPos:     0.25,
  grade:      0.20,
  trapBias:   0.15,
  venueWins:  0.10,
};

const MIN_CONFIDENCE_GAP = 0.04;

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

// ── Scoring ───────────────────────────────────────────────────────────────────

function scoreRace(race) {
  const runnerStats = race.runners.map(runner => {
    const dogNorm = norm(runner.name);
    const trap    = runner.trap || null;
    const stats   = getRunStats(dogNorm, { days: 30, venue: race.venue });
    return { runner, trap, stats };
  });

  // Only use full Timeform data — dogs without it get neutral 0.5 on history signals
  const fullIndices = runnerStats.map((r, i) => r.stats.hasFullHistory ? i : -1).filter(i => i >= 0);

  // Win rate — normalised only among dogs with full history
  const normWinRate = new Array(runnerStats.length).fill(0.5);
  if (fullIndices.length > 1) {
    const rates     = fullIndices.map(i => runnerStats[i].stats.winRate);
    const normed    = normaliseValues(rates);
    fullIndices.forEach((idx, j) => { normWinRate[idx] = normed[j]; });
  }

  // Avg position — invert so lower (better) scores higher
  const normAvgPos = new Array(runnerStats.length).fill(0.5);
  if (fullIndices.length > 1) {
    const inverted  = fullIndices.map(i => -(runnerStats[i].stats.avgPosition ?? 7));
    const normed    = normaliseValues(inverted);
    fullIndices.forEach((idx, j) => { normAvgPos[idx] = normed[j]; });
  }

  // Grade and venue wins — normalised across all runners
  const normGrade     = normaliseValues(runnerStats.map(r => r.stats.avgGradeScore));
  const normVenueWins = normaliseValues(runnerStats.map(r => r.stats.venueWins));

  return runnerStats.map((rs, i) => {
    const { runner, trap, stats } = rs;
    const hasHistory = stats.hasFullHistory;

    const s_winRate   = hasHistory ? normWinRate[i]   : 0.5;
    const s_avgPos    = hasHistory ? normAvgPos[i]     : 0.5;
    const s_grade     = hasHistory ? normGrade[i]      : 0.5;
    const s_trap      = trapBiasScore(race.venue, trap);
    const s_venue     = hasHistory ? normVenueWins[i]  : 0.5;

    const score =
      s_winRate  * WEIGHTS.winRate   +
      s_avgPos   * WEIGHTS.avgPos    +
      s_grade    * WEIGHTS.grade     +
      s_trap     * WEIGHTS.trapBias  +
      s_venue    * WEIGHTS.venueWins;

    return { runner, score, signals: { s_winRate, s_avgPos, s_grade, s_trap, s_venue }, hasHistory };
  }).sort((a, b) => b.score - a.score);
}

// ── Main export ───────────────────────────────────────────────────────────────

function generateAlgorithmTips(races) {
  const tips = [];
  let skipped = 0;

  for (const race of races) {
    if (!race.runners || race.runners.length < 2) continue;

    const scored = scoreRace(race);
    const best   = scored[0];
    const second = scored[1];

    const gap = best.score - (second?.score ?? 0);
    if (gap < MIN_CONFIDENCE_GAP) { skipped++; continue; }

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

  console.log(`[Algorithm] ${tips.length} tips from ${races.length} races (${skipped} skipped — low confidence)`);
  return tips;
}

module.exports = { generateAlgorithmTips };
