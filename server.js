'use strict';
/**
 * Soporte Digital Flower Agency — servidor.
 * Plataforma privada de casos de apelación: registro de creadoras,
 * casos privados con chat (texto, fotos, videos, documentos, PDF,
 * notas de voz y stickers) y panel de administradora.
 */
require('./lib/env');
const path = require('path');
const fs = require('fs');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { db, save, nextId, UPLOADS_DIR, AVATARS_DIR } = require('./lib/store');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'secreto-de-desarrollo-cambialo';
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 25);

const app = express();
app.use(express.json({ limit: '2mb' }));

/* ------------------------------------------------------------------ */
/* Constantes del negocio                                              */
/* ------------------------------------------------------------------ */
const ESTADOS = ['nuevo', 'esperando_evidencia', 'evidencia_completa', 'listos', 'resuelto', 'cerrado'];
const ESTADO_LABELS = {
  nuevo: 'Nuevo',
  esperando_evidencia: 'Esperando evidencia',
  evidencia_completa: 'Evidencia completa',
  listos: 'Listos',
  resuelto: 'Resuelto',
  cerrado: 'Cerrado',
};
const GRAVEDADES = ['grave', 'no_grave', 'sin_clasificar'];
const TIPOS_CASO = ['apelar', 'suspension', 'puntos', 'fondos', 'funciones', 'otro'];

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */
function publicUser(u) {
  return { id: u.id, nombre: u.nombre, email: u.email, tiktok: u.tiktok || '', rol: u.rol, foto: u.foto || null };
}
/** Foto de perfil de una usuaria (o null si usa el avatar de iniciales). */
function fotoDe(userId) {
  const u = db.users.find((x) => x.id === userId);
  return u ? u.foto || null : null;
}
function findUserByEmail(email) {
  return db.users.find((u) => u.email === String(email || '').toLowerCase().trim());
}
function sign(user) {
  return jwt.sign({ uid: user.id, rol: user.rol }, JWT_SECRET, { expiresIn: '30d' });
}
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Inicia sesión para continuar.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.users.find((u) => u.id === payload.uid);
    if (!user) return res.status(401).json({ error: 'Sesión no válida.' });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Sesión expirada, vuelve a iniciar sesión.' });
  }
}
function soloAdmin(req, res, next) {
  if (req.user.rol !== 'admin') return res.status(403).json({ error: 'Solo la administradora puede hacer esto.' });
  next();
}
/** Un caso solo lo ve su creadora o la administradora. Nadie más. */
function puedeVerCaso(user, caso) {
  return user.rol === 'admin' || caso.creadoraId === user.id;
}
function getCasoVisible(req, res) {
  const caso = db.cases.find((c) => c.id === Number(req.params.id));
  if (!caso || !puedeVerCaso(req.user, caso)) {
    res.status(404).json({ error: 'Caso no encontrado.' });
    return null;
  }
  return caso;
}
function casoResumen(caso) {
  /* Los mensajes borrados no cuentan ni se anuncian: para la lista es
     como si nunca hubieran existido. */
  const msgs = db.messages.filter((m) => m.casoId === caso.id && !m.eliminado);
  const ultimo = msgs[msgs.length - 1] || null;
  return {
    ...caso,
    creadoraFoto: fotoDe(caso.creadoraId),
    totalMensajes: msgs.length,
    sinLeerAdmin: msgs.filter((m) => m.autor === 'creadora' && !m.leidoAdmin).length,
    sinLeerCreadora: msgs.filter((m) => m.autor !== 'creadora' && !m.leidoCreadora).length,
    ultimoMensaje: ultimo
      ? {
          tipo: ultimo.tipo,
          texto: ultimo.texto ? ultimo.texto.slice(0, 80) : '',
          createdAt: ultimo.createdAt,
        }
      : null,
  };
}
function evidenciaDe(caso) {
  const msgs = db.messages.filter((m) => m.casoId === caso.id);
  const adjuntos = msgs.filter((m) => (m.tipo === 'archivo' || m.tipo === 'audio') && !m.eliminado);
  return {
    linkVideo: Boolean(caso.linkVideo),
    pps: Boolean(caso.pps),
    yaApelo: caso.yaApelo === 'si' || caso.yaApelo === 'no',
    fotos: adjuntos.filter((m) => (m.mime || '').startsWith('image/')).length,
    videos: adjuntos.filter((m) => (m.mime || '').startsWith('video/')).length,
    documentos: adjuntos.filter(
      (m) => m.tipo === 'archivo' && !(m.mime || '').startsWith('image/') && !(m.mime || '').startsWith('video/')
    ).length,
    audios: adjuntos.filter((m) => m.tipo === 'audio').length,
  };
}

