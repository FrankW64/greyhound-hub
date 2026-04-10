'use strict';

/**
 * greyhoundStatsScraper.js — scrapes trap and trainer stats from greyhoundstats.co.uk.
 *
 * On first run (or if --save-samples flag is set), saves raw HTML to:
 *   ./data/sample_trap_stats.html
 *   ./data/sample_trainer_stats.html
 *
 * These files let you inspect actual table structure if the parser needs adjusting.
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const fs      = require('fs');
const path    = require('path');
const { getDb } = require('./database');

const DATA_DIR = path.join(__dirname, '..', 'data');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept':     'text/html,application/xhtml+xml,*/*',
  'Accept-Language': 'en-GB,en;q=0.9',
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchPage(url, sampleFile) {
  const { data } = await axios.get(url, { headers: HEADERS, timeout: 20000 });
  if (sampleFile) {
    fs.writeFileSync(path.join(DATA_DIR, sampleFile), data, 'utf8');
    console.log(`[GStats] Saved sample HTML → data/${sampleFile}`);
  }
  return data;
}

// ── Trap stats parser ─────────────────────────────────────────────────────────
//
// greyhoundstats.co.uk typically shows a table per venue with columns:
//   Trap | Wins | Runs | Win%
// Venue names appear as section headings above each table.

function parseTrapStats(html) {
  const $       = cheerio.load(html);
  const records = [];

  // Strategy: find all tables, look for "Trap" in the header row
  // The venue name is usually in the nearest preceding heading element

  $('table').each((_, table) => {
    const $table   = $(table);
    const headers  = $table.find('tr').first().find('th, td')
                       .map((_, el) => $(el).text().trim().toLowerCase()).get();

    // Check this looks like a trap stats table
    const hasTrap = headers.some(h => h.includes('trap'));
    const hasWin  = headers.some(h => h.includes('win'));
    if (!hasTrap || !hasWin) return;

    // Column indices
    const colTrap  = headers.findIndex(h => h.includes('trap'));
    const colWins  = headers.findIndex(h => h === 'wins' || h === 'win');
    const colRuns  = headers.findIndex(h => h.includes('run') || h.includes('total'));
    const colPct   = headers.findIndex(h => h.includes('%') || h.includes('pct') || h.includes('percent'));

    // Find venue name from nearest preceding h2/h3/h4 or parent section heading
    let venue = '';
    let prev = $table.prev();
    while (prev.length && !venue) {
      const tag = prev[0].tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) { venue = prev.text().trim(); break; }
      prev = prev.prev();
    }
    // Fallback: look for heading inside the table's parent
    if (!venue) {
      venue = $table.closest('section, div, article')
                .find('h1, h2, h3, h4').first().text().trim();
    }
    if (!venue) return;

    // Also check for distance — some sites break stats by distance
    // We'll default distance to null if not found
    let distance = null;
    const venueText = venue;
    const distMatch = venueText.match(/(\d{3,4})\s*m/i);
    if (distMatch) distance = parseInt(distMatch[1], 10);

    $table.find('tr').slice(1).each((_, row) => {
      const cells = $(row).find('td').map((_, td) => $(td).text().trim()).get();
      if (!cells.length) return;

      const trapRaw = cells[colTrap];
      const trap    = parseInt(trapRaw, 10);
      if (!trap || trap < 1 || trap > 8) return;

      const wins   = parseInt(cells[colWins], 10)   || 0;
      const runs   = parseInt(cells[colRuns], 10)   || 0;
      const pct    = parseFloat(cells[colPct])      || (runs > 0 ? (wins / runs) * 100 : 0);

      records.push({ venue, trap_number: trap, distance, wins, total_runs: runs, win_percentage: pct });
    });
  });

  return records;
}

// ── Trainer stats parser ──────────────────────────────────────────────────────
//
// Typically a single table with columns:
//   Trainer | Runs | Wins | Win%

function parseTrainerStats(html) {
  const $       = cheerio.load(html);
  const records = [];

  $('table').each((_, table) => {
    const $table  = $(table);
    const headers = $table.find('tr').first().find('th, td')
                      .map((_, el) => $(el).text().trim().toLowerCase()).get();

    const hasTrainer = headers.some(h => h.includes('trainer'));
    const hasWin     = headers.some(h => h.includes('win'));
    if (!hasTrainer || !hasWin) return;

    const colName = headers.findIndex(h => h.includes('trainer'));
    const colRuns = headers.findIndex(h => h.includes('run') || h.includes('total'));
    const colWins = headers.findIndex(h => h === 'wins' || h === 'win');
    const colPct  = headers.findIndex(h => h.includes('%') || h.includes('pct') || h.includes('percent'));

    $table.find('tr').slice(1).each((_, row) => {
      const cells = $(row).find('td').map((_, td) => $(td).text().trim()).get();
      if (!cells.length) return;

      const name = cells[colName] || '';
      if (!name || name.length < 2) return;

      const runs = parseInt(cells[colRuns], 10) || 0;
      const wins = parseInt(cells[colWins], 10) || 0;
      const pct  = parseFloat(cells[colPct])    || (runs > 0 ? (wins / runs) * 100 : 0);

      records.push({ trainer_name: name, total_runs: runs, total_wins: wins, win_percentage: pct });
    });
  });

  return records;
}

