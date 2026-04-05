'use strict';

/**
 * Race card scraper — fetches today's UK greyhound race cards.
 *
 * Sources (tried in order):
 *   1. Timeform  — https://www.timeform.com/greyhound-racing/racecards
 *      Full race cards with all 6 runners, trap images, dog name links,
 *      trainer text. Server-side rendered HTML — no JS required.
 *
 *   2. GBGB API  — http://api.gbgb.org.uk/api/results?raceDate=TODAY
 *      Returns settled results for today (only after races run).
 *      Used as a supplementary source for results tracking, not pre-race cards.
 *
 * Returns an array of race objects:
 *   { id, venue, time, date, distance, grade, prize, runners[] }
 *
 * Each runner:
 *   { trap, name, trainer, form, openingOdds: null, currentOdds: null }
 */

const axios   = require('axios');
const cheerio = require('cheerio');

// ── HTTP config ───────────────────────────────────────────────────────────────

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,*/*',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Cache-Control':   'no-cache',
};

async function fetchHtml(url) {
  const { data } = await axios.get(url, {
    headers:      HEADERS,
    timeout:      15000,
    maxRedirects: 5,
  });
  return data;
}

async function fetchJson(url) {
  const { data } = await axios.get(url, {
    headers: { ...HEADERS, 'Accept': 'application/json' },
    timeout: 10000,
  });
  return data;
}

// ── Source 1: Timeform race card listing ──────────────────────────────────────
//
// Page structure (server-side rendered):
//   Venues appear as headings; each race links to its full card at:
//     /greyhound-racing/racecards/[venue]/[HHMM]/[YYYY-MM-DD]/[raceId]
//   Individual race card pages contain a runners table with:
//     - Trap:    <img src="...trap-X.png">
//     - Dog:     <a href="/greyhound-racing/greyhound-form/...">Name</a>
//     - Trainer: plain text in table cell
//     - Form:    plain text (row header or cell), e.g. "2TTT4"

async function scrapeTimeformCards() {
  const races = [];
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  try {
    const listHtml = await fetchHtml('https://www.timeform.com/greyhound-racing/racecards');
    const $list    = cheerio.load(listHtml);

    // ── Step 1: collect all race card URLs from the listing page ─────────────
    // URL pattern: /greyhound-racing/racecards/[venue-slug]/[HHMM]/[date]/[id]
    const raceLinks = [];
    $list('a[href*="/greyhound-racing/racecards/"]').each((_, el) => {
      const href  = $list(el).attr('href') || '';
      // Match: /greyhound-racing/racecards/venue/HHMM/YYYY-MM-DD/id
      const match = href.match(
        /\/greyhound-racing\/racecards\/([^/]+)\/(\d{3,4})\/(\d{4}-\d{2}-\d{2})\/(\d+)/
      );
      if (!match) return;
      const [, venueSlug, timePart, date, raceId] = match;
      if (date !== today) return; // only today's cards

      const time = `${timePart.padStart(4, '0').slice(0, 2)}:${timePart.padStart(4, '0').slice(2)}`;
      const venue = slugToVenue(venueSlug);
      if (!venue) return;

      const fullUrl = `https://www.timeform.com${href}`;
      // Deduplicate by raceId
      if (!raceLinks.find(r => r.raceId === raceId)) {
        raceLinks.push({ url: fullUrl, venue, time, date, raceId });
      }
    });

    // ── Step 2: also try to parse races directly from the listing page ───────
    // The listing page often includes runner-level data in expandable sections
    const listingRaces = parseTimeformListing($list, today);
    for (const r of listingRaces) {
      if (!races.find(x => x.id === r.id)) races.push(r);
    }

    console.log(`[RacecardScraper] Timeform listing: ${raceLinks.length} race links, ${listingRaces.length} from inline parse`);

    // ── Step 3: fetch individual race card pages for any races not yet parsed ─
    // Limit concurrent fetches to avoid hammering the server
    const missing = raceLinks.filter(l => !races.find(r => r.id === `TF-${l.raceId}`));
    const BATCH   = 4;

    for (let i = 0; i < missing.length; i += BATCH) {
      const batch = missing.slice(i, i + BATCH);
      const fetched = await Promise.allSettled(
        batch.map(link => fetchTimeformRace(link))
      );
      for (const result of fetched) {
        if (result.status === 'fulfilled' && result.value) {
          races.push(result.value);
        }
      }
      // Small polite delay between batches
      if (i + BATCH < missing.length) {
        await new Promise(r => setTimeout(r, 300));
      }
    }

    console.log(`[RacecardScraper] Timeform total: ${races.length} races`);
  } catch (err) {
    console.warn(`[RacecardScraper] Timeform failed: ${err.message}`);
  }

  return races;
}

/**
 * Parse race and runner data that Timeform sometimes embeds inline
 * in the main listing page (expandable race sections).
 */
