# gabriel security audit

date: 2026-09-27 · tree: `5e9287f` (bitchat upstream at fork time) · scope: the whole repository, read statically

this document answers three questions the owner asked, then lists every finding with the evidence behind it. every line is one of: **fact** (read in the code, path and line given), **inference** (reasoning about runtime behaviour that the code supports but this environment could not execute), or **not verified** (would need a device, a radio capture or an apple toolchain). confidence numbers use the scale 0.00–0.40 weak, 0.41–0.70 plausible, 0.71–0.90 strong, 0.91–1.00 structurally determined.

what this environment could and could not do: full source read of ~157k lines of swift across four parallel passes (cryptography and key storage; bluetooth transport; internet, tor and supply chain; application layer), with every claimed defect re-read at its cited line by a second pass. one defect was reproduced by simulating the code's arithmetic. nothing was compiled or run: there is no apple toolchain or bluetooth radio here. the swift changes in this branch are therefore written, reasoned, mirrored in a simulation and covered by new tests, but **not yet compiled**; run `swift test` on a mac before merging.

---

## 1. the three questions

### can outsiders read or intercept communications, whether or not the app is in use?

**private messages: no, with one repair now applied and two bounded exceptions that were already documented.**

- fact: live sessions use `Noise_XX_25519_ChaChaPoly_SHA256` with mutual authentication and forward secrecy (`bitchat/Noise/NoiseProtocol.swift:110-118`, patterns `:905-930`). relays and couriers carry ciphertext only. identity keys live in the keychain as `AfterFirstUnlockThisDeviceOnly`, non-synchronizable, so they never enter icloud keychain or a device transfer (`bitchat/Services/KeychainManager.swift:116, 421`).
- fact, **fixed in this branch**: the transport replay window was mis-shifted, so the seven most recently received nonces stayed replayable after every advance that was not a multiple of eight (`NoiseProtocol.swift`, old lines 169-206; reproduced by simulation: after receiving 0…20, replays of 13–19 were accepted). this is an integrity guarantee that did not hold, not a confidentiality break: an in-range attacker could re-inject a captured ciphertext once, within the window, more than five minutes after capture. see §2 F1.
- documented exceptions, unchanged: courier envelopes and nostr private envelopes are sealed to a static key with no forward secrecy (`WHITEPAPER.md` §5.2–5.3). compromise of the recipient's long-term key exposes undelivered mail sealed to it. prekeys now exist for courier mail (`bitchat/Services/NoiseEncryptionService.swift:480-536`), which narrows the exposure to the 48-hour post-use grace window (§2 F5).

**public traffic and metadata: yes, by design, and the project says so.** public mesh messages, nicknames, static public keys and up to ten neighbour ids are broadcast in the clear (`bitchat/Protocols/Packets.swift:242-286`), the peer id is stable across sessions (`bitchat/Protocols/BitchatProtocol.swift:47-49`) and the service uuid is fixed (`bitchat/Services/BLE/BLEService.swift:187-191`). `WHITEPAPER.md` §8 and `docs/PEER-ID-ROTATION.md` describe this accurately. a passive listener in radio range can tell the app is running, follow a device across places and reconstruct who stood near whom. the rotation design that closes this is implemented as a library and test vectors but not wired in (`BLEService.swift:5986-5993` parses and ignores it). this is the largest open privacy gap and it needs the android maintainers too.

**when the app is not in use:** the radio is off when the app is not running; ios background modes keep bluetooth alive only while the app is backgrounded (`bitchat/Info.plist:50-54`). there is no persistent daemon, push server or account, so there is nothing to intercept while the app is closed. data at rest is covered in §2 (app layer F2, F7).

### are there backdoors, hidden commands or remote-control paths?

**none found.** confidence 0.86 (strong; static analysis of every executable path, but a compiled binary was not diffed against source).

