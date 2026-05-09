/* 두근 트레이딩 service worker — 별도 PWA 알림 origin (두근컴퍼니와 분리) */
const VERSION = 'trading-v1';

self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(clients.claim()); });

// Web Push 수신
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}
  const title = data.title || '두근트레이딩';
  const body = data.body || '';
  const tag = data.tag || 'trading';
  const url = data.url || '/persona_unified.html';
  event.waitUntil(self.registration.showNotification(title, {
    body, tag, icon: '/manifest.json',
    badge: '/manifest.json',
    data: { url },
    requireInteraction: data.severity === 'danger',
    silent: false,
  }));
});

// 알림 클릭
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/persona_unified.html';
  event.waitUntil(clients.matchAll({ type: 'window' }).then(list => {
    for (const c of list) {
      if (c.url.includes(self.location.origin) && 'focus' in c) return c.focus();
    }
    return clients.openWindow(url);
  }));
});
