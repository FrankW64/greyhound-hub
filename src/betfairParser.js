'use strict';

/**
 * betfairParser.js — parses Betfair Stream API NDJSON files.
 *
 * Each .bz2 file in the Betfair historical archive contains newline-delimited
 * JSON (one object per line). The format is the Betfair Exchange Stream API:
 *
 *   - Market Change Messages (op: "mcm") contain:
 *       mc[].marketDefinition  — full market metadata + runner list (periodically replayed)
 *       mc[].rc[]              — runner changes: price updates, BSP
 *
 *   - We extract BSP per runner from the final reconciled state.
 *
 * Returns: [{ marketId, date, venue, raceTime, runners: [{ name, bsp, winFlag }] }]
 */

const GREYHOUND_EVENT_TYPE = '4339';

/**
 * Parse a complete NDJSON string from one bz2 file.
 * @param {string} ndjson  Full text content (newline-separated JSON objects)
 * @returns {{ marketId, date, venue, raceTime, distance, runners[] } | null}
 */
function parseMarketFile(ndjson) {
  const lines = ndjson.split('\n').filter(l => l.trim());

  let marketId      = null;
  let marketType    = null;
  let eventTypeId   = null;
  let venue         = null;
  let raceTime      = null;
  let raceDate      = null;
  let distance      = null;

  // runnerId → { name, bsp, winFlag }
  const runnerMap = new Map();

  for (const line of lines) {
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }

    if (!msg.mc || !Array.isArray(msg.mc)) continue;

    for (const mc of msg.mc) {
      if (!marketId && mc.id) marketId = mc.id;

      // ── Market definition ─────────────────────────────────────────────────
      if (mc.marketDefinition) {
        const def = mc.marketDefinition;

        eventTypeId = String(def.eventTypeId || '');
        marketType  = def.marketType || '';

        // Only process greyhound WIN markets
        if (eventTypeId !== GREYHOUND_EVENT_TYPE) return null;
        if (marketType !== 'WIN') return null;

        // Extract venue from eventName or venue field
        // eventName typically: "Hove 10th Apr" or "10th Apr Hove"
        venue    = extractVenue(def.venue || def.eventName || '');
        raceTime = extractTime(def.marketTime || def.openDate || '');
        raceDate = extractDate(def.marketTime || def.openDate || '');
        distance = extractDistance(def.name || '');

        // Build/update runner map from definition
        for (const r of (def.runners || [])) {
          const id   = String(r.id || r.selectionId || '');
          const name = (r.name || '').trim().toUpperCase();
          if (!id || !name) continue;

          const existing = runnerMap.get(id) || {};
          runnerMap.set(id, {
            name,
            bsp:     r.bsp     ?? existing.bsp     ?? null,
            winFlag: r.status === 'WINNER' ? 1 : (r.status === 'LOSER' ? 0 : existing.winFlag ?? null),
          });
        }
      }

      // ── Runner changes (price updates) ────────────────────────────────────
      if (mc.rc && Array.isArray(mc.rc)) {
        for (const rc of mc.rc) {
          const id = String(rc.id || '');
          if (!id) continue;

          const existing = runnerMap.get(id) || {};
          if (rc.bsp !== undefined && rc.bsp !== null) {
            runnerMap.set(id, { ...existing, bsp: rc.bsp });
          }
        }
      }
    }
  }

  // Must be a greyhound WIN market with venue and time
  if (!venue || !raceDate || !raceTime) return null;
  if (runnerMap.size === 0) return null;

  const runners = [...runnerMap.values()].filter(r => r.name && r.bsp !== null);
  if (!runners.length) return null;

  return { marketId, date: raceDate, venue, raceTime, distance, runners };
}

// ── Field extractors ──────────────────────────────────────────────────────────

function extractVenue(str) {
  if (!str) return '';
  // Betfair venue field is usually the track name directly
  // eventName might be "Hove 10th Apr" — take first word(s) before date
  const cleaned = str.replace(/\d+(st|nd|rd|th)\s+\w+/i, '').trim();
  return cleaned || str.trim();
}

function extractTime(iso) {
  // ISO string like "2026-03-10T14:23:00.000Z"
  if (!iso) return '';
  const m = iso.match(/T(\d{2}):(\d{2})/);
  if (m) return `${m[1]}:${m[2]}`;
  return '';
}

function extractDate(iso) {
  // ISO string like "2026-03-10T14:23:00.000Z"
  if (!iso) return '';
  const m = iso.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

function extractDistance(name) {
  // Race name like "R1 480m A2" or "480m Flat"
  const m = (name || '').match(/(\d{3,4})m/i);
  return m ? parseInt(m[1], 10) : null;
}

module.exports = { parseMarketFile };