function parseTimeformListing($, today) {
  const races = [];

  // Timeform groups races by venue in labelled sections
  // Strategy: look for any element that contains a trap image, dog link, and is
  // inside a block that also has a time link matching the race URL pattern
  $('a[href*="/greyhound-racing/racecards/"]').each((_, linkEl) => {
    const href  = $(linkEl).attr('href') || '';
    const match = href.match(
      /\/greyhound-racing\/racecards\/([^/]+)\/(\d{3,4})\/(\d{4}-\d{2}-\d{2})\/(\d+)/
    );
    if (!match) return;
    const [, venueSlug, timePart, date, raceId] = match;
    if (date !== today) return;

    const time  = `${timePart.padStart(4, '0').slice(0, 2)}:${timePart.padStart(4, '0').slice(2)}`;
    const venue = slugToVenue(venueSlug);
    if (!venue) return;

    // Look for runner rows within the same parent block as this link
    const container = $(linkEl).closest('section, article, div[class], li').first();
    if (!container.length) return;

    const runners = parseRunnerBlock($, container);
    if (runners.length < 2) return;

    const raceText = container.text();
    const race = {
      id:       `TF-${raceId}`,
      venue,
      time,
      date,
      distance: extractDistance(raceText),
      grade:    extractGrade(raceText),
      prize:    extractPrize(raceText),
      runners,
    };

    if (!races.find(r => r.id === race.id)) races.push(race);
  });

  return races;
}

/**
 * Fetch a single Timeform race card page and parse its runners + analyst verdict.
 */
async function fetchTimeformRace({ url, venue, time, date, raceId }) {
  try {
    const html = await fetchHtml(url);
    const $    = cheerio.load(html);

    // Get distance / grade / prize from page header
    const headerText = $('h1, [class*="racecard-header"], [class*="race-header"], [class*="race-title"]')
      .first().text();
    const pageText   = $('body').text();

    const runners     = parseRunnerBlock($, $('body'));
    if (runners.length < 2) return null;

    const verdictTips = parseAnalystVerdict($, runners);

    return {
      id:       `TF-${raceId}`,
      venue,
      time,
      date,
      distance: extractDistance(headerText) || extractDistance(pageText),
      grade:    extractGrade(headerText)    || extractGrade(pageText),
      prize:    extractPrize(headerText)    || extractPrize(pageText),
      runners,
      verdictTips,
    };
  } catch (err) {
    console.warn(`[RacecardScraper] Timeform race ${raceId} failed: ${err.message}`);
    return null;
  }
}

