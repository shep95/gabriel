// group calls: a webrtc full mesh inside a room. signalling rides room
// messages, so offers, answers and ice candidates are encrypted and signed
// like any other message; the beacon cannot read a fingerprint out of an sdp.
// media is dtls-srtp between each pair, peer to peer on the local network.
//
// no stun or turn is used unless the person adds servers in settings, so the
// default leaks nothing and works on a hotspot with no uplink. some routers
// isolate clients from each other; then the call fails while chat still works,
// and the room shows that plainly.

import { state, emit, on } from './state.js';

const MAX_PARTICIPANTS = 8;

export const call = {
  roomId: null,          // the conversation this call belongs to (room id or dm id)
  send: null,            // (body) => Promise: seals and sends a call signal inside that conversation
  callId: null,
  local: null,          // MediaStream
  peers: new Map(),     // fp -> { pc, polite, makingOffer, ignoreOffer, stream, audio }
  muted: false,
  video: false,
  since: null,
  participants: new Set(),
};

function iceServers() {
  return (state.settings.iceServers || '').split('\n').map((s) => s.trim()).filter(Boolean).map((urls) => ({ urls }));
}

// signals leave in order: an ice candidate must never overtake the offer it belongs to
let sendChain = Promise.resolve();
function signal(op, extra = {}) {
  const send = call.send;
  const callId = call.callId;
  if (!send) return Promise.resolve();
  const p = sendChain.then(() => send({ op, callId, ...extra }));
  sendChain = p.catch(() => {});
  return p;
}
const CONNECT_TIMEOUT_MS = 25_000;
const MAX_RESTARTS = 2;
let joining = false;

// conv = { id, send }: a room or a direct chat; send seals a call body into it
export async function joinCall(conv, { video = false } = {}) {
  if (call.roomId || joining) throw new Error('already in a call');
  if (!conv || typeof conv.id !== 'string' || typeof conv.send !== 'function') throw new Error('nothing to call');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('this browser has no microphone access');
  joining = true;
  let local = null;
  try {
    local = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: video ? { width: { ideal: 640 }, facingMode: 'user' } : false });
    if (call.roomId) throw new Error('already in a call');
    call.local = local;
    call.video = video;
    call.roomId = conv.id;
    call.send = conv.send;
    call.callId = call.callId || Math.random().toString(16).slice(2, 10);
    call.since = Date.now();
    call.participants = new Set([state.identity.fingerprint]);
    emit('call:state', snapshot());
    await signal('join', { video });
  } catch (e) {
    // nothing may stay hot after a failed join: no microphone, no half state
    if (local) for (const t of local.getTracks()) t.stop();
    if (call.local === local) teardown();
    throw e;
  } finally { joining = false; }
}

export async function leaveCall() {
  if (!call.roomId) return;
  // tear down first, so nothing that arrives while the goodbye is in flight can rebuild a peer
  const bye = signal('leave').catch(() => {});
  teardown();
  await bye;
}

function teardown() {
  for (const [, p] of call.peers) closePeer(p);
  call.peers.clear();
  if (call.local) for (const t of call.local.getTracks()) t.stop();
  call.local = null;
  call.roomId = null; call.send = null; call.callId = null; call.since = null;
  call.participants = new Set();
  call.muted = false; call.video = false;
  emit('call:state', snapshot());
}

function closePeer(p) {
  clearTimeout(p.connectTimer); clearTimeout(p.disconnectTimer);
  try { p.pc.close(); } catch { /* already closed */ }
  if (p.audio) { p.audio.srcObject = null; p.audio.remove(); }
  if (p.videoEl) { p.videoEl.srcObject = null; p.videoEl.remove(); }
}
function dropPeer(fp) {
  const p = call.peers.get(fp);
  if (p) closePeer(p);
  call.peers.delete(fp);
  call.participants.delete(fp);
}

export function toggleMute() {
  if (!call.local) return;
  call.muted = !call.muted;
  for (const t of call.local.getAudioTracks()) t.enabled = !call.muted;
  emit('call:state', snapshot());
}