- fact: the only slash commands are `/m /msg /w /who /clear /hug /slap /block /unblock /group /fav /unfav /ping /trace /pay /drop /help` (`bitchat/Services/CommandProcessor.swift:120-158`), all mapped to visible ui features. received messages are never fed to the command processor (`bitchat/ViewModels/ChatOutgoingCoordinator.swift:100-104`).
- fact: greps across the app, share extension and local packages for urls, 64-hex keys, npub/nsec, base64 blobs ≥48 chars, "backdoor|kill switch|god mode|master key|admin key|remote config|feature flag", dynamic execution (`NSClassFromString`, `dlopen`, `JSContext`, `Process`, `performSelector`) and special-cased peer ids returned nothing beyond `NSClassFromString("XCTestCase")` for test detection and a user-facing location-notes toggle comment.
- fact: the only remote-influenced behaviour is the relay directory refresh from the upstream github repository (§2 network F1). it can steer which nostr relays carry geohash traffic; it cannot read private content or change code.
- fact: no analytics, crash reporting, update check, url preview or remote image loading exists. both `PrivacyInfo.xcprivacy` files declare no tracking and no collected data. the xcode project has no shell-script build phases (`project.pbxproj`, `ENABLE_USER_SCRIPT_SANDBOXING = YES`).
- fact: the vendored tor library's three static archives hash to the values in `docs/ARTI-BINARY-PROVENANCE.md` (recomputed here). its lockfile pins 464 crates.io entries with checksums and it exports exactly the seven documented ffi functions. **not verified:** the reproducible-build claim itself; a second party should rebuild on a mac and compare.
- fact: all `_test_*` hooks and the in-memory test keychain are `#if DEBUG` (`BLEService.swift:3051-3414`, `KeychainManager.swift:74-77`). one softness: `CI` / `GITHUB_ACTIONS` environment variables are treated as "under test" in release builds and silence notifications and some persistence (§2 app F9). not attacker-reachable on ios; worth gating anyway.

### how strong is the encryption, and where are the flaws?

primitives are right and well used: curve25519, chacha20-poly1305, sha-256 hkdf, ed25519 signatures, cryptokit csprng; secp256k1 schnorr and xchacha20-poly1305 for the nostr path (the hchacha20 derivation was checked against the draft and is correct, `bitchat/Nostr/XChaCha20Poly1305Compat.swift:71-104`). the weaknesses are in the protocol logic around them, listed in §2: the replay window (fixed), a global handshake rate limit a spoofer can exhaust, an unauthenticated message-1 that demotes a working session, prekey grace semantics, missing padding on the nostr envelope, and a 64-bit truncated identity binding at handshake completion.

---

## 2. findings

status legend: **fixed** (changed in this branch, tests added, not compiled here) · **proposed** (exact change written below, not applied because it touches the 7,000-line ble engine and cannot be exercised without the suite) · **documented** (design property; decision belongs to maintainers).

### 2.1 cryptography and key storage