// ── DB upsert helpers ─────────────────────────────────────────────────────────

function upsertTrapStats(db, records) {
  const stmt = db.prepare(`
    INSERT INTO trap_stats (venue, trap_number, distance, wins, total_runs, win_percentage, last_updated)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(venue, trap_number, distance) DO UPDATE SET
      wins           = excluded.wins,
      total_runs     = excluded.total_runs,
      win_percentage = excluded.win_percentage,
      last_updated   = excluded.last_updated
  `);
  const run = db.transaction((rows) => {
    for (const r of rows) stmt.run(r.venue, r.trap_number, r.distance, r.wins, r.total_runs, r.win_percentage);
  });
  run(records);
}

function upsertTrainerStats(db, records) {
  const stmt = db.prepare(`
    INSERT INTO trainer_stats (trainer_name, total_runs, total_wins, win_percentage, last_updated)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(trainer_name) DO UPDATE SET
      total_runs     = excluded.total_runs,
      total_wins     = excluded.total_wins,
      win_percentage = excluded.win_percentage,
      last_updated   = excluded.last_updated
  `);
  const run = db.transaction((rows) => {
    for (const r of rows) stmt.run(r.trainer_name, r.total_runs, r.total_wins, r.win_percentage);
  });
  run(records);
}

function logPipeline(db, source, status, recordsFetched, errorMessage) {
  db.prepare(`
    INSERT INTO pipeline_log (source, status, records_fetched, error_message, ran_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(source, status, recordsFetched, errorMessage || null);
}

// ── Main export ───────────────────────────────────────────────────────────────

async function scrapeGreyhoundStats({ saveSamples = false } = {}) {
  const db = getDb();
  let trapCount = 0, trainerCount = 0;

  // ── Trap stats ──────────────────────────────────────────────────────────────
  try {
    console.log('[GStats] Fetching trap stats…');
    const trapHtml = await fetchPage(
      'https://greyhoundstats.co.uk/track_stats.php',
      saveSamples ? 'sample_trap_stats.html' : null
    );
    const trapRecords = parseTrapStats(trapHtml);
    trapCount = trapRecords.length;

    if (trapCount) {
      upsertTrapStats(db, trapRecords);
      console.log(`[GStats] Trap stats: ${trapCount} records stored`);
    } else {
      console.warn('[GStats] Trap stats: no records parsed — check data/sample_trap_stats.html');
      // Save sample for debugging even if saveSamples not set
      fs.writeFileSync(path.join(DATA_DIR, 'sample_trap_stats.html'), trapHtml, 'utf8');
    }
    logPipeline(db, 'greyhoundstats_traps', 'ok', trapCount, null);
  } catch (err) {
    console.error(`[GStats] Trap stats failed: ${err.message}`);
    logPipeline(db, 'greyhoundstats_traps', 'error', 0, err.message);
  }

  await sleep(3000);

  // ── Trainer stats ───────────────────────────────────────────────────────────
  try {
    console.log('[GStats] Fetching trainer stats…');
    const trainerHtml = await fetchPage(
      'https://greyhoundstats.co.uk/trainers.php',
      saveSamples ? 'sample_trainer_stats.html' : null
    );
    const trainerRecords = parseTrainerStats(trainerHtml);
    trainerCount = trainerRecords.length;

    if (trainerCount) {
      upsertTrainerStats(db, trainerRecords);
      console.log(`[GStats] Trainer stats: ${trainerCount} records stored`);
    } else {
      console.warn('[GStats] Trainer stats: no records parsed — check data/sample_trainer_stats.html');
      fs.writeFileSync(path.join(DATA_DIR, 'sample_trainer_stats.html'), trainerHtml, 'utf8');
    }
    logPipeline(db, 'greyhoundstats_trainers', 'ok', trainerCount, null);
  } catch (err) {
    console.error(`[GStats] Trainer stats failed: ${err.message}`);
    logPipeline(db, 'greyhoundstats_trainers', 'error', 0, err.message);
  }

  return { trapCount, trainerCount };
}

module.exports = { scrapeGreyhoundStats };
