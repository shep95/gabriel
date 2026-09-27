// byte helpers shared by crypto, pairing and transfer code.
// everything here is pure; nothing touches the dom or storage.

const te = new TextEncoder();
const td = new TextDecoder();

export const utf8 = {
  encode: (s) => te.encode(s),
  decode: (b) => td.decode(b),
};

export function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export function compareBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

export const hex = {
  encode(b) {
    let s = '';
    for (const x of b) s += x.toString(16).padStart(2, '0');
    return s;
  },
  decode(s) {
    if (s.length % 2) throw new Error('odd hex');
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    return out;
  },
};

export const b64url = {
  encode(b) {
    let s = '';
    for (const x of b) s += String.fromCharCode(x);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

// crockford base32: no i, l, o, u. decoding is case-insensitive and maps
// the confusable letters back, so a code read aloud or typed by hand survives.
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const B32_MAP = (() => {
  const m = new Map();
  for (let i = 0; i < B32.length; i++) m.set(B32[i], i);
  m.set('O', 0); m.set('I', 1); m.set('L', 1); m.set('U', 27); // U -> V (27)
  return m;
})();

export const b32 = {
  encode(bytes) {
    let bits = 0, val = 0, out = '';
    for (const x of bytes) {
      val = (val << 8) | x; bits += 8;
      while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) out += B32[(val << (5 - bits)) & 31];
    return out;
  },
  decode(str) {
    const clean = str.toUpperCase().replace(/[^0-9A-Z]/g, '');
    let bits = 0, val = 0;
    const out = [];
    for (const ch of clean) {
      const v = B32_MAP.get(ch);
      if (v === undefined) throw new Error('bad base32 char ' + ch);
      val = (val << 5) | v; bits += 5;
      if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
    }
    return new Uint8Array(out);
  },
  // groups of 5 read better on a phone screen and over the phone
  group(str, size = 5) {
    return str.replace(new RegExp(`(.{${size}})`, 'g'), '$1 ').trim();
  },
};

export function fingerprintPretty(fpHex) {
  // 64 hex -> 8 groups of 4 from the first 32 chars; the full value stays available
  return fpHex.slice(0, 32).match(/.{4}/g).join(' ');
}

export function nowIso() { return new Date().toISOString(); }

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = hex.encode(b);
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function relativeTime(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const d = Date.now() - t;
  const m = Math.round(d / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

// names come from other devices. strip bidi overrides, zero-width and control
// characters so a name cannot reorder or hide text next to it, then bound it.
export function cleanName(v, max = 40) {
  return String(v ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
