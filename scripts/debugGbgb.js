'use strict';

// Quick debug: shows what the GBGB API actually returns for a given date
// Usage: node scripts/debugGbgb.js 2026-01-10

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');

const date = process.argv[2] || new Date().toISOString().split('T')[0];

async function main() {
  const { data } = await axios.get('https://api.gbgb.org.uk/api/results', {
    params: { raceDate: date, pageSize: 500 },
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
      'Referer': 'https://www.gbgb.org.uk/',
    },
    timeout: 15000,
  });

  const rows = Array.isArray(data) ? data : (data.items || []);
  console.log(`\nQuery date: ${date}`);
  console.log(`Rows returned: ${rows.length}`);

  if (!rows.length) { console.log('No data'); return; }

  // Show unique dates actually in the response
  const dates = [...new Set(rows.map(r => r.raceDate))];
  console.log(`raceDate values in response: ${dates.join(', ')}`);

  // Show unique meetings
  const meetings = [...new Map(rows.map(r => [String(r.meetingId), r.trackName])).entries()];
  console.log(`\nMeetings (${meetings.length}):`);
  for (const [id, venue] of meetings) console.log(`  ${id} — ${venue}`);

  // Show first 5 rows
  console.log(`\nFirst 5 rows:`);
  console.log(JSON.stringify(rows.slice(0, 5), null, 2));
}

main().catch(err => console.error(err.message));
