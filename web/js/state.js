// in-memory state while unlocked. lock() empties it. one object, imported by
// every screen module, so there is exactly one source of truth.

export const DEFAULT_SETTINGS = {
  autoLockMinutes: 5,
  shield: true,               // blur messages until held; veil the app when it loses focus
  notifications: 'sender',    // 'off' | 'sender' | 'silent'
  tiles: 'none',              // 'none' | 'beacon' | 'osm'
  beaconUrl: '',
  beaconPassword: '',
  beaconAuto: false,
  iceServers: '',             // optional stun/turn urls, one per line, off by default
  theme: 'night',             // 'night' (the picture) | 'deep' (dimmed, denser glass)
  quietKeys: 'system',        // 'system' keyboard | 'quiet': the on-page keyboard for messages and notes
};

export const state = {
  profile: null,      // { id:'profile', name, createdAt, kdf, wrap, version }
  settings: { ...DEFAULT_SETTINGS },
  vaultKey: null,     // CryptoKey while unlocked
  identity: null,     // { pub, fingerprint, privateKey, signPub, signKey }
  devices: [],        // decrypted device records
  notes: [],          // decrypted notes
  rooms: [],          // decrypted room records
  route: 'overview',
  lockTimer: null,
  unlockedAt: null,
  readiness: null,
  installPrompt: null,
};

export function resetUnlockedState() {
  state.vaultKey = null;
  state.identity = null;
  state.devices = [];
  state.notes = [];
  state.rooms = [];
  state.unlockedAt = null;
}

// tiny event bus so modules can react (rooms -> ui, beacon -> rooms)
const listeners = new Map();
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}
export function emit(event, payload) {
  const set = listeners.get(event);
  if (!set) return;
  for (const fn of Array.from(set)) {
    try { fn(payload); } catch (e) { console.error(`listener for ${event} failed`, e); }
  }
}
