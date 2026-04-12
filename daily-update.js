'use strict';

/**
 * daily-update.js — designed to run twice daily via cron.
 *
 * 7am  — scrapes yesterday's full Timeform results (all positions)
 *         + refreshes greyhoundstats trap/trainer stats
 *
 * 11pm — scrapes today's full Timeform results (all racing now finished)
 *
 * Usage:
 *   node daily-update.js           # auto-detects morning vs evening run
 *   node daily-update.js --morning # force morning run (yesterday)
 *   node daily-update.js --evening # force evening run (today)
 *
 * Cron setup:
 *   0  7 * * * cd /var/www/greyhound-hub && node daily-update.js --morning >> ./logs/pipeline.log 2>&1
 *   0 23 * * * cd /var/www/greyhound-hub && node daily-update.js --evening >> ./logs/pipeline.log 2>&1
 */

require('dotenv').config();

const { getDb }                  = require('./src/database');
const { scrapeGreyhoundStats }   = require('./src/greyhoundStatsScraper');
const { fetchTimeformResults }   = require('./src/timeformResultsScraper');
const { storeRunners, getRunStats } = require('./src/dogHistory');
const { scoreRace, trapBiasScore }  = require('./src/algorithmTipper');

function normName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

function today()     { return daysAgo(0); }
function yesterday() { return daysAgo(1); }

/**
 * Re-scrape any dates in the last N days that still have null run_time,
 * beaten, run_comment, or grade. Fills gaps via the COALESCE upsert in
 * storeRunners — safe to run any number of times.
 */
async function autoFillNulls(lookbackDays = 5) {
  const db    = getDb();
  const today = new Date().toISOString().split('T')[0];

  const dates = db.prepare(`
    SELECT DISTINCT race_date
    FROM   dog_run_history
    WHERE  (run_time IS NULL OR beaten IS NULL OR run_comment IS NULL OR grade IS NULL)
      AND  race_date < ?
      AND  race_date >= date(?, '-' || ? || ' days')
    ORDER  BY race_date ASC
  `).all(today, today, lookbackDays).map(r => r.race_date);

  if (!dates.length) {
    console.log('[AutoFill] No recent dates with missing fields — skipping');
    return;
  }

  console.log(`[AutoFill] Re-scraping ${dates.length} date(s) with null fields: ${dates.join(', ')}`);

  for (const date of dates) {
    try {
      const runners = await fetchTimeformResults(date);
      if (runners.length) {
        storeRunners(runners);
        console.log(`[AutoFill] ${date}: ${runners.length} runners re-processed`);
      } else {
        console.log(`[AutoFill] ${date}: no runners returned`);
      }
    } catch (err) {
      console.error(`[AutoFill] ${date} error: ${err.message}`);
    }
  }
}

async function scrapeDate(date) {
  console.log(`\n[Timeform] Scraping results for ${date}…`);
  const runners = await fetchTimeformResults(date);

  if (!runners.length) {
    console.log(`[Timeform] No data returned for ${date}`);
    return 0;
  }

  storeRunners(runners);
  const hasFullData = runners.some(r => r.position > 1);
  console.log(`[Timeform] ${date}: ${runners.length} runners stored (${hasFullData ? 'full positions' : 'winners-only'})`);

  // Collect ML training data for this date
  collectMLDataForDate(date);

  return runners.length;
}

