'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { fetchTimeformResults } = require('../src/timeformResultsScraper');

const date  = process.argv[2] || '2026-04-10';
const limit = parseInt(process.argv[3] || '2', 10);

(async () => {
  console.log(`\nTesting scraper on ${date} (${limit} races)...\n`);
  const runners = await fetchTimeformResults(date, { limit });

  if (!runners.length) {
    console.log('No runners returned — check scraper or Timeform availability');
    return;
  }

  // Group by race
  const races = {};
  for (const r of runners) {
    const key = r.venue + ' ' + r.raceTime;
    if (!races[key]) races[key] = [];
    races[key].push(r);
  }

  for (const [race, dogs] of Object.entries(races)) {
    const first = dogs[0];
    console.log(`=== ${race} | grade: ${first.grade || 'NULL'} | dist: ${first.distance || 'NULL'} ===`);
    dogs.forEach(d => {
      const pos     = String(d.position).padStart(2);
      const trap    = String(d.trap || '-').padStart(2);
      const name    = d.dogName.padEnd(26);
      const time    = (d.runTime != null ? d.runTime : 'NULL').toString().padStart(6);
      const beaten  = (d.beaten || 'NULL').padEnd(6);
      const comment = d.runComment || 'NULL';
      console.log(`  pos:${pos} trap:${trap} ${name} time:${time} beaten:${beaten} | ${comment}`);
    });
    console.log('');
  }
})().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
