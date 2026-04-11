'use strict';

/**
 * fixBetfairNorms.js — one-time fix to strip trap number prefix from
 * betfair_odds.dog_name_norm (e.g. "6crokersLuna" → "crokersLuna")
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getDb } = require('../src/database');

function norm(name) {
  const stripped = (name || '').replace(/^\d+\.\s*/, '');
  return stripped.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const db  = getDb();
const all = db.prepare('SELECT id, dog_name FROM betfair_odds').all();

const update = db.prepare('UPDATE betfair_odds SET dog_name_norm = ? WHERE id = ?');

const fix = db.transaction(() => {
  let count = 0;
  for (const row of all) {
    const correct = norm(row.dog_name);
    update.run(correct, row.id);
    count++;
  }
  return count;
});

const updated = fix();
console.log(`✅ Fixed dog_name_norm for ${updated} betfair_odds rows`);
