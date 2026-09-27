// perf: measures what a person feels and holds it to a budget. run against
// the beacon's loopback dev mode like the other suites.
//
//   node web/tests/perf.mjs
//
// numbers come from headless chromium on the machine running the test, so
// they are not phone numbers; the budgets are set with that in mind and the
// 4x cpu throttle rows approximate a mid-range phone.

import { spawn, execSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* not local */ }
  const globalRoot = execSync('npm root -g').toString().trim();
  return import(pathToFileURL(path.join(globalRoot, 'playwright', 'index.mjs')).href);
}
const { chromium } = await loadPlaywright();

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');
const PORT = 8767;
const ORIGIN = `http://localhost:${PORT}`;
const PASS = 'a long passphrase for the timing run';

const rows = [];
const failures = [];
function record(name, value, unit, budget, higherIsBetter = false) {
  const ok = budget == null ? true : higherIsBetter ? value >= budget : value <= budget;
  rows.push({ name, value, unit, budget, ok });
  if (!ok) failures.push(`${name}: ${fmt(value)} ${unit} (budget ${higherIsBetter ? '≥' : '≤'} ${budget})`);
}
const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]; };

async function serve() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gabriel-perf-'));
  const child = spawn('node', ['server.mjs', '--dev-http', String(PORT), '--https-port', '18445', '--http-port', '18082', '--data', dataDir, '--name', 'perf room'], { cwd: path.resolve(webRoot, '..', 'beacon'), stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`${ORIGIN}/index.html`); if (r.ok) return child; } catch { /* not up yet */ }
    await sleep(100);
  }
  child.kill();
  throw new Error('static server did not start');
}

async function navTiming(page) {
  return page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0];
    const fcp = performance.getEntriesByType('paint').find((p) => p.name === 'first-contentful-paint');
    return { dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd, ttfb: n.responseStart, fcp: fcp ? fcp.startTime : null, transfer: n.transferSize };
  });
}
async function lcp(page) {
  return page.evaluate(() => new Promise((resolve) => {
    let last = null;
    const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) last = e.startTime; });
    po.observe({ type: 'largest-contentful-paint', buffered: true });
    setTimeout(() => { po.disconnect(); resolve(last); }, 800);
  }));
}
async function fps(page, seconds) {
  return page.evaluate((s) => new Promise((resolve) => {
    let frames = 0; const t0 = performance.now();
    const tick = () => { frames++; if (performance.now() - t0 < s * 1000) requestAnimationFrame(tick); else resolve(frames / s); };
    requestAnimationFrame(tick);
  }), seconds);
}
async function longTasks(page, seconds) {
  return page.evaluate((s) => new Promise((resolve) => {
    let n = 0, total = 0;
    const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) { n++; total += e.duration; } });
    po.observe({ type: 'longtask' });
    setTimeout(() => { po.disconnect(); resolve({ n, total }); }, s * 1000);
  }), seconds);
}
async function waitForOfflineReady(page) {
  for (let i = 0; i < 80; i++) {
    const ready = await page.evaluate(async () => {
      const keys = await caches.keys();
      for (const k of keys) { const c = await caches.open(k); if (await c.match('./app.html', { ignoreSearch: true }) && await c.match('./vendor/jsQR.js') && await c.match('./vendor/fonts/inter-latin-300-normal.woff2')) return !!navigator.serviceWorker.controller; }
      return false;
    });
    if (ready) return;
    await sleep(250);
  }
  throw new Error('worker never became ready');
}
async function timed(fn) { const t0 = Date.now(); await fn(); return Date.now() - t0; }
async function createProfile(page, name, pass) {
  await page.goto(`${ORIGIN}/app.html`);
  await page.waitForSelector('#create-form');
  await page.fill('#c-name', name); await page.fill('#c-pass', pass); await page.fill('#c-pass2', pass);
  return timed(async () => { await page.click('#c-submit'); await page.waitForSelector('main.content h2', { timeout: 60000 }); });
}
async function unlock(page, pass) {
  await page.waitForSelector('#unlock-form');
  await page.fill('#u-pass', pass);
  return timed(async () => { await page.click('#u-submit'); await page.waitForSelector('main.content h2', { timeout: 60000 }); });
}
async function connectBeacon(page) {
  await page.click('.sidenav a[data-route="privacy"]');
  await page.waitForSelector('#b-url');
  await page.fill('#b-url', `ws://127.0.0.1:${PORT}/ws`);
  await page.click('#b-connect');
  await page.waitForFunction(() => document.querySelector('#top-beacon')?.classList.contains('on'), null, { timeout: 10000 });
}

