// gabriel console: the application. one module, hash routing, no framework.
// state lives in memory while unlocked and is thrown away on lock.

import { b64url, hex, b32, escapeHtml, fingerprintPretty, uuid, nowIso, relativeTime } from './util.js';
import {
  cryptoAvailable, createVault, unlockVault, rewrapVault, sealRecord, openRecord,
  generateIdentity, importPrivate, buildInvite, parseInvite, derivePair,
  sealMessage, parseEnvelopeHeader, openMessage, chunkForQr, parseChunk,
  INVITE_PREFIX, ENVELOPE_PREFIX, CHUNK_PREFIX,
} from './crypto.js';
import * as db from './db.js';
import { renderQr } from './qr.js';
import { cameraAvailable, startScanner } from './scan.js';
import { registerServiceWorker, offlineReadiness, watchOnline } from './status.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const root = $('#root');

const state = {
  profile: null,      // { id:'profile', name, createdAt, kdf, wrap, version }
  settings: { autoLockMinutes: 5 },
  vaultKey: null,     // CryptoKey while unlocked
  identity: null,     // { pub: Uint8Array, fingerprint, privateKey: CryptoKey }
  devices: [],        // decrypted device records
  notes: [],          // decrypted notes
  route: 'overview',
  lockTimer: null,
  unlockedAt: null,
  readiness: null,
};

// ---------- small ui helpers ----------

let toastTimer = null;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), kind === 'error' ? 5200 : 3200);
}

function openOverlay(html) {
  const o = $('#overlay');
  $('#overlay-box').innerHTML = html;
  o.hidden = false;
  requestAnimationFrame(() => o.classList.add('show'));
  return $('#overlay-box');
}
function closeOverlay() {
  const o = $('#overlay');
  o.classList.remove('show');
  setTimeout(() => { o.hidden = true; $('#overlay-box').innerHTML = ''; }, 240);
}
$('#overlay').addEventListener('click', (e) => { if (e.target.id === 'overlay') closeOverlay(); });

function confirmDialog({ title, body, okLabel = 'continue', danger = false, typeToConfirm = null }) {
  return new Promise((resolve) => {
    const box = openOverlay(`
      <h3>${escapeHtml(title)}</h3>
      <p style="margin-top:.6rem">${body}</p>
      ${typeToConfirm ? `<div class="field" style="margin-top:1rem"><label>type <span class="mono">${escapeHtml(typeToConfirm)}</span> to continue</label><input type="text" id="confirm-input" autocomplete="off" autocapitalize="off" spellcheck="false"></div>` : ''}
      <div class="row" style="margin-top:1.2rem;justify-content:flex-end">
        <button class="ghost" id="c-no">cancel</button>
        <button class="${danger ? 'danger' : 'primary'}" id="c-ok" ${typeToConfirm ? 'disabled' : ''}>${escapeHtml(okLabel)}</button>
      </div>`);
    const ok = $('#c-ok', box);
    if (typeToConfirm) {
      const input = $('#confirm-input', box);
      input.focus();
      input.addEventListener('input', () => { ok.disabled = input.value.trim() !== typeToConfirm; });
    }
    $('#c-no', box).onclick = () => { closeOverlay(); resolve(false); };
    ok.onclick = () => { closeOverlay(); resolve(true); };
  });
}

function download(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('copied', 'ok');
  } catch {
    toast('clipboard blocked here; select the text and copy it by hand', 'error');
  }
}

// ---------- lock / idle ----------

function armIdleLock() {
  clearTimeout(state.lockTimer);
  const mins = Number(state.settings.autoLockMinutes) || 0;
  if (!state.vaultKey || mins <= 0) return;
  state.lockTimer = setTimeout(() => { lock('locked after inactivity'); }, mins * 60 * 1000);
}
for (const ev of ['pointerdown', 'keydown', 'touchstart']) document.addEventListener(ev, armIdleLock, { passive: true });

function lock(reason) {
  state.vaultKey = null;
  state.identity = null;
  state.devices = [];
  state.notes = [];
  state.unlockedAt = null;
  clearTimeout(state.lockTimer);
  stopActiveScanner();
  stopFrameCycle();
  $('#lock-btn').hidden = true;
  $('#who').textContent = '';
  if (location.hash) history.replaceState(null, '', location.pathname);
  renderGate();
  if (reason) toast(reason);
}
$('#lock-btn').addEventListener('click', () => lock());

// ---------- data access (all sealed under the vault key) ----------

async function loadProfile() {
  state.profile = (await db.get('meta', 'profile')) || null;
  const s = await db.get('meta', 'settings');
  if (s) state.settings = { ...state.settings, ...s.value };
}

async function loadUnlockedData() {
  const idRec = await db.get('meta', 'identity');
  if (!idRec) throw new Error('identity record missing');
  const priv = await openRecord(state.vaultKey, 'meta', 'identity', idRec.enc);
  state.identity = {
    pub: b64url.decode(idRec.pub),
    fingerprint: idRec.fingerprint,
    privateKey: await importPrivate(b64url.decode(priv.pkcs8)),
  };
  const devRecs = await db.all('devices');
  state.devices = [];
  for (const r of devRecs) {
    try { state.devices.push({ id: r.id, ...(await openRecord(state.vaultKey, 'devices', r.id, r.enc)) }); }
    catch { /* a record sealed under a different key is unreadable; leave it out rather than crash */ }
  }
  const noteRecs = await db.all('notes');
  state.notes = [];
  for (const r of noteRecs) {
    try { state.notes.push({ id: r.id, ...(await openRecord(state.vaultKey, 'notes', r.id, r.enc)) }); }
    catch { /* same */ }
  }
  state.notes.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  state.devices.sort((a, b) => (b.pairedAt || '').localeCompare(a.pairedAt || ''));
}

