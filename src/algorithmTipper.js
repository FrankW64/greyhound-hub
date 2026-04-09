'use strict';

/**
 * algorithmTipper.js — proprietary greyhound tip algorithm.
 *
 * Operates in two modes depending on the data available in dog_run_history:
 *
 * ── Mode A: Full history (Timeform data — all finishing positions) ─────────────
 *  Signal              Weight  Description
 *  ──────────────────  ──────  ────────────────────────────────────────────────
 *  Win rate            30%     Wins / total runs — normalised within race
 *  Avg position        25%     Mean finishing position (lower = better)
 *  Grade quality       20%     Avg grade of races entered
 *  Trap bias           15%     Venue-specific trap win % (hardcoded stats)
 *  Venue wins          10%     Wins at this specific track
 *
 * ── Mode B: Winners-only history (GBGB backfill data) ────────────────────────
 *  Signal              Weight  Description
 *  ──────────────────  ──────  ────────────────────────────────────────────────
 *  Win frequency       30%     Wins in last 30 days — normalised within race
 *  Win recency         25%     Days since last win — recent winners score higher
 *  Grade quality       20%     Average grade of wins — A1 wins beat A6 wins
 *  Trap bias           15%     Venue-specific trap win % (hardcoded stats)
 *  Venue wins          10%     Has this dog won at this track before?
 *
 * Dogs with no history get a neutral score (0.5) on history-based signals
 * so trap bias can still differentiate them.
 *
 * Confidence filter: only tip if score gap between 1st and 2nd > MIN_GAP.
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
  primary:   0.30,  // win rate (full) or win frequency (winners-only)
  secondary: 0.25,  // avg position (full) or win recency (winners-only)
  grade:     0.20,
  trapBias:  0.15,
  venue:     0.10,
};

const MIN_CONFIDENCE_GAP = 0.04;
const MAX_DAYS_SINCE_WIN = 30;

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

function recencyScore(daysSinceWin) {
  if (daysSinceWin === null) return 0.5;
  return Math.max(0, 1 - daysSinceWin / MAX_DAYS_SINCE_WIN);
}

// ── Per-race scoring ──────────────────────────────────────────────────────────

function scoreRace(race) {
  const runnerStats = race.runners.map(runner => {
    const dogNorm = norm(runner.name);
    const trap    = runner.trap || null;
    const stats   = getRunStats(dogNorm, { days: 30, venue: race.venue, trap });
    return { runner, dogNorm, trap, stats };
  });

  // ── Per-dog primary signal ────────────────────────────────────────────────
  // Win rate is only valid when we know total runs (Timeform full data).
  // For GBGB winners-only data, runCount === winCount → winRate always 1.0 → useless.
  // Use win count (normalised within race) as the primary proxy in that case.
  //
  // Per-dog secondary signal:
  //   Full history   → avg finishing position (lower = better)
  //   Winners-only   → recency (days since last win, linear decay)

  const winRates    = runnerStats.map(r => r.stats.hasFullHistory ? r.stats.winRate : null);
  const winCounts   = runnerStats.map(r => r.stats.winCount);
  const avgPositions = runnerStats.map(r =>
    r.stats.hasFullHistory ? (r.stats.avgPosition ?? 7) : null
  );
  const gradeScores = runnerStats.map(r => r.stats.avgGradeScore);
  const venueWins   = runnerStats.map(r => r.stats.venueWins);

  // Normalise win rate only among dogs that have full data
  const fullIndices  = runnerStats.map((r, i) => r.stats.hasFullHistory ? i : -1).filter(i => i >= 0);
  const normWinRate  = new Array(runnerStats.length).fill(0.5);
  if (fullIndices.length > 1) {
    const rates      = fullIndices.map(i => winRates[i]);
    const normRates  = normaliseValues(rates);
    fullIndices.forEach((idx, j) => { normWinRate[idx] = normRates[j]; });
  } else if (fullIndices.length === 1) {
    normWinRate[fullIndices[0]] = 0.5; // only one dog with full data — no relative signal
  }

  // Win count normalised across all runners (used for winners-only dogs)
  const normWinCount  = normaliseValues(winCounts);

  // Avg position: invert so lower position (better finish) → higher score
  const normAvgPos = new Array(runnerStats.length).fill(0.5);
  if (fullIndices.length > 1) {
    const inverted    = fullIndices.map(i => -(avgPositions[i]));
    const normInv     = normaliseValues(inverted);
    fullIndices.forEach((idx, j) => { normAvgPos[idx] = normInv[j]; });
  }

  const normGrade     = normaliseValues(gradeScores);
  const normVenueWins = normaliseValues(venueWins);

  return runnerStats.map((rs, i) => {
    const { runner, trap, stats } = rs;

    // Primary: win rate if full history, otherwise win count
    let s_primary;
    if (!stats.hasHistory) {
      s_primary = 0.5;
    } else if (stats.hasFullHistory) {
      s_primary = normWinRate[i];
    } else {
      s_primary = normWinCount[i];
    }

    // Secondary: avg position if full history, otherwise recency
    let s_secondary;
    if (!stats.hasHistory) {
      s_secondary = 0.5;
    } else if (stats.hasFullHistory) {
      s_secondary = normAvgPos[i];
    } else {
      s_secondary = recencyScore(stats.daysSinceRun);
    }

    const s_grade = stats.hasHistory ? normGrade[i]     : 0.5;
    const s_trap  = trapBiasScore(race.venue, trap);
    const s_venue = stats.hasHistory ? normVenueWins[i] : 0.5;

    const score =
      s_primary   * WEIGHTS.primary   +
      s_secondary * WEIGHTS.secondary +
      s_grade     * WEIGHTS.grade     +
      s_trap      * WEIGHTS.trapBias  +
      s_venue     * WEIGHTS.venue;

    const mode = !stats.hasHistory ? 'no-data'
               : stats.hasFullHistory ? 'full'
               : 'winners-only';

    return {
      runner,
      score,
      signals: { s_primary, s_secondary, s_grade, s_trap, s_venue },
      mode,
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
