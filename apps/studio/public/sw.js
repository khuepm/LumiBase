/* eslint-disable no-restricted-globals */
/**
 * LumiBase Studio service worker (push-noti feature).
 *
 * Sole responsibility is Web Push: render an OS notification when the push
 * service wakes us, and route a click back into the SPA. The encrypted payload
 * is the JSON `AgentNotification` emitted by the CMS notification broadcaster.
 *
 * Intentionally has no fetch/caching handler — Studio is not a PWA/offline app;
 * adding a cache here would risk serving stale bundles.
 */

self.addEventListener('install', () => {
  // Activate immediately so a freshly registered worker can receive pushes.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: 'LumiBase', body: event.data.text() };
  }

  const title = data.title || 'LumiBase';
  const options = {
    body: data.body || '',
    // Coalesce repeats of the same entity into one notification.
    tag: data.id || data.entityId || undefined,
    renotify: Boolean(data.id || data.entityId),
    data: { deepLink: data.deepLink || '/', kind: data.kind || null },
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    timestamp: data.ts ? Date.parse(data.ts) : Date.now(),
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const deepLink = (event.notification.data && event.notification.data.deepLink) || '/';

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // Prefer focusing an already-open Studio tab over opening a new one.
      for (const client of windows) {
        if ('focus' in client) {
          await client.focus();
          if ('navigate' in client && deepLink) {
            try {
              await client.navigate(deepLink);
            } catch {
              /* cross-origin or blocked navigation — leave the tab as-is */
            }
          }
          return;
        }
      }
      if (self.clients.openWindow) {
        await self.clients.openWindow(deepLink);
      }
    })(),
  );
});
