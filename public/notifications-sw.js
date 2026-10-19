// Notification delivery/clicks only: no fetch interception, caching or push.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const path = event.notification.data?.url;
  if (typeof path !== "string" || !/^\/agents(?:\/[^/?#]+)?$/.test(path)) return;
  const url = new URL(path, self.location.origin).href;
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const client = clients.find(client => {
      const location = new URL(client.url);
      return location.origin === self.location.origin &&
        (location.pathname === "/" || /^\/(?:agents|apps)(?:\/|$)/.test(location.pathname));
    });
    if (client) {
      // In-page routing preserves drafts and the private-handoff navigation guard.
      client.postMessage({ type: "jelly:notification-open", url: path });
      await client.focus();
    } else await self.clients.openWindow(url);
  })());
});
