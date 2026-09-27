// gabriel console: the application. one module, hash routing, no framework.
// state lives in memory while unlocked and is thrown away on lock.

import { b64url, b32, escapeHtml, fingerprintPretty, uuid, nowIso, relativeTime, cleanName } from './util.js';
import {
  cryptoAvailable, createVault, unlockVault, rewrapVault, sealRecord, openRecord,
  generateIdentity, generateSigningKey, importPrivate, importSigningPrivate,
  buildInvite, parseInvite, derivePair,
  sealMessage, parseEnvelopeHeader, openMessage, chunkForQr, parseChunk,
  INVITE_PREFIX, ENVELOPE_PREFIX, CHUNK_PREFIX,
} from './crypto.js';
import * as db from './db.js';
import { renderQr } from './qr.js';
import { cameraAvailable, startScanner } from './scan.js';
import { registerServiceWorker, offlineReadiness, watchOnline, onWorkerUpdate } from './status.js';
import { $, $$, toast, openOverlay, closeOverlay, confirmDialog, promptDialog, download, copyText } from './ui.js';
import { state, DEFAULT_SETTINGS, resetUnlockedState, on } from './state.js';
import { beacon, connectBeacon, disconnectBeacon, normalizeBeaconUrl } from './beacon.js';
import {
  loadRooms, createRoom, inviteDevice, removeMember, rotateEpoch, leaveRoom, deleteRoom,
  loadMessages, sendRoomMessage, sendDirectMessage, refreshSubscriptions, roomPeerCount, devicePeerCount,
  memberName, dmId, deviceForDm, callTransport, deleteConversationMessages,
  sendMedia, MAX_MEDIA_BYTES,
  joinRoom, declineInvite, resendInvite, proposeMember, approveProposal, declineProposal, requestDm, acceptDmRequest, ignoreDmRequest,
  handoverRoom, dissolveRoom, setViewing, clearUnread, unreadTotal, deviceForMember, upsertDevice,
} from './rooms.js';
import { call, joinCall, leaveCall, toggleMute, toggleVideo, snapshot as callSnapshot, resumeAudio } from './calls.js';
import { notificationSupport, requestNotifications, notifyIncoming, clearNotifications } from './notify.js';
import { installShield, applyShieldClass, shieldEnabled } from './shield.js';
import { quietKeyboard } from './keypad.js';
import { isStandalone, watchInstallPrompt, promptInstall, installInstructions } from './install.js';
import {
  currentPosition, watchPosition, distanceM, bearingDeg, fmtDistance, compassPoint,
  startCompass, stopCompass, drawRadar, renderMap, tileSource, externalMapLinks,
} from './geo.js';

const root = $('#root');

// ---------- lock / idle ----------

function armIdleLock() {
  clearTimeout(state.lockTimer);
  const mins = Number(state.settings.autoLockMinutes) || 0;
  if (!state.vaultKey || mins <= 0) return;
  state.lockTimer = setTimeout(() => { lock('locked after inactivity'); }, mins * 60 * 1000);
}
let lastActivity = Date.now();
for (const ev of ['pointerdown', 'keydown', 'touchstart']) document.addEventListener(ev, () => { lastActivity = Date.now(); armIdleLock(); }, { passive: true });
// a backgrounded tab's timers are throttled; on return, measure the real gap
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !state.vaultKey) return;
  const mins = Number(state.settings.autoLockMinutes) || 0;
  if (mins > 0 && Date.now() - lastActivity > mins * 60_000 && !call.roomId) lock('locked after inactivity');
});

// set when a newer version arrived while the vault was open; it loads at the
// next lock so nothing typed or in a call is lost
let reloadOnLock = false;

function lock(reason) {
  if (reloadOnLock) { location.reload(); return; }
  releaseMedia();
  stopLiveShare();
  if (call.roomId) leaveCall().catch(() => {});
  disconnectBeacon();
  resetUnlockedState();
  clearTimeout(state.lockTimer);
  stopActiveScanner();
  stopFrameCycle();
  stopCompass();
  clearNotifications().catch(() => {});
  myPos = null;
  pairing = null;
  inbox.tid = null; inbox.total = 0; inbox.parts.clear();
  state.settings = { ...DEFAULT_SETTINGS, autoLockMinutes: state.settings.autoLockMinutes, theme: state.settings.theme };
  applyShieldClass();
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
  // settings are sealed with everything else; until unlock the defaults apply
  state.settings = { ...DEFAULT_SETTINGS };
  applyShieldClass();
}

function coerceSettings(v) {
  const o = { ...DEFAULT_SETTINGS };
  if (!v || typeof v !== 'object') return o;
  o.autoLockMinutes = Math.max(0, Math.min(240, Number(v.autoLockMinutes) || 0));
  o.shield = v.shield !== false;
  o.notifications = ['off', 'sender', 'silent'].includes(v.notifications) ? v.notifications : 'sender';
  o.tiles = ['none', 'beacon', 'osm'].includes(v.tiles) ? v.tiles : 'none';
  o.beaconUrl = String(v.beaconUrl || '').slice(0, 300);
  o.beaconPassword = String(v.beaconPassword || '').slice(0, 200);
  o.beaconAuto = !!v.beaconAuto;
  o.iceServers = String(v.iceServers || '').slice(0, 2000);
  o.theme = v.theme === 'deep' ? 'deep' : 'night';
  o.quietKeys = v.quietKeys === 'quiet' ? 'quiet' : 'system';
  return o;
}

async function loadSettingsUnlocked() {
  const rec = await db.get('meta', 'settings');
  if (!rec) return;
  if (rec.enc) {
    try { state.settings = coerceSettings(await openRecord(state.vaultKey, 'meta', 'settings', rec.enc)); } catch { /* keep defaults */ }
  } else if (rec.value) {
    // migrate a plaintext settings record from an earlier build
    state.settings = coerceSettings(rec.value);
    await saveSettings();
  }
  applyShieldClass();
  applyTheme();
}

async function loadUnlockedData() {
  await loadSettingsUnlocked();
  const idRec = await db.get('meta', 'identity');
  if (!idRec) throw new Error('identity record missing');
  const priv = await openRecord(state.vaultKey, 'meta', 'identity', idRec.enc);
  // profiles from before rooms existed have no signing key: grow one now
  if (!priv.signPkcs8) {
    const sign = await generateSigningKey();
    priv.signPkcs8 = b64url.encode(sign.pkcs8);
    idRec.signPub = b64url.encode(sign.pub);
    idRec.enc = await sealRecord(state.vaultKey, 'meta', 'identity', priv);
    await db.put('meta', idRec);
  }
  state.identity = {
    pub: b64url.decode(idRec.pub),
    fingerprint: idRec.fingerprint,
    privateKey: await importPrivate(b64url.decode(priv.pkcs8)),
    signPub: b64url.decode(idRec.signPub),
    signKey: await importSigningPrivate(b64url.decode(priv.signPkcs8)),
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
  await loadRooms();
}

async function saveDevice(dev) { await upsertDevice(dev); }

async function saveNote(note) {
  const { id, ...plain } = note;
  await db.put('notes', { id, enc: await sealRecord(state.vaultKey, 'notes', id, plain) });
  const i = state.notes.findIndex((n) => n.id === id);
  if (i >= 0) state.notes[i] = note; else state.notes.unshift(note);
  state.notes.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

function applyTheme() {
  if (state.settings.theme === 'deep') document.documentElement.dataset.theme = 'deep';
  else delete document.documentElement.dataset.theme;
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.content = state.settings.theme === 'deep' ? '#040509' : '#07080d';
}

async function saveSettings() {
  if (!state.vaultKey) return;
  await db.put('meta', { id: 'settings', enc: await sealRecord(state.vaultKey, 'meta', 'settings', state.settings) });
  applyShieldClass();
  applyTheme();
}

// ---------- gate: create / unlock ----------

function signalMarkup(trust = false) {
  return `<div class="signal" data-trust="${trust}" aria-hidden="true"><div class="plane"><i></i><i></i><i></i></div></div>`;
}

function renderGate() {
  // the sky moves while a person arrives; once the vault is open it rests
  document.documentElement.classList.add('sky-moving');
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
        <form id="create-form" class="reveal in" style="--i:3" autocomplete="off" novalidate>
          <div class="field"><label for="c-name">name</label><input id="c-name" type="text" maxlength="24" required autocomplete="nickname" autocapitalize="off"></div>
          <div class="field"><label for="c-pass">passphrase</label><input id="c-pass" type="password" minlength="8" required autocomplete="new-password"><div class="hint" id="c-hint">length matters more than symbols. four unrelated words is a good passphrase.</div></div>
          <div class="field"><label for="c-pass2">again</label><input id="c-pass2" type="password" required autocomplete="new-password"></div>
          <div class="actions"><button class="primary" type="submit" id="c-submit">create</button><button class="ghost small" type="button" id="c-quiet">type on the page</button><span class="hint" id="c-status"></span></div>
        </form>
        <p class="fine reveal in" style="--i:4">key derivation runs 600 000 rounds on this device; on a slow phone that takes a second or two. nothing is uploaded, because there is nowhere to upload to.</p>
      </div>
    </div>`;
  const form = $('#create-form');
  const pass = $('#c-pass'), pass2 = $('#c-pass2'), hint = $('#c-hint');
  // the on-page keyboard: the passphrase never passes through the system keyboard
  const quiet = quietKeyboard([pass, pass2], { onDone: () => form.requestSubmit() });
  $('#c-quiet').onclick = () => { $('#c-quiet').textContent = quiet.toggle() ? 'system keyboard' : 'type on the page'; };
  pass.addEventListener('input', () => {
    const n = pass.value.length;
    hint.textContent = n === 0 ? 'length matters more than symbols. four unrelated words is a good passphrase.'
      : n < 8 ? `${8 - n} more characters needed` : n < 14 ? 'acceptable. longer is better.' : 'good length.';
    hint.classList.toggle('warn', n > 0 && n < 8);
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = cleanName($('#c-name').value, 24);
    if (!name) return toast('a name is needed', 'error');
    if (pass.value.length < 8) return toast('passphrase needs at least 8 characters', 'error');
    if (pass.value !== pass2.value) return toast('the two passphrases differ', 'error');
    const btn = $('#c-submit'); btn.disabled = true; $('#c-status').textContent = 'deriving keys…';
    try {
      const v = await createVault(pass.value);
      const idn = await generateIdentity();
      const enc = await sealRecord(v.vaultKey, 'meta', 'identity', { pkcs8: b64url.encode(idn.pkcs8), signPkcs8: b64url.encode(idn.signPkcs8) });
      const profile = { id: 'profile', name, createdAt: nowIso(), kdf: v.kdf, wrap: v.wrap, version: 1 };
      await db.put('meta', profile);
      await db.put('meta', { id: 'identity', pub: b64url.encode(idn.pub), signPub: b64url.encode(idn.signPub), fingerprint: idn.fingerprint, enc });
      await db.put('meta', { id: 'settings', enc: await sealRecord(v.vaultKey, 'meta', 'settings', state.settings) });
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
        <form id="unlock-form" class="reveal in" style="--i:3" novalidate>
          <div class="field"><label for="u-pass">passphrase</label><input id="u-pass" type="password" required autocomplete="current-password"></div>
          <div class="actions"><button class="primary" type="submit" id="u-submit">open</button><button class="ghost small" type="button" id="u-quiet">type on the page</button><span class="hint" id="u-status"></span></div>
        </form>
        <p class="fine reveal in" style="--i:4">forgot it? there is no recovery. you can <a href="#" id="u-wipe">erase this device's console data</a> and start over.</p>
      </div>
    </div>`;
  const form = $('#unlock-form');
  const quiet = quietKeyboard($('#u-pass'), { onDone: () => form.requestSubmit() });
  $('#u-quiet').onclick = () => { $('#u-quiet').textContent = quiet.toggle() ? 'system keyboard' : 'type on the page'; };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#u-pass');
    if (!input.value) { input.focus(); return toast('the passphrase is needed', 'error'); }
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
    body: 'profile, identity key, paired devices, rooms and notes are deleted. nothing can bring them back. paired devices will need to pair again.',
    okLabel: 'erase', danger: true, typeToConfirm: 'erase',
  });
  if (!ok) return;
  try {
    disconnectBeacon();
    await db.destroyDb();
    state.profile = null; resetUnlockedState();
    renderGate();
    toast('erased', 'ok');
  } catch (err) {
    toast(`erase failed: ${err.message}`, 'error');
  }
}

