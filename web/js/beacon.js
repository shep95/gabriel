// beacon client: one websocket to a local (or self-hosted) relay that fans out
// opaque strings by tag. everything that goes through here is already sealed;
// this module never sees a key. see beacon/README.md for the protocol.

import { emit } from './state.js';

const MAX_FRAME = 200_000;

export const beacon = {
  ws: null,
  url: '',
  password: '',
  status: 'off',        // off | connecting | on | error
  sessionId: null,
  info: null,           // welcome payload
  tags: new Set(),
  counts: new Map(),
  pending: new Map(),   // ack id -> resolve
  backoff: 1000,
  timer: null,
  wanted: false,
  lastError: '',
  lastIn: 0,            // when the last frame arrived; a silent socket is a dead one
  liveTimer: null,
};
const PING_MS = 20_000;
const SILENT_MS = 45_000;
const SUB_CHUNK = 64;

function setStatus(s, err = '') {
  beacon.status = s;
  beacon.lastError = err;
  emit('beacon:status', { status: s, error: err });
}

export function normalizeBeaconUrl(input) {
  let s = (input || '').trim();
  if (!s) return '';
  if (!/^wss?:\/\//i.test(s)) {
    if (/^https?:\/\//i.test(s)) s = s.replace(/^http/i, 'ws');
    else s = `wss://${s}`;
  }
  const u = new URL(s);
  if (!u.pathname || u.pathname === '/') u.pathname = '/ws';
  // plaintext websockets are only acceptable to the same machine; anything on
  // the network must be wss so the room ciphertext is not also trivially
  // correlatable by anyone with a sniffer on the hotspot
  if (u.protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) throw new Error('use wss:// for a beacon on the network');
  return u.toString();
}

export function connectBeacon(url, password = '') {
  beacon.url = normalizeBeaconUrl(url);
  beacon.password = password || '';
  beacon.wanted = true;
  beacon.backoff = 1000;
  open();
}

// drop a socket without hearing from it again
function silence(ws) {
  if (!ws) return;
  ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
  try { ws.close(1000, 'bye'); } catch { /* already gone */ }
}

export function disconnectBeacon() {
  beacon.wanted = false;
  clearTimeout(beacon.timer);
  clearInterval(beacon.liveTimer);
  silence(beacon.ws);
  beacon.ws = null;
  beacon.sessionId = null;
  beacon.counts.clear();
  for (const [, p] of beacon.pending) p.reject(new Error('beacon disconnected'));
  beacon.pending.clear();
  setStatus('off');
}

function open() {
  if (!beacon.wanted || !beacon.url) return;
  clearTimeout(beacon.timer);
  clearInterval(beacon.liveTimer);
  silence(beacon.ws); // a previous attempt still closing must not speak for this one
  setStatus('connecting');
  let ws;
  try { ws = new WebSocket(beacon.url); } catch (e) { setStatus('error', e.message); scheduleRetry(); return; }
  beacon.ws = ws;
  beacon.lastIn = Date.now();
  const hello = () => { if (beacon.ws === ws && ws.readyState === WebSocket.OPEN) send({ t: 'hello', v: 1, pw: beacon.password }); };
  const helloTimer = setTimeout(hello, 0);
  ws.onopen = () => { clearTimeout(helloTimer); hello(); };
  ws.onmessage = (ev) => {
    if (beacon.ws !== ws) return;
    if (typeof ev.data !== 'string' || ev.data.length > MAX_FRAME + 4096) return;
    beacon.lastIn = Date.now();
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    handle(m);
  };
  ws.onerror = () => { /* onclose follows with the reason we can act on */ };
  ws.onclose = (ev) => {
    if (beacon.ws !== ws) return; // an older socket; the live one speaks for itself
    clearTimeout(helloTimer);
    clearInterval(beacon.liveTimer);
    beacon.ws = null;
    beacon.sessionId = null;
    beacon.counts.clear();
    for (const [, p] of beacon.pending) p.reject(new Error('beacon disconnected'));
    beacon.pending.clear();
    if (ev.code === 4001) { beacon.wanted = false; setStatus('error', 'beacon refused the password'); return; }
    if (ev.code === 4002) { beacon.wanted = false; setStatus('error', 'this beacon speaks a newer protocol; update the console'); return; }
    if (beacon.wanted) { setStatus('connecting', ev.reason || `closed (${ev.code})`); scheduleRetry(); } else setStatus('off');
  };
  // liveness: a browser cannot see the relay's own pings, so we ask, and a
  // socket that has said nothing for a while is closed and reopened
  beacon.liveTimer = setInterval(() => {
    if (beacon.ws !== ws) { clearInterval(beacon.liveTimer); return; }
    if (Date.now() - beacon.lastIn > SILENT_MS) { try { ws.close(4999, 'silent'); } catch { /* ignore */ } return; }
    if (ws.readyState === WebSocket.OPEN) send({ t: 'ping' });
  }, PING_MS);
}

function scheduleRetry() {
  clearTimeout(beacon.timer);
  beacon.timer = setTimeout(open, beacon.backoff);
  beacon.backoff = Math.min(beacon.backoff * 2, 30_000);
}

function send(obj) {
  const ws = beacon.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(obj));
  return true;
}

