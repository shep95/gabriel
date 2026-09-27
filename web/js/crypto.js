// all cryptography for the console lives here and runs on webcrypto only.
// no key ever leaves this origin; nothing here talks to the network.
//
// vault:    passphrase -> pbkdf2-sha256 -> kek (aes-gcm) -> wraps a random vault key
// records:  aes-gcm under the vault key, aad = store name + record id
// identity: ecdh p-256, private key stored pkcs8-encrypted under the vault key
// pairing:  ecdh(mine, theirs) -> hkdf -> pair key + 6 digit sas
// transfer: hkdf(pair key, random salt) -> aes-gcm per message, aad binds sender->recipient

import { utf8, concat, randomBytes, hex, b64url, b32, compareBytes, uuid, cleanName } from './util.js';

const subtle = crypto.subtle;

export const KDF_ITERATIONS = 600_000; // owasp 2023 floor for pbkdf2-sha256
const PROTO_PAIR = utf8.encode('gabriel/pair/v1');
const PROTO_SAS = utf8.encode('gabriel/sas/v1');
const PROTO_MSG = utf8.encode('gabriel/msg/v1');
const PROTO_INBOX = utf8.encode('gabriel/inbox/v1');
const PROTO_ROOM = utf8.encode('gabriel/room/v1');
const PROTO_ROOM_TAG = utf8.encode('gabriel/room-tag/v1');

export function cryptoAvailable() {
  return typeof crypto !== 'undefined' && !!crypto.subtle && typeof crypto.getRandomValues === 'function';
}

// ---------- vault ----------

