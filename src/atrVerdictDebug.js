'use strict';
/**
 * Debug script — finds the Verdict section on an ATR greyhound racecard page.
 * Run on VPS: node src/atrVerdictDebug.js
 */

let puppeteer;
try { puppeteer = require('puppeteer'); } catch (_) { puppeteer = null; }

if (!puppeteer) { console.error('puppeteer not installed'); process.exit(1); }

const CHROMIUM_PATHS = [
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
];

function findChromium() {
  const fs = require('fs');
  for (const p of CHROMIUM_PATHS) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return null;
}

const TEST_URL = 'https://greyhounds.attheraces.com/racecard/GB/towcester/05-April-2026/1743';

(async () => {
  const executablePath = findChromium();
  const browser = await puppeteer.launch({
    headless: 'new',
    protocolTimeout: 60000,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
           '--disable-gpu','--no-zygote','--mute-audio','--no-first-run'],
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-GB,en;q=0.9' });

    // Block images/fonts/media
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (['image','font','media'].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    // Capture any JSON responses that might contain verdict data
    const apiResponses = [];
    page.on('response', async resp => {
      const ct = resp.headers()['content-type'] || '';
      if (ct.includes('json')) {
        try {
          const text = await resp.text();
          if (text.includes('verdict') || text.includes('Verdict') ||
              text.includes('first') || text.includes('selection')) {
            apiResponses.push({ url: resp.url(), body: text.slice(0, 2000) });
          }
        } catch (_) {}
      }
    });

    console.log('Loading:', TEST_URL);
    await page.goto(TEST_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait a few seconds for React/SPA to render
    await new Promise(r => setTimeout(r, 5000));

    // Dump page title
    const title = await page.title();
    console.log('Page title:', title);

    // Search for verdict-related elements
    const verdictInfo = await page.evaluate(() => {
      const keywords = ['verdict', 'selection', 'prediction', 'tip', 'pick'];
      const results = [];

      // Find all elements whose class or id contains verdict keywords
      document.querySelectorAll('[class],[id]').forEach(el => {
        const cls = el.className || '';
        const id  = el.id || '';
        const combined = (cls + ' ' + id).toLowerCase();
        if (keywords.some(k => combined.includes(k))) {
          results.push({
            tag:  el.tagName,
            cls:  cls.slice(0, 100),
            id:   id.slice(0, 50),
            text: el.innerText?.replace(/\s+/g,' ').trim().slice(0, 200),
            html: el.innerHTML?.slice(0, 500),
          });
        }
      });
      return results.slice(0, 30);
    });

    console.log('\n=== Elements with verdict/selection/tip in class/id ===');
    for (const el of verdictInfo) {
      console.log(`\n<${el.tag} class="${el.cls}" id="${el.id}">`);
      console.log('  Text:', el.text);
      console.log('  HTML:', el.html);
    }

    // Look for headings containing verdict/tip keywords
    const headings = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('h1,h2,h3,h4,h5,h6,strong,b,p').forEach(el => {
        const t = el.innerText?.toLowerCase() || '';
        if (['verdict','1st','2nd','3rd','selection','tip'].some(k => t.includes(k))) {
          const parent = el.parentElement;
          results.push({
            tag:        el.tagName,
            text:       el.innerText?.trim().slice(0, 100),
            parentCls:  parent?.className?.slice(0, 100),
            parentHtml: parent?.innerHTML?.slice(0, 600),
          });
        }
      });
      return results.slice(0, 20);
    });

    console.log('\n=== Headings/text containing verdict keywords ===');
    for (const h of headings) {
      console.log(`\n<${h.tag}>: "${h.text}"`);
      console.log('  Parent class:', h.parentCls);
      console.log('  Parent HTML:', h.parentHtml);
    }

    // Dump all unique class names on the page
    const allClasses = await page.evaluate(() => {
      const cls = new Set();
      document.querySelectorAll('[class]').forEach(el => {
        (el.className || '').split(/\s+/).forEach(c => {
          if (c && ['verdict','tip','pick','select','predict','position','first','second','third'].some(k => c.toLowerCase().includes(k))) {
            cls.add(c);
          }
        });
      });
      return [...cls];
    });

    console.log('\n=== All classes containing verdict/tip/pick keywords ===');
    console.log(allClasses.join('\n'));

    // Dump captured JSON API responses
    if (apiResponses.length) {
      console.log('\n=== JSON API responses mentioning verdict/selection ===');
      for (const r of apiResponses) {
        console.log('\nURL:', r.url);
        console.log('Body:', r.body);
      }
    }

    // Take a section of the full HTML around "Verdict"
    const fullHtml = await page.content();
    const idx = fullHtml.toLowerCase().indexOf('verdict');
    if (idx !== -1) {
      console.log('\n=== Raw HTML around "Verdict" ===');
      console.log(fullHtml.slice(Math.max(0, idx - 200), idx + 1000));
    }

  } finally {
    await browser.close();
  }
})().catch(err => console.error('Error:', err.message));
