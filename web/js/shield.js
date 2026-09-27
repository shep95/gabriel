// shield: what a web page can and cannot do about screenshots and recordings.
//
// it cannot stop the operating system from capturing the screen; no page can.
// what it can do is make a capture worth less:
//   - messages are blurred until the reader presses and holds one, so a
//     screenshot shows one message, not a conversation
//   - the moment the page loses focus or is hidden (app switcher, another
//     window, a recording overlay taking focus) everything is veiled
//   - text in shielded views cannot be selected, dragged or long-pressed
// the settings screen states these limits in the same words.

import { state } from './state.js';

let veil = null;
let holdTimer = null;

export function shieldEnabled() { return !!state.settings.shield; }

export function installShield() {
  if (veil) return;
  veil = document.createElement('div');
  veil.className = 'veil';
  veil.innerHTML = '<div class="veil-inner"><div class="wordmark">gabriel</div><div class="veil-note">veiled while the console is not in front. tap to return.</div></div>';
  veil.hidden = true;
  document.body.appendChild(veil);
  veil.addEventListener('click', () => unveil());

  const onHide = () => { if (shieldEnabled() && state.vaultKey) showVeil(); };
  document.addEventListener('visibilitychange', () => { if (document.hidden) onHide(); });
  window.addEventListener('blur', onHide);
  window.addEventListener('focus', () => { /* stay veiled until a tap: focus can return under a recorder */ });
  window.addEventListener('pageshow', onHide);

  // hold-to-reveal on any element with data-shielded
  document.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('[data-shielded]');
    if (!el || !shieldEnabled()) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => { el.classList.add('revealed'); }, 180);
  });
  const release = () => {
    clearTimeout(holdTimer);
    document.querySelectorAll('[data-shielded].revealed').forEach((el) => {
      // linger a moment so a slip of the finger does not re-blur mid-word
      setTimeout(() => el.classList.remove('revealed'), 400);
    });
  };
  document.addEventListener('pointerup', release);
  document.addEventListener('pointercancel', release);
  document.addEventListener('contextmenu', (e) => { if (e.target.closest('[data-shielded]') && shieldEnabled()) e.preventDefault(); });
  document.addEventListener('copy', (e) => { if (e.target && e.target.closest && e.target.closest('[data-shielded]') && shieldEnabled()) e.preventDefault(); });
  document.addEventListener('dragstart', (e) => { if (e.target.closest && e.target.closest('[data-shielded]') && shieldEnabled()) e.preventDefault(); });
}

export function showVeil() {
  if (!veil) return;
  veil.hidden = false;
  document.body.classList.add('veiled');
}

export function unveil() {
  if (!veil) return;
  veil.hidden = true;
  document.body.classList.remove('veiled');
}

export function applyShieldClass() {
  document.body.classList.toggle('shield-on', shieldEnabled());
}
