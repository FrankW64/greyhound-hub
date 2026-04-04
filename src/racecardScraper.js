'use strict';

/**
 * Race card scraper — fetches today's UK greyhound race cards from public sources.
 *
 * Returns an array of race objects in the same shape as mock data:
 *   { id, venue, time, date, distance, grade, prize, runners[] }
 *
 * Each runner:
 *   { trap, name, trainer, form, openingOdds: null, currentOdds: null }
 *
 * Sources tried in order (first with ≥3 races wins):
 *   1. GBGB.org.uk — official UK governing body
 *   2. TheGreyhoundRecorder.co.uk — independent race cards
 *   3. RacingPost.com/greyhounds/cards — Next.js JSON blob fallback
 */

const axios   = require('axios');
const cheerio = require('cheerio');

// ── Shared HTTP config ────────────────────────────────────────────────────────

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

// ── Source 1: GBGB.org.uk ─────────────────────────────────────────────────────

async function scrapeGBGB() {
  const races = [];
  const today = new Date().toISOString().split('T')[0];

  try {
    const url  = `https://www.gbgb.org.uk/race-cards/?date=${today}`;
    const html = await fetchHtml(url);
    const $    = cheerio.load(html);

    // Strategy 1 — structured meeting/race containers
    $('[class*="meeting"], [class*="race-meeting"], [class*="racecard-meeting"]').each((_, meetingEl) => {
      const meeting   = $(meetingEl);
      const venueText = normalise(
        meeting.find('[class*="venue"], [class*="meeting-name"], [class*="location"], h2, h3').first().text()
      );
      const venue = matchVenue(venueText);
      if (!venue) return;

      meeting.find('[class*="race-card__race"], [class*="race-row"], [class*="racecard-race"]').each((_, raceEl) => {
        const raceDiv = $(raceEl);
        const time    = extractTime(
          raceDiv.find('[class*="time"], [class*="race-time"]').first().text() || raceDiv.text()
        );
        if (!time) return;

        const race = buildRaceShell(venue, time, today, raceDiv);

        raceDiv.find('[class*="runner"], tr').each((_, runnerEl) => {
          const runner = parseRunnerRow($(runnerEl));
          if (runner) race.runners.push(runner);
        });

        if (race.runners.length >= 2) races.push(race);
      });
    });

    // Strategy 2 — flat table rows with venue/time headers
    if (!races.length) {
      let currentVenue = '';
      let currentRace  = null;

      $('table tbody tr, [class*="card-row"]').each((_, el) => {
        const row  = $(el);
        const text = row.text();

        // Venue header row (usually a single colspan cell)
        const detectedVenue = matchVenue(text);
        if (detectedVenue && row.find('td').length <= 2) {
          if (currentRace && currentRace.runners.length >= 2) races.push(currentRace);
          currentVenue = detectedVenue;
          currentRace  = null;
          return;
        }

        // Race header row (contains a time)
        const time = extractTime(text);
        if (time && currentVenue) {
          if (currentRace && currentRace.runners.length >= 2) races.push(currentRace);
          currentRace = buildRaceShell(currentVenue, time, today, row);
          return;
        }

        // Runner row
        if (currentRace) {
          const runner = parseRunnerCells(row.find('td'));
          if (runner) currentRace.runners.push(runner);
        }
      });

      if (currentRace && currentRace.runners.length >= 2) races.push(currentRace);
    }

    // Strategy 3 — embedded JSON (some GBGB pages use script data)
    if (!races.length) {
      $('script').each((_, el) => {
        const content = $(el).html() || '';
        if (!content.includes('raceCard') && !content.includes('runners')) return;
        try {
          // Look for JSON arrays/objects in script blocks
          const match = content.match(/(?:var|const|let)\s+\w+\s*=\s*(\[[\s\S]*?\]);/) ||
                        content.match(/(?:var|const|let)\s+\w+\s*=\s*(\{[\s\S]*?\});/);
          if (match) {
            const json     = JSON.parse(match[1]);
            const extracted = extractRacesFromJson(json, today);
            races.push(...extracted);
          }
        } catch (_) {}
      });
    }

    console.log(`[RacecardScraper] GBGB: found ${races.length} races`);
  } catch (err) {
    console.warn(`[RacecardScraper] GBGB failed: ${err.message}`);
  }

  return races;
}

