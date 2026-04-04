'use strict';

// ── Trap bias data ────────────────────────────────────────────────────────────
// Real 2026 graded-race win rates (%) per trap, sourced from greyhoundstats.co.uk.
// Each figure = wins ÷ runs for that trap at that venue (not a share of 100).
// Fair baseline: ~16.7% (1 ÷ 6). Values above indicate a biased advantage.
const TRAP_BIAS = {
  'Central Park':  [15.3, 18.1, 18.4, 20.4, 16.6, 19.5],
  'Doncaster':     [22.9, 18.8, 19.8, 18.8, 17.9, 23.6],
  'Dunstall Park': [17.9, 17.8, 14.4, 18.1, 20.5, 16.2],
  'Harlow':        [18.6, 18.2, 18.6, 20.1, 16.2, 21.6],
  'Hove':          [18.4, 19.7, 19.0, 19.2, 25.0, 19.1],
  'Kinsley':       [18.4, 18.3, 18.9, 16.0, 13.0, 16.7],
  'Monmore':       [21.1, 15.2, 17.8, 15.8, 19.7, 17.2],
  'Newcastle':     [20.0, 18.2, 18.5, 18.0, 17.9, 16.5],
  'Nottingham':    [17.2, 21.9, 18.9, 19.2, 15.9, 16.3],
  'Oxford':        [18.7, 18.3, 20.0, 20.1, 22.4, 15.6],
  'Pelaw Grange':  [18.3, 18.2, 22.7, 23.5, 16.7, 17.0],
  'Romford':       [18.2, 18.4, 17.9, 18.3, 16.3, 15.9],
  'Sheffield':     [21.9, 17.0, 23.1, 20.2, 17.6, 15.3],
  'Suffolk Downs': [21.2, 26.5, 17.2, 18.7, 21.7, 18.5],
  'Sunderland':    [20.5, 19.1, 14.6, 15.6, 18.3, 18.3],
  'The Valley':    [21.9, 16.8, 15.0, 12.5, 19.5, 22.1],
  'Towcester':     [21.3, 16.3, 19.9, 20.4, 14.2, 14.7],
  'Yarmouth':      [19.0, 20.2, 20.4, 20.3, 15.9, 17.0],
};

/** Return the bias array for a venue, or null if not in the dataset. */
function getTrapBias(venue) {
  return TRAP_BIAS[venue] || null;
}

// ── Config ────────────────────────────────────────────────────────────────────
const REFRESH_INTERVAL = 60;
const API_ENDPOINT     = '/api/races';

// ── State ─────────────────────────────────────────────────────────────────────
let countdownVal  = REFRESH_INTERVAL;
let refreshTimer  = null;
let countdownTimer = null;

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  fetchRaces();
  startRefreshLoop();
});

// ── Data fetch ────────────────────────────────────────────────────────────────
async function fetchRaces() {
  try {
    const res  = await fetch(API_ENDPOINT);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.success) throw new Error('API returned success=false');

    render(data);
    updateLastUpdated(data.lastUpdated);
    setMockBadge(data.useMockData);
    updateApiStatus(data.apiStatus);
    fetchAccuracy();
    hideStates();
  } catch (err) {
    console.error('[App] Fetch error:', err);
    showError(err.message);
  }
}

// ── Accuracy ──────────────────────────────────────────────────────────────────
async function fetchAccuracy() {
  try {
    const res = await fetch('/api/accuracy');
    if (!res.ok) return;
    const data = await res.json();
    if (data.success && data.stats) renderAccuracy(data.stats);
  } catch (_) {}
}

