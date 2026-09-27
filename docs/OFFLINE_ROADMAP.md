# what people without internet need from this software

a working list, organised by the situation the person is in rather than by feature area. every item names the code it would touch, so it can be argued with. items marked **exists** are already shipped and listed so the gaps read against what is there. the list is open-ended by design; add to it.

the constraint that shapes everything: **no server, no account, no cloud, no internet.** if an item quietly needs one of those it does not belong here.

---

## 1. the first ten minutes

what someone does the first time they open the app in a place with no signal.

- **exists:** open, get a nickname, see who is nearby, talk. no sign-up.
- know whether the radio is actually working. a single always-visible truth: scanning / advertising / n links / last packet heard n seconds ago (`bitchat/Views/Components/ConnectivityStatusBanner.swift`, `MeshRadarView.swift`). today the radar shows peers; it should also show *silence* honestly, so an empty room is not mistaken for a broken app.
- a one-screen explanation of what is public and what is private, in the app, at the moment it matters: the first public message and the first dm (`bitchat/Views/AppInfoView.swift` has the text; it needs to be a contextual first-use interstitial).
- a "range test": tap, and the nearest peer's phone chirps or vibrates and reports rssi and hop count back (`/ping` and `MeshPingTracker` already measure it; the ux is a command).
- pairing two devices you both hold: qr verification exists (`bitchat/Views/VerificationViews.swift`); the console in `web/` adds a code-only path for devices without cameras.

## 2. reaching someone who is not in range

- **exists:** multi-hop relay, courier envelopes carried by strangers, sender outbox, gossip-synced public history (`WHITEPAPER.md` §6).
- delivery visibility that tells the truth about the mesh: "handed to 2 couriers, last seen heading away 40 min ago" rather than a grey tick (`bitchat/Services/Courier/StoreAndForwardMetrics.swift` counts it; the message row does not show it).
- **scheduled and dead-drop messages:** write now, deliver when the recipient's announce is heard, with a "not before" and an "expires" (courier envelopes have ttl; a per-message do-not-deliver-before is missing).
- a **runner mode**: a person who volunteers to carry mail sees a queue, a rough map of who they are carrying for (by cell, never by identity) and how full the bag is (`CourierStore` quotas exist; no ui).
- **larger courier payloads** than 16 kib: a voice note or a photo of a document should be able to ride a person (`WHITEPAPER.md` §9 lists this; `CourierEnvelope` caps it).
- **relay through a fixed node:** any old phone plugged into a wall becomes a repeater. today it is just an app instance; it needs a "repeater" preference that disables the ui, keeps the radio hot, never duty-cycles, and stays on screen-off (`BLEScanDutyPolicy.swift`, background modes in `Info.plist`).
- **long-range bridges without internet:** two repeaters joined by lora or a serial cable are a different transport, not a different app. the `Transport` protocol (`bitchat/Services/Transport.swift`) is the seam; a `SerialTransport` speaking the same packet format is the smallest step.
- hop-aware voice: pack more frames per packet and lengthen the jitter buffer when the peer is ≥2 hops away (`TransportConfig.swift` ptt constants; `ChatLiveVoiceCoordinator.swift`).

## 3. groups of people who need to coordinate

- **exists:** groups with rotating epoch keys, public boards with expiry, urgent board posts with extra ttl (`bitchat/Services/Groups/`, `bitchat/Services/Board/`).
- **roles inside a group** without a server: who can rotate keys, who can post announcements. today only the creator rotates (`ChatGroupCoordinator.swift:198`); a second admin means nothing breaks when the creator's phone dies.
- **check-in / roll call:** one tap sends "i am ok" to a group; the group view shows who has and has not answered, with time since. it is a typed noise payload plus a small ui, no new transport.
- **shared lists** that merge without conflict: supplies, tasks, names. a grow-only set with tombstones (the board store already has tombstones, `BoardPackets.swift`) replicated by gossip is enough; no crdt library needed.
- **polls and quick votes** on a board post, tallied locally from signed replies.
- **meeting point** messages: a geohash plus a time, rendered as a pin on an offline map tile if one is cached, otherwise as text with a compass bearing from the device's own fix (location code in `LocationStateManager.swift` never leaves the device).
- **handoff of a role or a channel** to another person when you leave, by scanning them.

## 4. staying alive on a dying battery

- **exists:** adaptive duty cycling, rssi gating, fanout subsetting (`BLEScanDutyPolicy.swift`, `BLEFanoutSelector.swift`).
- a visible **battery budget**: "at this rate the radio lasts 9 h". the app knows its duty cycle and the os reports battery level; nobody has multiplied them.
- **low-power posture** the user chooses, not the app guesses: receive-only (no relaying), announce every 60 s, no gossip sync. each is a constant in `TransportConfig.swift` today.
- **wake on keyword**: relay nothing, decrypt nothing, but light up when a signed board post carries a chosen tag (urgent, water, medic).
- honest **airtime accounting**: bytes relayed for others vs bytes for me, per day, so a person can decide how much of their battery is a public good.

## 5. information that has to arrive without a network

