'use strict';
/** Cargador mínimo de .env (sin dependencias): KEY=VALUE por línea. */
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', '.env');
try {
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i > 0) {
        const k = t.slice(0, i).trim();
        const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
        if (!(k in process.env)) process.env[k] = v;
      }
    }
  }
} catch (e) {
  console.error('No se pudo leer .env:', e.message);
}