// ---------- shell + routing ----------

const ROUTES = [
  ['overview', 'overview'],
  ['rooms', 'rooms'],
  ['devices', 'devices'],
  ['notes', 'notes'],
  ['transfer', 'transfer'],
  ['privacy', 'privacy'],
  ['settings', 'settings'],
];

async function enterApp() {
  await loadUnlockedData();
  state.unlockedAt = nowIso();
  $('#who').textContent = state.profile.name;
  $('#lock-btn').hidden = false;
  armIdleLock();
  renderShell();
  if (state.settings.beaconAuto && state.settings.beaconUrl) {
    try { connectBeacon(state.settings.beaconUrl, state.settings.beaconPassword); } catch (e) { toast(`beacon: ${e.message}`, 'error'); }
  }
  if (!location.hash || !ROUTES.some(([r]) => location.hash.startsWith(`#/${r}`))) location.hash = '#/overview';
  else route();
}

function renderShell() {
  document.documentElement.classList.remove('sky-moving');
  root.innerHTML = `
    <div class="shell">
      <nav class="sidenav" aria-label="sections">
        ${ROUTES.map(([r, label]) => `<a href="#/${r}" data-route="${r}">${label}</a>`).join('')}
        <div class="spacer"></div>
        <div class="meta">unlocked ${relativeTime(state.unlockedAt)}<br>auto-lock ${state.settings.autoLockMinutes} min<br><span class="beaconchip" id="nav-beacon"><i></i><span>beacon off</span></span></div>
      </nav>
      <main class="content" id="content"></main>
    </div>`;
  paintBeaconChip();
  paintNavBadge();
}

function paintBeaconChip() {
  for (const el of $$('#nav-beacon, #top-beacon')) {
    el.className = `beaconchip ${beacon.status}`;
    const label = { off: 'beacon off', connecting: 'beacon…', on: 'beacon on', error: 'beacon error' }[beacon.status] || 'beacon';
    el.querySelector('span').textContent = label;
    el.title = beacon.lastError || beacon.url || '';
  }
}
on('beacon:status', paintBeaconChip);

let currentRoomId = null;
function route() {
  if (!state.vaultKey) {
    // lock() already drew the gate; the hashchange it caused must not redraw
    // it, or a passphrase typed in the meantime is thrown away mid-keystroke
    if (!$('#unlock-form') && !$('#create-form')) renderGate();
    return;
  }
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const r = parts[0] || 'overview';
  state.route = ROUTES.some(([x]) => x === r) ? r : 'overview';
  $$('.sidenav a').forEach((a) => a.classList.toggle('active', a.dataset.route === state.route));
  stopActiveScanner();
  stopFrameCycle();
  stopCompass();
  currentRoomId = null;
  setViewing(null);
  const el = $('#content');
  if (state.route === 'rooms' && parts[1]) { viewRoom(el, parts[1]); return; }
  const view = { overview: viewOverview, rooms: viewRooms, devices: viewDevices, notes: viewNotes, transfer: viewTransfer, privacy: viewPrivacy, settings: viewSettings }[state.route];
  view(el);
}
window.addEventListener('hashchange', route);

// ---------- overview ----------

async function viewOverview(el) {
  const r = state.readiness || await offlineReadiness();
  state.readiness = r;
  const standalone = isStandalone();
  const live = state.rooms.filter((x) => !x.left).length;
  el.innerHTML = `
    <section>
      <h2>${escapeHtml(state.profile.name)}</h2>
      <div class="sub">this device, sealed. ${state.devices.length} paired device${state.devices.length === 1 ? '' : 's'}, ${live} room${live === 1 ? '' : 's'}, ${state.notes.length} note${state.notes.length === 1 ? '' : 's'}.</div>
      <div class="grid">
        <div class="card ${r.ready ? 'trust' : ''}">
          <div class="stat"><div class="k">offline</div><div class="v">${r.ready ? 'ready' : 'not yet'}</div><div class="d">${r.ready ? 'every file is cached on this device. the network can go.' : 'the cache is still filling, or this browser blocks it.'}</div></div>
        </div>
        <div class="card ${beacon.status === 'on' ? 'trust' : ''}">
          <div class="stat"><div class="k">beacon</div><div class="v">${{ on: 'connected', connecting: 'connecting', error: 'error', off: 'off' }[beacon.status]}</div><div class="d">${beacon.status === 'on' ? `rooms and calls run through ${escapeHtml(beacon.info && beacon.info.name ? beacon.info.name : 'the beacon')} on this network.` : 'rooms and calls need a beacon on the local network. set one in privacy.'}</div></div>
        </div>
        <div class="card">
          <div class="stat"><div class="k">identity</div><div class="v" style="font-size:1rem" title="${escapeHtml(state.identity.fingerprint)}"><span class="fp">${fingerprintPretty(state.identity.fingerprint)}</span></div><div class="d">fingerprint of this device's pairing key. other devices see it when they pair with you.</div></div>
        </div>
        ${standalone ? '' : `<div class="card"><div class="stat"><div class="k">install</div><div class="v" style="font-size:1.2rem">${state.installPrompt ? 'one tap away' : 'from the browser menu'}</div><div class="d">installed, it opens like any app and works with the network off.</div><div class="row" style="margin-top:.8rem"><button class="small" id="ov-install">${state.installPrompt ? 'install' : 'how'}</button></div></div></div>`}
      </div>
      <div class="divider"></div>
      <h3>readiness, measured now</h3>
      <div class="readiness" style="margin-top:.8rem">
        ${readinessRow('secure context', r.secureContext, 'yes', 'no: needs https or localhost')}
        ${readinessRow('web cryptography', r.crypto, 'available', 'missing')}
        ${readinessRow('offline worker', r.controlled, 'controlling this page', 'not active')}
        ${readinessRow('app files cached', r.cached, 'complete', 'incomplete')}
        ${readinessRow('installed', standalone, 'yes', 'no (optional)', true)}
        ${readinessRow('shield', shieldEnabled(), 'on: messages blur until held, app veils when hidden', 'off', true)}
        <div class="item"><span class="k">network right now</span><span class="v">${r.online ? 'connected, unused except for a beacon you chose' : 'offline, unaffected'}</span></div>
      </div>
      <div class="divider"></div>
      <div class="row">
        <a href="#/rooms"><button>open a room</button></a>
        <a href="#/devices"><button>pair a device</button></a>
        <a href="#/notes"><button>write a note</button></a>
      </div>
    </section>`;
  const ib = $('#ov-install');
  if (ib) ib.onclick = installFlow;
}

function readinessRow(k, ok, yes, no, neutral = false) {
  return `<div class="item"><span class="k">${k}</span><span class="v ${ok ? 'on' : neutral ? '' : 'off'}">${ok ? yes : no}</span></div>`;
}

async function installFlow() {
  if (state.installPrompt) {
    const outcome = await promptInstall();
    if (outcome === 'accepted') toast('installed', 'ok');
    return;
  }
  const i = installInstructions();
  openOverlay(`<h3>install on ${escapeHtml(i.title)}</h3><ol class="steps" style="margin-top:1rem">${i.steps.map((s) => `<li><strong>${escapeHtml(s)}</strong></li>`).join('')}</ol><p style="margin-top:1rem;color:var(--muted)">no store, no account. the installed copy is this page, cached, opening in its own window.</p><div class="row" style="justify-content:flex-end;margin-top:1rem"><button class="primary" id="ins-ok">ok</button></div>`);
  $('#ins-ok').onclick = closeOverlay;
}

// ---------- devices + pairing ----------

let pairing = null; // { myInvite:{nonce,text}, theirs, derived }

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
      <div class="t"><div class="name">${escapeHtml(d.name)}${badge(d.unread)}</div><p class="sub mono" title="${escapeHtml(d.fingerprint)}">${fingerprintPretty(d.fingerprint)}</p><p class="sub">${d.verified ? `paired ${relativeTime(d.pairedAt)}` : `introduced by ${escapeHtml(d.via || 'a room')} ${relativeTime(d.pairedAt)} · not verified: pair in person to confirm the key`}${d.lastTransferAt ? ` · last transfer ${relativeTime(d.lastTransferAt)}` : ''}${d.signPub ? '' : ' · older code: cannot join rooms until re-paired'}</p></div>
      <div class="a"><button class="small accent" data-act="message">message</button><button class="small ghost" data-act="rename">rename</button><button class="small danger" data-act="forget">forget</button></div>
    </div>`).join('');
  list.onclick = async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const row = e.target.closest('.item-row');
    const dev = state.devices.find((d) => d.id === row.dataset.id);
    if (!dev) return;
    if (btn.dataset.act === 'message') {
      location.hash = `#/rooms/${dmId(dev)}`;
    } else if (btn.dataset.act === 'forget') {
      const ok = await confirmDialog({ title: `forget ${dev.name}`, body: 'the shared key is deleted here. the other device keeps its copy until it forgets you too. rooms you share stay, but this device can no longer be reached directly.', okLabel: 'forget', danger: true });
      if (!ok) return;
      await db.del('devices', dev.id);
      await deleteConversationMessages(dmId(dev));
      state.devices = state.devices.filter((d) => d.id !== dev.id);
      await refreshSubscriptions();
      renderDeviceList();
      toast('forgotten');
    } else if (btn.dataset.act === 'rename') {
      const name = cleanName(await promptDialog({ title: 'rename device', label: 'name', value: dev.name, maxlength: 40 }));
      if (!name) return;
      await saveDevice({ ...dev, name });
      renderDeviceList();
    }
  };
}

