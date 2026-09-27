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
- **photos, voice clips and files** in any conversation. a photo is re-encoded
  before it leaves, which strips camera, time and location metadata and bounds
  its size; a voice clip is recorded on the page; anything up to 1.5 mb goes
  in sealed parts of 84 kb so every frame stays under the relay's limit, and
  is checked to the byte on arrival. media arrives shielded like text.
- **shield.** messages and photos blur until pressed and held, one at a time
  and for at most eight seconds; the app veils itself when it is not in front;
  shielded text cannot be selected, copied or dragged. a page cannot prevent
  the operating system from capturing the screen, and the setting says so.
- **an on-page keyboard**, shuffled each time it opens, for the passphrase and,
  if chosen, for every message and note: what is typed on it never passes
  through the system keyboard, so a keyboard app or a keystroke logger on the
  device sees nothing. the composer also never hands text to cloud spell-check.
- **notifications that name the sender, never the content** (or only a dot, or
  nothing). no push server: they fire while the console is open or backgrounded.
- **location only on request.** share once or live inside a room; recipients get
  distance, bearing and a compass radar with no map at all. a map appears only if
  tiles come from the beacon or the person explicitly allows openstreetmap.org.
- **sealed transfers over the screen** (qr frames or text) between paired devices,
  sealed notes, sealed backup and import, passphrase change, auto-lock, erase.
- **installable from the web** on ios, android, macos, windows and linux browsers.

## look

the interface is read from one picture: a night sky full of stars, a ringed
moon low over a bank of cloud lit amber from below. the photograph itself is
not in the tree yet; it belongs at `img/sky.webp`, referenced from the
`.bg .picture` rule in `css/base.css` and the worker's precache list. surfaces
are smoked glass so the sky stays visible; text is the moon's off-white; the
single accent is the cloud's ember and appears only where something is on or
trusted; the primary button is the moon, the one solid light on the page. the
favicon is the same ringed moon. motion is the pace of cloud: the picture
breathes, the stars turn once in eleven minutes, the glow at the cloud line
drifts, and all of it stops under reduced-motion. a "deep" variant in
settings dims the picture and thickens the glass for dark rooms and long
nights. the sky is layered in css beneath the picture, so the page is whole
before the image has decoded, offline before it has been cached, and
tonight without it.

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
  js/notify.js  js/shield.js  js/install.js  js/geo.js  js/keypad.js
  js/qr.js  js/scan.js  qr rendering and camera scanning
  js/status.js          worker registration and offline readiness probes
  js/landing.js  js/app.js
  vendor/               qrcode-generator (mit), jsQR (apache-2.0), leaflet (bsd-2), inter (ofl), with licenses
  icons/                app icons (the ringed moon) and the social image
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

to update: bump `VERSION` in `sw.js`. an open page notices the new worker and
reloads itself: the landing at once, the console at once when locked and at the
next lock when open (a toast says so), so nothing typed or in a call is lost.

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