// ── Source 2: TheGreyhoundRecorder.co.uk ─────────────────────────────────────

async function scrapeGreyhoundRecorder() {
  const races = [];
  const today = new Date().toISOString().split('T')[0];

  try {
    const html = await fetchHtml('https://www.thegreyhoundrecorder.co.uk/race-cards/');
    const $    = cheerio.load(html);

    $('[class*="meeting"], [class*="venue-block"], .race-meeting, [class*="racecards-meeting"]').each((_, meetingEl) => {
      const meeting   = $(meetingEl);
      const venueText = normalise(
        meeting.find('h2, h3, [class*="venue"], [class*="meeting-title"], [class*="meeting-name"]').first().text()
      );
      const venue = matchVenue(venueText);
      if (!venue) return;

      meeting.find('[class*="race"], [class*="race-row"], [class*="racecard-race"]').each((_, raceEl) => {
        const raceDiv = $(raceEl);
        const time    = extractTime(
          raceDiv.find('[class*="time"], [class*="race-time"]').first().text() || raceDiv.text()
        );
        if (!time) return;

        const race = buildRaceShell(venue, time, today, raceDiv);

        raceDiv.find('tr, [class*="runner"]').each((_, runnerEl) => {
          const r      = $(runnerEl);
          const cells  = r.find('td');
          const runner = cells.length >= 2
            ? parseRunnerCells(cells)
            : parseRunnerRow(r);
          if (runner) race.runners.push(runner);
        });

        if (race.runners.length >= 2) races.push(race);
      });
    });

    // Fallback: look for any standard race-card tables
    if (!races.length) {
      $('table').each((_, tableEl) => {
        const tbl = $(tableEl);
        // Detect if this table looks like a race card (has trap numbers 1-6)
        const firstColNums = tbl.find('tbody tr').map((_, tr) =>
          parseInt($(tr).find('td').first().text(), 10)
        ).get().filter(n => n >= 1 && n <= 6);

        if (firstColNums.length < 2) return;

        // Try to find venue and time from nearest heading
        const heading = tbl.prev('h2, h3, h4').first().text() ||
                        tbl.closest('section, article, div').find('h2, h3, h4').first().text();
        const venue   = matchVenue(heading);
        const time    = extractTime(heading) || extractTime(tbl.closest('section, article').find('[class*="time"]').first().text());

        if (!venue || !time) return;

        const race = buildRaceShell(venue, time, today, tbl);

        tbl.find('tbody tr').each((_, tr) => {
          const runner = parseRunnerCells($(tr).find('td'));
          if (runner) race.runners.push(runner);
        });

        if (race.runners.length >= 2) races.push(race);
      });
    }

    console.log(`[RacecardScraper] GreyhoundRecorder: found ${races.length} races`);
  } catch (err) {
    console.warn(`[RacecardScraper] GreyhoundRecorder failed: ${err.message}`);
  }

  return races;
}

// ── Source 3: Racing Post greyhound cards ─────────────────────────────────────

async function scrapeRacingPostCards() {
  const races = [];
  const today = new Date().toISOString().split('T')[0];

  try {
    const html = await fetchHtml('https://www.racingpost.com/greyhounds/cards/today');
    const $    = cheerio.load(html);

    // Racing Post uses Next.js — __NEXT_DATA__ JSON blob is the most reliable
    let parsed = false;
    $('script#__NEXT_DATA__').each((_, el) => {
      try {
        const json      = JSON.parse($(el).html());
        const extracted = extractRacesFromJson(json, today);
        if (extracted.length) {
          races.push(...extracted);
          parsed = true;
        }
      } catch (_) {}
    });

    // HTML fallback
    if (!parsed) {
      $('[class*="CourseHeader"], [class*="course-header"], [class*="CardWrapper"]').each((_, cardEl) => {
        const card      = $(cardEl);
        const venueText = normalise(card.find('[class*="courseName"], [class*="venue"], h2').first().text());
        const venue     = matchVenue(venueText);
        if (!venue) return;

        card.find('[class*="RaceRow"], [class*="race-row"], [class*="RaceCard"]').each((_, raceEl) => {
          const raceDiv = $(raceEl);
          const time    = extractTime(
            raceDiv.find('[class*="raceTime"], [class*="time"]').first().text() || raceDiv.text()
          );
          if (!time) return;

          const race = buildRaceShell(venue, time, today, raceDiv);

          raceDiv.find('[class*="RunnerRow"], [class*="runner-row"], tr').each((_, runnerEl) => {
            const r      = $(runnerEl);
            const cells  = r.find('td');
            const runner = cells.length >= 2 ? parseRunnerCells(cells) : parseRunnerRow(r);
            if (runner) race.runners.push(runner);
          });

          if (race.runners.length >= 2) races.push(race);
        });
      });
    }

    console.log(`[RacecardScraper] RacingPost: found ${races.length} races`);
  } catch (err) {
    console.warn(`[RacecardScraper] RacingPost failed: ${err.message}`);
  }

  return races;
}