function viewPairing(el) {
  const inv = buildInvite(state.identity.pub, state.profile.name, state.identity.signPub);
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
          <p class="hint" style="color:var(--dim);font-size:.8rem;margin-top:.8rem">contains this device's public keys, a one-time number and your name. safe to show; useless to anyone who does not also hold the private keys.</p>
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
  box.innerHTML = `<div class="card" style="padding:.9rem 1rem;background:var(--bg-deep)"><div>${escapeHtml(t.name)}</div><div class="mono" style="color:var(--muted);font-size:.8rem;margin-top:.3rem">${fingerprintPretty(t.fingerprint)}</div>${t.signPub ? '' : '<div style="color:var(--danger);font-size:.8rem;margin-top:.3rem">older code without a signing key: pairing works, rooms will not</div>'}</div>`;
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
    pairing.derived = await derivePair(state.identity.privateKey, pairing.myInvite, theirs);
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
      signPub: t.signPub ? b64url.encode(t.signPub) : null,
      fingerprint: t.fingerprint,
      pairKey: b64url.encode(pairing.derived.pairKey),
      verified: true,
      pairedAt: nowIso(),
      lastTransferAt: existing ? existing.lastTransferAt : null,
    };
    await saveDevice(dev);
    await refreshSubscriptions();
    // paired: open the conversation with them straight away
    pairing = null;
    toast(`paired with ${dev.name}`, 'ok');
    location.hash = `#/rooms/${dmId(dev)}`;
    return;
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

// ---------- rooms ----------

const badge = (n) => (n ? `<span class="badge" aria-label="${n} unread">${n > 99 ? '99+' : n}</span>` : '');

function viewRooms(el) {
  const rooms = state.rooms.filter((r) => !r.left && !r.pending);
  const invitations = state.rooms.filter((r) => r.pending && !r.left);
  const proposals = state.rooms.filter((r) => !r.left && r.founderFp === state.identity.fingerprint && (r.proposals || []).length).flatMap((r) => r.proposals.map((p) => ({ room: r, p })));
  const requests = state.rooms.filter((r) => !r.left && (r.dmRequests || []).length).flatMap((r) => r.dmRequests.map((q) => ({ room: r, q })));
  el.innerHTML = `
    <section>
      <div class="row between"><div><h2>rooms</h2><div class="sub">group conversations and calls, sealed end to end, carried by a beacon on the local network.</div></div><button class="primary" id="room-new">new room</button></div>
      ${beacon.status === 'on' ? '' : `<div class="card" style="margin-bottom:1rem"><p>no beacon connected. rooms still open and keep their history; sending needs a beacon. <a href="#/privacy">set one up</a>.</p></div>`}
      ${invitations.length ? `<h3>invitations</h3><div class="sub" style="margin-bottom:.8rem">a paired device added you. nothing is read or sent until you join.</div><div class="list" style="margin-bottom:1.4rem">${invitations.map((r) => `
        <div class="item-row trust" data-id="${escapeHtml(r.id)}">
          <div class="t"><div class="name">${escapeHtml(r.name)}</div><p class="sub">from ${escapeHtml(r.invitedBy ? r.invitedBy.name : 'a paired device')} · ${r.members.length} member${r.members.length === 1 ? '' : 's'}</p></div>
          <div class="a"><button class="small accent" data-join="${escapeHtml(r.id)}">join</button><button class="small ghost" data-decline="${escapeHtml(r.id)}">decline</button></div>
        </div>`).join('')}</div>` : ''}
      ${requests.length ? `<h3>message requests</h3><div class="sub" style="margin-bottom:.8rem">a member of a room you share wants to talk one to one. accepting derives a key from the room's roster; verify in person later.</div><div class="list" style="margin-bottom:1.4rem">${requests.map(({ room, q }) => `
        <div class="item-row" data-id="${escapeHtml(room.id)}">
          <div class="t"><div class="name">${escapeHtml(q.name)}</div><p class="sub">in ${escapeHtml(room.name)} · ${relativeTime(q.at)}</p></div>
          <div class="a"><button class="small accent" data-dm-accept="${escapeHtml(room.id)}|${escapeHtml(q.fp)}">accept</button><button class="small ghost" data-dm-ignore="${escapeHtml(room.id)}|${escapeHtml(q.fp)}">ignore</button></div>
        </div>`).join('')}</div>` : ''}
      ${proposals.length ? `<h3>awaiting your approval</h3><div class="sub" style="margin-bottom:.8rem">members proposed people for rooms you founded. approving hands them the room key through the member who vouched for them.</div><div class="list" style="margin-bottom:1.4rem">${proposals.map(({ room, p }) => `
        <div class="item-row" data-id="${escapeHtml(room.id)}">
          <div class="t"><div class="name">${escapeHtml(p.name)}</div><p class="sub">for ${escapeHtml(room.name)} · proposed by ${escapeHtml(p.by ? p.by.name : 'a member')} · <span class="mono">${fingerprintPretty(p.fp).slice(0, 19)}</span></p></div>
          <div class="a"><button class="small accent" data-approve="${escapeHtml(room.id)}|${escapeHtml(p.fp)}">add</button><button class="small ghost" data-decline-proposal="${escapeHtml(room.id)}|${escapeHtml(p.fp)}">decline</button></div>
        </div>`).join('')}</div>` : ''}
      <div class="list" id="room-list">${rooms.length ? rooms.map((r) => `
        <div class="item-row" data-id="${escapeHtml(r.id)}">
          <div class="t"><div class="name">${escapeHtml(r.name)}${badge(r.unread)}</div><p class="sub">${r.members.length} member${r.members.length === 1 ? '' : 's'} · ${roomPeerCount(r)} here now · ${r.founderFp === state.identity.fingerprint ? 'you founded it' : `founded by ${escapeHtml(memberName(r, r.founderFp))}`} · ${relativeTime(r.updatedAt)}</p></div>
          <div class="a"><a href="#/rooms/${escapeHtml(r.id)}"><button class="small">open</button></a></div>
        </div>`).join('') : '<div class="empty">no rooms yet. found one and add people you have paired with.</div>'}</div>
      <div class="divider"></div>
      <h3>one to one</h3>
      <div class="sub" style="margin-bottom:.8rem">a direct chat rides the pair channel itself: only the two devices hold the key.</div>
      <div class="list">${state.devices.length ? state.devices.map((d) => `
        <div class="item-row" data-id="${escapeHtml(d.id)}">
          <div class="t"><div class="name">${escapeHtml(d.name)}${badge(d.unread)}</div><p class="sub">${devicePeerCount(d) > 1 ? 'here now' : 'not on this beacon'}${d.verified ? '' : ` · introduced by ${escapeHtml(d.via || 'a room')}, not verified in person`}${d.lastTransferAt ? ` · last ${relativeTime(d.lastTransferAt)}` : ''}</p></div>
          <div class="a"><a href="#/rooms/${dmId(d)}"><button class="small">open</button></a></div>
        </div>`).join('') : '<div class="empty">pair a device to message it directly.</div>'}</div>
      <p class="locked-note">a room holds devices its founder added: paired in person, or proposed by a member and approved. no accounts, no invites by link.</p>
    </section>`;
  el.onclick = async (e) => {
    const t = (attr) => e.target.closest(`[${attr}]`);
    const split = (v) => { const i = v.lastIndexOf('|'); return [v.slice(0, i), v.slice(i + 1)]; };
    try {
      let b;
      if ((b = t('data-join'))) { const r = state.rooms.find((x) => x.id === b.dataset.join); if (r) { await joinRoom(r); } return; }
      if ((b = t('data-decline'))) { const r = state.rooms.find((x) => x.id === b.dataset.decline); if (r) { await declineInvite(r); toast('declined', 'ok'); viewRooms(el); } return; }
      if ((b = t('data-approve'))) { const [rid, fp] = split(b.dataset.approve); const r = state.rooms.find((x) => x.id === rid); if (r) { const dev = await approveProposal(r, fp); toast(`${dev.name} added; they can join when they answer`, 'ok'); viewRooms(el); } return; }
      if ((b = t('data-decline-proposal'))) { const [rid, fp] = split(b.dataset.declineProposal); const r = state.rooms.find((x) => x.id === rid); if (r) { await declineProposal(r, fp); viewRooms(el); } return; }
      if ((b = t('data-dm-accept'))) { const [rid, fp] = split(b.dataset.dmAccept); const r = state.rooms.find((x) => x.id === rid); if (r) { const dev = await acceptDmRequest(r, fp); location.hash = `#/rooms/${dmId(dev)}`; } return; }
      if ((b = t('data-dm-ignore'))) { const [rid, fp] = split(b.dataset.dmIgnore); const r = state.rooms.find((x) => x.id === rid); if (r) { await ignoreDmRequest(r, fp); viewRooms(el); } return; }
    } catch (err) { toast(err.message, 'error'); }
  };
  $('#room-new').onclick = async () => {
    const name = cleanName(await promptDialog({ title: 'new room', label: 'name', placeholder: 'north stairwell', maxlength: 60 }), 60);
    if (!name) return;
    const room = await createRoom(name);
    location.hash = `#/rooms/${room.id}`;
  };
}

let liveShareStop = null;
let liveShareRoomId = null;
function stopLiveShare() { if (liveShareStop) { liveShareStop(); liveShareStop = null; liveShareRoomId = null; } }

let myPos = null; // last position this device read for itself, memory only

