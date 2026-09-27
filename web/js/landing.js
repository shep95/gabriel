import { registerServiceWorker, offlineReadiness, watchOnline, onWorkerUpdate } from './status.js';

const $ = (s, r = document) => r.querySelector(s);

function reveal() {
  document.documentElement.classList.add('js');
  const els = document.querySelectorAll('.reveal');
  // whatever the observer does, nothing stays hidden for long
  setTimeout(() => els.forEach((e) => e.classList.add('in')), 2500);
  if (!('IntersectionObserver' in window)) { els.forEach((e) => e.classList.add('in')); return; }
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
  els.forEach((e) => io.observe(e));
}

// the header takes its glass once the hero has passed under it; the phone
// menu folds open and closed; the link for the section in view keeps its
// underline
function header() {
  const top = $('#top');
  const nav = $('#topnav');
  const btn = $('#menu-btn');
  if (!top || !nav) return;
  const solid = () => top.classList.toggle('solid', window.scrollY > 24 || top.classList.contains('open'));
  window.addEventListener('scroll', solid, { passive: true });
  solid();
  const close = () => { top.classList.remove('open'); if (btn) btn.setAttribute('aria-expanded', 'false'); solid(); };
  if (btn) {
    btn.addEventListener('click', () => {
      const open = !top.classList.contains('open');
      top.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', String(open));
      solid();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    document.addEventListener('click', (e) => { if (top.classList.contains('open') && !top.contains(e.target)) close(); });
  }
  const links = Array.from(nav.querySelectorAll('a[href^="#"]'));
  links.forEach((a) => a.addEventListener('click', close));
  if (!('IntersectionObserver' in window)) return;
  const byId = new Map(links.map((a) => [a.getAttribute('href').slice(1), a]));
  const visible = new Map();
  const spy = new IntersectionObserver((entries) => {
    for (const en of entries) visible.set(en.target.id, en.isIntersecting ? en.intersectionRatio : 0);
    let best = null, bestRatio = 0;
    for (const [id, r] of visible) if (r > bestRatio) { best = id; bestRatio = r; }
    links.forEach((a) => a.classList.remove('current'));
    if (best && byId.has(best)) byId.get(best).classList.add('current');
  }, { rootMargin: '-30% 0px -50% 0px', threshold: [0, 0.2, 0.5, 0.8] });
  for (const id of byId.keys()) { const sec = document.getElementById(id); if (sec) spy.observe(sec); }
}

function setPill(el, state, label) {
  el.classList.remove('on', 'warn');
  if (state === 'on') el.classList.add('on');
  if (state === 'warn') el.classList.add('warn');
  if (label) el.textContent = label;
}

function paintReadiness(r) {
  const box = $('#readiness');
  const say = (k, ok, yes, no) => {
    const el = box.querySelector(`[data-k="${k}"]`);
    if (!el) return;
    el.textContent = ok ? yes : no;
    el.classList.toggle('mono', true);
    el.style.color = ok ? 'var(--accent)' : 'var(--danger)';
  };
  say('secureContext', r.secureContext, 'yes', 'no: needs https or localhost');
  say('crypto', r.crypto, 'available', 'missing in this browser');
  say('controlled', r.controlled, 'active', r.serviceWorker ? 'installing' : 'unsupported');
  say('cached', r.cached, 'complete', 'not yet');
  const net = box.querySelector('[data-k="online"]');
  net.textContent = r.online ? 'connected (not needed)' : 'offline (fine)';
  net.style.color = 'var(--text-soft)';

  setPill($('#pill-cached'), r.cached && r.controlled ? 'on' : 'off', r.cached && r.controlled ? 'cached for offline' : 'caching for offline');
  const fr = $('#foot-ready');
  if (fr) setPill(fr, r.cached && r.controlled ? 'on' : 'off', r.cached && r.controlled ? 'offline copy kept on this device' : 'offline copy not complete yet');
  setPill($('#pill-crypto'), r.crypto ? 'on' : 'warn', r.crypto ? 'device cryptography ready' : 'no web cryptography');
  $('#hero-signal').dataset.trust = String(r.ready);
  $('#pairdemo').classList.toggle('trust', r.ready);
}

async function main() {
  reveal();
  header();
  // chromium fires this when the page qualifies for install; offer a button
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    const b = $('#install-btn');
    if (!b) return;
    b.hidden = false;
    b.onclick = async () => { e.prompt(); const { outcome } = await e.userChoice; if (outcome === 'accepted') b.hidden = true; };
  });
  watchOnline((online) => setPill($('#pill-net'), online ? 'off' : 'on', online ? 'network: connected' : 'network: off, still working'));

  // a newer version took over: the landing holds nothing, so show it now
  onWorkerUpdate(() => location.reload());
  const reg = await registerServiceWorker();
  if (reg.registration) {
    // the first install finishes a moment after ready; re-measure when it does
    reg.registration.addEventListener('updatefound', () => {
      const w = reg.registration.installing;
      if (w) w.addEventListener('statechange', async () => { if (w.state === 'activated') paintReadiness(await offlineReadiness()); });
    });
  }
  paintReadiness(await offlineReadiness());
  // caches fill asynchronously on first load; check again shortly
  setTimeout(async () => paintReadiness(await offlineReadiness()), 1500);
  setTimeout(async () => paintReadiness(await offlineReadiness()), 5000);

  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'version') $('#version').textContent = e.data.version;
    });
    navigator.serviceWorker.controller.postMessage('version');
  } else {
    $('#version').textContent = 'first load';
  }
}

main().catch((e) => {
  const t = $('#toast');
  t.textContent = `startup problem: ${e.message}`;
  t.classList.add('show', 'error');
});