function handle(m) {
  switch (m.t) {
    case 'welcome':
      beacon.sessionId = m.id;
      beacon.info = m;
      beacon.backoff = 1000;
      setStatus('on');
      sendSub(Array.from(beacon.tags));
      emit('beacon:welcome', m);
      break;
    case 'msg':
      if (typeof m.tag === 'string' && typeof m.data === 'string') emit('beacon:msg', m);
      break;
    case 'count':
      beacon.counts.set(m.tag, m.n);
      emit('beacon:count', m);
      break;
    case 'ack': {
      const r = beacon.pending.get(m.id);
      if (r) { beacon.pending.delete(m.id); r.resolve(m); }
      break;
    }
    case 'error': {
      emit('beacon:error', m);
      if (m.code === 'auth') setStatus('error', 'beacon refused the password');
      // a refused publication answers its own promise at once
      const r = typeof m.id === 'string' ? beacon.pending.get(m.id) : null;
      if (r) { beacon.pending.delete(m.id); r.reject(new Error(`beacon refused it (${m.code})`)); }
      break;
    }
    case 'pong':
      break;
    default:
      break;
  }
}

// tags go in frames of at most 64, the smallest limit a relay may hold
function sendSub(tags, t = 'sub') {
  for (let i = 0; i < tags.length; i += SUB_CHUNK) send({ t, tags: tags.slice(i, i + SUB_CHUNK) });
}

export function subscribe(tags) {
  const fresh = tags.filter((t) => /^[0-9a-f]{32,64}$/.test(t) && !beacon.tags.has(t));
  for (const t of fresh) beacon.tags.add(t);
  if (fresh.length && beacon.status === 'on') sendSub(fresh);
}

export function unsubscribe(tags) {
  const gone = tags.filter((t) => beacon.tags.delete(t));
  for (const t of gone) beacon.counts.delete(t);
  if (gone.length && beacon.status === 'on') sendSub(gone, 'unsub');
}

// resolves when the beacon acknowledges; rejects when offline
export function publish(tag, data, keep = false) {
  return new Promise((resolve, reject) => {
    if (beacon.status !== 'on') return reject(new Error('not connected to a beacon'));
    if (typeof data !== 'string' || data.length > MAX_FRAME) return reject(new Error('frame too large for the beacon'));
    const id = Math.random().toString(16).slice(2, 10) + Date.now().toString(16);
    const timer = setTimeout(() => {
      beacon.pending.delete(id);
      reject(new Error('beacon did not acknowledge'));
      // no ack and nothing else heard for a while: the socket is dead; reopen
      if (beacon.ws && Date.now() - beacon.lastIn > PING_MS) { try { beacon.ws.close(4999, 'silent'); } catch { /* ignore */ } }
    }, 8000);
    beacon.pending.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    if (!send({ t: 'pub', tag, data, keep, id })) { beacon.pending.delete(id); clearTimeout(timer); reject(new Error('not connected to a beacon')); }
  });
}

export function peersOn(tag) { return beacon.counts.get(tag) || 0; }

// ---------- finding a beacon without typing ----------
// a hotspot's own address is one of a handful in practice. a phone or laptop
// running the beacon on the hotspot answers on 8443; the probe is a websocket
// open and close, which fails at once when nothing is there or the certificate
// is not yet trusted, and never sends anything.
const HOTSPOT_GATEWAYS = ['172.20.10.1', '192.168.43.1', '192.168.137.1', '10.42.0.1', '192.168.4.1', '192.168.1.1', '192.168.0.1', '192.168.8.1', '10.0.0.1'];

function probe(url, timeoutMs) {
  return new Promise((resolve) => {
    let ws;
    try { ws = new WebSocket(url); } catch { return resolve(false); }
    const t = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } resolve(false); }, timeoutMs);
    ws.onopen = () => { clearTimeout(t); try { ws.close(1000, 'probe'); } catch { /* ignore */ } resolve(true); };
    ws.onerror = () => { clearTimeout(t); resolve(false); };
    ws.onclose = () => { clearTimeout(t); };
  });
}

// the page's own origin, when a beacon served it: the console connects to
// the machine it came from and nobody types an address
export async function servedByBeacon() {
  if (!/^https?:$/.test(location.protocol)) return null;
  try {
    const r = await fetch('./healthz', { cache: 'no-store', credentials: 'omit' });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || j.ok !== true) return null;
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  } catch { return null; }
}

// tries the hotspot addresses, the last known beacon first; resolves to a url or null
export async function discoverBeacon({ known = '', timeoutMs = 2500, onProgress } = {}) {
  const own = await servedByBeacon();
  if (own) return own;
  const candidates = [];
  if (known) { try { candidates.push(normalizeBeaconUrl(known)); } catch { /* ignore */ } }
  for (const ip of HOTSPOT_GATEWAYS) candidates.push(`wss://${ip}:8443/ws`);
  if (['localhost', '127.0.0.1'].includes(location.hostname)) candidates.push('ws://127.0.0.1:8443/ws');
  const seen = new Set();
  const list = candidates.filter((u) => !seen.has(u) && seen.add(u));
  // in parallel, a few at a time, first answer wins
  for (let i = 0; i < list.length; i += 4) {
    const batch = list.slice(i, i + 4);
    if (onProgress) onProgress(batch);
    const results = await Promise.all(batch.map((u) => probe(u, timeoutMs).then((ok) => (ok ? u : null))));
    const hit = results.find(Boolean);
    if (hit) return hit;
  }
  return null;
}
