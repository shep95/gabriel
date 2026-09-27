// the plain-http side: a page that explains the certificate step, the CA in
// the formats each OS wants, a health probe, and a redirect to https for
// everything else.

import { createHash } from 'node:crypto';
import { text } from './static.mjs';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// stable uuid derived from the CA so re-downloading the profile updates the
// installed one instead of stacking duplicates.
function uuidFrom(seed, salt) {
  const b = createHash('sha256').update(salt + seed).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`.toUpperCase();
}

export function mobileconfig(ca, name) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key>
      <string>beacon-ca.cer</string>
      <key>PayloadContent</key>
      <data>${ca.der.toString('base64')}</data>
      <key>PayloadDescription</key>
      <string>Root certificate of the ${esc(name)} beacon</string>
      <key>PayloadDisplayName</key>
      <string>beacon local CA</string>
      <key>PayloadIdentifier</key>
      <string>local.beacon.ca.root</string>
      <key>PayloadType</key>
      <string>com.apple.security.root</string>
      <key>PayloadUUID</key>
      <string>${uuidFrom(ca.sha256hex, 'payload')}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key>
  <string>Trusts the local beacon so this device can open its console over https. SHA-256 ${esc(ca.fingerprint)}</string>
  <key>PayloadDisplayName</key>
  <string>beacon CA (${esc(name)})</string>
  <key>PayloadIdentifier</key>
  <string>local.beacon.ca</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${uuidFrom(ca.sha256hex, 'profile')}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
`;
}