/* ------------------------------------------------------------------ */
/* Cuenta de administradora (se crea sola en el primer arranque)       */
/* ------------------------------------------------------------------ */
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();
/** La cuenta administradora principal es la del correo de ADMIN_EMAIL:
    no se puede degradar ni cambiar su rol desde la app. */
function esAdminPrincipal(u) {
  return Boolean(ADMIN_EMAIL) && Boolean(u) && u.email === ADMIN_EMAIL;
}
(function seedAdmin() {
  const email = ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email || !password) {
    console.warn('⚠️  ADMIN_EMAIL / ADMIN_PASSWORD no definidos: no se creó la cuenta de administradora.');
    return;
  }
  if (!findUserByEmail(email)) {
    db.users.push({
      id: nextId('user'),
      nombre: process.env.ADMIN_NAME || 'Mell',
      email,
      tiktok: '',
      foto: null,
      rol: 'admin',
      passwordHash: bcrypt.hashSync(password, 10),
      createdAt: new Date().toISOString(),
    });
    save();
    console.log('✔ Cuenta de administradora creada para', email);
  }
})();

/* ------------------------------------------------------------------ */
/* Autenticación                                                       */
/* ------------------------------------------------------------------ */
app.post('/api/register', async (req, res) => {
  const { nombre, email, password, tiktok } = req.body || {};
  if (!nombre || !email || !password) return res.status(400).json({ error: 'Faltan datos: nombre, correo y contraseña.' });
  if (String(password).length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });
  const limpio = String(email).toLowerCase().trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(limpio)) return res.status(400).json({ error: 'Ese correo no se ve válido.' });
  if (findUserByEmail(limpio)) return res.status(409).json({ error: 'Ya existe una cuenta con ese correo. Inicia sesión.' });
  const user = {
    id: nextId('user'),
    nombre: String(nombre).trim(),
    email: limpio,
    tiktok: String(tiktok || '').trim(),
    foto: null,
    rol: 'creadora',
    passwordHash: bcrypt.hashSync(String(password), 10),
    createdAt: new Date().toISOString(),
  };
  db.users.push(user);
  save();
  res.json({ token: sign(user), user: publicUser(user) });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  const user = findUserByEmail(email);
  if (!user || !bcrypt.compareSync(String(password || ''), user.passwordHash)) {
    return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
  }
  res.json({ token: sign(user), user: publicUser(user) });
});

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

/* Versión pública de la app (v21): la consulta el actualizador
   automático del cliente pa' saber si el servidor ya va por una
   versión más nueva que la copia instalada. Debe coincidir con
   APP_VERSION de public/app.js; ambas se suben juntas en cada
   despliegue. Es solo una etiqueta, sin datos de nadie. */
const APP_VERSION = 'v21';
app.get('/api/version', (req, res) => res.json({ version: APP_VERSION }));

