# gabriel console

an offline-first messenger companion. static files, no build step, no
server-side code on the hosting side, no third-party network calls except the
ones a person switches on by hand. once loaded over https (or localhost) it
installs a service worker and keeps working with the network off.

## what it does

- **local sign-in without an account.** a passphrase is turned into a key on the
  device (pbkdf2-sha256, 600 000 rounds, random salt) that wraps a random
  aes-256-gcm vault key. every stored record is sealed under the vault key.
  nothing is sent anywhere; there is nothing to reset.
- **device pairing by code.** each device has p-256 keys (ecdh for agreement,
  ecdsa for signing). a pairing code (qr or crockford-base32 text) carries the
  public keys, a one-time nonce and a name. after both devices have read each
  other's code they derive a shared key and a six-digit short authentication
  string; matching digits on both screens confirm nobody sat in between.
- **one to one and group, with no internet.** a *beacon* (see `../beacon/`) is a small
  relay run on a laptop or hotspot in the room. it fans out opaque strings by
  random tag. rooms are founded by one device; only devices the founder has
  paired with can be added; the room key travels to them sealed under that
  pairing. every message is aes-256-gcm under the room's epoch key with the room
  id and epoch as additional data, and signed ecdsa p-256 by its sender.
  removing someone rotates the epoch key, and the beacon tag rotates with it.
  a direct chat rides the pair channel itself under the pair key. calls, one to
  one or in a room, are a webrtc mesh (up to eight) signalled inside sealed
  messages of that conversation; media goes straight between phones on the
  local network with no stun or turn unless the person adds servers.
- **shield.** messages blur until pressed and held; the app veils itself when
  it is not in front; shielded text cannot be selected, copied or dragged. a
  page cannot prevent the operating system from capturing the screen, and the
  setting says so.
- **notifications that name the sender, never the content** (or only a dot, or
  nothing). no push server: they fire while the console is open or backgrounded.
- **location only on request.** share once or live inside a room; recipients get
  distance, bearing and a compass radar with no map at all. a map appears only if
  tiles come from the beacon or the person explicitly allows openstreetmap.org.
- **sealed transfers over the screen** (qr frames or text) between paired devices,
  sealed notes, sealed backup and import, passphrase change, auto-lock, erase.
- **installable from the web** on ios, android, macos, windows and linux browsers.

## look

the interface is read from one picture (`img/meadow.webp`): a cobalt sky, a
cascade of silver light falling into cloud, a green field, one person walking.
surfaces are frosted glass so the picture stays visible; text is the sky's
shadow; the single accent is field green and appears only at trust states;
motion is a slow drift (the picture breathes, two sheets of mist cross it)
and stops entirely under reduced-motion. a dusk variant is in settings.

## layout

```
web/
  index.html            landing page (seo metadata, install, sections)
  app.html              the console
  sw.js                 service worker: precache, cache-first, same-origin only
                        (openstreetmap tile hosts pass through, never cached)
  manifest.webmanifest  installable app metadata
  robots.txt            crawl rules (sitemap added by scripts/set-site-url.mjs)
  css/                  tokens, landing, app
  js/util.js            bytes, base32, base64url, small helpers
  js/crypto.js          vault, records, identity, pairing, transfer, rooms (webcrypto only)
  js/db.js              indexeddb wrapper (meta, devices, notes, seen, rooms, messages)
  js/state.js  js/ui.js shared state, event bus, dom helpers
  js/beacon.js          websocket client for the relay
  js/rooms.js           room lifecycle, roster, epoch keys, message seal/open
  js/calls.js           webrtc mesh with perfect negotiation
  js/notify.js  js/shield.js  js/install.js  js/geo.js
  js/qr.js  js/scan.js  qr rendering and camera scanning
  js/status.js          worker registration and offline readiness probes
  js/landing.js  js/app.js
  vendor/               qrcode-generator (mit), jsQR (apache-2.0), leaflet (bsd-2), inter (ofl), with licenses
  icons/                app icons and the social image
  scripts/set-site-url.mjs   writes canonical/og:url/sitemap for a domain
  tests/e2e.mjs         headless end-to-end check (see tests/README.md)
```

## serving it

**vercel.** the repository root carries `vercel.json` (output directory `web`,
no build step, security headers, cache rules) and `.vercelignore`. import the
repository into a vercel project and deploy; nothing else is needed. after the
first deploy, set the public url once so crawlers get absolute links:

```
node web/scripts/set-site-url.mjs https://your-domain.example
```

**a beacon.** `node beacon/server.mjs` serves this directory over https on the
local network and provides the relay. see `../beacon/README.md`.

**anything else.** any static file server over https or `http://localhost`.
web cryptography, service workers, the camera and the microphone require a
secure context.

to update: bump `VERSION` in `sw.js` so installed clients fetch the new files.

## security notes

- what stays plaintext at rest: profile name, public keys and fingerprint, the
  room id used to index sealed messages, and a ledger of seen message ids with
  receive times. everything else, settings included, is sealed.
- keys never leave the origin; the worker refuses off-origin requests except
  openstreetmap tile hosts, which are only asked when the person enabled them.
- the vault key lives in memory only while unlocked; idle auto-lock defaults to
  five minutes and locking discards it and drops the beacon connection.
- the passphrase kdf is pbkdf2 because that is what webcrypto ships. it is
  slow enough for a long passphrase and not a substitute for one.
- pairing security rests on the six-digit comparison being done by the people
  holding the two devices. a code swapped in transit produces different digits.
- the pair key and room epoch keys are long-lived; re-pairing or rotating
  replaces them. there is no per-message ratchet.
- the beacon is untrusted: it sees tags, ciphertext, timing and how many devices
  listen to each tag. it can drop or replay ciphertext (replays are rejected by
  message id); it cannot read, forge or re-target a message.
- the console cannot talk to the bluetooth mesh from a browser. it holds what
  the mesh cannot, and carries rooms and calls over a local beacon instead.
- the deep review of this code is in `../docs/audit/WEB_SECURITY_AUDIT.md`.
