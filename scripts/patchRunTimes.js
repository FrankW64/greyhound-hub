'use strict';

/**
 * patchRunTimes.js — backfills run_time for existing dog_run_history records.
 *
 * Reuses fetchTimeformResults (which already works) and updates only the
 * run_time column for existing rows. Safe to re-run.
 *
 * Usage:
 *   node scripts/patchRunTimes.js              # all dates missing run_time
 *   node scripts/patchRunTimes.js 2026-03-11 2026-03-20  # date range
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { fetchTimeformResults } = require('../src/timeformResultsScraper');
const { getDb }                = require('../src/database');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function norm(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function main() {
  const db   = getDb();
  const args = process.argv.slice(2);

  // Get dates that have null run_time, skip today
  const today = new Date().toISOString().split('T')[0];

  let dates;
  if (args.length === 2) {
    // Date range provided
    const cursor = new Date(args[0]);
    const end    = new Date(args[1]);
    dates = [];
    while (cursor <= end) {
      dates.push(cursor.toISOString().split('T')[0]);
      cursor.setDate(cursor.getDate() + 1);
    }
  } else {
    // All dates with missing run_time
    dates = db.prepare(`
      SELECT DISTINCT race_date
      FROM   dog_run_history
      WHERE  run_time IS NULL
        AND  race_date < ?
      ORDER  BY race_date ASC
    `).all(today).map(r => r.race_date);
  }

  console.log(`\n🕐 Patching run times for ${dates.length} dates…\n`);

  const update = db.prepare(`
    UPDATE dog_run_history
    SET    run_time = ?
    WHERE  race_date     = ?
      AND  venue         = ?
      AND  race_time     = ?
      AND  dog_name_norm = ?
      AND  run_time IS NULL
  `);

  let totalUpdated = 0;

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    process.stdout.write(`[${i + 1}/${dates.length}] ${date} … `);

    try {
      const runners = await fetchTimeformResults(date);

      // Only process runners that have a run_time
      const withTime = runners.filter(r => r.runTime);

      if (!withTime.length) {
        console.log('no run times returned');
      } else {
        const runUpdate = db.transaction(() => {
          let count = 0;
          for (const r of withTime) {
            const result = update.run(
              r.runTime,
              r.raceDate,
              r.venue,
              r.raceTime,
              norm(r.dogName)
            );
            count += result.changes;
          }
          return count;
        });

        const updated = runUpdate();
        totalUpdated += updated;
        console.log(`${updated} run times updated (${withTime.length} with time from ${runners.length} runners)`);
      }
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
    }

    if (i < dates.length - 1) await sleep(10000);
  }

  console.log(`\n✅ Done — ${totalUpdated} total run times updated`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
