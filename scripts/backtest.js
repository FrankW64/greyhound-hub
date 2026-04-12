'use strict';

/**
 * backtest.js — replay the algorithm against March 2026 races using Betfair BSP.
 *
 * Form data window: 30 days before each race date (so March 1 uses Feb form only).
 * Assumes £1 level stakes on every tip generated.
 *
 * Usage:
 *   node scripts/backtest.js                                    # default: Mar 1 – Mar 31
 *   node scripts/backtest.js 2026-03-01 2026-03-31              # custom date range
 *   node scripts/backtest.js 2026-03-01 2026-03-31 --verbose    # race-by-race detail
 *   node scripts/backtest.js 2026-03-01 2026-03-31 --min-bsp=6 --max-bsp=20  # BSP filter
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

function norm(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function main() {
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

  const bspLabel = MIN_BSP || MAX_BSP
    ? ` | BSP filter: ${MIN_BSP ?? 0}–${MAX_BSP ?? '∞'}`
    : '';
  console.log(`\n🏁 Backtest: ${START} → ${END}${bspLabel}`);
  console.log(`   ${races.length} races with Betfair odds coverage\n`);
  if (verbose) console.log(`${'─'.repeat(95)}`);

  let totalRaces = 0;
  let totalBets  = 0;
  let totalWins  = 0;
  let totalPnL   = 0;
  let noOdds     = 0;
  let noTip      = 0;

  // Weekly and BSP breakdowns
  const weeklyStats = {};
  const bspStats    = {};

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
    }], { asOf: race.race_date });

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
    if (MIN_BSP && oddsRow.bsp < MIN_BSP) { noOdds++; continue; }
    if (MAX_BSP && oddsRow.bsp > MAX_BSP) { noOdds++; continue; }

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
  console.log(`${'═'.repeat(60)}`);

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

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