/* ------------------------------------------------------------------ */
/* Mi perfil: nombre y foto                                            */
/* ------------------------------------------------------------------ */
const MAX_FOTO_MB = 5;
const FOTO_EXT_POR_MIME = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const uploadFoto = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, AVATARS_DIR),
    filename: (req, file, cb) => {
      const ext = FOTO_EXT_POR_MIME[file.mimetype] || '.jpg';
      cb(null, `avatar-${req.user.id}-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: MAX_FOTO_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (FOTO_EXT_POR_MIME[file.mimetype]) return cb(null, true);
    cb(new Error('La foto tiene que ser una imagen (JPG, PNG, WebP o GIF).'));
  },
});

/** Cambiar el nombre visible (y el @ de TikTok) del perfil propio. */
app.patch('/api/profile', auth, (req, res) => {
  const { nombre, tiktok } = req.body || {};
  if (nombre !== undefined) {
    const limpio = String(nombre).trim().slice(0, 80);
    if (!limpio) return res.status(400).json({ error: 'El nombre no puede quedar vacío.' });
    req.user.nombre = limpio;
    // El nombre nuevo se refleja también en sus casos abiertos
    for (const c of db.cases) if (c.creadoraId === req.user.id) c.creadoraNombre = limpio;
  }
  if (tiktok !== undefined) {
    req.user.tiktok = String(tiktok).trim().slice(0, 60);
    for (const c of db.cases) if (c.creadoraId === req.user.id) c.creadoraTiktok = req.user.tiktok;
  }
  save();
  res.json({ user: publicUser(req.user) });
});

/** Subir o cambiar la foto de perfil (solo imágenes, máx. 5 MB). */
app.post('/api/profile/foto', auth, (req, res) => {
  uploadFoto.single('foto')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `La foto es muy grande: el máximo es ${MAX_FOTO_MB} MB.`
        : err.message || 'No se pudo subir la foto.';
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'No llegó ninguna foto.' });
    const anterior = req.user.foto;
    req.user.foto = '/uploads/avatars/' + req.file.filename;
    save();
    // Borrar la foto anterior para no acumular archivos viejos
    if (anterior && anterior.startsWith('/uploads/avatars/')) {
      fs.unlink(path.join(AVATARS_DIR, path.basename(anterior)), () => {});
    }
    res.json({ user: publicUser(req.user) });
  });
});

/* ------------------------------------------------------------------ */
/* Casos                                                               */
/* ------------------------------------------------------------------ */
app.post('/api/cases', auth, (req, res) => {
  if (req.user.rol === 'admin') return res.status(403).json({ error: 'La administradora no abre casos.' });
  const { titulo, tipo, descripcion, yaApelo, linkVideo, pps } = req.body || {};
  if (!descripcion || !String(descripcion).trim()) {
    return res.status(400).json({ error: 'Cuéntanos qué te pasó para poder abrir el caso.' });
  }
  const caso = {
    id: nextId('caso'),
    creadoraId: req.user.id,
    creadoraNombre: req.user.nombre,
    creadoraTiktok: req.user.tiktok || '',
    titulo: String(titulo || 'Mi caso').trim().slice(0, 120),
    tipo: TIPOS_CASO.includes(tipo) ? tipo : 'otro',
    descripcion: String(descripcion).trim(),
    yaApelo: yaApelo === 'si' ? 'si' : yaApelo === 'no' ? 'no' : '',
    linkVideo: String(linkVideo || '').trim(),
    pps: String(pps || '').trim(),
    estado: 'nuevo',
    gravedad: 'sin_clasificar',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  db.cases.push(caso);
  // El primer mensaje del chat es la descripción del caso
  db.messages.push({
    id: nextId('msg'),
    casoId: caso.id,
    autor: 'creadora',
    autorId: req.user.id,
    autorNombre: req.user.nombre,
    tipo: 'texto',
    texto: caso.descripcion,
    createdAt: caso.createdAt,
    leidoAdmin: false,
    leidoCreadora: true,
  });
  save();
  res.json({ caso: casoResumen(caso) });
});

app.get('/api/cases', auth, (req, res) => {
  const visibles =
    req.user.rol === 'admin' ? db.cases : db.cases.filter((c) => c.creadoraId === req.user.id);
  const lista = visibles
    .slice()
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .map(casoResumen);
  res.json({ casos: lista });
});

app.get('/api/cases/:id', auth, (req, res) => {
  const caso = getCasoVisible(req, res);
  if (!caso) return;
  res.json({ caso: { ...caso, creadoraFoto: fotoDe(caso.creadoraId), evidencia: evidenciaDe(caso) } });
});

app.patch('/api/cases/:id', auth, soloAdmin, (req, res) => {
  const caso = getCasoVisible(req, res);
  if (!caso) return;
  const { estado, gravedad } = req.body || {};
  if (estado && ESTADOS.includes(estado)) caso.estado = estado;
  if (gravedad && GRAVEDADES.includes(gravedad)) caso.gravedad = gravedad;
  caso.updatedAt = new Date().toISOString();
  save();
  res.json({ caso: casoResumen(caso) });
});

/** Eliminar un caso completo (solo la administradora): borra el caso, sus
    mensajes y los archivos adjuntos guardados en disco. */
app.delete('/api/cases/:id', auth, soloAdmin, (req, res) => {
  const caso = getCasoVisible(req, res);
  if (!caso) return;
  const msgs = db.messages.filter((m) => m.casoId === caso.id);
  for (const m of msgs) {
    if (m.archivo && m.archivo.startsWith('/uploads/')) {
      fs.unlink(path.join(UPLOADS_DIR, path.basename(m.archivo)), () => {});
    }
  }
  db.messages = db.messages.filter((m) => m.casoId !== caso.id);
  db.cases = db.cases.filter((c) => c.id !== caso.id);
  save();
  res.json({ ok: true });
});

/** La creadora puede completar datos de su caso (link del video, PPS, si ya apeló) */
app.patch('/api/cases/:id/datos', auth, (req, res) => {
  const caso = getCasoVisible(req, res);
  if (!caso) return;
  if (req.user.rol !== 'admin' && caso.creadoraId !== req.user.id) {
    return res.status(403).json({ error: 'Este no es tu caso.' });
  }
  const { linkVideo, pps, yaApelo } = req.body || {};
  if (linkVideo !== undefined) caso.linkVideo = String(linkVideo).trim();
  if (pps !== undefined) caso.pps = String(pps).trim();
  if (yaApelo === 'si' || yaApelo === 'no') caso.yaApelo = yaApelo;
  caso.updatedAt = new Date().toISOString();
  save();
  res.json({ caso: { ...caso, evidencia: evidenciaDe(caso) } });
});

/* ------------------------------------------------------------------ */
/* Mensajes del chat                                                   */
/* ------------------------------------------------------------------ */
app.get('/api/cases/:id/messages', auth, (req, res) => {
  const caso = getCasoVisible(req, res);
  if (!caso) return;
  /* Los mensajes eliminados (con el borrado viejo quedaban marcados) ya
     no se sirven a nadie: en el chat no queda ni el aviso. */
  const msgs = db.messages
    .filter((m) => m.casoId === caso.id && !m.eliminado)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  // Marcar como leídos los mensajes de la otra parte
  let cambio = false;
  for (const m of msgs) {
    if (req.user.rol === 'admin' && m.autor === 'creadora' && !m.leidoAdmin) { m.leidoAdmin = true; cambio = true; }
    if (req.user.rol !== 'admin' && m.autor !== 'creadora' && !m.leidoCreadora) { m.leidoCreadora = true; cambio = true; }
  }
  if (cambio) save();
  // Cada mensaje lleva la foto de perfil actual de quien lo escribió
  res.json({ mensajes: msgs.map((m) => ({ ...m, autorFoto: fotoDe(m.autorId) })) });
});

/** Extracto corto de un mensaje, para citarlo al responder (tipo WhatsApp).
    Se guarda una copia (snapshot) en el mensaje nuevo: si el original se
    borra después, la cita sigue viéndose. */
function extractoDe(m) {
  if (m.eliminado) return 'Mensaje eliminado';
  if (m.tipo === 'texto') return String(m.texto || '').slice(0, 120);
  if (m.tipo === 'sticker') return '🌸 Sticker';
  if (m.tipo === 'audio') return '🎤 Nota de voz';
  if ((m.mime || '').startsWith('image/')) return '🖼️ Foto';
  if ((m.mime || '').startsWith('video/')) return '🎬 Video';
  return '📄 ' + (m.nombreArchivo || 'Documento');
}
/** Si el cuerpo trae respuestaA (id de mensaje del mismo caso), construye
    la cita; si no, devuelve null. */
function citaDesde(req, caso) {
  const id = Number((req.body || {}).respuestaA);
  if (!id) return null;
  const orig = db.messages.find((m) => m.id === id && m.casoId === caso.id);
  if (!orig) return null;
  return { id: orig.id, autorNombre: orig.autorNombre || '', texto: extractoDe(orig) };
}

function guardarMensaje(req, res, datos) {
  const caso = getCasoVisible(req, res);
  if (!caso) return null;
  const msg = {
    id: nextId('msg'),
    casoId: caso.id,
    autor: req.user.rol === 'admin' ? 'admin' : 'creadora',
    autorId: req.user.id,
    autorNombre: req.user.nombre,
    createdAt: new Date().toISOString(),
    leidoAdmin: req.user.rol === 'admin',
    leidoCreadora: req.user.rol !== 'admin',
    ...datos,
  };
  const cita = citaDesde(req, caso);
  if (cita) msg.respuesta = cita;
  db.messages.push(msg);
  caso.updatedAt = msg.createdAt;
  if (caso.estado === 'nuevo' && req.user.rol === 'admin') caso.estado = 'esperando_evidencia';
  save();
  res.json({ mensaje: msg });
  return msg;
}

app.post('/api/cases/:id/messages', auth, (req, res) => {
  const { texto, sticker } = req.body || {};
  if (sticker) return void guardarMensaje(req, res, { tipo: 'sticker', texto: String(sticker).slice(0, 8) });
  if (!texto || !String(texto).trim()) return res.status(400).json({ error: 'El mensaje está vacío.' });
  guardarMensaje(req, res, { tipo: 'texto', texto: String(texto).trim().slice(0, 4000) });
});

/** Reacciones a un mensaje (v20, pedido de Mell el 25/11/2026): tocar de
    nuevo la misma reacción la quita (toggle). Solo se aceptan ❤️ y 😂.
    Se guardan en el propio mensaje como { emoji: [ids de usuario] } y
    viajan con la lista de mensajes, así ambas partes las ven. */
const REACCIONES_OK = ['❤️', '😂'];
app.post('/api/cases/:id/messages/:mid/reaccion', auth, (req, res) => {
  const caso = getCasoVisible(req, res);
  if (!caso) return;
  const emoji = String((req.body || {}).emoji || '');
  if (!REACCIONES_OK.includes(emoji)) return res.status(400).json({ error: 'Reacción no válida.' });
  const msg = db.messages.find((m) => m.id === Number(req.params.mid) && m.casoId === caso.id && !m.eliminado);
  if (!msg) return res.status(404).json({ error: 'Mensaje no encontrado.' });
  if (!msg.reacciones || typeof msg.reacciones !== 'object') msg.reacciones = {};
  const lista = Array.isArray(msg.reacciones[emoji]) ? msg.reacciones[emoji] : [];
  const i = lista.indexOf(req.user.id);
  if (i === -1) lista.push(req.user.id); else lista.splice(i, 1);
  if (lista.length) msg.reacciones[emoji] = lista; else delete msg.reacciones[emoji];
  save();
  res.json({ reacciones: msg.reacciones });
});

/** Eliminar un mensaje PARA TODOS: lo puede borrar quien lo escribió o
    la administradora. El mensaje desaparece por completo del caso y deja
    de servirse a ambas partes (sin burbuja de "mensaje eliminado"), y se
    quita también la cita de los mensajes que lo respondían, para que no
    quede visible ni el extracto de lo borrado. */
app.delete('/api/cases/:id/messages/:mid', auth, (req, res) => {
  const caso = getCasoVisible(req, res);
  if (!caso) return;
  const idx = db.messages.findIndex((m) => m.id === Number(req.params.mid) && m.casoId === caso.id);
  if (idx === -1) return res.status(404).json({ error: 'Mensaje no encontrado.' });
  const msg = db.messages[idx];
  if (req.user.rol !== 'admin' && msg.autorId !== req.user.id) {
    return res.status(403).json({ error: 'Solo puedes eliminar tus propios mensajes.' });
  }
  if (msg.archivo && msg.archivo.startsWith('/uploads/')) {
    fs.unlink(path.join(UPLOADS_DIR, path.basename(msg.archivo)), () => {});
  }
  db.messages.splice(idx, 1);
  for (const m of db.messages) {
    if (m.casoId === caso.id && m.respuesta && m.respuesta.id === msg.id) delete m.respuesta;
  }
  save();
  res.json({ ok: true });
});

/* Adjuntos: fotos, videos, documentos, PDF y notas de voz */
/* Extensión según el formato REAL del archivo. Es clave para las notas de
   voz del iPhone: iOS/Safari graba en MP4/AAC, pero el cliente guardaba
   todo como ".webm"; el archivo quedaba con contenido MP4 y extensión y
   tipo WebM, y el iPhone no lo podía reproducir (daba error al abrirlo).
   En Chrome/Escritorio la grabación sí es WebM y se guarda como .webm. */
const EXT_POR_MIME = {
  'audio/webm': '.webm', 'audio/mp4': '.m4a', 'audio/m4a': '.m4a', 'audio/x-m4a': '.m4a',
  'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/aac': '.aac',
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  'application/pdf': '.pdf',
};
/** Tipo sin parámetros: 'audio/webm;codecs=opus' → 'audio/webm'. */
function mimeLimpio(m) {
  return String(m || '').split(';')[0].trim().toLowerCase();
}
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const mime = mimeLimpio(file.mimetype);
      let ext = path.extname(file.originalname || '').slice(0, 10).toLowerCase();
      /* En los audios manda el formato real, no el nombre que traiga el
         archivo; y si no hay extensión usable, se deriva del tipo. */
      if (mime.startsWith('audio/') && EXT_POR_MIME[mime]) ext = EXT_POR_MIME[mime];
      else if (!ext && EXT_POR_MIME[mime]) ext = EXT_POR_MIME[mime];
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 9)}${ext}`);
    },
  }),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
});

