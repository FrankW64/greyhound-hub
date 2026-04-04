'use strict';

require('dotenv').config();

const express     = require('express');
const cors        = require('cors');
const path        = require('path');
const DataManager = require('./src/dataManager');

const app        = express();
const PORT       = process.env.PORT || 3000;
const IS_PROD    = process.env.NODE_ENV === 'production';
const dm         = new DataManager();

// ── Middleware ────────────────────────────────────────────────────────────────

// Trust the first proxy hop (Nginx) so req.ip reflects the real client IP
if (IS_PROD) app.set('trust proxy', 1);

// Security headers (no extra dependencies)
app.use((req, res, next) => {
  res.removeHeader('X-Powered-By');
  res.setHeader('X-Content-Type-Options',  'nosniff');
  res.setHeader('X-Frame-Options',         'SAMEORIGIN');
  res.setHeader('X-XSS-Protection',        '1; mode=block');
  res.setHeader('Referrer-Policy',         'strict-origin-when-cross-origin');
  next();
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── API Routes ────────────────────────────────────────────────────────────────

/**
 * GET /api/races
 * All races grouped by venue, with tips, Betfair odds, and bookie odds merged.
 * Also includes apiStatus so the header can show connection indicators.
 */
app.get('/api/races', (req, res) => {
  const data = dm.getGroupedByVenue();
  res.json({ success: true, ...data });
});

/**
 * GET /api/health
 * Connection status for all external APIs.
 */
app.get('/api/health', (req, res) => {
  res.json({
    status:      'ok',
    useMockData: dm.useMockData,
    isPolling:   dm.isPolling,
    lastUpdated: dm.lastUpdated,
    ...dm.getApiStatus(),
  });
});

/**
 * GET /api/accuracy
 * Tipster accuracy stats — win rates per source and per badge type.
 */
app.get('/api/accuracy', (req, res) => {
  try {
    const stats = dm.getAccuracyStats();
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────

const HOST = IS_PROD ? '127.0.0.1' : '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`\n🐕 Greyhound Hub → http://${HOST}:${PORT}`);
  console.log('────────────────────────────────────────────────────────');
  dm.init();
});

process.on('SIGINT',  () => { dm.stop(); process.exit(0); });
process.on('SIGTERM', () => { dm.stop(); process.exit(0); });
