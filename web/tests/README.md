# console tests

`e2e.mjs` drives the built console in headless chromium. it starts the beacon
in its loopback dev mode (`node beacon/server.mjs --dev-http`), which serves
`web/` and the relay on one port, then:

- loads the landing page and waits until the worker has cached the site
- creates a profile, locks, rejects a wrong passphrase, unlocks
- takes the browser offline and proves the app and landing still load and unlock
- pairs two devices by exchanging codes and checks both derive the same six digits
- moves a multi-frame sealed note across, detects a replay, and proves a third
  device cannot open it
- rotates a passphrase and re-opens the vault
- connects both devices to the beacon, founds a room, adds the second device
  over the pair channel, exchanges messages, checks the shield blur is applied
- shares a location once and reads it back with bearing on the other device
- joins a real webrtc call from both devices and waits for `connected`
- sends a message containing markup and proves it renders as text
- opens a direct chat from the devices list, messages both ways, and connects a
  one-to-one call
- sends a photo (re-encoded, bounded, shielded on arrival), a 700 kb file in
  nine sealed parts (checked byte for byte by hash) and a recorded voice clip
- locks and unlocks with the on-page keyboard, and checks the layout shuffles
- proves an invitation waits for consent: the invitee joins, the founder sees it
- pairs a third device with a member, has the member propose it, the founder
  approve it, the newcomer receive an introduction and an invitation, join,
  and be heard by everyone
- drops the channel between two members on both sides, asks to message
  through the room, accepts, and proves a direct chat works on the derived key;
  then proves a side that still holds a channel answers a request at once
- counts unread while a member is away and clears it on opening
- removes a member, rotates the key, and proves the removed member sees nothing new
- hands the room to the third device, has it rotate the key and then dissolve
  the room, and proves every member saw each step
- asserts that no request ever left the origin

```
cd beacon && npm install && cd ..
node web/tests/e2e.mjs
```

`sweep.mjs` is the broad pass: it opens every screen on a phone and on a
desktop and presses every control once (menu, scroll-spy, footer, every route,
notes create/edit/delete, the pairing screen with bad and own codes, transfer
with a bad code, founding and leaving a room, the people and where sheets, a
call started and left, every privacy control, the beacon against a bad address
and then the local hub, theme, auto-lock, passphrase change, export, import of
that export with the type-to-confirm gate, install sheet, erase cancelled,
lock and unlock). it fails on any page error, console error, failed or 4xx
same-origin request, unexpected browser dialog, or a screen without its
heading, and reports every problem from one run.

```
node web/tests/sweep.mjs
```

`perf.mjs` measures what a person feels and holds it to a budget: bytes and
requests on a cold landing load, first and largest paint, load from the
offline cache, the share of the still frame rate kept while the sky moves and
while a section is read, key derivation and unlock (also under a 4x cpu
throttle), route switches, idle main-thread cost, pairing, beacon connection,
message latency between two devices through the relay (first, median, p95),
hold-to-reveal latency, a photo and a 700 kb file end to end, and call setup.

```
node web/tests/perf.mjs
```

all three need the `playwright` package (a global install is found automatically)
and a chromium it can launch. screenshots land in `web/tests/shots/` (ignored
by git).
