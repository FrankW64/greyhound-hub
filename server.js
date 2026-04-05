'use strict';

require('dotenv').config();

const express     = require('express');
const cors        = require('cors');
const path        = require('path');
const crypto      = require('crypto');
const DataManager = require('./src/dataManager');

const app        = express();
const PORT       = process.env.PORT || 3000;
const IS_PROD    = process.env.NODE_ENV === 'production';
const dm         = new DataManager();

// ── Auth ──────────────────────────────────────────────────────────────────────

const AUTH_PASSWORD  = process.env.AUTH_PASSWORD || '';
const AUTH_ENABLED   = AUTH_PASSWORD.length > 0;
const validSessions  = new Set(); // in-memory; cleared on restart (7-day cookies keep users logged in)
const SESSION_COOKIE = 'gh_session';
const COOKIE_OPTS    = {
  httpOnly: true,
  secure:   IS_PROD,
  sameSite: 'strict',
  maxAge:   7 * 24 * 60 * 60 * 1000, // 7 days
};

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(pair => {
    const [k, ...v] = pair.split('=');
    if (k) out[k.trim()] = decodeURIComponent(v.join('=').trim());
  });
  return out;
}

function isAuthed(req) {
  if (!AUTH_ENABLED) return true; // no password set → open access
  return validSessions.has(parseCookies(req)[SESSION_COOKIE]);
}

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
app.use(express.urlencoded({ extended: false }));

// Serve coming-soon static assets publicly (logo, favicon only)
// Full static serving happens after auth check below
app.use('/logo.png',  express.static(path.join(__dirname, 'public', 'logo.png')));
app.use('/favicon',   express.static(path.join(__dirname, 'public')));

// ── Auth routes (before static / API middleware) ──────────────────────────────

// POST /auth — password check
app.post('/auth', (req, res) => {
  if (!AUTH_ENABLED) return res.redirect('/');
  if (req.body.password === AUTH_PASSWORD) {
    const token = crypto.randomBytes(32).toString('hex');
    validSessions.add(token);
    res.cookie(SESSION_COOKIE, token, COOKIE_OPTS);
    return res.redirect('/');
  }
  res.redirect('/?error=1');
});

// GET /logout — clear session
app.get('/logout', (req, res) => {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) validSessions.delete(token);
  res.clearCookie(SESSION_COOKIE);
  res.redirect('/');
});

// GET / — show coming soon to guests, app to authed users
app.get('/', (req, res) => {
  if (isAuthed(req)) return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  res.sendFile(path.join(__dirname, 'public', 'coming-soon.html'));
});

// Protect all static app assets and API routes
app.use((req, res, next) => {
  // Always allow the coming-soon page itself and auth routes
  if (req.path === '/coming-soon.html' || req.path === '/auth' || req.path === '/logout') {
    return next();
  }
  if (isAuthed(req)) return next();
  // API requests get a JSON 401; everything else redirects to coming soon
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ success: false, error: 'Unauthorised' });
  }
  res.redirect('/');
});

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
  if (isAuthed(req)) return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  res.redirect('/');
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