// a conversation is a room or a direct chat; both render the same way
function getConv(convId) {
  if (convId.startsWith('dm:')) {
    const dev = deviceForDm(convId);
    if (!dev) return null;
    return {
      id: convId, dev, room: null, name: dev.name, isRoom: false,
      nameOf: (fp) => (fp === state.identity.fingerprint ? state.profile.name : dev.name),
      peers: () => devicePeerCount(dev),
      send: (kind, body, opts) => sendDirectMessage(dev, kind, body, opts),
      members: () => `${dev.name}, you`,
    };
  }
  const room = state.rooms.find((r) => r.id === convId);
  if (!room) return null;
  return {
    id: convId, dev: null, room, name: room.name, isRoom: true,
    nameOf: (fp) => memberName(room, fp),
    peers: () => roomPeerCount(room),
    send: (kind, body, opts) => sendRoomMessage(room, kind, body, opts),
    members: () => room.members.map((m) => (m.fp === state.identity.fingerprint ? 'you' : m.name)).join(', '),
  };
}

async function viewRoom(el, convId) {
  const conv = getConv(convId);
  if (!conv) { location.hash = '#/rooms'; return; }
  currentRoomId = convId;
  setViewing(convId);
  clearUnread(convId).catch(() => {});
  clearNotifications(`#/rooms/${convId}`);
  const founder = conv.isRoom && conv.room.founderFp === state.identity.fingerprint;
  const inThisCall = call.roomId === convId;
  el.innerHTML = `
    <section>
      <div class="roomhead">
        <div><h2>${escapeHtml(conv.name)}</h2><div class="members" id="room-members"></div></div>
        <div class="row">
          ${conv.isRoom ? '<button class="small ghost" id="room-people">people</button>' : ''}
          <button class="small ghost" id="room-where">where</button>
          <button class="small ${inThisCall ? 'danger' : 'accent'}" id="room-call">${inThisCall ? 'leave call' : 'call'}</button>
        </div>
      </div>
      <div id="call-panel"></div>
      <div class="shield-hint">shielded: press and hold a message to read it. it blurs again when you let go.</div>
      <div class="timeline" id="timeline"></div>
      <div class="send-status" id="send-status" aria-live="polite"></div>
      <div class="composer">
        <button class="tool" id="attach" type="button" title="send a photo or a file" aria-label="send a photo or a file"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 11.5 12 20a5 5 0 0 1-7-7l9-9a3.2 3.2 0 0 1 4.5 4.5L9.8 17.2a1.4 1.4 0 0 1-2-2l7.6-7.6"/></svg></button>
        <input type="file" id="attach-input" hidden>
        <button class="tool" id="mic" type="button" title="hold to record a voice clip" aria-label="hold to record a voice clip" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"/></svg></button>
        <textarea id="compose" rows="1" placeholder="${beacon.status === 'on' ? (conv.isRoom ? 'message the room' : `message ${escapeHtml(conv.name)}`) : 'connect a beacon to send'}" maxlength="4000" autocomplete="off" autocorrect="off" autocapitalize="sentences" spellcheck="false" data-gramm="false" data-enable-grammarly="false"></textarea>
        <button class="primary" id="send">send</button>
      </div>
    </section>`;
  paintMembers(conv);
  releaseMedia();
  wireMediaComposer(conv);
  const tl = $('#timeline');
  const msgs = await loadMessages(convId);
  tl.innerHTML = msgs.map((m) => bubble(conv, m)).join('') || '<div class="sysline">nothing yet</div>';
  tl.scrollTop = tl.scrollHeight;
  const compose = $('#compose');
  const doSend = async () => {
    const text = compose.value.trim();
    if (!text) return;
    if (beacon.status !== 'on') return noBeaconSheet();
    compose.value = ''; compose.style.height = '';
    try {
      await conv.send('text', { text });
    } catch (e) {
      if (!compose.value) compose.value = text; // give it back to be sent again
      toast(e.message, 'error');
    }
  };
  $('#send').onclick = doSend;
  compose.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); } });
  compose.addEventListener('input', () => { compose.style.height = 'auto'; compose.style.height = `${Math.min(compose.scrollHeight, 160)}px`; });
  if (state.settings.quietKeys === 'quiet') {
    const quiet = quietKeyboard(compose, { onDone: doSend, mount: $('.composer'), where: 'append' });
    quiet.open();
  }
  const people = $('#room-people');
  if (people) people.onclick = () => peopleSheet(conv.room, founder);
  $('#room-where').onclick = () => whereSheet(conv);
  $('#room-call').onclick = async () => {
    if (call.roomId === convId) { await leaveCall(); return; }
    if (call.roomId) return toast('already in a call in another conversation', 'error');
    try { await joinCall({ id: convId, send: callTransport(conv) }); toast('in the call: your microphone is live', 'ok'); }
    catch (e) { toast(`call: ${e.message}`, 'error'); }
  };
  paintCallPanel();
}

function bubble(conv, m) {
  const mine = m.fp === state.identity.fingerprint;
  const who = mine ? 'you' : conv.nameOf(m.fp);
  const when = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const id = escapeHtml(String(m.id));
  if (m.kind === 'location') {
    const rel = myPos ? `${fmtDistance(distanceM(myPos, m))} ${compassPoint(bearingDeg(myPos, m))} of you` : `±${Number(m.acc) || '?'} m`;
    return `<div class="bubble loc ${mine ? 'mine' : ''}" data-id="${id}"><div class="who ${mine ? 'me' : ''}">${escapeHtml(who)} · location${m.live ? ' · live' : ''}</div><div class="txt" data-shielded>${Number(m.lat).toFixed(5)}, ${Number(m.lon).toFixed(5)}<br>${escapeHtml(rel)}</div><div class="when">${when}</div></div>`;
  }
  if (m.kind === 'media') return mediaBubble(m, mine, who, when, id);
  return `<div class="bubble ${mine ? 'mine' : ''}" data-id="${id}"><div class="who ${mine ? 'me' : ''}">${escapeHtml(who)}</div><div class="txt" data-shielded>${escapeHtml(m.text || '')}</div><div class="when">${when}</div></div>`;
}

// ---------- media: photos, voice clips, files ----------

// blob urls made for the timeline on screen; released when it is repainted
const liveMediaUrls = [];
function releaseMedia() { for (const u of liveMediaUrls.splice(0)) URL.revokeObjectURL(u); }
function mediaUrl(m) {
  const url = URL.createObjectURL(new Blob([b64url.decode(m.data)], { type: m.mime }));
  liveMediaUrls.push(url);
  return url;
}
function fmtBytes(n) { return n < 1024 ? `${n} b` : n < 1048576 ? `${Math.round(n / 1024)} kb` : `${(n / 1048576).toFixed(1)} mb`; }
function fmtClock(sec) { const s = Math.round(sec); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
function mediaBubble(m, mine, who, when, id) {
  const url = mediaUrl(m);
  const name = escapeHtml(m.name || 'file');
  let inner;
  if (m.mime.startsWith('image/')) {
    const ratio = m.width && m.height ? ` style="aspect-ratio:${Number(m.width)}/${Number(m.height)}"` : '';
    inner = `<img class="media-img" data-shielded src="${url}" alt="" draggable="false"${ratio}><div class="media-meta">photo · ${fmtBytes(m.size)}</div>`;
  } else if (m.mime.startsWith('audio/')) {
    inner = `<div class="media-audio"><audio controls preload="metadata" src="${url}"></audio><div class="media-meta">voice${m.duration ? ` · ${fmtClock(m.duration)}` : ''} · ${fmtBytes(m.size)}</div></div>`;
  } else if (m.mime.startsWith('video/')) {
    inner = `<video class="media-img" data-shielded controls playsinline preload="metadata" src="${url}"></video><div class="media-meta">video · ${fmtBytes(m.size)}</div>`;
  } else {
    inner = `<a class="media-file" href="${url}" download="${name}"><span class="media-name">${name}</span><span class="media-meta">${fmtBytes(m.size)} · tap to save</span></a>`;
  }
  return `<div class="bubble media ${mine ? 'mine' : ''}" data-id="${id}"><div class="who ${mine ? 'me' : ''}">${escapeHtml(who)}</div>${inner}<div class="when">${when}</div></div>`;
}

function setSendStatus(text) { const el = $('#send-status'); if (el) el.textContent = text || ''; }

// sending with no beacon: say how messages travel, and offer the way there
function noBeaconSheet() {
  const box = openOverlay(`
    <h3>no beacon in reach</h3>
    <p style="margin-top:.6rem">messages, photos and calls travel over a beacon: a small relay on the wi-fi hotspot in the room. nothing goes over the internet, ever, even when the internet is there.</p>
    <p>someone runs it on a laptop or a spare phone with one command, everyone installs its certificate once, and then this console connects to it under privacy. the beacon carries only ciphertext it cannot read.</p>
    <div class="row" style="margin-top:1.2rem;justify-content:flex-end"><button class="ghost" id="nb-close">close</button><a href="#/privacy" id="nb-go"><button class="primary">set up a beacon</button></a></div>`);
  $('#nb-close', box).onclick = closeOverlay;
  $('#nb-go', box).onclick = () => closeOverlay();
}

// a photo is re-encoded before it leaves: that strips exif (camera, time,
// gps) and bounds the size. it steps down until the jpeg fits the target.
async function prepareImage(file) {
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { return { name: file.name || 'image', mime: file.type || 'application/octet-stream', bytes: new Uint8Array(await file.arrayBuffer()) }; }
  const TARGET = 350_000;
  let blob = null, w = bmp.width, h = bmp.height;
  const encode = async (side, q) => {
    const scale = Math.min(1, side / Math.max(bmp.width, bmp.height));
    w = Math.max(1, Math.round(bmp.width * scale)); h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    return new Promise((r) => canvas.toBlob(r, 'image/jpeg', q));
  };
  // first at the largest size; if that is over the target, jump straight to the
  // side that should land under it (bytes scale with pixels), then one last step
  blob = await encode(1600, 0.85);
  if (blob && blob.size > TARGET) blob = await encode(Math.max(480, Math.floor(Math.max(w, h) * Math.sqrt((TARGET * 0.85) / blob.size))), 0.8);
  if (blob && blob.size > TARGET) blob = await encode(Math.max(320, Math.floor(Math.max(w, h) * 0.75)), 0.68);
  bmp.close();
  if (!blob) throw new Error('could not encode the image');
  return { name: `${(file.name || 'photo').replace(/\.[^.]+$/, '') || 'photo'}.jpg`, mime: 'image/jpeg', bytes: new Uint8Array(await blob.arrayBuffer()), width: w, height: h };
}

async function sendMediaFromComposer(conv, media, label) {
  try {
    if (media.bytes.length > MAX_MEDIA_BYTES) throw new Error(`${fmtBytes(media.bytes.length)} is over the ${fmtBytes(MAX_MEDIA_BYTES)} limit`);
    setSendStatus(`sending ${label}`);
    await sendMedia(conv.id, media, (i, n) => { if (n > 1) setSendStatus(`sending ${label} · ${i}/${n}`); });
    setSendStatus('');
  } catch (e) {
    setSendStatus('');
    toast(e.message, 'error');
  }
}

function pickAudioMime() {
  if (!window.MediaRecorder) return null;
  for (const t of ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm']) if (MediaRecorder.isTypeSupported(t)) return t;
  return '';
}

function wireMediaComposer(conv) {
  const input = $('#attach-input');
  $('#attach').onclick = () => input.click();
  input.onchange = async () => {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    if (beacon.status !== 'on') return noBeaconSheet();
    const isImage = /^image\//.test(file.type);
    const media = isImage ? await prepareImage(file).catch((e) => { toast(`image: ${e.message}`, 'error'); return null; })
      : { name: file.name || 'file', mime: file.type || 'application/octet-stream', bytes: new Uint8Array(await file.arrayBuffer()) };
    if (!media) return;
    await sendMediaFromComposer(conv, media, isImage ? 'photo' : 'file');
  };

  const mic = $('#mic');
  const mime = pickAudioMime();
  if (mime === null || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
  mic.hidden = false;
  let rec = null, chunks = [], timer = null, startedAt = 0;
  const stop = () => { if (rec && rec.state !== 'inactive') rec.stop(); };
  const start = async (e) => {
    e.preventDefault();
    if (rec) return;
    if (beacon.status !== 'on') return noBeaconSheet();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 24_000 } : { audioBitsPerSecond: 24_000 });
      chunks = [];
      rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
      rec.onstop = async () => {
        for (const t of stream.getTracks()) t.stop();
        clearInterval(timer);
        mic.classList.remove('rec');
        const duration = (Date.now() - startedAt) / 1000;
        const type = (rec.mimeType || mime || 'audio/webm').split(';')[0];
        rec = null;
        setSendStatus('');
        if (duration < 0.6) return toast('hold the microphone while you speak');
        const blob = new Blob(chunks, { type });
        const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
        await sendMediaFromComposer(conv, { name: `voice-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.${ext}`, mime: type, bytes: new Uint8Array(await blob.arrayBuffer()), duration }, 'voice clip');
      };
      rec.start(250);
      startedAt = Date.now();
      mic.classList.add('rec');
      timer = setInterval(() => {
        const s = (Date.now() - startedAt) / 1000;
        setSendStatus(`recording · ${fmtClock(s)} · release to send`);
        if (s >= 60) stop();
      }, 200);
    } catch (err) { toast(`microphone: ${err.message}`, 'error'); }
  };
  mic.addEventListener('pointerdown', start);
  mic.addEventListener('pointerup', stop);
  mic.addEventListener('pointercancel', stop);
  mic.addEventListener('pointerleave', stop);
  mic.addEventListener('contextmenu', (e) => e.preventDefault());
}

