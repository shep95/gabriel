# gabriel console and beacon: security review

date: 2026-09-27 · scope: everything under `web/` (vendored libraries checked only for how they are called) and `beacon/`, plus `vercel.json` and `.vercelignore` · method: two independent adversarial passes (a line-by-line reviewer and the author's own pass), then fixes, then the end-to-end suite re-run in headless chromium.

status legend: **fixed** (in this branch, covered by the test where a test can reach it) · **mitigated** (reduced, residual stated) · **accepted** (design property, stated in the ui and readme).

## what the review attacked

the claims: local sign-in with a passphrase (pbkdf2-sha256 → aes-gcm wrap → per-record sealing in indexeddb); device pairing by code with a six-digit confirmation; sealed transfers over qr; end-to-end encrypted rooms and direct chats carried by an untrusted relay; webrtc calls signalled inside sealed messages; a service worker that refuses off-origin requests; the shield and sender-only notifications; opt-in location; a strict content security policy.

## findings

### high

| id | finding | status |
|---|---|---|
| H1 | **room takeover through an invite.** `acceptInvite` accepted an invite for a room id already known here and overwrote founder, key, tag and roster. any paired device that learned a room id could re-found it on your device, cutting you off from the real room and steering your messages to its own tag. | **fixed**: an existing room's founder is pinned; invites from anyone else for that id are ignored; epoch must be an integer in range and never lower than the current one; the key must be 32 bytes. |
| H2 | **html injection through message fields.** a room member's message id and location accuracy were interpolated into markup unescaped. the csp blocks script, but inline styles are allowed, so a member could draw fake bubbles attributed to others, fake "key rotated" lines, or a full-screen fake unlock prompt. | **fixed**: every interpolated value is escaped; message ids must be uuids and location fields finite numbers in range at receive time; room ids are validated before they reach an `href`. the test sends `<img onerror>` and asserts no element is created. |
| H3 | **call signalling not bound to its conversation.** while in a call in room a, a signed `call` message from room b (where an attacker is a legitimate member) reached the peer setup and had your microphone track added to a connection with them. | **fixed**: a signal is dropped unless it arrives in the conversation the call lives in, from someone other than yourself. |

### medium

| id | finding | status |
|---|---|---|
| M1 | **six digits did not cover the signing key.** the pairing digits derived from the ecdh shared secret and nonces only; an intermediary relaying codes as text could swap the signing key without changing the digits, then sign room messages as the victim once inside a room. | **fixed**: the key agreement salt now includes a hash of both complete invites (both public keys, nonces and names). a swapped byte changes the digits on one side. |
| M2 | **leaving a room did not rotate the key**, so a departed member kept reading until the founder pressed rotate. | **fixed**: the founder rotates automatically on receiving a `leave`. |
| M3 | **plaintext at rest**: settings (including a beacon password), the seen-message ledger and the message index were unsealed; the backup exported them raw. | **mitigated**: settings are now sealed under the vault key (older plaintext records migrate on unlock); seen keys are namespaced. still plaintext, by design and stated in the readme: profile name, public keys and fingerprint, the per-message room id used as an index, and the seen ledger (ids and receive times, no content). |
| M4 | **beacon memory and flooding**: replay buffers had no global byte cap; no per-address limits; password guessing unthrottled. | **fixed**: buffers share a 64 mib cap with least-recently-used eviction; 64 connections per address; five failed passwords a minute block that address at the upgrade for a minute. |
| M5 | **private root ca trusted system-wide** for ten years, no name constraints. | **mitigated**: validity cut to five years; the install page states plainly what trusting a root means and how to remove it. name constraints remain a follow-up: the certificate library in use does not emit them reliably, and browser support is uneven. |
| M6 | **reconnect crash**: a pending publish at disconnect threw inside the close handler, leaving the status stuck at "on" with no retry. a hostile beacon could trigger it by closing mid-send. | **fixed**. |
| M7 | **one bad invite silenced everything**: an unusable room key threw inside subscription refresh and aborted every other subscription. | **fixed**: keys validated before storage; each room's tag derivation is isolated. |

### low

| id | finding | status |
|---|---|---|
| L1 | names from other devices unbounded and unsanitised; a member could name itself `you`. | **fixed**: bidi, zero-width and control characters stripped, lengths bounded; your own messages are marked by colour as well as the word. |
| L2 | sender-controlled timestamps ordered history, pruning and "latest location". | **fixed**: ordering and pruning use receive time; a sender timestamp is shown only when within thirty days back and five minutes ahead. |
| L3 | history pruning decrypted every record on every message. | **fixed**: prunes in batches of fifty. |
| L4 | receive side accepted longer text and larger rosters than the send side. | **fixed**: send caps mirrored on receive. |
| L5 | lock left the last gps fix, a derived pair key, partial qr chunks and the compass listener alive; idle timer naive under background throttling. | **fixed**: all cleared on lock; the idle gap is re-measured when the tab returns to the foreground; a live call keeps the vault open. |
| L6 | idle lock ended an active call. | **fixed** (see L5). |
| L7 | notifications included the room name although the page promised sender only. | **fixed**: sender name only. |
| L8 | websocket hub has no origin check and is unauthenticated by default. | **accepted / mitigated**: any page can connect but learns nothing without a 256-bit tag; per-address caps added; the readme recommends a password. |
| L9 | shield is css-only: reader mode, accessibility tree, devtools and print expose text. | **accepted**, stated in the ui; print now hides shielded text. |
| L10 | service worker could cache redirected responses and the health endpoint. | **fixed**. |
| L11 | seen-ledger keys for rooms and devices shared one namespace. | **fixed**. |
| L12 | rosters had no sequence, so a reordering relay could replay an older roster. | **fixed**: rosters carry the founder's timestamp and older ones are ignored. |
| L13 | beacon http redirect echoes the host header. | **accepted**: characters restricted, node rejects line breaks; only a client that sets its own host header is redirected to it. |
| L14 | backup import accepted arbitrary records. | **mitigated**: records need a string id; settings are coerced to known types and ranges on load. the importer chose the file. |

### sound, checked

vault: pbkdf2-sha256 at 600 000 rounds with a random 16-byte salt, aes-gcm wrap with a random nonce, non-extractable wrapping key, a wrong passphrase yields only an authentication failure; per-record additional data of store and id prevents record swapping. pairing: compressed points validated on-curve before import. transfers: fresh salt and nonce per message, additional data binds sender to recipient, replay rejected by id. rooms: additional data binds room id and epoch so a frame cannot be replayed into another room or epoch; impersonation fails because the signature is checked against the key of the claimed sender; rosters and key updates are accepted only from the founder and only over the founder's pair channel. webrtc: no ice servers unless configured, so nothing leaves the local network; offers and candidates are accepted only from signed member frames inside the call's own conversation; tracks stop on teardown, page hide and lock. service worker: same-origin cache-first, off-origin refused except openstreetmap tile hosts, which pass through uncached. csp identical in the page and the vercel header: scripts from self only, no objects, no base, no forms, no framing. static server: normalised paths, dotfiles refused, prefix check with separator, tile coordinates bounded. certificates: leaf reissued on name change or expiry, files 0600 in a 0700 directory, tls 1.2 minimum. no localstorage, sessionstorage or cookies anywhere. beacon dependencies pinned with a lockfile.

## residual risks, in plain words

- a browser cannot stop the operating system from capturing the screen. the shield lowers the value of a capture; it does not prevent one.
- the beacon operator and anyone on the wi-fi see timing, sizes and how many devices listen to each random tag. they see no names, keys or content.
- the pair key and room epoch keys are long-lived until rotated; there is no per-message ratchet. a stolen unlocked device reads everything it holds.
- a trusted private root is powerful. install only a beacon run by someone you trust with that, and remove the certificate when the deployment ends.
- the vendored libraries (qr generator, qr decoder, leaflet, inter) are copied from their published packages; record their hashes if you need reproducibility beyond the git history.

## media, typing and capture (added with photos, clips and files)

**media.** a photo is re-encoded on the sending device before anything else happens: the jpeg that leaves carries no exif, so no camera model, no capture time and no gps, and it is bounded to about 350 kb. voice clips are recorded on the page (opus in webm, or aac in mp4 on safari) at 24 kbit/s, sixty seconds at most. any file up to 1.5 mb travels in sealed parts of 84 kb, each a normal room message (aes-256-gcm under the epoch key, ecdsa-signed) or a direct frame (aes-256-gcm under a key derived from the pair key with its own label and additional data, `gabriel/direct-frame/v1`). the receiver validates every part (ids, counts, sizes, alphabet, mime shape), keeps at most eight half-received items per conversation for ten minutes, and accepts the whole only when the joined bytes match the announced size. media is stored sealed like text and rendered from blob urls that are revoked when the timeline is repainted; the page's policy forbids scripts from fetching blobs, so a saved file goes through the browser's own download path. images and video arrive shielded (blurred until held). residual: the relay sees the number and size of frames, so it can tell a photo from a sentence; that is the same metadata it always had for text length.

**typing.** the composer and the notes editor set `spellcheck=false`, `autocomplete=off` and the grammarly opt-out attributes, so browsers with cloud spell-check enabled do not send drafts to a service. an on-page keyboard (`js/keypad.js`) is offered on the passphrase screens and, by a privacy switch, for every message and note: keys are drawn by the page and shuffled with `crypto.getRandomValues` on every opening, the field is made read-only with `inputmode=none` so the system keyboard stays down, and key presses insert directly into the field. this removes the system keyboard, third-party keyboard apps and input-method loggers from the path. it does nothing against a browser extension, a compromised browser or a screen recorder, and the privacy page says so in those words.

**capture.** a page cannot refuse a screenshot or a recording; the operating system decides. the shield bounds what a frame is worth: one message or photo at a time, only while held, for at most eight seconds; everything veiled when the page is not in front; no selection, copy or drag of shielded content. the ios native app additionally blanks itself while a recording or mirroring is active, which the browser cannot do.

## access to a room, and what an introduction is worth

a room is founded by one device. it fills three ways, each with a consent step: the founder adds a device they have paired with in person, and that device receives an invitation it must accept before it subscribes or reads anything; a member proposes a device they have paired with, the founder approves, and the newcomer receives the founder's public keys from the member who vouched for them, then the invitation from the founder; two members with no channel ask to message one to one, and the other side accepts. the second and third paths rest on an *introduction*: a pair key derived by ecdh of the two identity keys, salted with both fingerprints and labelled `gabriel/intro/v1`, on the word of the introducer (a paired device, or the room roster the founder signs). the device record is marked unverified with the introducer's name until the two devices compare digits in person, which replaces the key with a paired one. a dishonest introducer could substitute keys and stand in the middle of that one channel; they could not read the room, whose key travels only under keys the founder holds. handover, dissolution, proposals and requests are signed room messages accepted only from the roles they belong to (founder for roster, handover, dissolve, results; members for proposals and requests addressed to one fingerprint). a founder who leaves must hand over or dissolve, so no room is left without a key holder.

## verification

`node web/tests/e2e.mjs` passes end to end in headless chromium through the beacon's loopback dev server: profile creation, lock, offline reload, pairing with matching digits, multi-frame sealed transfer and replay detection, passphrase rotation, beacon connection, room founding and invitation over the pair channel, shielded rendering, markup escaping, location sharing with bearing, a peer-to-peer room call, a direct chat with a one-to-one call, key rotation after removal, a photo, a 700 kb file (nine parts, verified byte for byte by hash after a real save) and a recorded voice clip between two devices, an unlock typed on the shuffled on-page keyboard, a three-device run of consent, proposal and approval, introduction, message request, unread, handover and dissolution, and the assertion that no request left the origin. `node web/tests/sweep.mjs` presses every control on every screen at phone and desktop widths and fails on any error; `node web/tests/perf.mjs` holds load size, paint, key derivation, route switches, pairing, beacon connection, message latency, media transfer and call setup to budgets. the beacon's own suite (`npm test` in `beacon/`) passes its thirteen cases.
