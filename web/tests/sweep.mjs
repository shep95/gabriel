// sweep: open every screen and press every control once, on a phone and on
// a desktop, and fail on anything that should not happen: a page error, a
// console error, a same-origin request that fails or comes back 4xx/5xx, an
// unexpected browser dialog, a screen that does not render its heading. the
// deep flows (pairing, rooms, calls, transfer) live in e2e.mjs; this is the
// broad pass that catches the crash in the corner nobody clicks in a demo.
//
//   node web/tests/sweep.mjs

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
const PORT = 8766;
const ORIGIN = `http://localhost:${PORT}`;
const PASS = 'tall grass under a ringed moon';
const PASS2 = 'the second passphrase is longer still';

const problems = [];
const problem = (where, what) => { problems.push(`${where}: ${what}`); console.error('  !', where, what); };
// a step that throws is recorded and the sweep moves on to the next one
async function step(label, name, fn) {
  try { await fn(); } catch (e) { problem(label, `${name}: ${String(e.message || e).split('\n')[0]}`); }
}
const log = (...a) => console.log('  ', ...a);

async function serve() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gabriel-sweep-'));
  const child = spawn('node', ['server.mjs', '--dev-http', String(PORT), '--https-port', '18444', '--http-port', '18081', '--data', dataDir, '--name', 'sweep room'], { cwd: path.resolve(webRoot, '..', 'beacon'), stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`${ORIGIN}/index.html`); if (r.ok) return child; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error('static server did not start');
}