- **offline bulletins** with authorship that can be checked: a board post signed by a key people already verified in person is a bulletin; render verification state on the post (`BoardStore` re-verifies signatures on load; the ui does not surface who signed).
- **static content packs** distributed over the mesh: first-aid pages, maps of the area, a phrasebook, water-purification instructions. it is a file transfer with a manifest and a "seed this to anyone who asks" flag (`BLEFileTransferHandler.swift`, `GossipSyncManager` keeps fragments 15 min; packs need a longer, opt-in retention class).
- **offline map tiles** for the current geohash, cached while online and served over the mesh to neighbours who never were.
- a **read-only public archive mode** for people who only want to listen: no announces, no nickname, no radio identity of their own (this conflicts with how presence works today; it is a design decision, not a toggle).
- **broadcast from an authority key** the community chose (a clinic, a shelter): a pinned key whose posts sort to the top. distribution of that key is in person, by qr.

## 6. safety when the phone is taken

- **exists:** panic wipe, hidden notification previews, app-switcher cover, device-only keychain (`docs/privacy-assessment.md`).
- an **app-level lock** separate from the device passcode, with a short auto-lock. `docs/privacy-assessment.md` explains why a duress mode is a policy decision; a plain lock is not controversial and is missing.
- **decoy or minimal profile** on a second passphrase is the contested one; write the decision down either way.
- **wipe on n failed unlocks**, opt-in, with the same legal caveat.
- **remote wipe by a paired device**: a signed "burn" message from a device you verified in person, delivered over the mesh, wipes this one. the courier path already carries signed, sealed messages to a static key.
- **backup exclusion** for everything under application support (finding P2 in the audit), so a seized icloud account is not a seized mesh history.
- **what a locked phone still says** should be listed in the app, in one screen, in plain words.

## 7. trust between strangers

- **exists:** tofu pinning, qr verification, vouches from verified peers (`VouchAttestation.swift`).
- a **trust view**: for each peer, how you know them: verified in person, vouched by whom, or merely seen. render it on every message row, not only in the peer sheet.
- **nickname collision handling** made visible (the `#xxxx` suffix exists; the impersonation cases in audit finding P1 need the display rule fixed first).
- **web of introductions**: "alice, whom i verified, verified bob" shown as a path, with the whole path checkable offline.
- **revocation** of a vouch or a verification, propagated the same way it was given.

## 8. the mesh itself, as infrastructure

- **repeater mode** (above) and a **mesh health board**: how many nodes heard in the last hour, median hop count, duplicate rate, per cell. every input already exists in `MeshTopologyTracker` and the dedup stats.
- **rotating on-air identity** (`docs/PEER-ID-ROTATION.md`): implemented as a library, not wired in, needs android. it is the one change that turns "a phone running this app was here" into "some phone was here".
- **padding for non-noise packet types** and closing the >255-byte pad gap (`WHITEPAPER.md` §9).
- **link-quality-aware routing** with `readRSSI()` (audit §3).
- **per-link rate limits** so one hostile phone cannot make everyone else's battery pay (audit A2, A4).
- **cross-platform test vectors** for every wire format, published in the repo, so android and ios stop drifting (courier vectors exist in `docs/courier-test-vectors.json`; announces, voice frames and boards do not).

## 9. accessibility and people who are not power users

- **large-type and high-contrast mode** that keeps the terminal aesthetic legible outdoors in sunlight; today the palette is tuned for dark rooms.
- **voice-first**: hold to talk exists; hold to *send a text by dictation* and have messages read out is missing, and it is the difference for people who cannot read the script on screen.
- **language packs offline**: `Localizable.xcstrings` ships with the app; community-supplied translations should be loadable as a file, not a release.
- **one-handed and glove-friendly** targets on the composer and the mic button.
- **no-camera pairing** (the console's code path) and **no-screen pairing** for a repeater box: a printed code on the box.

## 10. keeping what matters when the phone dies

- **encrypted export of the things that are not messages**: verified contacts, group keys, board bookmarks. today a lost phone means re-verifying everyone in person (`FavoritesPersistenceService` is keychain-only, so it does not travel).
- **device-to-device migration** by code, offline: the console in `web/` demonstrates the pairing and sealed transfer; the app needs the same for its identity, with the explicit warning that a copied identity is two devices claiming one peer id (audit F7 and `PEER-ID-ROTATION.md` §3 explain why that is dangerous today).
- **paper backup** of the identity key as words, for people who will never have a second device.

## 11. things that look small and are not

- a **clock the mesh agrees on**. packets carry timestamps and freshness windows (`TransportConfig.swift` skew 120 s); phones with dead batteries come back with wrong clocks and get ignored. a signed time hint from a trusted peer, applied as an offset, keeps them in the mesh.
- **message expiry the sender controls**, honoured by receivers that are honest, and labelled as such.
- **draft survival** across kills (`ComposerDraftStore` is memory-only by policy; sealed drafts under the outbox key would keep the policy and the text).
- **"who heard this"** for public posts, counted from relay acks, so a bulletin author knows whether it went anywhere.
- **a way to say "i am leaving the area"** so couriers stop waiting for you.

## 12. what the console (`web/`) is for, and is not

it is the part of this that works on any device with a browser and no app store: local sign-in, sealed notes, pairing by code, encrypted hand-off over a screen, and, through a beacon on the local wi-fi, end-to-end encrypted rooms and peer-to-peer calls with no internet. it cannot reach the bluetooth mesh from a browser, and it does not pretend to. the seam for later is a shared pairing format between the app and the console, so a phone running the app and a laptop running the console can be paired with the same six digits, and a beacon that also speaks the mesh packet format over a radio it owns.

---

things deliberately not on this list: anything that phones home, anything that needs an account, hiding *that* the app is in use (see `docs/SERVICE-UUID-DETECTABILITY.md` for why that is not achievable for an open app), and internet-only conveniences.
