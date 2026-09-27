// location: nothing is read from the gps until a person taps "share where i
// am", and then only for the room or device they chose. what leaves the device
// is a sealed room message with lat/lon/accuracy; the beacon and the network
// see ciphertext. recipients get distance, bearing and a compass arrow, which
// work with no map at all; a map appears only when a tile source is enabled.

import { state } from './state.js';
import { escapeHtml } from './util.js';

const R = 6371000;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

export function distanceM(a, b) {
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function bearingDeg(a, b) {
  const y = Math.sin(toRad(b.lon - a.lon)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lon - a.lon));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function fmtDistance(m) {
  if (!Number.isFinite(m)) return '';
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;
}

export function compassPoint(deg) {
  return ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'][Math.round(deg / 45) % 8];
}

export function geoAvailable() { return 'geolocation' in navigator; }

export function currentPosition({ highAccuracy = true, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!geoAvailable()) return reject(new Error('no location hardware access in this browser'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, acc: Math.round(pos.coords.accuracy || 0), ts: new Date(pos.timestamp).toISOString() }),
      (err) => reject(new Error(err.code === 1 ? 'location permission refused' : err.code === 2 ? 'no position available' : 'position timed out')),
      { enableHighAccuracy: highAccuracy, timeout, maximumAge: 0 },
    );
  });
}

// live sharing: a watch that reports at most every `minIntervalMs`
export function watchPosition(cb, { minIntervalMs = 20000 } = {}) {
  if (!geoAvailable()) throw new Error('no location access');
  let last = 0;
  const id = navigator.geolocation.watchPosition((pos) => {
    const now = Date.now();
    if (now - last < minIntervalMs) return;
    last = now;
    cb({ lat: pos.coords.latitude, lon: pos.coords.longitude, acc: Math.round(pos.coords.accuracy || 0), ts: new Date(pos.timestamp).toISOString() });
  }, () => {}, { enableHighAccuracy: true, maximumAge: 5000 });
  return () => navigator.geolocation.clearWatch(id);
}

// ---------- compass ----------

let headingCb = null;
let headingHandler = null;
export async function startCompass(cb) {
  headingCb = cb;
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    try { const r = await DeviceOrientationEvent.requestPermission(); if (r !== 'granted') return false; } catch { return false; }
  }
  headingHandler = (e) => {
    let h = null;
    if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;
    else if (e.absolute && typeof e.alpha === 'number') h = (360 - e.alpha) % 360;
    if (h !== null && headingCb) headingCb(h);
  };
  window.addEventListener('deviceorientationabsolute', headingHandler, true);
  window.addEventListener('deviceorientation', headingHandler, true);
  return true;
}
export function stopCompass() {
  if (headingHandler) { window.removeEventListener('deviceorientationabsolute', headingHandler, true); window.removeEventListener('deviceorientation', headingHandler, true); }
  headingHandler = null; headingCb = null;
}

// ---------- radar: relative positions with no tiles at all ----------