async function saveDevice(dev) {
  const { id, ...plain } = dev;
  await db.put('devices', { id, enc: await sealRecord(state.vaultKey, 'devices', id, plain) });
  const i = state.devices.findIndex((d) => d.id === id);
  if (i >= 0) state.devices[i] = dev; else state.devices.unshift(dev);
}

async function saveNote(note) {
  const { id, ...plain } = note;
  await db.put('notes', { id, enc: await sealRecord(state.vaultKey, 'notes', id, plain) });
  const i = state.notes.findIndex((n) => n.id === id);
  if (i >= 0) state.notes[i] = note; else state.notes.unshift(note);
  state.notes.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

async function saveSettings() {
  await db.put('meta', { id: 'settings', value: state.settings });
}

// ---------- gate: create / unlock ----------

function signalMarkup(trust = false) {
  return `<div class="signal" data-trust="${trust}" aria-hidden="true"><svg viewBox="0 0 1000 1000"><circle cx="500" cy="500" r="480"/><circle cx="500" cy="500" r="480"/><circle cx="500" cy="500" r="480"/></svg></div>`;
}

function renderGate() {
  if (!cryptoAvailable()) {
    root.innerHTML = `<div class="gate">${signalMarkup()}<div class="panel"><h1>this browser cannot run the console</h1><p>web cryptography is missing. that usually means the page was opened over plain http from another machine. open it over https, or from localhost.</p></div></div>`;
    return;
  }
  if (!state.profile) renderCreate(); else renderUnlock();
}

function renderCreate() {
  root.innerHTML = `
    <div class="gate">${signalMarkup()}
      <div class="panel">
        <div class="eyebrow reveal in">first run on this device</div>
        <h1 class="reveal in" style="--i:1">choose a name and a passphrase.</h1>
        <p class="reveal in" style="--i:2">the name is what other devices will see when you pair. the passphrase never leaves this device and cannot be reset.</p>
        <form id="create-form" class="reveal in" style="--i:3" autocomplete="off">
          <div class="field"><label for="c-name">name</label><input id="c-name" type="text" maxlength="24" required autocomplete="nickname" autocapitalize="off"></div>
          <div class="field"><label for="c-pass">passphrase</label><input id="c-pass" type="password" minlength="8" required autocomplete="new-password"><div class="hint" id="c-hint">length matters more than symbols. four unrelated words is a good passphrase.</div></div>
          <div class="field"><label for="c-pass2">again</label><input id="c-pass2" type="password" required autocomplete="new-password"></div>
          <div class="actions"><button class="primary" type="submit" id="c-submit">create</button><span class="hint" id="c-status"></span></div>
        </form>
        <p class="fine reveal in" style="--i:4">key derivation runs 600 000 rounds on this device; on a slow phone that takes a second or two. nothing is uploaded, because there is nowhere to upload to.</p>
      </div>
    </div>`;
  const form = $('#create-form');
  const pass = $('#c-pass'), pass2 = $('#c-pass2'), hint = $('#c-hint');
  pass.addEventListener('input', () => {
    const n = pass.value.length;
    hint.textContent = n === 0 ? 'length matters more than symbols. four unrelated words is a good passphrase.'
      : n < 8 ? `${8 - n} more characters needed` : n < 14 ? 'acceptable. longer is better.' : 'good length.';
    hint.classList.toggle('warn', n > 0 && n < 8);
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#c-name').value.trim();
    if (!name) return toast('a name is needed', 'error');
    if (pass.value.length < 8) return toast('passphrase needs at least 8 characters', 'error');
    if (pass.value !== pass2.value) return toast('the two passphrases differ', 'error');
    const btn = $('#c-submit'); btn.disabled = true; $('#c-status').textContent = 'deriving keys…';
    try {
      const v = await createVault(pass.value);
      const idn = await generateIdentity();
      const enc = await sealRecord(v.vaultKey, 'meta', 'identity', { pkcs8: b64url.encode(idn.pkcs8) });
      const profile = { id: 'profile', name, createdAt: nowIso(), kdf: v.kdf, wrap: v.wrap, version: 1 };
      await db.put('meta', profile);
      await db.put('meta', { id: 'identity', pub: b64url.encode(idn.pub), fingerprint: idn.fingerprint, enc });
      await db.put('meta', { id: 'settings', value: state.settings });
      await db.requestPersistence();
      state.profile = profile;
      state.vaultKey = v.vaultKey;
      pass.value = ''; pass2.value = '';
      await enterApp();
      toast('profile created on this device', 'ok');
    } catch (err) {
      btn.disabled = false; $('#c-status').textContent = '';
      toast(`could not create profile: ${err.message}`, 'error');
    }
  });
  $('#c-name').focus();
}

function renderUnlock() {
  root.innerHTML = `
    <div class="gate">${signalMarkup()}
      <div class="panel">
        <div class="eyebrow reveal in">${escapeHtml(state.profile.name)}</div>
        <h1 class="reveal in" style="--i:1">unlock.</h1>
        <p class="reveal in" style="--i:2">everything on this device stays sealed until the passphrase opens it.</p>
        <form id="unlock-form" class="reveal in" style="--i:3">
          <div class="field"><label for="u-pass">passphrase</label><input id="u-pass" type="password" required autocomplete="current-password"></div>
          <div class="actions"><button class="primary" type="submit" id="u-submit">open</button><span class="hint" id="u-status"></span></div>
        </form>
        <p class="fine reveal in" style="--i:4">forgot it? there is no recovery. you can <a href="#" id="u-wipe">erase this device's console data</a> and start over.</p>
      </div>
    </div>`;
  const form = $('#unlock-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#u-pass');
    const btn = $('#u-submit'); btn.disabled = true; $('#u-status').textContent = 'checking…';
    try {
      state.vaultKey = await unlockVault(input.value, state.profile);
      input.value = '';
      await enterApp();
    } catch {
      state.vaultKey = null;
      btn.disabled = false; $('#u-status').textContent = '';
      input.value = ''; input.focus();
      toast('that passphrase did not open the vault', 'error');
    }
  });
  $('#u-wipe').addEventListener('click', async (e) => { e.preventDefault(); await wipeEverything(); });
  $('#u-pass').focus();
}