async function deriveKek(passphrase, salt, iterations) {
  const base = await subtle.importKey('raw', utf8.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

export async function createVault(passphrase) {
  const salt = randomBytes(16);
  const iterations = KDF_ITERATIONS;
  const kek = await deriveKek(passphrase, salt, iterations);
  const vaultKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const wrapIv = randomBytes(12);
  const wrapped = new Uint8Array(await subtle.wrapKey('raw', vaultKey, kek, { name: 'AES-GCM', iv: wrapIv }));
  return {
    vaultKey,
    kdf: { name: 'PBKDF2-SHA256', salt: b64url.encode(salt), iterations },
    wrap: { iv: b64url.encode(wrapIv), key: b64url.encode(wrapped) },
  };
}

// throws on a wrong passphrase: aes-gcm refuses to unwrap.
export async function unlockVault(passphrase, profile) {
  const kek = await deriveKek(passphrase, b64url.decode(profile.kdf.salt), profile.kdf.iterations);
  return subtle.unwrapKey(
    'raw',
    b64url.decode(profile.wrap.key),
    kek,
    { name: 'AES-GCM', iv: b64url.decode(profile.wrap.iv) },
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

export async function rewrapVault(vaultKey, newPassphrase) {
  const salt = randomBytes(16);
  const iterations = KDF_ITERATIONS;
  const kek = await deriveKek(newPassphrase, salt, iterations);
  const wrapIv = randomBytes(12);
  const wrapped = new Uint8Array(await subtle.wrapKey('raw', vaultKey, kek, { name: 'AES-GCM', iv: wrapIv }));
  return {
    kdf: { name: 'PBKDF2-SHA256', salt: b64url.encode(salt), iterations },
    wrap: { iv: b64url.encode(wrapIv), key: b64url.encode(wrapped) },
  };
}

// ---------- records ----------

function aad(store, id) {
  return utf8.encode(`gabriel/record/v1|${store}|${id}`);
}

export async function sealRecord(vaultKey, store, id, obj) {
  const iv = randomBytes(12);
  const pt = utf8.encode(JSON.stringify(obj));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(store, id) }, vaultKey, pt));
  return { iv: b64url.encode(iv), ct: b64url.encode(ct) };
}

export async function openRecord(vaultKey, store, id, enc) {
  const pt = await subtle.decrypt(
    { name: 'AES-GCM', iv: b64url.decode(enc.iv), additionalData: aad(store, id) },
    vaultKey,
    b64url.decode(enc.ct),
  );
  return JSON.parse(utf8.decode(new Uint8Array(pt)));
}

// ---------- p-256 point compression ----------
// webcrypto only exports uncompressed (65 byte) points. a 33 byte compressed
// point saves 32 bytes in every code a person has to scan or type, so we
// compress by hand. p = 3 mod 4, so sqrt is a single modpow.

const P = (1n << 256n) - (1n << 224n) + (1n << 192n) + (1n << 96n) - 1n;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;

function bytesToBig(b) { return BigInt('0x' + hex.encode(b)); }
function bigToBytes(n, len = 32) { return hex.decode(n.toString(16).padStart(len * 2, '0')); }
function modpow(base, exp, mod) {
  let r = 1n; base %= mod;
  while (exp > 0n) {
    if (exp & 1n) r = (r * base) % mod;
    exp >>= 1n; base = (base * base) % mod;
  }
  return r;
}

export function compressPoint(raw65) {
  if (raw65.length !== 65 || raw65[0] !== 4) throw new Error('not an uncompressed p-256 point');
  const x = raw65.slice(1, 33);
  const y = raw65.slice(33, 65);
  const out = new Uint8Array(33);
  out[0] = (y[31] & 1) ? 3 : 2;
  out.set(x, 1);
  return out;
}

export function decompressPoint(c33) {
  if (c33.length !== 33 || (c33[0] !== 2 && c33[0] !== 3)) throw new Error('not a compressed p-256 point');
  const x = bytesToBig(c33.slice(1));
  if (x >= P) throw new Error('x out of range');
  const y2 = (((x * x * x) % P) - (3n * x) % P + B + P + P) % P;
  let y = modpow(y2, (P + 1n) >> 2n, P);
  if ((y * y) % P !== y2) throw new Error('point not on curve');
  const odd = (y & 1n) === 1n;
  if (odd !== (c33[0] === 3)) y = P - y;
  return { x: bigToBytes(x), y: bigToBytes(y) };
}

// ---------- identity ----------

export async function generateIdentity() {
  const kp = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', kp.privateKey));
  const pub = compressPoint(raw);
  const sign = await generateSigningKey();
  return { pub, pkcs8, fingerprint: await fingerprintOf(pub), signPub: sign.pub, signPkcs8: sign.pkcs8 };
}

// ecdsa p-256 for authenticating room messages. webcrypto keeps ecdh and
// ecdsa keys apart, so this is a second key pair; profiles created before
// rooms existed grow one on their next unlock.
export async function generateSigningKey() {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', kp.privateKey));
  return { pub: compressPoint(raw), pkcs8 };
}

export async function importSigningPrivate(pkcs8) {
  return subtle.importKey('pkcs8', pkcs8, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

export async function importSigningPublic(pub33) {
  const { x, y } = decompressPoint(pub33);
  return subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: b64url.encode(x), y: b64url.encode(y), ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
}

export async function signBytes(signKey, bytes) {
  return new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signKey, bytes));
}

export async function verifyBytes(pub33, sig, bytes) {
  try {
    const key = await importSigningPublic(pub33);
    return await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, bytes);
  } catch {
    return false;
  }
}

export async function fingerprintOf(pub33) {
  return hex.encode(new Uint8Array(await subtle.digest('SHA-256', pub33)));
}

export async function importPrivate(pkcs8) {
  return subtle.importKey('pkcs8', pkcs8, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}

export async function importPublic(pub33) {
  const { x, y } = decompressPoint(pub33);
  return subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: b64url.encode(x), y: b64url.encode(y), ext: true }, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}

async function hkdf(ikm, salt, info, bytes = 32) {
  const k = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, bytes * 8));
}

// ---------- pairing ----------
// invite = 0x01 | pub(33) | nonce(8) | name utf8 (<= 24 bytes)
// shown as "GBR1-" + crockford base32. the same string goes in the qr code.

const INVITE_VERSION = 2;
export const INVITE_PREFIX = 'GBR1';
const NAME_MAX_BYTES = 24;

function truncateUtf8(s, max) {
  let out = '';
  for (const ch of s) {
    if (utf8.encode(out + ch).length > max) break;
    out += ch;
  }
  return out;
}

// v1 = 0x01 | ecdh pub(33) | nonce(8) | name
// v2 = 0x02 | ecdh pub(33) | sign pub(33) | nonce(8) | name
export function buildInvite(pub33, name, signPub33 = null) {
  const nonce = randomBytes(8);
  const nameBytes = utf8.encode(truncateUtf8(name.trim(), NAME_MAX_BYTES));
  const bytes = signPub33
    ? concat(new Uint8Array([INVITE_VERSION]), pub33, signPub33, nonce, nameBytes)
    : concat(new Uint8Array([1]), pub33, nonce, nameBytes);
  return { nonce, text: `${INVITE_PREFIX}-${b32.encode(bytes)}` };
}