export async function toggleVideo() {
  if (!call.local) return;
  if (call.video) {
    for (const t of call.local.getVideoTracks()) { t.stop(); call.local.removeTrack(t); }
    // the sender stays and carries nothing, so turning the camera back on reuses it
    for (const [, p] of call.peers) for (const s of p.pc.getSenders()) if (s.track && s.track.kind === 'video') s.replaceTrack(null).catch(() => {});
    call.video = false;
    signal('video', { on: false }).catch(() => {});
  } else {
    const roomAtStart = call.roomId;
    const cam = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, facingMode: 'user' } });
    const track = cam.getVideoTracks()[0];
    if (!call.local || call.roomId !== roomAtStart) { track.stop(); return; } // the call ended during the prompt
    call.local.addTrack(track);
    for (const [, p] of call.peers) {
      const idle = p.pc.getSenders().find((s) => !s.track && s.kind === 'video') || p.pc.getSenders().find((s) => s.track === null && p.pc.getTransceivers().some((t) => t.sender === s && t.receiver.track && t.receiver.track.kind === 'video'));
      if (idle) idle.replaceTrack(track).catch(() => {}); else p.pc.addTrack(track, call.local);
    }
    call.video = true;
    signal('video', { on: true }).catch(() => {});
  }
  emit('call:state', snapshot());
}

export function snapshot() {
  return {
    active: !!call.roomId,
    roomId: call.roomId,
    muted: call.muted,
    video: call.video,
    since: call.since,
    peers: Array.from(call.peers.entries()).map(([fp, p]) => ({ fp, state: p.pc.connectionState, hasVideo: !!p.videoEl })),
    participants: Array.from(call.participants),
  };
}

// perfect negotiation, per pair: the lexically smaller fingerprint is polite.
function ensurePeer(fp) {
  let p = call.peers.get(fp);
  if (p) return p;
  if (call.peers.size >= MAX_PARTICIPANTS - 1) return null;
  const pc = new RTCPeerConnection({ iceServers: iceServers(), bundlePolicy: 'max-bundle' });
  p = { pc, polite: state.identity.fingerprint < fp, makingOffer: false, ignoreOffer: false, stream: null, audio: null, videoEl: null };
  call.peers.set(fp, p);
  call.participants.add(fp);
  if (call.local) for (const t of call.local.getTracks()) pc.addTrack(t, call.local);
  p.queued = [];       // ice candidates that arrived before the remote description
  p.restarts = 0;
  p.connectTimer = setTimeout(() => { if (p.pc.connectionState !== 'connected') { dropPeer(fp); emit('call:state', snapshot()); } }, CONNECT_TIMEOUT_MS);
  pc.onicecandidate = ({ candidate }) => { if (candidate) signal('ice', { to: fp, candidate: candidate.toJSON() }).catch(() => {}); };
  pc.onnegotiationneeded = async () => {
    try {
      p.makingOffer = true;
      await pc.setLocalDescription();
      await signal('sdp', { to: fp, sdp: pc.localDescription });
    } catch (e) { console.error('negotiation failed', e); }
    finally { p.makingOffer = false; }
  };
  pc.ontrack = ({ track, streams }) => {
    const stream = streams[0] || new MediaStream([track]);
    p.stream = stream;
    if (track.kind === 'audio') {
      if (!p.audio) { p.audio = document.createElement('audio'); p.audio.autoplay = true; p.audio.setAttribute('playsinline', ''); p.audio.dataset.fp = fp; document.body.appendChild(p.audio); }
      p.audio.srcObject = stream;
      p.audio.play().catch(() => { /* needs a gesture on some browsers; the call panel retries */ });
    } else {
      if (!p.videoEl) { p.videoEl = document.createElement('video'); p.videoEl.autoplay = true; p.videoEl.muted = true; p.videoEl.setAttribute('playsinline', ''); p.videoEl.dataset.fp = fp; }
      p.videoEl.srcObject = stream;
      // a camera turned off at the far end mutes the track rather than ending it
      const gone = () => { if (p.videoEl) { p.videoEl.srcObject = null; p.videoEl.remove(); p.videoEl = null; emit('call:state', snapshot()); } };
      track.onended = gone;
      track.onmute = gone;
      track.onunmute = () => { if (!p.videoEl) { p.videoEl = document.createElement('video'); p.videoEl.autoplay = true; p.videoEl.muted = true; p.videoEl.setAttribute('playsinline', ''); p.videoEl.dataset.fp = fp; p.videoEl.srcObject = stream; emit('call:state', snapshot()); } };
    }
    emit('call:state', snapshot());
  };
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'connected') { clearTimeout(p.connectTimer); clearTimeout(p.disconnectTimer); p.restarts = 0; }
    // a blip: wait a little, then the impolite side restarts ice; give up after a few tries
    if (s === 'disconnected') { clearTimeout(p.disconnectTimer); p.disconnectTimer = setTimeout(() => { if (pc.connectionState === 'disconnected') restart(p, fp); }, 4000); }
    if (s === 'failed') restart(p, fp);
    if (s === 'closed') dropPeer(fp);
    emit('call:state', snapshot());
  };
  return p;
}

