'use strict';

/**
 * backfillHistory.js — one-off script to seed dog_run_history from GBGB API.
 *
 * Usage:
 *   node scripts/backfillHistory.js           # backfill last 30 days
 *   node scripts/backfillHistory.js 60        # backfill last 60 days
 *   node scripts/backfillHistory.js 2026-03-01 2026-04-08   # date range
 *
 * Safe to re-run — UNIQUE constraint on (race_date, venue, race_time, dog_name_norm)
 * means duplicate rows are silently ignored.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { fetchGbgbData } = require('../src/gbgbResults');
const { storeRunners }  = require('../src/dogHistory');
const { getDb }         = require('../src/database');

// ── Date helpers ──────────────────────────────────────────────────────────────

function dateRange(startStr, endStr) {
  const dates = [];
  const cur   = new Date(startStr);
  const end   = new Date(endStr);
  while (cur <= end) {
    dates.push(cur.toISOString().split('T')[0]);
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

// ── Delay helper ──────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  let dates;
  if (args.length === 0) {
    // Default: last 30 days (excluding today — already handled by live refresh)
    dates = dateRange(daysAgo(30), daysAgo(1));
  } else if (args.length === 1 && /^\d+$/.test(args[0])) {
    // Number of days
    dates = dateRange(daysAgo(parseInt(args[0], 10)), daysAgo(1));
  } else if (args.length === 2) {
    // Explicit date range
    dates = dateRange(args[0], args[1]);
  } else {
    console.error('Usage: node scripts/backfillHistory.js [days | startDate endDate]');
    process.exit(1);
  }

  console.log(`\n🐕 Backfilling dog history for ${dates.length} days (${dates[0]} → ${dates[dates.length - 1]})\n`);

  // Initialise DB (creates tables if needed)
  getDb();

  let totalRunners = 0;
  let totalRaces   = 0;
  let skipped      = 0;

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    process.stdout.write(`[${i + 1}/${dates.length}] ${date} … `);

    try {
      const { results, allRunners } = await fetchGbgbData(date);

      if (!allRunners.length) {
        console.log('no data');
        skipped++;
      } else {
        storeRunners(allRunners);
        totalRunners += allRunners.length;
        totalRaces   += results.length;
        console.log(`${results.length} races, ${allRunners.length} runners stored`);
      }
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      skipped++;
    }

    // Polite delay between requests — avoid hammering GBGB
    if (i < dates.length - 1) await sleep(1500);
  }

  console.log(`
✅ Backfill complete
   Days processed : ${dates.length - skipped}/${dates.length}
   Total races    : ${totalRaces}
   Total runners  : ${totalRunners}
   Skipped (no data / error): ${skipped}
`);

  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