export async function parseInvite(text) {
  const clean = text.trim().toUpperCase().replace(/\s+/g, '');
  if (!clean.startsWith(INVITE_PREFIX + '-') && !clean.startsWith(INVITE_PREFIX)) throw new Error('not a pairing code');
  const body = clean.slice(clean.indexOf(INVITE_PREFIX) + INVITE_PREFIX.length).replace(/^-/, '');
  const bytes = b32.decode(body);
  if (bytes.length < 1 + 33 + 8) throw new Error('pairing code too short');
  const version = bytes[0];
  if (version !== 1 && version !== 2) throw new Error('unknown pairing code version');
  const pub = bytes.slice(1, 34);
  decompressPoint(pub); // validates the point before we trust it
  let at = 34;
  let signPub = null;
  if (version === 2) {
    if (bytes.length < 1 + 33 + 33 + 8) throw new Error('pairing code too short');
    signPub = bytes.slice(34, 67);
    decompressPoint(signPub);
    at = 67;
  }
  const nonce = bytes.slice(at, at + 8);
  const name = cleanName(utf8.decode(bytes.slice(at + 8)), 24) || 'unnamed device';
  // the canonical text is what the key agreement binds: prefix, dash, base32
  const canonical = `${INVITE_PREFIX}-${b32.encode(bytes)}`;
  return { pub, signPub, nonce, name, text: canonical, fingerprint: await fingerprintOf(pub), version };
}

// both sides compute identical results regardless of who invited whom: the
// salt orders the two nonces and appends a hash of both complete invites, so
// the six digits also cover the signing keys and names. an intermediary who
// relays the codes and swaps a signing key changes the digits on one side.
export async function derivePair(myPrivateKey, mine, theirs) {
  const theirKey = await importPublic(theirs.pub);
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: theirKey }, myPrivateKey, 256));
  const a = utf8.encode(mine.text), b = utf8.encode(theirs.text);
  const transcript = new Uint8Array(await subtle.digest('SHA-256', compareBytes(a, b) <= 0 ? concat(a, b) : concat(b, a)));
  const nonces = compareBytes(mine.nonce, theirs.nonce) <= 0 ? concat(mine.nonce, theirs.nonce) : concat(theirs.nonce, mine.nonce);
  const salt = concat(nonces, transcript);
  const pairKey = await hkdf(shared, salt, PROTO_PAIR, 32);
  const sasBytes = await hkdf(shared, salt, PROTO_SAS, 32);
  shared.fill(0);
  return { pairKey, sas: sasFromBytes(sasBytes) };
}

// uniform 6 digits by rejection sampling on 32-bit chunks.
export function sasFromBytes(bytes) {
  const LIMIT = 4_294_000_000; // largest multiple of 1e6 below 2^32
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let v = null;
  for (let i = 0; i + 4 <= bytes.length; i += 4) {
    const c = dv.getUint32(i);
    if (c < LIMIT) { v = c; break; }
  }
  if (v === null) v = dv.getUint32(bytes.length - 4);
  return String(v % 1_000_000).padStart(6, '0');
}

// ---------- transfer ----------
// envelope = 0x02 | senderFp(4) | salt(16) | iv(12) | ciphertext
// aad binds the direction so an envelope cannot be replayed back at its author.

const ENVELOPE_VERSION = 2;
export const ENVELOPE_PREFIX = 'GBR2';
export const CHUNK_PREFIX = 'GBR3';
export const MAX_ENVELOPE_BYTES = 8 * 1024;

function msgAad(senderFpHex, recipientFpHex) {
  return concat(PROTO_MSG, hex.decode(senderFpHex), hex.decode(recipientFpHex));
}

