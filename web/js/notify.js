// notifications that name the sender and nothing else. content never enters a
// notification, so a lock screen or a notification centre shows who wrote, not
// what. 'silent' shows only that something arrived; 'off' shows nothing.
//
// these fire from the page through the service worker registration, which
// works while the console is open or backgrounded in a tab or installed app.
// there is no push server, so a fully closed console cannot be woken; the
// settings screen says so.

import { state } from './state.js';

export function notificationSupport() {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) return { supported: false, permission: 'unsupported' };
  return { supported: true, permission: Notification.permission };
}

export async function requestNotifications() {
  const s = notificationSupport();
  if (!s.supported) return 'unsupported';
  if (s.permission === 'granted') return 'granted';
  try { return await Notification.requestPermission(); } catch { return Notification.permission; }
}

// the notification carries the sender's name and nothing else: no room, no text
export async function notifyIncoming({ senderName, route }) {
  const mode = state.settings.notifications;
  if (mode === 'off') return;
  if (!document.hidden && document.hasFocus()) return;
  const s = notificationSupport();
  if (!s.supported || s.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const title = mode === 'silent' ? 'gabriel' : String(senderName).slice(0, 40);
    await reg.showNotification(title, {
      body: mode === 'silent' ? 'something arrived' : 'sent a message',
      tag: mode === 'silent' ? 'gabriel' : `gabriel:${route}`,
      renotify: false,
      silent: false,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      data: { route },
    });
  } catch { /* the browser refused; nothing to do */ }
}

export async function clearNotifications(route) {
  try {
    const reg = await navigator.serviceWorker.ready;
    const list = await reg.getNotifications(route ? { tag: `gabriel:${route}` } : {});
    for (const n of list) n.close();
  } catch { /* fine */ }
}
