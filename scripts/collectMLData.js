'use strict';

/**
 * collectMLData.js — backfill ml_training_data table with per-runner features.
 *
 * For each race in the date range, computes all algorithm features for every
 * runner using only form data available BEFORE that race (asOf = race_date).
 * Stores features alongside the actual outcome for Random Forest training.
 *
 * Usage:
 *   node scripts/collectMLData.js                        # last 60 days
 *   node scripts/collectMLData.js 2026-02-01 2026-03-31  # date range
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { getDb }          = require('../src/database');
const { getRunStats }    = require('../src/dogHistory');
const { scoreRace, trapBiasScore } = require('../src/algorithmTipper');

function norm(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

async function main() {
  const db   = getDb();
  const args = process.argv.slice(2);

  let startDate, endDate;
  if (args.length === 2) {
    startDate = args[0];
    endDate   = args[1];
  } else {
    startDate = daysAgo(60);
    endDate   = daysAgo(1);
  }

  console.log(`\n🤖 Collecting ML training data: ${startDate} → ${endDate}\n`);

  // All distinct races in range
  const races = db.prepare(`
    SELECT DISTINCT race_date, venue, race_time
    FROM   dog_run_history
    WHERE  race_date BETWEEN ? AND ?
    ORDER  BY race_date, race_time
  `).all(startDate, endDate);

  console.log(`   ${races.length} races to process\n`);

  const insert = db.prepare(`
    INSERT OR REPLACE INTO ml_training_data (
      race_date, venue, race_time,
      dog_name, dog_name_norm, trap,
      actual_position, won, bsp,
      run_count, win_rate, avg_position,
      avg_beaten_lengths, avg_speed_index, avg_start_score,
      avg_grade_score, trap_bias, venue_wins,
      days_since_run, has_full_history,
      field_size, field_avg_grade, grade, distance,
      algo_score, confidence_gap, tip_tier
    ) VALUES (
      @race_date, @venue, @race_time,
      @dog_name, @dog_name_norm, @trap,
      @actual_position, @won, @bsp,
      @run_count, @win_rate, @avg_position,
      @avg_beaten_lengths, @avg_speed_index, @avg_start_score,
      @avg_grade_score, @trap_bias, @venue_wins,
      @days_since_run, @has_full_history,
      @field_size, @field_avg_grade, @grade, @distance,
      @algo_score, @confidence_gap, @tip_tier
    )
  `);

  let totalRows = 0;
  let processed = 0;

  for (const race of races) {
    // Get all runners with their actual results
    const runners = db.prepare(`
      SELECT dog_name, dog_name_norm, trap, position, grade, distance
      FROM   dog_run_history
      WHERE  race_date = ? AND venue = ? AND race_time = ?
      ORDER  BY position
    `).all(race.race_date, race.venue, race.race_time);

    if (runners.length < 2) continue;

    // Score the race (using asOf to prevent data leakage)
    const scored = scoreRace({
      venue:   race.venue,
      time:    race.race_time,
      runners: runners.map(r => ({ name: r.dog_name, trap: r.trap })),
    }, { asOf: race.race_date });

    // Build a map of dogNorm → score+gap for quick lookup
    const best   = scored[0];
    const second = scored[1];
    const topGap = best && second ? best.score - second.score : 0;

    // Field-level context
    const fieldSize     = runners.length;
    const gradeScores   = scored.map(s => s.signals.s_grade).filter(v => v !== 0.5);
    const fieldAvgGrade = gradeScores.length
      ? gradeScores.reduce((a, b) => a + b, 0) / gradeScores.length
      : null;

    const grade    = runners[0].grade    || null;
    const distance = runners[0].distance || null;

    // Determine tip tier for the top dog
    let tipTier = 'standard';
    if (topGap >= 0.15)                             tipTier = 'value';
    else if (topGap >= 0.06 && best.score >= 0.62)  tipTier = 'banker';

    const storeRows = db.transaction(() => {
      let count = 0;
      for (const scoredRunner of scored) {
        const dogNorm = norm(scoredRunner.runner.name);
        const actual  = runners.find(r => r.dog_name_norm === dogNorm);
        if (!actual) continue;

        // Get full stats for this runner at race time
        const stats = getRunStats(dogNorm, {
          days:  30,
          venue: race.venue,
          asOf:  race.race_date,
        });

        // BSP from betfair_odds if available
        const oddsRow = db.prepare(`
          SELECT bsp FROM betfair_odds
          WHERE race_date = ? AND race_time = ? AND dog_name_norm = ?
        `).get(race.race_date, race.race_time, dogNorm);

        // Gap for this specific dog (only meaningful for the top-scored dog)
        const isTop   = scoredRunner === best;
        const gap     = isTop ? topGap : null;
        const tier    = isTop ? tipTier : null;

        insert.run({
          race_date:          race.race_date,
          venue:              race.venue,
          race_time:          race.race_time,
          dog_name:           scoredRunner.runner.name,
          dog_name_norm:      dogNorm,
          trap:               actual.trap || null,
          actual_position:    actual.position,
          won:                actual.position === 1 ? 1 : 0,
          bsp:                oddsRow?.bsp ?? null,
          run_count:          stats.runCount,
          win_rate:           stats.winRate,
          avg_position:       stats.avgPosition,
          avg_beaten_lengths: stats.avgBeatenLengths,
          avg_speed_index:    stats.avgSpeedIndex,
          avg_start_score:    stats.avgStartScore,
          avg_grade_score:    stats.avgGradeScore,
          trap_bias:          trapBiasScore(race.venue, actual.trap),
          venue_wins:         stats.venueWins,
          days_since_run:     stats.daysSinceRun,
          has_full_history:   stats.hasFullHistory ? 1 : 0,
          field_size:         fieldSize,
          field_avg_grade:    fieldAvgGrade,
          grade,
          distance,
          algo_score:         scoredRunner.score,
          confidence_gap:     gap,
          tip_tier:           tier,
        });
        count++;
      }
      return count;
    });

    totalRows += storeRows();
    processed++;

    if (processed % 100 === 0) {
      process.stdout.write(`\r   Processed ${processed}/${races.length} races — ${totalRows} rows stored`);
    }
  }

  console.log(`\r   Processed ${processed}/${races.length} races — ${totalRows} rows stored`);
  console.log(`\n✅ Done — ${totalRows} ML training rows collected\n`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