export function drawRadar(canvas, me, points, headingDeg = null) {
  const size = Math.min(canvas.clientWidth || 300, 360);
  const ratio = window.devicePixelRatio || 1;
  canvas.width = size * ratio; canvas.height = size * ratio;
  canvas.style.height = `${size}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, size, size);
  const cx = size / 2, cy = size / 2, rMax = size / 2 - 22;
  const styles = getComputedStyle(document.documentElement);
  const line = styles.getPropertyValue('--line-strong').trim() || 'rgba(190,210,230,0.16)';
  const accent = styles.getPropertyValue('--accent').trim() || '#9fd3ff';
  const text = styles.getPropertyValue('--text-soft').trim() || '#a4adb7';
  const dists = points.map((p) => distanceM(me, p));
  const maxD = Math.max(50, ...dists) * 1.15;
  ctx.strokeStyle = line; ctx.lineWidth = 1;
  for (const f of [0.33, 0.66, 1]) { ctx.beginPath(); ctx.arc(cx, cy, rMax * f, 0, Math.PI * 2); ctx.stroke(); }
  // ring labels sit at the lower right so the north tick at the top stays clear
  ctx.font = '11px ui-monospace, Menlo, monospace'; ctx.fillStyle = text; ctx.textAlign = 'left';
  for (const f of [0.33, 0.66, 1]) ctx.fillText(fmtDistance(maxD * f), cx + rMax * f * 0.72 + 4, cy + rMax * f * 0.72 + 4);
  ctx.textAlign = 'center';
  const rot = headingDeg === null ? 0 : -headingDeg; // rotate so "up" is where the phone points
  const place = (p) => {
    const d = distanceM(me, p), b = bearingDeg(me, p) + rot;
    const r = (Math.min(d, maxD) / maxD) * rMax;
    return { x: cx + r * Math.sin(toRad(b)), y: cy - r * Math.cos(toRad(b)), d, b: (bearingDeg(me, p)) };
  };
  // north tick
  ctx.fillStyle = text; ctx.fillText('n', cx + (rMax + 12) * Math.sin(toRad(rot)), cy - (rMax + 12) * Math.cos(toRad(rot)) + 4);
  // me
  ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fill();
  if (headingDeg !== null) { ctx.strokeStyle = accent; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx, cy - 18); ctx.stroke(); }
  ctx.textAlign = 'left';
  for (const p of points) {
    const { x, y } = place(p);
    ctx.fillStyle = p.stale ? text : accent;
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = text; ctx.fillText(p.label, x + 8, y + 4);
  }
}

// ---------- optional map (leaflet, vendored) ----------

let leafletLoaded = null;
export function tileSource() {
  const t = state.settings.tiles;
  if (t === 'osm') return { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© openstreetmap contributors', maxZoom: 19, external: true };
  if (t === 'beacon') {
    try {
      const u = new URL(state.settings.beaconUrl.replace(/^ws/i, 'http'));
      u.pathname = '/tiles/{z}/{x}/{y}.png'; u.search = '';
      return { url: decodeURIComponent(u.toString()), attribution: 'tiles served by the beacon', maxZoom: 19, external: false };
    } catch { return null; }
  }
  return null;
}

async function loadLeaflet() {
  if (window.L) return window.L;
  if (!leafletLoaded) {
    leafletLoaded = new Promise((resolve, reject) => {
      const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = './vendor/leaflet.css'; document.head.appendChild(css);
      const s = document.createElement('script'); s.src = './vendor/leaflet.js'; s.onload = () => resolve(window.L); s.onerror = () => reject(new Error('map library did not load')); document.head.appendChild(s);
    });
  }
  return leafletLoaded;
}

export async function renderMap(container, me, points) {
  const src = tileSource();
  if (!src) return null;
  const L = await loadLeaflet();
  container.innerHTML = '';
  const map = L.map(container, { zoomControl: true, attributionControl: true });
  L.tileLayer(src.url, { maxZoom: src.maxZoom, attribution: src.attribution, crossOrigin: false }).addTo(map);
  const pts = [];
  if (me) { L.circleMarker([me.lat, me.lon], { radius: 6, color: '#9fd3ff', fillOpacity: 0.9 }).addTo(map).bindTooltip('you'); pts.push([me.lat, me.lon]); }
  for (const p of points) { L.circleMarker([p.lat, p.lon], { radius: 6, color: p.stale ? '#7d8791' : '#ffffff', fillOpacity: 0.9 }).addTo(map).bindTooltip(escapeHtml(p.label)); pts.push([p.lat, p.lon]); }
  if (pts.length > 1) map.fitBounds(pts, { padding: [30, 30] }); else if (pts.length === 1) map.setView(pts[0], 16); else map.setView([0, 0], 2);
  return map;
}

// links that open the platform's own maps app. these leave the console and are
// only ever followed on a tap; they are shown, never fetched.
export function externalMapLinks(p) {
  const ll = `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;
  return [
    { label: 'geo: link (android maps apps)', href: `geo:${ll}?q=${ll}` },
    { label: 'apple maps directions', href: `https://maps.apple.com/?daddr=${ll}&dirflg=w` },
    { label: 'openstreetmap.org', href: `https://www.openstreetmap.org/?mlat=${p.lat.toFixed(6)}&mlon=${p.lon.toFixed(6)}#map=17/${p.lat.toFixed(6)}/${p.lon.toFixed(6)}` },
  ];
}
