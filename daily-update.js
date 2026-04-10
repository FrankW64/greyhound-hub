'use strict';

/**
 * daily-update.js — designed to run daily via cron.
 *
 * Fetches yesterday + today from GBGB (catches late results),
 * then refreshes trap and trainer stats from greyhoundstats.
 *
 * Usage:
 *   node daily-update.js
 *
 * Cron (7am daily):
 *   0 7 * * * cd /var/www/greyhound-hub && node daily-update.js >> ./logs/pipeline.log 2>&1
 */

require('dotenv').config();

const { getDb }                = require('./src/database');
const { fetchGBGBDate }        = require('./src/gbgbPipeline');
const { scrapeGreyhoundStats } = require('./src/greyhoundStatsScraper');

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

async function main() {
  const started = new Date().toISOString();
  console.log(`\n[${started}] 🐕 Daily update starting…`);

  getDb(); // ensure tables exist

  const dates = [daysAgo(1), daysAgo(0)]; // yesterday + today
  let totalRunners = 0;
  let totalErrors  = 0;

  for (const date of dates) {
    console.log(`\n[GBGB] Fetching ${date}…`);
    const summary = await fetchGBGBDate(date);
    totalRunners += summary.runnersFetched;
    totalErrors  += summary.errors.length;
    console.log(`[GBGB] ${date}: ${summary.meetingsFetched} meetings, ${summary.runnersFetched} runners, ${summary.errors.length} errors`);
  }

  console.log('\n[GStats] Refreshing trap and trainer stats…');
  const { trapCount, trainerCount } = await scrapeGreyhoundStats();
  console.log(`[GStats] ${trapCount} trap records, ${trainerCount} trainer records`);

  console.log(`\n✅ Daily update complete — ${totalRunners} runners stored, ${totalErrors} errors`);
  if (totalErrors > 0) process.exit(1); // non-zero exit for cron alerting
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