export function installPage({ ca, name, httpsUrls }) {
  const consoleUrl = httpsUrls[0] || '/';
  const urls = httpsUrls.map((u) => `<li><a href="${esc(u)}">${esc(u)}</a></li>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<meta name="robots" content="noindex, nofollow">
<title>${esc(name)}: join</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 28px 16px 56px; background: #07080d; color: #ece7df; font: 17px/1.55 -apple-system, "Inter", "Segoe UI", system-ui, sans-serif; max-width: 40em; margin-inline: auto; }
  h1 { font-size: 1.5em; font-weight: 300; margin: 0 0 .3em; letter-spacing: -.01em; }
  h2 { font-size: 1em; font-weight: 400; margin: 1.6em 0 .4em; color: #fff; }
  p { color: #c6bfb4; margin: .5em 0; }
  a { color: #e0a262; }
  .step { display: grid; grid-template-columns: 2em 1fr; gap: .4em 1em; align-items: start; margin: 1.4em 0; padding: 1.1em 1.2em; background: rgba(14,17,25,.8); border: 1px solid rgba(236,231,223,.1); border-radius: 16px; }
  .n { font-family: ui-monospace, Menlo, Consolas, monospace; color: #8f887d; font-size: .8em; padding-top: .4em; }
  .btn { display: inline-block; margin: .5em .5em .2em 0; padding: 12px 18px; border-radius: 999px; text-decoration: none; font-size: 1em; }
  .primary { background: #f4efe7; color: #07080d; }
  .secondary { background: rgba(244,239,231,.08); color: #ece7df; border: 1px solid rgba(244,239,231,.25); }
  details { margin: .6em 0; } summary { cursor: pointer; color: #ece7df; }
  code, .fp { font-family: ui-monospace, Menlo, Consolas, monospace; }
  .fp { display: block; word-break: break-all; background: #10131a; padding: 10px 12px; border-radius: 8px; font-size: .85em; color: #c6bfb4; }
  ol, ul { padding-left: 1.3em; } li { margin: .25em 0; } .muted { color: #8f887d; font-size: .9em; }
</style>
</head>
<body>
<h1>join ${esc(name)}</h1>
<p>this room runs its own network, with no internet. two taps and you are in.</p>

<div class="step"><div class="n">01</div><div>
  <strong>install the beacon's certificate</strong>
  <p>the beacon vouches for itself, since no public authority can reach a room without internet. your device asks you to trust it once.</p>
  <a class="btn primary" href="/ca.mobileconfig">iPhone / iPad</a>
  <a class="btn secondary" href="/ca.crt">Android</a>
  <a class="btn secondary" href="/ca.crt">Mac</a>
  <a class="btn secondary" href="/ca.der">Windows</a>
  <a class="btn secondary" href="/ca.pem">Linux / Firefox</a>
  <details><summary>where the switch is, per device</summary>
    <h2>iPhone and iPad</h2>
    <ol><li>allow the download, then open Settings → <b>Profile Downloaded</b> → <b>Install</b>.</li><li>Settings → General → About → <b>Certificate Trust Settings</b> → switch on <b>beacon local CA</b>.</li></ol>
    <h2>Android</h2>
    <ol><li>Settings → Security → <b>Encryption &amp; credentials</b> → <b>Install a certificate</b> → <b>CA certificate</b> → <b>Install anyway</b> → pick <code>beacon-ca.crt</code>.</li></ol>
    <p class="muted">Firefox on Android keeps its own store: Settings → About Firefox, tap the logo five times, then Settings → Secret Settings → Use third party CA certificates.</p>
    <h2>Mac</h2>
    <ol><li>double-click the file; it opens in <b>Keychain Access</b>. add it to <b>System</b>, double-click the entry, open <b>Trust</b>, set <b>Always Trust</b>.</li></ol>
    <h2>Windows</h2>
    <ol><li>Win+R, run <code>certmgr.msc</code>. <b>Trusted Root Certification Authorities</b> → All Tasks → <b>Import</b> the file.</li></ol>
    <h2>Linux and Firefox</h2>
    <ol><li>Firefox: Settings → Privacy &amp; Security → <b>Certificates</b> → View Certificates → Authorities → <b>Import</b>, tick <b>Trust this CA to identify websites</b>.</li><li>Chrome: Settings → Privacy and security → Security → Manage certificates → Authorities → Import.</li><li>system-wide (Debian/Ubuntu): copy the PEM to <code>/usr/local/share/ca-certificates/beacon-ca.crt</code> and run <code>sudo update-ca-certificates</code>.</li></ol>
  </details>
</div></div>

<div class="step"><div class="n">02</div><div>
  <strong>open the console</strong>
  <p>it is served by this beacon and connects to it by itself. add it to your home screen from the browser menu and it keeps working with the network off.</p>
  <a class="btn primary" href="${esc(consoleUrl)}">open the console</a>
  ${httpsUrls.length > 1 ? `<details><summary>other addresses of this beacon</summary><ul>${urls}</ul></details>` : ''}
  <p class="muted">if the browser still warns, the certificate was installed but not marked trusted: on iPhone that is the Certificate Trust Settings switch; on a Mac the Always Trust setting.</p>
</div></div>

<details>
<summary>what trusting the certificate means, and how to undo it</summary>
<p>a trusted authority can vouch for any website name, not only this beacon. whoever holds the beacon's private key file could, on this device, impersonate other https sites until you remove the certificate (iPhone: Settings → General → VPN &amp; Device Management; Android: Settings → Security → Encryption &amp; credentials → Trusted credentials → User; desktop: the store you imported it into). only install a beacon run by someone you trust with that, and remove it when the deployment ends. the certificate expires by itself after five years.</p>
<p>before trusting it, compare this fingerprint with the one printed where the beacon runs:</p>
<span class="fp">SHA-256 ${esc(ca.fingerprint)}</span>
</details>
</body>
</html>
`;
}

// returns an http request handler.
export function createInstall({ ca, name, httpsPort, lanAddresses, health }) {
  const attach = (filename, type) => ({ 'Content-Type': type, 'Content-Disposition': `attachment; filename=${filename}`, 'Cache-Control': 'no-cache' });
  const profile = mobileconfig(ca, name);
  return function handle(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return text(res, 405, 'method not allowed', { Allow: 'GET, HEAD' });
    const hostname = hostOf(req) || lanAddresses()[0] || 'localhost';
    const httpsBase = `https://${hostname}:${httpsPort}`;
    switch (pathname) {
      case '/': {
        const urls = [httpsBase, ...lanAddresses().map((ip) => `https://${ip}:${httpsPort}`)].filter((u, i, a) => a.indexOf(u) === i).map((u) => u + '/');
        const body = installPage({ ca, name, httpsUrls: urls });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-cache' });
        return res.end(req.method === 'HEAD' ? undefined : body);
      }
      case '/ca.crt': return body(res, ca.cert, attach('beacon-ca.crt', 'application/x-x509-ca-cert'));
      case '/ca.pem': return body(res, ca.cert, attach('beacon-ca.pem', 'application/x-pem-file'));
      case '/ca.der': return body(res, ca.der, attach('beacon-ca.der', 'application/x-x509-ca-cert'));
      case '/ca.mobileconfig': return body(res, profile, attach('beacon-ca.mobileconfig', 'application/x-apple-aspen-config'));
      case '/healthz': return body(res, JSON.stringify({ ok: true, now: Date.now(), ...health() }), { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      default:
        res.writeHead(302, { Location: httpsBase + req.url, 'Cache-Control': 'no-store' });
        return res.end();
    }
  };
}

function body(res, data, headers) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  res.writeHead(200, { 'Content-Length': buf.length, ...headers });
  res.end(buf);
}

// hostname from the Host header, without port; null if absent or unusable.
export function hostOf(req) {
  const h = req.headers.host;
  if (!h) return null;
  const m = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d+)?$/i.exec(h);
  return m ? m[1] : null;
}
