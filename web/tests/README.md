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
- removes a member, rotates the key, and proves the removed member sees nothing new
- asserts that no request ever left the origin

```
cd beacon && npm install && cd ..
node web/tests/e2e.mjs
```

needs the `playwright` package (a global install is found automatically) and a
chromium it can launch. screenshots land in `web/tests/shots/` (ignored by git).