function watch(page, label) {
  page.on('pageerror', (e) => problem(label, `page error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problem(label, `console error: ${m.text()}`); });
  page.on('dialog', (d) => { problem(label, `unexpected ${d.type()} dialog: ${d.message()}`); d.dismiss().catch(() => {}); });
  page.on('requestfailed', (r) => { if (r.url().startsWith(ORIGIN) && !r.failure()?.errorText.includes('ERR_ABORTED')) problem(label, `request failed: ${r.url()} ${r.failure()?.errorText}`); });
  page.on('response', (r) => { if (r.url().startsWith(ORIGIN) && r.status() >= 400) problem(label, `${r.status()} for ${r.url()}`); });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function toastText(page) { return page.$eval('#toast', (t) => t.textContent.trim()).catch(() => ''); }
async function expectToast(page, label, pattern) {
  await page.waitForFunction(() => document.querySelector('#toast')?.classList.contains('show'), null, { timeout: 8000 }).catch(() => {});
  const t = await toastText(page);
  if (!pattern.test(t)) problem(label, `expected a toast matching ${pattern}, got "${t}"`);
}
async function heading(page) { return page.$eval('main.content h2, .gate h1', (h) => h.textContent.trim()).catch(() => ''); }
async function go(page, label, route, expected) {
  await page.click(`.sidenav a[data-route="${route}"]`);
  await page.waitForFunction((r) => document.querySelector(`.sidenav a[data-route="${r}"]`)?.classList.contains('active'), route, { timeout: 8000 }).catch(() => problem(label, `${route}: nav never became active`));
  await sleep(150);
  const h = await heading(page);
  if (!expected.test(h)) problem(label, `${route}: heading "${h}" does not match ${expected}`);
}
async function overlayOpen(page) { return page.$eval('#overlay', (o) => !o.hidden && o.classList.contains('show')).catch(() => false); }
async function closeOverlayWith(page, label, selector) {
  if (!(await overlayOpen(page))) { problem(label, `overlay expected open before ${selector}`); return; }
  await page.click(`#overlay-box ${selector}`);
  await page.waitForFunction(() => document.querySelector('#overlay').hidden, null, { timeout: 4000 }).catch(() => problem(label, `overlay did not close after ${selector}`));
}

async function createProfile(page, name, pass) {
  await page.goto(`${ORIGIN}/app.html`);
  await page.waitForSelector('#create-form');
  await page.fill('#c-name', name);
  await page.fill('#c-pass', pass);
  await page.fill('#c-pass2', pass);
  await page.click('#c-submit');
  await page.waitForSelector('.sidenav', { timeout: 60000 });
  await page.waitForSelector('main.content h2');
}
async function unlock(page, pass) {
  await page.waitForSelector('#unlock-form');
  await page.fill('#u-pass', pass);
  await page.click('#u-submit');
  await page.waitForSelector('.sidenav', { timeout: 60000 });
}

// ---------- landing ----------
async function sweepLanding(browser, viewport, label) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: viewport.width < 700, hasTouch: viewport.width < 700 });
  const page = await ctx.newPage(); watch(page, label);
  await page.goto(`${ORIGIN}/index.html`);
  await page.waitForSelector('#hero-title');
  await sleep(1500);
  const menuVisible = await page.$eval('#menu-btn', (b) => getComputedStyle(b).display !== 'none');
  if (menuVisible) {
    await page.click('#menu-btn');
    await sleep(500);
    if (!(await page.$eval('#top', (t) => t.classList.contains('open')))) problem(label, 'menu did not open');
    const linkVisible = await page.$eval('#topnav a[href="#shield"]', (a) => { const r = a.getBoundingClientRect(); return r.width > 0 && getComputedStyle(a.parentElement).opacity === '1'; });
    if (!linkVisible) problem(label, 'menu links not visible when open');
    await page.keyboard.press('Escape');
    await sleep(400);
    if (await page.$eval('#top', (t) => t.classList.contains('open'))) problem(label, 'escape did not close the menu');
    await page.click('#menu-btn'); await sleep(400);
    await page.click('#topnav a[href="#shield"]'); await sleep(900);
    if (await page.$eval('#top', (t) => t.classList.contains('open'))) problem(label, 'choosing a section did not close the menu');
  } else {
    await page.click('#topnav a[href="#rooms"]'); await sleep(1200);
    const solid = await page.$eval('#top', (t) => t.classList.contains('solid'));
    if (!solid) problem(label, 'header did not take its glass after scrolling');
    const current = await page.$eval('#topnav a.current', (a) => a.getAttribute('href')).catch(() => null);
    if (current !== '#rooms') problem(label, `scroll-spy marks ${current}, expected #rooms`);
  }
  for (const id of ['signin', 'pair', 'rooms', 'shield', 'where', 'offline', 'install', 'never']) {
    const ok = await page.$eval(`#${id} h2`, (h) => h.textContent.trim().length > 0).catch(() => false);
    if (!ok) problem(label, `section ${id} has no heading`);
  }
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await sleep(800);
  const footLinks = await page.$$eval('footer .col a[href^="#"]', (as) => as.map((a) => a.getAttribute('href').slice(1)));
  for (const id of footLinks) if (!(await page.$(`#${id}`))) problem(label, `footer link to missing section ${id}`);
  await page.waitForFunction(() => /gabriel-console-v\d+|first load/.test(document.querySelector('#version')?.textContent || ''), null, { timeout: 15000 }).catch(() => problem(label, 'footer version never filled'));
  const readiness = await page.$$eval('#readiness .v', (vs) => vs.map((v) => v.textContent.trim()));
  if (readiness.some((v) => v === 'checking')) problem(label, `readiness rows still "checking": ${readiness.join(', ')}`);
  // the app link from the hero
  await page.click('.hero .actions a.enter button');
  await page.waitForSelector('#create-form, #unlock-form', { timeout: 10000 }).catch(() => problem(label, 'hero button did not reach the console'));
  await ctx.close();
  log(`${label}: landing`);
}

