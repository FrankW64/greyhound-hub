'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getDb } = require('../src/database');

const date  = process.argv[2] || '2026-04-10';
const limit = parseInt(process.argv[3] || '2', 10);

const db   = getDb();
const rows = db.prepare(`
  SELECT venue, race_time, trap, dog_name, position,
         run_time, beaten, run_comment, grade, distance
  FROM   dog_run_history
  WHERE  race_date = ?
  ORDER  BY venue, race_time, position
`).all(date);

if (!rows.length) {
  console.log(`No data in database for ${date}`);
  process.exit(0);
}

// Group into races and apply limit
const raceMap = {};
for (const r of rows) {
  const key = `${r.venue} ${r.race_time}`;
  if (!raceMap[key]) raceMap[key] = [];
  raceMap[key].push(r);
}

const raceKeys = Object.keys(raceMap).slice(0, limit);
console.log(`\nDatabase records for ${date} (showing ${raceKeys.length} of ${Object.keys(raceMap).length} races)\n`);

for (const key of raceKeys) {
  const dogs  = raceMap[key];
  const first = dogs[0];
  console.log(`=== ${key} | grade: ${first.grade || 'NULL'} | dist: ${first.distance || 'NULL'} ===`);
  dogs.forEach(d => {
    const pos     = String(d.position).padStart(2);
    const trap    = String(d.trap || '-').padStart(2);
    const name    = d.dog_name.padEnd(26);
    const time    = (d.run_time != null ? d.run_time : 'NULL').toString().padStart(6);
    const beaten  = (d.beaten || 'NULL').padEnd(6);
    const comment = d.run_comment || 'NULL';
    console.log(`  pos:${pos} trap:${trap} ${name} time:${time} beaten:${beaten} | ${comment}`);
  });
  console.log('');
}
