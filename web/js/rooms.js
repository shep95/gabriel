// rooms: end-to-end encrypted group conversations carried by a beacon.
//
// trust model: you can only be added to a room by a device you have paired with
// in person (the invite travels sealed under that pair key). the founder holds
// the roster and rotates the epoch key whenever someone is removed. every
// message is encrypted under the epoch key and signed by its sender; the beacon
// sees random tags and ciphertext.

import { b64url, hex, utf8, uuid, nowIso } from './util.js';
import {
  inboxTag, dayString, newRoomKey, newRoomId, roomTag, sealRoomMessage, openRoomMessage,
  sealMessage, parseEnvelopeHeader, openMessage, sealRecord, openRecord,
} from './crypto.js';
import * as db from './db.js';
import { state, emit, on } from './state.js';
import { beacon, subscribe, unsubscribe, publish } from './beacon.js';

const MAX_MEMBERS = 24;
const MAX_HISTORY = 500;
const MAX_TEXT = 4000;

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
  for (const m of await db.byIndex('messages', 'room', roomId)) await db.del('messages', m.id);
  state.rooms = state.rooms.filter((r) => r.id !== roomId);
  const r = tagsByRoom.get(roomId);
  if (r) { unsubscribe([r]); tagsByRoom.delete(roomId); roomsByTag.delete(r); }
}

export async function loadMessages(roomId) {
  const recs = await db.byIndex('messages', 'room', roomId);
  const out = [];
  for (const r of recs) {
    try { out.push({ id: r.id, ...(await openRecord(state.vaultKey, 'messages', r.id, r.enc)) }); }
    catch { /* skip */ }
  }
  out.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
  return out;
}

async function storeMessage(roomId, msg) {
  await db.put('messages', { id: msg.id, roomId, enc: await sealRecord(state.vaultKey, 'messages', msg.id, msg) });
  const all = await db.byIndex('messages', 'room', roomId);
  if (all.length > MAX_HISTORY) {
    // ids are uuids, so order by stored ts is not available without opening;
    // open only the excess candidates and drop the oldest
    const opened = [];
    for (const r of all) { try { opened.push({ id: r.id, ts: (await openRecord(state.vaultKey, 'messages', r.id, r.enc)).ts }); } catch { opened.push({ id: r.id, ts: '' }); } }
    opened.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
    for (const r of opened.slice(0, all.length - MAX_HISTORY)) await db.del('messages', r.id);
  }
}

// ---------- tag bookkeeping ----------

const roomsByTag = new Map();   // tag -> roomId
const tagsByRoom = new Map();   // roomId -> tag
const inboxByTag = new Map();   // tag -> deviceId
let inboxDay = null;

async function currentKey(room) {
  return b64url.decode(room.keys[String(room.epoch)]);
}

export async function refreshSubscriptions() {
  if (!state.vaultKey || !state.identity) return;
  const wanted = [];
  for (const room of state.rooms) {
    if (room.left) continue;
    const tag = await roomTag(await currentKey(room));
    const old = tagsByRoom.get(room.id);
    if (old && old !== tag) { unsubscribe([old]); roomsByTag.delete(old); }
    tagsByRoom.set(room.id, tag); roomsByTag.set(tag, room.id); wanted.push(tag);
  }
  // pair inboxes for today and yesterday, so a clock a few hours off still meets
  const today = dayString();
  const yesterday = dayString(new Date(Date.now() - 86_400_000));
  const stillWanted = new Set();
  for (const dev of state.devices) {
    const pk = b64url.decode(dev.pairKey);
    for (const day of [today, yesterday]) {
      const tag = await inboxTag(pk, day);
      inboxByTag.set(tag, dev.id); stillWanted.add(tag); wanted.push(tag);
    }
  }
  for (const [tag] of inboxByTag) if (!stillWanted.has(tag)) { unsubscribe([tag]); inboxByTag.delete(tag); }
  inboxDay = today;
  subscribe(wanted);
}

// re-derive inbox tags when the day changes
setInterval(() => { if (inboxDay && inboxDay !== dayString()) refreshSubscriptions().catch(() => {}); }, 60_000);

// ---------- direct (pair) channel ----------

async function sendDirect(dev, payload) {
  const env = await sealMessage(b64url.decode(dev.pairKey), state.identity.fingerprint, dev.fingerprint, payload);
  const tag = await inboxTag(b64url.decode(dev.pairKey));
  await publish(tag, env.text, true);
  return env.id;
}

async function handleDirect(dev, text) {
  let header;
  try { header = parseEnvelopeHeader(text); } catch { return; }
  if (!dev.fingerprint.startsWith(header.senderFpPrefix)) return;
  let body;
  try { body = await openMessage(b64url.decode(dev.pairKey), dev.fingerprint, state.identity.fingerprint, header); }
  catch { return; }
  const seenKey = `${dev.id}:${body.id}`;
  if (await db.get('seen', seenKey)) return;
  await db.put('seen', { id: seenKey, t: nowIso() });
  if (body.kind === 'room-invite') await acceptInvite(dev, body.room);
  else if (body.kind === 'room-key') await acceptKeyUpdate(dev, body);
  else if (body.kind === 'note') emit('direct:note', { from: dev, body });
}

// ---------- room lifecycle ----------

export function me() {
  return { fp: state.identity.fingerprint, name: state.profile.name, pub: b64url.encode(state.identity.pub), signPub: b64url.encode(state.identity.signPub) };
}

