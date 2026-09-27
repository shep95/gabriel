# beacon

the small relay that carries the console's rooms and calls on a wi-fi with no
internet. one person runs it; everyone else joins the wi-fi and opens the
address it shows. it sees only random tags and ciphertext.

## running it, simplest first

**one command, on a laptop with node installed** (node is a single download
from nodejs.org, the lts button):

```
npx github:shep95/gabriel.asher
```

**or double-click**: download the repository as a zip, unzip it, and open
`beacon/start.command` (mac), `beacon/start.bat` (windows) or `beacon/start.sh`
(linux). the first start installs its three dependencies; every later start
is instant.

**or from a checkout**: `cd beacon && npm install && node server.mjs`.

what happens next, every time:

1. it prints three lines to tell the room, and a qr code of its join page,
   and opens that page in your own browser.
2. everyone joins the same wi-fi: this machine's hotspot, a phone's hotspot,
   or the room's router. no internet is needed on it.
3. each person opens the join page once, taps install for the certificate,
   then "open the console". the console served by the beacon connects to it
   by itself, and a console opened from anywhere else finds it on the
   hotspot's usual addresses and connects too.

turn the machine's hotspot on before starting the beacon so the printed
address is the hotspot's. `--no-open` keeps the browser closed; `--password`
asks phones for a password; `--name` names the room.

## quick start

```
cd beacon
npm install            # ws, selfsigned, qrcode-terminal; pinned
node server.mjs        # serves ../web
```

Startup prints the https URL for each LAN address, the http install page URL,
the CA fingerprint, whether a password is set, tiles status, and a QR code of
the first https URL. Phones do this once: open the http install page, install
the CA (below), then open the https URL.

Options (env in brackets; command-line wins):

```
--web DIR           console files             [BEACON_WEB]        default ../web next to beacon/
--https-port N      console + hub             [BEACON_HTTPS_PORT] 8443
--http-port N       install page              [BEACON_HTTP_PORT]  8080
--data DIR          keys and certificates     [BEACON_DATA]       ./beacon-data inside beacon/
--password SECRET   required in the hello     [BEACON_PASSWORD]   none
--tiles DIR         serve map tiles from DIR  [BEACON_TILES]      off
--name "room 12"    shown to clients          [BEACON_NAME]       beacon
--host ADDR         bind address              [BEACON_HOST]       0.0.0.0
--host-name NAME    extra certificate name    [BEACON_HOST_NAME]  repeatable; env comma separated
--dev-http PORT     plain http copy on 127.0.0.1 for local testing only [BEACON_DEV_HTTP]
```

Relative paths on the command line resolve against the current directory.
`--dev-http` exists so the console's browser tests can run against a real hub
without certificates; it is unencrypted, bound to loopback, and prints a warning.
Never forward that port.

Requires Node 20 or newer. No build step.

## the certificate step, and why it exists

Browsers hand out Web Crypto, service workers, the camera and installability
only on secure origins: https, or `localhost`. On a hotspot with no uplink there
is no public certificate authority to ask, and the beacon has no domain name.
So the beacon makes its own CA on first run (valid ten years, kept under
`--data` with 0600 permissions) and signs a server certificate with it (valid
398 days, reissued automatically when fewer than 30 days remain or when the
set of addresses it must cover changed, for example after the Pi gets a new
DHCP lease). The CA does not change, so each phone installs it exactly once.

Before trusting the CA on a phone, compare the SHA-256 fingerprint shown on the
install page with the one the beacon printed at startup. They must match.

The install page at `http://<beacon-ip>:8080/` walks through it per OS:

- iPhone/iPad: download `/ca.mobileconfig`, Settings → Profile Downloaded →
  Install, then General → About → Certificate Trust Settings → enable it.
- Android: download `/ca.crt`, Settings → Security → Encryption & credentials →
  Install a certificate → CA certificate.
- macOS: `/ca.crt` → Keychain Access → System keychain → Always Trust.
- Windows: `/ca.der` → `certmgr.msc` → Trusted Root Certification Authorities → Import.
- Linux and Firefox: import `/ca.pem` under Settings → Certificates (Authorities).

