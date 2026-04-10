'use strict';

/**
 * pipeline.js — main entry point for the greyhound data pipeline.
 *
 * Usage:
 *   node pipeline.js              # auto-detects first run, runs backfill if needed
 *   node pipeline.js --backfill   # force 90-day backfill regardless of DB state
 *   node pipeline.js --days 30    # backfill N days
 *   node pipeline.js --save-samples  # save raw HTML from greyhoundstats for inspection
 */

require('dotenv').config();

const { getDb }               = require('./src/database');
const { fetchGBGBDateRange }  = require('./src/gbgbPipeline');
const { scrapeGreyhoundStats } = require('./src/greyhoundStatsScraper');

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

function yesterday() { return daysAgo(1); }

async function main() {
  const args        = process.argv.slice(2);
  const forceBackfill  = args.includes('--backfill');
  const saveSamples    = args.includes('--save-samples');
  const daysIdx        = args.indexOf('--days');
  const backfillDays   = daysIdx >= 0 ? parseInt(args[daysIdx + 1], 10) || 90 : 90;

  console.log('\n🐕 Greyhound Hub — Data Pipeline\n');

  const db = getDb();

  // ── Detect first run ────────────────────────────────────────────────────────
  const meetingCount = db.prepare('SELECT COUNT(*) as n FROM meetings').get().n;
  const isFirstRun   = meetingCount === 0;

  if (isFirstRun || forceBackfill) {
    const days  = backfillDays;
    const start = daysAgo(days);
    const end   = yesterday();

    console.log(`📦 ${isFirstRun ? 'First run detected' : 'Backfill forced'} — fetching ${days} days of GBGB data`);
    console.log(`   ${start} → ${end}`);
    console.log('   This will take a while (2s delay per meeting)…\n');

    await fetchGBGBDateRange(start, end);
  } else {
    console.log(`ℹ️  Database has ${meetingCount} meetings — skipping backfill`);
    console.log('   Run with --backfill to force a fresh backfill\n');
  }

  // ── Scrape greyhoundstats ───────────────────────────────────────────────────
  console.log('\n📊 Scraping greyhoundstats.co.uk…');
  const { trapCount, trainerCount } = await scrapeGreyhoundStats({ saveSamples });

  // ── Summary ─────────────────────────────────────────────────────────────────
  const totals = {
    meetings:        db.prepare('SELECT COUNT(*) as n FROM meetings').get().n,
    races:           db.prepare('SELECT COUNT(*) as n FROM races').get().n,
    runners:         db.prepare('SELECT COUNT(*) as n FROM runners').get().n,
    trap_stats:      db.prepare('SELECT COUNT(*) as n FROM trap_stats').get().n,
    trainer_stats:   db.prepare('SELECT COUNT(*) as n FROM trainer_stats').get().n,
  };

  console.log('\n✅ Pipeline complete\n');
  console.log('   Table          Rows');
  console.log('   ─────────────────────────');
  for (const [table, count] of Object.entries(totals)) {
    console.log(`   ${table.padEnd(16)} ${count.toLocaleString()}`);
  }
  console.log();
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