export async function sealMessage(pairKey, senderFpHex, recipientFpHex, payload) {
  const body = { v: 1, id: uuid(), ts: new Date().toISOString(), ...payload };
  const pt = utf8.encode(JSON.stringify(body));
  if (pt.length > MAX_ENVELOPE_BYTES - 64) throw new Error(`message too large for a code (${pt.length} bytes, limit ${MAX_ENVELOPE_BYTES - 64})`);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const keyBytes = await hkdf(pairKey, salt, PROTO_MSG, 32);
  const key = await subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: msgAad(senderFpHex, recipientFpHex) }, key, pt));
  const bytes = concat(new Uint8Array([ENVELOPE_VERSION]), hex.decode(senderFpHex.slice(0, 8)), salt, iv, ct);
  return { id: body.id, text: `${ENVELOPE_PREFIX}-${b32.encode(bytes)}` };
}

// a direct frame: the pair-key sealing of a transfer code, but base64url and
// without the code's size cap. media rides the pair channel in these; the
// derivation label and the additional data keep it a separate protocol from
// the codes a person reads off a screen.
export const FRAME_PREFIX = 'GBR4';
const FRAME_VERSION = 1;
const PROTO_FRAME = utf8.encode('gabriel/direct-frame/v1');
const MAX_FRAME_BYTES = 200_000;
function frameAad(senderFpHex, recipientFpHex) {
  return concat(PROTO_FRAME, hex.decode(senderFpHex), hex.decode(recipientFpHex));
}
export async function sealDirectFrame(pairKey, senderFpHex, recipientFpHex, payload) {
  const body = { v: 1, id: uuid(), ts: new Date().toISOString(), ...payload };
  const pt = utf8.encode(JSON.stringify(body));
  if (pt.length > MAX_FRAME_BYTES - 64) throw new Error(`frame too large (${pt.length} bytes)`);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const keyBytes = await hkdf(pairKey, salt, PROTO_FRAME, 32);
  const key = await subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: frameAad(senderFpHex, recipientFpHex) }, key, pt));
  const bytes = concat(new Uint8Array([FRAME_VERSION]), hex.decode(senderFpHex.slice(0, 8)), salt, iv, ct);
  return { id: body.id, text: `${FRAME_PREFIX}-${b64url.encode(bytes)}` };
}
export function isDirectFrame(text) { return typeof text === 'string' && text.startsWith(`${FRAME_PREFIX}-`); }
export async function openDirectFrame(pairKey, senderFpHex, recipientFpHex, text) {
  if (!isDirectFrame(text)) throw new Error('not a direct frame');
  const bytes = b64url.decode(text.slice(FRAME_PREFIX.length + 1));
  if (bytes.length < 1 + 4 + 16 + 12 + 16 || bytes.length > MAX_FRAME_BYTES + 64) throw new Error('bad frame size');
  if (bytes[0] !== FRAME_VERSION) throw new Error('unknown frame version');
  if (!senderFpHex.startsWith(hex.encode(bytes.slice(1, 5)))) throw new Error('frame is not from this device');
  const salt = bytes.slice(5, 21);
  const iv = bytes.slice(21, 33);
  const ct = bytes.slice(33);
  const keyBytes = await hkdf(pairKey, salt, PROTO_FRAME, 32);
  const key = await subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: frameAad(senderFpHex, recipientFpHex) }, key, ct);
  const body = JSON.parse(utf8.decode(new Uint8Array(pt)));
  if (body.v !== 1 || typeof body.id !== 'string' || typeof body.kind !== 'string') throw new Error('malformed frame body');
  return body;
}

export function parseEnvelopeHeader(text) {
  const clean = text.trim().toUpperCase().replace(/\s+/g, '');
  if (!clean.startsWith(ENVELOPE_PREFIX)) throw new Error('not a transfer code');
  const bytes = b32.decode(clean.slice(ENVELOPE_PREFIX.length).replace(/^-/, ''));
  if (bytes.length < 1 + 4 + 16 + 12 + 16) throw new Error('transfer code too short');
  if (bytes[0] !== ENVELOPE_VERSION) throw new Error('unknown transfer code version');
  if (bytes.length > MAX_ENVELOPE_BYTES + 33) throw new Error('transfer code too large');
  return {
    senderFpPrefix: hex.encode(bytes.slice(1, 5)),
    salt: bytes.slice(5, 21),
    iv: bytes.slice(21, 33),
    ct: bytes.slice(33),
  };
}

