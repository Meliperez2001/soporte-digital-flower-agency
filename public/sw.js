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
const CACHE = 'soporte-dfa-v29';
const SHELL = ['/', '/index.html', '/styles.css?v=29', '/app.js?v=29', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

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

/* Notificaciones push (v24): el servidor avisa cuando hay un mensaje
   nuevo o un caso nuevo, aunque la app esté cerrada. Al tocar la
   notificación se enfoca la app (o se abre). El conteo de sin leer
   viaja en el aviso y se pone sobre el ícono de la app. */
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { /* aviso sin datos */ }
  const titulo = d.title || 'Soporte Digital Flower Agency';
  const opciones = {
    body: d.body || 'Tienes un mensaje nuevo.',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { casoId: d.casoId || null },
    tag: (d.llamada ? 'llamada-' : 'caso-') + (d.casoId || 'general'),
  };
  /* Aviso de llamada (v26): la notificación se queda en pantalla hasta
     que la toquen y vibra, pa' que se note que es una llamada y no un
     mensaje más. */
  if (d.llamada) {
    opciones.requireInteraction = true;
    opciones.vibrate = [300, 120, 300, 120, 300];
    opciones.renotify = true;
  }
  const tareas = [self.registration.showNotification(titulo, opciones)];
  try {
    if (d.sinLeer > 0 && self.registration.setAppBadge) tareas.push(self.registration.setAppBadge(d.sinLeer).catch(() => {}));
    else if (self.registration.clearAppBadge) tareas.push(self.registration.clearAppBadge().catch(() => {}));
  } catch (e) { /* la insignia es un extra */ }
  event.waitUntil(Promise.all(tareas));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  /* Al tocar la notificación se abre DIRECTAMENTE el caso del aviso
     (v26): la app lee el ?caso= al arrancar y entra a ese chat, donde
     está el botón «Llamar» pa' unirse. */
  const casoId = event.notification.data && event.notification.data.casoId;
  const destino = casoId ? '/?caso=' + encodeURIComponent(casoId) : '/';
  event.waitUntil((async () => {
    const lista = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of lista) {
      if ('navigate' in c) { try { await c.navigate(destino); } catch (e) { /* si no puede navegar, solo enfoca */ } }
      if ('focus' in c) return c.focus();
    }
    if (clients.openWindow) return clients.openWindow(destino);
  })());
});
