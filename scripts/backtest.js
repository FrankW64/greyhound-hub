'use strict';

/**
 * backtest.js — replay the algorithm against March 2026 races using Betfair BSP.
 *
 * Form data window: 30 days before each race date (so March 1 uses Feb form only).
 * Assumes £1 level stakes on every tip generated.
 *
 * Usage:
 *   node scripts/backtest.js                                          # default: Mar 1–31, all filters off
 *   node scripts/backtest.js 2026-03-01 2026-03-31                    # custom date range
 *   node scripts/backtest.js 2026-03-01 2026-03-31 --verbose          # race-by-race detail
 *   node scripts/backtest.js 2026-03-01 2026-03-31 --min-bsp=6 --max-bsp=20
 *   node scripts/backtest.js 2026-03-01 2026-03-31 --min-gap=0.08     # confidence threshold
 *   node scripts/backtest.js 2026-03-01 2026-03-31 --sweep            # auto-sweep gap thresholds
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { getDb }                  = require('../src/database');
const { generateAlgorithmTips }  = require('../src/algorithmTipper');

const args      = process.argv.slice(2).filter(a => !a.startsWith('--'));
const verbose   = process.argv.includes('--verbose');
const START     = args[0] || '2026-03-01';
const END       = args[1] || '2026-03-31';

// Optional BSP range filter e.g. --min-bsp=6 --max-bsp=20
const minBspArg = process.argv.find(a => a.startsWith('--min-bsp='));
const maxBspArg = process.argv.find(a => a.startsWith('--max-bsp='));
const MIN_BSP   = minBspArg ? parseFloat(minBspArg.split('=')[1]) : null;
const MAX_BSP   = maxBspArg ? parseFloat(maxBspArg.split('=')[1]) : null;

// Optional confidence gap threshold e.g. --min-gap=0.08
const minGapArg = process.argv.find(a => a.startsWith('--min-gap='));
const MIN_GAP   = minGapArg ? parseFloat(minGapArg.split('=')[1]) : 0.04;

// Sweep mode — test multiple gap thresholds automatically
const SWEEP     = process.argv.includes('--sweep');

function norm(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function main({ minGap = MIN_GAP, minBsp = MIN_BSP, maxBsp = MAX_BSP, silent = false } = {}) {
  const db = getDb();

  // All distinct races in range that have at least one Betfair odds entry
  const races = db.prepare(`
    SELECT DISTINCT h.race_date, h.venue, h.race_time
    FROM   dog_run_history h
    INNER  JOIN betfair_odds b
      ON   b.race_date     = h.race_date
      AND  b.race_time     = h.race_time
      AND  b.dog_name_norm = h.dog_name_norm
    WHERE  h.race_date BETWEEN ? AND ?
    ORDER  BY h.race_date, h.race_time
  `).all(START, END);

  const bspLabel = minBsp || maxBsp ? ` | BSP: ${minBsp ?? 0}–${maxBsp ?? '∞'}` : '';
  const gapLabel = ` | min-gap: ${minGap}`;
  if (!silent) {
    console.log(`\n🏁 Backtest: ${START} → ${END}${bspLabel}${gapLabel}`);
    console.log(`   ${races.length} races with Betfair odds coverage\n`);
    if (verbose) console.log(`${'─'.repeat(95)}`);
  }

  let totalRaces = 0;
  let totalBets  = 0;
  let totalWins  = 0;
  let totalPnL   = 0;
  let noOdds     = 0;
  let noTip      = 0;

  // Weekly, BSP and gap breakdowns
  const weeklyStats = {};
  const bspStats    = {};
  const gapStats    = {}; // keyed by gap bucket e.g. "0.04-0.06"

  for (const race of races) {
    totalRaces++;

    // Get runners for this race
    const runners = db.prepare(`
      SELECT dog_name, dog_name_norm, trap, position
      FROM   dog_run_history
      WHERE  race_date = ? AND venue = ? AND race_time = ?
      ORDER  BY position
    `).all(race.race_date, race.venue, race.race_time);

    if (runners.length < 2) { noTip++; continue; }

    // Run algorithm using only form up to race date (no future leakage)
    const tips = generateAlgorithmTips([{
      venue:   race.venue,
      time:    race.race_time,
      runners: runners.map(r => ({ name: r.dog_name, trap: r.trap })),
    }], { asOf: race.race_date, minGap });

    if (!tips.length) { noTip++; continue; }

    const tip     = tips[0];
    const tipNorm = norm(tip.dogName);

    // Find the actual winner
    const winner = runners.find(r => r.position === 1);

    // Get BSP for our selection
    const oddsRow = db.prepare(`
      SELECT bsp FROM betfair_odds
      WHERE  race_date     = ?
        AND  race_time     = ?
        AND  dog_name_norm = ?
    `).get(race.race_date, race.race_time, tipNorm);

    if (!oddsRow || !oddsRow.bsp) { noOdds++; continue; }

    // Apply BSP filter if set
    if (minBsp && oddsRow.bsp < minBsp) { noOdds++; continue; }
    if (maxBsp && oddsRow.bsp > maxBsp) { noOdds++; continue; }

    const won  = winner && winner.dog_name_norm === tipNorm;
    const pnl  = won ? (oddsRow.bsp - 1) : -1;

    totalBets++;
    if (won) totalWins++;
    totalPnL += pnl;

    // BSP range breakdown
    const bspRanges = [[1,2],[2,3],[3,4],[4,6],[6,10],[10,20],[20,1000]];
    const bucket = bspRanges.find(([lo, hi]) => oddsRow.bsp >= lo && oddsRow.bsp < hi);
    if (bucket) {
      const key = bucket[0] + '-' + (bucket[1] === 1000 ? '∞' : bucket[1]);
      if (!bspStats[key]) bspStats[key] = { bets: 0, wins: 0, pnl: 0, lo: bucket[0] };
      bspStats[key].bets++;
      if (won) bspStats[key].wins++;
      bspStats[key].pnl += pnl;
    }

    // Confidence gap breakdown
    const tipGap = tip.gap ?? 0;
    const gapBuckets = [[0.04,0.06],[0.06,0.08],[0.08,0.10],[0.10,0.15],[0.15,1]];
    const gapBucket  = gapBuckets.find(([lo, hi]) => tipGap >= lo && tipGap < hi);
    if (gapBucket) {
      const gkey = gapBucket[0] + '-' + (gapBucket[1] === 1 ? '∞' : gapBucket[1]);
      if (!gapStats[gkey]) gapStats[gkey] = { bets: 0, wins: 0, pnl: 0, lo: gapBucket[0] };
      gapStats[gkey].bets++;
      if (won) gapStats[gkey].wins++;
      gapStats[gkey].pnl += pnl;
    }

    // Weekly tracking (week starting Monday)
    const d       = new Date(race.race_date);
    const day     = d.getDay() || 7;
    d.setDate(d.getDate() - (day - 1));
    const weekKey = d.toISOString().split('T')[0];
    if (!weeklyStats[weekKey]) weeklyStats[weekKey] = { bets: 0, wins: 0, pnl: 0 };
    weeklyStats[weekKey].bets++;
    if (won) weeklyStats[weekKey].wins++;
    weeklyStats[weekKey].pnl += pnl;

    if (verbose) {
      const result = won ? '✅ WON ' : '❌ LOST';
      const pnlStr = (pnl >= 0 ? '+' : '') + pnl.toFixed(2);
      console.log(
        `${race.race_date} ${race.venue.padEnd(15)} ${race.race_time}` +
        ` | ${tip.dogName.padEnd(28)} | ${result}` +
        ` | BSP: ${String(oddsRow.bsp.toFixed(2)).padStart(6)}` +
        ` | P&L: ${pnlStr.padStart(7)}` +
        ` | Running: ${totalPnL >= 0 ? '+' : ''}£${totalPnL.toFixed(2)}`
      );
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  const roi      = totalBets ? (totalPnL / totalBets) * 100 : 0;
  const winRate  = totalBets ? (totalWins / totalBets) * 100 : 0;

  if (!silent) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  BACKTEST RESULTS  ${START} → ${END}`);
    console.log(`${'═'.repeat(60)}`);
    console.log(`  Races analysed   : ${totalRaces}`);
    console.log(`  Tips generated   : ${totalBets}`);
    console.log(`  Skipped (no tip) : ${noTip}`);
    console.log(`  Skipped (no BSP) : ${noOdds}`);
    console.log(`  Winners          : ${totalWins} / ${totalBets} (${winRate.toFixed(1)}%)`);
    console.log(`  Total P&L        : ${totalPnL >= 0 ? '+' : ''}£${totalPnL.toFixed(2)} (£1 level stakes)`);
    console.log(`  ROI              : ${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`);
  }
  console.log(`${'═'.repeat(60)}`);

  if (silent) return { totalBets, totalWins, totalPnL, roi, winRate };

  // BSP range breakdown
  console.log(`\n  BSP range breakdown (algorithm tips only):`);
  console.log(`  ${'Range'.padEnd(10)} ${'Bets'.padStart(5)} ${'Wins'.padStart(5)} ${'Win%'.padStart(6)} ${'P&L'.padStart(10)} ${'ROI'.padStart(7)}`);
  console.log(`  ${'─'.repeat(50)}`);
  for (const [key, s] of Object.entries(bspStats).sort((a, b) => a[1].lo - b[1].lo)) {
    const wr  = s.bets ? ((s.wins / s.bets) * 100).toFixed(1) : '0';
    const pl  = (s.pnl >= 0 ? '+' : '') + '£' + s.pnl.toFixed(2);
    const roi = s.bets ? ((s.pnl / s.bets) * 100).toFixed(1) : '0';
    console.log(`  ${key.padEnd(10)} ${String(s.bets).padStart(5)} ${String(s.wins).padStart(5)} ${(wr+'%').padStart(6)} ${pl.padStart(10)} ${(roi+'%').padStart(7)}`);
  }

  // Confidence gap breakdown
  console.log(`\n  Confidence gap breakdown:`);
  console.log(`  ${'Gap'.padEnd(12)} ${'Bets'.padStart(5)} ${'Wins'.padStart(5)} ${'Win%'.padStart(6)} ${'P&L'.padStart(10)} ${'ROI'.padStart(7)}`);
  console.log(`  ${'─'.repeat(50)}`);
  for (const [key, s] of Object.entries(gapStats).sort((a, b) => a[1].lo - b[1].lo)) {
    const wr  = s.bets ? ((s.wins / s.bets) * 100).toFixed(1) : '0';
    const pl  = (s.pnl >= 0 ? '+' : '') + '£' + s.pnl.toFixed(2);
    const roi = s.bets ? ((s.pnl / s.bets) * 100).toFixed(1) : '0';
    console.log(`  ${key.padEnd(12)} ${String(s.bets).padStart(5)} ${String(s.wins).padStart(5)} ${(wr+'%').padStart(6)} ${pl.padStart(10)} ${(roi+'%').padStart(7)}`);
  }

  // Weekly breakdown
  console.log(`\n  Weekly breakdown:`);
  console.log(`  ${'Week'.padEnd(12)} ${'Bets'.padStart(5)} ${'Wins'.padStart(5)} ${'Win%'.padStart(6)} ${'P&L'.padStart(8)}`);
  console.log(`  ${'─'.repeat(42)}`);
  for (const [week, s] of Object.entries(weeklyStats).sort()) {
    const wr  = s.bets ? ((s.wins / s.bets) * 100).toFixed(0) : '0';
    const pl  = (s.pnl >= 0 ? '+' : '') + '£' + s.pnl.toFixed(2);
    console.log(`  ${week.padEnd(12)} ${String(s.bets).padStart(5)} ${String(s.wins).padStart(5)} ${(wr + '%').padStart(6)} ${pl.padStart(8)}`);
  }
  console.log('');
}

async function sweep() {
  const gapThresholds = [0.04, 0.05, 0.06, 0.07, 0.08, 0.10, 0.12, 0.15, 0.20];
  const bspFilters    = [
    { label: 'All BSP',   minBsp: null, maxBsp: null },
    { label: 'BSP 3-20',  minBsp: 3,    maxBsp: 20   },
    { label: 'BSP 6-20',  minBsp: 6,    maxBsp: 20   },
  ];

  process.stdout.write('🔬 Running sweep');
  const results = {};
  for (const bspFilter of bspFilters) {
    results[bspFilter.label] = [];
    for (const gap of gapThresholds) {
      process.stdout.write('.');
      const r = await main({ minGap: gap, minBsp: bspFilter.minBsp, maxBsp: bspFilter.maxBsp, silent: true });
      results[bspFilter.label].push({ gap, ...r });
    }
  }

  console.log(' done.\n');
  console.log(`${'═'.repeat(65)}`);
  console.log(`  🔬 SWEEP RESULTS  ${START} → ${END}`);
  console.log(`${'═'.repeat(65)}`);

  for (const bspFilter of bspFilters) {
    console.log(`\n  ── ${bspFilter.label} ──`);
    console.log(`  ${'min-gap'.padEnd(10)} ${'Bets'.padStart(6)} ${'Win%'.padStart(6)} ${'P&L'.padStart(10)} ${'ROI'.padStart(8)}`);
    console.log(`  ${'─'.repeat(46)}`);
    for (const r of results[bspFilter.label]) {
      const pl  = (r.totalPnL >= 0 ? '+' : '') + '£' + r.totalPnL.toFixed(2);
      const roi = (r.roi >= 0 ? '+' : '') + r.roi.toFixed(1) + '%';
      console.log(`  ${String(r.gap).padEnd(10)} ${String(r.totalBets).padStart(6)} ${(r.winRate.toFixed(1)+'%').padStart(6)} ${pl.padStart(10)} ${roi.padStart(8)}`);
    }
  }
  console.log('');
}

if (SWEEP) {
  sweep().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
} else {
  main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
}