/**
 * Parse the Analyst Verdict section from a Timeform racecard page.
 *
 * Structure:
 *   <h3>Analyst Verdict</h3>
 *   <div class="rpf-verdict ...">
 *     <div class="rpf-verdict-container">
 *       <div class="rpf-verdict-selection">
 *         <b class="rpf-verdict-selection-prediction">2.</b>
 *         <img class="rpf-verdict-selection-trap" alt="6">
 *         <div class="rpf-verdict-selection-name"><a>TRICKYS MATILDA</a></div>
 *       </div>
 *       <!-- 3rd pick similarly -->
 *     </div>
 *     <div class="rpf-verdict-text-container">...Be My Lass just about edges it...</div>
 *   </div>
 *
 * 2nd and 3rd picks are in structured divs with position labels.
 * 1st pick is mentioned by name in the verdict text — find it by matching runner names.
 *
 * Returns: [{ position, trap, dogName }]
 */
function parseAnalystVerdict($, runners) {
  const tips       = [];
  const pickedNorm = new Set();

  // Extract all structured picks (1st, 2nd, 3rd) from verdict selection elements
  $('.rpf-verdict-selection').each((_, el) => {
    const predText = $(el).find('b.rpf-verdict-selection-prediction').text().trim();
    const position = parseInt(predText, 10);
    if (!position) return;

    const trap    = parseInt($(el).find('img.rpf-verdict-selection-trap').attr('alt') || '0', 10) || null;
    const dogName = normalise($(el).find('.rpf-verdict-selection-name a').text());
    if (!dogName) return;

    tips.push({ position, trap, dogName });
    pickedNorm.add(dogName.toLowerCase().replace(/[^a-z0-9]/g, ''));
  });

  // Fallback: find 1st pick from verdict text if not found in structured elements
  const hasFirst = tips.some(t => t.position === 1);
  if (!hasFirst) {
    const verdictText = ($('.rpf-verdict').text() || '').toLowerCase();
    if (verdictText && runners.length) {
      for (const runner of runners) {
        const norm = runner.name.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (pickedNorm.has(norm)) continue;
        if (verdictText.includes(runner.name.toLowerCase())) {
          tips.push({ position: 1, trap: runner.trap, dogName: runner.name });
          break;
        }
      }
    }
  }

  return tips;
}

/**
 * Parse runner rows from a Cheerio container using Timeform's confirmed structure.
 *
 * Each runner spans TWO consecutive <tr> rows:
 *   Row 1 (class "rpb-entry-details"):
 *     - td.rpb-entry-details-trap  → <img class="rpb-trap"> + <span title="previous 5...">FORM</span>
 *     - td                         → <a class="rpb-greyhound">DOG NAME</a>
 *     - td                         → (empty or hidden cols)
 *   Row 2 (next sibling <tr>):
 *     - td → <span title="...trainer...">TRAINER (XX.XX%)</span>
 *     - td → <span title="...gender...">bk d Aug20</span>
 *     - td → star rating images: <img src="...star-blue.png"> / <img src="...star-grey.png">
 */