| id | sev | finding | evidence | status |
|---|---|---|---|---|
| F1 | high | replay window shifted the wrong way; last 7 nonces replayable | `NoiseProtocol.swift` old 169-206; simulation confirms | **fixed**: `[UInt64]` bitmap shifted toward older offsets; regression test `cipherStateRejectsReplayAtEveryWindowOffset` covers offsets 1…1023 and reordering |
| F2 | medium | one global handshake budget (30/min) shared by inbound and outbound, charged before validation; 30 spoofed 32-byte packets a minute block every handshake including our own | `NoiseRateLimiter.swift:28-33`, `NoiseSecurityConstants.swift:71-76`, `NoiseEncryptionService.swift:833, 708-782` | proposed: split budgets; charge inbound only after message 1 parses; key on physical link as well as claimed id |
| F3 | medium | any 32-byte packet claiming an established peer's id parks that session receive-only for up to 20 s, then forces a re-handshake; ~25 % outbound downtime per victim pair at one packet per 80 s | `NoiseSessionManager.swift:555-560, 636-660`, `NoiseSecurityConstants.swift:41-62` | documented: deliberate trade-off (a reconnecting peer must replace stale keys). alternative: run the candidate responder in parallel and promote on authenticated message 3 |
| F4 | low | explicit consent path sends private media unencrypted to "legacy" peers; a never-seen peer can always claim to be legacy | `BLEService.swift:1789-1845`, gating `:1195-1225` | documented: bounded by consent ui and capability pin; set a sunset |
| F5 | low | one-time prekeys accept *new* ciphertexts for 48 h after first use | `LocalPrekeyStore.swift:97-108, 121-131` (acknowledged `:22-30`) | proposed: keep `sha256(ciphertext)` of accepted envelopes and accept only exact redeliveries in grace |
| F6 | low | nostr private envelope: no padding (length leaks), hkdf with empty salt, no aad over version/recipient | `NostrProtocol.swift:589-627, 911-918` | proposed: power-of-two padding, aad = version ‖ recipient pubkey; needs a version bump for android interop |
| F7 | low | handshake completion binds `sha256(static)[0..8]` to the claimed id; trust decisions use the full fingerprint | `PeerID.swift:132-134`, `NoiseSessionManager.swift:1130-1142`, `NoiseEncryptionService.swift:1010-1030` | documented: 2^64 second-preimage margin; note the assumption |
| F8 | info | no hchacha20 known-answer test; replay tests covered only offsets 0 and ≥1024 | `XChaCha20Poly1305CompatTests.swift`; `NoiseCoverageTests.swift:65-96` | partly fixed (replay test added); kat still to add |
| F9 | info | documentation drift: `BRING_THE_NOISE.md` describes rekey at 1 h/10k messages, `NoiseChannelEncryption`, peer-id rotation and `versionHello = 0x20`; actual rekey is 24 h/1e9 at 90 % and 0x20 is `noiseEncrypted`; whitepaper calls prekeys future work though implemented | `NoiseSecurityConstants.swift:65-68`, `NoiseEncryptionService.swift:480-536` | proposed: refresh both documents |
| F10 | info | on any keychain read failure the service silently runs with a fresh identity; peers who pinned the old key then reject the new announces as impersonation | `NoiseEncryptionService.swift:265-282`, `SecureIdentityStateManager.swift:378-383` | proposed: fail closed (no mesh until keychain readable) |
| F11 | info | groups: random-nonce chachapoly under a long-lived epoch key, creator-only rotation, no in-epoch forward secrecy or post-compromise security, no per-message replay dedup beyond the 5-minute ble seen-set | `GroupProtocol.swift:494`, `ChatGroupCoordinator.swift:198, 274, 398-437` | documented |

checked and sound: hkdf/mixkey/split per the noise spec; separate send/receive ciphers with fresh objects on rekey; decrypt failures leave nonce state untouched; announce signatures cover peer id, both public keys, nickname and timestamp with a context string; trust-on-first-use pinning of signing keys with a persisted cache; crossed-handshake tie-break by lexical id with one-time claim tokens; qr verification challenges over the live session; vouches bound to session and expiry; padding of noise frames to 256/512/1024/2048 buckets (frames needing >255 pad bytes go unpadded, as the whitepaper says); panic wipe reaches every keychain service, identity cache, favorites, outbox, courier and bridge stores, gossip archive, prekeys, group keys, boards, location state, nostr identity, sessions, media and snapshots.

### 2.2 bluetooth mesh transport

