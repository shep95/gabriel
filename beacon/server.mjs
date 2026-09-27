#!/usr/bin/env node
// beacon: serves the console over https on a network with no internet and
// relays opaque encrypted frames between the phones on it.

import { createServer as createHttps } from 'node:https';
import { createServer as createHttp } from 'node:http';
import { join } from 'node:path';
import qrcode from 'qrcode-terminal';
import { spawn } from 'node:child_process';
import { parseConfig, usage } from './lib/args.mjs';
import { ensureCerts, lanAddresses } from './lib/certs.mjs';
import { createStatic, sendFile, text } from './lib/static.mjs';
import { createInstall } from './lib/install.mjs';
import { attachHub } from './lib/hub.mjs';

const log = (...a) => console.log(new Date().toISOString(), ...a);

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=(self), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  // no strict-transport-security on purpose: hsts is per host across ports,
  // so it would make a browser refuse the plain-http certificate install page
  // on this same address for a year. a lan device with its own ca gains
  // nothing from it; the console is only ever linked over https anyway.
};

// wraps a (req, res, pathname) handler: security headers, url parsing, error fence.
function route(handler) {
  return (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    let pathname;
    try {
      pathname = new URL(req.url, 'http://x').pathname;
    } catch {
      return text(res, 400, 'bad request');
    }
    Promise.resolve(handler(req, res, pathname)).catch((err) => {
      log('request error', err.message);
      if (!res.headersSent) text(res, 500, 'internal error');
      else res.destroy();
    });
  };
}

const TILE = /^\/tiles\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.png$/;

function createApp(cfg, hubStats) {
  const serveStatic = createStatic(cfg.web);
  return async (req, res, pathname) => {
    if (pathname === '/healthz') {
      const body = JSON.stringify({ ok: true, now: Date.now(), ...hubStats() });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
      return res.end(body);
    }
    const tile = cfg.tiles && TILE.exec(pathname);
    if (tile) {
      const [z, x, y] = tile.slice(1).map(Number);
      if (z > 19 || x >= 2 ** z || y >= 2 ** z) return text(res, 404, 'not found');
      if (await sendFile(req, res, join(cfg.tiles, String(z), String(x), `${y}.png`), 'public, max-age=86400')) return;
      return text(res, 404, 'not found');
    }
    if (pathname.startsWith('/tiles/')) return text(res, 404, 'not found');
    return serveStatic(req, res, pathname);
  };
}

function openInBrowser(url) {
  const cmd = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* no browser here; the address is printed */ }
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

async function main() {
  let cfg;
  try {
    cfg = parseConfig();
  } catch (err) {
    console.error(err.message);
    console.error(usage());
    process.exit(2);
  }
  if (cfg.help) {
    console.log(usage());
    return;
  }

  const certs = await ensureCerts({ dataDir: cfg.data, hostNames: cfg.hostNames, log });
  if (certs.changed === 'ca') log('new CA created; every phone needs to install it from the http install page');
  else if (certs.changed === 'leaf') log('server certificate (re)issued for', certs.names.join(' '));

  const hubOpts = { password: cfg.password, name: cfg.name, tiles: !!cfg.tiles, log };
  const https = createHttps({ key: certs.key, cert: certs.cert, minVersion: 'TLSv1.2' });
  const hub = attachHub(https, hubOpts);
  https.on('request', route(createApp(cfg, hub.stats)));
  https.on('tlsClientError', () => {}); // phones without the CA abort the handshake; that is expected, not an error

  const http = createHttp(route(createInstall({ ca: certs.ca, name: cfg.name, httpsPort: cfg.httpsPort, lanAddresses, health: hub.stats })));

  const servers = [https, http];
  const hubs = [hub];
  let dev = null;
  if (cfg.devHttp) {
    dev = createHttp();
    const devHub = attachHub(dev, hubOpts);
    dev.on('request', route(createApp(cfg, devHub.stats)));
    servers.push(dev);
    hubs.push(devHub);
  }

  try {
    await listen(https, cfg.httpsPort, cfg.host);
    await listen(http, cfg.httpPort, cfg.host);
    if (dev) await listen(dev, cfg.devHttp, '127.0.0.1');
  } catch (err) {
    console.error(`cannot listen: ${err.message}`);
    process.exit(1);
  }

  const ips = cfg.host === '0.0.0.0' || cfg.host === '::' ? lanAddresses() : [cfg.host];
  const shown = ips.length ? ips : ['127.0.0.1'];
  const httpsUrls = shown.map((ip) => `https://${ip}:${cfg.httpsPort}/`);
  const installUrl = `http://${shown[0]}:${cfg.httpPort}/`;
  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  beacon "${cfg.name}" is running. tell everyone in the room:`);
  console.log('');
  console.log('  1. join this wi-fi (this machine\'s hotspot, or the same router)');
  console.log(`  2. open  ${installUrl}  and tap "install"`);
  console.log('  3. tap "open the console"; it connects here by itself');
  console.log('');
  console.log('  or scan this:');
  console.log('══════════════════════════════════════════════════════════════');
  qrcode.generate(installUrl, { small: true }, (q) => console.log(q));
  console.log(`  console (https):  ${httpsUrls.join('\n                    ')}`);
  console.log(`  CA sha256:        ${certs.ca.fingerprint}`);
  console.log(`  password:         ${cfg.password ? 'set' : 'none'}`);
  console.log(`  tiles:            ${cfg.tiles ? cfg.tiles : 'off'}`);
  console.log(`  serving:          ${cfg.web}`);
  console.log(`  certificates:     ${cfg.data} (leaf covers ${certs.names.join(', ')})`);
  if (dev) {
    console.log('');
    console.log(`  !!! DEV HTTP on http://127.0.0.1:${cfg.devHttp}/ : NO ENCRYPTION. local testing only.`);
    console.log('  !!! never forward or expose this port; anything on the path sees every frame.');
  }
  console.log('');
  // the machine running the beacon opens its own install page, so the person
  // who started it sees the same screen everyone else will
  if (cfg.open && !dev && !process.env.CI) openInBrowser(installUrl);

  let stopping = false;
  const stop = async (sig) => {
    if (stopping) return;
    stopping = true;
    log(`${sig}: shutting down`);
    const t = setTimeout(() => process.exit(1), 5000);
    t.unref();
    for (const s of servers) s.close();
    await Promise.all(hubs.map((h) => h.close(1001)));
    for (const s of servers) s.closeAllConnections?.();
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
