// end-to-end check of the console in headless chromium.
// run: node web/tests/e2e.mjs   (needs playwright + a chromium it can find)
//
// what it proves:
//   1. the landing page and app load, register the worker and cache themselves
//   2. profile creation, lock, wrong passphrase rejected, unlock
//   3. the app keeps working with the browser offline (worker-served)
//   4. two devices pair by exchanging codes and derive the same six digits
//   5. an encrypted transfer round-trips and a replay is recognised
//   6. no request ever leaves the origin

import { spawn, execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// prefer a local install; fall back to the global one (esm ignores NODE_PATH)
async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* not local */ }
  const globalRoot = execSync('npm root -g').toString().trim();
  return import(pathToFileURL(path.join(globalRoot, 'playwright', 'index.mjs')).href);
}
const { chromium } = await loadPlaywright();
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');
const PORT = 8765;
const ORIGIN = `http://localhost:${PORT}`;
const shots = path.join(here, 'shots');
fs.mkdirSync(shots, { recursive: true });

function assert(cond, msg) { if (!cond) throw new Error(`assertion failed: ${msg}`); }
const log = (...a) => console.log('  ', ...a);

async function serve() {
  const child = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: webRoot, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`${ORIGIN}/index.html`); if (r.ok) return child; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error('static server did not start');
}

const openPages = [];
async function newDevice(browser, name, offOrigin) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  context.on('request', (req) => { if (!req.url().startsWith(ORIGIN)) offOrigin.push(req.url()); });
  const page = await context.newPage();
  page.on('pageerror', (e) => { console.error(`${name} page error:`, e.message); });
  page.on('console', (m) => { if (m.type() === 'error') console.error(`${name} console:`, m.text()); });
  openPages.push({ name, page });
  return { context, page, name };
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