function restart(p, fp) {
  if (p.restarts >= MAX_RESTARTS) { dropPeer(fp); emit('call:state', snapshot()); return; }
  p.restarts += 1;
  if (!p.polite) { try { p.pc.restartIce(); } catch { /* not supported: the timeout below drops the peer */ } }
  clearTimeout(p.connectTimer);
  p.connectTimer = setTimeout(() => { if (p.pc.connectionState !== 'connected') { dropPeer(fp); emit('call:state', snapshot()); } }, CONNECT_TIMEOUT_MS);
}

async function onSignal({ roomId, msg }) {
  // a signal is only ever acted on inside the conversation the call lives in;
  // a member of some other room must not be able to attach to this call
  if (!call.roomId || roomId !== call.roomId || !msg || msg.callId === undefined) return;
  const from = msg.fp;
  if (typeof from !== 'string' || from === state.identity.fingerprint) return;
  if (msg.to && msg.to !== state.identity.fingerprint) return;
  if (msg.op === 'join') {
    // whoever was already in the call offers to the newcomer; the newcomer's
    // callId is adopted by everyone so a second concurrent call merges. a
    // newcomer we still hold a peer for (they reloaded) starts from a fresh one
    if (!call.callId) call.callId = msg.callId;
    if (call.peers.has(from)) dropPeer(from);
    const p = ensurePeer(from);
    if (!p) return;
    if (p.pc.signalingState === 'stable' && !p.makingOffer && p.pc.getTransceivers().length === 0) {
      // adding tracks fires negotiationneeded; if we have no tracks yet, force it
      p.pc.addTransceiver('audio', { direction: 'recvonly' });
    }
    emit('call:state', snapshot());
    return;
  }
  if (msg.op === 'leave') {
    dropPeer(from);
    emit('call:state', snapshot());
    return;
  }
  if (msg.op === 'video') { emit('call:state', snapshot()); return; }
  // a peer is only ever created by a join or an offer; a stray answer or
  // candidate for someone we do not hold is noise from a call already over
  const isOffer = msg.op === 'sdp' && msg.sdp && msg.sdp.type === 'offer';
  const p = call.peers.get(from) || (isOffer ? ensurePeer(from) : null);
  if (!p) return;
  const pc = p.pc;
  try {
    if (msg.op === 'sdp' && msg.sdp && typeof msg.sdp.type === 'string') {
      const offerCollision = msg.sdp.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
      p.ignoreOffer = !p.polite && offerCollision;
      if (p.ignoreOffer) return;
      await pc.setRemoteDescription(msg.sdp);
      // candidates that arrived early are applied now that they have a description
      for (const c of p.queued.splice(0)) { try { await pc.addIceCandidate(c); } catch { /* stale */ } }
      if (msg.sdp.type === 'offer') {
        await pc.setLocalDescription();
        await signal('sdp', { to: from, sdp: pc.localDescription });
      }
    } else if (msg.op === 'ice' && msg.candidate) {
      if (!pc.remoteDescription) { if (p.queued.length < 64) p.queued.push(msg.candidate); return; }
      try { await pc.addIceCandidate(msg.candidate); } catch (e) { if (!p.ignoreOffer) throw e; }
    }
  } catch (e) {
    console.error('signal handling failed', e);
  }
}

on('room:call', onSignal);

// a peer that vanished without saying so is dropped when its connection fails;
// nothing else to do on our side. leaving the page ends the call.
window.addEventListener('pagehide', () => { if (call.roomId) teardown(); });

export function resumeAudio() {
  for (const [, p] of call.peers) if (p.audio) p.audio.play().catch(() => {});
}