| id | sev | finding | evidence | status |
|---|---|---|---|---|
| A1 | high | an **unsigned** announce with ttl 7 binds an unbound link to any claimed peer id before signature verification, and `bindPeripheral` unconditionally makes that link the victim's preferred one. directed sends to the victim then go to the attacker's link (black hole), and on the victim's next verified announce the redundant-link policy keeps the newest connection and cancels the victim's real one. confidentiality is unaffected (noise); availability is | `BLEService.swift:5857-5871` (comment admits the ordering), `BLELinkBindings.swift:87-97`, `BLEFanoutSelector.swift:112-137`, `BLEService.swift:6326-6350`, `BLERedundantLinkPolicy.swift:71-108`; containment rule at `BLEService.swift:6209-6212` applies only to verified rebinds | **proposed** (below) |
| A2 | medium-high | relay amplification: directed `noiseEncrypted`, `courierEnvelope`, `ping`, `pong`, `nostrCarrier` and handshakes relay unconditionally with no per-ingress-link budget; dedup keys on payload digest so varying payload defeats it. ping budget is keyed on the claimed sender, so an unbound link rotating sender ids gets unlimited pongs flooded at ttl 7 | `RelayController.swift:40-48`, `BLEService.swift:6076-6101, 6031-6035, 3855-3863`, `BLEIngressLinkRegistry.swift:365`, `BLEMeshPingTracker.swift:596` | proposed: token bucket per `BLEIngressLinkID` (packets/s and bytes/s), refuse pings on unbound links, ttl ≤5 for unsigned directed types |
| A3 | medium | fragment reassembly expired on **start** time, not last progress: a 512 kib transfer (~1,100 fragments at 25-30 ms) already exceeds the 30 s lifetime on the sender alone, so multi-hop media was silently capped; plus unauthenticated eviction of the oldest assembly at 128 in flight, no per-sender cap | `BLEFragmentAssemblyBuffer.swift:80-91, 149-153`, `TransportConfig.swift:9, 181, 197-198` | **fixed** (expiry): idle-based with a 300 s absolute bound; test `removeExpiredKeepsAssembliesThatAreStillReceivingFragments`. proposed: per-sender cap of 4 and a global byte budget |
| A4 | medium | gossip-sync amplification: any self-signed identity is "verified" enough to request sync; 8 responses/30 s per peer, each up to ~40 mb; rotating identities resets the budget. responses are ttl 0 so the cost is the responder's radio and battery | `BLEService.swift:6623-6651`, `BLEPeerRegistry.swift:224-236`, `GossipSyncManager.swift:88-96, 475-560`, `TransportConfig.swift:400-401` | proposed: per-link byte budget; require a noise-authenticated link for file and fragment replay |
| A5 | medium | first-contact identity spoof: announce signature is checked with the key inside the same announce; a device that never met v accepts an attacker presenting v's peer id and noise key with their own signing key and nickname. dms stay safe (`canDeliverSecurely`); presence and nickname are forgeable until first handshake | `BLEAnnounceHandlingPolicy.swift:376-418`, `BLEService.swift:1119-1130` | documented (design); proposed: mark never-handshaked peers visually |
| A6 | medium | passive-sniffer exposure: stable peer id, fixed uuid, cleartext keys/nickname/neighbours every 4–30 s, only noise types padded, voice cadence reveals who talks and for how long | `Packets.swift:242-286`, `TransportConfig.swift:199-205`, `BLEOutboundPacketPolicy.swift:367-385` | documented; the fix is `docs/PEER-ID-ROTATION.md`, cross-platform |
| A7 | low | three tlv decoders index `data[offset]` from 0 rather than `startIndex`; safe today because every caller re-bases the slice | `Packets.swift:300-307, 401-407, 470-478` | proposed: `startIndex`-relative indexing |
| A8 | low | `m4a/aac` magic check is "longer than 100 bytes"; `octet-stream` skips validation; untrusted aac decoded in-process by avfoundation | `MimeType.swift:138-146`, `PTTAudioCodec.swift:98-135` | proposed: sniff the `ftyp` box |
| A9 | info | in-band `[FAVORITED]:<npub>` inside a private message reveals your nostr key to favourites | `BLEService.swift:2640-2656` | by design; tell users |

checked and sound: binary framing with bounds checks, per-type payload caps and a 1032× deflate ratio cap (`BinaryProtocol.swift:270-420`); fragment header limits; every tlv decoder length-guarded; noise identity binding at handshake completion; courier handover requires the noise session to have completed on the current ingress link; signature gates on message, voice, file, board, prekey and courier deposit; request-sync ttl 0 and never relayed; bounded early-ciphertext buffer; media store sanitised names, traversal guard, symlink skip, 100 mb quota, 7-day retention.

**proposed patch for A1** (not applied; needs the ble suite on a mac):

