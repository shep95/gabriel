// an on-page keyboard. what is typed on it never passes through the system
// keyboard, so a keyboard app, an input method or a keystroke logger on the
// device has nothing to see; the layout is shuffled every time it opens, so
// a logger of tap positions has nothing either. it is slower than the system
// keyboard, and that is the price. it does not defend against a browser
// extension or a compromised browser, which see the page itself.

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');
const DIGITS = '0123456789'.split('');
const SYMBOLS = ".,-_'\"?!@#:;/()&+=*%".split('');

function shuffled(list) {
  const a = list.slice();
  const r = new Uint32Array(a.length);
  crypto.getRandomValues(r);
  for (let i = a.length - 1; i > 0; i--) { const j = r[i] % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// inputs: one or more fields the keyboard types into; the last one focused
// receives the keys. onDone runs for the done key (usually: submit). mount is
// where the sheet goes: after that element, or inside it with where: 'append'.
export function quietKeyboard(inputs, { onDone, mount, where = 'after' } = {}) {
  const fields = Array.isArray(inputs) ? inputs : [inputs];
  let target = fields[0];
  let panel = null;
  let shift = false;
  let symbols = false;
  const saved = new Map();

  for (const f of fields) f.addEventListener('focus', () => { target = f; });

  const insert = (ch) => {
    const el = target;
    const start = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length;
    const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : el.value.length;
    const max = Number(el.getAttribute('maxlength')) || Infinity;
    if (el.value.length - (end - start) + ch.length > max) return;
    el.value = el.value.slice(0, start) + ch + el.value.slice(end);
    const pos = start + ch.length;
    try { el.setSelectionRange(pos, pos); } catch { /* not every input type allows it */ }
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const backspace = () => {
    const el = target;
    const start = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length;
    const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : el.value.length;
    if (start === 0 && end === 0) return;
    const from = start === end ? start - 1 : start;
    el.value = el.value.slice(0, from) + el.value.slice(end);
    try { el.setSelectionRange(from, from); } catch { /* ignore */ }
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const key = (label, k, cls = '') => `<button type="button" class="k ${cls}" data-k="${k}" aria-label="${label}">${label}</button>`;
  const render = () => {
    const letters = shuffled(symbols ? SYMBOLS : LETTERS).map((c) => (shift && !symbols ? c.toUpperCase() : c));
    const rows = symbols ? [letters.slice(0, 7), letters.slice(7, 14), letters.slice(14)] : [letters.slice(0, 10), letters.slice(10, 19), letters.slice(19)];
    const digits = shuffled(DIGITS);
    panel.innerHTML = `
      <div class="row">${digits.map((d) => key(d, d)).join('')}</div>
      ${rows.map((r) => `<div class="row">${r.map((c) => key(c, c)).join('')}</div>`).join('')}
      <div class="row">
        ${key('⇧', 'shift', `fn ${shift ? 'on' : ''}`)}
        ${key(symbols ? 'abc' : '#+=', 'sym', 'fn')}
        ${key('space', ' ', 'wide')}
        ${key('⌫', 'back', 'fn')}
        ${key('done', 'done', 'fn done')}
      </div>`;
  };

  const onPointer = (e) => {
    const b = e.target.closest('.k');
    if (!b) return;
    e.preventDefault(); // the field keeps focus and its caret
    const k = b.dataset.k;
    if (k === 'shift') { shift = !shift; render(); return; }
    if (k === 'sym') { symbols = !symbols; render(); return; }
    if (k === 'back') { backspace(); return; }
    if (k === 'done') { api.close(); if (onDone) onDone(); return; }
    insert(k);
    if (shift && !symbols) { shift = false; render(); }
  };

  const api = {
    get open() { return !!panel; },
    open() {
      if (panel) return;
      panel = document.createElement('div');
      panel.className = 'keypad';
      panel.setAttribute('role', 'group');
      panel.setAttribute('aria-label', 'on-page keyboard');
      panel.addEventListener('pointerdown', onPointer);
      panel.addEventListener('mousedown', (e) => e.preventDefault());
      panel.addEventListener('contextmenu', (e) => e.preventDefault());
      shift = false; symbols = false;
      render();
      for (const f of fields) {
        saved.set(f, { readOnly: f.readOnly, inputMode: f.getAttribute('inputmode') });
        f.readOnly = true;                       // the system keyboard stays down
        f.setAttribute('inputmode', 'none');
        f.dataset.quiet = '1';
      }
      if (mount && where === 'append') mount.appendChild(panel);
      else (mount || target.closest('.field') || target).insertAdjacentElement('afterend', panel);
      target.focus({ preventScroll: true });
    },
    close() {
      if (!panel) return;
      panel.remove(); panel = null;
      for (const f of fields) {
        const s = saved.get(f) || {};
        f.readOnly = !!s.readOnly;
        if (s.inputMode) f.setAttribute('inputmode', s.inputMode); else f.removeAttribute('inputmode');
        delete f.dataset.quiet;
      }
    },
    toggle() { if (panel) api.close(); else api.open(); return !!panel; },
    reshuffle() { if (panel) render(); },
  };
  return api;
}
