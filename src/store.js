'use strict';

/**
 * Lightweight JSON file persistence for accuracy tracking data.
 * Stores tip snapshots and race results in data/accuracy.json.
 */

const fs   = require('fs');
const path = require('path');

const DATA_DIR  = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'accuracy.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  ensureDir();
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (_) {
    return { snapshots: [], results: [] };
  }
}

function save(data) {
  ensureDir();
  // Write to a temp file then rename for atomic-ish write
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}

module.exports = { load, save };