export async function createRoom(name) {
  const key = newRoomKey();
  const room = {
    id: newRoomId(),
    name: name.trim().slice(0, 60) || 'room',
    founderFp: state.identity.fingerprint,
    epoch: 1,
    keys: { 1: b64url.encode(key) },
    members: [me()],
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
  room.updatedAt = nowIso();
  await saveRoom(room);
  // tell the room (signed) so existing members learn the newcomer's key
  await sendRoomMessage(room, 'roster', { members: room.members, epoch: room.epoch });
  // hand the newcomer the key over the pair channel
  await sendDirect(dev, { kind: 'room-invite', room: { id: room.id, name: room.name, founderFp: room.founderFp, epoch: room.epoch, key: room.keys[String(room.epoch)], members: room.members } });
}

async function acceptInvite(fromDev, r) {
  if (!r || typeof r.id !== 'string' || typeof r.key !== 'string' || !Array.isArray(r.members)) return;
  if (r.founderFp !== fromDev.fingerprint) return; // invites come only from the founder
  if (!r.members.some((m) => m.fp === state.identity.fingerprint)) return;
  const existing = state.rooms.find((x) => x.id === r.id);
  const room = existing || { id: r.id, createdAt: nowIso(), keys: {} };
  room.name = String(r.name || 'room').slice(0, 60);
  room.founderFp = r.founderFp;
  room.epoch = Number(r.epoch) || 1;
  room.keys[String(room.epoch)] = r.key;
  room.members = sanitizeMembers(r.members);
  room.updatedAt = nowIso();
  room.left = false;
  await saveRoom(room);
  await refreshSubscriptions();
  emit('rooms:changed', { roomId: room.id, reason: existing ? 'rejoined' : 'invited' });
}

async function acceptKeyUpdate(fromDev, body) {
  const room = state.rooms.find((x) => x.id === body.roomId);
  if (!room || room.founderFp !== fromDev.fingerprint) return;
  const epoch = Number(body.epoch);
  if (!(epoch > room.epoch) || typeof body.key !== 'string') return;
  room.epoch = epoch;
  room.keys[String(epoch)] = body.key;
  // forget keys older than two epochs; history already stored is plaintext-sealed locally
  for (const k of Object.keys(room.keys)) if (Number(k) < epoch - 1) delete room.keys[k];
  room.members = sanitizeMembers(body.members);
  room.updatedAt = nowIso();
  await saveRoom(room);
  await refreshSubscriptions();
  emit('rooms:changed', { roomId: room.id, reason: 'rotated' });
}

function sanitizeMembers(list) {
  return list.filter((m) => m && typeof m.fp === 'string' && /^[0-9a-f]{64}$/.test(m.fp) && typeof m.signPub === 'string')
    .slice(0, MAX_MEMBERS)
    .map((m) => ({ fp: m.fp, name: String(m.name || '').slice(0, 40), pub: String(m.pub || ''), signPub: m.signPub }));
}

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
  const key = newRoomKey();
  room.epoch += 1;
  room.keys[String(room.epoch)] = b64url.encode(key);
  for (const k of Object.keys(room.keys)) if (Number(k) < room.epoch - 1) delete room.keys[k];
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
  const frame = await sealRoomMessage(await currentKey(room), room.id, room.epoch, state.identity.signKey, msg);
  const tag = tagsByRoom.get(room.id) || await roomTag(await currentKey(room));
  await publish(tag, JSON.stringify(frame), keep);
  if (kind === 'text' || kind === 'location') {
    await storeMessage(room.id, msg);
    room.updatedAt = msg.ts;
    await saveRoom(room);
    emit('room:message', { roomId: room.id, msg, mine: true });
  }
  return msg;
}

async function handleRoomFrame(room, text, replay) {
  let frame;
  try { frame = JSON.parse(text); } catch { return; }
  const epoch = Number(frame.e);
  const keyB64 = room.keys[String(epoch)];
  if (!keyB64) return; // older than we keep, or newer than we were given
  let msg;
  try {
    msg = await openRoomMessage(b64url.decode(keyB64), room.id, epoch, frame, (fp) => {
      const m = room.members.find((x) => x.fp === fp);
      return m ? b64url.decode(m.signPub) : null;
    });
  } catch { return; }
  if (msg.fp === state.identity.fingerprint) return;
  const seenKey = `${room.id}:${msg.id}`;
  if (await db.get('seen', seenKey)) return;
  await db.put('seen', { id: seenKey, t: nowIso() });
  const sender = room.members.find((m) => m.fp === msg.fp);
  switch (msg.kind) {
    case 'text':
    case 'location':
      if (msg.kind === 'text' && typeof msg.text !== 'string') return;
      await storeMessage(room.id, msg);
      room.updatedAt = msg.ts || nowIso();
      await saveRoom(room);
      emit('room:message', { roomId: room.id, msg, mine: false, replay, sender });
      break;
    case 'roster':
      if (msg.fp !== room.founderFp || !Array.isArray(msg.members)) return;
      room.members = sanitizeMembers(msg.members);
      await saveRoom(room);
      emit('rooms:changed', { roomId: room.id, reason: 'roster' });
      break;
    case 'leave':
      room.members = room.members.filter((m) => m.fp !== msg.fp);
      await saveRoom(room);
      emit('rooms:changed', { roomId: room.id, reason: 'left', who: sender });
      break;
    case 'call':
      if (!replay) emit('room:call', { roomId: room.id, msg, sender });
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

export function memberName(room, fp) {
  if (fp === state.identity.fingerprint) return state.profile.name;
  const m = room.members.find((x) => x.fp === fp);
  return m ? m.name : `unknown ${fp.slice(0, 6)}`;
}