async function wipeEverything() {
  const ok = await confirmDialog({
    title: 'erase everything on this device',
    body: 'profile, identity key, paired devices and notes are deleted. nothing can bring them back. paired devices will need to pair again.',
    okLabel: 'erase', danger: true, typeToConfirm: 'erase',
  });
  if (!ok) return;
  try {
    await db.destroyDb();
    if ('caches' in window) { /* keep the app cache: the console itself stays installed */ }
    state.profile = null; state.vaultKey = null; state.identity = null; state.devices = []; state.notes = [];
    renderGate();
    toast('erased', 'ok');
  } catch (err) {
    toast(`erase failed: ${err.message}`, 'error');
  }
}

// ---------- shell + routing ----------

const ROUTES = [
  ['overview', 'overview'],
  ['devices', 'devices'],
  ['notes', 'notes'],
  ['transfer', 'transfer'],
  ['settings', 'settings'],
];

async function enterApp() {
  await loadUnlockedData();
  state.unlockedAt = nowIso();
  $('#who').textContent = state.profile.name;
  $('#lock-btn').hidden = false;
  armIdleLock();
  renderShell();
  if (!location.hash || !ROUTES.some(([r]) => location.hash === `#/${r}`)) location.hash = '#/overview';
  else route();
}

function renderShell() {
  root.innerHTML = `
    <div class="shell">
      <nav class="sidenav" aria-label="sections">
        ${ROUTES.map(([r, label]) => `<a href="#/${r}" data-route="${r}">${label}</a>`).join('')}
        <div class="spacer"></div>
        <div class="meta">unlocked ${relativeTime(state.unlockedAt)}<br>auto-lock ${state.settings.autoLockMinutes} min</div>
      </nav>
      <main class="content" id="content"></main>
    </div>`;
}

