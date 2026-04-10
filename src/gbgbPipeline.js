'use strict';

/**
 * gbgbPipeline.js — fetches GBGB race data into the pipeline tables.
 *
 * Uses the confirmed working endpoint:
 *   https://api.gbgb.org.uk/api/results?raceDate=YYYY-MM-DD&pageSize=500
 *
 * This returns all runner rows for a date. We group by meetingId/raceId
 * to reconstruct meetings and races, then store into the pipeline tables.
 *
 * Confirmed field names from API:
 *   meetingId, trackName, raceDate (MM/DD/YYYY), raceTime (HH:MM:SS),
 *   raceId, raceClass, raceDistance (float), dogName, trapNumber,
 *   trainerName, resultPosition
 */

const axios     = require('axios');
const { getDb } = require('./database');

const BASE_URL = 'https://api.gbgb.org.uk/api/results';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':     'application/json, text/plain, */*',
  'Referer':    'https://www.gbgb.org.uk/',
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseGbgbDate(str) {
  const m = (str || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : (str || '');
}

function parseGbgbTime(str) {
  const m = (str || '').match(/(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : (str || '');
}

// ── API fetch ─────────────────────────────────────────────────────────────────

async function fetchAllRunnersForDate(date, retries = 3, delayMs = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const { data } = await axios.get(BASE_URL, {
        params:  { raceDate: date, pageSize: 500 },
        headers: HEADERS,
        timeout: 15000,
      });
      return Array.isArray(data) ? data : (data.items || []);
    } catch (err) {
      const status = err.response?.status;
      if (attempt < retries && (status === 503 || status === 429 || status === 502)) {
        await sleep(delayMs);
        delayMs *= 2;
      } else throw err;
    }
  }
}

// ── DB helpers ────────────────────────────────────────────────────────────────

function logPipeline(db, source, status, recordsFetched, errorMessage) {
  db.prepare(`
    INSERT INTO pipeline_log (source, status, records_fetched, error_message, ran_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(source, status, recordsFetched, errorMessage || null);
}

// ── Core ──────────────────────────────────────────────────────────────────────

/**
 * Fetch and store all runners for a single date.
 * Groups API rows by meetingId → raceId to build meetings/races/runners.
 *
 * @param {string} date  YYYY-MM-DD
 * @returns {{ date, meetingsFound, meetingsFetched, runnersFetched, errors }}
 */
async function fetchGBGBDate(date) {
  const db = getDb();
  const summary = { date, meetingsFound: 0, meetingsFetched: 0, runnersFetched: 0, errors: [] };

  let rows;
  try {
    rows = await fetchAllRunnersForDate(date);
  } catch (err) {
    const msg = `${date}: ${err.message}`;
    console.error(`[GBGB] ${msg}`);
    summary.errors.push(msg);
    logPipeline(db, 'gbgb', 'error', 0, msg);
    return summary;
  }

  if (!rows || !rows.length) {
    console.log(`[GBGB] ${date}: no data`);
    logPipeline(db, 'gbgb', 'ok', 0, null);
    return summary;
  }

  // Group: meetingId → { venue, date, races: Map(raceId → rows[]) }
  const meetingMap = new Map();
  for (const row of rows) {
    const meetingId = String(row.meetingId || '');
    const raceId    = String(row.raceId    || '');
    if (!meetingId || !raceId) continue;

    if (!meetingMap.has(meetingId)) {
      meetingMap.set(meetingId, {
        venue: row.trackName || '',
        date:  parseGbgbDate(row.raceDate),
        races: new Map(),
      });
    }
    const meeting = meetingMap.get(meetingId);
    if (!meeting.races.has(raceId)) meeting.races.set(raceId, []);
    meeting.races.get(raceId).push(row);
  }

  summary.meetingsFound = meetingMap.size;

  // Persist each meeting
  const store = db.transaction(() => {
    for (const [meetingId, meeting] of meetingMap) {
      // Insert meeting (ignore if already exists)
      db.prepare(`
        INSERT OR IGNORE INTO meetings (meeting_id, date, venue)
        VALUES (?, ?, ?)
      `).run(meetingId, meeting.date, meeting.venue);

      let raceNumber = 1;
      for (const [, raceRows] of meeting.races) {
        const first    = raceRows[0];
        const distance = first.raceDistance ? Math.round(parseFloat(first.raceDistance)) : null;
        const grade    = first.raceClass    || null;
        const raceTime = parseGbgbTime(first.raceTime || '');

        const gbgbRaceId = raceRows[0].raceId ? String(raceRows[0].raceId) : null;

        // INSERT OR IGNORE deduplicates on gbgb_race_id UNIQUE constraint
        const { lastInsertRowid: dbRaceId, changes } = db.prepare(`
          INSERT OR IGNORE INTO races (meeting_id, gbgb_race_id, race_number, distance, grade, race_time)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(meetingId, gbgbRaceId, raceNumber++, distance, grade, raceTime);

        if (!changes) continue; // race already stored

        for (const row of raceRows) {
          const trap    = parseInt(row.trapNumber    || '0', 10) || null;
          const dog     = (row.dogName     || '').trim();
          const trainer = (row.trainerName || '').trim();
          const pos     = parseInt(row.resultPosition || '0', 10) || null;
          const time    = parseFloat(row.sectionalTime || '') || null;
          if (!dog) continue;
          db.prepare(`
            INSERT INTO runners (race_id, trap_number, dog_name, trainer, finish_position, race_time_seconds)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(dbRaceId, trap, dog, trainer, pos, time);
          summary.runnersFetched++;
        }
      }
      summary.meetingsFetched++;
    }
  });

  store();

  console.log(`[GBGB] ${date}: ${summary.meetingsFetched} meetings, ${summary.runnersFetched} runners`);
  logPipeline(db, 'gbgb', summary.errors.length ? 'partial' : 'ok', summary.runnersFetched, summary.errors.join('; ') || null);
  return summary;
}

/**
 * Fetch a date range sequentially.
 * @param {string} startDate  YYYY-MM-DD
 * @param {string} endDate    YYYY-MM-DD
 */
async function fetchGBGBDateRange(startDate, endDate) {
  const dates  = [];
  const cursor = new Date(startDate);
  const end    = new Date(endDate);
  while (cursor <= end) {
    dates.push(cursor.toISOString().split('T')[0]);
    cursor.setDate(cursor.getDate() + 1);
  }

  console.log(`[GBGB] Fetching ${dates.length} days: ${startDate} → ${endDate}`);
  const totals = { meetingsFetched: 0, runnersFetched: 0, errors: 0 };

  for (let i = 0; i < dates.length; i++) {
    const summary = await fetchGBGBDate(dates[i]);
    totals.meetingsFetched += summary.meetingsFetched;
    totals.runnersFetched  += summary.runnersFetched;
    totals.errors          += summary.errors.length;
    console.log(`[${i + 1}/${dates.length}] ${dates[i]} — ${summary.meetingsFetched} meetings, ${summary.runnersFetched} runners`);
    if (i < dates.length - 1) await sleep(1000);
  }

  console.log(`\n[GBGB] Done — ${totals.meetingsFetched} meetings, ${totals.runnersFetched} runners, ${totals.errors} errors`);
  return totals;
}

module.exports = { fetchGBGBDate, fetchGBGBDateRange };
