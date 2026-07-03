// DEMO: no-op service worker — unregisters itself and clears caches.
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) await caches.delete(k);
  await self.registration.unregister();
  const cs = await self.clients.matchAll(); cs.forEach(c => c.navigate(c.url));
})()));
