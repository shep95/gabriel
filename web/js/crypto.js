// all cryptography for the console lives here and runs on webcrypto only.
// no key ever leaves this origin; nothing here talks to the network.
//
// vault:    passphrase -> pbkdf2-sha256 -> kek (aes-gcm) -> wraps a random vault key
// records:  aes-gcm under the vault key, aad = store name + record id
// identity: ecdh p-256, private key stored pkcs8-encrypted under the vault key
// pairing:  ecdh(mine, theirs) -> hkdf -> pair key + 6 digit sas
// transfer: hkdf(pair key, random salt) -> aes-gcm per message, aad binds sender->recipient

import { utf8, concat, randomBytes, hex, b64url, b32, compareBytes, uuid } from './util.js';

const subtle = crypto.subtle;

export const KDF_ITERATIONS = 600_000; // owasp 2023 floor for pbkdf2-sha256
const PROTO_PAIR = utf8.encode('gabriel/pair/v1');
const PROTO_SAS = utf8.encode('gabriel/sas/v1');
const PROTO_MSG = utf8.encode('gabriel/msg/v1');

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
  return { pub, pkcs8, fingerprint: await fingerprintOf(pub) };
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

const INVITE_VERSION = 1;
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

export function buildInvite(pub33, name) {
  const nonce = randomBytes(8);
  const nameBytes = utf8.encode(truncateUtf8(name.trim(), NAME_MAX_BYTES));
  const bytes = concat(new Uint8Array([INVITE_VERSION]), pub33, nonce, nameBytes);
  return { nonce, text: `${INVITE_PREFIX}-${b32.encode(bytes)}` };
}

export async function parseInvite(text) {
  const clean = text.trim().toUpperCase().replace(/\s+/g, '');
  if (!clean.startsWith(INVITE_PREFIX + '-') && !clean.startsWith(INVITE_PREFIX)) throw new Error('not a pairing code');
  const body = clean.slice(clean.indexOf(INVITE_PREFIX) + INVITE_PREFIX.length).replace(/^-/, '');
  const bytes = b32.decode(body);
  if (bytes.length < 1 + 33 + 8) throw new Error('pairing code too short');
  if (bytes[0] !== INVITE_VERSION) throw new Error('unknown pairing code version');
  const pub = bytes.slice(1, 34);
  decompressPoint(pub); // validates the point before we trust it
  const nonce = bytes.slice(34, 42);
  const name = utf8.decode(bytes.slice(42)) || 'unnamed device';
  return { pub, nonce, name, fingerprint: await fingerprintOf(pub) };
}

// both sides compute identical results regardless of who invited whom,
// because salt orders the two nonces and the pair key is symmetric.
export async function derivePair(myPrivateKey, myNonce, theirPub33, theirNonce) {
  const theirKey = await importPublic(theirPub33);
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: theirKey }, myPrivateKey, 256));
  const salt = compareBytes(myNonce, theirNonce) <= 0 ? concat(myNonce, theirNonce) : concat(theirNonce, myNonce);
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
