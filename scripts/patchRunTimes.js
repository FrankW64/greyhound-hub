'use strict';

/**
 * patchRunTimes.js — backfills run_time for existing dog_run_history records.
 *
 * Finds all unique races where run_time IS NULL, re-scrapes those Timeform
 * result pages, and updates only the run_time column.
 *
 * Usage:
 *   node scripts/patchRunTimes.js
 *   node scripts/patchRunTimes.js --limit 100   # patch first 100 races only
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const axios      = require('axios');
const cheerio    = require('cheerio');
const { getDb }  = require('../src/database');

const BASE    = 'https://www.timeform.com';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':     'text/html,application/xhtml+xml,*/*',
  'Accept-Language': 'en-GB,en;q=0.9',
};

const limitIdx = process.argv.indexOf('--limit');
const LIMIT    = limitIdx >= 0 ? parseInt(process.argv[limitIdx + 1], 10) : null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const SLUG_TO_VENUE = {
  'romford': 'Romford', 'hove': 'Hove', 'belle-vue': 'Belle Vue',
  'nottingham': 'Nottingham', 'swindon': 'Swindon', 'monmore': 'Monmore',
  'oxford': 'Oxford', 'perry-barr': 'Perry Barr', 'poole': 'Poole',
  'sheffield': 'Sheffield', 'towcester': 'Towcester', 'newcastle': 'Newcastle',
  'doncaster': 'Doncaster', 'yarmouth': 'Yarmouth', 'kinsley': 'Kinsley',
  'coventry': 'Coventry', 'henlow': 'Henlow', 'peterborough': 'Peterborough',
  'harlow': 'Harlow', 'crayford': 'Crayford', 'wimbledon': 'Wimbledon',
  'central-park': 'Central Park', 'dunstall-park': 'Dunstall Park',
  'pelaw-grange': 'Pelaw Grange', 'suffolk-downs': 'Suffolk Downs',
  'the-valley': 'The Valley', 'valley': 'The Valley', 'sunderland': 'Sunderland',
};

const VENUE_TO_SLUG = Object.fromEntries(
  Object.entries(SLUG_TO_VENUE).map(([slug, venue]) => [venue.toLowerCase(), slug])
);

async function fetchRunTimes(date, venue, time) {
  // Build listing URL and find the race URL
  const venueSlug = VENUE_TO_SLUG[venue.toLowerCase()] || venue.toLowerCase().replace(/\s+/g, '-');
  const timePart  = time.replace(':', '');
  const listUrl   = `${BASE}/greyhound-racing/results/${date}`;

  try {
    const { data: listHtml } = await axios.get(listUrl, { headers: HEADERS, timeout: 20000 });
    const $list = cheerio.load(listHtml);

    // Find matching race URL
    let raceUrl = null;
    $list(`a[href*="/greyhound-racing/results/${venueSlug}/${timePart}"]`).each((_, el) => {
      raceUrl = `${BASE}${$list(el).attr('href')}`;
      return false;
    });

    if (!raceUrl) return {};

    await sleep(2000);
    const { data: raceHtml } = await axios.get(raceUrl, { headers: HEADERS, timeout: 20000 });
    const $ = cheerio.load(raceHtml);

    // Extract run times per dog name
    const runTimes = {};
    for (let pos = 1; pos <= 8; pos++) {
      $(`.rrb-runner-details-${pos}`).each((_, el) => {
        const row     = $(el);
        const dogName = row.find('a.rrb-greyhound').first().text().trim().toUpperCase();
        const rtText  = row.find('span[title*="run time"], span[title*="Run time"]').first().text().trim();
        const runTime = rtText ? parseFloat(rtText) || null : null;
        if (dogName && runTime) runTimes[dogName] = runTime;
      });
    }
    return runTimes;
  } catch (err) {
    return {};
  }
}

async function main() {
  const db = getDb();

  // Find all unique races with null run_time
  const races = db.prepare(`
    SELECT DISTINCT race_date, venue, race_time
    FROM   dog_run_history
    WHERE  run_time IS NULL
    ORDER  BY race_date DESC
    ${LIMIT ? `LIMIT ${LIMIT}` : ''}
  `).all();

  console.log(`\n🕐 Patching run times for ${races.length} races…\n`);

  const update = db.prepare(`
    UPDATE dog_run_history
    SET    run_time = ?
    WHERE  race_date = ? AND venue = ? AND race_time = ? AND dog_name = ?
  `);

  let totalUpdated = 0;
  let listingsCache = new Map(); // cache listing pages per date

  for (let i = 0; i < races.length; i++) {
    const { race_date, venue, race_time } = races[i];
    process.stdout.write(`[${i + 1}/${races.length}] ${race_date} ${venue} ${race_time} … `);

    const runTimes = await fetchRunTimes(race_date, venue, race_time);
    const count    = Object.keys(runTimes).length;

    if (count) {
      const runUpdates = db.transaction(() => {
        let updated = 0;
        for (const [dogName, runTime] of Object.entries(runTimes)) {
          const result = update.run(runTime, race_date, venue, race_time, dogName);
          updated += result.changes;
        }
        return updated;
      });
      const updated = runUpdates();
      totalUpdated += updated;
      console.log(`${updated} run times updated`);
    } else {
      console.log('no run times found');
    }

    if (i < races.length - 1) await sleep(5000);
  }

  console.log(`\n✅ Done — ${totalUpdated} run times updated across ${races.length} races`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