export async function openMessage(pairKey, senderFpHex, recipientFpHex, header) {
  const keyBytes = await hkdf(pairKey, header.salt, PROTO_MSG, 32);
  const key = await subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: header.iv, additionalData: msgAad(senderFpHex, recipientFpHex) }, key, header.ct);
  const body = JSON.parse(utf8.decode(new Uint8Array(pt)));
  if (body.v !== 1 || typeof body.id !== 'string') throw new Error('malformed message body');
  return body;
}

// long envelopes cycle through several qr frames. each frame is self-describing
// so frames can arrive in any order and a missed one is simply picked up on the
// next cycle. tid is 4 base32 chars of randomness to keep two transfers apart.
export function chunkForQr(text, size = 700) {
  if (text.length <= size) return [text];
  const tid = b32.encode(randomBytes(3)).slice(0, 4);
  const n = Math.ceil(text.length / size);
  const frames = [];
  for (let i = 0; i < n; i++) frames.push(`${CHUNK_PREFIX}-${tid}-${i + 1}-${n}-${text.slice(i * size, (i + 1) * size)}`);
  return frames;
}

export function parseChunk(text) {
  const m = /^GBR3-([0-9A-Z]{4})-(\d+)-(\d+)-(.+)$/s.exec(text.trim().toUpperCase());
  if (!m) return null;
  return { tid: m[1], index: Number(m[2]), total: Number(m[3]), part: m[4] };
}

// ---------- beacon tags ----------
// a pair shares a daily tag derived from the pair key. both devices subscribe to
// it on the beacon; the beacon sees a random 64-hex string that changes every
// day and cannot be linked to either identity.

export function dayString(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

export async function inboxTag(pairKey, day = dayString()) {
  return hex.encode(await hkdf(pairKey, utf8.encode(day), PROTO_INBOX, 32));
}

// ---------- rooms ----------
// a room has an epoch key (32 bytes) that the founder replaces whenever the
// roster shrinks. the beacon tag is derived from the epoch key, so a removed
// member cannot even watch traffic volume after rotation.

export function newRoomKey() { return randomBytes(32); }
export function newRoomId() { return hex.encode(randomBytes(8)); }

export async function roomTag(epochKey) {
  return hex.encode(await hkdf(epochKey, new Uint8Array(32), PROTO_ROOM_TAG, 32));
}

function roomAad(roomId, epoch) {
  return concat(PROTO_ROOM, utf8.encode(`|${roomId}|${epoch}`));
}

// frame = { v:1, e:epoch, iv, ct, sig }, all strings, opaque to the beacon.
// the signature covers ct||iv so a frame cannot be re-keyed or re-noncd.
export async function sealRoomMessage(epochKey, roomId, epoch, signKey, body) {
  const iv = randomBytes(12);
  const key = await subtle.importKey('raw', epochKey, 'AES-GCM', false, ['encrypt']);
  const pt = utf8.encode(JSON.stringify(body));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: roomAad(roomId, epoch) }, key, pt));
  const sig = await signBytes(signKey, concat(ct, iv));
  return { v: 1, e: epoch, iv: b64url.encode(iv), ct: b64url.encode(ct), sig: b64url.encode(sig) };
}

// returns { body, verified } or throws. verification needs the sender's signing
// key, which the caller looks up from the roster after decryption.
export async function openRoomMessage(epochKey, roomId, epoch, frame, lookupSignPub) {
  if (!frame || frame.v !== 1 || typeof frame.ct !== 'string' || typeof frame.iv !== 'string' || typeof frame.sig !== 'string') throw new Error('malformed room frame');
  const iv = b64url.decode(frame.iv);
  const ct = b64url.decode(frame.ct);
  if (iv.length !== 12 || ct.length < 16 || ct.length > 300_000) throw new Error('bad frame sizes');
  const key = await subtle.importKey('raw', epochKey, 'AES-GCM', false, ['decrypt']);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: roomAad(roomId, epoch) }, key, ct);
  const body = JSON.parse(utf8.decode(new Uint8Array(pt)));
  if (typeof body.fp !== 'string' || typeof body.id !== 'string' || typeof body.kind !== 'string') throw new Error('malformed room body');
  const signPub = lookupSignPub(body.fp);
  if (!signPub) throw new Error('sender is not a member');
  const verified = await verifyBytes(signPub, b64url.decode(frame.sig), concat(ct, iv));
  if (!verified) throw new Error('bad signature');
  return body;
}