function route() {
  if (!state.vaultKey) {
    // lock() already drew the gate; the hashchange it caused must not redraw
    // it, or a passphrase typed in the meantime is thrown away mid-keystroke
    if (!$('#unlock-form') && !$('#create-form')) renderGate();
    return;
  }
  const r = (location.hash.replace(/^#\/?/, '') || 'overview').split('/')[0];
  state.route = ROUTES.some(([x]) => x === r) ? r : 'overview';
  $$('.sidenav a').forEach((a) => a.classList.toggle('active', a.dataset.route === state.route));
  stopActiveScanner();
  stopFrameCycle();
  const view = { overview: viewOverview, devices: viewDevices, notes: viewNotes, transfer: viewTransfer, settings: viewSettings }[state.route];
  view($('#content'));
}
window.addEventListener('hashchange', route);

// ---------- overview ----------

async function viewOverview(el) {
  const r = state.readiness || await offlineReadiness();
  state.readiness = r;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  el.innerHTML = `
    <section>
      <h2>${escapeHtml(state.profile.name)}</h2>
      <div class="sub">this device, sealed. ${state.devices.length} paired device${state.devices.length === 1 ? '' : 's'}, ${state.notes.length} note${state.notes.length === 1 ? '' : 's'}.</div>
      <div class="grid">
        <div class="card ${r.ready ? 'trust' : ''}">
          <div class="stat"><div class="k">offline</div><div class="v">${r.ready ? 'ready' : 'not yet'}</div><div class="d">${r.ready ? 'every file is cached on this device. the network can go.' : 'the cache is still filling, or this browser blocks it.'}</div></div>
        </div>
        <div class="card">
          <div class="stat"><div class="k">identity</div><div class="v" style="font-size:1rem" title="${escapeHtml(state.identity.fingerprint)}"><span class="fp">${fingerprintPretty(state.identity.fingerprint)}</span></div><div class="d">fingerprint of this device's pairing key. other devices see it when they pair with you.</div></div>
        </div>
        <div class="card">
          <div class="stat"><div class="k">since</div><div class="v">${new Date(state.profile.createdAt).toLocaleDateString()}</div><div class="d">profile created on this device. last unlock ${relativeTime(state.unlockedAt)}.</div></div>
        </div>
      </div>
      <div class="divider"></div>
      <h3>readiness, measured now</h3>
      <div class="readiness" style="margin-top:.8rem">
        ${readinessRow('secure context', r.secureContext, 'yes', 'no: needs https or localhost')}
        ${readinessRow('web cryptography', r.crypto, 'available', 'missing')}
        ${readinessRow('offline worker', r.controlled, 'controlling this page', 'not active')}
        ${readinessRow('app files cached', r.cached, 'complete', 'incomplete')}
        ${readinessRow('installed to home screen', standalone, 'yes', 'no (optional: browser menu → add to home screen)', true)}
        <div class="item"><span class="k">network right now</span><span class="v">${r.online ? 'connected, unused' : 'offline, unaffected'}</span></div>
      </div>
      <div class="divider"></div>
      <div class="row">
        <a href="#/devices"><button>pair a device</button></a>
        <a href="#/notes"><button>write a note</button></a>
        <a href="#/transfer"><button>hand something across</button></a>
      </div>
    </section>`;
}

function readinessRow(k, ok, yes, no, neutral = false) {
  return `<div class="item"><span class="k">${k}</span><span class="v ${ok ? 'on' : neutral ? '' : 'off'}">${ok ? yes : no}</span></div>`;
}

// ---------- devices + pairing ----------

let pairing = null; // { myInvite:{nonce,text}, theirs:{pub,nonce,name,fingerprint}|null, derived:{pairKey,sas}|null }

function viewDevices(el) {
  pairing = null;
  el.innerHTML = `
    <section>
      <div class="row between"><div><h2>devices</h2><div class="sub">devices that hold a key in common with this one.</div></div><button class="primary" id="pair-btn">pair a device</button></div>
      <div class="list" id="dev-list"></div>
    </section>`;
  renderDeviceList();
  $('#pair-btn').onclick = () => viewPairing(el);
}

function renderDeviceList() {
  const list = $('#dev-list');
  if (!list) return;
  if (!state.devices.length) {
    list.innerHTML = `<div class="empty">no paired devices yet. pairing needs both devices in the same room, or a way to move a short code between them.</div>`;
    return;
  }
  list.innerHTML = state.devices.map((d) => `
    <div class="item-row ${d.verified ? 'trust' : ''}" data-id="${d.id}">
      <div class="t"><div class="name">${escapeHtml(d.name)}</div><p class="sub mono" title="${escapeHtml(d.fingerprint)}">${fingerprintPretty(d.fingerprint)}</p><p class="sub">paired ${relativeTime(d.pairedAt)}${d.lastTransferAt ? ` · last transfer ${relativeTime(d.lastTransferAt)}` : ''}</p></div>
      <div class="a"><button class="small ghost" data-act="rename">rename</button><button class="small danger" data-act="forget">forget</button></div>
    </div>`).join('');
  list.onclick = async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const row = e.target.closest('.item-row');
    const dev = state.devices.find((d) => d.id === row.dataset.id);
    if (!dev) return;
    if (btn.dataset.act === 'forget') {
      const ok = await confirmDialog({ title: `forget ${dev.name}`, body: 'the shared key is deleted here. the other device keeps its copy until it forgets you too.', okLabel: 'forget', danger: true });
      if (!ok) return;
      await db.del('devices', dev.id);
      state.devices = state.devices.filter((d) => d.id !== dev.id);
      renderDeviceList();
      toast('forgotten');
    } else if (btn.dataset.act === 'rename') {
      const box = openOverlay(`<h3>rename device</h3><div class="field" style="margin-top:1rem"><label>name</label><input type="text" id="rn" maxlength="40" value="${escapeHtml(dev.name)}"></div><div class="row" style="justify-content:flex-end"><button class="ghost" id="rn-no">cancel</button><button class="primary" id="rn-ok">save</button></div>`);
      $('#rn', box).focus();
      $('#rn-no', box).onclick = closeOverlay;
      $('#rn-ok', box).onclick = async () => {
        const name = $('#rn', box).value.trim();
        if (!name) return;
        await saveDevice({ ...dev, name });
        closeOverlay(); renderDeviceList();
      };
    }
  };
}

function viewPairing(el) {
  const inv = buildInvite(state.identity.pub, state.profile.name);
  pairing = { myInvite: inv, theirs: null, derived: null };
  el.innerHTML = `
    <section>
      <div class="row between"><div><h2>pair a device</h2><div class="sub">show yours, read theirs. the order does not matter.</div></div><button class="ghost" id="pair-cancel">cancel</button></div>
      <div class="pairgrid">
        <div class="card">
          <h3>your code</h3>
          <div class="qrwrap"><div class="qrframe"><canvas id="my-qr" aria-label="your pairing code"></canvas></div></div>
          <div class="codebox" id="my-code">${escapeHtml(b32.group(inv.text))}</div>
          <div class="row" style="margin-top:.8rem"><button class="small" id="copy-mine">copy text</button><button class="small ghost" id="regen-mine">new code</button></div>
          <p class="hint" style="color:var(--dim);font-size:.8rem;margin-top:.8rem">contains this device's public key, a one-time number and your name. safe to show; useless to anyone who does not also hold the private key.</p>
        </div>
        <div class="card">
          <h3>their code</h3>
          <div id="their-state"></div>
          <div class="row" style="margin-top:.4rem">${cameraAvailable() ? '<button class="small" id="scan-theirs">scan with camera</button>' : ''}</div>
          <div class="field" style="margin-top:1rem"><label for="their-text">or paste the text</label><textarea id="their-text" rows="3" placeholder="${INVITE_PREFIX}-…" autocapitalize="characters" autocomplete="off" spellcheck="false"></textarea></div>
          <button class="small" id="read-theirs">read code</button>
        </div>
      </div>
      <div id="sas-area"></div>
    </section>`;
  try { renderQr($('#my-qr'), inv.text, { size: 240 }); } catch (e) { toast(`qr: ${e.message}`, 'error'); }
  $('#pair-cancel').onclick = () => viewDevices(el);
  $('#copy-mine').onclick = () => copyText(inv.text);
  $('#regen-mine').onclick = () => viewPairing(el);
  $('#read-theirs').onclick = () => acceptTheirInvite($('#their-text').value, el);
  const scanBtn = $('#scan-theirs');
  if (scanBtn) scanBtn.onclick = () => openScanner((text) => acceptTheirInvite(text, el, true), 'point the camera at the other device\'s pairing code');
  renderTheirState();
}

function renderTheirState() {
  const box = $('#their-state');
  if (!box) return;
  if (!pairing.theirs) { box.innerHTML = `<p class="hint" style="color:var(--muted)">nothing read yet.</p>`; return; }
  const t = pairing.theirs;
  box.innerHTML = `<div class="card" style="padding:.9rem 1rem;background:var(--bg-deep)"><div>${escapeHtml(t.name)}</div><div class="mono" style="color:var(--muted);font-size:.8rem;margin-top:.3rem">${fingerprintPretty(t.fingerprint)}</div></div>`;
}

async function acceptTheirInvite(text, el, fromScanner = false) {
  if (!pairing) return;
  let theirs;
  try { theirs = await parseInvite(text); }
  catch (e) { if (!fromScanner) toast(e.message, 'error'); return; }
  if (theirs.fingerprint === state.identity.fingerprint) { toast('that is your own code', 'error'); return; }
  if (fromScanner) closeScanner();
  pairing.theirs = theirs;
  renderTheirState();
  try {
    pairing.derived = await derivePair(state.identity.privateKey, pairing.myInvite.nonce, theirs.pub, theirs.nonce);
  } catch (e) { toast(`key agreement failed: ${e.message}`, 'error'); return; }
  renderSas(el);
}

function renderSas(el) {
  const area = $('#sas-area');
  const existing = state.devices.find((d) => d.fingerprint === pairing.theirs.fingerprint);
  area.innerHTML = `
    <div class="card trust" style="margin-top:1.2rem">
      <div class="eyebrow">compare on both screens</div>
      <div class="sas" id="sas">${pairing.derived.sas.split('').join(' ')}</div>
      <p>the other device shows six digits too, once it has read your code. same digits means the two devices share a secret that nobody in between could compute. ${existing ? `<br><strong style="font-weight:400;color:var(--text)">${escapeHtml(existing.name)} is already paired; confirming replaces its key.</strong>` : ''}</p>
      <div class="row" style="margin-top:1rem"><button class="accent" id="sas-yes">the digits match</button><button class="ghost" id="sas-no">they differ</button></div>
    </div>`;
  area.scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('#sas-yes').onclick = async () => {
    const t = pairing.theirs;
    const dev = {
      id: existing ? existing.id : uuid(),
      name: t.name,
      pub: b64url.encode(t.pub),
      fingerprint: t.fingerprint,
      pairKey: b64url.encode(pairing.derived.pairKey),
      verified: true,
      pairedAt: nowIso(),
      lastTransferAt: existing ? existing.lastTransferAt : null,
    };
    await saveDevice(dev);
    $('#sas').classList.add('matched');
    toast(`paired with ${t.name}`, 'ok');
    setTimeout(() => viewDevices(el), 900);
  };
  $('#sas-no').onclick = () => {
    area.innerHTML = `<div class="card" style="margin-top:1.2rem;border-color:var(--danger)"><p style="color:var(--danger)">not paired. different digits mean one side read a code that was not the other's. generate a new code on both devices and try again, in person.</p></div>`;
    pairing.theirs = null; pairing.derived = null; renderTheirState();
  };
}

// ---------- scanner overlay ----------

let activeScanner = null;
function openScanner(onText, caption) {
  stopActiveScanner();
  const box = openOverlay(`
    <div class="row between" style="margin-bottom:.8rem"><h3>scan</h3><button class="ghost small" id="scan-close">close</button></div>
    <div class="scanwrap"><video id="scan-video" muted playsinline></video><div class="reticle"></div></div>
    <p class="hint" style="color:var(--muted);font-size:.85rem;margin-top:.8rem" id="scan-caption">${escapeHtml(caption || '')}</p>`);
  $('#scan-close', box).onclick = closeScanner;
  activeScanner = startScanner($('#scan-video', box), (text, err) => {
    if (err) { toast(`camera: ${err.message || err}`, 'error'); closeScanner(); return; }
    if (text) onText(text);
  });
}
function closeScanner() { stopActiveScanner(); closeOverlay(); }
function stopActiveScanner() { if (activeScanner) { activeScanner.stop(); activeScanner = null; } }

// ---------- notes ----------

function viewNotes(el) {
  el.innerHTML = `
    <section>
      <div class="row between"><div><h2>notes</h2><div class="sub">sealed on this device. hand one to a paired device from the transfer tab.</div></div><button class="primary" id="note-new">new note</button></div>
      <div class="list" id="note-list"></div>
    </section>`;
  $('#note-new').onclick = () => editNote(el, null);
  renderNoteList(el);
}

function renderNoteList(el) {
  const list = $('#note-list');
  if (!state.notes.length) { list.innerHTML = `<div class="empty">nothing written yet.</div>`; return; }
  list.innerHTML = state.notes.map((n) => `
    <div class="item-row" data-id="${n.id}">
      <div class="t"><div class="name">${escapeHtml(n.title || 'untitled')}</div><p class="sub">${escapeHtml((n.body || '').slice(0, 90))}${(n.body || '').length > 90 ? '…' : ''}</p><p class="sub">${n.from ? `from ${escapeHtml(n.from)} · ` : ''}${relativeTime(n.updatedAt)}</p></div>
      <div class="a"><button class="small ghost" data-act="open">open</button></div>
    </div>`).join('');
  list.onclick = (e) => {
    const row = e.target.closest('.item-row');
    if (!row) return;
    editNote(el, state.notes.find((n) => n.id === row.dataset.id));
  };
}

function editNote(el, note) {
  const isNew = !note;
  const n = note || { id: uuid(), title: '', body: '', createdAt: nowIso(), updatedAt: nowIso() };
  el.innerHTML = `
    <section class="note-editor">
      <div class="row between"><h2>${isNew ? 'new note' : 'note'}</h2><div class="row"><button class="ghost" id="n-back">back</button>${isNew ? '' : '<button class="danger small" id="n-del">delete</button>'}</div></div>
      <div class="field" style="margin-top:1.2rem"><label for="n-title">title</label><input id="n-title" type="text" maxlength="120" value="${escapeHtml(n.title)}"></div>
      <div class="field"><label for="n-body">body</label><textarea id="n-body" maxlength="6000">${escapeHtml(n.body)}</textarea><div class="hint">up to 6000 characters. anything longer than about 700 characters becomes a multi-frame code when handed across.</div></div>
      <div class="row"><button class="primary" id="n-save">save</button>${isNew ? '' : '<a href="#/transfer"><button>hand across</button></a>'}<span class="hint" style="color:var(--dim)">${n.from ? `received from ${escapeHtml(n.from)} · ` : ''}${isNew ? '' : `edited ${relativeTime(n.updatedAt)}`}</span></div>
    </section>`;
  $('#n-back').onclick = () => viewNotes(el);
  $('#n-save').onclick = async () => {
    const title = $('#n-title').value.trim();
    const body = $('#n-body').value;
    if (!title && !body.trim()) return toast('nothing to save', 'error');
    await saveNote({ ...n, title, body, updatedAt: nowIso() });
    toast('saved', 'ok');
    viewNotes(el);
  };
  const del = $('#n-del');
  if (del) del.onclick = async () => {
    const ok = await confirmDialog({ title: 'delete this note', body: 'gone from this device. copies already handed to other devices stay there.', okLabel: 'delete', danger: true });
    if (!ok) return;
    await db.del('notes', n.id);
    state.notes = state.notes.filter((x) => x.id !== n.id);
    viewNotes(el);
  };
  ($('#n-title').value ? $('#n-body') : $('#n-title')).focus();
}

// ---------- transfer ----------

let frameCycle = null;
function stopFrameCycle() { if (frameCycle) { clearInterval(frameCycle); frameCycle = null; } }

function viewTransfer(el, tab = 'send') {
  el.innerHTML = `
    <section>
      <h2>transfer</h2>
      <div class="sub">a note becomes an encrypted code only the chosen device can open. no radio, no network: the screen is the wire.</div>
      <div class="row" style="margin-bottom:1.4rem"><button class="${tab === 'send' ? 'primary' : ''} small" id="t-send">send</button><button class="${tab === 'receive' ? 'primary' : ''} small" id="t-recv">receive</button></div>
      <div id="t-body"></div>
    </section>`;
  $('#t-send').onclick = () => viewTransfer(el, 'send');
  $('#t-recv').onclick = () => viewTransfer(el, 'receive');
  if (tab === 'send') renderSend($('#t-body')); else renderReceive($('#t-body'));
}

function renderSend(box) {
  stopFrameCycle();
  if (!state.devices.length) { box.innerHTML = `<div class="empty">pair a device first.</div>`; return; }
  box.innerHTML = `
    <div class="field"><label for="s-dev">to</label><select id="s-dev">${state.devices.map((d) => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('')}</select></div>
    <div class="field"><label for="s-note">what</label><select id="s-note"><option value="">type something instead</option>${state.notes.map((n) => `<option value="${n.id}">${escapeHtml(n.title || 'untitled')}</option>`).join('')}</select></div>
    <div class="field" id="s-free-wrap"><label for="s-free">text</label><textarea id="s-free" maxlength="6000" placeholder="anything short. the other device saves it as a note."></textarea></div>
    <button class="primary" id="s-make">make the code</button>
    <div id="s-out" style="margin-top:1.4rem"></div>`;
  $('#s-note').onchange = () => { $('#s-free-wrap').style.display = $('#s-note').value ? 'none' : ''; };
  $('#s-make').onclick = async () => {
    const dev = state.devices.find((d) => d.id === $('#s-dev').value);
    if (!dev) return;
    const noteId = $('#s-note').value;
    let payload;
    if (noteId) {
      const n = state.notes.find((x) => x.id === noteId);
      payload = { kind: 'note', title: n.title, body: n.body };
    } else {
      const text = $('#s-free').value.trim();
      if (!text) return toast('nothing to send', 'error');
      payload = { kind: 'note', title: text.split('\n')[0].slice(0, 60), body: text };
    }
    try {
      const env = await sealMessage(b64url.decode(dev.pairKey), state.identity.fingerprint, dev.fingerprint, { ...payload, from: state.profile.name });
      await saveDevice({ ...dev, lastTransferAt: nowIso() });
      showEnvelope($('#s-out'), env.text, dev);
    } catch (e) { toast(e.message, 'error'); }
  };
}

function showEnvelope(out, text, dev) {
  const frames = chunkForQr(text, 500);
  out.innerHTML = `
    <div class="card trust">
      <div class="eyebrow">for ${escapeHtml(dev.name)} only</div>
      <div class="qrwrap"><div class="qrframe"><canvas id="env-qr"></canvas></div></div>
      ${frames.length > 1 ? `<div class="framecounter" id="frame-counter">frame 1 of ${frames.length}</div><p class="hint" style="color:var(--muted);text-align:center;font-size:.8rem">the frames cycle. keep the camera on it until the other side reports all of them.</p>` : ''}
      <details style="margin-top:1rem"><summary style="color:var(--muted);cursor:pointer">as text (${text.length} characters)</summary><div class="codebox" style="margin-top:.6rem">${escapeHtml(b32.group(text, 8))}</div><div class="row" style="margin-top:.6rem"><button class="small" id="env-copy">copy</button></div></details>
    </div>`;
  const canvas = $('#env-qr', out);
  let i = 0;
  const draw = () => {
    try { renderQr(canvas, frames[i], { size: 300, ecl: 'L' }); } catch (e) { toast(`qr: ${e.message}`, 'error'); stopFrameCycle(); return; }
    const c = $('#frame-counter', out);
    if (c) c.textContent = `frame ${i + 1} of ${frames.length}`;
    i = (i + 1) % frames.length;
  };
  draw();
  stopFrameCycle();
  if (frames.length > 1) frameCycle = setInterval(draw, 900);
  $('#env-copy', out).onclick = () => copyText(text);
  out.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const inbox = { tid: null, total: 0, parts: new Map() };

function renderReceive(box) {
  inbox.tid = null; inbox.total = 0; inbox.parts.clear();
  box.innerHTML = `
    <div class="row">${cameraAvailable() ? '<button class="primary" id="r-scan">scan a code</button>' : ''}</div>
    <div class="field" style="margin-top:1rem"><label for="r-text">or paste the text</label><textarea id="r-text" rows="4" placeholder="${ENVELOPE_PREFIX}-… or ${CHUNK_PREFIX}-…" autocapitalize="characters" autocomplete="off" spellcheck="false"></textarea></div>
    <button id="r-read">read</button>
    <div id="r-progress"></div>
    <div id="r-out" style="margin-top:1.4rem"></div>`;
  const scan = $('#r-scan', box);
  if (scan) scan.onclick = () => openScanner((t) => ingestReceived(t, box, true), 'hold steady on the sender\'s code');
  $('#r-read', box).onclick = () => {
    // pasted text may be one grouped code or several frames in a row;
    // whitespace carries no information in either, so drop it first
    const raw = $('#r-text', box).value.toUpperCase().replace(/\s+/g, '');
    const pieces = raw.split(/(?=GBR[23]-)/).filter(Boolean);
    if (!pieces.length) return toast('nothing to read', 'error');
    for (const p of pieces) ingestReceived(p, box, false);
  };
}

async function ingestReceived(text, box, fromScanner) {
  const clean = text.trim().toUpperCase();
  const chunk = parseChunk(clean);
  let envelopeText = null;
  if (chunk) {
    if (inbox.tid !== chunk.tid) { inbox.tid = chunk.tid; inbox.total = chunk.total; inbox.parts.clear(); }
    if (!inbox.parts.has(chunk.index)) inbox.parts.set(chunk.index, chunk.part);
    renderProgress(box);
    if (inbox.parts.size < inbox.total) return;
    envelopeText = Array.from({ length: inbox.total }, (_, k) => inbox.parts.get(k + 1)).join('');
  } else if (clean.startsWith(ENVELOPE_PREFIX)) {
    envelopeText = clean;
  } else {
    if (!fromScanner) toast('that is not a transfer code', 'error');
    return;
  }
  if (fromScanner) closeScanner();
  await openEnvelope(envelopeText, box);
}

function renderProgress(box) {
  const p = $('#r-progress', box);
  if (!inbox.total) { p.innerHTML = ''; return; }
  p.innerHTML = `<div class="progress">${Array.from({ length: inbox.total }, (_, k) => `<i class="${inbox.parts.has(k + 1) ? 'got' : ''}"></i>`).join('')}</div><div class="framecounter">${inbox.parts.size} of ${inbox.total} frames</div>`;
}

async function openEnvelope(text, box) {
  const out = $('#r-out', box);
  let header;
  try { header = parseEnvelopeHeader(text); } catch (e) { toast(e.message, 'error'); return; }
  const candidates = state.devices.filter((d) => d.fingerprint.startsWith(header.senderFpPrefix));
  if (!candidates.length) { out.innerHTML = `<div class="card" style="border-color:var(--danger)"><p style="color:var(--danger)">this code was sealed by a device that is not paired here (sender prefix ${header.senderFpPrefix}). pair first, then read it again.</p></div>`; return; }
  let body = null, sender = null;
  for (const d of candidates) {
    try { body = await openMessage(b64url.decode(d.pairKey), d.fingerprint, state.identity.fingerprint, header); sender = d; break; }
    catch { /* try the next candidate with the same prefix */ }
  }
  if (!body) { out.innerHTML = `<div class="card" style="border-color:var(--danger)"><p style="color:var(--danger)">the code did not open. it was sealed for a different device, or the pairing on one side was replaced. re-pair and send again.</p></div>`; return; }
  const seenKey = `${sender.id}:${body.id}`;
  if (await db.get('seen', seenKey)) { toast('already received this one'); }
  out.innerHTML = `
    <div class="card trust">
      <div class="eyebrow">from ${escapeHtml(sender.name)} · ${relativeTime(body.ts)}</div>
      <h3>${escapeHtml(body.title || 'untitled')}</h3>
      <p style="white-space:pre-wrap;margin-top:.6rem">${escapeHtml(body.body || '')}</p>
      <div class="row" style="margin-top:1rem"><button class="accent" id="r-save">save as note</button></div>
    </div>`;
  $('#r-save', out).onclick = async () => {
    await saveNote({ id: uuid(), title: body.title || '', body: body.body || '', from: sender.name, createdAt: body.ts || nowIso(), updatedAt: nowIso() });
    await db.put('seen', { id: seenKey, t: nowIso() });
    await saveDevice({ ...sender, lastTransferAt: nowIso() });
    toast('saved', 'ok');
    location.hash = '#/notes';
  };
}

// ---------- settings ----------

function viewSettings(el) {
  el.innerHTML = `
    <section>
      <h2>settings</h2>
      <div class="sub">everything here acts on this device only.</div>

      <div class="card"><h3>auto-lock</h3>
        <div class="field" style="margin-top:.8rem"><label for="st-lock">minutes of inactivity before the vault locks (0 never)</label><input id="st-lock" type="number" min="0" max="240" value="${Number(state.settings.autoLockMinutes)}"></div>
        <button class="small" id="st-lock-save">save</button>
      </div>

      <div class="card" style="margin-top:1rem"><h3>passphrase</h3>
        <form id="st-pass" autocomplete="off" style="margin-top:.8rem">
          <div class="field"><label for="p-old">current</label><input id="p-old" type="password" autocomplete="current-password" required></div>
          <div class="field"><label for="p-new">new</label><input id="p-new" type="password" minlength="8" autocomplete="new-password" required></div>
          <div class="field"><label for="p-new2">new, again</label><input id="p-new2" type="password" autocomplete="new-password" required></div>
          <button class="small" type="submit">change</button>
        </form>
      </div>

      <div class="card" style="margin-top:1rem"><h3>backup</h3>
        <p style="margin-top:.6rem">the export is the sealed vault as it sits on disk: useless without the passphrase. keep it on a memory card or another phone. importing replaces everything here.</p>
        <div class="row"><button class="small" id="st-export">export sealed backup</button><label class="small" style="margin:0"><input type="file" id="st-import" accept="application/json,.json" hidden><button class="small" type="button" id="st-import-btn">import backup</button></label></div>
      </div>

      <div class="card" style="margin-top:1rem;border-color:var(--danger-soft)"><h3>erase</h3>
        <p style="margin-top:.6rem">deletes the profile, identity key, paired devices and notes from this device. the console itself stays installed.</p>
        <button class="danger small" id="st-wipe">erase everything</button>
      </div>
      <p class="locked-note">pairing key fingerprint <span class="mono">${state.identity.fingerprint}</span></p>
    </section>`;

  $('#st-lock-save').onclick = async () => {
    const v = Math.max(0, Math.min(240, Number($('#st-lock').value) || 0));
    state.settings.autoLockMinutes = v;
    await saveSettings(); armIdleLock(); toast('saved', 'ok');
    const meta = $('.sidenav .meta'); if (meta) meta.innerHTML = `unlocked ${relativeTime(state.unlockedAt)}<br>auto-lock ${v} min`;
  };

  $('#st-pass').addEventListener('submit', async (e) => {
    e.preventDefault();
    const oldP = $('#p-old').value, n1 = $('#p-new').value, n2 = $('#p-new2').value;
    if (n1.length < 8) return toast('new passphrase needs at least 8 characters', 'error');
    if (n1 !== n2) return toast('the two new passphrases differ', 'error');
    try { await unlockVault(oldP, state.profile); } catch { return toast('current passphrase is wrong', 'error'); }
    try {
      const w = await rewrapVault(state.vaultKey, n1);
      const profile = { ...state.profile, kdf: w.kdf, wrap: w.wrap };
      await db.put('meta', profile);
      state.profile = profile;
      e.target.reset();
      toast('passphrase changed', 'ok');
    } catch (err) { toast(`could not change passphrase: ${err.message}`, 'error'); }
  });

  $('#st-export').onclick = async () => {
    const dump = { format: 'gabriel-console-backup', version: 1, exportedAt: nowIso(), stores: {} };
    for (const s of db.STORES) dump.stores[s] = await db.all(s);
    download(`gabriel-console-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(dump));
  };
  $('#st-import-btn').onclick = () => $('#st-import').click();
  $('#st-import').onchange = async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    let dump;
    try { dump = JSON.parse(await f.text()); } catch { return toast('that file is not a backup', 'error'); }
    if (!dump || dump.format !== 'gabriel-console-backup' || dump.version !== 1 || !dump.stores || !Array.isArray(dump.stores.meta)) return toast('that file is not a backup', 'error');
    const profile = dump.stores.meta.find((r) => r && r.id === 'profile');
    const identity = dump.stores.meta.find((r) => r && r.id === 'identity');
    if (!profile || !identity) return toast('backup is missing its profile', 'error');
    const ok = await confirmDialog({ title: 'replace this device\'s data', body: `everything here is replaced by the backup of <strong style="font-weight:400">${escapeHtml(profile.name)}</strong> exported ${relativeTime(dump.exportedAt)}. you will need that profile's passphrase to unlock it.`, okLabel: 'replace', danger: true, typeToConfirm: 'replace' });
    if (!ok) return;
    try {
      await db.clearAll();
      for (const s of db.STORES) for (const r of dump.stores[s] || []) if (r && typeof r.id === 'string') await db.put(s, r);
      await loadProfile();
      lock('backup imported; unlock with its passphrase');
    } catch (err) { toast(`import failed: ${err.message}`, 'error'); }
  };
  $('#st-wipe').onclick = wipeEverything;
}

// ---------- boot ----------

async function main() {
  watchOnline((online) => {
    const p = $('#net-pill');
    p.classList.toggle('on', !online);
    p.textContent = online ? 'online' : 'offline';
  });
  registerServiceWorker().then(async () => { state.readiness = await offlineReadiness(); if (state.route === 'overview' && state.vaultKey) route(); });
  await loadProfile();
  renderGate();
}

main().catch((e) => {
  root.innerHTML = `<div class="gate"><div class="panel"><h1>the console could not start</h1><p>${escapeHtml(e.message)}</p><p>if this browser is in a private window, storage may be disabled. try a normal window.</p></div></div>`;
});
