// installing the console from the web, no store. chromium browsers fire
// beforeinstallprompt and let the page offer a button; ios and desktop safari
// only install from the share menu, so those get exact instructions instead.

import { state, emit } from './state.js';

export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

export function platform() {
  const ua = navigator.userAgent;
  const iOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (iOS) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Macintosh/.test(ua)) return 'mac';
  if (/Windows/.test(ua)) return 'windows';
  if (/Linux/.test(ua)) return 'linux';
  return 'other';
}

export function watchInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installPrompt = e;
    emit('install:available');
  });
  window.addEventListener('appinstalled', () => { state.installPrompt = null; emit('install:done'); });
}

export async function promptInstall() {
  const p = state.installPrompt;
  if (!p) return 'unavailable';
  p.prompt();
  const { outcome } = await p.userChoice;
  if (outcome === 'accepted') state.installPrompt = null;
  return outcome;
}

export function installInstructions() {
  const p = platform();
  const safari = /Safari/.test(navigator.userAgent) && !/Chrome|CriOS|FxiOS|EdgiOS/.test(navigator.userAgent);
  if (p === 'ios') return { title: 'iphone or ipad', steps: ['open this page in safari', 'tap the share button (the square with an arrow)', 'scroll and tap "add to home screen"', 'open it from the home screen; it runs full-screen and offline'] };
  if (p === 'android') return { title: 'android', steps: ['in chrome or edge, open the browser menu (three dots)', 'tap "install app" or "add to home screen"', 'confirm; it appears with the other apps'] };
  if (p === 'mac' && safari) return { title: 'mac (safari)', steps: ['file menu → "add to dock"', 'confirm; it opens as its own window from the dock'] };
  if (p === 'mac' || p === 'windows' || p === 'linux') return { title: 'laptop or desktop', steps: ['in chrome, edge or brave, look for the install icon at the right end of the address bar', 'or open the browser menu and choose "install gabriel console"', 'it opens in its own window and works with the network off'] };
  return { title: 'this browser', steps: ['use the browser menu to add this page to your home screen or apps', 'it keeps working without a connection once added'] };
}
