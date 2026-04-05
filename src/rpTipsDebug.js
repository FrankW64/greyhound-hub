'use strict';
/**
 * Debug script — dumps the Racing Post tips page HTML so we can fix selectors.
 * Run on VPS: node src/rpTipsDebug.js
 */
const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: '/usr/bin/chromium-browser',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  const today = new Date().toISOString().split('T')[0];
  console.log('Date:', today);

  // Step 1: get a race_id from the meeting list
  console.log('\n=== Loading meeting list ===');
  await page.goto(`https://greyhoundbet.racingpost.com/#meeting-list/r_date=${today}`, {
    waitUntil: 'networkidle2', timeout: 40000,
  });
  await new Promise(r => setTimeout(r, 3000));

  const links = await page.evaluate(() =>
    [...document.querySelectorAll('a[href*="race_id"]')].slice(0, 5).map(a => a.getAttribute('href'))
  );
  console.log('Race links found:', links.length);
  if (!links.length) {
    console.log('Body snippet:', (await page.evaluate(() => document.body.innerHTML)).slice(0, 1000));
    await browser.close(); return;
  }

  const raceId = links[0].match(/race_id=(\d+)/)?.[1];
  const allIds = links.map(l => l.match(/race_id=(\d+)/)?.[1]).filter(Boolean).join(',');
  console.log('Using race_id:', raceId);

  // Step 2: load the tips tab for that race
  const tipUrl = `https://greyhoundbet.racingpost.com/#card/race_id=${raceId}&r_date=${today}&tab=tips&races_ids=${allIds}`;
  console.log('\n=== Loading tips page ===\n', tipUrl);
  await page.goto(tipUrl, { waitUntil: 'networkidle2', timeout: 40000 });
  await new Promise(r => setTimeout(r, 5000)); // let React finish rendering

  // Step 3: dump class names relevant to tips
  const tipClasses = await page.evaluate(() => {
    const all = new Set();
    document.querySelectorAll('[class]').forEach(el =>
      (el.className || '').split(/\s+/).forEach(c => { if (c) all.add(c); })
    );
    return [...all].filter(c => /tip|select|trap|pick|tab|card|race|row|strength/i.test(c)).sort();
  });
  console.log('\n=== Relevant CSS classes ===');
  console.log(tipClasses.join('\n'));

  // Step 4: dump all tables
  const tables = await page.evaluate(() =>
    [...document.querySelectorAll('table')].map(t => ({
      className: t.className,
      html: t.outerHTML.slice(0, 1500),
    }))
  );
  console.log(`\n=== Tables found: ${tables.length} ===`);
  tables.forEach((t, i) => {
    console.log(`\n-- Table ${i} class="${t.className}" --`);
    console.log(t.html);
  });

  // Step 5: dump first 3000 chars around "tip"/"select"/"1st" keywords
  const bodyHtml = await page.evaluate(() => document.body.innerHTML);
  ['1st', 'selection', 'tip-', 'strength'].forEach(kw => {
    const idx = bodyHtml.toLowerCase().indexOf(kw);
    if (idx !== -1) {
      console.log(`\n=== Context around "${kw}" ===`);
      console.log(bodyHtml.slice(Math.max(0, idx - 200), idx + 800));
    }
  });

  await browser.close();
})().catch(err => { console.error(err); process.exit(1); });