app.post('/api/cases/:id/upload', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No llegó ningún archivo.' });
  const mime = mimeLimpio(req.file.mimetype);
  const esAudio = mime.startsWith('audio/');
  guardarMensaje(req, res, {
    tipo: esAudio ? 'audio' : 'archivo',
    texto: '',
    archivo: '/uploads/' + req.file.filename,
    nombreArchivo: req.file.originalname,
    mime,
  });
});

/* Los adjuntos también son privados: solo la dueña del caso o la admin.
   Se acepta el token por query (?token=) porque las etiquetas <img>/<audio>
   no pueden enviar la cabecera Authorization. */
function authFlexible(req, res, next) {
  if (!req.headers.authorization && req.query.token) {
    req.headers.authorization = 'Bearer ' + req.query.token;
  }
  auth(req, res, next);
}
/* Las fotos de perfil se ven entre la creadora y la administradora de un
   caso, así que basta con estar autenticada para verlas (no son públicas:
   sin sesión no se sirven). */
app.get('/uploads/avatars/:name', authFlexible, (req, res) => {
  const name = path.basename(req.params.name);
  const duena = db.users.find((u) => u.foto === '/uploads/avatars/' + name);
  if (!duena) return res.status(404).end();
  const file = path.join(AVATARS_DIR, name);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.sendFile(file);
});

