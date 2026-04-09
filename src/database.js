'use strict';

/**
 * SQLite database for race tips and results.
 *
 * Schema
 * ──────
 * tips      — one row per tipped runner per race per source (snapshotted at race time)
 * results   — one row per settled race (winner name + selection ID)
 *
 * The DB file lives at data/greyhound.db next to the existing accuracy.json.
 * On first run it migrates any existing accuracy.json data automatically.
 */

const path    = require('path');
const fs      = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE  = path.join(DATA_DIR, 'greyhound.db');

let _db = null;

function getDb() {
  if (_db) return _db;

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  _db = new Database(DB_FILE);
  _db.pragma('journal_mode = WAL');   // better concurrency
  _db.pragma('synchronous  = NORMAL'); // safe + faster than FULL

  _db.exec(`
    CREATE TABLE IF NOT EXISTS tips (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      race_id          TEXT    NOT NULL,
      race_date        TEXT    NOT NULL,
      venue            TEXT    NOT NULL,
      race_time        TEXT    NOT NULL,
      dog_name         TEXT    NOT NULL,
      dog_name_norm    TEXT    NOT NULL,
      selection_id     TEXT,
      source           TEXT    NOT NULL,
      position         INTEGER NOT NULL,
      is_best_bet      INTEGER NOT NULL DEFAULT 0,
      is_ew_outsider   INTEGER NOT NULL DEFAULT 0,
      win_tip_count    INTEGER NOT NULL DEFAULT 0,
      snapshotted_at   TEXT    NOT NULL,
      UNIQUE(race_id, race_date, dog_name_norm, source)
    );

    CREATE TABLE IF NOT EXISTS results (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      race_id              TEXT    NOT NULL,
      race_date            TEXT    NOT NULL,
      venue                TEXT    NOT NULL,
      race_time            TEXT    NOT NULL,
      winner_name          TEXT    NOT NULL,
      winner_name_norm     TEXT    NOT NULL,
      winner_selection_id  TEXT,
      settled_at           TEXT    NOT NULL,
      UNIQUE(race_id, race_date)
    );

    CREATE INDEX IF NOT EXISTS idx_tips_date     ON tips(race_date);
    CREATE INDEX IF NOT EXISTS idx_tips_race     ON tips(race_id, race_date);
    CREATE INDEX IF NOT EXISTS idx_results_date  ON results(race_date);
    CREATE INDEX IF NOT EXISTS idx_results_race  ON results(race_id, race_date);
  `);

  // dog_run_history — one row per runner per race, built from GBGB results API
  _db.exec(`
    CREATE TABLE IF NOT EXISTS dog_run_history (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      race_date     TEXT    NOT NULL,
      venue         TEXT    NOT NULL,
      race_time     TEXT    NOT NULL,
      grade         TEXT,
      distance      INTEGER,
      dog_name      TEXT    NOT NULL,
      dog_name_norm TEXT    NOT NULL,
      trap          INTEGER,
      position      INTEGER NOT NULL,
      run_time      REAL,
      created_at    TEXT    NOT NULL,
      UNIQUE(race_date, venue, race_time, dog_name_norm)
    );

    CREATE INDEX IF NOT EXISTS idx_history_dog   ON dog_run_history(dog_name_norm);
    CREATE INDEX IF NOT EXISTS idx_history_date  ON dog_run_history(race_date);
    CREATE INDEX IF NOT EXISTS idx_history_venue ON dog_run_history(dog_name_norm, venue);
  `);

  // Add 2nd/3rd place columns if they don't exist yet (non-destructive migration)
  const cols = _db.prepare("PRAGMA table_info(results)").all().map(c => c.name);
  if (!cols.includes('second_name')) {
    _db.exec(`ALTER TABLE results ADD COLUMN second_name      TEXT`);
    _db.exec(`ALTER TABLE results ADD COLUMN second_name_norm TEXT`);
    _db.exec(`ALTER TABLE results ADD COLUMN third_name       TEXT`);
    _db.exec(`ALTER TABLE results ADD COLUMN third_name_norm  TEXT`);
    console.log('[DB] Migrated results table: added 2nd/3rd place columns');
  }

  // Migrate existing accuracy.json data on first run
  migrateJson(_db);

  return _db;
}

/** One-time migration from legacy accuracy.json → SQLite */
function migrateJson(db) {
  const jsonFile = path.join(DATA_DIR, 'accuracy.json');
  const doneFile = path.join(DATA_DIR, '.migrated');
  if (!fs.existsSync(jsonFile) || fs.existsSync(doneFile)) return;

  console.log('[DB] Migrating accuracy.json → greyhound.db…');
  try {
    const { snapshots = [], results = [] } = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));

    const insertTip = db.prepare(`
      INSERT OR IGNORE INTO tips
        (race_id, race_date, venue, race_time, dog_name, dog_name_norm,
         selection_id, source, position, is_best_bet, is_ew_outsider, snapshotted_at)
      VALUES
        (@race_id, @race_date, @venue, @race_time, @dog_name, @dog_name_norm,
         @selection_id, @source, @position, @is_best_bet, @is_ew_outsider, @snapshotted_at)
    `);

    const insertResult = db.prepare(`
      INSERT OR IGNORE INTO results
        (race_id, race_date, venue, race_time, winner_name, winner_name_norm,
         winner_selection_id, settled_at)
      VALUES
        (@race_id, @race_date, @venue, @race_time, @winner_name, @winner_name_norm,
         @winner_selection_id, @settled_at)
    `);

    const migrate = db.transaction(() => {
      for (const snap of snapshots) {
        for (const runner of (snap.runners || [])) {
          for (const source of (runner.sources || [])) {
            insertTip.run({
              race_id:        snap.raceId,
              race_date:      snap.raceDate,
              venue:          snap.venue,
              race_time:      snap.raceTime,
              dog_name:       runner.name,
              dog_name_norm:  runner.nameNorm,
              selection_id:   runner.selectionId || null,
              source,
              position:       (runner.tipPositions || {})[source] || 1,
              is_best_bet:    runner.isBestBet    ? 1 : 0,
              is_ew_outsider: runner.isEachWayOutsider ? 1 : 0,
              snapshotted_at: snap.snapshottedAt,
            });
          }
        }
      }
      for (const r of results) {
        insertResult.run({
          race_id:             r.raceId,
          race_date:           r.raceDate,
          venue:               r.venue,
          race_time:           r.raceTime,
          winner_name:         r.winnerName,
          winner_name_norm:    r.winnerNameNorm,
          winner_selection_id: r.winnerSelectionId || null,
          settled_at:          r.settledAt,
        });
      }
    });

    migrate();
    fs.writeFileSync(doneFile, new Date().toISOString());
    console.log(`[DB] Migration complete — ${snapshots.length} snapshots, ${results.length} results`);
  } catch (err) {
    console.error('[DB] Migration failed:', err.message);
  }
}

module.exports = { getDb, DB_FILE };