// ── Aggregator ────────────────────────────────────────────────────────────────

/**
 * Fetch today's race cards.  Each source is tried in parallel; the first that
 * returns ≥3 races is used.  If none meet that threshold, results are merged.
 */
async function fetchRaceCards() {
  const results = await Promise.allSettled([
    scrapeGBGB(),
    scrapeGreyhoundRecorder(),
    scrapeRacingPostCards(),
  ]);

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.length >= 3) {
      console.log(`[RacecardScraper] Using primary result: ${result.value.length} races`);
      return deduplicateRaces(result.value);
    }
  }

  // Merge all partial results
  const all = [];
  for (const result of results) {
    if (result.status === 'fulfilled') all.push(...result.value);
  }
  const merged = deduplicateRaces(all);
  console.log(`[RacecardScraper] Merged from all sources: ${merged.length} races`);
  return merged;
}

// ── Venue data ────────────────────────────────────────────────────────────────

const UK_VENUES = [
  'Romford', 'Hove', 'Belle Vue', 'Nottingham', 'Swindon', 'Monmore',
  'Oxford', 'Perry Barr', 'Poole', 'Sheffield', 'Towcester', 'Newcastle',
  'Doncaster', 'Yarmouth', 'Kinsley', 'Coventry', 'Henlow', 'Peterborough',
  'Harlow', 'Walthamstow', 'Birmingham', 'Crayford', 'Wimbledon',
  'Central Park', 'Dunstall Park', 'Pelaw Grange', 'Suffolk Downs',
  'The Valley', 'Sunderland',
];

const VENUE_CODES = {
  'Romford':       'ROM', 'Hove':          'HOV', 'Belle Vue':     'BEL',
  'Nottingham':    'NOT', 'Swindon':        'SWI', 'Monmore':       'MON',
  'Oxford':        'OXF', 'Perry Barr':     'PER', 'Poole':         'POO',
  'Sheffield':     'SHE', 'Towcester':      'TOW', 'Newcastle':     'NEW',
  'Doncaster':     'DON', 'Yarmouth':       'YAR', 'Kinsley':       'KIN',
  'Coventry':      'COV', 'Henlow':         'HEN', 'Peterborough':  'PET',
  'Harlow':        'HAR', 'Crayford':       'CRA', 'Wimbledon':     'WIM',
  'Central Park':  'CEN', 'Dunstall Park':  'DUN', 'Pelaw Grange':  'PEL',
  'Suffolk Downs': 'SUF', 'The Valley':     'VAL', 'Sunderland':    'SUN',
};

function matchVenue(text) {
  const t = (text || '').toLowerCase();
  for (const v of UK_VENUES) {
    if (t.includes(v.toLowerCase())) return v;
  }
  return '';
}

function venueCode(venue) {
  return VENUE_CODES[venue] || venue.slice(0, 3).toUpperCase();
}

// ── Row parsing helpers ───────────────────────────────────────────────────────

/**
 * Build the shell of a race object from a Cheerio element that contains
 * distance/grade/prize metadata.
 */
