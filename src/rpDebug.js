'use strict';
// node src/rpDebug.js
// Probes Racing Post greyhound tips API with known race_id

const axios = require('axios');

const RACE_ID = '2193253';
const R_DATE  = '2026-04-05';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/javascript, */*',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Referer': `https://greyhoundbet.racingpost.com/#card/race_id=${RACE_ID}&r_date=${R_DATE}&tab=tips`,
  'X-Requested-With': 'XMLHttpRequest',
};

const CANDIDATES = [
  // card/blocks.sd with various block values
  `/card/blocks.sd?race_id=${RACE_ID}&r_date=${R_DATE}&blocks=tips`,
  `/card/blocks.sd?race_id=${RACE_ID}&r_date=${R_DATE}&blocks=card`,
  `/card/blocks.sd?race_id=${RACE_ID}&r_date=${R_DATE}&blocks=tab-tips`,
  `/card/blocks.sd?race_id=${RACE_ID}&r_date=${R_DATE}&blocks=card-header`,
  `/card/blocks.sd?race_id=${RACE_ID}&r_date=${R_DATE}&blocks=card,tips`,
  `/card/blocks.sd?race_id=${RACE_ID}&r_date=${R_DATE}&blocks=tips,card`,
  // meeting/blocks.sd
  `/meeting/blocks.sd?r_date=${R_DATE}&blocks=meeting-list`,
  `/meeting/blocks.sd?r_date=${R_DATE}&blocks=meeting-races`,
  `/meeting/blocks.sd?r_date=${R_DATE}&blocks=tips`,
].map(p => `https://greyhoundbet.racingpost.com${p}`);

(async () => {
  for (const url of CANDIDATES) {
    try {
      const res = await axios.get(url, {
        headers: HEADERS,
        timeout: 10000,
        validateStatus: () => true,
      });
      const body = typeof res.data === 'object'
        ? JSON.stringify(res.data).slice(0, 600)
        : String(res.data).slice(0, 600);
      console.log(`\n[${res.status}] ${url.replace('https://greyhoundbet.racingpost.com', '')}`);
      console.log(`  Content-Type: ${res.headers['content-type'] || '?'}`);
      console.log(`  Body: ${body}`);
    } catch (err) {
      console.log(`\n[ERR] ${url}`);
      console.log(`  ${err.message}`);
    }
  }
})();
