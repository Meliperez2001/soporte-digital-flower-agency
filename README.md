# 🌸 Soporte Digital Flower Agency

Plataforma privada de soporte y apelaciones de **Digital Flower Agency**.

Cada creadora se registra con su correo y contraseña, abre su caso con un
formulario y conversa en un **chat privado** con la administradora (Mell).
Nadie puede ver el caso de nadie: cada creadora solo ve lo suyo, y solo la
administradora ve todos los casos.

Es una **aplicación web instalable (PWA)**: se abre desde un link en el
navegador y se puede instalar en Windows, Android e iPhone con su icono,
sin pasar por ninguna tienda de aplicaciones y sin costo de tienda.

---

## Qué incluye

- **Registro e inicio de sesión** de creadoras con correo y contraseña
  (contraseñas cifradas con bcrypt; sesiones con JWT de 30 días).
- **Cuenta de administradora** para Mell: se crea sola en el primer
  arranque con las variables `ADMIN_EMAIL` y `ADMIN_PASSWORD`.
- **Formulario de caso**: qué le pasó, tipo de caso, si ya apeló o no,
  link del video sancionado (señalado como obligatorio cuando el caso es
  por un video) y su PPS (salud de la cuenta).
- **Chat privado por caso, tipo Discord**:
  - Enter envía el mensaje (Shift+Enter hace salto de línea).
  - Adjuntos: fotos, videos, documentos y PDF (máx. configurable, 25 MB).
  - Notas de voz grabadas desde el micrófono.
  - Stickers 🌸.
  - Los adjuntos también son privados: solo la dueña del caso y la
    administradora pueden abrirlos.
- **Panel de administradora**:
  - Casos separados por estado: **Nuevo, Esperando evidencia, Evidencia
    completa, Listos, Resuelto, Cerrado** (los casos se atienden al paso
    de Mell; no hay ningún día fijo).
  - Contador de **mensajes sin leer** y aviso en cada caso.
  - Clasificación de **gravedad**: Grave / No grave / Sin clasificar.
  - **Lista de evidencia** por caso: si ya indicó si apeló, link del
    video, PPS, y cuántas fotos, videos, documentos y audios ha enviado.
- **Diseño**: púrpura vivo `#751d95` con rosado suave y la flor 🌸,
  nombre "Soporte Digital Flower Agency", iconos 192/512/maskable y
  `display: standalone` (se abre como aplicación, sin barra del navegador).

## Tecnología

- Node.js + Express (sin frameworks pesados).
- Datos en un archivo JSON dentro de `DATA_DIR` y adjuntos como archivos
  en `DATA_DIR/uploads` (módulo `lib/store.js`: es el único punto a
  cambiar si algún día se migra a Postgres/SQLite).
- Frontend en HTML/CSS/JS puro, en `public/`, con manifiesto PWA y
  service worker.

## Variables de entorno

Copia `.env.example` a `.env` (en local) o configura estas variables en
tu servicio de hosting:

| Variable | Para qué |
|---|---|
| `PORT` | Puerto del servidor (el hosting lo asigna solo casi siempre). |
| `JWT_SECRET` | Secreto para firmar las sesiones. **Pon una frase larga y aleatoria, solo tuya.** |
| `ADMIN_EMAIL` | Correo de la administradora (Mell). |
| `ADMIN_PASSWORD` | Contraseña de la administradora. Se usa solo la primera vez, para crear la cuenta. |
| `ADMIN_NAME` | Nombre que se muestra de la administradora (por defecto "Mell"). |
| `DATA_DIR` | Carpeta de datos (base de datos + adjuntos). Apúntala al disco persistente/volumen de tu hosting. Si no se define, usa `./data`. |
| `MAX_FILE_MB` | Tamaño máximo por adjunto (por defecto 25). |

## Correr en tu computadora (para probar)

```bash
npm install
cp .env.example .env   # edita .env y pon tus valores
npm start              # http://localhost:3000
```

## Cómo publicarla (gratis)

> ⚠️ Importante: la app guarda datos y archivos en disco, así que
> necesita un hosting con **disco persistente**. Por eso se recomienda
> Railway o Render con disco. **No** sirve tal cual en Vercel/Netlify
> (son sin servidor y el disco se borra); ahí habría que migrar primero
> la base de datos y los adjuntos a un servicio externo.

### Opción recomendada: Railway (el mismo que ya usa Vox)

1. Sube esta carpeta a un repositorio de GitHub.
2. En Railway: **New Project → Deploy from GitHub repo** y elige el repo.
3. En **Settings → Volumes** (o "Add Volume"), agrega un volumen montado
   en `/data`.
4. En **Variables**, agrega: `JWT_SECRET`, `ADMIN_EMAIL`,
   `ADMIN_PASSWORD`, `ADMIN_NAME` y `DATA_DIR=/data`.
5. Railway detecta Node, corre `npm install` y `npm start` solo, y te da
   un link público (tipo `https://soporte-....up.railway.app`). Ese es
   **el link para todo el mundo**: Mell lo abre en su laptop y las
   creadoras en su teléfono.

### Opción 2: Render

1. Sube la carpeta a GitHub.
2. En Render: **New → Web Service**, elige el repo, comando de arranque
   `npm start`.
3. En **Disks**, agrega un disco montado en `/data`.
4. En **Environment**, las mismas variables de arriba, con
   `DATA_DIR=/data`.

### Después de publicar: instalar la aplicación

- **Windows (laptop de Mell)**: abre el link en Chrome o Edge → botón
  **"Instalar la aplicación"** dentro de la página (o el icono de
  instalar en la barra de direcciones). Queda en el escritorio con su
  icono púrpura y se abre en su propia ventana.
- **Android**: abre el link en Chrome → "Instalar la aplicación".
- **iPhone**: abre el link en Safari → Compartir → **Añadir a pantalla
  de inicio**.

Los cambios futuros se aplican actualizando el código en el hosting; la
aplicación instalada se actualiza sola al abrirla, nadie tiene que
descargarla de nuevo.

## Respaldo de los datos

Todo vive en la carpeta `DATA_DIR`: el archivo `db.json` (usuarios,
casos y mensajes) y la carpeta `uploads` (adjuntos). Para respaldar,
copia esa carpeta. Para empezar de cero, bórrala (la cuenta de
administradora se vuelve a crear con las variables de entorno).

## Notas

- La plataforma **empieza vacía**: los casos de la plataforma anterior
  no se pasan solos; cada creadora abre el suyo aquí.
- Una creadora conserva el acceso a su caso con su cuenta (correo y
  contraseña), desde cualquier teléfono o navegador.
- Si Mell deja la agencia algún día, la app es suya: vive en su cuenta
  del hosting y se borra desde ahí cuando ella quiera.
