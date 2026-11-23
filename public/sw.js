/* Service worker de Soporte Digital Flower Agency.
   La app es en vivo: la API y los adjuntos SIEMPRE van a la red.
   La carcasa (HTML, CSS, JS, iconos) va RED PRIMERO y el caché solo es
   respaldo si no hay conexión: así, tras cada despliegue, la computadora
   y el teléfono reciben enseguida la versión nueva en vez de quedarse
   con la anterior guardada en caché. */
const CACHE = 'soporte-dfa-v16';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  /* Datos en vivo: nunca desde el caché */
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) return;
  /* Carcasa: red primero; si la red falla, el caché guardado. Cada
     respuesta buena de la red refresca el caché. */
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok) {
          const copia = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copia));
        }
        return r;
      })
      .catch(() => caches.match(e.request))
  );
});