1. in `attributeAndHandlePacket` (`BLEService.swift:5857`), keep the raw bind for split-horizon attribution but stop it from taking over a peer that already owns a live link: before binding, `guard linkBindings.links(to: claimedSenderID).isEmpty else { attribute without binding }`. this is the same rule the verified path enforces at `:6209`.
2. add a `promoteToPreferred: Bool` parameter to `BLELinkBindings.bindPeripheral` and pass `false` from the raw path, so an unverified bind can add a secondary link but never replace `preferredPeripheral`.
3. in `retireRedundantPeripheralLinks` prefer the ingress link of the verified announce over "newest connection" when the two disagree, so a verified announce from v on v's real link never cancels that link.
4. test: two peripheral links, victim bound and preferred on link 1, raw announce for victim's id on link 2 → link 1 stays preferred; verified announce on link 1 → link 2 retired, not link 1.

the dual-link field case (one phone connected in both roles, or a restored stale connection) is why step 1 alone is not enough: an unbound duplicate would never be consolidated. steps 2–3 keep consolidation working while removing the takeover.

### 2.3 internet, tor, location, supply chain

| id | sev | finding | evidence | status |
|---|---|---|---|---|
| N1 | medium | relay directory refreshes from the **upstream** repository's `main` over https every 24 h; anyone who can push there steers which relays carry geohash, notes, bridge and courier traffic. validation is strict (wss only, ≥50 entries, ≥50 % overlap) but overlap is against the *last accepted* set, so a full replacement can be ratcheted in over a few days | `GeoRelayDirectory.swift:73, 442-513, 572-611` | proposed: sign the csv (ed25519 detached signature verified in `validatedEntries`), overlap against the bundled baseline, host under an address you control |
| N2 | medium | raw coordinates (10 m accuracy while live) go to apple's reverse geocoder on **every** location update; this is a system service tor cannot cover | `LocationStateManager.swift:406-410, 295, 533, 571` | proposed: geocode the geohash cell centre at the coarsest useful level, once per cell change, or make place labels opt-in |
| N3 | low-medium | no tor stream isolation: all relay connections likely share circuits, letting one exit correlate "geohash x" with "dm pubkey y". socks shim also accepts ip-literal targets, so a client-side dns resolution would leak and still connect | `localPackages/Arti/arti-bitchat/src/socks.rs:146, 86-93, 47-58` | proposed: per-destination isolation token; reject `ATYP_IPV4/6` for non-loopback; **not verified**: needs a packet capture on a device |
| N4 | low | cashu bearer token opened in the system browser at `redeem.cashu.me` when no wallet handles it | `PaymentChipView.swift:60, 190-213` | proposed: confirm before web fallback |
| N5 | low | gift-wrap timestamp jitter is symmetric ±15 min; nip-59 recommends past-only, and future skew is a weak fingerprint | `NostrProtocol.swift:748-752` | proposed |
| N6 | low | a few github actions tag-pinned rather than sha-pinned in read-only jobs | `.github/workflows/*.yml` | proposed |

checked and sound: fail-closed tor gating (sends, connects and the directory fetch wait for tor and drop rather than fall back to clearnet, `NostrRelayManager.swift:549-559, 904-969`, `GeoRelayDirectory.swift:87-90`); tor default-on with a compile-time enforcement flag absent from every build config; activation gate keeps a mesh-only user fully offline (no tor bootstrap, no sockets, no fetch); schnorr verification before dedup; strict gift-wrap → seal → rumor binding; relay-injected events cannot impersonate mesh peers (namespaced ids); pow never grants trust; single pinned swiftpm dependency; ci write scopes minimal and pr-only; no build-phase scripts; share extension limited to app-group userdefaults with size and control-character checks.

### 2.4 application layer

