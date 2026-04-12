'use strict';

/**
 * backfillHistory.js — seed dog_run_history from Timeform results pages.
 *
 * Timeform provides full finishing positions (1st–6th) for all runners,
 * enabling the full algorithm mode (win rate, avg position, grade quality).
 *
 * Usage:
 *   node scripts/backfillHistory.js           # backfill last 30 days
 *   node scripts/backfillHistory.js 60        # backfill last 60 days
 *   node scripts/backfillHistory.js 2026-03-01 2026-04-08   # date range
 *
 * Safe to re-run — UNIQUE constraint on (race_date, venue, race_time, dog_name_norm)
 * means duplicate rows are silently ignored.
 *
 * Note: Timeform may block days with no meetings or very old dates.
 * Use --gbgb flag to fall back to GBGB winners-only data for any day that
 * Timeform returns no runners.
 *
 * Options:
 *   --gbgb    Also try GBGB API as fallback for days Timeform has no data
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { fetchTimeformResults } = require('../src/timeformResultsScraper');
const { fetchGbgbData }        = require('../src/gbgbResults');
const { storeRunners }         = require('../src/dogHistory');
const { getDb }                = require('../src/database');

const useGbgbFallback = process.argv.includes('--gbgb');
const limitIdx        = process.argv.indexOf('--limit');
const RACE_LIMIT      = limitIdx >= 0 ? parseInt(process.argv[limitIdx + 1], 10) : null;

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

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2).filter(a => !a.startsWith('--') && a !== String(RACE_LIMIT));

  let dates;
  if (args.length === 0) {
    dates = dateRange(daysAgo(30), daysAgo(1));
  } else if (args.length === 1 && /^\d+$/.test(args[0])) {
    dates = dateRange(daysAgo(parseInt(args[0], 10)), daysAgo(1));
  } else if (args.length === 2) {
    dates = dateRange(args[0], args[1]);
  } else {
    console.error('Usage: node scripts/backfillHistory.js [days | startDate endDate] [--gbgb]');
    process.exit(1);
  }

  const source = useGbgbFallback ? 'Timeform (GBGB fallback)' : 'Timeform';
  console.log(`\n🐕 Backfilling dog history via ${source}`);
  console.log(`   ${dates.length} days: ${dates[0]} → ${dates[dates.length - 1]}\n`);

  // Initialise DB (creates tables if needed)
  getDb();

  let totalRunners = 0;
  let totalRaces   = 0;
  let skipped      = 0;

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    process.stdout.write(`[${i + 1}/${dates.length}] ${date} … `);

    try {
      let allRunners = await fetchTimeformResults(date, { limit: RACE_LIMIT });

      // Fallback to GBGB if Timeform returned nothing and --gbgb flag is set
      if (!allRunners.length && useGbgbFallback) {
        process.stdout.write('(TF empty, trying GBGB) ');
        const { allRunners: gbgbRunners } = await fetchGbgbData(date);
        allRunners = gbgbRunners;
      }

      if (!allRunners.length) {
        console.log('no data');
        skipped++;
      } else {
        storeRunners(allRunners);
        // Count distinct races from this batch
        const races = new Set(allRunners.map(r => `${r.venue}|${r.raceTime}`)).size;
        totalRunners += allRunners.length;
        totalRaces   += races;
        // Show whether data is full (has non-winners) or winners-only
        const hasNonWinners = allRunners.some(r => r.position > 1);
        const mode = hasNonWinners ? 'full' : 'winners-only';
        console.log(`${races} races, ${allRunners.length} runners stored (${mode})`);
      }
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      skipped++;
    }

    // Polite delay — avoid hammering Timeform
    if (i < dates.length - 1) await sleep(2000);
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
