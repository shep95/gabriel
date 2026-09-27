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
};

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

export function disconnectBeacon() {
  beacon.wanted = false;
  clearTimeout(beacon.timer);
  if (beacon.ws) { try { beacon.ws.close(1000, 'bye'); } catch { /* already gone */ } }
  beacon.ws = null;
  beacon.sessionId = null;
  beacon.counts.clear();
  setStatus('off');
}

function open() {
  if (!beacon.wanted || !beacon.url) return;
  clearTimeout(beacon.timer);
  setStatus('connecting');
  let ws;
  try { ws = new WebSocket(beacon.url); } catch (e) { setStatus('error', e.message); scheduleRetry(); return; }
  beacon.ws = ws;
  let helloTimer = setTimeout(() => { if (ws.readyState === WebSocket.OPEN) send({ t: 'hello', v: 1, pw: beacon.password }); }, 0);
  ws.onopen = () => { clearTimeout(helloTimer); send({ t: 'hello', v: 1, pw: beacon.password }); };
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string' || ev.data.length > MAX_FRAME + 4096) return;
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    handle(m);
  };
  ws.onerror = () => { /* onclose follows with the reason we can act on */ };
  ws.onclose = (ev) => {
    if (beacon.ws === ws) beacon.ws = null;
    beacon.sessionId = null;
    for (const [, p] of beacon.pending) p.reject(new Error('beacon disconnected'));
    beacon.pending.clear();
    if (ev.code === 4001) { beacon.wanted = false; setStatus('error', 'beacon refused the password'); return; }
    if (beacon.wanted) { setStatus('connecting', ev.reason || `closed (${ev.code})`); scheduleRetry(); } else setStatus('off');
  };
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
      if (beacon.tags.size) send({ t: 'sub', tags: Array.from(beacon.tags) });
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
    case 'error':
      emit('beacon:error', m);
      if (m.code === 'auth') setStatus('error', 'beacon refused the password');
      break;
    case 'pong':
      break;
    default:
      break;
  }
}

export function subscribe(tags) {
  const fresh = tags.filter((t) => /^[0-9a-f]{32,64}$/.test(t) && !beacon.tags.has(t));
  for (const t of fresh) beacon.tags.add(t);
  if (fresh.length && beacon.status === 'on') send({ t: 'sub', tags: fresh });
}

export function unsubscribe(tags) {
  const gone = tags.filter((t) => beacon.tags.delete(t));
  for (const t of gone) beacon.counts.delete(t);
  if (gone.length && beacon.status === 'on') send({ t: 'unsub', tags: gone });
}

// resolves when the beacon acknowledges; rejects when offline
export function publish(tag, data, keep = false) {
  return new Promise((resolve, reject) => {
    if (beacon.status !== 'on') return reject(new Error('not connected to a beacon'));
    if (typeof data !== 'string' || data.length > MAX_FRAME) return reject(new Error('frame too large for the beacon'));
    const id = Math.random().toString(16).slice(2, 10) + Date.now().toString(16);
    const timer = setTimeout(() => { beacon.pending.delete(id); reject(new Error('beacon did not acknowledge')); }, 8000);
    beacon.pending.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    if (!send({ t: 'pub', tag, data, keep, id })) { beacon.pending.delete(id); clearTimeout(timer); reject(new Error('not connected to a beacon')); }
  });
}

export function peersOn(tag) { return beacon.counts.get(tag) || 0; }