function renderAccuracy(s) {
  const panel = document.getElementById('accuracy-panel');
  const cards = document.getElementById('accuracy-cards');
  const meta  = document.getElementById('accuracy-meta');
  if (!panel || !cards) return;

  meta.textContent = `${s.days}-day window · ${s.settledRaces} settled race${s.settledRaces !== 1 ? 's' : ''}`;

  const SOURCE_LABELS = { timeform: 'TF', attheraces: 'ATR', racingpost: 'RP' };
  const SOURCE_ORDER  = ['timeform', 'attheraces', 'racingpost'];

  function makeCard(label, wins, tips, rate, highlight = false) {
    const div = document.createElement('div');
    div.className = 'ac-card' + (highlight ? ' ac-highlight' : '');
    const rateStr = rate != null ? `${rate}%` : '—';
    const countStr = tips > 0 ? `${wins}/${tips}` : 'no data';
    div.innerHTML =
      `<div class="ac-label">${esc(label)}</div>` +
      `<div class="ac-rate">${rateStr}</div>` +
      `<div class="ac-count">${countStr}</div>`;
    return div;
  }

  function makeDivider() {
    const d = document.createElement('div');
    d.className = 'accuracy-divider';
    return d;
  }

  cards.innerHTML = '';

  // Per-source cards
  let hasAnySourceData = false;
  for (const src of SOURCE_ORDER) {
    const s2 = s.bySource?.[src];
    if (!s2) continue;
    hasAnySourceData = true;
    cards.appendChild(makeCard(SOURCE_LABELS[src] || src, s2.wins, s2.tips, s2.rate));
  }

  if (!hasAnySourceData && s.settledRaces === 0) {
    const msg = document.createElement('span');
    msg.className = 'ac-no-data';
    msg.textContent = 'No settled races yet — accuracy data will appear here once races complete.';
    cards.appendChild(msg);
    panel.classList.remove('hidden');
    return;
  }

  if (hasAnySourceData) cards.appendChild(makeDivider());

  // Best Bet card
  if (s.bestBet) {
    cards.appendChild(makeCard('Best Bet', s.bestBet.wins, s.bestBet.tips, s.bestBet.rate, true));
  }

  // EW Outsider card
  if (s.ewOutsider) {
    cards.appendChild(makeCard('EW Win', s.ewOutsider.wins, s.ewOutsider.tips, s.ewOutsider.rate, false));
  }

  panel.classList.remove('hidden');
}

// ── Refresh loop ──────────────────────────────────────────────────────────────
function startRefreshLoop() {
  resetCountdown();
  refreshTimer   = setInterval(onRefreshTick,   REFRESH_INTERVAL * 1000);
  countdownTimer = setInterval(onCountdownTick, 1000);
}

function onRefreshTick() { fetchRaces(); resetCountdown(); }

function onCountdownTick() {
  countdownVal--;
  if (countdownVal < 0) countdownVal = REFRESH_INTERVAL;
  const el = document.getElementById('refresh-countdown');
  if (el) el.textContent = `${countdownVal}s`;
  const bar = document.getElementById('refresh-bar');
  if (bar) bar.style.transform = `scaleX(${countdownVal / REFRESH_INTERVAL})`;
}

function resetCountdown() {
  countdownVal = REFRESH_INTERVAL;
  const el  = document.getElementById('refresh-countdown');
  const bar = document.getElementById('refresh-bar');
  if (el)  el.textContent = `${countdownVal}s`;
  if (bar) bar.style.transform = 'scaleX(1)';
}

// ── Render ────────────────────────────────────────────────────────────────────
function render(data) {
  const container = document.getElementById('races-container');
  const fragment  = document.createDocumentFragment();
  const venues    = data.venues || [];

  if (!venues.length) {
    container.innerHTML = '<div class="state-card"><p>No races found for today.</p></div>';
    return;
  }

  for (const venue of venues) fragment.appendChild(renderVenue(venue));
  container.innerHTML = '';
  container.appendChild(fragment);
}

function renderVenue(venue) {
  const node = document.getElementById('tpl-venue').content.cloneNode(true);
  const el   = node.querySelector('.venue-section');
  el.querySelector('.venue-name').textContent       = venue.name;
  el.querySelector('.venue-race-count').textContent =
    `${venue.races.length} race${venue.races.length !== 1 ? 's' : ''}`;
  const racesEl = el.querySelector('.venue-races');
  for (const race of venue.races) racesEl.appendChild(renderRace(race));
  return el;
}

function renderRace(race) {
  const node = document.getElementById('tpl-race').content.cloneNode(true);
  const el   = node.querySelector('.race-card');
  el.querySelector('.race-time').textContent     = race.time;
  el.querySelector('.race-grade').textContent    = race.grade || '';
  el.querySelector('.race-distance').textContent = race.distance || '';
  const prizeEl = el.querySelector('.race-prize');
  if (race.prize) prizeEl.textContent = race.prize;
  else prizeEl.style.display = 'none';
  const tbody = el.querySelector('.race-runners');
  for (const runner of race.runners) tbody.appendChild(renderRunner(runner));

  // Inject result banner if race is settled
  if (race.result) {
    el.querySelector('.race-header').insertAdjacentHTML('afterend', renderResultBanner(race));
  }

  // Inject trap bias chart between header (or result banner) and table
  const biasHtml = renderTrapBias(race);
  if (biasHtml) {
    el.querySelector('.race-table-wrap').insertAdjacentHTML('beforebegin', biasHtml);
  }

  return el;
}

