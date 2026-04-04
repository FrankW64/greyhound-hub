# UK Greyhound Racing Tips Dashboard

A live odds and tips dashboard for UK greyhound racing, built with Node.js (Express) and plain HTML/CSS/JS.

---

## Features

- **Race cards** grouped by venue, sorted by race time
- **Live Betfair Exchange odds** with drift detection (current vs morning price)
- **Race cards** from the Racing API (venue, distance, grade, trap numbers, trainers, form)
- **Tips scraped** from Greyhound Tips and Racing Post
- **Best Bet** badge — dog tipped by all sources *and* odds have drifted (value signal)
- **Tipped ×N** badge — dog tipped by 2+ sources
- **Auto-refresh** every 60 seconds with countdown bar
- Mobile-friendly responsive layout
- Runs in **mock/demo mode** out of the box — no API keys required to see the UI

---

## Quick Start (Demo Mode)

```bash
# 1. Install dependencies
npm install

# 2. Start the server (uses mock data by default)
npm start

# 3. Open http://localhost:3000
```

The dashboard works immediately with sample race data. Add live API keys when ready.

---

## Adding Live API Keys

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

### Betfair Exchange API

1. Log in to [Betfair](https://www.betfair.com) → My Account → **API Access**
2. Create a **Developer App Key** (free for personal use)
3. Set in `.env`:
   ```
   BETFAIR_USERNAME=your_username
   BETFAIR_PASSWORD=your_password
   BETFAIR_APP_KEY=your_app_key
   ```

### Racing API (racingapi.io)

1. Sign up at [racingapi.io](https://racingapi.io) for an API key
2. Set in `.env`:
   ```
   RACING_API_KEY=your_api_key
   ```

### Enable Live Mode

Once both keys are set, change in `.env`:
```
USE_MOCK_DATA=false
```

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `USE_MOCK_DATA` | `true` | Force mock data even if keys are present |
| `POLL_INTERVAL` | `60` | Refresh interval in seconds |
| `BETFAIR_USERNAME` | — | Betfair account username |
| `BETFAIR_PASSWORD` | — | Betfair account password |
| `BETFAIR_APP_KEY` | — | Betfair application key |
| `RACING_API_KEY` | — | racingapi.io API key |
| `RACING_API_BASE` | `https://api.racingapi.io/v1` | Base URL for Racing API |

---

## Project Structure

```
greyhound-dashboard/
├── server.js               # Express server + API routes
├── src/
│   ├── dataManager.js      # State, polling loop, badge logic
│   ├── mockData.js         # Realistic sample race data
│   ├── betfair.js          # Betfair Exchange API client
│   ├── racingApi.js        # racingapi.io client
│   └── scraper.js          # Cheerio scrapers (GT + RP)
├── public/
│   ├── index.html          # Single-page app shell
│   ├── styles.css          # Dark theme, mobile-first styles
│   └── app.js              # Fetch, render, auto-refresh
├── .env.example            # Environment variables template
├── package.json
└── README.md
```

---

## Best Bet Logic

```
Tipped ×N  →  dog is tipped by N ≥ 2 sources
Best Bet   →  tipped by ALL active sources AND currentOdds > openingOdds
```

"Drifted odds" means the market has moved out from the morning price — a classic
value indicator when multiple tipsters still back the selection.

---

## Development

```bash
# Hot-reload with nodemon
npm run dev
```

The scraper silently falls back to an empty tip list if either site is unavailable
or blocks the request — the rest of the app continues to work normally.
