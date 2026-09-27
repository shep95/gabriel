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
import { createHash } from 'node:crypto';
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
  // the beacon's dev-http mode serves web/ and the hub on one loopback port,
  // which is exactly the shape a phone sees on a hotspot (minus tls)
  const child = spawn('node', ['server.mjs', '--dev-http', String(PORT), '--https-port', '18443', '--http-port', '18080', '--data', '/tmp/gabriel-e2e-beacon', '--name', 'test room'], { cwd: path.resolve(webRoot, '..', 'beacon'), stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`${ORIGIN}/index.html`); if (r.ok) return child; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error('static server did not start');
}

const openPages = [];
async function newDevice(browser, name, offOrigin) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'dark', permissions: ['geolocation', 'microphone', 'camera'], geolocation: { latitude: 51.5007, longitude: -0.1246, accuracy: 12 }, acceptDownloads: true });
  context.on('request', (req) => { const u = req.url(); if (!u.startsWith(ORIGIN) && !u.startsWith(`blob:${ORIGIN}`)) offOrigin.push(u); });
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
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
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

    // 7. rooms through the beacon: a and b pair already; connect both, found a
    //    room on a, add b, exchange messages, share a location, hold a call
    await A.context.setOffline(false); await B.context.setOffline(false);
    await A.page.goto(`${ORIGIN}/app.html`);
    await unlock(A.page, 'correct horse battery');
    await B.page.goto(`${ORIGIN}/app.html`);
    await unlock(B.page, 'rotated passphrase 2');
    for (const D of [A, B]) {
      await D.page.click('a[data-route="privacy"]');
      await D.page.fill('#b-url', `ws://127.0.0.1:${PORT}/ws`);
      await D.page.check('#b-auto');
      await D.page.click('#b-connect');
      await D.page.waitForFunction(() => document.querySelector('#nav-beacon')?.classList.contains('on'), null, { timeout: 15000 });
    }
    log('both devices connected to the beacon');

    await A.page.click('a[data-route="rooms"]');
    await A.page.click('#room-new');
    await A.page.fill('#pd', 'north stairwell');
    await A.page.click('#pd-ok');
    await A.page.waitForSelector('#timeline');
    await A.page.click('#room-people');
    await A.page.waitForSelector('[data-add]');
    await A.page.click('[data-add]');
    await A.page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('added'));
    // b learns about the room over its pair inbox
    await B.page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('added to north stairwell'), null, { timeout: 15000 });
    await B.page.click('a[data-route="rooms"]');
    await B.page.waitForSelector('.item-row');
    await B.page.click('.item-row a');
    await B.page.waitForSelector('#timeline');

    await A.page.fill('#compose', 'water at the second landing');
    await A.page.click('#send');
    await B.page.waitForFunction(() => document.querySelector('#timeline')?.textContent.includes('water at the second landing'), null, { timeout: 15000 });
    await B.page.fill('#compose', 'on my way, bringing the blue key');
    await B.page.press('#compose', 'Enter');
    await A.page.waitForFunction(() => document.querySelector('#timeline')?.textContent.includes('bringing the blue key'), null, { timeout: 15000 });
    // shield: the message text sits behind a blur until held
    const shielded = await B.page.$eval('.bubble .txt', (el) => el.hasAttribute('data-shielded') && getComputedStyle(el).filter.includes('blur'));
    assert(shielded, 'room messages are shielded by default');
    await B.page.screenshot({ path: path.join(shots, 'room.png') });
    log('room: b was added over the pair channel, messages flow both ways, shield active');

    // a stranger's beacon frame must be ignored: publish garbage on the room's tag via the raw socket
    // (the tag is private to members; we just check the ui stays intact after junk on a random tag)
    await A.page.evaluate((port) => new Promise((res) => { const w = new WebSocket(`ws://127.0.0.1:${port}/ws`); w.onopen = () => w.send(JSON.stringify({ t: 'hello', v: 1 })); w.onmessage = (m) => { const j = JSON.parse(m.data); if (j.t === 'welcome') { w.send(JSON.stringify({ t: 'pub', tag: 'ab'.repeat(32), data: 'junk', keep: true, id: 'x' })); setTimeout(() => { w.close(); res(); }, 200); } }; }), PORT);

    // location: a shares once, b sees it in "where"
    await A.page.click('#room-where');
    await A.page.click('#wh-share');
    await A.page.waitForFunction(() => document.querySelector('#wh-status')?.textContent.includes('shared once'), null, { timeout: 15000 });
    await A.page.click('#wh-close');
    await B.page.waitForFunction(() => document.querySelector('#timeline')?.textContent.includes('location'), null, { timeout: 15000 });
    await B.page.click('#room-where');
    await B.page.waitForFunction(() => document.querySelector('#wh-list')?.textContent.includes('ada'), null, { timeout: 5000 });
    await B.page.click('#wh-locate');
    await B.page.waitForFunction(() => document.querySelector('#wh-list')?.textContent.includes('bearing'), null, { timeout: 10000 });
    await B.page.screenshot({ path: path.join(shots, 'where.png') });
    await B.page.click('#wh-close');
    log('location: shared once, received, radar has a bearing');

    // call: both join, webrtc connects over loopback
    await A.page.click('#room-call');
    await A.page.waitForSelector('.callpanel');
    await B.page.click('#room-call');
    await B.page.waitForSelector('.callpanel');
    await A.page.waitForFunction(() => document.querySelector('.callpanel .who')?.textContent.includes('connected'), null, { timeout: 30000 });
    await B.page.waitForFunction(() => document.querySelector('.callpanel .who')?.textContent.includes('connected'), null, { timeout: 30000 });
    await A.page.screenshot({ path: path.join(shots, 'call.png') });
    await A.page.click('#c-mute');
    await A.page.waitForFunction(() => document.querySelector('#c-mute')?.textContent === 'unmute');
    await B.page.click('#room-call');
    await A.page.waitForFunction(() => !document.querySelector('.callpanel .who')?.textContent.includes('connected'), null, { timeout: 15000 });
    await A.page.click('#room-call');
    log('call: two peers connected peer to peer, mute works, leaving tears down');

    // markup in a message must render as text, never as elements
    await A.page.fill('#compose', '<img src=x onerror=alert(1)><b>bold?</b>');
    await A.page.click('#send');
    await B.page.waitForFunction(() => document.querySelector('#timeline')?.textContent.includes('<img src=x'), null, { timeout: 15000 });
    const injected = await B.page.$$eval('#timeline img, #timeline b', (els) => els.length);
    assert(injected === 0, 'message markup is escaped');
    log('injection: markup arrives as text');

    // direct chat: b messages a one to one over the pair channel, then a 1:1 call
    await B.page.click('a[data-route="devices"]');
    await B.page.click('[data-act="message"]');
    await B.page.waitForSelector('#compose');
    await B.page.fill('#compose', 'just us: meet at the gate');
    await B.page.press('#compose', 'Enter');
    await A.page.click('a[data-route="rooms"]');
    await A.page.waitForFunction(() => document.body.textContent.includes('bao'), null, { timeout: 15000 });
    await A.page.click('a[href^="#/rooms/dm:"]');
    await A.page.waitForFunction(() => document.querySelector('#timeline')?.textContent.includes('meet at the gate'), null, { timeout: 15000 });
    await A.page.fill('#compose', 'coming');
    await A.page.click('#send');
    await B.page.waitForFunction(() => document.querySelector('#timeline')?.textContent.includes('coming'), null, { timeout: 15000 });
    await A.page.click('#room-call');
    await A.page.waitForSelector('.callpanel');
    await B.page.click('#room-call');
    await A.page.waitForFunction(() => document.querySelector('.callpanel .who')?.textContent.includes('connected'), null, { timeout: 30000 });
    await B.page.waitForFunction(() => document.querySelector('.callpanel .who')?.textContent.includes('connected'), null, { timeout: 30000 });
    await A.page.screenshot({ path: path.join(shots, 'dm-call.png') });
    await A.page.click('#room-call');
    await B.page.waitForFunction(() => !document.querySelector('.callpanel .who')?.textContent.includes('connected'), null, { timeout: 15000 });
    await B.page.click('#room-call');
    log('direct chat: messages both ways and a one-to-one call connected');

    // media over the pair channel: a photo (re-encoded, exif gone, bounded), a
    // file too large for one frame (chunked, byte-exact), a voice clip
    const png = await A.page.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 2400; c.height = 1600;
      const x = c.getContext('2d');
      const g = x.createLinearGradient(0, 0, 2400, 1600); g.addColorStop(0, '#1c5b9c'); g.addColorStop(1, '#e0a262');
      x.fillStyle = g; x.fillRect(0, 0, 2400, 1600);
      for (let i = 0; i < 1200; i++) { x.fillStyle = `hsl(${(i * 7) % 360} 70% 60%)`; x.fillRect((i * 373) % 2400, (i * 199) % 1600, 40, 40); }
      const b = await new Promise((r) => c.toBlob(r, 'image/png'));
      return new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result.split(',')[1]); fr.readAsDataURL(b); });
    });
    const t0 = Date.now(); // the clock starts when the picker hands the file over
    await A.page.setInputFiles('#attach-input', { name: 'meadow.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await B.page.waitForSelector('.bubble.media img', { timeout: 30000 });
    const photo = await B.page.$eval('.bubble.media img', (img) => new Promise((r) => { const done = () => r({ w: img.naturalWidth, h: img.naturalHeight, shielded: img.hasAttribute('data-shielded'), blur: getComputedStyle(img).filter }); if (img.complete && img.naturalWidth) done(); else img.onload = done; }));
    assert(photo.w > 0 && photo.w <= 1600 && photo.h <= 1600, `photo re-encoded within bounds, got ${photo.w}x${photo.h}`);
    assert(photo.shielded && /blur/.test(photo.blur), 'received photo is shielded (blurred until held)');
    const photoMeta = await B.page.$eval('.bubble.media .media-meta', (m) => m.textContent);
    assert(/photo/.test(photoMeta), 'photo bubble labelled');
    const photoMs = Date.now() - t0;

    const fileBytes = Buffer.alloc(700 * 1024); for (let i = 0; i < fileBytes.length; i++) fileBytes[i] = (i * 2654435761 >>> 24) & 0xff;
    const fileHash = createHash('sha256').update(fileBytes).digest('hex');
    const t1 = Date.now();
    await A.page.setInputFiles('#attach-input', { name: 'survey.bin', mimeType: 'application/octet-stream', buffer: fileBytes });
    await B.page.waitForSelector('.bubble.media a.media-file', { timeout: 60000 });
    // "tap to save" is the real path (the page's csp forbids fetching blobs, on purpose)
    const [dl] = await Promise.all([B.page.waitForEvent('download', { timeout: 15000 }), B.page.click('.bubble.media a.media-file')]);
    const savedPath = await dl.path();
    const saved = fs.readFileSync(savedPath);
    const got = { size: saved.length, hash: createHash('sha256').update(saved).digest('hex'), name: dl.suggestedFilename(), label: await B.page.$eval('.bubble.media a.media-file', (a) => a.textContent) };
    assert(got.size === fileBytes.length && got.hash === fileHash, `700 kb file arrives byte-exact in ${Math.ceil(fileBytes.length / (84 * 1024))} parts`);
    assert(got.name === 'survey.bin' && /700 kb/.test(got.label), `file name and size shown (${got.name}, ${got.label})`);
    const fileMs = Date.now() - t1;

    const t2 = Date.now();
    const micBox = await A.page.$('#mic');
    assert(micBox && !(await A.page.$eval('#mic', (m) => m.hidden)), 'voice clip control present');
    const mb = await micBox.boundingBox();
    await A.page.mouse.move(mb.x + mb.width / 2, mb.y + mb.height / 2);
    await A.page.mouse.down();
    await A.page.waitForFunction(() => /recording/.test(document.querySelector('#send-status')?.textContent || ''), null, { timeout: 5000 });
    await A.page.waitForTimeout(1500);
    await A.page.mouse.up();
    await B.page.waitForSelector('.bubble.media audio', { timeout: 30000 });
    const clip = await B.page.$eval('.bubble.media .media-audio .media-meta', (m) => m.textContent);
    assert(/voice/.test(clip), `voice clip labelled (${clip})`);
    const voiceMs = Date.now() - t2;
    log(`media: photo ${photoMs} ms, 700 kb file ${fileMs} ms, voice clip ${voiceMs} ms, all sealed, file byte-exact`);

    // the on-page keyboard: a passphrase typed without the system keyboard
    await A.page.click('#lock-btn');
    await A.page.waitForSelector('#unlock-form');
    await A.page.click('#u-quiet');
    await A.page.waitForSelector('.keypad');
    const layout1 = await A.page.$$eval('.keypad .row:nth-child(2) .k', (ks) => ks.map((k) => k.dataset.k).join(''));
    for (const ch of 'correct horse battery') await A.page.click(`.keypad .k[data-k="${ch}"]`);
    assert(await A.page.$eval('#u-pass', (i) => i.readOnly && i.getAttribute('inputmode') === 'none'), 'system keyboard is kept down while the on-page keyboard is open');
    await A.page.click('.keypad .k[data-k="done"]');
    await A.page.waitForSelector('.sidenav', { timeout: 60000 });
    await A.page.click('#lock-btn');
    await A.page.waitForSelector('#unlock-form');
    await A.page.click('#u-quiet');
    const layout2 = await A.page.$$eval('.keypad .row:nth-child(2) .k', (ks) => ks.map((k) => k.dataset.k).join(''));
    assert(layout1 !== layout2, 'the on-page keyboard shuffles between openings');
    await A.page.click('#u-quiet');
    await unlock(A.page, 'correct horse battery');
    await A.page.click('a[data-route="rooms"]');
    await A.page.click('a[href^="#/rooms/dm:"]');
    await A.page.waitForSelector('#compose');
    log('on-page keyboard: unlocked with a shuffled keypad, layout differs each time');

    // back to the room for the rotation check
    await A.page.click('a[data-route="rooms"]');
    await A.page.click('.item-row a[href^="#/rooms/"]:not([href*="dm:"])');
    await A.page.waitForSelector('#timeline');
    await B.page.click('a[data-route="rooms"]');
    await B.page.click('.item-row a[href^="#/rooms/"]:not([href*="dm:"])');
    await B.page.waitForSelector('#timeline');

    // removal rotates the key: b stops receiving
    await A.page.click('#room-people');
    await A.page.click('[data-remove]');
    await A.page.click('#c-ok');
    await A.page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('rotated'));
    await A.page.fill('#compose', 'after rotation');
    await A.page.click('#send');
    await A.page.waitForTimeout(1500);
    const leaked = await B.page.$eval('#timeline', (el) => el.textContent.includes('after rotation'));
    assert(!leaked, 'a removed member does not receive messages sealed under the new key');
    log('removal: key rotated, removed member sees nothing new');

    // the beacon is on-origin here (same loopback origin), so the off-origin check below still holds
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