app.get('/uploads/:name', authFlexible, (req, res) => {
  const name = path.basename(req.params.name);
  const msg = db.messages.find((m) => m.archivo === '/uploads/' + name);
  if (!msg) return res.status(404).end();
  const caso = db.cases.find((c) => c.id === msg.casoId);
  if (!caso || !puedeVerCaso(req.user, caso)) return res.status(403).end();
  const file = path.join(UPLOADS_DIR, name);
  if (!fs.existsSync(file)) return res.status(404).end();
  /* Las notas de voz se sirven con su tipo real (audio/mp4 en iPhone,
     audio/webm en Chrome), no con el que adivina la extensión: un .m4a
     servido como video/webm no suena en Safari. sendFile respeta el
     Content-Type si ya viene fijado. */
  if (msg.tipo === 'audio' && msg.mime) res.type(mimeLimpio(msg.mime));
  res.sendFile(file);
});

/* ------------------------------------------------------------------ */
/* Panel de administradora: resumen                                    */
/* ------------------------------------------------------------------ */
app.get('/api/admin/resumen', auth, soloAdmin, (req, res) => {
  const porEstado = {};
  for (const e of ESTADOS) porEstado[e] = 0;
  let sinLeer = 0;
  for (const c of db.cases) {
    porEstado[c.estado] = (porEstado[c.estado] || 0) + 1;
  }
  sinLeer = db.messages.filter((m) => m.autor === 'creadora' && !m.leidoAdmin && !m.eliminado).length;
  res.json({ porEstado, sinLeer, totalCasos: db.cases.length, labels: ESTADO_LABELS });
});