// half-received media shows its progress under the timeline
on('media:progress', ({ roomId, got, parts, meta }) => {
  if (roomId !== currentRoomId || got >= parts) return;
  const what = meta.mime.startsWith('image/') ? 'photo' : meta.mime.startsWith('audio/') ? 'voice clip' : meta.mime.startsWith('video/') ? 'video' : 'file';
  setSendStatus(`receiving ${what} · ${got}/${parts}`);
});

function paintMembers(conv) {
  const el = $('#room-members');
  if (!el) return;
  el.textContent = `${conv.members()} · ${conv.peers()} here now`;
}

on('room:message', ({ roomId, msg, mine, replay, sender }) => {
  const conv = getConv(roomId);
  if (!conv) return;
  if (roomId === currentRoomId) {
    const tl = $('#timeline');
    if (tl) {
      if (tl.querySelector('.sysline')) tl.innerHTML = '';
      if (msg.kind === 'media' && !mine) setSendStatus('');
      const atBottom = tl.scrollHeight - tl.scrollTop - tl.clientHeight < 80;
      tl.insertAdjacentHTML('beforeend', bubble(conv, msg));
      if (atBottom || mine) tl.scrollTop = tl.scrollHeight;
    }
  } else if (state.route === 'rooms' && !currentRoomId) {
    route();
  }
  if (!mine && !replay) notifyIncoming({ senderName: sender ? sender.name : 'someone', route: `#/rooms/${roomId}` });
});
on('rooms:changed', ({ roomId, reason, who, deviceId }) => {
  const room = state.rooms.find((r) => r.id === roomId);
  const conv = getConv(roomId);
  const name = room ? room.name : 'a room';
  const whoName = who ? who.name : 'someone';
  if (state.route === 'rooms' && !currentRoomId) route();
  if (roomId === currentRoomId && conv) {
    paintMembers(conv);
    const tl = $('#timeline');
    const line = (t) => { if (tl) tl.insertAdjacentHTML('beforeend', `<div class="sysline">${t}</div>`); };
    if (reason === 'left' && who) line(`${escapeHtml(whoName)} left`);
    if (reason === 'rotated') line('the room key was rotated');
    if (reason === 'joined' && who) line(`${escapeHtml(whoName)} joined`);
    if (reason === 'handover' && who) line(`${escapeHtml(whoName)} is the founder now`);
    if (reason === 'dissolved') { line('the founder dissolved the room'); toast(`${name} was dissolved`, 'error'); }
  }
  switch (reason) {
    case 'invitation':
      toast(`${whoName} invited you to ${name}`, 'ok');
      notifyIncoming({ senderName: whoName, route: '#/rooms' });
      break;
    case 'invited':
      // joined: open it, unless the person is mid-conversation or on a call
      if (!currentRoomId && !call.roomId && state.vaultKey) location.hash = `#/rooms/${roomId}`;
      else toast(`joined ${name}`, 'ok');
      break;
    case 'proposal':
      toast(`${whoName} proposed someone for ${name}`, 'ok');
      notifyIncoming({ senderName: whoName, route: '#/rooms' });
      break;
    case 'proposal-approved': toast(`the founder approved a proposal in ${name}`, 'ok'); break;
    case 'proposal-declined': toast(`the founder declined a proposal in ${name}`); break;
    case 'dm-request':
      toast(`${whoName} asks to message you`, 'ok');
      notifyIncoming({ senderName: whoName, route: '#/rooms' });
      break;
    case 'dm-ready': {
      const dev = state.devices.find((d) => d.id === deviceId);
      toast(`${whoName} accepted. you can message them now.`, 'ok');
      if (dev && !currentRoomId && !call.roomId) location.hash = `#/rooms/${dmId(dev)}`;
      break;
    }
    case 'handover':
      if (who && who.fp === state.identity.fingerprint) toast(`you are the founder of ${name} now`, 'ok');
      break;
    case 'dissolved':
      if (roomId !== currentRoomId) toast(`${name} was dissolved`, 'error');
      break;
    default: break;
  }
  paintNavBadge();
});
on('devices:changed', () => { if (state.route === 'devices' && !pairing) renderDeviceList(); if (state.route === 'rooms' && !currentRoomId) route(); });
on('unread:changed', () => { paintNavBadge(); if (state.route === 'rooms' && !currentRoomId) route(); });

// the rooms entry in the navigation carries everything that waits for a person
function paintNavBadge() {
  const a = document.querySelector('.sidenav a[data-route="rooms"]');
  if (!a) return;
  const n = unreadTotal();
  let b = a.querySelector('.badge');
  if (!n) { if (b) b.remove(); return; }
  if (!b) { b = document.createElement('span'); b.className = 'badge'; a.appendChild(b); }
  b.textContent = n > 99 ? '99+' : String(n);
  b.setAttribute('aria-label', `${n} waiting`);
}
on('beacon:count', () => { const conv = currentRoomId ? getConv(currentRoomId) : null; if (conv) paintMembers(conv); });

