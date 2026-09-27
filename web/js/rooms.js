// rooms and direct chats: end-to-end encrypted conversations carried by a beacon.
//
// trust model: you can only be added to a room by a device you have paired with
// in person (the invite travels sealed under that pair key). the founder holds
// the roster and rotates the epoch key whenever the roster shrinks. every room
// message is encrypted under the epoch key and signed by its sender; a direct
// chat is the pair channel itself. the beacon sees random tags and ciphertext.

import { b64url, uuid, nowIso, cleanName } from './util.js';
import {
  inboxTag, dayString, newRoomKey, newRoomId, roomTag, sealRoomMessage, openRoomMessage,
  sealMessage, parseEnvelopeHeader, openMessage, sealRecord, openRecord,
  sealDirectFrame, openDirectFrame, isDirectFrame,
} from './crypto.js';
import * as db from './db.js';
import { state, emit, on } from './state.js';
import { beacon, subscribe, unsubscribe, publish } from './beacon.js';

const MAX_MEMBERS = 24;
const MAX_HISTORY = 500;
const MAX_TEXT = 4000;
// media: photos, voice clips, small files. sealed like any message, carried in
// parts so every frame stays under the relay's limit; a part is base64url of a
// slice whose length is a multiple of three, so the parts join back into one
// valid string without decoding each.
export const MAX_MEDIA_BYTES = 1_500_000;
const MEDIA_CHUNK = 84 * 1024;
const MAX_MEDIA_PARTS = Math.ceil(MAX_MEDIA_BYTES / MEDIA_CHUNK);
const MAX_MEDIA_PENDING = 8;          // half-received media per conversation
const MEDIA_PENDING_MS = 10 * 60_000;
const MIME = /^[a-z0-9!#$&^_.+-]{1,40}\/[a-z0-9!#$&^_.+-]{1,80}$/i;
const B64URL = /^[A-Za-z0-9_-]*$/;
const MAX_EPOCH = 1_000_000;
const ROOM_ID = /^[0-9a-f]{16}$/;
const FP = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TS_PAST_MS = 30 * 86_400_000;
const TS_FUTURE_MS = 5 * 60_000;

function finiteInRange(v, lo, hi) { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; }
function isKey32(b64) { try { return typeof b64 === 'string' && b64url.decode(b64).length === 32; } catch { return false; } }

// a sender's timestamp is shown when plausible; ordering and pruning always
// use the time this device received the message, which nobody else controls
function acceptedTs(ts, rx) {
  const t = typeof ts === 'string' ? Date.parse(ts) : NaN;
  const now = Date.parse(rx);
  if (Number.isNaN(t) || t > now + TS_FUTURE_MS || t < now - TS_PAST_MS) return rx;
  return ts;
}

// ---------- persistence ----------

export async function loadRooms() {
  const recs = await db.all('rooms');
  state.rooms = [];
  for (const r of recs) {
    try { state.rooms.push({ id: r.id, ...(await openRecord(state.vaultKey, 'rooms', r.id, r.enc)) }); }
    catch { /* sealed under another key */ }
  }
  state.rooms.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export async function saveRoom(room) {
  const { id, ...plain } = room;
  await db.put('rooms', { id, enc: await sealRecord(state.vaultKey, 'rooms', id, plain) });
  const i = state.rooms.findIndex((r) => r.id === id);
  if (i >= 0) state.rooms[i] = room; else state.rooms.unshift(room);
}

export async function deleteRoom(roomId) {
  await db.del('rooms', roomId);
  await deleteConversationMessages(roomId);
  state.rooms = state.rooms.filter((r) => r.id !== roomId);
  const t = tagsByRoom.get(roomId);
  if (t) { unsubscribe([t]); tagsByRoom.delete(roomId); roomsByTag.delete(t); }
}

export async function deleteConversationMessages(convId) {
  for (const m of await db.byIndex('messages', 'room', convId)) await db.del('messages', m.id);
}

export async function loadMessages(convId) {
  const recs = await db.byIndex('messages', 'room', convId);
  const out = [];
  for (const r of recs) {
    try { out.push({ id: r.id, ...(await openRecord(state.vaultKey, 'messages', r.id, r.enc)) }); }
    catch { /* skip */ }
  }
  out.sort((a, b) => (a.rx || a.ts || '').localeCompare(b.rx || b.ts || ''));
  return out;
}

async function storeMessage(convId, msg) {
  const rec = { id: msg.id, roomId: convId, enc: await sealRecord(state.vaultKey, 'messages', msg.id, msg) };
  await db.put('messages', rec);
  const all = await db.byIndex('messages', 'room', convId);
  // prune in batches so the cost is paid once per fifty messages, not per message
  if (all.length > MAX_HISTORY + 50) {
    const opened = [];
    for (const r of all) { try { opened.push({ id: r.id, rx: (await openRecord(state.vaultKey, 'messages', r.id, r.enc)).rx || '' }); } catch { opened.push({ id: r.id, rx: '' }); } }
    opened.sort((a, b) => a.rx.localeCompare(b.rx));
    for (const r of opened.slice(0, all.length - MAX_HISTORY)) await db.del('messages', r.id);
  }
}

// ---------- tag bookkeeping ----------

const roomsByTag = new Map();   // tag -> roomId
const tagsByRoom = new Map();   // roomId -> tag
const inboxByTag = new Map();   // tag -> deviceId
const tagsByDevice = new Map(); // deviceId -> today's tag
let inboxDay = null;

function currentKey(room) {
  const k = room.keys[String(room.epoch)];
  if (!isKey32(k)) throw new Error('room has no usable key');
  return b64url.decode(k);
}

export async function refreshSubscriptions() {
  if (!state.vaultKey || !state.identity) return;
  const wanted = [];
  for (const room of state.rooms) {
    if (room.left) continue;
    try {
      const tag = await roomTag(currentKey(room));
      const old = tagsByRoom.get(room.id);
      if (old && old !== tag) { unsubscribe([old]); roomsByTag.delete(old); }
      tagsByRoom.set(room.id, tag); roomsByTag.set(tag, room.id); wanted.push(tag);
    } catch {
      // one broken room must not silence every other conversation
    }
  }
  // pair inboxes for today and yesterday, so a clock a few hours off still meets
  const today = dayString();
  const yesterday = dayString(new Date(Date.now() - 86_400_000));
  const stillWanted = new Set();
  for (const dev of state.devices) {
    if (!isKey32(dev.pairKey)) continue;
    const pk = b64url.decode(dev.pairKey);
    for (const day of [today, yesterday]) {
      const tag = await inboxTag(pk, day);
      inboxByTag.set(tag, dev.id); stillWanted.add(tag); wanted.push(tag);
      if (day === today) tagsByDevice.set(dev.id, tag);
    }
  }
  for (const [tag] of inboxByTag) if (!stillWanted.has(tag)) { unsubscribe([tag]); inboxByTag.delete(tag); }
  inboxDay = today;
  subscribe(wanted);
}

// re-derive inbox tags when the day changes
setInterval(() => { if (inboxDay && inboxDay !== dayString()) refreshSubscriptions().catch(() => {}); }, 60_000);

// ---------- direct (pair) channel ----------

export function dmId(dev) { return `dm:${dev.id}`; }
export function deviceForDm(convId) {
  if (!convId.startsWith('dm:')) return null;
  return state.devices.find((d) => d.id === convId.slice(3)) || null;
}

async function sendDirect(dev, payload, keep = true, large = false) {
  if (!isKey32(dev.pairKey)) throw new Error('this pairing is unusable; pair again');
  const seal = large ? sealDirectFrame : sealMessage;
  const env = await seal(b64url.decode(dev.pairKey), state.identity.fingerprint, dev.fingerprint, payload);
  const tag = await inboxTag(b64url.decode(dev.pairKey));
  await publish(tag, env.text, keep);
  return env;
}

// a direct chat message: sealed under the pair key, stored under dm:<device>
export async function sendDirectMessage(dev, kind, body, { keep = true } = {}) {
  if (kind === 'text' && (typeof body.text !== 'string' || !body.text.trim())) throw new Error('nothing to send');
  if (kind === 'text' && body.text.length > MAX_TEXT) throw new Error(`message longer than ${MAX_TEXT} characters`);
  const env = await sendDirect(dev, { kind, ...body }, keep);
  const msg = { id: env.id, fp: state.identity.fingerprint, ts: nowIso(), rx: nowIso(), kind, ...body };
  if (kind === 'text' || kind === 'location') {
    await storeMessage(dmId(dev), msg);
    await touchDevice(dev);
    emit('room:message', { roomId: dmId(dev), msg, mine: true });
  }
  return msg;
}

async function touchDevice(dev) {
  const { id, ...plain } = { ...dev, lastTransferAt: nowIso() };
  await db.put('devices', { id, enc: await sealRecord(state.vaultKey, 'devices', id, plain) });
  const i = state.devices.findIndex((d) => d.id === id);
  if (i >= 0) state.devices[i] = { id, ...plain };
}

async function handleDirect(dev, text) {
  let body;
  if (isDirectFrame(text)) {
    try { body = await openDirectFrame(b64url.decode(dev.pairKey), dev.fingerprint, state.identity.fingerprint, text); } catch { return; }
  } else {
    let header;
    try { header = parseEnvelopeHeader(text); } catch { return; }
    if (!dev.fingerprint.startsWith(header.senderFpPrefix)) return;
    try { body = await openMessage(b64url.decode(dev.pairKey), dev.fingerprint, state.identity.fingerprint, header); }
    catch { return; }
  }
  if (!UUID.test(body.id)) return;
  const seenKey = `dev|${dev.id}|${body.id}`;
  if (await db.get('seen', seenKey)) return;
  await db.put('seen', { id: seenKey, t: nowIso() });
  const sender = { fp: dev.fingerprint, name: dev.name };
  switch (body.kind) {
    case 'room-invite': return acceptInvite(dev, body.room);
    case 'room-key': return acceptKeyUpdate(dev, body);
    case 'note': return emit('direct:note', { from: dev, body });
    case 'text':
    case 'location': {
      const msg = normalizeMessage({ ...body, fp: dev.fingerprint });
      if (!msg) return;
      await storeMessage(dmId(dev), msg);
      await touchDevice(dev);
      return emit('room:message', { roomId: dmId(dev), msg, mine: false, replay: false, sender });
    }
    case 'call':
      return emit('room:call', { roomId: dmId(dev), msg: { ...body, fp: dev.fingerprint }, sender });
    case 'media':
      return acceptMediaPart(dmId(dev), body, dev.fingerprint, { sender, replay: false, afterStore: () => touchDevice(dev) });
    default:
      return undefined;
  }
}

// ---------- media ----------

const mediaPending = new Map(); // `${convId}|${mediaId}` -> { meta, fp, parts, got, at }

function validMediaPart(m) {
  return UUID.test(m.mediaId)
    && Number.isInteger(m.parts) && m.parts >= 1 && m.parts <= MAX_MEDIA_PARTS
    && Number.isInteger(m.part) && m.part >= 0 && m.part < m.parts
    && Number.isInteger(m.size) && m.size >= 1 && m.size <= MAX_MEDIA_BYTES && m.size <= m.parts * MEDIA_CHUNK && m.size > (m.parts - 1) * MEDIA_CHUNK
    && typeof m.data === 'string' && m.data.length <= Math.ceil((MEDIA_CHUNK * 4) / 3) + 4 && B64URL.test(m.data)
    && typeof m.mime === 'string' && MIME.test(m.mime)
    && typeof m.name === 'string' && m.name.length <= 120;
}
function mediaMeta(m) {
  const out = { name: cleanName(m.name, 80) || 'file', mime: m.mime.toLowerCase(), size: m.size, parts: m.parts };
  if (Number.isFinite(m.duration) && m.duration > 0 && m.duration <= 3600) out.duration = Math.round(m.duration * 10) / 10;
  if (Number.isInteger(m.width) && Number.isInteger(m.height) && m.width > 0 && m.height > 0 && m.width <= 8192 && m.height <= 8192) { out.width = m.width; out.height = m.height; }
  return out;
}
function pendingIn(convId) { let n = 0; for (const k of mediaPending.keys()) if (k.startsWith(`${convId}|`)) n++; return n; }
setInterval(() => {
  const cutoff = Date.now() - MEDIA_PENDING_MS;
  for (const [k, p] of mediaPending) if (p.at < cutoff || !state.vaultKey) mediaPending.delete(k);
}, 60_000);

async function acceptMediaPart(convId, m, fp, { sender, replay, afterStore }) {
  if (!validMediaPart(m)) return;
  const key = `${convId}|${m.mediaId}`;
  let p = mediaPending.get(key);
  if (!p) {
    if (pendingIn(convId) >= MAX_MEDIA_PENDING) return;
    p = { meta: mediaMeta(m), fp, parts: new Array(m.parts).fill(null), got: 0, at: Date.now() };
    mediaPending.set(key, p);
  }
  if (p.fp !== fp || p.meta.parts !== m.parts || p.meta.size !== m.size) return;
  if (p.parts[m.part] === null) { p.parts[m.part] = m.data; p.got++; p.at = Date.now(); }
  emit('media:progress', { roomId: convId, mediaId: m.mediaId, got: p.got, parts: m.parts, meta: p.meta, sender });
  if (p.got < m.parts) return;
  mediaPending.delete(key);
  const data = p.parts.join('');
  let length;
  try { length = b64url.decode(data).length; } catch { return; }
  if (length !== p.meta.size) return;
  const rx = nowIso();
  const { parts, ...meta } = p.meta;
  const msg = { id: m.mediaId, fp, kind: 'media', ts: acceptedTs(m.ts, rx), rx, ...meta, data };
  await storeMessage(convId, msg);
  if (afterStore) await afterStore();
  emit('room:message', { roomId: convId, msg, mine: false, replay, sender });
}

// send a photo, a clip or a file to a room or a direct chat. `media` is
// { name, mime, bytes: Uint8Array, duration?, width?, height? }. onProgress
// is called after each part with (sent, total).
export async function sendMedia(convId, media, onProgress) {
  if (beacon.status !== 'on') throw new Error('connect a beacon to send');
  const bytes = media && media.bytes;
  if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error('nothing to send');
  if (bytes.length > MAX_MEDIA_BYTES) throw new Error(`${(bytes.length / 1048576).toFixed(1)} mb is over the 1.5 mb limit`);
  const dev = convId.startsWith('dm:') ? deviceForDm(convId) : null;
  const room = dev ? null : state.rooms.find((r) => r.id === convId && !r.left);
  if (!dev && !room) throw new Error('conversation not found');
  const parts = Math.ceil(bytes.length / MEDIA_CHUNK);
  const meta = mediaMeta({ name: media.name || 'file', mime: MIME.test(media.mime || '') ? media.mime : 'application/octet-stream', size: bytes.length, parts, duration: media.duration, width: media.width, height: media.height });
  const mediaId = uuid();
  const ts = nowIso();
  for (let i = 0; i < parts; i++) {
    const body = { ...meta, mediaId, part: i, data: b64url.encode(bytes.subarray(i * MEDIA_CHUNK, (i + 1) * MEDIA_CHUNK)) };
    if (dev) await sendDirect(dev, { kind: 'media', ...body }, true, true);
    else await sendRoomMessage(room, 'media', body, { keep: true });
    if (onProgress) onProgress(i + 1, parts);
  }
  const { parts: _n, ...stored } = meta;
  const msg = { id: mediaId, fp: state.identity.fingerprint, kind: 'media', ts, rx: ts, ...stored, data: b64url.encode(bytes) };
  await storeMessage(convId, msg);
  if (dev) await touchDevice(dev);
  else { room.updatedAt = ts; await saveRoom(room); }
  emit('room:message', { roomId: convId, msg, mine: true });
  return msg;
}

// shared validation for text and location messages from any peer
function normalizeMessage(m) {
  const rx = nowIso();
  const out = { id: m.id, fp: m.fp, kind: m.kind, rx, ts: acceptedTs(m.ts, rx) };
  if (m.kind === 'text') {
    if (typeof m.text !== 'string' || !m.text.trim() || m.text.length > MAX_TEXT) return null;
    out.text = m.text;
  } else if (m.kind === 'location') {
    const lat = finiteInRange(m.lat, -90, 90), lon = finiteInRange(m.lon, -180, 180);
    if (lat === null || lon === null) return null;
    out.lat = lat; out.lon = lon;
    out.acc = finiteInRange(m.acc, 0, 100_000) ?? 0;
    out.live = !!m.live;
  } else return null;
  return out;
}

// ---------- room lifecycle ----------

export function me() {
  return { fp: state.identity.fingerprint, name: state.profile.name, pub: b64url.encode(state.identity.pub), signPub: b64url.encode(state.identity.signPub) };
}

export async function createRoom(name) {
  const key = newRoomKey();
  const room = {
    id: newRoomId(),
    name: cleanName(name, 60) || 'room',
    founderFp: state.identity.fingerprint,
    epoch: 1,
    keys: { 1: b64url.encode(key) },
    members: [me()],
    rosterAt: nowIso(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    left: false,
  };
  await saveRoom(room);
  await refreshSubscriptions();
  return room;
}

// only the founder can add; the device must be paired and have a signing key
export async function inviteDevice(room, dev) {
  if (room.founderFp !== state.identity.fingerprint) throw new Error('only the founder can add people');
  if (!dev.signPub) throw new Error(`${dev.name} paired with an older code and cannot sign messages; pair again`);
  if (room.members.length >= MAX_MEMBERS) throw new Error('room is full');
  if (room.members.some((m) => m.fp === dev.fingerprint)) throw new Error(`${dev.name} is already a member`);
  const member = { fp: dev.fingerprint, name: dev.name, pub: dev.pub, signPub: dev.signPub };
  room.members = [...room.members, member];
  room.rosterAt = nowIso();
  room.updatedAt = nowIso();
  await saveRoom(room);
  // tell the room (signed) so existing members learn the newcomer's key
  await sendRoomMessage(room, 'roster', { members: room.members, epoch: room.epoch, at: room.rosterAt });
  // hand the newcomer the key over the pair channel
  await sendDirect(dev, { kind: 'room-invite', room: { id: room.id, name: room.name, founderFp: room.founderFp, epoch: room.epoch, key: room.keys[String(room.epoch)], members: room.members, rosterAt: room.rosterAt } });
}

async function acceptInvite(fromDev, r) {
  if (!r || typeof r.id !== 'string' || !ROOM_ID.test(r.id) || !isKey32(r.key) || !Array.isArray(r.members)) return;
  if (r.founderFp !== fromDev.fingerprint) return; // invites come only from the founder
  const epoch = Number(r.epoch);
  if (!Number.isInteger(epoch) || epoch < 1 || epoch > MAX_EPOCH) return;
  if (!r.members.some((m) => m && m.fp === state.identity.fingerprint)) return;
  const existing = state.rooms.find((x) => x.id === r.id);
  // a room id already known here belongs to its founder for good: another
  // paired device cannot re-found it under its own key and roster
  if (existing && existing.founderFp !== r.founderFp) return;
  if (existing && epoch < existing.epoch) return;
  const room = existing || { id: r.id, createdAt: nowIso(), keys: {}, rosterAt: '' };
  room.name = cleanName(r.name, 60) || 'room';
  room.founderFp = r.founderFp;
  room.epoch = epoch;
  room.keys[String(epoch)] = r.key;
  for (const k of Object.keys(room.keys)) if (Number(k) < epoch - 1) delete room.keys[k];
  room.members = sanitizeMembers(r.members);
  room.rosterAt = typeof r.rosterAt === 'string' ? r.rosterAt : nowIso();
  room.updatedAt = nowIso();
  room.left = false;
  await saveRoom(room);
  await refreshSubscriptions();
  emit('rooms:changed', { roomId: room.id, reason: existing ? 'rejoined' : 'invited' });
}

async function acceptKeyUpdate(fromDev, body) {
  if (typeof body.roomId !== 'string' || !ROOM_ID.test(body.roomId)) return;
  const room = state.rooms.find((x) => x.id === body.roomId);
  if (!room || room.founderFp !== fromDev.fingerprint) return;
  const epoch = Number(body.epoch);
  if (!Number.isInteger(epoch) || !(epoch > room.epoch) || epoch > room.epoch + 1000 || !isKey32(body.key)) return;
  if (!Array.isArray(body.members)) return;
  room.epoch = epoch;
  room.keys[String(epoch)] = body.key;
  // forget keys older than two epochs; history already stored is sealed locally
  for (const k of Object.keys(room.keys)) if (Number(k) < epoch - 1) delete room.keys[k];
  room.members = sanitizeMembers(body.members);
  room.rosterAt = nowIso();
  room.updatedAt = nowIso();
  await saveRoom(room);
  await refreshSubscriptions();
  emit('rooms:changed', { roomId: room.id, reason: 'rotated' });
}

function sanitizeMembers(list) {
  const seen = new Set();
  return list.filter((m) => m && typeof m.fp === 'string' && FP.test(m.fp) && isKey33(m.signPub) && !seen.has(m.fp) && seen.add(m.fp))
    .slice(0, MAX_MEMBERS)
    .map((m) => ({ fp: m.fp, name: cleanName(m.name) || m.fp.slice(0, 8), pub: String(m.pub || '').slice(0, 64), signPub: m.signPub }));
}
function isKey33(b64) { try { return typeof b64 === 'string' && b64url.decode(b64).length === 33; } catch { return false; } }

// founder removes a member: new epoch key, delivered to every remaining member
// over their pair channel. members the founder is not paired with fall out of
// the room, which is the rule anyway (nobody is in a room without a pairing).
export async function removeMember(room, fp) {
  if (room.founderFp !== state.identity.fingerprint) throw new Error('only the founder can remove people');
  if (fp === state.identity.fingerprint) throw new Error('leave the room instead');
  room.members = room.members.filter((m) => m.fp !== fp);
  return rotateEpoch(room);
}

export async function rotateEpoch(room) {
  if (room.founderFp !== state.identity.fingerprint) throw new Error('only the founder can rotate the key');
  const key = newRoomKey();
  room.epoch += 1;
  room.keys[String(room.epoch)] = b64url.encode(key);
  for (const k of Object.keys(room.keys)) if (Number(k) < room.epoch - 1) delete room.keys[k];
  room.rosterAt = nowIso();
  room.updatedAt = nowIso();
  await saveRoom(room);
  await refreshSubscriptions();
  const failures = [];
  for (const m of room.members) {
    if (m.fp === state.identity.fingerprint) continue;
    const dev = state.devices.find((d) => d.fingerprint === m.fp);
    if (!dev) { failures.push(m.name); continue; }
    try { await sendDirect(dev, { kind: 'room-key', roomId: room.id, epoch: room.epoch, key: room.keys[String(room.epoch)], members: room.members }); }
    catch { failures.push(m.name); }
  }
  return failures;
}

export async function leaveRoom(room) {
  try { await sendRoomMessage(room, 'leave', {}); } catch { /* offline: leaving is local anyway */ }
  room.left = true;
  room.updatedAt = nowIso();
  await saveRoom(room);
  await refreshSubscriptions();
}

// ---------- messages ----------

export async function sendRoomMessage(room, kind, body, { keep = true } = {}) {
  if (kind === 'text' && (typeof body.text !== 'string' || !body.text.trim())) throw new Error('nothing to send');
  if (kind === 'text' && body.text.length > MAX_TEXT) throw new Error(`message longer than ${MAX_TEXT} characters`);
  const msg = { id: uuid(), fp: state.identity.fingerprint, ts: nowIso(), kind, ...body };
  const frame = await sealRoomMessage(currentKey(room), room.id, room.epoch, state.identity.signKey, msg);
  const tag = tagsByRoom.get(room.id) || await roomTag(currentKey(room));
  await publish(tag, JSON.stringify(frame), keep);
  if (kind === 'text' || kind === 'location') {
    const stored = { ...msg, rx: msg.ts };
    await storeMessage(room.id, stored);
    room.updatedAt = msg.ts;
    await saveRoom(room);
    emit('room:message', { roomId: room.id, msg: stored, mine: true });
  }
  return msg;
}

async function handleRoomFrame(room, text, replay) {
  let frame;
  try { frame = JSON.parse(text); } catch { return; }
  const epoch = Number(frame.e);
  if (!Number.isInteger(epoch)) return;
  const keyB64 = room.keys[String(epoch)];
  if (!isKey32(keyB64)) return; // older than we keep, or newer than we were given
  let msg;
  try {
    msg = await openRoomMessage(b64url.decode(keyB64), room.id, epoch, frame, (fp) => {
      const m = room.members.find((x) => x.fp === fp);
      return m ? b64url.decode(m.signPub) : null;
    });
  } catch { return; }
  if (msg.fp === state.identity.fingerprint) return;
  if (!UUID.test(msg.id)) return;
  const seenKey = `room|${room.id}|${msg.id}`;
  if (await db.get('seen', seenKey)) return;
  await db.put('seen', { id: seenKey, t: nowIso() });
  const sender = room.members.find((m) => m.fp === msg.fp);
  switch (msg.kind) {
    case 'text':
    case 'location': {
      const clean = normalizeMessage(msg);
      if (!clean) return;
      await storeMessage(room.id, clean);
      room.updatedAt = clean.rx;
      await saveRoom(room);
      emit('room:message', { roomId: room.id, msg: clean, mine: false, replay, sender });
      break;
    }
    case 'roster': {
      if (msg.fp !== room.founderFp || !Array.isArray(msg.members)) return;
      // rosters carry the founder's clock; an older one replayed by the relay is ignored
      if (typeof msg.at !== 'string' || (room.rosterAt && msg.at <= room.rosterAt)) return;
      room.members = sanitizeMembers(msg.members);
      room.rosterAt = msg.at;
      await saveRoom(room);
      emit('rooms:changed', { roomId: room.id, reason: 'roster' });
      break;
    }
    case 'leave':
      room.members = room.members.filter((m) => m.fp !== msg.fp);
      await saveRoom(room);
      emit('rooms:changed', { roomId: room.id, reason: 'left', who: sender });
      // a departed member keeps the old key; the founder issues a fresh one so
      // "left" means "cannot read anything further"
      if (room.founderFp === state.identity.fingerprint && !replay) {
        rotateEpoch(room).then(() => emit('rooms:changed', { roomId: room.id, reason: 'rotated' })).catch(() => {});
      }
      break;
    case 'call':
      if (!replay) emit('room:call', { roomId: room.id, msg, sender });
      break;
    case 'media':
      await acceptMediaPart(room.id, msg, msg.fp, { sender, replay, afterStore: async () => { room.updatedAt = nowIso(); await saveRoom(room); } });
      break;
    default:
      break;
  }
}

// ---------- wiring ----------

on('beacon:msg', async (m) => {
  if (!state.vaultKey) return;
  const roomId = roomsByTag.get(m.tag);
  if (roomId) {
    const room = state.rooms.find((r) => r.id === roomId);
    if (room && !room.left) await handleRoomFrame(room, m.data, !!m.replay);
    return;
  }
  const devId = inboxByTag.get(m.tag);
  if (devId) {
    const dev = state.devices.find((d) => d.id === devId);
    if (dev) await handleDirect(dev, m.data);
  }
});

on('beacon:welcome', () => { refreshSubscriptions().catch(() => {}); });

export function roomPeerCount(room) {
  const tag = tagsByRoom.get(room.id);
  return tag ? beacon.counts.get(tag) || 0 : 0;
}

export function devicePeerCount(dev) {
  const tag = tagsByDevice.get(dev.id);
  return tag ? beacon.counts.get(tag) || 0 : 0;
}

export function memberName(room, fp) {
  if (fp === state.identity.fingerprint) return state.profile.name;
  const m = room.members.find((x) => x.fp === fp);
  return m ? m.name : `unknown ${fp.slice(0, 6)}`;
}

// the send side of a call for either conversation kind
export function callTransport(conv) {
  if (conv.room) return (body) => sendRoomMessage(conv.room, 'call', body, { keep: false });
  if (conv.dev) return (body) => sendDirect(conv.dev, { kind: 'call', ...body }, false).then(() => undefined);
  throw new Error('no conversation');
}
