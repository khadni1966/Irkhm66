// Khedni service worker: lets the app be installed and open without signal.
// Always asks the network first, so every update to the site reaches installed phones straight away.
var C = 'khedni-v2', SHELL = ['/', 'logo-light.png?v=4', 'icon-192.png'];
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
// phone notifications sent by the Khedni notification service (Firebase Cloud Messaging, data messages)
self.addEventListener('push', function (e) {
  var d = {}; try { d = e.data ? e.data.json() : {}; } catch (x) {}
  var p = d.data || {}, n = d.notification || {};
  var title = p.title || n.title || 'خدني', body = p.body || n.body || '';
  e.waitUntil(self.registration.showNotification(title, { body: body, icon: 'icon-192.png', badge: 'icon-192.png', tag: p.tag || undefined, renotify: !!p.tag, lang: 'ar', dir: 'rtl', data: { url: p.url || '/' } }));
});
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cs) {
    for (var i = 0; i < cs.length; i++) if ('focus' in cs[i]) return cs[i].focus();
    return self.clients.openWindow(url);
  }));
});