// ---------- console ----------
async function sweepConsole(browser, viewport, label) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: viewport.width < 700, hasTouch: viewport.width < 700, permissions: ['geolocation', 'microphone', 'camera'], geolocation: { latitude: 48.8584, longitude: 2.2945, accuracy: 20 }, acceptDownloads: true });
  const page = await ctx.newPage(); watch(page, label);
  let backupPath = null;

  // gate: validation before creation
  await page.goto(`${ORIGIN}/app.html`);
  await page.waitForSelector('#create-form');
  await page.fill('#c-name', 'sweep'); await page.fill('#c-pass', 'short'); await page.fill('#c-pass2', 'short');
  await page.click('#c-submit'); await expectToast(page, label, /at least 8/);
  await page.fill('#c-pass', PASS); await page.fill('#c-pass2', PASS + 'x');
  await page.click('#c-submit'); await expectToast(page, label, /differ/);
  await page.fill('#c-pass2', PASS);
  await page.click('#c-submit');
  await page.waitForSelector('.sidenav', { timeout: 60000 });
  await page.waitForSelector('main.content h2');

  await step(label, 'every route renders its heading', async () => {
    const routes = [['overview', /\S/], ['rooms', /^rooms$/], ['devices', /^devices$/], ['notes', /^notes$/], ['transfer', /^transfer$/], ['privacy', /^privacy$/], ['settings', /^settings$/]];
    for (const [r, re] of routes) await go(page, label, r, re);
  });

  await step(label, 'overview: install sheet', async () => {
    await go(page, label, 'overview', /\S/);
    if (await page.$('#ov-install')) { await page.click('#ov-install'); await sleep(300); await closeOverlayWith(page, label, '#ins-ok'); }
  });

  await step(label, 'notes: create, edit, delete', async () => {
    await go(page, label, 'notes', /^notes$/);
    await page.click('#note-new'); await page.waitForSelector('#n-title');
    await page.fill('#n-title', 'water'); await page.fill('#n-body', 'two jerrycans behind the north stairwell.');
    await page.click('#n-save'); await sleep(400);
    await page.click('#n-back').catch(() => {}); await sleep(300);
    const count = await page.$$eval('#note-list .item-row', (l) => l.length).catch(() => 0);
    if (count !== 1) problem(label, `expected 1 note in the list, found ${count}`);
  });

  await step(label, 'the preview is shielded (hold to reveal), so a tap on it is ignored by design; open by the title', async () => {
    await page.click('#note-list .item-row .name'); await page.waitForSelector('#n-del');
    await page.fill('#n-body', 'two jerrycans behind the north stairwell. one is half.');
    await page.click('#n-save'); await sleep(400);
    // saving returns to the list; open it again to delete
    await page.click('#note-list .item-row .name'); await page.waitForSelector('#n-del');
    await page.click('#n-del'); await sleep(300); await closeOverlayWith(page, label, '#c-no');
    await page.click('#n-del'); await sleep(300); await closeOverlayWith(page, label, '#c-ok');
    await sleep(400);
    if ((await page.$$eval('#note-list .item-row', (l) => l.length).catch(() => -1)) !== 0) problem(label, 'note not deleted');
  });

  await step(label, 'devices: pairing screen, bad code, own code, cancel', async () => {
    await go(page, label, 'devices', /^devices$/);
    await page.click('#pair-btn'); await page.waitForSelector('#my-code');
    const mine = await page.$eval('#my-code', (c) => c.textContent.trim());
    if (!/^GBR1-/.test(mine)) problem(label, `own pairing code malformed: ${mine.slice(0, 12)}`);
    await page.click('#regen-mine'); await sleep(300);
    const mine2 = await page.$eval('#my-code', (c) => c.textContent.trim());
    if (mine2 === mine) problem(label, 'new code did not change');
    await page.fill('#their-text', 'GBR1-NOT-A-REAL-CODE'); await page.click('#read-theirs'); await expectToast(page, label, /./);
    await page.fill('#their-text', mine2); await page.click('#read-theirs'); await sleep(400);
    if (await page.$('#sas')) problem(label, 'the console accepted its own code as a peer');
    await page.click('#pair-cancel').catch(() => problem(label, 'no cancel on the pairing screen'));
    await sleep(300);
  });

  await step(label, 'transfer: both tabs, a bad code on receive', async () => {
    await go(page, label, 'transfer', /^transfer$/);
    await page.click('#t-recv'); await page.waitForSelector('#r-text');
    await page.fill('#r-text', 'GBR2-NOPE'); await page.click('#r-read'); await sleep(400);
    const rOut = await page.$eval('#r-out', (o) => o.textContent.trim()).catch(() => '');
    const rToast = await toastText(page);
    if (!rOut && !rToast) problem(label, 'bad transfer code produced no message');
    await page.click('#t-send'); await sleep(200);
  });

  await step(label, 'rooms without a beacon: create, open, compose, sheets, call panel, leave', async () => {
    await go(page, label, 'rooms', /^rooms$/);
    await page.click('#room-new'); await page.waitForSelector('#overlay-box #pd');
    await page.fill('#overlay-box #pd', 'north stairwell'); await page.click('#overlay-box #pd-ok');
    // founding a room opens it
    await page.waitForSelector('#compose', { timeout: 8000 }).catch(() => problem(label, 'room view did not open after founding'));
    await page.click('.sidenav a[data-route="rooms"]'); await sleep(400);
    await page.waitForSelector('#room-list .item-row', { timeout: 8000 }).catch(() => problem(label, 'room did not appear in the list'));
    await page.click('#room-list .item-row a[href^="#/rooms/"] button');
    await page.waitForSelector('#compose', { timeout: 8000 }).catch(() => problem(label, 'room view did not open from the list'));
    await page.fill('#compose', 'anyone here'); await page.click('#send'); await sleep(500);
    await page.click('#room-people'); await sleep(400); await closeOverlayWith(page, label, '#pp-close');
    await page.click('#room-where'); await sleep(400);
    if (await page.$('#overlay-box #wh-locate')) { await page.click('#overlay-box #wh-locate'); await sleep(1500); }
    await closeOverlayWith(page, label, '#wh-close');
    await page.click('#room-call'); await sleep(1500);
    if (!(await page.$('#call-panel .callpanel'))) problem(label, 'call panel did not appear');
    else {
      await page.click('#c-mute'); await sleep(200);
      await page.click('#c-video').catch(() => {}); await sleep(600);
      // the same button starts and leaves the call
      await page.click('#room-call'); await sleep(800);
      if (await page.$('#call-panel .callpanel')) problem(label, 'call panel stayed after leaving');
    }
    await page.click('#room-people'); await sleep(400);
    await page.click('#overlay-box #pp-leave'); await sleep(400);
    await closeOverlayWith(page, label, '#c-ok');
    await sleep(500);
    if (!/^rooms$/.test(await heading(page))) problem(label, 'leaving the room did not return to the list');
  });

  await step(label, 'privacy: every control', async () => {
    await go(page, label, 'privacy', /^privacy$/);
    await page.fill('#b-url', 'wss://not-a-beacon.invalid:8443/ws'); await page.click('#b-connect'); await sleep(1500);
    // a new address while the bad one is still being tried: one press switches to it
    await page.fill('#b-url', `ws://localhost:${PORT}/ws`); await page.click('#b-connect');
    await page.waitForFunction(() => document.querySelector('#top-beacon')?.classList.contains('on'), null, { timeout: 10000 }).catch(() => problem(label, 'beacon did not connect to the local dev hub'));
    await page.click('#b-auto'); await sleep(200);
    await page.click('#b-connect'); await sleep(600);
    await page.click('[data-shield="0"]'); await sleep(300);
    if (await page.$eval('body', (b) => b.classList.contains('shield-on'))) problem(label, 'shield stayed on after turning it off');
    await page.click('[data-shield="1"]'); await sleep(300);
    for (const n of ['off', 'silent', 'sender']) { await page.click(`[data-notif="${n}"]`); await sleep(250); }
    await page.click('[data-tiles="osm"]'); await sleep(300); await closeOverlayWith(page, label, '#c-no');
    await page.click('[data-tiles="beacon"]'); await sleep(250); await page.click('[data-tiles="none"]'); await sleep(250);
    if (await page.$('#notif-ask')) { await page.click('#notif-ask'); await sleep(500); }
    await page.fill('#ice', 'stun:stun.example.org:3478'); await page.click('#ice-save'); await expectToast(page, label, /./);
  });

  await step(label, 'settings: theme, auto-lock, passphrase, backup, install, erase (cancelled)', async () => {
    await go(page, label, 'settings', /^settings$/);
    await page.click('[data-theme-pick="deep"]'); await sleep(400);
    if ((await page.$eval('html', (h) => h.dataset.theme)) !== 'deep') problem(label, 'deep theme not applied');
    await page.click('[data-theme-pick="night"]'); await sleep(400);
    if (await page.$eval('html', (h) => h.dataset.theme)) problem(label, 'night theme left a data-theme behind');
    await page.fill('#st-lock', '7'); await page.click('#st-lock-save'); await expectToast(page, label, /./);
    await page.fill('#p-old', 'wrong one'); await page.fill('#p-new', PASS2); await page.fill('#p-new2', PASS2);
    await page.click('#st-pass button[type="submit"], #st-pass .primary'); await expectToast(page, label, /./);
    await page.fill('#p-old', PASS); await page.fill('#p-new', PASS2); await page.fill('#p-new2', PASS2);
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
      (async () => { await page.click('#st-pass button[type="submit"], #st-pass .primary'); await sleep(2500); await page.click('#st-export'); })(),
    ]);
    if (!dl) problem(label, 'export produced no download');
    backupPath = dl ? await dl.path() : null;
    if (await page.$('#st-install')) { await page.click('#st-install'); await sleep(300); await closeOverlayWith(page, label, '#ins-ok'); }
    await page.click('#st-wipe'); await sleep(300); await closeOverlayWith(page, label, '#c-no');
  });

  await step(label, 'lock, unlock with the new passphrase, auto-lock value survived', async () => {
    await page.click('#lock-btn'); await page.waitForSelector('#unlock-form');
    await page.fill('#u-pass', PASS); await page.click('#u-submit'); await expectToast(page, label, /did not open/);
    await unlock(page, PASS2);
    await go(page, label, 'settings', /^settings$/);
    if ((await page.$eval('#st-lock', (i) => i.value)) !== '7') problem(label, 'auto-lock minutes did not persist');
  });

  await step(label, 'import the backup over itself: the type-to-confirm gate, then unlock again', async () => {
    if (backupPath) {
      await page.setInputFiles('#st-import', backupPath); await sleep(600);
      if (!(await overlayOpen(page))) problem(label, 'import did not ask for confirmation');
      else {
        await page.fill('#overlay-box #confirm-input', 'replace'); await sleep(100);
        await page.click('#overlay-box #c-ok');
        await page.waitForSelector('#unlock-form', { timeout: 15000 }).catch(() => problem(label, 'import did not return to the gate'));
        await unlock(page, PASS2);
      }
    }
  });

  await step(label, 'reload while unlocked: the gate comes back, nothing leaks, unlock works', async () => {
    await page.reload(); await unlock(page, PASS2);
    await go(page, label, 'notes', /^notes$/);
  });

  await ctx.close();
  log(`${label}: console`);
}

async function main() {
  const server = await serve();
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  try {
    await sweepLanding(browser, { width: 390, height: 844 }, 'phone');
    await sweepLanding(browser, { width: 1440, height: 900 }, 'desktop');
    await sweepConsole(browser, { width: 390, height: 844 }, 'phone');
    await sweepConsole(browser, { width: 1440, height: 900 }, 'desktop');
  } finally {
    await browser.close();
    server.kill();
  }
  if (problems.length) {
    console.error(`\n${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(1);
  }
  console.log('\nsweep clean: every screen rendered, every control answered, no errors.');
}

main().catch((e) => { console.error(e); process.exit(1); });