A trusted root can vouch for any name, so anyone holding `beacon-data/ca.key`
could impersonate other https sites to devices that installed it. The install
page says so and shows how to remove it; keep the data directory on the
operator's machine only, and tell people to remove the certificate when the
deployment ends. The CA expires after five years. Wrong-password attempts are
counted per address and an address that fails five times a minute is refused
at the websocket upgrade for a minute; replay buffers share a 64 MiB cap with
least-recently-used eviction; each address may hold 64 connections.

Everything else requested over http redirects to the https URL. The https
server deliberately does not send `Strict-Transport-Security`: HSTS applies per
host across all ports, so it would make a browser refuse this same address's
plain-http install page for a year, and a LAN device with its own CA gains
nothing from it.

Certificate details for the curious: EC P-256 keys, SHA-256, leaf with
`serverAuth` EKU and SANs for every non-internal IPv4 of the machine plus
`localhost`, `127.0.0.1`, `beacon.local` and any `--host-name`. If your hotspot
resolves a name (mDNS `beacon.local`, or a router DNS entry), pass it with
`--host-name` and phones can use the name instead of the address.

## hotspot notes

- Any phone hotspot or travel router works; the beacon needs no uplink.
- Many routers and most phone hotspots enable client isolation: devices can
  reach the router (and the beacon if it is the router or is wired to it) but
  not each other. That breaks phone-to-phone WebRTC. The beacon does not care:
  every frame goes phone → beacon → phone, so chat keeps working.
- If the beacon runs on a laptop that is itself the hotspot, its LAN address
  is the hotspot gateway address (often 192.168.137.1 on Windows,
  192.168.2.1 on macOS, 10.42.0.1 on Linux NetworkManager).
- Firewalls: allow inbound TCP on the https and http ports.
- Time: certificate checks need roughly correct clocks. The certificates are
  backdated one day to tolerate small drift; a phone that has been off the
  internet for months may need its clock set by hand.

## static files

The https server serves the web directory as plain files. `/` is `index.html`.
`sw.js` and `*.html` get `Cache-Control: no-cache` so an updated service worker
is picked up on the next load; other assets get `public, max-age=3600` (they are
not content-hashed, so long immutable caching would be wrong). Paths are resolved
and checked against the root; dotfiles are not served. Every response carries
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
`Permissions-Policy`, `Cross-Origin-Opener-Policy: same-origin`,
`X-Frame-Options: DENY`. No
Content-Security-Policy header is set; the pages carry their own meta CSP.
`/healthz` returns `{"ok":true,"now":<ms>,"connections":n,"tags":n,"buffers":n}`
on both servers.

## hub protocol

Endpoint: `wss://<host>:<https-port>/ws`. JSON text frames only, at most
256 KiB each; a binary frame closes the connection with 1003. All timestamps
are unix milliseconds. Tags are lowercase hex strings of 32 to 64 characters.
Ids from the server are 16 hex characters.

Client → server:

| frame | meaning |
| --- | --- |
| `{"t":"hello","v":1,"pw":"..."}` | must be the first frame, within 5 s, or the server closes with 4000. Wrong or missing password when one is configured: `{"t":"error","code":"auth"}` then close 4001. `v` other than 1: `error` `version` then close 4002. |
| `{"t":"sub","tags":[...]}` | subscribe. The tag's kept frames are replayed in order as `msg` with `"replay":true`, then every subscriber of the tag (including you) gets a `count`. At most 64 subscriptions per connection. |
| `{"t":"unsub","tags":[...]}` | unsubscribe; remaining subscribers get a `count`. |
| `{"t":"pub","tag":"...","data":"...","keep":true,"id":"..."}` | publish. `data` is a string of at most 200 000 characters and is never parsed. Delivered to every *other* subscriber of the tag. `keep:true` also appends it to the tag's replay buffer. `id` is optional (string, at most 40 characters) and is echoed in the ack. |
| `{"t":"ping"}` | answered with `pong`. |

Server → client:

