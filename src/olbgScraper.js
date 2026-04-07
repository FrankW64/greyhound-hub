'use strict';

/**
 * OLBG greyhound tips scraper.
 *
 * https://www.olbg.com/betting-tips/Greyhounds/All_Greyhounds/All_Events/28
 * is a SvelteKit SSR page — it delivers fully rendered HTML to plain axios
 * requests, with all tip data embedded in the __sveltekit JSON object.
 *
 * Each entry in the embedded JSON contains:
 *   selection         — dog name  (e.g. "Chadwell Pest")
 *   event_name_alias  — "HH:MM Venue"  (e.g. "6:02 Towcester")
 *   win_tips          — number of win-tip votes
 *   ew_tips           — number of each-way-tip votes
 *   confidence        — 0-100 confidence score
 *   expired           — 0 if race is still upcoming
 */

const axios = require('axios');

const SOURCE      = 'olbg';
const SOURCE_NAME = 'OLBG';
const LISTING_URL = 'https://www.olbg.com/betting-tips/Greyhounds/All_Greyhounds/All_Events/28';

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
};

async function scrapeOlbgTips() {
  const tips = [];

  try {
    console.log('[OLBGScraper] Fetching tips listing…');
    const { data: html } = await axios.get(LISTING_URL, {
      headers: HEADERS,
      timeout: 15000,
      maxRedirects: 5,
    });

    // ── Extract the embedded SvelteKit JSON ──────────────────────────────────
    // SvelteKit embeds page data in a script tag as:
    //   <script id="__sveltekit_data" type="application/json">…</script>
    // or inline as:  __sveltekit_XXX={...}
    // We search all <script> tags for JSON containing our selection keys.

    // OLBG embeds data as JS object literals with unquoted keys:
    //   selection:"Full Dog Name", event_name_alias:"HH:MM Venue", team_name:"Tipster", win_tips:3, ...
    // `selection` is the dog name; `team_name` is the tipster's team (not the dog).
    const rawEntries = [];
    for (const m of html.matchAll(/event_name_alias:"([^"]+)"/g)) {
      const alias = m[1];
      const ctx   = html.slice(Math.max(0, m.index - 600), m.index + 600);

      const selM  = ctx.match(/\bselection:"([^"]+)"/);
      const teamM = ctx.match(/\bteam_name:"([^"]+)"/);
      const winM  = ctx.match(/\bwin_tips:(\d+)/);
      const ewM   = ctx.match(/\bew_tips:(\d+)/);
      const expM  = ctx.match(/\bexpired:(\d+)/);

      const dogName = selM?.[1] || teamM?.[1];
      if (!dogName) continue;

      rawEntries.push({
        event_name_alias: alias,
        dog_name:  dogName,
        win_tips:  winM ? parseInt(winM[1], 10) : 0,
        ew_tips:   ewM  ? parseInt(ewM[1],  10) : 0,
        expired:   expM ? parseInt(expM[1], 10) : 0,
      });
    }

    // De-duplicate by dog+event
    const seen = new Set();
    const entries = rawEntries.filter(e => {
      const key = `${e.dog_name}|${e.event_name_alias}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log(`[OLBGScraper] ${entries.length} raw entries found`);

    // ── Convert to tip objects ───────────────────────────────────────────────
    for (const entry of entries) {
      if (!entry.dog_name || entry.expired) continue;

      // Skip entries with no tips at all
      const totalTips = (entry.win_tips || 0) + (entry.ew_tips || 0);
      if (totalTips === 0) continue;

      const dogName  = entry.dog_name.trim();
      const alias    = entry.event_name_alias || ''; // "6:02 Towcester"

      const venue    = extractVenueFromAlias(alias);
      const raceTime = extractTimeFromAlias(alias);

      // Position: ew tips → each-way (treat as 3rd/place), win tips → 1st
      const position = entry.ew_tips > entry.win_tips ? 3 : 1;

      tips.push({ source: SOURCE, sourceName: SOURCE_NAME, dogName, venue, raceTime, position });
    }

    console.log(`[OLBGScraper] ${tips.length} tips extracted`);
  } catch (err) {
    console.warn(`[OLBGScraper] Failed: ${err.message}`);
  }

  return tips;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract venue name from "6:02 Towcester" or "6:11 Star Pelaw" style alias.
 * Everything after the first space is the venue.
 */
function extractVenueFromAlias(alias) {
  const parts = (alias || '').trim().split(/\s+/);
  if (parts.length < 2) return '';
  // Join remaining parts and replace underscores with spaces
  return parts.slice(1).join(' ').replace(/_/g, ' ');
}

/**
 * Extract HH:MM time from "6:02 Towcester" style alias.
 */
function extractTimeFromAlias(alias) {
  const m = (alias || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : '';
}

module.exports = { scrapeOlbgTips };