async function waitForOfflineReady(page) {
  // the worker installs asynchronously on first load; poll readiness
  for (let i = 0; i < 60; i++) {
    const ready = await page.evaluate(async () => {
      const keys = await caches.keys();
      for (const k of keys) { const c = await caches.open(k); if (await c.match('./app.html', { ignoreSearch: true }) && await c.match('./vendor/jsQR.js')) return !!navigator.serviceWorker.controller; }
      return false;
    });
    if (ready) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('worker never became ready');
}

async function main() {
  const server = await serve();
  const browser = await chromium.launch();
  const offOrigin = [];
  try {
    // 1. landing page
    const landing = await newDevice(browser, 'landing', offOrigin);
    await landing.page.goto(`${ORIGIN}/index.html`);
    await landing.page.waitForSelector('#hero-title');
    await waitForOfflineReady(landing.page);
    await landing.page.reload();
    await landing.page.waitForFunction(() => document.querySelector('#pill-cached')?.classList.contains('on'), null, { timeout: 15000 });
    await landing.page.screenshot({ path: path.join(shots, 'landing-mobile.png'), fullPage: true });
    const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
    await desktop.goto(`${ORIGIN}/index.html`);
    await desktop.waitForSelector('#hero-title');
    await desktop.waitForTimeout(1200);
    await desktop.screenshot({ path: path.join(shots, 'landing-desktop.png') });
    await desktop.close();
    await landing.context.close();
    log('landing page loads and reports itself cached');

    // 2. device a: create, lock, unlock
    const A = await newDevice(browser, 'A', offOrigin);
    await createProfile(A.page, 'ada', 'correct horse battery');
    await A.page.screenshot({ path: path.join(shots, 'app-overview.png') });
    const fpA = await A.page.$eval('.fp', (el) => el.textContent.trim());
    assert(fpA.length > 20, 'fingerprint rendered');
    await A.page.click('#lock-btn');
    await A.page.waitForSelector('#unlock-form');
    await A.page.fill('#u-pass', 'wrong passphrase');
    await A.page.click('#u-submit');
    await A.page.waitForFunction(() => document.querySelector('#toast')?.classList.contains('error'));
    assert(await A.page.$('.sidenav') === null, 'wrong passphrase stays locked');
    await unlock(A.page, 'correct horse battery');
    log('create / lock / wrong passphrase rejected / unlock');

    // 3. offline: worker must serve everything
    await waitForOfflineReady(A.page);
    await A.context.setOffline(true);
    await A.page.goto(`${ORIGIN}/app.html`);
    await unlock(A.page, 'correct horse battery');
    const readyText = await A.page.$eval('.stat .v', (el) => el.textContent.trim());
    assert(readyText === 'ready', `offline card says ready, got "${readyText}"`);
    await A.page.goto(`${ORIGIN}/index.html`);
    await A.page.waitForSelector('#hero-title');
    await A.page.goto(`${ORIGIN}/app.html`);
    await unlock(A.page, 'correct horse battery');
    log('app and landing load and unlock with the network off');

    // 4. pairing with device b (b stays offline too once cached)
    const B = await newDevice(browser, 'B', offOrigin);
    await createProfile(B.page, 'bao', 'another long passphrase');
    await waitForOfflineReady(B.page);
    await B.context.setOffline(true);

    await A.page.click('a[data-route="devices"]');
    await A.page.click('#pair-btn');
    await A.page.waitForSelector('#my-code');
    const codeA = await A.page.$eval('#my-code', (el) => el.textContent);
    await B.page.click('a[data-route="devices"]');
    await B.page.click('#pair-btn');
    await B.page.waitForSelector('#my-code');
    const codeB = await B.page.$eval('#my-code', (el) => el.textContent);
    assert(codeA.startsWith('GBR1-') && codeB.startsWith('GBR1-'), 'pairing codes have the prefix');
    await A.page.screenshot({ path: path.join(shots, 'pairing.png') });

    await A.page.fill('#their-text', codeB.toLowerCase()); // case must not matter
    await A.page.click('#read-theirs');
    await A.page.waitForSelector('#sas');
    await B.page.fill('#their-text', codeA);
    await B.page.click('#read-theirs');
    await B.page.waitForSelector('#sas');
    const sasA = await A.page.$eval('#sas', (el) => el.textContent.replace(/\s/g, ''));
    const sasB = await B.page.$eval('#sas', (el) => el.textContent.replace(/\s/g, ''));
    assert(/^\d{6}$/.test(sasA), 'sas is six digits');
    assert(sasA === sasB, `both devices derive the same sas (${sasA} vs ${sasB})`);
    await A.page.screenshot({ path: path.join(shots, 'sas.png') });
    await A.page.click('#sas-yes');
    await B.page.click('#sas-yes');
    await A.page.waitForSelector('.item-row.trust');
    await B.page.waitForSelector('.item-row.trust');
    assert((await A.page.$eval('.item-row .name', (el) => el.textContent)).includes('bao'), 'a lists b');
    assert((await B.page.$eval('.item-row .name', (el) => el.textContent)).includes('ada'), 'b lists a');
    log(`pairing: identical sas ${sasA} on both devices, both saved as verified`);

    // own code must be refused
    await A.page.click('#pair-btn');
    await A.page.waitForSelector('#my-code');
    const ownCode = await A.page.$eval('#my-code', (el) => el.textContent);
    await A.page.fill('#their-text', ownCode);
    await A.page.click('#read-theirs');
    await A.page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('your own code'));
    await A.page.click('#pair-cancel');

    // 5. transfer a -> b
    await A.page.click('a[data-route="notes"]');
    await A.page.click('#note-new');
    await A.page.fill('#n-title', 'water point');
    await A.page.fill('#n-body', 'north stairwell, second landing. tap works after 6pm. bring the blue key.\n' + 'x'.repeat(1200));
    await A.page.click('#n-save');
    await A.page.waitForSelector('.item-row');
    await A.page.click('a[data-route="transfer"]');
    await A.page.waitForSelector('#s-make');
    await A.page.selectOption('#s-note', { index: 1 });
    await A.page.click('#s-make');
    await A.page.waitForSelector('#env-copy', { state: 'attached' });
    const frameCount = await A.page.$eval('#frame-counter', (el) => el.textContent).catch(() => 'frame 1 of 1');
    assert(/of [2-9]/.test(frameCount), `long note becomes multiple frames (${frameCount})`);
    const envelope = await A.page.$eval('.codebox', (el) => el.textContent);
    await A.page.screenshot({ path: path.join(shots, 'transfer-send.png') });

    await B.page.click('a[data-route="transfer"]');
    await B.page.click('#t-recv');
    await B.page.waitForSelector('#r-text');
    await B.page.fill('#r-text', envelope);
    await B.page.click('#r-read');
    await B.page.waitForSelector('#r-save');
    const received = await B.page.$eval('#r-out h3', (el) => el.textContent);
    assert(received === 'water point', `b decrypted the note title (${received})`);
    await B.page.screenshot({ path: path.join(shots, 'transfer-receive.png') });
    await B.page.click('#r-save');
    await B.page.waitForSelector('.item-row');
    assert((await B.page.$eval('.item-row .name', (el) => el.textContent)).includes('water point'), 'b saved the note');

    // replay: same envelope again is recognised
    await B.page.click('a[data-route="transfer"]');
    await B.page.click('#t-recv');
    await B.page.fill('#r-text', envelope);
    await B.page.click('#r-read');
    await B.page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('already received'));

    // wrong recipient: a third device cannot open it
    const C = await newDevice(browser, 'C', offOrigin);
    await createProfile(C.page, 'cy', 'third device passphrase');
    await C.page.click('a[data-route="transfer"]');
    await C.page.click('#t-recv');
    await C.page.fill('#r-text', envelope);
    await C.page.click('#r-read');
    await C.page.waitForFunction(() => document.querySelector('#r-out')?.textContent.includes('not paired'));
    log('transfer: multi-frame envelope decrypts on b, replay detected, stranger cannot open it');

    // 6. persistence across reload (offline) and lock via settings change
    await B.page.goto(`${ORIGIN}/app.html`);
    await unlock(B.page, 'another long passphrase');
    await B.page.click('a[data-route="notes"]');
    await B.page.waitForSelector('.item-row');
    await B.page.click('a[data-route="settings"]');
    await B.page.fill('#p-old', 'another long passphrase');
    await B.page.fill('#p-new', 'rotated passphrase 2');
    await B.page.fill('#p-new2', 'rotated passphrase 2');
    await B.page.click('#st-pass button[type="submit"]');
    await B.page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('changed'));
    await B.page.click('#lock-btn');
    await unlock(B.page, 'rotated passphrase 2');
    await B.page.click('a[data-route="devices"]');
    await B.page.waitForSelector('.item-row.trust');
    log('data survives reload offline; passphrase rotation keeps the vault readable');

    assert(offOrigin.length === 0, `no off-origin requests (saw ${offOrigin.join(', ')})`);
    log('no request left the origin during any flow');

    await A.context.close(); await B.context.close(); await C.context.close();
    console.log('\nall checks passed. screenshots in', shots);
  } catch (e) {
    for (const { name, page } of openPages) {
      try {
        if (page.isClosed()) continue;
        await page.screenshot({ path: path.join(shots, `fail-${name}.png`) });
        console.error(`${name} toast:`, await page.$eval('#toast', (t) => t.className + ' | ' + t.textContent).catch(() => 'n/a'));
        console.error(`${name} url:`, page.url(), 'body starts:', (await page.evaluate(() => document.body.innerText.slice(0, 200))).replace(/\n/g, ' / '));
      } catch { /* best effort */ }
    }
    throw e;
  } finally {
    await browser.close();
    server.kill();
  }
}

main().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