function renderTrapBias(race) {
  const bias = getTrapBias(race.venue);
  if (!bias) return '';

  const FAIR       = 100 / 6;          // 16.67 %
  const MAX_HEIGHT = 30;               // px for the tallest bar
  const maxPct     = Math.max(...bias);

  const items = bias.map((pct, i) => {
    const trap   = i + 1;
    const height = Math.max(3, Math.round((pct / maxPct) * MAX_HEIGHT));
    const diff   = pct - FAIR;
    const cls    = diff > 2 ? 'tb-strong' : diff < -2 ? 'tb-weak' : 'tb-fair';
    return (
      `<div class="tb-item">` +
        `<div class="tb-pct ${cls}">${pct.toFixed(1)}%</div>` +
        `<div class="tb-bar t${trap}" style="height:${height}px"></div>` +
        `<div class="trap-badge t${trap} tb-trap">${trap}</div>` +
      `</div>`
    );
  }).join('');

  return (
    `<div class="trap-bias-wrap">` +
      `<div class="tb-label">Trap Bias</div>` +
      `<div class="tb-chart">${items}</div>` +
    `</div>`
  );
}

function renderResultBanner(race) {
  const result  = race.result;
  const winner  = race.runners.find(r =>
    (result.winnerSelectionId && r.selectionId === result.winnerSelectionId) ||
    r.name.toLowerCase().replace(/[^a-z0-9]/g, '') === result.winnerNameNorm
  );

  const trapBadge = winner
    ? `<span class="trap-badge t${winner.trap} result-trap">${winner.trap}</span>`
    : '';

  const tippedMark = winner?.isBestBet  ? '<span class="result-flag result-bestbet">⭐ Best Bet won</span>'
                   : winner?.isTipped   ? '<span class="result-flag result-tipped">✓ Tipped</span>'
                   : '';

  const settledTime = result.settledAt
    ? new Date(result.settledAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : '';

  return (
    `<div class="race-result-banner">` +
      `<span class="result-label">RESULT</span>` +
      `${trapBadge}` +
      `<span class="result-winner">${esc(result.winnerName)}</span>` +
      `${tippedMark}` +
      `${settledTime ? `<span class="result-time">${settledTime}</span>` : ''}` +
    `</div>`
  );
}

function renderRunner(r) {
  const tr = document.createElement('tr');
  if (r.isBestBet)     tr.classList.add('is-best-bet');
  else if (r.isTipped) tr.classList.add('is-tipped');

  tr.appendChild(makeTd(renderTrap(r.trap),          'col-trap'));
  tr.appendChild(makeTd(renderDogName(r),            'col-dog'));
  tr.appendChild(makeTd(esc(r.trainer || '—'),       'col-trainer'));
  tr.appendChild(makeTd(renderForm(r.form),          'col-form'));
  tr.appendChild(makeTd(renderExchangeOdds(r),       'col-odds'));
  tr.appendChild(makeTd(renderTips(r),               'col-tips'));
  return tr;
}

// ── Cell renderers ────────────────────────────────────────────────────────────

function renderTrap(trap) {
  return `<span class="trap-badge t${trap}">${trap}</span>`;
}

function renderDogName(r) {
  return `<span class="dog-name">${esc(r.name)}</span>`;
}

function renderForm(form) {
  if (!form) return '<span style="color:var(--text-dim)">—</span>';
  return form.split('').map(ch => {
    if (ch === '1' || ch === 'W') return `<span style="color:#27ae60;font-weight:700">${ch}</span>`;
    if (ch === 'F' || ch === 'U') return `<span style="color:var(--red)">${ch}</span>`;
    if (ch === '-' || ch === '.') return `<span style="color:var(--text-dim)">${ch}</span>`;
    return `<span>${ch}</span>`;
  }).join('');
}

function renderExchangeOdds(r) {
  const curr = r.currentOdds;
  const open = r.openingOdds;
  if (!curr) return '<span style="color:var(--text-dim)">—</span>';

  const diff = curr - (open || curr);
  let cls = 'stable', dir = '', dirCls = '';

  if (open && Math.abs(diff) >= 0.05) {
    if (diff > 0) { cls = 'drifted';   dir = `▲ ${diff.toFixed(2)}`;         dirCls = 'up'; }
    else          { cls = 'shortened'; dir = `▼ ${Math.abs(diff).toFixed(2)}`; dirCls = 'down'; }
  }

  return `
    <div class="odds-wrap">
      <span class="odds-current ${cls}">${curr.toFixed(2)}</span>
      ${open ? `<span class="odds-open">mkt: ${open.toFixed(2)}</span>` : ''}
      ${dir  ? `<span class="odds-direction ${dirCls}">${dir}</span>` : ''}
    </div>`;
}

function renderBookieOdds(r) {
  const best = r.bestBookmakerOdds;
  if (!best) return '<span style="color:var(--text-dim)">—</span>';

  const exchBetter = r.currentOdds && r.currentOdds > best.price;
  const pill       = exchBetter
    ? '<span class="exch-better-pill">BFX&nbsp;better</span>'
    : '';

  return `
    <div class="bookie-wrap">
      <span class="bookie-price">${best.price.toFixed(2)}</span>
      <span class="bookie-name">${esc(best.bookmakerName)}</span>
      ${pill}
    </div>`;
}

function renderTips(r) {
  const parts = [];
  if (r.isBestBet)         parts.push('<span class="badge badge-bestbet">⭐ Best Bet</span>');
  else if (r.isTipped)     parts.push(`<span class="badge badge-tipped">✓ Tipped ×${r.tipsCount}</span>`);
  if (r.isEachWayOutsider) parts.push('<span class="badge badge-ew">EW Outsider</span>');

  // Per-source position pills (replace plain source badge)
  if (r.tipPositions && Object.keys(r.tipPositions).length) {
    const pills = Object.entries(r.tipPositions)
      .map(([src, pos]) =>
        `<span class="pos-pill"><span class="pos-src">${esc(sourceLabel(src))}</span>` +
        `<span class="pos-ord pos-${pos}">${ordinal(pos)}</span></span>`
      ).join('');
    parts.push(`<div class="tip-positions">${pills}</div>`);
  } else if (r.tipSources && r.tipSources.length) {
    // Fallback: no position data, just show source labels
    parts.push(`<span class="badge badge-source">${r.tipSources.map(sourceLabel).join(', ')}</span>`);
  }

  return parts.length
    ? `<div class="badges">${parts.join('')}</div>`
    : '<span style="color:var(--text-dim)">—</span>';
}

// ── API status indicators ─────────────────────────────────────────────────────

function updateApiStatus(apiStatus) {
  if (!apiStatus) return;
  setStatusIndicator('status-scraper', apiStatus.scraper);
  setStatusIndicator('status-betfair', apiStatus.betfair);
  setStatusIndicator('status-oddsapi', apiStatus.oddsApi);
}

function setStatusIndicator(elId, status) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.classList.remove('connected', 'error');
  if (!status) return;
  if (status.connected)            el.classList.add('connected');
  else if (status.lastError)       el.classList.add('error');
  // If neither → grey (not configured), no class added

  // Build tooltip
  const lines = [];
  if (status.lastSuccess)       lines.push(`Last OK: ${fmtTime(status.lastSuccess)}`);
  if (status.lastError)         lines.push(`Error: ${status.lastError}`);
  if (status.remainingRequests != null) lines.push(`Quota left: ${status.remainingRequests}`);
  el.title = lines.join('\n') || el.title;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sourceLabel(src) {
  return { timeform: 'TF', attheraces: 'ATR', racingpost: 'RP' }[src] || src;
}

function ordinal(n) {
  return n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;
}

function makeTd(html, cls) {
  const td = document.createElement('td');
  td.className = cls || '';
  td.innerHTML = html;
  return td;
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-GB',
    { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function hideStates() {
  document.getElementById('loading').classList.add('hidden');
  document.getElementById('error').classList.add('hidden');
}

function showError(msg) {
  document.getElementById('loading').classList.add('hidden');
  document.getElementById('error').classList.remove('hidden');
  document.getElementById('error-msg').textContent = msg || 'Could not load race data.';
}

function updateLastUpdated(iso) {
  const el = document.getElementById('last-updated');
  if (!el || !iso) return;
  el.textContent = `Updated ${fmtTime(iso)}`;
}

function setMockBadge(isMock) {
  document.getElementById('mock-badge')?.classList.toggle('hidden', !isMock);
}
