/* Service worker de Soporte Digital Flower Agency.
   La app es en vivo: la API y los adjuntos SIEMPRE van a la red.
   La carcasa (HTML, CSS, JS, iconos) va RED PRIMERO y el caché solo es
   respaldo si no hay conexión: así, tras cada despliegue, la computadora
   y el teléfono reciben enseguida la versión nueva en vez de quedarse
   con la anterior guardada en caché.
   Actualización a la fuerza (v17): el fetch de la carcasa va con
   cache:'reload' —red real, saltándose la caché HTTP— porque el fetch
   por defecto puede resolver desde la caché HTTP sin tocar la red, y
   en el iPhone de Mell la app seguía cargando versiones viejas
   MEZCLADAS (HTML nuevo con el CSS de dos versiones atrás) aunque se
   cerrara y se reinstalara el acceso. El servidor además sirve la
   carcasa con Cache-Control: no-store, y el index referencia el CSS y
   el JS con ?v=NN para romper cualquier copia vieja al cambiar de
   versión. Flujo al llegar un SW nuevo: skipWaiting al instalar,
   borrado de los cachés viejos al activar y clients.claim. */
const CACHE = 'soporte-dfa-v18';
const SHELL = ['/', '/index.html', '/styles.css?v=18', '/app.js?v=18', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

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
  /* Carcasa: red primero DE VERDAD (cache:'reload' salta la caché HTTP
     y va siempre a la red); si la red falla, el caché guardado. Cada
     respuesta buena de la red refresca el caché. */
  e.respondWith(
    fetch(e.request, { cache: 'reload' })
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
