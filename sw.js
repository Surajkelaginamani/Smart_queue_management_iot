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
    vibrate: [200, 100, 200],
    requireInteraction: true,
    data: { url: '/' } // Task 1 requirement: added data: { url: '/' }
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'Smart Queue Alert', options)
  );
});

// Service Worker: Notification Click Recovery (Task 1)
self.addEventListener('notificationclick', function(event) {
  // 1. Close notification
  event.notification.close();

  const targetUrl = (event.notification.data && event.notification.data.url) ? event.notification.data.url : '/';

  // 2. Check if a tab is already open using clients.matchAll({ type: 'window' })
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(windowClients) {
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        if ('focus' in client) {
          return client.focus();
        }
      }
      // If no tab is open, open a new one
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});