async function peopleSheet(room, founder) {
  const meFp = state.identity.fingerprint;
  const candidates = state.devices.filter((d) => d.signPub && !room.members.some((m) => m.fp === d.fingerprint));
  const proposals = founder ? (room.proposals || []) : [];
  const memberRow = (m) => {
    const isMe = m.fp === meFp;
    const dev = isMe ? null : deviceForMember(m.fp);
    const joined = isMe || !founder || (room.joined && room.joined[m.fp]);
    const notes = [];
    if (m.fp === room.founderFp) notes.push('founder');
    if (!isMe && founder && !joined) notes.push('invited, not yet joined');
    if (!isMe && dev && !dev.verified) notes.push(`introduced by ${escapeHtml(dev.via || 'a room')}`);
    if (!isMe && !dev) notes.push('no direct channel yet');
    const actions = [];
    if (!isMe && dev) actions.push(`<a href="#/rooms/${dmId(dev)}"><button class="small ghost">message</button></a>`);
    if (!isMe && !dev) actions.push((room.dmAsked || []).includes(m.fp) ? '<span class="hint" style="color:var(--dim)">asked</span>' : `<button class="small ghost" data-dm-request="${escapeHtml(m.fp)}">ask to message</button>`);
    if (!isMe && founder && !joined && dev) actions.push(`<button class="small ghost" data-resend="${escapeHtml(m.fp)}">send again</button>`);
    if (!isMe && founder && dev) actions.push(`<button class="small ghost" data-handover="${escapeHtml(m.fp)}">make founder</button>`);
    if (!isMe && founder) actions.push(`<button class="small danger" data-remove="${escapeHtml(m.fp)}">remove</button>`);
    return `<div class="item-row"><div class="t"><div class="name">${isMe ? 'you' : escapeHtml(m.name)}</div><p class="sub mono">${fingerprintPretty(m.fp)}</p>${notes.length ? `<p class="sub">${notes.join(' · ')}</p>` : ''}</div>${actions.length ? `<div class="a" style="flex-wrap:wrap;justify-content:flex-end">${actions.join('')}</div>` : ''}</div>`;
  };
  const box = openOverlay(`
    <div class="row between"><h3>people in ${escapeHtml(room.name)}</h3><button class="ghost small" id="pp-close">close</button></div>
    <div class="list" style="margin-top:1rem">${room.members.map(memberRow).join('')}</div>
    ${proposals.length ? `<div class="divider"></div><h3>proposed by members</h3><div class="list" style="margin-top:.8rem">${proposals.map((p) => `<div class="item-row"><div class="t"><div class="name">${escapeHtml(p.name)}</div><p class="sub">by ${escapeHtml(p.by ? p.by.name : 'a member')} · <span class="mono">${fingerprintPretty(p.fp).slice(0, 19)}</span></p></div><div class="a"><button class="small accent" data-approve="${escapeHtml(p.fp)}">add</button><button class="small ghost" data-decline-proposal="${escapeHtml(p.fp)}">decline</button></div></div>`).join('')}</div>` : ''}
    <div class="divider"></div>
    <h3>${founder ? 'add a paired device' : 'propose a paired device'}</h3>
    <p class="sub" style="margin-top:.3rem">${founder ? 'they receive the room key over your pairing and choose whether to join.' : 'the founder decides. if they approve, the newcomer receives the key through your pairing.'}</p>
    ${candidates.length ? `<div class="list" style="margin-top:.8rem">${candidates.map((d) => `<div class="item-row"><div class="t"><div class="name">${escapeHtml(d.name)}</div>${d.verified ? '' : `<p class="sub">introduced by ${escapeHtml(d.via || 'a room')}</p>`}</div><div class="a"><button class="small accent" data-${founder ? 'add' : 'propose'}="${escapeHtml(d.id)}">${founder ? 'add' : 'propose'}</button></div></div>`).join('')}</div>` : '<p style="color:var(--muted);margin-top:.6rem">everyone you are paired with is already here, or paired with an older code.</p>'}
    ${founder ? '<div class="divider"></div><div class="row"><button class="small" id="pp-rotate">rotate key now</button><span class="hint" style="color:var(--dim)">issue a fresh epoch key to current members</span></div>' : ''}
    <div class="divider"></div>
    <div class="row"><button class="small danger" id="pp-leave">${founder ? (room.members.length > 1 ? 'leave or dissolve' : 'delete room here') : 'leave room'}</button></div>`);
  $('#pp-close', box).onclick = closeOverlay;
  const conv = () => getConv(room.id);
  box.onclick = async (e) => {
    const t = (attr) => e.target.closest(`[${attr}]`);
    let b;
    try {
      if ((b = t('data-add'))) {
        const dev = state.devices.find((d) => d.id === b.dataset.add);
        await inviteDevice(room, dev); toast(`${dev.name} invited; they can join when they answer`, 'ok'); closeOverlay(); paintMembers(conv());
      } else if ((b = t('data-propose'))) {
        const dev = state.devices.find((d) => d.id === b.dataset.propose);
        await proposeMember(room, dev); toast(`${dev.name} proposed to the founder`, 'ok'); closeOverlay();
      } else if ((b = t('data-approve'))) {
        const dev = await approveProposal(room, b.dataset.approve); toast(`${dev.name} invited; they can join when they answer`, 'ok'); closeOverlay(); paintMembers(conv());
      } else if ((b = t('data-decline-proposal'))) {
        await declineProposal(room, b.dataset.declineProposal); closeOverlay(); peopleSheet(room, founder);
      } else if ((b = t('data-dm-request'))) {
        await requestDm(room, b.dataset.dmRequest); toast('asked. they decide.', 'ok'); closeOverlay();
      } else if ((b = t('data-resend'))) {
        await resendInvite(room, b.dataset.resend); toast('invitation sent again', 'ok');
      } else if ((b = t('data-handover'))) {
        const m = room.members.find((x) => x.fp === b.dataset.handover);
        const ok = await confirmDialog({ title: `make ${m.name} the founder`, body: 'they will be the one who adds people, approves proposals and rotates the key. you stay a member. this cannot be taken back by you.', okLabel: 'hand over', danger: true });
        if (!ok) return;
        await handoverRoom(room, m.fp); toast(`${m.name} is the founder now`, 'ok'); closeOverlay(); paintMembers(conv());
      } else if ((b = t('data-remove'))) {
        const ok = await confirmDialog({ title: 'remove from room', body: 'they stop receiving new messages; the room key is rotated for everyone else.', okLabel: 'remove', danger: true });
        if (!ok) return;
        const failed = await removeMember(room, b.dataset.remove);
        toast(failed.length ? `removed; could not reach ${failed.join(', ')} with the new key` : 'removed and key rotated', failed.length ? 'error' : 'ok'); closeOverlay(); paintMembers(conv());
      }
    } catch (err) { toast(err.message, 'error'); }
  };
  const rot = $('#pp-rotate', box);
  if (rot) rot.onclick = async () => { const failed = await rotateEpoch(room); toast(failed.length ? `rotated; could not reach ${failed.join(', ')}` : 'key rotated', failed.length ? 'error' : 'ok'); closeOverlay(); };
  $('#pp-leave', box).onclick = async () => {
    if (founder && room.members.length > 1) return leaveAsFounderSheet(room);
    const ok = await confirmDialog({ title: founder ? 'delete this room here' : 'leave this room', body: founder ? 'you are its only member. the room and its history are deleted from this device.' : 'your copy of the history is deleted. the founder can add you again.', okLabel: founder ? 'delete' : 'leave', danger: true });
    if (!ok) return;
    if (call.roomId === room.id) await leaveCall();
    await leaveRoom(room);
    await deleteRoom(room.id);
    closeOverlay();
    location.hash = '#/rooms';
  };
}

// a founder with members cannot simply vanish: the room would be left with
// nobody able to add, approve or rotate. hand it over, or end it for everyone.
function leaveAsFounderSheet(room) {
  const heirs = room.members.filter((m) => m.fp !== state.identity.fingerprint && deviceForMember(m.fp));
  const box = openOverlay(`
    <h3>you founded ${escapeHtml(room.name)}</h3>
    <p style="margin-top:.6rem">a room needs a founder to add people, approve proposals and rotate the key. hand it to a member and leave, or dissolve it for everyone.</p>
    ${heirs.length ? `<div class="list" style="margin-top:1rem">${heirs.map((m) => `<div class="item-row"><div class="t"><div class="name">${escapeHtml(m.name)}</div></div><div class="a"><button class="small accent" data-heir="${escapeHtml(m.fp)}">hand over and leave</button></div></div>`).join('')}</div>` : '<p class="sub" style="margin-top:.6rem">no member can take it: you have no direct channel to any of them.</p>'}
    <div class="row" style="margin-top:1.2rem;justify-content:flex-end"><button class="ghost" id="lf-cancel">cancel</button><button class="danger" id="lf-dissolve">dissolve for everyone</button></div>`);
  $('#lf-cancel', box).onclick = closeOverlay;
  box.onclick = async (e) => {
    const b = e.target.closest('[data-heir]');
    if (!b) return;
    try {
      await handoverRoom(room, b.dataset.heir);
      if (call.roomId === room.id) await leaveCall();
      await leaveRoom(room); await deleteRoom(room.id);
      closeOverlay(); location.hash = '#/rooms'; toast('handed over and left', 'ok');
    } catch (err) { toast(err.message, 'error'); }
  };
  $('#lf-dissolve', box).onclick = async () => {
    const ok = await confirmDialog({ title: 'dissolve this room', body: 'every member sees it end. history stays on each device; nothing new can be sent.', okLabel: 'dissolve', danger: true, typeToConfirm: 'dissolve' });
    if (!ok) return;
    try {
      if (call.roomId === room.id) await leaveCall();
      await dissolveRoom(room); await deleteRoom(room.id);
      closeOverlay(); location.hash = '#/rooms'; toast('dissolved', 'ok');
    } catch (err) { toast(err.message, 'error'); }
  };
}

// ---------- location ----------

async function whereSheet(conv) {
  const msgs = (await loadMessages(conv.id)).filter((m) => m.kind === 'location');
  const latest = new Map();
  for (const m of msgs) if (m.fp !== state.identity.fingerprint) latest.set(m.fp, m);
  const points = Array.from(latest.values()).map((m) => ({ ...m, lat: Number(m.lat), lon: Number(m.lon), label: conv.nameOf(m.fp), stale: Date.now() - new Date(m.rx || m.ts).getTime() > 15 * 60 * 1000 })).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  const src = tileSource();
  const box = openOverlay(`
    <div class="row between"><h3>where</h3><button class="ghost small" id="wh-close">close</button></div>
    <p style="margin-top:.6rem;color:var(--muted);font-size:.9rem">nothing is read from this device's location until you tap share. what you share goes sealed to ${conv.isRoom ? 'this room' : escapeHtml(conv.name)} only.</p>
    <div class="row" style="margin-top:.8rem"><button class="accent small" id="wh-share">share where i am once</button><button class="small ${liveShareRoomId === conv.id ? 'danger' : ''}" id="wh-live">${liveShareRoomId === conv.id ? 'stop live sharing' : 'share live (every 20 s)'}</button><button class="small ghost" id="wh-locate">locate me for the radar</button></div>
    <div id="wh-status" class="hint" style="color:var(--dim);margin-top:.6rem"></div>
    <div class="radar"><canvas id="radar" width="320" height="320"></canvas></div>
    <div id="wh-list" class="list"></div>
    ${src ? '<div class="mapbox" id="wh-map" style="margin-top:1rem"></div>' : '<p class="hint" style="color:var(--dim);margin-top:.8rem">no map tiles enabled (privacy → map). the radar above needs none.</p>'}
  `);
  $('#wh-close', box).onclick = () => { closeOverlay(); stopCompass(); };
  const canvas = $('#radar', box);
  let heading = null;
  const paint = () => {
    if (myPos) drawRadar(canvas, myPos, points, heading);
    else { const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height); }
    $('#wh-list', box).innerHTML = points.length ? points.map((p) => `<div class="item-row"><div class="t"><div class="name">${escapeHtml(p.label)}${p.stale ? ' <span style="color:var(--dim)">(old)</span>' : ''}</div><p class="sub">${myPos ? `${fmtDistance(distanceM(myPos, p))} · bearing ${Math.round(bearingDeg(myPos, p))}° ${compassPoint(bearingDeg(myPos, p))}` : `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`} · ±${Number(p.acc) || '?'} m · ${relativeTime(p.rx || p.ts)}</p><p class="sub">${externalMapLinks(p).map((l) => `<a href="${escapeHtml(l.href)}" target="_blank" rel="noopener noreferrer">${l.label}</a>`).join(' · ')}</p></div></div>`).join('') : '<div class="empty">nobody here has shared a location yet.</div>';
  };
  paint();
  if (src) renderMap($('#wh-map', box), myPos, points).catch((e) => toast(`map: ${e.message}`, 'error'));
  const status = (t) => { $('#wh-status', box).textContent = t; };
  $('#wh-locate', box).onclick = async () => {
    status('reading position…');
    try {
      myPos = await currentPosition();
      status(`you: ${myPos.lat.toFixed(5)}, ${myPos.lon.toFixed(5)} ±${myPos.acc} m (kept in memory only)`);
      paint();
      await startCompass((h) => { heading = h; paint(); });
    } catch (e) { status(e.message); }
  };
  $('#wh-share', box).onclick = async () => {
    status('reading position…');
    try {
      myPos = await currentPosition();
      await conv.send('location', { lat: myPos.lat, lon: myPos.lon, acc: myPos.acc, live: false });
      status('shared once');
      paint();
    } catch (e) { status(e.message); }
  };
  $('#wh-live', box).onclick = async () => {
    const b = $('#wh-live', box);
    if (liveShareRoomId === conv.id) { stopLiveShare(); status('live sharing stopped'); b.textContent = 'share live (every 20 s)'; b.classList.remove('danger'); return; }
    stopLiveShare();
    try {
      liveShareStop = watchPosition(async (p) => {
        myPos = p;
        try { await conv.send('location', { lat: p.lat, lon: p.lon, acc: p.acc, live: true }); } catch { /* beacon gone; keep watching */ }
      }, { minIntervalMs: 20000 });
      liveShareRoomId = conv.id;
      status('live: your position goes out every 20 s until you stop or lock');
      b.textContent = 'stop live sharing'; b.classList.add('danger');
    } catch (e) { status(e.message); }
  };
}