| id | sev | finding | evidence | status |
|---|---|---|---|---|
| P1 | medium | peer nicknames are never validated on receive; nothing reserves `system`; action messages from any peer are rewritten to sender `system` (grey, unblockable); `isSentByCurrentUser` compares nicknames so a peer announcing your nickname loses block/mention actions and shows your delivery ui | `Packets.swift:117-118`, `ChatMessageFormatter.swift:53, 370`, `ChatPrivateConversationCoordinator.swift:823-835`, `ConversationUIModel.swift:154-156`, `MessageListView.swift:121` | proposed: apply `InputValidator.validateNickname` in the announce decoder, reserve `system`, compare `senderPeerID`, strip `Cf` scalars |
| P2 | medium | nothing is excluded from icloud/finder backup: gossip archive, board posts, group rosters and media back up in plaintext; keychain items do not | no `isExcludedFromBackup` anywhere; `BLEIncomingFileStore.swift:764-772`, `GroupStore.swift:203-214`, `BoardStore.swift:363-374`, `GossipMessageArchive.swift:69-79` | proposed: set `isExcludedFromBackup` on the application-support subtrees |
| P3 | medium | received images fully decoded with `UIImage(contentsOfFile:)`; a 1 mib file encoding a 20k×20k canvas can jetsam the app on scroll | `BlockRevealImageView.swift:232-236`, `ImagePreviewView.swift:81-83`, `BLEFileTransferPolicy.swift:54-61` | proposed: `CGImageSourceCreateThumbnailAtIndex` with a max pixel size and a pre-decode dimension check |
| P4 | low | any data-detector link is tappable, including non-http schemes; `bitchat://geohash/<gh>` in a message switches the reader's location channel | `ChatMessageFormatter.swift:306-310`, `MessageListView.swift:283-293, 585-589` | proposed: allow-list http/https and payment schemes; confirm channel switches |
| P5 | low | wire-supplied `mentions` trusted for highlight and alert | `ChatPublicConversationCoordinator.swift:523-527` | proposed: intersect with a re-parse of content |
| P6 | low | panic wipe leaves delivered notifications and the url cache | `ChatViewModel.swift:1557-1780` | proposed: `removeAllDeliveredNotifications()`, `URLCache.shared.removeAllCachedResponses()` |
| P7 | low | clipboard writes without `.localOnly` or expiry (universal clipboard) | `MessageListView.swift:148-152`, `FingerprintView.swift:146-183` | proposed |
| P8 | low | `CI`/`GITHUB_ACTIONS` env vars treated as test mode in release | `TestEnvironment.swift:17-24` | proposed: `#if DEBUG` |
| P9 | low | audio "magic" check is a size check; waveform decode loads the whole pcm stream | `MimeType.swift:143-146`, `Waveform.swift:64-71` | proposed |
| P10 | info | privacy cover ios-only; no screen-recording detection; no duress or decoy mode (deliberately, see `docs/privacy-assessment.md`) | `PrivacyScreen.swift:9` | documented |

checked and sound: messages live in memory only; drafts memory-only; favorites and group keys in keychain; boards re-verify signatures on load; exif/gps stripped by re-encoding at 448 px; file names sanitised; no `try!`/`as!`/`unsafeBitCast` on network data; all logging compiled out of release; regexes linear and skipped above 4,000 chars; notification previews hidden by default; panic wipe survives relaunch via durable markers.

---

## 3. bluetooth range and live voice reach

the physical constraint first: corebluetooth exposes no transmit power, no phy selection (no le coded / long range), no connection-interval control and no advertising interval. everything below is software, and most of it is about **how many hops a packet survives**, not how far one radio reaches.

