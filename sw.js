const CACHE = 'neatmark-dashboard-v1';

const PRECACHE = [
  '/admin',
  '/assets/dashboard.css',
  '/assets/dashboard.js',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/assets/favicon.svg',
  'https://fonts.googleapis.com/css2?family=Mona+Sans:wght@400;500;600;700;800;900&display=swap'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // API / Supabase / Netlify functions — always network-first, never cache
  if (
    url.pathname.startsWith('/.netlify/functions/') ||
    url.hostname.includes('supabase') ||
    url.hostname.includes('netlify')
  ) {
    return; // Let browser handle it normally
  }

  // Shell assets — cache-first
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);
    })
  );
});
