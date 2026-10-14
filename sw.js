// Khedni service worker: lets the app be installed and open without signal.
// Always asks the network first, so every update to the site reaches installed phones straight away.
var C = 'khedni-v1', SHELL = ['/', 'logo-light.png?v=4', 'icon-192.png'];
self.addEventListener('install', function (e) { e.waitUntil(caches.open(C).then(function (c) { return c.addAll(SHELL); }).catch(function () {})); self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== C; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); })); });
self.addEventListener('fetch', function (e) {
  var r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin) return; // Firebase, Google Maps and the rest go straight to the network
  e.respondWith(fetch(r).then(function (res) {
    if (res.ok && (r.mode === 'navigate' || SHELL.indexOf(u.pathname.slice(1) + u.search) >= 0)) { var cp = res.clone(); caches.open(C).then(function (c) { c.put(r.mode === 'navigate' ? '/' : r, cp); }); }
    return res;
  }).catch(function () { return caches.match(r.mode === 'navigate' ? '/' : r); }));
});
