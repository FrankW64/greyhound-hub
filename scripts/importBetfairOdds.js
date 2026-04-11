'use strict';

/**
 * importBetfairOdds.js — imports Betfair historical BSP data from a .tar archive.
 *
 * The archive contains bz2-compressed NDJSON files (Betfair Stream API format).
 * This script extracts, decompresses, parses, and stores BSP per runner into
 * the betfair_odds table.
 *
 * Usage:
 *   node scripts/importBetfairOdds.js /path/to/data.tar
 *   node scripts/importBetfairOdds.js /path/to/data.tar --dry-run
 *
 * Requirements (Ubuntu):
 *   tar and bzip2 are pre-installed on most Ubuntu systems.
 *
 * Safe to re-run — UNIQUE constraint on (race_date, venue, race_time, dog_name_norm)
 * prevents duplicates.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { execSync, spawn } = require('child_process');
const path                = require('path');
const { getDb }           = require('../src/database');
const { parseMarketFile } = require('../src/betfairParser');

const tarFile  = process.argv[2];
const dryRun   = process.argv.includes('--dry-run');

if (!tarFile) {
  console.error('Usage: node scripts/importBetfairOdds.js /path/to/data.tar [--dry-run]');
  process.exit(1);
}

function norm(name) {
  // Strip Betfair trap prefix e.g. "6. CROKERS LUNA" → "CROKERS LUNA"
  const stripped = (name || '').replace(/^\d+\.\s*/, '');
  return stripped.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ── Decompress a single bz2 file from the tar archive ─────────────────────────

function decompressEntry(tarPath, entryPath) {
  return new Promise((resolve, reject) => {
    // tar -xOf archive.tar entry.bz2 | bunzip2 -c
    const tar    = spawn('tar', ['-xOf', tarPath, entryPath]);
    const bzip   = spawn('bunzip2', ['-c']);
    const chunks = [];

    tar.stdout.pipe(bzip.stdin);
    bzip.stdout.on('data', chunk => chunks.push(chunk));
    bzip.stdout.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    bzip.stderr.on('data', () => {}); // suppress bunzip2 warnings
    tar.stderr.on('data', () => {});
    bzip.on('error', reject);
    tar.on('error', reject);
    tar.on('close', code => { if (code !== 0) bzip.stdin.end(); });
  });
}

// ── DB insert ─────────────────────────────────────────────────────────────────

function storeMarket(db, market) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO betfair_odds
      (race_date, venue, race_time, dog_name, dog_name_norm, bsp, win_flag, market_id)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insert = db.transaction(() => {
    let count = 0;
    for (const runner of market.runners) {
      const result = stmt.run(
        market.date,
        market.venue,
        market.raceTime,
        runner.name,
        norm(runner.name),
        runner.bsp,
        runner.winFlag,
        market.marketId
      );
      if (result.changes) count++;
    }
    return count;
  });

  return insert();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🏇 Betfair Historical Odds Importer`);
  console.log(`   Archive: ${tarFile}`);
  if (dryRun) console.log('   DRY RUN — nothing will be written\n');

  // List all .bz2 files in the archive
  console.log('Listing archive contents…');
  let fileList;
  try {
    fileList = execSync(`tar -tf "${tarFile}"`, { maxBuffer: 50 * 1024 * 1024 })
      .toString()
      .split('\n')
      .filter(f => f.endsWith('.bz2'));
  } catch (err) {
    console.error('Failed to list tar contents:', err.message);
    process.exit(1);
  }

  console.log(`Found ${fileList.length} .bz2 files\n`);

  const db = dryRun ? null : getDb();

  let processed  = 0;
  let stored     = 0;
  let skipped    = 0;
  let errors     = 0;
  let totalRunners = 0;

  for (let i = 0; i < fileList.length; i++) {
    const entry = fileList[i].trim();
    if (!entry) continue;

    // Progress every 100 files
    if (i % 100 === 0) {
      process.stdout.write(`\r[${i}/${fileList.length}] processed=${processed} stored=${stored} skipped=${skipped} errors=${errors}`);
    }

    try {
      const ndjson = await decompressEntry(tarFile, entry);
      if (!ndjson.trim()) { skipped++; continue; }

      const market = parseMarketFile(ndjson);
      if (!market) { skipped++; continue; }

      processed++;

      if (!dryRun) {
        const count = storeMarket(db, market);
        stored++;
        totalRunners += count;
      } else {
        // Dry run — just log first 5 markets
        if (processed <= 5) {
          console.log(`\n  ✓ ${market.date} ${market.venue} ${market.raceTime} — ${market.runners.length} runners`);
          for (const r of market.runners) {
            console.log(`    ${r.name.padEnd(25)} BSP: ${String(r.bsp).padStart(6)}  ${r.winFlag === 1 ? '🏆 WINNER' : ''}`);
          }
        }
        stored++;
        totalRunners += market.runners.length;
      }
    } catch (err) {
      errors++;
      if (errors <= 5) console.error(`\n  Error on ${entry}: ${err.message}`);
    }
  }

  console.log(`\n\n✅ Import complete`);
  console.log(`   Files processed : ${processed}`);
  console.log(`   Files skipped   : ${skipped} (non-greyhound or no BSP)`);
  console.log(`   Markets stored  : ${stored}`);
  console.log(`   Runners stored  : ${totalRunners}`);
  console.log(`   Errors          : ${errors}`);

  if (!dryRun && db) {
    const total = db.prepare('SELECT COUNT(*) as n FROM betfair_odds').get().n;
    console.log(`\n   Total in betfair_odds table: ${total}`);
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