function buildRaceShell(venue, time, date, $el) {
  const text = $el.text ? $el.text() : '';
  return {
    id:       `${venueCode(venue)}-${time.replace(':', '')}`,
    venue,
    time,
    date,
    distance: normalise($el.find ? $el.find('[class*="dist"]').first().text() : '') ||
              extractDistance(text),
    grade:    normalise($el.find ? $el.find('[class*="grade"], [class*="class"]').first().text() : '') ||
              extractGrade(text),
    prize:    normalise($el.find ? $el.find('[class*="prize"]').first().text() : '') ||
              extractPrize(text),
    runners:  [],
  };
}

/**
 * Parse a runner from a <tr> element using class-based selectors.
 */
function parseRunnerRow($el) {
  const trap = parseInt(
    $el.find('[class*="trap"], [class*="cloth"], [class*="number"]').first().text(), 10
  );
  const name = normalise(
    $el.find('[class*="dog"], [class*="name"], [class*="runner-name"], [class*="selection"]').first().text()
  );
  const trainer = normalise($el.find('[class*="trainer"]').first().text());
  const form    = normalise($el.find('[class*="form"]').first().text());

  if (trap >= 1 && trap <= 6 && name.length > 2) {
    return { trap, name, trainer, form, openingOdds: null, currentOdds: null };
  }
  return null;
}

/**
 * Parse a runner from a jQuery collection of <td> elements (positional).
 * Assumes columns: trap | name | trainer | form [| ...]
 */
function parseRunnerCells($cells) {
  const trap    = parseInt($cells.eq(0).text(), 10);
  const name    = normalise($cells.eq(1).text());
  const trainer = normalise($cells.eq(2).text());
  const form    = normalise($cells.eq(3).text());

  if (trap >= 1 && trap <= 6 && name.length > 2) {
    return { trap, name, trainer, form, openingOdds: null, currentOdds: null };
  }
  return null;
}

// ── JSON extraction (Racing Post __NEXT_DATA__ et al.) ────────────────────────

/**
 * Walk any JSON tree looking for nodes that look like race cards.
 * Handles both array and object structures recursively.
 */
function extractRacesFromJson(json, today) {
  const races = [];
  if (!json || typeof json !== 'object') return races;

  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }

    // Does this node look like a race?
    const hasVenueKey  = node.courseName || node.venue || node.meeting || node.track;
    const hasTimeKey   = node.time || node.raceTime || node.offTime;
    const hasRunnerKey = node.runners || node.dogs || node.selections;

    if (hasVenueKey && hasTimeKey && hasRunnerKey) {
      const venueText = String(hasVenueKey);
      const venue     = matchVenue(venueText);
      const time      = extractTime(String(hasTimeKey));

      if (venue && time) {
        const runnersRaw = (hasRunnerKey instanceof Array ? hasRunnerKey : []);
        const runners = runnersRaw
          .map(r => ({
            trap:        parseInt(r.trap || r.trapNumber || r.cloth || r.saddle, 10) || 0,
            name:        normalise(r.name || r.dogName || r.runner || r.horse || ''),
            trainer:     normalise(r.trainer || r.trainerName || ''),
            form:        normalise(r.form || r.recentForm || r.formFigures || ''),
            openingOdds: null,
            currentOdds: null,
          }))
          .filter(r => r.trap >= 1 && r.trap <= 6 && r.name.length > 2);

        if (runners.length >= 2) {
          races.push({
            id:       `${venueCode(venue)}-${time.replace(':', '')}`,
            venue,
            time,
            date:     today,
            distance: normalise(String(node.distance || node.dist || '')),
            grade:    normalise(String(node.class || node.grade || node.raceClass || node.category || '')),
            prize:    normalise(String(node.prize || node.prizeMoney || node.winnerPrize || '')),
            runners,
          });
        }
      }
    }

    // Recurse
    for (const val of Object.values(node)) {
      if (val && typeof val === 'object') walk(val);
    }
  }

  walk(json);
  return deduplicateRaces(races);
}

// ── Text extraction helpers ───────────────────────────────────────────────────

function normalise(str) {
  return (str || '').replace(/\s+/g, ' ').trim();
}

function extractTime(text) {
  const m = (text || '').match(/\b(\d{1,2})[:.h](\d{2})\b/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : '';
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

// ── Deduplication ─────────────────────────────────────────────────────────────

/**
 * Remove duplicate races (same venue + time).
 * Prefers the entry with more runners; sorts by venue then time.
 */
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

module.exports = { fetchRaceCards };
