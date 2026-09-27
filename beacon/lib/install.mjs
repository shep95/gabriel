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
  const urls = httpsUrls.map((u) => `<li><a href="${esc(u)}">${esc(u)}</a></li>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>beacon: install the certificate</title>
<style>
  body { margin: 0; padding: 24px 16px 48px; background: #101214; color: #e6e6e6; font: 16px/1.5 system-ui, sans-serif; max-width: 42em; margin-inline: auto; }
  h1 { font-size: 1.4em; margin: 0 0 .5em; } h2 { font-size: 1.05em; margin: 1.8em 0 .4em; color: #fff; }
  a { color: #8ecbff; } code, .fp { font-family: ui-monospace, Menlo, Consolas, monospace; }
  .fp { display: block; word-break: break-all; background: #1a1d21; padding: 10px 12px; border-radius: 6px; font-size: .9em; }
  .dl a { display: inline-block; margin: 4px 8px 4px 0; padding: 8px 12px; background: #1f2937; border-radius: 6px; text-decoration: none; }
  ol, ul { padding-left: 1.3em; } li { margin: .25em 0; } .muted { color: #9aa0a6; }
</style>
</head>
<body>
<h1>${esc(name)}: this beacon uses its own certificate; install it once</h1>
<p>There is no internet on this network, so no public authority can vouch for the beacon. Instead it carries its own certificate authority. Browsers only allow encryption, the camera and offline install on pages served over https, so your phone has to trust that authority before the console will work. You do this one time per device.</p>
<p><strong>What trusting it means.</strong> A trusted authority can vouch for any website name, not only this beacon. Whoever holds the beacon's private key file could, on this device, impersonate other https sites until you remove the certificate (iPhone: Settings → General → VPN &amp; Device Management; Android: Settings → Security → Encryption &amp; credentials → Trusted credentials → User; desktop: the same store you imported it into). Only install a beacon run by someone you trust with that, and remove it when the deployment ends. The certificate expires by itself after five years.</p>
<p>Before trusting it, compare this fingerprint with the one printed where the beacon is running:</p>
<span class="fp">SHA-256 ${esc(ca.fingerprint)}</span>
<p class="dl"><a href="/ca.mobileconfig">iPhone / iPad profile</a> <a href="/ca.crt">certificate (.crt)</a> <a href="/ca.pem">PEM</a> <a href="/ca.der">DER</a></p>

<h2>iPhone and iPad</h2>
<ol>
<li>Tap <a href="/ca.mobileconfig">iPhone / iPad profile</a> and allow the download.</li>
<li>Open Settings. Tap <b>Profile Downloaded</b> near the top, then <b>Install</b> (enter your passcode).</li>
<li>Go to Settings → General → About → <b>Certificate Trust Settings</b> and switch on <b>beacon local CA</b>.</li>
</ol>

<h2>Android</h2>
<ol>
<li>Tap <a href="/ca.crt">certificate (.crt)</a> to download it.</li>
<li>Open Settings → Security (or Security &amp; privacy) → <b>Encryption &amp; credentials</b> → <b>Install a certificate</b> → <b>CA certificate</b>.</li>
<li>Choose <b>Install anyway</b> and pick the downloaded <code>beacon-ca.crt</code>.</li>
</ol>
<p class="muted">Some browsers on Android (Firefox) keep their own store: Settings → About Firefox, tap the logo five times, then Settings → Secret Settings → Use third party CA certificates.</p>

<h2>macOS</h2>
<ol>
<li>Download <a href="/ca.crt">certificate (.crt)</a> and double-click it; it opens in <b>Keychain Access</b>.</li>
<li>Add it to the <b>System</b> keychain, then double-click the entry, open <b>Trust</b> and set <b>When using this certificate</b> to <b>Always Trust</b>.</li>
</ol>

<h2>Windows</h2>
<ol>
<li>Download <a href="/ca.der">DER</a>. Press Win+R, run <code>certmgr.msc</code>.</li>
<li>Right-click <b>Trusted Root Certification Authorities</b> → All Tasks → <b>Import</b>, and choose the downloaded file.</li>
</ol>

<h2>Linux and Firefox</h2>
<ol>
<li>Firefox on any OS: Settings → Privacy &amp; Security → <b>Certificates</b> → View Certificates → Authorities → <b>Import</b> the <a href="/ca.pem">PEM</a>, and tick <b>Trust this CA to identify websites</b>.</li>
<li>Chrome and Chromium: Settings → Privacy and security → Security → Manage certificates → Authorities → Import.</li>
<li>System-wide (Debian/Ubuntu): copy the PEM to <code>/usr/local/share/ca-certificates/beacon-ca.crt</code> and run <code>sudo update-ca-certificates</code>.</li>
</ol>

<h2>Then open the console</h2>
<ul>${urls}</ul>
<p class="muted">If the browser still warns, the certificate was installed but not marked trusted: on iPhone that is the Certificate Trust Settings switch; on macOS the Always Trust setting.</p>
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
