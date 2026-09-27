// boot guard. loaded as a plain script before the module, so it runs even
// when the module graph fails to load (a missing export after a mixed cache,
// an old browser). if the console has not started after a few seconds and
// the network is there, it clears the worker and its caches once and reloads;
// the vault in indexeddb is untouched. offline, or on a second failure, it
// says what happened instead of leaving a blank page.
(function () {
  var FLAG = 'gabriel-boot-retry';
  function started() {
    var root = document.getElementById('root');
    return document.documentElement.classList.contains('app-ready') || (root && root.childElementCount > 0);
  }
  function explain(text) {
    var root = document.getElementById('root');
    if (!root || root.childElementCount) return;
    root.innerHTML = '<div class="gate"><div class="panel"><h1>the console did not start.</h1><p>' + text + '</p><p class="fine">your data is untouched: it lives in this browser\'s storage for this site, sealed.</p></div></div>';
  }
  function check() {
    if (started()) return;
    var retried = false;
    try { retried = !!sessionStorage.getItem(FLAG); } catch (e) { /* storage blocked */ }
    if (retried) { explain('this browser kept a mix of old and new files, and one reload did not clear it. clear this site\'s data in the browser settings and open the console again, or try another browser.'); return; }
    // the copy is only thrown away when the origin can hand out a fresh one:
    // a hotspot with no uplink says "online" and would otherwise lose it
    var probe = fetch('./sw.js', { cache: 'no-store', credentials: 'omit' }).then(function (r) { return r.ok; }, function () { return false; });
    probe.then(function (reachable) {
      if (!reachable) { explain('this browser holds an incomplete copy and cannot reach the site to complete it. reconnect once and open the console again.'); return; }
      try { sessionStorage.setItem(FLAG, '1'); } catch (e) { /* ignore */ }
      var done = function () { location.reload(); };
      var work = Promise.resolve();
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
        work = work.then(function () { return navigator.serviceWorker.getRegistrations(); }).then(function (regs) { return Promise.all(regs.map(function (r) { return r.unregister(); })); });
      }
      if (window.caches) work = work.then(function () { return caches.keys(); }).then(function (keys) { return Promise.all(keys.map(function (k) { return caches.delete(k); })); });
      work.then(done, done);
    });
  }
  // the clock starts when the page has loaded, not when this script ran, so a
  // slow first load over a crowded hotspot is not mistaken for a broken one
  if (document.readyState === 'complete') setTimeout(check, 4000);
  else window.addEventListener('load', function () { setTimeout(check, 4000); });
  // a clean start clears the flag so a later problem gets its one retry too
  window.addEventListener('load', function () { setTimeout(function () { if (started()) { try { sessionStorage.removeItem(FLAG); } catch (e) { /* ignore */ } } }, 5000); });
})();
