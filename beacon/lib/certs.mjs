// a private CA (5 years) and a leaf certificate (398 days) it signs. both
// live under the data dir with 0600 perms. the leaf is reissued when it is
// close to expiry or when the set of names/addresses it must cover changed;
// the CA stays put so phones only ever install it once.

import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { X509Certificate, createHash } from 'node:crypto';
import selfsigned from 'selfsigned';

const DAY = 86_400_000;
const CA_DAYS = 1826; // five years: long enough to install once, short enough to expire if the key ever leaks
const LEAF_DAYS = 398; // apple rejects TLS leaves valid for longer
const RENEW_DAYS = 30;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(a.address);
    }
  }
  return [...new Set(out)];
}

// names the leaf must cover, normalised so two runs can be compared as sets.
export function wantedNames(extra = []) {
  const names = new Set(['localhost', '127.0.0.1', 'beacon.local', ...lanAddresses(), ...extra]);
  return [...names].map((n) => n.trim().toLowerCase()).filter(Boolean).sort();
}

function sansOf(x509) {
  // node renders SANs as "DNS:a, IP Address:1.2.3.4"
  if (!x509.subjectAltName) return [];
  return x509.subjectAltName
    .split(', ')
    .map((s) => s.slice(s.indexOf(':') + 1).toLowerCase())
    .sort();
}

function sameList(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function readPem(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

function writeSecret(file, text) {
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600); // mode above is ignored when the file already exists
}

async function makeCa() {
  const now = Date.now();
  return selfsigned.generate([{ name: 'commonName', value: 'beacon local CA' }], {
    keyType: 'ec',
    algorithm: 'sha256',
    notBeforeDate: new Date(now - DAY), // tolerate phones whose clock lags
    notAfterDate: new Date(now + CA_DAYS * DAY),
    extensions: [
      { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    ],
  });
}

async function makeLeaf(ca, names) {
  const now = Date.now();
  const altNames = names.map((n) => (IPV4.test(n) ? { type: 7, ip: n } : { type: 2, value: n }));
  return selfsigned.generate([{ name: 'commonName', value: 'beacon' }], {
    keyType: 'ec',
    algorithm: 'sha256',
    notBeforeDate: new Date(now - DAY),
    notAfterDate: new Date(now + LEAF_DAYS * DAY),
    ca: { key: ca.key, cert: ca.cert },
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames },
    ],
  });
}

// returns { key, cert, ca: { cert, der, fingerprint }, names, changed }
// where changed is 'ca', 'leaf' or null.
export async function ensureCerts({ dataDir, hostNames = [], log = () => {} }) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const files = {
    caKey: join(dataDir, 'ca.key'),
    caCert: join(dataDir, 'ca.crt'),
    key: join(dataDir, 'server.key'),
    cert: join(dataDir, 'server.crt'),
  };
  let changed = null;

  let ca = { key: readPem(files.caKey), cert: readPem(files.caCert) };
  if (ca.key && ca.cert) {
    const x = new X509Certificate(ca.cert);
    if (Date.parse(x.validTo) - Date.now() < RENEW_DAYS * DAY) {
      log('CA certificate is expiring; issuing a new one. phones must install it again.');
      ca = { key: null, cert: null };
    }
  }
  if (!ca.key || !ca.cert) {
    const p = await makeCa();
    ca = { key: p.private, cert: p.cert };
    writeSecret(files.caKey, ca.key);
    writeSecret(files.caCert, ca.cert);
    rmSync(files.key, { force: true });
    rmSync(files.cert, { force: true });
    changed = 'ca';
  }
  const caX = new X509Certificate(ca.cert);

  const names = wantedNames(hostNames);
  let leaf = { key: readPem(files.key), cert: readPem(files.cert) };
  if (leaf.key && leaf.cert) {
    let x;
    try {
      x = new X509Certificate(leaf.cert);
    } catch {
      x = null;
    }
    const ok = x
      && x.checkIssued(caX)
      && x.verify(caX.publicKey)
      && Date.parse(x.validTo) - Date.now() >= RENEW_DAYS * DAY
      && sameList(sansOf(x), names);
    if (!ok) leaf = { key: null, cert: null };
  }
  if (!leaf.key || !leaf.cert) {
    const p = await makeLeaf(ca, names);
    leaf = { key: p.private, cert: p.cert };
    writeSecret(files.key, leaf.key);
    writeSecret(files.cert, leaf.cert);
    changed = changed || 'leaf';
  }

  return {
    key: leaf.key,
    cert: leaf.cert,
    ca: {
      cert: ca.cert,
      der: caX.raw,
      fingerprint: caX.fingerprint256,
      sha256hex: createHash('sha256').update(caX.raw).digest('hex'),
      validTo: caX.validTo,
    },
    names,
    changed,
  };
}
