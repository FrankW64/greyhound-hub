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
  startClock();
});

// ── Live clock ────────────────────────────────────────────────────────────────
function startClock() {
  const el = document.getElementById('live-clock');
  if (!el) return;
  function tick() {
    const now = new Date();
    const date = now.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    el.textContent = `${date}  ${time}`;
  }
  tick();
  setInterval(tick, 1000);
}

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

  const SOURCE_LABELS = { timeform: 'Timeform', racingpost: 'Racing Post', olbg: 'OLBG', everytip: 'EveryTip', algorithm: 'Algorithm' };
  const SOURCE_ORDER  = ['algorithm', 'timeform', 'racingpost', 'everytip', 'olbg'];

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

  // Always render all known sources even if no settled data yet
  for (const src of SOURCE_ORDER) {
    const s2   = s.bySource?.[src];
    const wins = s2?.wins ?? 0, tips = s2?.tips ?? 0, rate = s2?.rate ?? null;
    cards.appendChild(makeCard(SOURCE_LABELS[src] || src, wins, tips, rate));
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

// ── Tab state ─────────────────────────────────────────────────────────────────
let activeTab = 'upcoming';

function setTab(tab) {
  activeTab = tab;
  document.getElementById('tab-btn-upcoming')?.classList.toggle('tab-btn-active', tab === 'upcoming');
  document.getElementById('tab-btn-results')?.classList.toggle('tab-btn-active',  tab === 'results');
  document.getElementById('tab-upcoming')?.classList.toggle('hidden', tab !== 'upcoming');
  document.getElementById('tab-results')?.classList.toggle('hidden',  tab !== 'results');
}

// ── Sort mode ─────────────────────────────────────────────────────────────────
let sortMode       = 'venue';
let lastRenderData = null;
let hideFinished   = false;

function setSortMode(mode) {
  sortMode = mode;
  document.getElementById('sort-btn-venue')?.classList.toggle('sort-btn-active', mode === 'venue');
  document.getElementById('sort-btn-time')?.classList.toggle('sort-btn-active', mode === 'time');
  if (lastRenderData) render(lastRenderData);
}

function toggleHideFinished() {
  hideFinished = !hideFinished;
  document.getElementById('hide-finished-btn')?.classList.toggle('sort-btn-active', hideFinished);
  if (lastRenderData) render(lastRenderData);
}

// ── Render ────────────────────────────────────────────────────────────────────
function render(data) {
  lastRenderData = data;
  const container = document.getElementById('races-container');
  const fragment  = document.createDocumentFragment();
  const venues    = data.venues || [];

  if (!venues.length) {
    container.innerHTML = '<div class="state-card"><p>No races found for today.</p></div>';
    return;
  }

  // Apply hide-finished filter
  const filteredVenues = hideFinished
    ? venues.map(v => ({ ...v, races: v.races.filter(r => !r.result) })).filter(v => v.races.length)
    : venues;

  if (sortMode === 'time') {
    // Flatten all races across all venues, sort by time
    const allRaces = filteredVenues.flatMap(v => v.races.map(r => ({ ...r, venue: r.venue || v.name })));
    allRaces.sort((a, b) => a.time.localeCompare(b.time));
    const grid = document.createElement('div');
    grid.className = 'venue-races';
    for (const race of allRaces) grid.appendChild(renderRace(race, true));
    fragment.appendChild(grid);
  } else {
    for (const venue of filteredVenues) fragment.appendChild(renderVenue(venue));
  }

  container.innerHTML = '';
  container.appendChild(fragment);

  renderResultsTab(data);
}

// ── Results tab ───────────────────────────────────────────────────────────────
function renderResultsTab(data) {
  const container = document.getElementById('results-container');
  if (!container) return;

  const venues = data.venues || [];

  // Collect all settled races across all venues
  const settledRaces = [];
  for (const venue of venues) {
    for (const race of venue.races) {
      if (race.result) settledRaces.push({ ...race, venue: race.venue || venue.name });
    }
  }

  // Update tab count badge
  const countEl = document.getElementById('results-count');
  if (countEl) countEl.textContent = settledRaces.length || '';

  if (!settledRaces.length) {
    container.innerHTML = '<div class="state-card"><p>No results yet today — check back as races settle.</p></div>';
    return;
  }

  // Sort by time descending (most recent first)
  settledRaces.sort((a, b) => b.time.localeCompare(a.time));

  const fragment = document.createDocumentFragment();

  for (const race of settledRaces) {
    const result = race.result;
    const winner = race.runners.find(r =>
      (result.winnerSelectionId && r.selectionId === result.winnerSelectionId) ||
      r.name.toLowerCase().replace(/[^a-z0-9]/g, '') === result.winnerNameNorm
    );

    const anyTipped  = race.runners.some(r => r.isBestBet || r.isTipped);
    const tipHit     = winner?.isBestBet || winner?.isTipped;
    const outcomeClass = winner?.isBestBet ? 'ro-bestbet'
                       : tipHit           ? 'ro-hit'
                       : anyTipped        ? 'ro-miss'
                       : 'ro-none';
    const outcomeLabel = winner?.isBestBet ? '⭐ Best Bet won'
                       : tipHit           ? '✓ Tip won'
                       : anyTipped        ? '✗ Tip missed'
                       : '';

    const trapBadge = winner
      ? `<span class="trap-badge t${winner.trap} result-trap">${winner.trap}</span>`
      : '';

    const settledTime = result.settledAt
      ? new Date(result.settledAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      : '';

    // Build tipped dogs summary
    const tippedDogs = race.runners
      .filter(r => r.isBestBet || r.isTipped)
      .map(r => {
        const badge = r.isBestBet
          ? `<span class="badge badge-bestbet" style="font-size:0.6rem;padding:1px 5px">⭐</span>`
          : `<span class="badge badge-tipped badge-tipped-${Math.min(r.winTipCount,4)}" style="font-size:0.6rem;padding:1px 5px">×${r.winTipCount}</span>`;
        return `<span class="ro-tipped-dog">${esc(r.name)} ${badge}</span>`;
      }).join('');

    const card = document.createElement('div');
    card.className = `results-race-card ${outcomeClass}`;
    card.innerHTML =
      `<div class="ro-header">` +
        `<span class="ro-venue">${esc(race.venue)}</span>` +
        `<span class="ro-time">${esc(race.time)}</span>` +
        `<span class="ro-grade">${esc(race.grade || '')}</span>` +
        `${settledTime ? `<span class="ro-settled">settled ${settledTime}</span>` : ''}` +
      `</div>` +
      `<div class="ro-result">` +
        `<span class="ro-label">WINNER</span>` +
        `${trapBadge}` +
        `<span class="ro-winner-name">${esc(result.winnerName)}</span>` +
        `${outcomeLabel ? `<span class="ro-outcome ${outcomeClass}-tag">${outcomeLabel}</span>` : ''}` +
      `</div>` +
      `${tippedDogs ? `<div class="ro-tipped">Tipped: ${tippedDogs}</div>` : ''}`;

    fragment.appendChild(card);
  }

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

function renderRace(race, showVenue = false) {
  const node = document.getElementById('tpl-race').content.cloneNode(true);
  const el   = node.querySelector('.race-card');
  el.querySelector('.race-time').textContent     = race.time;
  const venueLabelEl = el.querySelector('.race-venue-label');
  if (showVenue && race.venue) {
    venueLabelEl.textContent = race.venue;
  } else {
    venueLabelEl.style.display = 'none';
  }
  el.querySelector('.race-grade').textContent    = race.grade || '';
  el.querySelector('.race-distance').textContent = race.distance || '';
  const prizeEl = el.querySelector('.race-prize');
  if (race.prize) prizeEl.textContent = race.prize;
  else prizeEl.style.display = 'none';
  const tbody = el.querySelector('.race-runners');
  for (const runner of race.runners) tbody.appendChild(renderRunner(runner, race.result));

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

  const anyTipped = race.runners.some(r => r.isBestBet || r.isTipped);
  const tippedMark = winner?.isBestBet  ? '<span class="result-flag result-bestbet">⭐ Best Bet won</span>'
                   : winner?.isTipped   ? '<span class="result-flag result-tipped">✓ Tipped won</span>'
                   : anyTipped          ? '<span class="result-flag result-missed">✗ Tip missed</span>'
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

function renderRunner(r, result) {
  const tr = document.createElement('tr');

  // Determine if this runner is the winner
  const isWinner = result && (
    (result.winnerSelectionId && r.selectionId === result.winnerSelectionId) ||
    r.name.toLowerCase().replace(/[^a-z0-9]/g, '') === result.winnerNameNorm
  );

  if (isWinner) {
    tr.classList.add('is-race-winner');
  } else if (result) {
    tr.classList.add('is-race-loser');
  } else if (r.isBestBet) {
    tr.classList.add('is-best-bet');
  } else if (r.isTipped) {
    tr.classList.add('is-tipped');
  }

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
  const stars = r.starRating
    ? `<span class="star-rating" title="Timeform rating: ${r.starRating}/5">` +
      `<span class="stars-filled">${'★'.repeat(r.starRating)}</span>` +
      `<span class="stars-empty">${'★'.repeat(5 - r.starRating)}</span>` +
      `</span>`
    : '';
  return `<span class="dog-name">${esc(r.name)}</span>${stars}`;
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
  else if (r.isTipped)     parts.push(`<span class="badge badge-tipped badge-tipped-${Math.min(r.winTipCount, 4)}">✓ Tipped ×${r.winTipCount}</span>`);
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