// ---------- calls ----------

function paintCallPanel() {
  const panel = $('#call-panel');
  if (!panel) return;
  const s = callSnapshot();
  const btn = $('#room-call');
  if (btn) { btn.textContent = s.active && s.roomId === currentRoomId ? 'leave call' : 'call'; btn.className = `small ${s.active && s.roomId === currentRoomId ? 'danger' : 'accent'}`; }
  if (!s.active || s.roomId !== currentRoomId) { panel.innerHTML = ''; return; }
  const conv = getConv(s.roomId);
  const mins = Math.floor((Date.now() - s.since) / 60000);
  panel.innerHTML = `
    <div class="callpanel">
      <div class="row between"><div><span class="pulse"></span>in the call · ${mins} min · peer to peer on this network</div><div class="row"><button class="small ${s.muted ? 'accent' : ''}" id="c-mute">${s.muted ? 'unmute' : 'mute'}</button><button class="small ${s.video ? 'accent' : ''}" id="c-video">${s.video ? 'camera off' : 'camera'}</button><button class="small ghost" id="c-audio">sound</button></div></div>
      <div class="who">${s.peers.length ? s.peers.map((p) => `<span class="${p.state === 'connected' ? 'on' : p.state === 'failed' ? 'off' : ''}">${escapeHtml(conv ? conv.nameOf(p.fp) : p.fp.slice(0, 8))} · ${p.state}</span>`).join('') : '<span>waiting for others to join</span>'}</div>
      <div class="videos" id="c-videos"></div>
      <p class="hint" style="color:var(--dim);font-size:.78rem;margin:0">audio and video go straight between phones, encrypted, never through the beacon. if a peer stays at "connecting", this wi-fi isolates its clients; chat still works.</p>
    </div>`;
  const vids = $('#c-videos');
  for (const [, p] of call.peers) if (p.videoEl) vids.appendChild(p.videoEl);
  $('#c-mute').onclick = toggleMute;
  $('#c-video').onclick = () => toggleVideo().catch((e) => toast(`camera: ${e.message}`, 'error'));
  $('#c-audio').onclick = resumeAudio;
}
on('call:state', paintCallPanel);
setInterval(() => { if (call.roomId && call.roomId === currentRoomId) paintCallPanel(); }, 30000);

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
      <div class="t"><div class="name">${escapeHtml(n.title || 'untitled')}</div><p class="sub" data-shielded>${escapeHtml((n.body || '').slice(0, 90))}${(n.body || '').length > 90 ? '…' : ''}</p><p class="sub">${n.from ? `from ${escapeHtml(n.from)} · ` : ''}${relativeTime(n.updatedAt)}</p></div>
      <div class="a"><button class="small ghost" data-act="open">open</button></div>
    </div>`).join('');
  list.onclick = (e) => {
    if (e.target.closest('[data-shielded]')) return;
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
      <div class="field"><label for="n-body">body</label><textarea id="n-body" maxlength="6000" autocomplete="off" autocorrect="off" spellcheck="false" data-gramm="false" data-enable-grammarly="false">${escapeHtml(n.body)}</textarea><div class="hint">up to 6000 characters. anything longer than about 500 characters becomes a multi-frame code when handed across.</div></div>
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
  if (state.settings.quietKeys === 'quiet') quietKeyboard([$('#n-title'), $('#n-body')], { mount: $('#n-body').closest('.field') }).open();
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
      <p style="white-space:pre-wrap;margin-top:.6rem" data-shielded>${escapeHtml(body.body || '')}</p>
      <div class="row" style="margin-top:1rem"><button class="accent" id="r-save">save as note</button></div>
    </div>`;
  $('#r-save', out).onclick = async () => {
    await saveNote({ id: uuid(), title: String(body.title || ''), body: String(body.body || ''), from: sender.name, createdAt: body.ts || nowIso(), updatedAt: nowIso() });
    await db.put('seen', { id: seenKey, t: nowIso() });
    await saveDevice({ ...sender, lastTransferAt: nowIso() });
    toast('saved', 'ok');
    location.hash = '#/notes';
  };
}

// ---------- privacy ----------

async function permissionState(name) {
  try {
    if (!navigator.permissions || !navigator.permissions.query) return 'unknown';
    const p = await navigator.permissions.query({ name });
    return p.state;
  } catch { return 'unknown'; }
}

async function viewPrivacy(el) {
  const s = state.settings;
  const ns = notificationSupport();
  const perms = {
    camera: await permissionState('camera'),
    microphone: await permissionState('microphone'),
    geolocation: await permissionState('geolocation'),
    notifications: ns.permission,
  };
  const beaconHttp = (() => { try { const u = new URL((s.beaconUrl || '').replace(/^ws/i, 'http')); return `http://${u.hostname}:8080/`; } catch { return null; } })();
  el.innerHTML = `
    <section>
      <h2>privacy</h2>
      <div class="sub">what this console can reach, and what it is allowed to. everything defaults to off.</div>

      <div class="card">
        <h3>beacon</h3>
        <p style="margin-top:.6rem">a beacon is a small relay someone runs on a laptop or a hotspot in the room. it carries rooms and call setup as ciphertext it cannot read. nothing connects until you say so here.</p>
        <div class="field" style="margin-top:1rem"><label for="b-url">address</label><input id="b-url" type="text" value="${escapeHtml(s.beaconUrl)}" placeholder="wss://192.168.4.1:8443/ws" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
        <div class="field"><label for="b-pw">password (if the beacon has one)</label><input id="b-pw" type="password" value="${escapeHtml(s.beaconPassword)}" autocomplete="off"></div>
        <div class="row"><button class="small" id="b-connect">${beacon.status === 'on' || beacon.status === 'connecting' ? 'disconnect' : 'connect'}</button><label class="row" style="margin:0;gap:.4rem"><input type="checkbox" id="b-auto" ${s.beaconAuto ? 'checked' : ''}> reconnect on unlock</label><span class="beaconchip ${beacon.status}" id="top-beacon"><i></i><span></span></span></div>
        <p class="hint" style="color:var(--dim);margin-top:.8rem">${beaconHttp ? `first time on this beacon: install its certificate from <span class="mono">${escapeHtml(beaconHttp)}</span>, then come back.` : 'first time on a beacon: open its install page (http://its-address:8080/) to trust its certificate, then connect here.'} ${beacon.lastError ? `<br><span style="color:var(--danger)">${escapeHtml(beacon.lastError)}</span>` : ''}</p>
      </div>

      <div class="card" style="margin-top:1rem">
        <h3>shield</h3>
        <p style="margin-top:.6rem">on: messages and photos blur until you press and hold one, one at a time and for at most eight seconds; the app veils itself whenever it is not in front; shielded text cannot be selected, copied or dragged. a page cannot stop the operating system, a browser extension or a screen recorder from capturing the screen: a recording taken frame by frame gets one held message, nothing more. the native app on iphone blanks itself while a recording runs.</p>
        <div class="choice" style="margin-top:.8rem"><button class="small ${s.shield ? 'on' : ''}" data-shield="1">on</button><button class="small ${s.shield ? '' : 'on'}" data-shield="0">off</button></div>
      </div>

      <div class="card" style="margin-top:1rem">
        <h3>typing</h3>
        <p style="margin-top:.6rem">the system keyboard sees everything typed into it, and so does any keyboard app, input method or keystroke logger installed on the device. the on-page keyboard is drawn by the console, shuffled each time it opens, and what you type on it never leaves this page. it is slower. the passphrase screens offer it always; this switch uses it for every message and note too. neither keyboard helps against a browser extension or a compromised browser, which read the page itself.</p>
        <div class="choice" style="margin-top:.8rem"><button class="small ${s.quietKeys !== 'quiet' ? 'on' : ''}" data-quiet-keys="system">system keyboard</button><button class="small ${s.quietKeys === 'quiet' ? 'on' : ''}" data-quiet-keys="quiet">on-page keyboard</button></div>
        <p class="hint" style="color:var(--dim);margin-top:.8rem">either way, the composer and the notes editor never hand text to cloud spell-check or a writing assistant.</p>
      </div>

      <div class="card" style="margin-top:1rem">
        <h3>notifications</h3>
        <p style="margin-top:.6rem">a notification names who wrote, never what. it fires while the console is open in a tab or installed and running in the background; there is no push server, so a closed console cannot be woken.</p>
        <div class="choice" style="margin-top:.8rem">${['off', 'sender', 'silent'].map((m) => `<button class="small ${s.notifications === m ? 'on' : ''}" data-notif="${m}">${{ off: 'none', sender: 'sender only', silent: 'a dot, no name' }[m]}</button>`).join('')}</div>
        <p class="hint" style="color:var(--dim);margin-top:.6rem">permission: <span class="mono">${ns.permission}</span>${ns.supported && ns.permission !== 'granted' ? ' · <a href="#" id="notif-ask">ask the browser</a>' : ''}</p>
      </div>

      <div class="card" style="margin-top:1rem">
        <h3>location and map</h3>
        <p style="margin-top:.6rem">location is read only when you tap share inside a room, and goes sealed to that room. the radar needs no map. loading map tiles means asking a tile server for the area you are looking at, which tells that server roughly where you are.</p>
        <div class="choice" style="margin-top:.8rem">${['none', 'beacon', 'osm'].map((m) => `<button class="small ${s.tiles === m ? 'on' : ''}" data-tiles="${m}">${{ none: 'no tiles (radar only)', beacon: 'tiles from the beacon', osm: 'openstreetmap.org (internet)' }[m]}</button>`).join('')}</div>
      </div>

      <div class="card" style="margin-top:1rem">
        <h3>calls</h3>
        <p style="margin-top:.6rem">calls go directly between phones on the local network. with no entries below, no outside server is ever contacted. if you also want calls across the internet, add stun or turn servers you trust, one per line.</p>
        <div class="field" style="margin-top:.8rem"><label for="ice">ice servers (optional)</label><textarea id="ice" rows="2" placeholder="stun:stun.example.org:3478" spellcheck="false">${escapeHtml(s.iceServers)}</textarea></div>
        <button class="small" id="ice-save">save</button>
      </div>

      <div class="card" style="margin-top:1rem">
        <h3>permissions this browser has granted</h3>
        <div style="margin-top:.6rem">
          ${permRow('camera', 'used only while scanning a code or when you turn video on in a call', perms.camera)}
          ${permRow('microphone', 'used only during a call you joined', perms.microphone)}
          ${permRow('location', 'used only when you tap share in a room', perms.geolocation)}
          ${permRow('notifications', 'sender name only', perms.notifications)}
        </div>
        <p class="hint" style="color:var(--dim);margin-top:.8rem">revoke any of these in the browser's site settings; the console keeps working without them.</p>
      </div>

      <div class="card" style="margin-top:1rem">
        <h3>what leaves this device</h3>
        <ul class="never" style="margin-top:.6rem">
          <li>to the site that served the console: nothing after the first load; files come from the cache.</li>
          <li>to a beacon you configured: sealed room messages, sealed pair messages, call setup inside sealed messages, and random daily tags. no names, no keys, no plaintext.</li>
          <li>to other phones in a call: encrypted audio and video, directly.</li>
          <li>to openstreetmap.org: tile requests for the visible map area, only if you enabled it above.</li>
          <li>to anyone else: nothing. there is no analytics, no account, no telemetry.</li>
        </ul>
      </div>
    </section>`;
  paintBeaconChip();
  $('#b-connect').onclick = async () => {
    const busy = beacon.status === 'on' || beacon.status === 'connecting';
    let typed = null;
    try { typed = normalizeBeaconUrl($('#b-url').value); } catch (e) { if (busy) typed = null; else return toast(e.message, 'error'); }
    // the same address while connected or connecting: disconnect. a different
    // address: drop the current attempt and go to the new one in a single press
    if (busy && (!typed || typed === s.beaconUrl)) { disconnectBeacon(); $('#b-connect').textContent = 'connect'; return; }
    if (busy) disconnectBeacon();
    try {
      const url = typed;
      s.beaconUrl = url; s.beaconPassword = $('#b-pw').value; s.beaconAuto = $('#b-auto').checked;
      await saveSettings();
      connectBeacon(url, s.beaconPassword);
      $('#b-connect').textContent = 'disconnect';
    } catch (e) { toast(e.message, 'error'); }
  };
  $('#b-auto').onchange = async () => { s.beaconAuto = $('#b-auto').checked; await saveSettings(); };
  el.onclick = async (e) => {
    const sh = e.target.closest('[data-shield]'); const nt = e.target.closest('[data-notif]'); const tl = e.target.closest('[data-tiles]');
    if (sh) { s.shield = sh.dataset.shield === '1'; await saveSettings(); viewPrivacy(el); }
    const qk = e.target.closest('[data-quiet-keys]');
    if (qk) { s.quietKeys = qk.dataset.quietKeys === 'quiet' ? 'quiet' : 'system'; await saveSettings(); viewPrivacy(el); }
    if (nt) { s.notifications = nt.dataset.notif; await saveSettings(); if (s.notifications !== 'off' && ns.permission === 'default') await requestNotifications(); viewPrivacy(el); }
    if (tl) {
      if (tl.dataset.tiles === 'osm' && s.tiles !== 'osm') {
        const ok = await confirmDialog({ title: 'load tiles from openstreetmap.org', body: 'each map view sends the tile coordinates you look at to openstreetmap.org over the internet. that reveals the area, not your exact position, and only while you look. the beacon and rooms are unaffected.', okLabel: 'allow' });
        if (!ok) return;
      }
      s.tiles = tl.dataset.tiles; await saveSettings(); viewPrivacy(el);
    }
  };
  const ask = $('#notif-ask');
  if (ask) ask.onclick = async (e) => { e.preventDefault(); await requestNotifications(); viewPrivacy(el); };
  $('#ice-save').onclick = async () => {
    const lines = $('#ice').value.split('\n').map((x) => x.trim()).filter(Boolean);
    if (lines.some((l) => !/^(stun|stuns|turn|turns):/.test(l))) return toast('entries must start with stun: or turn:', 'error');
    s.iceServers = lines.join('\n'); await saveSettings(); toast('saved', 'ok');
  };
}

