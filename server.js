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
const { db, save, nextId, UPLOADS_DIR } = require('./lib/store');

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
  return { id: u.id, nombre: u.nombre, email: u.email, tiktok: u.tiktok || '', rol: u.rol };
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
  const msgs = db.messages.filter((m) => m.casoId === caso.id);
  const ultimo = msgs[msgs.length - 1] || null;
  return {
    ...caso,
    totalMensajes: msgs.length,
    sinLeerAdmin: msgs.filter((m) => m.autor === 'creadora' && !m.leidoAdmin).length,
    sinLeerCreadora: msgs.filter((m) => m.autor !== 'creadora' && !m.leidoCreadora).length,
    ultimoMensaje: ultimo
      ? { tipo: ultimo.tipo, texto: ultimo.texto ? ultimo.texto.slice(0, 80) : '', createdAt: ultimo.createdAt }
      : null,
  };
}
function evidenciaDe(caso) {
  const msgs = db.messages.filter((m) => m.casoId === caso.id);
  const adjuntos = msgs.filter((m) => m.tipo === 'archivo' || m.tipo === 'audio');
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
(function seedAdmin() {
  const email = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();
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
  res.json({ caso: { ...caso, evidencia: evidenciaDe(caso) } });
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
  const msgs = db.messages
    .filter((m) => m.casoId === caso.id)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  // Marcar como leídos los mensajes de la otra parte
  let cambio = false;
  for (const m of msgs) {
    if (req.user.rol === 'admin' && m.autor === 'creadora' && !m.leidoAdmin) { m.leidoAdmin = true; cambio = true; }
    if (req.user.rol !== 'admin' && m.autor !== 'creadora' && !m.leidoCreadora) { m.leidoCreadora = true; cambio = true; }
  }
  if (cambio) save();
  res.json({ mensajes: msgs });
});

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

/* Adjuntos: fotos, videos, documentos, PDF y notas de voz */
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').slice(0, 10);
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 9)}${ext}`);
    },
  }),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
});

app.post('/api/cases/:id/upload', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No llegó ningún archivo.' });
  const esAudio = (req.file.mimetype || '').startsWith('audio/');
  guardarMensaje(req, res, {
    tipo: esAudio ? 'audio' : 'archivo',
    texto: '',
    archivo: '/uploads/' + req.file.filename,
    nombreArchivo: req.file.originalname,
    mime: req.file.mimetype,
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
app.get('/uploads/:name', authFlexible, (req, res) => {
  const name = path.basename(req.params.name);
  const msg = db.messages.find((m) => m.archivo === '/uploads/' + name);
  if (!msg) return res.status(404).end();
  const caso = db.cases.find((c) => c.id === msg.casoId);
  if (!caso || !puedeVerCaso(req.user, caso)) return res.status(403).end();
  const file = path.join(UPLOADS_DIR, name);
  if (!fs.existsSync(file)) return res.status(404).end();
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
  sinLeer = db.messages.filter((m) => m.autor === 'creadora' && !m.leidoAdmin).length;
  res.json({ porEstado, sinLeer, totalCasos: db.cases.length, labels: ESTADO_LABELS });
});

/* ------------------------------------------------------------------ */
/* Frontend (PWA)                                                      */
/* ------------------------------------------------------------------ */
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Ruta no encontrada.' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🌸 Soporte Digital Flower Agency escuchando en el puerto ${PORT}`);
});
