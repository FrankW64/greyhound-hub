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
const { storeRunners }           = require('./src/dogHistory');

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

function today()     { return daysAgo(0); }
function yesterday() { return daysAgo(1); }

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
  return runners.length;
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