| lever | today | change | expected effect | status |
|---|---|---|---|---|
| fragment lifetime | 30 s from first fragment (`TransportConfig.swift:181`) | expire on idle, 300 s absolute | multi-hop media above ~400 kib stops being silently dropped; this was the hard cap | **fixed** (A3) |
| voice fanout | live voice frames were subset like text (k ≈ log₂ degree) (`BLEFanoutSelector.swift`) | exempt `voiceFrame` from subsetting | fewer 64 ms holes at edge neighbours only this node reaches; cost is airtime in dense rooms, already bounded by the ttl clamp | **fixed**, test added |
| duplicate-cancel | a scheduled relay is cancelled on the first duplicate when >2 peers (`BLEReceivePipeline.swift:35-37`) | cancel after ≥2 duplicates, or never when this node has a neighbour absent from the duplicate senders' neighbour lists (`MeshTopologyTracker` already holds that data) | measurable edge coverage gain; +10–30 % airtime when dense | proposed |
| connection scheduler | 6 central links ranked by strongest rssi (`BLEConnectionScheduler.swift:283-292`), so nodes cluster locally | reserve 1–2 slots for bridging candidates: peers not in any connected neighbour's announced list, or weakest stable rssi; relax the isolated floor to −100 dbm immediately instead of after 30 s | the single biggest hop-count lever; weak links churn, mitigated by the existing cooldown | proposed |
| rssi-aware paths | `readRSSI()` never called; topology is bfs over announced neighbours with no link quality | sample rssi periodically, prefer the strongest duplicate link for directed sends, bias fanout toward weak-but-unique links ("farthest useful neighbour first") | better geographic progress per hop | proposed |
| ttl | 7 at origin, dense clamp 5 | do not raise unilaterally (android must match); make the dense clamp conditional on measured duplicate rate rather than degree | | proposed |
| directed spool | 60 s, only when zero links (`BLEOutboundLinkPlanner.swift:342-355`) | spool also when the peer is known but unreachable; re-flush on every new link | | proposed |
| voice packetisation | 1 frame per 288-byte noise packet, ~15 pkt/s, jitter 350 ms | pack up to 4 frames per 512-byte bucket (~4 pkt/s, +190 ms), jitter 500–600 ms when ≥2 hops | packet rate, not bitrate, is what multi-hop drops; fewer, larger packets survive better | proposed |
| background reach | backgrounded iphones advertise only in the overflow area (invisible to android) | raise wake-on-proximity reserve from 2 to 3 slots and the recent-peripheral cache from 16 to 32 (`TransportConfig.swift:341-344`) | | proposed |
| store-and-forward | gossip 6 h / 1000 packets; handover cooldown 10 min | 24 h public history, 2 min handover cooldown, small courier quota for non-favourites | delay-tolerant reach; grows A4 exposure, so land A4 first | proposed |

there is no voice/video *calling* in this codebase. what exists is live push-to-talk over the mesh (`docs/PUSH-TO-TALK-DESIGN.md`, `bitchat/Features/voice/`), which does relay multi-hop and is what the voice rows above address.

---

## 4. changes made in this branch

| file | change | verification |
|---|---|---|
| `bitchat/Noise/NoiseProtocol.swift` | replay window rewritten as 16 × `UInt64` shifted toward older offsets | algorithm mirrored in python: 0 replays accepted across sequential, strided, gapped and shuffled deliveries; offsets 1…1023 all rejected |
| `bitchatTests/Noise/NoiseCoverageTests.swift` | `cipherStateRejectsReplayAtEveryWindowOffset` | would have failed on the old code at offsets 1–7 |
| `bitchat/Services/BLE/BLEFragmentAssemblyBuffer.swift` | idle-based expiry with absolute bound; call site unchanged (default `maxAge` 300 s) | existing test `removeExpiredDropsOldAssemblies` still holds (start == last progress there) |
| `bitchatTests/Services/BLEFragmentAssemblyBufferTests.swift` | `removeExpiredKeepsAssembliesThatAreStillReceivingFragments` | |
| `bitchat/Services/BLE/BLEFanoutSelector.swift` | `voiceFrame` exempt from subset fanout | |
| `bitchatTests/Services/BLEFanoutSelectorTests.swift` | `voiceFramesFanOutToEveryNonIngressLink` | |

**none of the swift above has been compiled here.** run `swift test` (or the ios scheme) before merging; the changes are small and local, but that is a statement about their shape, not a test result.

---

## 5. confidence map

- private-message confidentiality against a radio-range attacker: 0.92 (structurally determined by noise xx; the only defect found was integrity, now fixed).
- no backdoor or remote control in source: 0.86 (every executable path read; binary-vs-source equivalence not checked).
- vendored tor binary matches its documented hashes: 0.95 (recomputed). that it was built from the stated source: 0.55 (single-host self-attestation).
- A1 link-takeover is exploitable as described: 0.80 (code path read end to end; not exercised on hardware).
- tor stream-isolation leak (N3): 0.55 (code strongly suggests it; needs a capture).
- range levers deliver the stated gains: 0.45–0.65 each (mechanism sound; magnitude depends on topology and android behaviour).

## 6. what would change these conclusions

a packet capture from a real device with tor on (N3); a compiled run of the new tests; a second-party rebuild of the arti xcframework; and a review of the android client, which shares the wire protocol and therefore every protocol-level finding above.