function permRow(k, why, v) {
  return `<div class="perm"><div class="k">${k}<small>${why}</small></div><div class="v ${v === 'granted' ? 'on' : v === 'denied' ? 'off' : ''}">${v}</div></div>`;
}

// ---------- settings ----------

function viewSettings(el) {
  el.innerHTML = `
    <section>
      <h2>settings</h2>
      <div class="sub">everything here acts on this device only.</div>

      <div class="card"><h3>light</h3>
        <p style="margin-top:.6rem">the sky as it is, or deeper: the picture dimmed and the glass denser, for a dark room or a battery that has to last.</p>
        <div class="choice" style="margin-top:.8rem"><button class="small ${state.settings.theme !== 'deep' ? 'on' : ''}" data-theme-pick="night">night</button><button class="small ${state.settings.theme === 'deep' ? 'on' : ''}" data-theme-pick="deep">deep</button></div>
      </div>

      <div class="card" style="margin-top:1rem"><h3>auto-lock</h3>
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

      <div class="card" style="margin-top:1rem"><h3>install</h3>
        <p style="margin-top:.6rem">${isStandalone() ? 'this copy is installed and runs in its own window.' : 'install from the web, no store. the installed copy is this page, cached, in its own window, working offline.'}</p>
        ${isStandalone() ? '' : '<button class="small" id="st-install">install</button>'}
      </div>

      <div class="card" style="margin-top:1rem"><h3>backup</h3>
        <p style="margin-top:.6rem">the export is the sealed vault as it sits on disk: useless without the passphrase. keep it on a memory card or another phone. importing replaces everything here.</p>
        <div class="row"><button class="small" id="st-export">export sealed backup</button><label class="small" style="margin:0"><input type="file" id="st-import" accept="application/json,.json" hidden><button class="small" type="button" id="st-import-btn">import backup</button></label></div>
      </div>

      <div class="card" style="margin-top:1rem;border-color:var(--danger-soft)"><h3>erase</h3>
        <p style="margin-top:.6rem">deletes the profile, identity keys, paired devices, rooms and notes from this device. the console itself stays installed.</p>
        <button class="danger small" id="st-wipe">erase everything</button>
      </div>
      <p class="locked-note">pairing key fingerprint <span class="mono">${state.identity.fingerprint}</span></p>
    </section>`;

  el.querySelectorAll('[data-theme-pick]').forEach((b) => { b.onclick = async () => { state.settings.theme = b.dataset.themePick === 'deep' ? 'deep' : 'night'; await saveSettings(); viewSettings(el); }; });
  $('#st-lock-save').onclick = async () => {
    const v = Math.max(0, Math.min(240, Number($('#st-lock').value) || 0));
    state.settings.autoLockMinutes = v;
    await saveSettings(); armIdleLock(); toast('saved', 'ok');
    renderShell(); route();
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

  const ins = $('#st-install');
  if (ins) ins.onclick = installFlow;

  $('#st-export').onclick = async () => {
    const dump = { format: 'gabriel-console-backup', version: 1, exportedAt: nowIso(), stores: {} };
    for (const s of db.STORES) dump.stores[s] = await db.all(s);
    download(`gabriel-console-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(dump));
  };
  $('#st-import-btn').onclick = () => $('#st-import').click();
  $('#st-import').onchange = async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    if (f.size > 64 * 1024 * 1024) return toast('backup file is implausibly large', 'error');
    let dump;
    try { dump = JSON.parse(await f.text()); } catch { return toast('that file is not a backup', 'error'); }
    if (!dump || dump.format !== 'gabriel-console-backup' || dump.version !== 1 || !dump.stores || !Array.isArray(dump.stores.meta)) return toast('that file is not a backup', 'error');
    const profile = dump.stores.meta.find((r) => r && r.id === 'profile');
    const identity = dump.stores.meta.find((r) => r && r.id === 'identity');
    if (!profile || !identity || typeof profile.name !== 'string' || !profile.kdf || !profile.wrap) return toast('backup is missing its profile', 'error');
    const ok = await confirmDialog({ title: 'replace this device\'s data', body: `everything here is replaced by the backup of <strong style="font-weight:400">${escapeHtml(profile.name)}</strong> exported ${relativeTime(dump.exportedAt)}. you will need that profile's passphrase to unlock it.`, okLabel: 'replace', danger: true, typeToConfirm: 'replace' });
    if (!ok) return;
    try {
      await db.clearAll();
      for (const s of db.STORES) {
        for (const r of dump.stores[s] || []) {
          if (!r || typeof r !== 'object' || typeof r.id !== 'string') continue;
          await db.put(s, r);
        }
      }
      await loadProfile();
      lock('backup imported; unlock with its passphrase');
    } catch (err) { toast(`import failed: ${err.message}`, 'error'); }
  };
  $('#st-wipe').onclick = wipeEverything;
}

// ---------- boot ----------

async function main() {
  document.documentElement.classList.add('app-ready'); // tells the boot guard the module is alive
  watchOnline((online) => {
    const p = $('#net-pill');
    p.classList.toggle('on', !online);
    p.textContent = online ? 'online' : 'offline';
  });
  installShield();
  watchInstallPrompt();
  on('install:available', () => { if (state.route === 'overview' && state.vaultKey) route(); });
  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'navigate' && state.vaultKey && typeof e.data.route === 'string' && e.data.route.startsWith('#/')) location.hash = e.data.route;
    });
  }
  onWorkerUpdate(() => {
    if (!state.vaultKey) { location.reload(); return; }
    reloadOnLock = true;
    toast('a newer version is ready. it appears when you next lock.');
  });
  registerServiceWorker().then(async () => { state.readiness = await offlineReadiness(); if (state.route === 'overview' && state.vaultKey) route(); });
  await loadProfile();
  renderGate();
}

main().catch((e) => {
  root.innerHTML = `<div class="gate"><div class="panel"><h1>the console could not start</h1><p>${escapeHtml(e.message)}</p><p>if this browser is in a private window, storage may be disabled. try a normal window.</p></div></div>`;
});
