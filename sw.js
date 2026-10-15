// Service Worker: Lifecycle - Install immediately
self.addEventListener('install', (event) => {
  self.skipWaiting(); // Activate new SW without waiting for old one to expire
});

// Service Worker: Lifecycle - Claim all clients immediately on activation
self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

// Service Worker: Handle incoming push notifications
self.addEventListener('push', function(event) {
  let data = {};
  // Wrap json() parse in try/catch to prevent SW crash on malformed payload
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      // Fallback: treat raw text as the notification body
      data = { title: 'Smart Queue Alert', body: event.data.text() };
    }
  }

  const options = {
    body: data.body || 'Please check your queue status.',
    icon: 'https://cdn-icons-png.flaticon.com/512/1828/1828970.png',
    badge: 'https://cdn-icons-png.flaticon.com/512/1828/1828970.png',
    vibrate: [300, 100, 300, 100, 300],
    requireInteraction: true,
    data: { url: (data && data.url) ? data.url : '/mobile.html' }
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'Smart Queue Alert', options)
  );
});

// Service Worker: Notification Click Recovery
self.addEventListener('notificationclick', function(event) {
  event.notification.close();

  const targetUrl = (event.notification.data && event.notification.data.url) ? event.notification.data.url : '/mobile.html';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(windowClients) {
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        if (client.url && client.url.includes('mobile.html') && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});