// static files from one root. paths are resolved and checked against the root
// so nothing outside it can ever be read; dotfiles are not served.

import { createReadStream, promises as fsp } from 'node:fs';
import { resolve, sep, extname, join } from 'node:path';

export const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.woff2': 'font/woff2',
};

export function text(res, status, body, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...extra });
  res.end(body);
}

// stream one file with etag/304 handling. returns false when it is not a
// regular file so the caller can 404.
export async function sendFile(req, res, file, cacheControl) {
  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': cacheControl,
    'Last-Modified': st.mtime.toUTCString(),
    ETag: etag,
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  headers['Content-Length'] = st.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  const stream = createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
  return true;
}

// map a request path to an absolute file under root, or null if it escapes,
// is malformed, or touches a dotfile.
export function resolveUnder(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  if (decoded.split('/').some((seg) => seg.startsWith('.') && seg !== '.' && seg !== '..')) return null;
  const file = resolve(root, '.' + (decoded.startsWith('/') ? decoded : '/' + decoded));
  if (file !== root && !file.startsWith(root + sep)) return null;
  return file;
}

function cacheFor(file) {
  const base = file.slice(file.lastIndexOf(sep) + 1);
  if (base === 'sw.js' || base.endsWith('.html')) return 'no-cache';
  return 'public, max-age=3600';
}

// handler for the web root. resolves once at creation so symlinked roots work.
export function createStatic(rootDir) {
  const root = resolve(rootDir);
  return async function serve(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return text(res, 405, 'method not allowed', { Allow: 'GET, HEAD' });
    let file = resolveUnder(root, pathname);
    if (!file) return text(res, 404, 'not found');
    if (pathname.endsWith('/')) file = join(file, 'index.html');
    if (await sendFile(req, res, file, cacheFor(file))) return;
    // a directory without a trailing slash: try its index, no redirect dance
    if (extname(file) === '' && (await sendFile(req, res, join(file, 'index.html'), 'no-cache'))) return;
    text(res, 404, 'not found');
  };
}
