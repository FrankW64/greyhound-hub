'use strict';

/**
 * algorithmTipper.js — proprietary greyhound tip algorithm.
 *
 * Scores each runner in a race using signals derived from GBGB run history:
 *
 *   Signal              Weight   Notes
 *   ─────────────────── ──────   ──────────────────────────────────────────────
 *   Trap bias           0.20     Venue-specific win % for this trap
 *   Recent win rate     0.30     Win% across last 10 runs
 *   Avg finishing pos   0.20     Lower is better; normalised within race
 *   Venue record        0.15     Win% at this specific venue
 *   Grade trajectory    0.10     Positive = dropping in grade = improving
 *   Trap record         0.05     Win% from this trap across all venues
 *
 * Only the top-scoring runner per race is tipped (position = 1).
 * A minimum confidence threshold filters out races with no clear favourite.
 *
 * Source key: 'algorithm'
 */

const { getForm, getVenueRecord, gradeTrajectory, getTrapRecord } = require('./dogHistory');

// Trap bias table (same data as app.js — single source of truth kept here)
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
  trapBias:       0.20,
  recentWinRate:  0.30,
  avgPos:         0.20,
  venueRecord:    0.15,
  gradeTrend:     0.10,
  trapRecord:     0.05,
};

// Minimum score gap between 1st and 2nd runner to emit a tip (confidence filter)
const MIN_CONFIDENCE_GAP = 0.03;

function norm(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ── Scoring helpers ───────────────────────────────────────────────────────────

/** Normalise an array of values to [0, 1] range. */
function normaliseValues(values) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 0.5);
  return values.map(v => (v - min) / (max - min));
}

/** Trap bias score (0–1) for a given venue + trap (1-indexed). */
function trapBiasScore(venue, trap) {
  const biases = TRAP_BIAS[venue];
  if (!biases || !trap || trap < 1 || trap > biases.length) return 0.5;
  const vals = normaliseValues(biases);
  return vals[trap - 1];
}

// ── Per-race scoring ──────────────────────────────────────────────────────────

/**
 * Score every runner in a race and return a sorted array of
 * { runner, score, signals } objects, best first.
 */
function scoreRace(race) {
  const scored = race.runners.map(runner => {
    const dogNorm = norm(runner.name);
    const trap    = runner.trap || null;

    // --- Signal 1: trap bias
    const s_trapBias = trapBiasScore(race.venue, trap);

    // --- Signal 2 & 3: recent form
    const form = getForm(dogNorm, { runs: 10 });
    const s_winRate = form.winRate !== null ? form.winRate : 0.167; // default = random

    // avgPos: lower = better, so invert after normalisation (handled per-race below)
    const rawAvgPos = form.avgPos !== null ? form.avgPos : 3.5; // middle of 6

    // --- Signal 4: venue record
    const venueRec  = getVenueRecord(dogNorm, race.venue);
    const s_venue   = venueRec.winRate !== null ? venueRec.winRate : 0.167;

    // --- Signal 5: grade trajectory (-n to +n → normalised)
    const gradeTrend = gradeTrajectory(dogNorm); // positive = improving
    // Clamp to [-3, 3], map to [0, 1]
    const s_grade    = Math.min(1, Math.max(0, (gradeTrend + 3) / 6));

    // --- Signal 6: trap record
    const trapRec  = trap ? getTrapRecord(dogNorm, trap) : { winRate: null };
    const s_trap   = trapRec.winRate !== null ? trapRec.winRate : 0.167;

    return {
      runner,
      dogNorm,
      rawAvgPos,
      signals: { s_trapBias, s_winRate, rawAvgPos, s_venue, s_grade, s_trap },
    };
  });

  // Normalise avgPos within the race (lower pos = better, so invert)
  const avgPosValues = scored.map(s => s.rawAvgPos);
  const normAvgPos   = normaliseValues(avgPosValues).map(v => 1 - v); // invert

  // Compute final weighted score
  for (let i = 0; i < scored.length; i++) {
    const { s_trapBias, s_winRate, s_venue, s_grade, s_trap } = scored[i].signals;
    scored[i].signals.s_avgPos = normAvgPos[i];
    scored[i].score =
      s_trapBias * WEIGHTS.trapBias    +
      s_winRate  * WEIGHTS.recentWinRate +
      normAvgPos[i] * WEIGHTS.avgPos   +
      s_venue    * WEIGHTS.venueRecord +
      s_grade    * WEIGHTS.gradeTrend  +
      s_trap     * WEIGHTS.trapRecord;
  }

  return scored.sort((a, b) => b.score - a.score);
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Generate algorithm tips for today's races.
 * Returns an array of tip objects compatible with the rest of the tip pipeline.
 *
 * @param {Array} races  Current race list from DataManager
 * @returns {Array<{ source, sourceName, dogName, venue, raceTime, position, confidence }>}
 */
function generateAlgorithmTips(races) {
  const tips = [];

  for (const race of races) {
    if (!race.runners || race.runners.length < 2) continue;

    const scored = scoreRace(race);
    const best   = scored[0];
    const second = scored[1];

    // Confidence filter — skip if margin is too slim
    const gap = best.score - (second ? second.score : 0);
    if (gap < MIN_CONFIDENCE_GAP) continue;

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

  console.log(`[Algorithm] Generated ${tips.length} tips from ${races.length} races`);
  return tips;
}

module.exports = { generateAlgorithmTips };