async function main() {
  const server = await serve();
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  try {
    // ---- landing, cold: bytes, requests, paint ----
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      let bytes = 0, requests = 0;
      page.on('response', async (r) => { if (r.url().startsWith(ORIGIN)) { requests++; try { bytes += (await r.request().sizes()).responseBodySize; } catch { /* aborted */ } } });
      await page.goto(`${ORIGIN}/index.html`, { waitUntil: 'load' });
      await sleep(1200);
      const t = await navTiming(page);
      record('landing cold: requests', requests, '', 40);
      record('landing cold: bytes over the wire', Math.round(bytes / 1024), 'KB', 450);
      record('landing cold: first contentful paint', t.fcp, 'ms', 1200);
      record('landing cold: largest contentful paint', await lcp(page), 'ms', 2500);
      record('landing cold: dom ready', t.dcl, 'ms', 1200);
      record('landing cold: load event', t.load, 'ms', 2000);
      // cost of the motion, measured against the same renderer with everything still.
      // headless chromium draws in software, so only the ratio means anything here.
      const heroMoving = await fps(page, 3);
      const lt = await longTasks(page, 3);
      record('landing hero: long tasks in 3 s', lt.n, '', 2);
      await page.evaluate(() => document.getElementById('signin').scrollIntoView());
      await sleep(900);
      const readingFps = await fps(page, 3);
      await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
      await sleep(300);
      const stillFps = await fps(page, 3);
      record('landing hero, sky and rings moving: share of the still frame rate', (heroMoving / stillFps) * 100, '%', 30, true);
      record('landing reading a section, sky at rest: share of the still frame rate', (readingFps / stillFps) * 100, '%', 85, true);
      // warm, offline: the worker serves everything
      await waitForOfflineReady(page);
      await ctx.setOffline(true);
      await page.reload({ waitUntil: 'load' });
      const w = await navTiming(page);
      record('landing offline from cache: dom ready', w.dcl, 'ms', 400);
      record('landing offline from cache: load event', w.load, 'ms', 700);
      await ctx.setOffline(false);
      await ctx.close();
    }

    // ---- console: key derivation, unlock, routes, idle cpu ----
    const mk = async (label) => { const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['microphone', 'camera', 'geolocation'], geolocation: { latitude: 51.5, longitude: -0.12, accuracy: 10 } }); const page = await ctx.newPage(); page.on('pageerror', (e) => failures.push(`${label} page error: ${e.message}`)); return { ctx, page }; };
    const A = await mk('A');
    record('console: create profile (600 000 pbkdf2 rounds + keys)', await createProfile(A.page, 'ada', PASS), 'ms', 4000);
    await A.page.click('#lock-btn');
    record('console: unlock', await unlock(A.page, PASS), 'ms', 3000);
    const cdpA = await A.ctx.newCDPSession(A.page);
    await cdpA.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await A.page.click('#lock-btn');
    record('console: unlock at 4x cpu throttle', await unlock(A.page, PASS), 'ms', 9000);
    await cdpA.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    const switches = [];
    for (const r of ['rooms', 'devices', 'notes', 'transfer', 'privacy', 'settings', 'overview']) {
      switches.push(await timed(async () => {
        await A.page.click(`.sidenav a[data-route="${r}"]`);
        await A.page.waitForFunction((x) => document.querySelector(`.sidenav a[data-route="${x}"]`)?.classList.contains('active') && document.querySelector('main.content h2'), r, { polling: 5 });
      }));
    }
    record('console: route switch, worst of seven', Math.max(...switches), 'ms', 300);
    await cdpA.send('Performance.enable');
    const m0 = (await cdpA.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration').value;
    await sleep(5000);
    const m1 = (await cdpA.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration').value;
    record('console idle: main-thread busy over 5 s', ((m1 - m0) / 5) * 100, '% of one core', 5);

    // ---- two devices through the beacon: message latency ----
    const B = await mk('B');
    await createProfile(B.page, 'bao', PASS);
    for (const d of [A, B]) { await d.page.click('.sidenav a[data-route="devices"]'); await d.page.click('#pair-btn'); await d.page.waitForSelector('#my-code'); }
    const codeA = await A.page.$eval('#my-code', (el) => el.textContent);
    const codeB = await B.page.$eval('#my-code', (el) => el.textContent);
    const pairMs = await timed(async () => {
      await A.page.fill('#their-text', codeB); await A.page.click('#read-theirs'); await A.page.waitForSelector('#sas');
      await B.page.fill('#their-text', codeA); await B.page.click('#read-theirs'); await B.page.waitForSelector('#sas');
      await A.page.click('#sas-yes'); await B.page.click('#sas-yes');
      await A.page.waitForSelector('.item-row.trust'); await B.page.waitForSelector('.item-row.trust');
    });
    record('pairing: both codes read, sas derived, both confirmed', pairMs, 'ms', 3000);
    record('beacon: connect', await timed(() => connectBeacon(A.page)), 'ms', 2000);
    await connectBeacon(B.page);
    for (const d of [A, B]) { await d.page.click('.sidenav a[data-route="rooms"]'); await d.page.click('a[href^="#/rooms/dm:"]'); await d.page.waitForSelector('#compose'); }
    await sleep(600);
    const lat = [];
    for (let i = 0; i < 20; i++) {
      const text = `ping ${i} ${Math.random().toString(36).slice(2, 8)}`;
      await A.page.fill('#compose', text);
      const t0 = Date.now();
      await A.page.click('#send');
      try {
        await B.page.waitForFunction((t) => [...document.querySelectorAll('#timeline .bubble .txt')].some((b) => b.textContent === t), text, { timeout: 30000, polling: 20 });
      } catch (e) {
        const diag = { aToast: await A.page.$eval('#toast', (t) => t.textContent).catch(() => null), aBubbles: await A.page.$$eval('#timeline .bubble .txt', (b) => b.map((x) => x.textContent)).catch(() => null), bBubbles: await B.page.$$eval('#timeline .bubble .txt', (b) => b.map((x) => x.textContent)).catch(() => null), aHash: await A.page.evaluate(() => location.hash), bHash: await B.page.evaluate(() => location.hash), aBeacon: await A.page.$eval('#nav-beacon, #top-beacon', (c) => c.className).catch(() => null), bBeacon: await B.page.$eval('#nav-beacon, #top-beacon', (c) => c.className).catch(() => null) };
        console.error('latency diag', JSON.stringify(diag));
        throw e;
      }
      lat.push(Date.now() - t0);
    }
    record('direct message a → beacon → b, first (subscription warm-up)', lat[0], 'ms', 1500);
    record('direct message a → beacon → b, median of 20', median(lat), 'ms', 250);
    record('direct message a → beacon → b, p95 of 20', p95(lat), 'ms', 600);
    // the shield reveal must be immediate
    const reveal = await A.page.evaluate(() => new Promise((resolve) => {
      const el = document.querySelector('#timeline .bubble .txt');
      const t0 = performance.now();
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      setTimeout(() => resolve({ ms: performance.now() - t0, revealed: el.classList.contains('revealed') }), 450);
    }));
    record('shield: hold-to-reveal latency', reveal.ms, 'ms', 700);
    // media over the pair channel: a photo and a file that needs nine frames
    const png = await A.page.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 2000; c.height = 1400; const x = c.getContext('2d');
      const g = x.createLinearGradient(0, 0, 2000, 1400); g.addColorStop(0, '#1c5b9c'); g.addColorStop(1, '#e0a262'); x.fillStyle = g; x.fillRect(0, 0, 2000, 1400);
      for (let i = 0; i < 900; i++) { x.fillStyle = `hsl(${(i * 11) % 360} 70% 60%)`; x.fillRect((i * 373) % 2000, (i * 199) % 1400, 36, 36); }
      const b = await new Promise((r) => c.toBlob(r, 'image/png')); return new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result.split(',')[1]); fr.readAsDataURL(b); });
    });
    record('photo: 2000 x 1400 png picked → re-encoded → sealed → b shows it', await timed(async () => {
      await A.page.setInputFiles('#attach-input', { name: 'p.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
      await B.page.waitForSelector('.bubble.media img', { timeout: 60000 });
    }), 'ms', 4000);
    const file = Buffer.alloc(700 * 1024); for (let i = 0; i < file.length; i++) file[i] = (i * 2654435761 >>> 24) & 0xff;
    record('file: 700 kb in nine sealed parts → b can save it', await timed(async () => {
      await A.page.setInputFiles('#attach-input', { name: 'f.bin', mimeType: 'application/octet-stream', buffer: file });
      await B.page.waitForSelector('.bubble.media a.media-file', { timeout: 60000 });
    }), 'ms', 6000);

    // a call between the two: time to connected
    const callMs = await timed(async () => {
      await A.page.click('#room-call');
      await B.page.click('#room-call');
      await A.page.waitForFunction(() => /connected/.test(document.querySelector('#call-panel .who')?.textContent || ''), null, { timeout: 20000, polling: 50 });
    });
    record('call: both joined to peer connected', callMs, 'ms', 8000);
    await A.page.click('#room-call'); await B.page.click('#room-call');
    await A.ctx.close(); await B.ctx.close();
  } catch (e) {
    failures.push(`run stopped: ${String(e.message || e).split('\n')[0]}`);
  } finally {
    await browser.close();
    server.kill();
  }

  const width = Math.max(...rows.map((r) => r.name.length));
  console.log('');
  for (const r of rows) console.log(`  ${r.ok ? ' ' : '!'} ${r.name.padEnd(width)}  ${fmt(r.value).padStart(8)} ${r.unit.padEnd(14)} ${r.budget == null ? '' : `budget ${r.budget}`}`);
  console.log('');
  if (failures.length) { console.error(`${failures.length} over budget:\n${failures.map((f) => `  - ${f}`).join('\n')}`); process.exit(1); }
  console.log('all within budget.');
}

main().catch((e) => { console.error(e); process.exit(1); });
