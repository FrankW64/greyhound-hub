'use strict';

/**
 * gbgbPipeline.js — fetches GBGB meeting and race data into the pipeline tables.
 *
 * Endpoints:
 *   Meeting list:    https://api.gbgb.org.uk/api/results/?date=YYYY-MM-DD
 *   Meeting detail:  https://api.gbgb.org.uk/api/results/meeting/?meetingId=XXXXX
 *
 * Known field names (confirmed from prior API testing):
 *   meetingId, trackName, raceDate (MM/DD/YYYY), raceTime (HH:MM:SS),
 *   raceId, raceClass, raceDistance (float metres), dogName, trapNumber,
 *   trainerName, resultPosition, sectionalTime (not always present)
 */

const axios  = require('axios');
const { getDb } = require('./database');

const BASE    = 'https://api.gbgb.org.uk/api/results';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept':     'application/json',
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Date helpers ──────────────────────────────────────────────────────────────

function parseGbgbDate(str) {
  // GBGB returns "MM/DD/YYYY"
  const m = (str || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : (str || '');
}

function parseGbgbTime(str) {
  // GBGB returns "HH:MM:SS" — trim to HH:MM
  const m = (str || '').match(/(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : (str || '');
}

// ── DB helpers ────────────────────────────────────────────────────────────────

function insertMeeting(db, meetingId, date, venue) {
  db.prepare(`
    INSERT OR IGNORE INTO meetings (meeting_id, date, venue)
    VALUES (?, ?, ?)
  `).run(String(meetingId), date, venue);
}

function insertRace(db, meetingId, raceNumber, distance, grade, raceTime) {
  const result = db.prepare(`
    INSERT INTO races (meeting_id, race_number, distance, grade, race_time)
    VALUES (?, ?, ?, ?, ?)
  `).run(String(meetingId), raceNumber, distance, grade, raceTime);
  return result.lastInsertRowid;
}

function insertRunner(db, raceId, trapNumber, dogName, trainer, finishPosition, raceTimeSeconds) {
  db.prepare(`
    INSERT INTO runners (race_id, trap_number, dog_name, trainer, finish_position, race_time_seconds)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(raceId, trapNumber, dogName, trainer, finishPosition, raceTimeSeconds);
}

function logPipeline(db, source, status, recordsFetched, errorMessage) {
  db.prepare(`
    INSERT INTO pipeline_log (source, status, records_fetched, error_message, ran_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(source, status, recordsFetched, errorMessage || null);
}

// ── API fetchers ──────────────────────────────────────────────────────────────

async function fetchMeetingList(date) {
  const { data } = await axios.get(`${BASE}/`, {
    params:  { date },
    headers: HEADERS,
    timeout: 15000,
  });
  // Response may be array or { items: [] }
  return Array.isArray(data) ? data : (data.items || data.results || []);
}

async function fetchMeetingDetail(meetingId) {
  const { data } = await axios.get(`${BASE}/meeting/`, {
    params:  { meetingId },
    headers: HEADERS,
    timeout: 15000,
  });
  return Array.isArray(data) ? data : (data.items || data.results || []);
}

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Fetch and store all races for a single date.
 *
 * @param {string} date  YYYY-MM-DD
 * @returns {{ date, meetingsFound, meetingsFetched, runnersFetched, errors }}
 */
async function fetchGBGBDate(date) {
  const db = getDb();
  const summary = { date, meetingsFound: 0, meetingsFetched: 0, runnersFetched: 0, errors: [] };

  let meetings;
  try {
    meetings = await fetchMeetingList(date);
    summary.meetingsFound = meetings.length;
  } catch (err) {
    const msg = `Meeting list failed for ${date}: ${err.message}`;
    console.error(`[GBGB] ${msg}`);
    summary.errors.push(msg);
    logPipeline(db, 'gbgb', 'error', 0, msg);
    return summary;
  }

  if (!meetings.length) {
    console.log(`[GBGB] ${date}: no meetings found`);
    logPipeline(db, 'gbgb', 'ok', 0, null);
    return summary;
  }

  // Deduplicate meetings by meetingId (API sometimes returns duplicate rows)
  const seen = new Map();
  for (const m of meetings) {
    const id = String(m.meetingId || m.MeetingId || '');
    if (id && !seen.has(id)) seen.set(id, m);
  }
  const uniqueMeetings = [...seen.values()];

  for (const meeting of uniqueMeetings) {
    const meetingId = String(meeting.meetingId || meeting.MeetingId || '');
    const venue     = meeting.trackName || meeting.venue || meeting.Track || '';
    if (!meetingId) continue;

    try {
      const rows = await fetchMeetingDetail(meetingId);

      if (!rows.length) {
        console.log(`[GBGB] ${venue}: no race rows returned`);
        continue;
      }

      // Insert meeting
      const rawDate = rows[0].raceDate || rows[0].RaceDate || date;
      insertMeeting(db, meetingId, parseGbgbDate(rawDate), venue);

      // Group rows by raceId to reconstruct individual races
      const raceMap = new Map();
      for (const row of rows) {
        const raceId = String(row.raceId || row.RaceId || '');
        if (!raceId) continue;
        if (!raceMap.has(raceId)) raceMap.set(raceId, []);
        raceMap.get(raceId).push(row);
      }

      let raceNumber = 1;
      let runnersThisMeeting = 0;

      // Use a transaction for performance
      const storeMeeting = db.transaction(() => {
        for (const [, raceRows] of raceMap) {
          const first    = raceRows[0];
          const distance = first.raceDistance ? Math.round(parseFloat(first.raceDistance)) : null;
          const grade    = first.raceClass    || first.RaceClass    || null;
          const raceTime = parseGbgbTime(first.raceTime || first.RaceTime || '');

          const dbRaceId = insertRace(db, meetingId, raceNumber++, distance, grade, raceTime);

          for (const row of raceRows) {
            const trapNumber    = parseInt(row.trapNumber    || row.TrapNumber    || '0', 10) || null;
            const dogName       = (row.dogName       || row.DogName       || '').trim();
            const trainer       = (row.trainerName   || row.TrainerName   || '').trim();
            const finishPos     = parseInt(row.resultPosition || row.ResultPosition || '0', 10) || null;
            const runTimeSec    = parseFloat(row.sectionalTime || row.SectionalTime || '') || null;

            if (!dogName) continue;
            insertRunner(db, dbRaceId, trapNumber, dogName, trainer, finishPos, runTimeSec);
            runnersThisMeeting++;
          }
        }
      });

      storeMeeting();
      summary.meetingsFetched++;
      summary.runnersFetched += runnersThisMeeting;
      console.log(`[GBGB] ${venue}: ${raceMap.size} races, ${runnersThisMeeting} runners stored`);
    } catch (err) {
      const msg = `${venue} (${meetingId}): ${err.message}`;
      console.error(`[GBGB] Error — ${msg}`);
      summary.errors.push(msg);
    }

    await sleep(2000); // polite delay between meeting requests
  }

  logPipeline(db, 'gbgb', summary.errors.length ? 'partial' : 'ok', summary.runnersFetched, summary.errors.join('; ') || null);
  return summary;
}

/**
 * Fetch a range of dates sequentially.
 *
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
    process.stdout.write(`[${i + 1}/${dates.length}] ${dates[i]} — ${summary.meetingsFetched} meetings, ${summary.runnersFetched} runners\n`);
    if (i < dates.length - 1) await sleep(1000);
  }

  console.log(`\n[GBGB] Done — ${totals.meetingsFetched} meetings, ${totals.runnersFetched} runners, ${totals.errors} errors`);
  return totals;
}

module.exports = { fetchGBGBDate, fetchGBGBDateRange };