function parseRunnerBlock($, container) {
  const runners = [];
  const seen    = new Set();

  // Target the first-row of each runner pair using the confirmed class name
  container.find('tr.rpb-entry-details, tr[class^="rpb-entry-details"]').each((_, tr) => {
    const row = $(tr);

    // ── Trap number ──────────────────────────────────────────────────────────
    // From img alt attribute (most reliable) or src filename
    const trapImg = row.find('img.rpb-trap, img[src*="trap-"]').first();
    const trap    = parseInt(trapImg.attr('alt') || '', 10) ||
                    parseInt((trapImg.attr('src') || '').match(/trap-(\d)/)?.[1] || '0', 10);
    if (!trap || trap < 1 || trap > 6) return;

    // ── Form string ──────────────────────────────────────────────────────────
    // In the span inside the trap cell, titled "previous 5 finishing positions"
    const form = normalise(
      row.find('span[title*="previous 5"], span[title*="finishing positions"]').first().text()
    );

    // ── Dog name ─────────────────────────────────────────────────────────────
    const name = normalise(
      row.find('a.rpb-greyhound, a[class*="rpb-greyhound"]').first().text()
    );
    if (!name || name.length < 3) return;
    if (seen.has(name.toLowerCase())) return;
    seen.add(name.toLowerCase());

    // ── Trainer + star rating ────────────────────────────────────────────────
    // These live in the NEXT sibling <tr> (second row of the runner pair)
    const nextRow  = row.next('tr');          // row 2: trainer, gender, seed
    const starRow  = nextRow.next('tr');      // row 3: nested table with star rating + comment

    const trainerRaw = normalise(
      nextRow.find('span[title*="trainer"], span[title*="Trainer"]').first().text()
    );
    // Strip the 21-day strike rate "(27.77%)" appended by Timeform
    const trainer = trainerRaw.replace(/\s*\(\d+(\.\d+)?%\)\s*$/, '').trim();

    // Stars live in td.rpb-star-rating inside a nested table in row 3
    const blueStars = starRow.find('td.rpb-star-rating img[src*="star-blue"], img.rpb-star[src*="star-blue"]').length;
    const starRating = blueStars > 0 ? blueStars : null;

    // Timeform numeric master rating (rpb-final-rating div in row 1)
    const tfRating = parseInt(
      row.find('div.rpb-final-rating').first().text().trim(), 10
    ) || null;

    runners.push({ trap, name, trainer, form, starRating, tfRating, openingOdds: null, currentOdds: null });
  });

  // Fallback: original trap-image approach if no rpb-entry-details rows found
  if (!runners.length) {
    container.find('img[src*="trap-"]').each((_, img) => {
      const trap = parseInt($(img).attr('alt') || '', 10) ||
                   parseInt(($(img).attr('src') || '').match(/trap-(\d)/)?.[1] || '0', 10);
      if (!trap || trap < 1 || trap > 6) return;

      const row  = $(img).closest('tr').first();
      const name = normalise(row.find('a[href*="greyhound-form"]').first().text());
      if (!name || name.length < 3 || seen.has(name.toLowerCase())) return;
      seen.add(name.toLowerCase());

      const nextRow    = row.next('tr');
      const starRow    = nextRow.next('tr');
      const trainerRaw = normalise(nextRow.find('span[title*="trainer"]').first().text());
      const trainer    = trainerRaw.replace(/\s*\(\d+(\.\d+)?%\)\s*$/, '').trim();
      const form       = normalise(row.find('span[title*="previous 5"]').first().text());
      const blueStars  = starRow.find('td.rpb-star-rating img[src*="star-blue"], img.rpb-star[src*="star-blue"]').length;

      runners.push({ trap, name, trainer, form, starRating: blueStars || null, openingOdds: null, currentOdds: null });
    });
  }

  runners.sort((a, b) => a.trap - b.trap);
  return runners;
}

// ── Source 2: GBGB API — today's results (for results tracker) ────────────────
//
// Note: this returns settled races only (after they've run).
// It is NOT a race card source — it's used to get today's results.

async function fetchGBGBResults(date) {
  const results = [];
  try {
    // GBGB date format: MM/DD/YYYY in response but filter uses YYYY-MM-DD
    const today = date || new Date().toISOString().split('T')[0];
    const url   = `http://api.gbgb.org.uk/api/results?raceDate=${today}&pageSize=200`;
    const data  = await fetchJson(url);

    for (const item of (data.items || [])) {
      if (item.resultPosition !== 1) continue; // only winners
      results.push({
        raceId:    String(item.raceId),
        meetingId: String(item.meetingId),
        venue:     item.trackName,
        time:      formatTime(item.raceTime),
        date:      parseGBGBDate(item.raceDate),
        grade:     item.raceClass,
        distance:  item.raceDistance ? `${item.raceDistance}m` : '',
        winner: {
          trap:    parseInt(item.trapNumber, 10),
          name:    item.dogName,
          trainer: item.trainerName,
        },
      });
    }
    console.log(`[RacecardScraper] GBGB API: ${results.length} settled results for ${today}`);
  } catch (err) {
    console.warn(`[RacecardScraper] GBGB API failed: ${err.message}`);
  }
  return results;
}