function collectMLDataForDate(date) {
  const db = getDb();

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

  const races = db.prepare(`
    SELECT DISTINCT venue, race_time FROM dog_run_history
    WHERE race_date = ? ORDER BY race_time
  `).all(date);

  let rowCount = 0;

  for (const race of races) {
    const runners = db.prepare(`
      SELECT dog_name, dog_name_norm, trap, position, grade, distance
      FROM   dog_run_history
      WHERE  race_date = ? AND venue = ? AND race_time = ?
      ORDER  BY position
    `).all(date, race.venue, race.race_time);

    if (runners.length < 2) continue;

    const scored  = scoreRace({
      venue:   race.venue,
      time:    race.race_time,
      runners: runners.map(r => ({ name: r.dog_name, trap: r.trap })),
    }, { asOf: date });

    const best    = scored[0];
    const second  = scored[1];
    const topGap  = best && second ? best.score - second.score : 0;
    const grade   = runners[0].grade    || null;
    const distance = runners[0].distance || null;

    let tipTier = 'standard';
    if (topGap >= 0.15)                            tipTier = 'value';
    else if (topGap >= 0.06 && best.score >= 0.62) tipTier = 'banker';

    const storeRows = db.transaction(() => {
      let c = 0;
      for (const sr of scored) {
        const dn     = normName(sr.runner.name);
        const actual = runners.find(r => r.dog_name_norm === dn);
        if (!actual) continue;

        const stats   = getRunStats(dn, { days: 30, venue: race.venue, asOf: date });
        const oddsRow = db.prepare('SELECT bsp FROM betfair_odds WHERE race_date=? AND race_time=? AND dog_name_norm=?')
                          .get(date, race.race_time, dn);
        const isTop   = sr === best;

        insert.run({
          race_date:          date,
          venue:              race.venue,
          race_time:          race.race_time,
          dog_name:           sr.runner.name,
          dog_name_norm:      dn,
          trap:               actual.trap    || null,
          actual_position:    actual.position,
          won:                actual.position === 1 ? 1 : 0,
          bsp:                oddsRow?.bsp   ?? null,
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
          field_size:         runners.length,
          field_avg_grade:    null,
          grade,
          distance,
          algo_score:         sr.score,
          confidence_gap:     isTop ? topGap : null,
          tip_tier:           isTop ? tipTier : null,
        });
        c++;
      }
      return c;
    });
    rowCount += storeRows();
  }

  console.log(`[ML] ${date}: ${rowCount} training rows stored`);
}

async function main() {
  const started  = new Date().toISOString();
  const args     = process.argv.slice(2);
  const isMorning = args.includes('--morning') || new Date().getHours() < 12;
  const isEvening = args.includes('--evening') || !isMorning;

  console.log(`\n[${started}] 🐕 Daily update (${isMorning ? 'morning' : 'evening'}) starting…`);

  getDb(); // ensure tables exist

  let totalRunners = 0;
  let errors = 0;

  if (isMorning) {
    // Morning: scrape yesterday's completed results + refresh stats
    try {
      totalRunners += await scrapeDate(yesterday());
    } catch (err) {
      console.error(`[Timeform] Error: ${err.message}`);
      errors++;
    }

    // Auto-fill any nulls in the last 5 days (run times often published after racing)
    console.log('\n[AutoFill] Checking last 5 days for missing fields…');
    try {
      await autoFillNulls(5);
    } catch (err) {
      console.error(`[AutoFill] Error: ${err.message}`);
      errors++;
    }

    console.log('\n[GStats] Refreshing trap and trainer stats…');
    try {
      const { trapCount, trainerCount } = await scrapeGreyhoundStats();
      console.log(`[GStats] ${trapCount} trap records, ${trainerCount} trainer records`);
    } catch (err) {
      console.error(`[GStats] Error: ${err.message}`);
      errors++;
    }
  }

  if (isEvening) {
    // Evening: scrape today's now-completed results
    try {
      totalRunners += await scrapeDate(today());
    } catch (err) {
      console.error(`[Timeform] Error: ${err.message}`);
      errors++;
    }
  }

  console.log(`\n✅ Update complete — ${totalRunners} runners stored, ${errors} errors`);

  // Summary of what's in the DB
  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) as n FROM dog_run_history').get().n;
  console.log(`   Total runners in dog_run_history: ${count.toLocaleString()}`);

  if (errors > 0) process.exit(1);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
