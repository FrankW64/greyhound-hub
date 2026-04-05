'use strict';
// node src/rpDebug.js

const axios = require('axios');

const RACE_ID = '2193253';
const R_DATE  = '2026-04-05';
const BASE    = 'https://greyhoundbet.racingpost.com';

// Try different Accept header combinations — 406 means server is picky
const ACCEPT_VARIANTS = [
  '*/*',
  'application/json',
  'text/javascript, application/javascript, */*',
  'text/html, */*',
  'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'application/json, text/javascript, */*; q=0.01',
];

const BASE_HEADERS = {
  'User-Agent':  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Referer': `${BASE}/#card/race_id=${RACE_ID}&r_date=${R_DATE}&tab=tips`,
  'X-Requested-With': 'XMLHttpRequest',
  'Origin': BASE,
};

async function probe(path, accept) {
  const url = `${BASE}${path}`;
  try {
    const res = await axios.get(url, {
      headers: { ...BASE_HEADERS, 'Accept': accept },
      timeout: 10000,
      validateStatus: () => true,
    });
    const body = typeof res.data === 'object'
      ? JSON.stringify(res.data).slice(0, 800)
      : String(res.data).slice(0, 800);
    return { status: res.status, ct: res.headers['content-type'] || '?', body };
  } catch (err) {
    return { status: 'ERR', ct: '', body: err.message };
  }
}

(async () => {
  const paths = [
    `/card/blocks.sd?race_id=${RACE_ID}&r_date=${R_DATE}&blocks=tips`,
    `/card/blocks.sd?race_id=${RACE_ID}&r_date=${R_DATE}&blocks=card`,
    `/meeting/blocks.sd?r_date=${R_DATE}&blocks=meeting-list`,
    `/meeting/blocks.sd?r_date=${R_DATE}&blocks=meeting-races`,
  ];

  // Try every Accept variant against the tips endpoint
  console.log('=== ACCEPT HEADER VARIANTS (tips endpoint) ===');
  for (const accept of ACCEPT_VARIANTS) {
    const r = await probe(`/card/blocks.sd?race_id=${RACE_ID}&r_date=${R_DATE}&blocks=tips`, accept);
    console.log(`[${r.status}] Accept: ${accept}`);
    if (r.status === 200) console.log('  BODY:', r.body);
  }

  // Try without X-Requested-With (some servers reject XHR but accept plain requests)
  console.log('\n=== WITHOUT X-Requested-With ===');
  try {
    const res = await axios.get(`${BASE}/card/blocks.sd?race_id=${RACE_ID}&r_date=${R_DATE}&blocks=tips`, {
      headers: {
        'User-Agent': BASE_HEADERS['User-Agent'],
        'Accept': '*/*',
        'Accept-Language': 'en-GB,en;q=0.9',
        'Referer': `${BASE}/`,
      },
      timeout: 10000,
      validateStatus: () => true,
    });
    console.log(`[${res.status}] Content-Type: ${res.headers['content-type'] || '?'}`);
    console.log('Body:', JSON.stringify(res.data).slice(0, 800));
  } catch (err) {
    console.log('ERR:', err.message);
  }

  // Try fetching a race card page directly as HTML — tips might be server-rendered
  console.log('\n=== HTML RACE CARD PAGE (tips tab) ===');
  try {
    const res = await axios.get(`${BASE}/`, {
      headers: {
        'User-Agent': BASE_HEADERS['User-Agent'],
        'Accept': 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
      params: { race_id: RACE_ID, r_date: R_DATE, tab: 'tips' },
      timeout: 10000,
      validateStatus: () => true,
    });
    console.log(`[${res.status}] Content-Type: ${res.headers['content-type'] || '?'}`);
    // Look for trap numbers and tip-related content in HTML
    const html = String(res.data);
    const tipMatches = html.match(/.{0,100}(trap|tip|1st|2nd|3rd|pick|select).{0,100}/gi) || [];
    tipMatches.slice(0, 5).forEach(m => console.log(' ', m.trim()));
  } catch (err) {
    console.log('ERR:', err.message);
  }

  // Try the meeting-list to get actual race IDs for today
  console.log('\n=== MEETING LIST (to find today race IDs) ===');
  const meetRes = await probe(`/meeting/blocks.sd?r_date=${R_DATE}&blocks=meeting-list`, 'application/json, text/javascript, */*; q=0.01');
  console.log(`[${meetRes.status}]`, meetRes.body.slice(0, 400));

})();
