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
 *  Win rate            20%     Wins / total runs in last 30 days
 *  Avg position        15%     Mean finishing position (excl. interfered runs)
 *  Closeness           15%     Avg lengths beaten by (lower = closer to winning)
 *  Speed rating        15%     Avg distance/run_time index (higher = faster)
 *  Grade quality       12%     Avg grade of races entered (A1 beats A6)
 *  Trap bias           10%     Historical win % for this trap at this venue
 *  Start ability        8%     Avg starting speed from run comments (QAw/SAw)
 *  Venue wins           5%     Number of wins at this specific track
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
  winRate:    0.20,
  avgPos:     0.15,
  closeness:  0.15,
  speed:      0.15,
  grade:      0.12,
  trapBias:   0.10,
  startAbility: 0.08,
  venueWins:  0.05,
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

function scoreRace(race, { asOf = null } = {}) {
  const runnerStats = race.runners.map(runner => {
    const dogNorm = norm(runner.name);
    const trap    = runner.trap || null;
    const stats   = getRunStats(dogNorm, { days: 30, venue: race.venue, asOf });
    return { runner, trap, stats };
  });

  // Only use full Timeform data — dogs without it get neutral 0.5 on history signals
  const fullIndices = runnerStats.map((r, i) => r.stats.hasFullHistory ? i : -1).filter(i => i >= 0);

  // Helper: normalise only among dogs with full history, fill rest with 0.5
  function normAmongFull(valueFn) {
    const arr = new Array(runnerStats.length).fill(0.5);
    if (fullIndices.length > 1) {
      const vals   = fullIndices.map(i => valueFn(runnerStats[i].stats));
      const normed = normaliseValues(vals);
      fullIndices.forEach((idx, j) => { arr[idx] = normed[j]; });
    }
    return arr;
  }

  // Win rate
  const normWinRate = normAmongFull(s => s.winRate);

  // Avg position — invert so lower (better) scores higher
  const normAvgPos = normAmongFull(s => -(s.avgPosition ?? 7));

  // Closeness — invert beaten lengths so less beaten = higher score
  const normCloseness = normAmongFull(s => -(s.avgBeatenLengths ?? 99));

  // Speed index — higher = faster
  const normSpeed = normAmongFull(s => s.avgSpeedIndex ?? 0);

  // Start ability — already 0–1, normalise within race
  const normStart = normAmongFull(s => s.avgStartScore);

  // Grade and venue wins — normalised across all runners
  const normGrade     = normaliseValues(runnerStats.map(r => r.stats.avgGradeScore));
  const normVenueWins = normaliseValues(runnerStats.map(r => r.stats.venueWins));

  return runnerStats.map((rs, i) => {
    const { runner, trap, stats } = rs;
    const h = stats.hasFullHistory;

    const s_winRate      = h ? normWinRate[i]   : 0.5;
    const s_avgPos       = h ? normAvgPos[i]     : 0.5;
    const s_closeness    = h ? normCloseness[i]  : 0.5;
    const s_speed        = h ? normSpeed[i]      : 0.5;
    const s_grade        = h ? normGrade[i]      : 0.5;
    const s_trap         = trapBiasScore(race.venue, trap);
    const s_startAbility = h ? normStart[i]      : 0.5;
    const s_venue        = h ? normVenueWins[i]  : 0.5;

    const score =
      s_winRate      * WEIGHTS.winRate      +
      s_avgPos       * WEIGHTS.avgPos       +
      s_closeness    * WEIGHTS.closeness    +
      s_speed        * WEIGHTS.speed        +
      s_grade        * WEIGHTS.grade        +
      s_trap         * WEIGHTS.trapBias     +
      s_startAbility * WEIGHTS.startAbility +
      s_venue        * WEIGHTS.venueWins;

    return {
      runner, score, hasHistory: h,
      signals: { s_winRate, s_avgPos, s_closeness, s_speed, s_grade, s_trap, s_startAbility, s_venue },
    };
  }).sort((a, b) => b.score - a.score);
}

// ── Main export ───────────────────────────────────────────────────────────────

function generateAlgorithmTips(races, { asOf = null, minGap = MIN_CONFIDENCE_GAP } = {}) {
  const tips = [];
  let skipped = 0;

  for (const race of races) {
    if (!race.runners || race.runners.length < 2) continue;

    const scored = scoreRace(race, { asOf });
    const best   = scored[0];
    const second = scored[1];

    const gap = best.score - (second?.score ?? 0);
    if (gap < minGap) { skipped++; continue; }

    tips.push({
      source:     'algorithm',
      sourceName: 'Algorithm',
      dogName:    best.runner.name,
      venue:      race.venue,
      raceTime:   race.time,
      position:   1,
      confidence: parseFloat(best.score.toFixed(3)),
      gap:        parseFloat(gap.toFixed(4)),
    });
  }

  console.log(`[Algorithm] ${tips.length} tips from ${races.length} races (${skipped} skipped — low confidence)`);
  return tips;
}

module.exports = { generateAlgorithmTips };
