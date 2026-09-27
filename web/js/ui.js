// dom helpers shared by every screen. nothing here knows about crypto or storage.

import { escapeHtml } from './util.js';

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

let toastTimer = null;
export function toast(msg, kind = '') {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), kind === 'error' ? 5200 : 3200);
}

export function openOverlay(html) {
  const o = $('#overlay');
  $('#overlay-box').innerHTML = html;
  o.hidden = false;
  requestAnimationFrame(() => o.classList.add('show'));
  return $('#overlay-box');
}

export function closeOverlay() {
  const o = $('#overlay');
  if (!o) return;
  o.classList.remove('show');
  setTimeout(() => { o.hidden = true; $('#overlay-box').innerHTML = ''; }, 240);
}

export function confirmDialog({ title, body, okLabel = 'continue', danger = false, typeToConfirm = null }) {
  return new Promise((resolve) => {
    const box = openOverlay(`
      <h3>${escapeHtml(title)}</h3>
      <p style="margin-top:.6rem">${body}</p>
      ${typeToConfirm ? `<div class="field" style="margin-top:1rem"><label>type <span class="mono">${escapeHtml(typeToConfirm)}</span> to continue</label><input type="text" id="confirm-input" autocomplete="off" autocapitalize="off" spellcheck="false"></div>` : ''}
      <div class="row" style="margin-top:1.2rem;justify-content:flex-end">
        <button class="ghost" id="c-no">cancel</button>
        <button class="${danger ? 'danger' : 'primary'}" id="c-ok" ${typeToConfirm ? 'disabled' : ''}>${escapeHtml(okLabel)}</button>
      </div>`);
    const ok = $('#c-ok', box);
    if (typeToConfirm) {
      const input = $('#confirm-input', box);
      input.focus();
      input.addEventListener('input', () => { ok.disabled = input.value.trim() !== typeToConfirm; });
    }
    $('#c-no', box).onclick = () => { closeOverlay(); resolve(false); };
    ok.onclick = () => { closeOverlay(); resolve(true); };
  });
}

// a one-field prompt; resolves with the string or null
export function promptDialog({ title, label, value = '', okLabel = 'save', maxlength = 60, placeholder = '' }) {
  return new Promise((resolve) => {
    const box = openOverlay(`
      <h3>${escapeHtml(title)}</h3>
      <div class="field" style="margin-top:1rem"><label>${escapeHtml(label)}</label><input type="text" id="pd" maxlength="${maxlength}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" autocomplete="off"></div>
      <div class="row" style="justify-content:flex-end"><button class="ghost" id="pd-no">cancel</button><button class="primary" id="pd-ok">${escapeHtml(okLabel)}</button></div>`);
    const input = $('#pd', box);
    input.focus();
    const done = (v) => { closeOverlay(); resolve(v); };
    $('#pd-no', box).onclick = () => done(null);
    $('#pd-ok', box).onclick = () => done(input.value.trim());
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(input.value.trim()); });
  });
}

export function download(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('copied', 'ok');
  } catch {
    toast('clipboard blocked here; select the text and copy it by hand', 'error');
  }
}

export function pillState(el, on, label) {
  el.classList.toggle('on', on);
  if (label !== undefined) el.textContent = label;
}