// ── Aggregator ────────────────────────────────────────────────────────────────

async function fetchRaceCards() {
  // Primary source: Timeform
  const races = await scrapeTimeformCards();

  if (races.length > 0) {
    return deduplicateRaces(races);
  }

  // If Timeform returns nothing (e.g. late at night, off-season), return empty
  // The DataManager will keep the last known race set
  console.warn('[RacecardScraper] No races found from any source');
  return [];
}

/**
 * Fetch today's settled results from GBGB API.
 * Used by DataManager for results tracking — separate from race cards.
 */
async function fetchTodaysResults() {
  const today = new Date().toISOString().split('T')[0];
  return fetchGBGBResults(today);
}

// ── Venue slug mapping ────────────────────────────────────────────────────────

// Timeform URL slugs → display names
const SLUG_TO_VENUE = {
  'romford':        'Romford',
  'hove':           'Hove',
  'belle-vue':      'Belle Vue',
  'nottingham':     'Nottingham',
  'swindon':        'Swindon',
  'monmore':        'Monmore',
  'oxford':         'Oxford',
  'perry-barr':     'Perry Barr',
  'poole':          'Poole',
  'sheffield':      'Sheffield',
  'towcester':      'Towcester',
  'newcastle':      'Newcastle',
  'doncaster':      'Doncaster',
  'yarmouth':       'Yarmouth',
  'kinsley':        'Kinsley',
  'coventry':       'Coventry',
  'henlow':         'Henlow',
  'peterborough':   'Peterborough',
  'harlow':         'Harlow',
  'crayford':       'Crayford',
  'wimbledon':      'Wimbledon',
  'central-park':   'Central Park',
  'dunstall-park':  'Dunstall Park',
  'pelaw-grange':   'Pelaw Grange',
  'suffolk-downs':  'Suffolk Downs',
  'the-valley':     'The Valley',
  'valley':         'The Valley',
  'sunderland':     'Sunderland',
};

function slugToVenue(slug) {
  return SLUG_TO_VENUE[slug.toLowerCase()] || '';
}

// ── Text helpers ──────────────────────────────────────────────────────────────

function normalise(str) {
  return (str || '').replace(/\s+/g, ' ').trim();
}

function formatTime(timeStr) {
  // GBGB returns "HH:MM:SS"
  const m = (timeStr || '').match(/(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : '';
}

function parseGBGBDate(dateStr) {
  // GBGB returns "MM/DD/YYYY"
  const m = (dateStr || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : dateStr;
}

function extractDistance(text) {
  const m = (text || '').match(/\b(\d{3,4})\s*m\b/i);
  return m ? `${m[1]}m` : '';
}

function extractGrade(text) {
  const m = (text || '').match(/\b([ASOHaosh]\d{1,2}|OR|S|H)\b/);
  return m ? m[1].toUpperCase() : '';
}

function extractPrize(text) {
  const m = (text || '').match(/£[\d,]+/);
  return m ? m[0] : '';
}

function looksLikeDogName(str) {
  return /^[A-Z][a-z]+(\s[A-Z][a-z]+)+$/.test(str) && str.length > 4 && str.length < 50;
}

// ── Deduplication + sorting ───────────────────────────────────────────────────

function deduplicateRaces(races) {
  const seen = new Map();
  for (const race of races) {
    const key = `${race.venue}-${race.time}`;
    if (!seen.has(key) || race.runners.length > seen.get(key).runners.length) {
      seen.set(key, race);
    }
  }
  return [...seen.values()].sort((a, b) => {
    const vc = a.venue.localeCompare(b.venue);
    return vc !== 0 ? vc : a.time.localeCompare(b.time);
  });
}

module.exports = { fetchRaceCards, fetchTodaysResults };
