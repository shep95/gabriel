# gabriel console

an offline-first companion to the mesh app. static files, no build step, no
server-side code, no third-party network calls. once loaded over https (or
localhost) it installs a service worker and keeps working with the network off.

## what it does

- **local sign-in without an account.** a passphrase is turned into a key on the
  device (pbkdf2-sha256, 600 000 rounds, random salt) that wraps a random
  aes-256-gcm vault key. every stored record is sealed under the vault key.
  nothing is sent anywhere; there is nothing to reset.
- **device pairing by code.** each device has a p-256 identity. a pairing code
  (qr or crockford-base32 text) carries the public key, a one-time nonce and
  a name. after both devices have read each other's code they derive a shared
  key and a six-digit short authentication string; matching digits on both
  screens confirm nobody sat in between.
- **encrypted transfer over the screen.** notes are sealed for one paired
  device (hkdf from the pair key, fresh salt and nonce per message, aad binds
  sender and recipient) and shown as one or several cycling qr frames, or as
  text. the receiving device decrypts, detects replays, and saves the note.
- **sealed notes, backup, passphrase change, auto-lock, full erase.**

## layout

```
web/
  index.html            landing page
  app.html              the console
  sw.js                 service worker: precache, cache-first, same-origin only
  manifest.webmanifest  installable app metadata
  css/                  tokens, landing, app
  js/util.js            bytes, base32, base64url, small helpers
  js/crypto.js          vault, records, identity, pairing, transfer (webcrypto only)
  js/db.js              indexeddb wrapper
  js/qr.js  js/scan.js  qr rendering and camera scanning
  js/status.js          worker registration and offline readiness probes
  js/landing.js  js/app.js
  vendor/               qrcode-generator (mit), jsQR (apache-2.0), with licenses
  icons/
  tests/e2e.mjs         headless end-to-end check (see tests/README.md)
```

## serving it

any static file server works. web cryptography, service workers and the
camera require a secure context, so use https or `http://localhost`.

```
cd web
python3 -m http.server 8080
# open http://localhost:8080/
```

to update: bump `VERSION` in `sw.js` so installed clients fetch the new files.

## security notes

- keys never leave the origin; the worker refuses off-origin requests outright.
- the vault key lives in memory only while unlocked; idle auto-lock defaults to
  five minutes and locking discards it.
- the passphrase kdf is pbkdf2 because that is what webcrypto ships. it is
  slow enough for a long passphrase and not a substitute for one. the sign-in
  screen says so.
- pairing security rests on the six-digit comparison being done by the people
  holding the two devices. a code swapped in transit produces different digits.
- the transfer envelope has no forward secrecy across messages: the pair key
  is long-lived. re-pairing replaces it.
- the console cannot talk to the bluetooth mesh from a browser. it holds what
  the mesh cannot: notes, contacts and a verified link between two devices.