| frame | meaning |
| --- | --- |
| `{"t":"welcome","v":1,"id":"<16 hex>","name":"<--name>","tiles":bool,"buffer":200,"ttl":86400,"now":<ms>}` | after a good hello. `id` is this connection's id. |
| `{"t":"msg","tag","data","ts","id"}` | a published frame; `id` and `ts` are assigned by the server. `"replay":true` is added on frames replayed from the buffer. |
| `{"t":"ack","id"}` | your pub was accepted; `id` is the one you sent, or the server's message id if you sent none. |
| `{"t":"count","tag","n"}` | current subscriber count for a tag you subscribe to. Sent on sub, unsub and disconnect. |
| `{"t":"pong","now":<ms>}` | |
| `{"t":"error","code"}` | the offending frame was dropped. Codes: `auth`, `version`, `bad_frame` (not JSON, or no `t`), `bad_type`, `bad_tag`, `bad_data`, `bad_id`, `rate`. |

Close codes: 1001 beacon shutting down, 1003 binary frame, 1009 frame too
large, 4000 no hello in time (or another frame first), 4001 bad password,
4002 unsupported version, 4008 too many rejected frames.

The server pings at the WebSocket level every 30 s and terminates sockets that
did not answer the previous ping.

## limits

Per connection: 30 publishes per second (token bucket, burst 60), 4 MiB of
inbound frames per minute, 64 subscriptions, 256 KiB per frame, 200 000
characters of `data`. A frame that breaks a limit is dropped with `error`
`rate`; ten rejected frames of any kind within a minute close the connection
with 4008. A subscriber that stops reading and accumulates 16 MiB of unsent
output is disconnected.

Global: 2000 connections (further upgrades get HTTP 503), 20 000 tags with
replay buffers; beyond that the least recently written buffers are evicted.
Each buffer holds the last 200 kept frames for 24 hours; expired frames are
swept once a minute. All of it lives in memory and is gone on restart.

Logs: one line per connection open and close with the connection count and
close code. No tags, no data, no addresses.

## map tiles

With `--tiles DIR` the beacon serves `/tiles/{z}/{x}/{y}.png` from `DIR`
(z 0 to 19, x and y integers within range, `Cache-Control: public,
max-age=86400`); the welcome frame reports `"tiles":true` so the console can
offer a map. The directory layout is the usual slippy-map one:
`DIR/12/2048/1362.png`.

Please respect the [OpenStreetMap tile usage policy](https://operations.osmfoundation.org/policies/tiles/):
bulk downloading from `tile.openstreetmap.org` is not allowed, and this
repository deliberately contains no scraper. Two acceptable ways to fill `DIR`:

1. Render locally. Download a small region extract (for example from
   Geofabrik), run a local renderer or tile server such as
   `openstreetmap-tile-server` or `tilemaker` + `tileserver-gl`, and export
   the zoom levels you need for your area into `DIR`. Everything stays on your
   machine; no public server is touched.
2. Fetch a small bounded area from a tile provider whose terms allow it (your
   own tile server, or a commercial provider's plan that permits caching), with
   a valid `User-Agent`, one request at a time, and only the zoom levels you
   need. A neighbourhood at zoom 13 to 16 is a few hundred tiles; a whole city
   at zoom 17 to 19 is hundreds of thousands. Keep it small.

Tiles carry their own attribution requirements; the console should show
"© OpenStreetMap contributors" when it draws them.

## running it for real

- `--password` keeps strangers on the same Wi-Fi from using the relay as a
  free message bus; share it out of band. It does not protect content, which
  is encrypted end to end before it reaches the beacon.
- Back up `--data` if you want phones to keep trusting the same CA after you
  reinstall the machine. Losing it means every phone installs a new CA.
- A systemd unit is enough for a Pi: `ExecStart=/usr/bin/node /opt/gabriel/beacon/server.mjs`,
  `Environment=BEACON_DATA=/var/lib/beacon`, `Restart=on-failure`.
- Stop with Ctrl-C or SIGTERM; open sockets are closed with 1001 first.

## tests

```
npm test
```

`test/hub.test.mjs` mounts the hub on a plain http server on an ephemeral
loopback port (no certificates) and exercises hello and auth, fan-out that
excludes the sender, keep and replay order, buffer size, TTL and eviction,
tag validation, the subscription cap, malformed frames, rate limiting and the
4008 close, the connection cap, and shutdown.
