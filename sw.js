// ─── Temple Service Worker ────────────────────────────────────────────────
const CACHE_NAME = 'temple-v10';
const APP_SHELL = [
  './',
  './index.html',
  './app.html',
  './app.js',
  './auth.js',
  './manifest.json',
];

// Instalar: pre-cachear el app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// Activar: eliminar cachés antiguos
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Fetch: dejar pasar el backend y CDNs, cachear assets locales
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Dejar pasar siempre: peticiones al backend Railway y APIs externas
  const isBackend =
    event.request.method !== 'GET' ||
    url.hostname.includes('railway.app') ||
    url.hostname.includes('supabase.co') ||
    url.hostname.includes('googleapis.com');

  if (isBackend) return;

  // Recursos de CDN externos: Network-first con fallback a caché
  const isCDN =
    url.hostname.includes('cdn.tailwindcss.com') ||
    url.hostname.includes('cdn.jsdelivr.net');

  if (isCDN) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Assets locales: Cache-first con fallback a red
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});

// ─── Push notifications ────────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  const data = event.data?.json() ?? {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'Temple', {
      body:  data.body || '¿Has registrado lo que has comido hoy?',
      icon:  './icons/icon-192.png',
      badge: './icons/icon-192.png',
      tag:   'temple-reminder',
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow('./app.html'));
});
