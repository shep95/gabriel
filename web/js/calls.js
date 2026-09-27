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

async function signal(op, extra = {}) {
  if (!call.send) return;
  await call.send({ op, callId: call.callId, ...extra });
}

// conv = { id, send }: a room or a direct chat; send seals a call body into it
export async function joinCall(conv, { video = false } = {}) {
  if (call.roomId) throw new Error('already in a call');
  if (!conv || typeof conv.id !== 'string' || typeof conv.send !== 'function') throw new Error('nothing to call');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('this browser has no microphone access');
  call.local = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: video ? { width: { ideal: 640 }, facingMode: 'user' } : false });
  call.video = video;
  call.roomId = conv.id;
  call.send = conv.send;
  call.callId = call.callId || Math.random().toString(16).slice(2, 10);
  call.since = Date.now();
  call.participants = new Set([state.identity.fingerprint]);
  emit('call:state', snapshot());
  await signal('join', { video });
}

export async function leaveCall() {
  if (!call.roomId) return;
  try { await signal('leave'); } catch { /* offline */ }
  teardown();
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
  try { p.pc.close(); } catch { /* already closed */ }
  if (p.audio) { p.audio.srcObject = null; p.audio.remove(); }
  if (p.videoEl) { p.videoEl.srcObject = null; p.videoEl.remove(); }
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
    for (const [, p] of call.peers) for (const s of p.pc.getSenders()) if (s.track && s.track.kind === 'video') p.pc.removeTrack(s);
    call.video = false;
  } else {
    const cam = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, facingMode: 'user' } });
    const track = cam.getVideoTracks()[0];
    call.local.addTrack(track);
    for (const [, p] of call.peers) p.pc.addTrack(track, call.local);
    call.video = true;
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
      track.onended = () => { if (p.videoEl) { p.videoEl.remove(); p.videoEl = null; emit('call:state', snapshot()); } };
    }
    emit('call:state', snapshot());
  };
  pc.onconnectionstatechange = () => {
    if (['failed', 'closed'].includes(pc.connectionState)) { closePeer(p); call.peers.delete(fp); call.participants.delete(fp); }
    emit('call:state', snapshot());
  };
  return p;
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
    // callId is adopted by everyone so a second concurrent call merges
    if (!call.callId) call.callId = msg.callId;
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
    const p = call.peers.get(from);
    if (p) { closePeer(p); call.peers.delete(from); }
    call.participants.delete(from);
    emit('call:state', snapshot());
    return;
  }
  const p = ensurePeer(from);
  if (!p) return;
  const pc = p.pc;
  try {
    if (msg.op === 'sdp' && msg.sdp && typeof msg.sdp.type === 'string') {
      const offerCollision = msg.sdp.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
      p.ignoreOffer = !p.polite && offerCollision;
      if (p.ignoreOffer) return;
      await pc.setRemoteDescription(msg.sdp);
      if (msg.sdp.type === 'offer') {
        await pc.setLocalDescription();
        await signal('sdp', { to: from, sdp: pc.localDescription });
      }
    } else if (msg.op === 'ice' && msg.candidate) {
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
