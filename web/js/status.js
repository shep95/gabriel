// answers one question for both pages: will this keep working with the
// network gone? each check is a real probe, not a claim.

import { cryptoAvailable } from './crypto.js';

// true when a worker already owned this page at load: a later controller
// change is then an update, not the first install.
const controlledAtLoad = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
const updateListeners = new Set();
let updateWired = false;

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return { supported: false, controlled: false };
  try {
    const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    // ask for a fresh copy of the worker now and whenever the page comes back
    // in front; an installed app can sit open for days without a navigation
    reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
    await navigator.serviceWorker.ready;
    return { supported: true, controlled: !!navigator.serviceWorker.controller, registration: reg };
  } catch (e) {
    return { supported: true, controlled: false, error: e };
  }
}

// fires once when a newer worker has taken over this page. the files the page
// is showing came from the old cache, so the caller decides when to reload.
export function onWorkerUpdate(cb) {
  if (!('serviceWorker' in navigator)) return () => {};
  updateListeners.add(cb);
  if (!updateWired) {
    updateWired = true;
    let fired = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!controlledAtLoad || fired) return;
      fired = true;
      for (const fn of Array.from(updateListeners)) { try { fn(); } catch (e) { console.error('update listener failed', e); } }
    });
  }
  return () => updateListeners.delete(cb);
}

export async function offlineReadiness() {
  const out = {
    secureContext: window.isSecureContext,
    crypto: cryptoAvailable(),
    serviceWorker: 'serviceWorker' in navigator,
    controlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
    cached: false,
    online: navigator.onLine,
  };
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      for (const k of keys) {
        const c = await caches.open(k);
        if (await c.match('./app.html', { ignoreSearch: true })) { out.cached = true; break; }
      }
    }
  } catch { /* caches unavailable in some private modes */ }
  out.ready = out.crypto && out.controlled && out.cached;
  return out;
}

export function watchOnline(cb) {
  const fire = () => cb(navigator.onLine);
  window.addEventListener('online', fire);
  window.addEventListener('offline', fire);
  fire();
  return () => { window.removeEventListener('online', fire); window.removeEventListener('offline', fire); };
}