/* ------------------------------------------------------------------ */
/* Panel de administradora: usuarias y roles                           */
/* Una administradora puede promover a otra usuaria a administradora   */
/* (verá todos los casos, igual que la principal) o quitarle el rol.   */
/* La cuenta principal (la del correo ADMIN_EMAIL) no se puede         */
/* degradar ni cambiar desde la app. Los permisos se verifican aquí,   */
/* en el servidor: una creadora ni siquiera puede leer la lista.       */
/* ------------------------------------------------------------------ */
app.get('/api/admin/usuarios', auth, soloAdmin, (req, res) => {
  const usuarias = db.users
    .slice()
    .sort((a, b) => (a.rol === b.rol ? a.nombre.localeCompare(b.nombre) : a.rol === 'admin' ? -1 : 1))
    .map((u) => ({ ...publicUser(u), esPrincipal: esAdminPrincipal(u), createdAt: u.createdAt }));
  res.json({ usuarias });
});

app.patch('/api/admin/usuarios/:id/rol', auth, soloAdmin, (req, res) => {
  const { rol } = req.body || {};
  if (rol !== 'admin' && rol !== 'creadora') return res.status(400).json({ error: 'Rol no válido.' });
  const u = db.users.find((x) => x.id === Number(req.params.id));
  if (!u) return res.status(404).json({ error: 'Usuaria no encontrada.' });
  if (esAdminPrincipal(u)) {
    return res.status(403).json({ error: 'La administradora principal no se puede cambiar desde la app.' });
  }
  u.rol = rol;
  save();
  res.json({ user: { ...publicUser(u), esPrincipal: esAdminPrincipal(u) } });
});

/* ------------------------------------------------------------------ */
/* Frontend (PWA)                                                      */
/* ------------------------------------------------------------------ */
/* La carcasa (index.html, styles.css, app.js, sw.js y el manifest) se
   sirve SIN caché HTTP (no-cache, no-store, must-revalidate): con el
   maxAge de 1 h anterior, Safari —sobre todo el iPhone con la app
   instalada— se quedaba con copias viejas y la app cargaba versiones
   MEZCLADAS (HTML nuevo con el CSS de dos versiones atrás) aunque se
   cerrara y se volviera a agregar a inicio. El resto de estáticos
   (iconos) sí conserva su hora de caché. */
const SHELL_FILES = new Set(['index.html', 'styles.css', 'app.js', 'sw.js', 'manifest.webmanifest']);
function sinCache(res) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}
app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders(res, filePath) {
      if (SHELL_FILES.has(path.basename(filePath))) sinCache(res);
      else res.setHeader('Cache-Control', 'public, max-age=3600');
    },
  })
);
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Ruta no encontrada.' });
  sinCache(res);
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🌸 Soporte Digital Flower Agency escuchando en el puerto ${PORT}`);
});
