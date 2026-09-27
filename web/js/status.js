// answers one question for both pages: will this keep working with the
// network gone? each check is a real probe, not a claim.

import { cryptoAvailable } from './crypto.js';

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return { supported: false, controlled: false };
  try {
    const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    await navigator.serviceWorker.ready;
    return { supported: true, controlled: !!navigator.serviceWorker.controller, registration: reg };
  } catch (e) {
    return { supported: true, controlled: false, error: e };
  }
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
