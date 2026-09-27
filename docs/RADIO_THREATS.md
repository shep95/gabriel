# radio pickup: what an antenna can and cannot take from this software

the question behind this document: how do we stop someone with a bluetooth or radio receiver from intercepting messages and calls? the honest first line is that radio cannot be made unreceivable. every packet the phone transmits is in the air for anyone with the right chip, and bluetooth and wi-fi chips are cheap. what can be done, and what is done here, is to make sure that what they receive is useless, and to shrink what they can learn from the shape of it.

this is written for the two carriers in this repository: the bluetooth mesh in the native app, and the wi-fi hotspot plus beacon that the web console uses.

---

## 1. the bluetooth mesh (native app)

### what a passive receiver gets

- every packet in range, as bytes. this is physics, not a bug.
- **private messages, media, receipts:** ciphertext only. sessions are `Noise_XX_25519_ChaChaPoly_SHA256` (`bitchat/Noise/NoiseProtocol.swift:110`), mutually authenticated, with forward secrecy. a captured recording cannot be decrypted later even if a phone is seized afterwards, because the session keys are gone. this is the strongest guarantee in the system and the audit found it intact.
- **live voice (push to talk) in a private chat:** the same noise session. the frames are 288 bytes each at a steady cadence, so a listener learns *that* someone is talking and for how long, not what is said.
- **public chat, boards, public voice:** plaintext by design. anything sent to "everyone nearby" is for everyone nearby, including the antenna.
- **metadata:** the stable 8-byte peer id in every packet, the announce with nickname, both public keys and up to ten neighbour ids in the clear every 4 to 30 seconds, and the fixed service uuid. a listener can tell the app is running, recognise the same phone next week, and draw who stood near whom. this is documented in `WHITEPAPER.md` §8 and is the largest open item.

### what an active attacker (transmitting, in range) can do

- **replay a captured private packet:** was possible for the seven most recent nonces because of the window bug; fixed in this branch (`docs/audit/SECURITY_AUDIT.md` F1). after the fix, a replayed ciphertext is rejected.
- **impersonate a peer on first contact:** a device that has never met you accepts an announce carrying your peer id and noise key but the attacker's signing key. they can show up under your name in the peer list; they cannot read or send your private messages, because the noise handshake needs your static private key. verifying in person (qr) or favouriting after a real conversation pins the key and closes this.
- **steal a link:** an unsigned announce with ttl 7 makes a relay bind its connection to a victim's id before verifying anything, black-holing directed traffic and, on the next real announce, cancelling the victim's real link (audit A1, high). this is a denial of service, not interception. the patch is written in the audit; it needs the ble test suite on a mac before it lands.
- **exhaust the handshake budget:** thirty spoofed 32-byte packets a minute stop all new handshakes near the attacker (audit F2). again denial, not interception.
- **flood relays** to drain batteries (audit A2, A4). same class.

### what stops interception, in order of effect

1. **keep the noise layer as it is**, with the replay fix. nothing in radio range reads a private message.
2. **verify people in person** (qr) or through a vouch. that turns "some phone claiming to be ada" into "ada". the app already shows verification state; the roadmap asks for it on every message row.
3. **land the peer-id rotation design** (`docs/PEER-ID-ROTATION.md`). it moves the static keys inside the encrypted handshake and rotates the on-air id, so the antenna stops being able to follow a phone across days. it needs the android client in step.
4. **pad every packet type**, not only noise frames (`WHITEPAPER.md` §9), so message sizes stop leaking.
5. **land the link-binding and rate-limit patches** from the audit so an active attacker cannot silence a neighbourhood.

### what does not help, so it is not done

- **hiding the service uuid or hopping frequencies.** bluetooth le already hops across 37 channels; a sniffer with three dongles follows it anyway. rotating the uuid does not hide an open-source app from someone running the same code (`docs/SERVICE-UUID-DETECTABILITY.md`).
- **turning the radio power down.** ios does not expose it, and it would cut the mesh's reach for everyone while a directional antenna still hears you.
- **any "anti-sniffing" feature that claims to detect a passive receiver.** a passive receiver emits nothing. it cannot be detected.

---

## 2. the wi-fi hotspot and the beacon (web console)

the console uses no bluetooth. rooms and calls ride a local wi-fi network with a beacon on it. a radio listener here is someone with a wi-fi card in monitor mode.

### what they get, layer by layer

- **the wi-fi itself.** if the hotspot is open, every frame is readable at the 802.11 layer; if it has a wpa2/wpa3 password, frames are encrypted per client. **use a password on the hotspot.** it is the cheapest layer of protection and it also stops strangers from joining.
- **the beacon connection.** the console requires `wss://` to any address that is not the machine itself (`web/js/beacon.js`), so the websocket is tls under the beacon's certificate, which the phone trusted on the install page. a listener who broke the wi-fi key still sees tls.
- **inside tls, the beacon protocol.** random 64-hex tags, opaque strings, subscriber counts. the beacon operator, who is by definition on the wire, sees exactly this and nothing more. tags for pairs rotate daily; tags for rooms rotate with the room key.
- **the messages.** aes-256-gcm under the room's epoch key with the room id and epoch bound in, signed with the sender's ecdsa key. a captured frame cannot be decrypted, altered, re-targeted to another room, or replayed (message ids are remembered).
- **calls.** webrtc media is dtls-srtp between the two phones. the fingerprints that authenticate that dtls handshake travel *inside* the signed, encrypted room messages, so neither the beacon nor a wi-fi listener can substitute their own. audio and video never touch the beacon. with no stun or turn configured, no packet leaves the local network.

### what an active attacker on the same wi-fi can do

- join the beacon and subscribe to random tags: they get nothing unless they guess a 256-bit tag, and they cannot decrypt what they would get.
- flood the beacon: bounded per connection (30 publishes a second, 4 mib a minute, 64 tags) and globally (2000 connections). set a beacon password to keep them off entirely.
- run a second, fake beacon with the same name: phones only connect to the address they were given, over a certificate they installed. a fake beacon has neither.
- block phone-to-phone traffic (client isolation) so calls fail: chat still works through the beacon; the call panel says so.

### practices that matter more than any code

- put a password on the hotspot and on the beacon.
- install the beacon's certificate from its install page in person, once, and compare the fingerprint the page shows with the one printed in the beacon's terminal.
- pair devices in person and compare the six digits out loud. everything else builds on that.
- keep the shield on. the attacker most likely to read your messages is standing behind you.

---

## 3. one table

| threat | mesh (bluetooth) | console (wi-fi + beacon) |
|---|---|---|
| passive listener reads private messages | no (noise xx) | no (aes-gcm + tls + wpa) |
| passive listener reads calls | no (noise) | no (dtls-srtp) |
| passive listener learns who is present | yes, until id rotation lands | only that devices talk to a beacon; identities never appear on the wire |
| passive listener learns who talks to whom | partly (neighbour lists, timing) | subscriber counts per random tag; timing |
| active attacker impersonates you to strangers | until verified in person | no (membership is pairing) |
| active attacker replays a message | fixed in this branch | no (message ids) |
| active attacker silences the area | yes (A1, A2, F2; patches written) | flood, bounded; password stops it |
| operator of the infrastructure reads content | there is no operator | no |
