'use strict';
/**
 * Almacén de datos ligero basado en un archivo JSON.
 * Guarda usuarios, casos y mensajes. Los archivos adjuntos se guardan
 * como ficheros en DATA_DIR/uploads y aquí solo se guarda su referencia.
 *
 * Es suficiente para el volumen de una agencia. Si algún día hace falta
 * escalar, este módulo es el único punto a cambiar por una base de datos
 * real (Postgres/SQLite): la interfaz (load/save + colecciones) se mantiene.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const AVATARS_DIR = path.join(UPLOADS_DIR, 'avatars');
const DB_FILE = path.join(DATA_DIR, 'db.json');

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(AVATARS_DIR, { recursive: true });

let db = { users: [], cases: [], messages: [], anuncios: [], seq: { user: 1, caso: 1, msg: 1, anuncio: 1 } };

function load() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if (parsed && parsed.users && parsed.cases && parsed.messages) db = parsed;
    }
  } catch (e) {
    console.error('No se pudo leer la base de datos, se empieza vacía:', e.message);
  }
}

let saveTimer = null;
function save() {
  // Escritura diferida y atómica (archivo temporal + renombrar)
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  }, 60);
}

function nextId(kind) {
  return db.seq[kind]++;
}

load();

module.exports = { db, save, nextId, DATA_DIR, UPLOADS_DIR, AVATARS_DIR };
