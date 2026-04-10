# Greyhound Hub — Data Pipeline

## Overview

The pipeline pulls UK greyhound race data from two sources and stores everything in `data/greyhound.db`:

| Source | Data | Tables |
|---|---|---|
| GBGB JSON API | Meetings, races, all runners + finishing positions | `meetings`, `races`, `runners` |
| greyhoundstats.co.uk | Pre-aggregated trap and trainer win stats | `trap_stats`, `trainer_stats` |

---

## Quick Start

### First-time backfill (90 days)
```bash
node pipeline.js
```
Automatically detects an empty database and runs a 90-day GBGB backfill, then scrapes greyhoundstats. Allow 30–60 minutes.

### Custom backfill length
```bash
node pipeline.js --days 30
```

### Force a fresh backfill (even if DB has data)
```bash
node pipeline.js --backfill --days 60
```

### Save raw HTML from greyhoundstats (for debugging parsers)
```bash
node pipeline.js --save-samples
```
Saves to `data/sample_trap_stats.html` and `data/sample_trainer_stats.html`.

---

## Daily Update

```bash
node daily-update.js
```

Fetches yesterday + today from GBGB (catches late results), then refreshes trap and trainer stats.

### Cron setup (Ubuntu VPS — runs at 7am daily)
```bash
crontab -e
```
Add:
```
0 7 * * * cd /var/www/greyhound-hub && node daily-update.js >> ./logs/pipeline.log 2>&1
```

Create the logs directory first:
```bash
mkdir -p /var/www/greyhound-hub/logs
```

---

## Database Tables

### `meetings`
One row per racing meeting (venue + date combination).

| Column | Type | Description |
|---|---|---|
| meeting_id | TEXT | GBGB meeting ID (unique) |
| date | TEXT | YYYY-MM-DD |
| venue | TEXT | Track name |

### `races`
One row per race within a meeting.

| Column | Type | Description |
|---|---|---|
| meeting_id | TEXT | Links to meetings.meeting_id |
| race_number | INTEGER | Sequential within meeting |
| distance | INTEGER | Metres (e.g. 480) |
| grade | TEXT | e.g. A1, A2, OR, S |
| race_time | TEXT | HH:MM |

### `runners`
One row per dog per race — all finishing positions included.

| Column | Type | Description |
|---|---|---|
| race_id | INTEGER | Links to races.id |
| trap_number | INTEGER | 1–6 |
| dog_name | TEXT | |
| trainer | TEXT | |
| finish_position | INTEGER | 1 = winner |
| race_time_seconds | REAL | Run time in seconds (if available) |
| sp | TEXT | Starting price (not always populated) |
| bsp | REAL | Betfair SP (not always populated) |

### `trap_stats`
Pre-aggregated trap win percentages from greyhoundstats.co.uk.

| Column | Type | Description |
|---|---|---|
| venue | TEXT | Track name |
| trap_number | INTEGER | 1–6 |
| distance | INTEGER | Metres (null if not broken down) |
| wins | INTEGER | |
| total_runs | INTEGER | |
| win_percentage | REAL | |

### `trainer_stats`
Overall trainer performance from greyhoundstats.co.uk.

| Column | Type | Description |
|---|---|---|
| trainer_name | TEXT | |
| total_runs | INTEGER | |
| total_wins | INTEGER | |
| win_percentage | REAL | |

### `pipeline_log`
One row per pipeline run per source — used for monitoring.

| Column | Type | Description |
|---|---|---|
| source | TEXT | e.g. `gbgb`, `greyhoundstats_traps` |
| status | TEXT | `ok`, `partial`, `error` |
| records_fetched | INTEGER | |
| error_message | TEXT | null if ok |
| ran_at | TEXT | datetime |

---

## Query Helpers (`queries.js`)

```js
const {
  getRunnersByDate,
  getTrapBias,
  getTrainerForm,
  getDogForm,
  getBestTrapsAtVenue,
  getInFormTrainers,
  getRacesByVenueAndGrade,
} = require('./queries');

// All runners for today with trap + trainer stats joined in
const runners = getRunnersByDate('2026-04-10');

// Trap win % at a venue
const bias = getTrapBias('Romford', 1);
// → { venue, trap_number, wins, total_runs, win_percentage }

// Trainer form over last 14 days
const form = getTrainerForm('J Smith', 14);
// → { trainer, total_runs, wins, win_percentage }

// Dog's last 6 runs
const dogRuns = getDogForm('FASTEST DOG', 6);

// Best traps at a venue
const traps = getBestTrapsAtVenue('Crayford');
// → [{ trap_number, win_percentage }, ...]  sorted best first

// Hot trainers (>25% win rate, min 10 runs in last 30 days)
const hotTrainers = getInFormTrainers(25);

// All A1 races at Sheffield
const races = getRacesByVenueAndGrade('Sheffield', 'A1');
```

---

## Environment Variables (`.env`)

```
DB_PATH=./data/greyhounds.db
LOG_LEVEL=info
```
