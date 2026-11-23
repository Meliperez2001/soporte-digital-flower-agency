'use strict';
/* Soporte Digital Flower Agency — lógica del cliente */
const $ = (id) => document.getElementById(id);
const ESTADOS = ['nuevo', 'esperando_evidencia', 'evidencia_completa', 'listos', 'resuelto', 'cerrado'];
const ESTADO_LABELS = {
  nuevo: 'Nuevo', esperando_evidencia: 'Esperando evidencia', evidencia_completa: 'Evidencia completa',
  listos: 'Listos', resuelto: 'Resuelto', cerrado: 'Cerrado',
};
const STICKERS = ['🌸', '💜', '🦋', '🌷', '💐', '✨', '🙏', '💪', '👍', '❤️', '🌺', '🍀'];

let token = localStorage.getItem('sdfa_token') || '';
let yo = null;
let casoActual = null;
/* Mensajes del caso abierto, por id (para responder y eliminar). */
let mensajesPorId = new Map();
/* Mensaje al que se está respondiendo (cita tipo WhatsApp), o null. */
let respondiendoA = null;
let filtroEstado = 'todos';
let poll = null;
let deferredInstall = null;
/* Vista previa "Ver como creadora": solo visual y solo para la administradora.
   Nunca cambia el rol real (yo.rol) ni los permisos en el servidor. */
let vistaPrevia = false;
function rolVista() { return vistaPrevia ? 'creadora' : (yo ? yo.rol : null); }
function bloqueadoPorPreview() {
  if (!vistaPrevia) return false;
  alert('Estás viendo la app como creadora (vista previa). Vuelve a administradora para enviar o guardar cambios de verdad.');
  return true;
}

/* ---------------- API ---------------- */
async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(opts.headers || {}) },
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) { salir(); throw new Error(data.error || 'Sesión expirada'); }
  if (!r.ok) throw new Error(data.error || 'Algo salió mal, inténtalo de nuevo.');
  return data;
}
function urlAdjunto(m) {
  return m.archivo + '?token=' + encodeURIComponent(token);
}
function urlFoto(foto) {
  return foto ? foto + '?token=' + encodeURIComponent(token) : '';
}
function inicialesDe(nombre) {
  return (nombre || '?').split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();
}
/* Rellena un elemento .avatar con la foto de perfil o, si no hay, las iniciales. */
function pintarAvatar(el, nombre, foto) {
  if (!el) return;
  if (foto) el.innerHTML = `<img src="${urlFoto(foto)}" alt="">`;
  else el.textContent = inicialesDe(nombre);
}
/* HTML de un avatar (foto o iniciales) para listas y mensajes. */
function avatarHTML(nombre, foto, clase) {
  return foto
    ? `<span class="avatar ${clase || ''}"><img src="${urlFoto(foto)}" alt=""></span>`
    : `<span class="avatar ${clase || ''}">${esc(inicialesDe(nombre))}</span>`;
}
function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function hora(iso) {
  try {
    return new Date(iso).toLocaleString('es', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  } catch (e) { return ''; }
}

/* ---------------- Vistas ---------------- */
function mostrar(id) {
  for (const v of ['vista-auth', 'vista-lista', 'vista-nuevo', 'vista-chat', 'vista-perfil']) $(v).hidden = v !== id;
  /* El panel de stickers y la barra de escribir solo existen dentro del chat:
     al salir de esa vista se cierran siempre. */
  if (id !== 'vista-chat') { $('stickers').hidden = true; $('menu-mas').hidden = true; }
  clearInterval(poll); poll = null;
  if (id === 'vista-lista') { cargarLista(); poll = setInterval(cargarLista, 15000); }
  if (id === 'vista-chat') { poll = setInterval(() => cargarMensajes(false), 6000); }
  /* App shell: el scroll vive en el área de contenido, no en la ventana.
     Al cambiar de vista, esa área vuelve arriba. */
  $(id).scrollTop = 0;
}
function salir() {
  token = ''; yo = null; casoActual = null; vistaPrevia = false;
  localStorage.removeItem('sdfa_token');
  $('btn-salir').hidden = true; $('quien').textContent = '';
  $('btn-perfil').hidden = true; $('mi-avatar').hidden = true;
  $('btn-vista-creadora').hidden = true; $('franja-preview').hidden = true;
  mostrar('vista-auth');
}

/* ---------------- Autenticación ---------------- */
$('tab-login').onclick = () => {
  $('tab-login').classList.add('activa'); $('tab-registro').classList.remove('activa');
  $('form-login').hidden = false; $('form-registro').hidden = true;
};
$('tab-registro').onclick = () => {
  $('tab-registro').classList.add('activa'); $('tab-login').classList.remove('activa');
  $('form-registro').hidden = false; $('form-login').hidden = true;
};
$('form-login').onsubmit = async (e) => {
  e.preventDefault(); $('login-error').textContent = '';
  try {
    const d = await api('/api/login', { method: 'POST', body: JSON.stringify({ email: $('login-email').value, password: $('login-pass').value }) });
    entrar(d);
  } catch (err) { $('login-error').textContent = err.message; }
};
/* Vista previa de la foto elegida en el registro */
$('reg-foto').onchange = () => {
  const f = $('reg-foto').files[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  $('reg-foto-preview').innerHTML = `<img src="${url}" alt="">`;
};
async function subirFoto(file) {
  const fd = new FormData(); fd.append('foto', file);
  const r = await fetch('/api/profile/foto', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'No se pudo subir la foto.');
  return d.user;
}
$('form-registro').onsubmit = async (e) => {
  e.preventDefault(); $('reg-error').textContent = '';
  try {
    const d = await api('/api/register', {
      method: 'POST',
      body: JSON.stringify({ nombre: $('reg-nombre').value, email: $('reg-email').value, tiktok: $('reg-tiktok').value, password: $('reg-pass').value }),
    });
    token = d.token; // la foto se sube ya autenticada, antes de entrar
    const fotoFile = $('reg-foto').files[0];
    if (fotoFile) {
      try { d.user = await subirFoto(fotoFile); } catch (err) { /* la cuenta ya se creó: la foto se puede poner luego en Mi perfil */ }
    }
    e.target.reset();
    $('reg-foto-preview').textContent = '🌸';
    entrar(d);
  } catch (err) { $('reg-error').textContent = err.message; }
};
function entrar(d) {
  token = d.token; yo = d.user; vistaPrevia = false;
  localStorage.setItem('sdfa_token', token);
  $('btn-salir').hidden = false;
  $('btn-perfil').hidden = false;
  $('quien').textContent = yo.rol === 'admin' ? `🌸 ${yo.nombre} (administradora)` : `Hola, ${yo.nombre}`;
  $('mi-avatar').hidden = false;
  pintarAvatar($('mi-avatar'), yo.nombre, yo.foto);
  aplicarVista();
  mostrar('vista-lista');
}
$('btn-salir').onclick = salir;

/* ---------------- Mi perfil ---------------- */
$('btn-perfil').onclick = () => {
  if (!yo) return;
  $('perfil-nombre').value = yo.nombre || '';
  $('perfil-tiktok').value = yo.tiktok || '';
  $('perfil-error').textContent = ''; $('perfil-ok').textContent = '';
  pintarAvatar($('perfil-foto-preview'), yo.nombre, yo.foto);
  mostrar('vista-perfil');
};
$('btn-volver-perfil').onclick = () => mostrar('vista-lista');
$('perfil-foto').onchange = async () => {
  const f = $('perfil-foto').files[0];
  $('perfil-foto').value = '';
  if (!f || !yo) return;
  $('perfil-error').textContent = ''; $('perfil-ok').textContent = '';
  try {
    yo = await subirFoto(f);
    pintarAvatar($('perfil-foto-preview'), yo.nombre, yo.foto);
    pintarAvatar($('mi-avatar'), yo.nombre, yo.foto);
    $('perfil-ok').textContent = '✔ Foto actualizada.';
    refrescarVistaActual();
  } catch (err) { $('perfil-error').textContent = err.message; }
};
$('form-perfil').onsubmit = async (e) => {
  e.preventDefault();
  $('perfil-error').textContent = ''; $('perfil-ok').textContent = '';
  try {
    const d = await api('/api/profile', {
      method: 'PATCH',
      body: JSON.stringify({ nombre: $('perfil-nombre').value, tiktok: $('perfil-tiktok').value }),
    });
    yo = d.user;
    $('quien').textContent = yo.rol === 'admin' ? `🌸 ${yo.nombre} (administradora)` : `Hola, ${yo.nombre}`;
    pintarAvatar($('mi-avatar'), yo.nombre, yo.foto);
    pintarAvatar($('perfil-foto-preview'), yo.nombre, yo.foto);
    $('perfil-ok').textContent = '✔ Perfil guardado.';
  } catch (err) { $('perfil-error').textContent = err.message; }
};

/* ---------------- Vista previa como creadora (solo administradora) ---------------- */
function aplicarVista() {
  const rv = rolVista();
  $('lista-titulo').textContent = rv === 'admin' ? 'Casos de la agencia' : 'Mis casos';
  $('btn-nuevo-caso').hidden = rv === 'admin';
  $('admin-resumen').hidden = rv !== 'admin';
  $('filtros-estado').hidden = rv !== 'admin';
  $('franja-preview').hidden = !vistaPrevia;
  /* El botón de entrar a la vista previa solo existe para la administradora
     y solo fuera de la vista previa (dentro, manda el de la franja). */
  $('btn-vista-creadora').hidden = !yo || yo.rol !== 'admin' || vistaPrevia;
}
function textoChatSub(caso) {
  return rolVista() === 'admin'
    ? `${caso.creadoraNombre} ${caso.creadoraTiktok || ''} · ${ESTADO_LABELS[caso.estado]}`
    : `Tu caso · ${ESTADO_LABELS[caso.estado]} · Solo tú y la administradora ven este chat`;
}
function refrescarVistaActual() {
  if (!$('vista-lista').hidden) cargarLista();
  if (!$('vista-chat').hidden && casoActual) {
    $('chat-sub').textContent = textoChatSub(casoActual);
    renderDetalles(casoActual);
    cargarMensajes(false);
  }
}
$('btn-vista-creadora').onclick = () => {
  if (!yo || yo.rol !== 'admin') return;
  vistaPrevia = true;
  aplicarVista();
  refrescarVistaActual();
};
$('btn-volver-admin').onclick = () => {
  vistaPrevia = false;
  aplicarVista();
  refrescarVistaActual();
};

/* ---------------- Lista de casos ---------------- */
async function cargarLista() {
  if (vistaPrevia) {
    /* Vista previa: se muestra la lista como la vería una creadora sin casos.
       Los casos reales de la agencia NO se cargan ni se pintan aquí. */
    $('lista-casos').innerHTML = '';
    $('lista-vacia').hidden = false;
    return;
  }
  try {
    const { casos } = await api('/api/cases');
    if (yo.rol === 'admin') {
      const r = await api('/api/admin/resumen');
      $('admin-resumen').innerHTML =
        `<div class="stat"><b>${r.sinLeer}</b>mensajes sin leer</div>` +
        ESTADOS.map((e) => `<div class="stat"><b>${r.porEstado[e] || 0}</b>${ESTADO_LABELS[e]}</div>`).join('');
      $('filtros-estado').innerHTML =
        `<button class="filtro ${filtroEstado === 'todos' ? 'activo' : ''}" data-f="todos">Todos</button>` +
        ESTADOS.map((e) => `<button class="filtro ${filtroEstado === e ? 'activo' : ''}" data-f="${e}">${ESTADO_LABELS[e]}<span class="n">${r.porEstado[e] || 0}</span></button>`).join('');
      for (const b of $('filtros-estado').querySelectorAll('.filtro')) {
        b.onclick = () => { filtroEstado = b.dataset.f; cargarLista(); };
      }
    }
    const visibles = filtroEstado === 'todos' ? casos : casos.filter((c) => c.estado === filtroEstado);
    $('lista-vacia').hidden = visibles.length > 0;
    $('lista-casos').innerHTML = visibles.map((c) => {
      const sinLeer = yo.rol === 'admin' ? c.sinLeerAdmin : c.sinLeerCreadora;
      const ult = c.ultimoMensaje
        ? (c.ultimoMensaje.tipo === 'texto' ? esc(c.ultimoMensaje.texto) : c.ultimoMensaje.tipo === 'sticker' ? '🌸 Sticker' : '📎 Adjunto')
        : 'Sin mensajes';
      return `<button class="caso-item" data-id="${c.id}">
        ${avatarHTML(c.creadoraNombre, c.creadoraFoto)}
        <span class="caso-info">
          <span class="t">${esc(c.creadoraNombre)} ${c.creadoraTiktok ? `<span class="muted">${esc(c.creadoraTiktok)}</span>` : ''}</span>
          <span class="s" style="display:block">${esc(c.titulo)} · ${ult}</span>
          <span class="chips">
            <span class="chip">${ESTADO_LABELS[c.estado] || c.estado}</span>
            ${c.gravedad === 'grave' ? '<span class="chip grave">🚨 Grave</span>' : c.gravedad === 'no_grave' ? '<span class="chip nograve">No grave</span>' : ''}
          </span>
        </span>
        ${sinLeer ? `<span class="badge">${sinLeer}</span>` : ''}
        <span class="muted small">${c.ultimoMensaje ? hora(c.ultimoMensaje.createdAt) : ''}</span>
      </button>`;
    }).join('');
    for (const b of $('lista-casos').querySelectorAll('.caso-item')) {
      b.onclick = () => abrirCaso(Number(b.dataset.id));
    }
  } catch (e) { /* la sesión se maneja en api() */ }
}
$('btn-nuevo-caso').onclick = () => mostrar('vista-nuevo');
$('btn-cancelar-caso').onclick = () => mostrar('vista-lista');

/* ---------------- Abrir caso ---------------- */
$('form-caso').onsubmit = async (e) => {
  e.preventDefault(); $('caso-error').textContent = '';
  if (vistaPrevia) { $('caso-error').textContent = 'Esto es solo una vista previa: así abre su caso una creadora. Vuelve a administradora para trabajar de verdad.'; return; }
  try {
    const d = await api('/api/cases', {
      method: 'POST',
      body: JSON.stringify({
        titulo: $('caso-titulo').value, tipo: $('caso-tipo').value, descripcion: $('caso-descripcion').value,
        yaApelo: $('caso-apelo').value, linkVideo: $('caso-link').value, pps: $('caso-pps').value,
      }),
    });
    e.target.reset();
    abrirCaso(d.caso.id);
  } catch (err) { $('caso-error').textContent = err.message; }
};

/* ---------------- Chat ---------------- */
async function abrirCaso(id) {
  try {
    const { caso } = await api('/api/cases/' + id);
    casoActual = caso;
    cancelarRespuesta();
    cerrarMenuMsg();
    $('chat-titulo').textContent = caso.titulo;
    $('chat-sub').textContent = textoChatSub(caso);
    pintarAvatar($('chat-avatar'), caso.creadoraNombre, caso.creadoraFoto);
    renderDetalles(caso);
    mostrar('vista-chat');
    await cargarMensajes(true);
  } catch (e) { alert(e.message); }
}
function renderDetalles(caso) {
  const ev = caso.evidencia || {};
  $('detalles-contenido').innerHTML = `
    <p class="small muted" style="white-space:pre-wrap">${esc(caso.descripcion)}</p>
    <ul class="check">
      <li class="${ev.yaApelo ? 'ok' : ''}">Ya indicó si apeló o no ${caso.yaApelo ? `(dijo que ${caso.yaApelo === 'si' ? 'SÍ' : 'NO'})` : ''}</li>
      <li class="${ev.linkVideo ? 'ok' : ''}">Link del video sancionado ${caso.linkVideo ? `— <a href="${esc(caso.linkVideo)}" target="_blank" rel="noopener">abrir video</a>` : '(obligatorio si el caso es por un video)'}</li>
      <li class="${ev.pps ? 'ok' : ''}">PPS / salud de la cuenta ${caso.pps ? `— ${esc(caso.pps)}` : ''}</li>
      <li class="${ev.fotos ? 'ok' : ''}">Capturas / fotos enviadas (${ev.fotos || 0})</li>
      <li class="${ev.videos ? 'ok' : ''}">Videos enviados (${ev.videos || 0})</li>
      <li class="${ev.documentos ? 'ok' : ''}">Documentos o PDF enviados (${ev.documentos || 0})</li>
      <li class="${ev.audios ? 'ok' : ''}">Notas de voz enviadas (${ev.audios || 0})</li>
    </ul>`;
  $('dato-link').value = caso.linkVideo || '';
  $('dato-pps').value = caso.pps || '';
  $('dato-apelo').value = caso.yaApelo || '';
  $('form-datos').style.display = rolVista() === 'admin' ? 'none' : '';
  $('admin-controles').hidden = rolVista() !== 'admin';
  if (rolVista() === 'admin') {
    $('admin-estado').innerHTML = ESTADOS.map((e) => `<option value="${e}" ${e === caso.estado ? 'selected' : ''}>${ESTADO_LABELS[e]}</option>`).join('');
    $('admin-gravedad').value = caso.gravedad || 'sin_clasificar';
  }
}
$('form-datos').onsubmit = async (e) => {
  e.preventDefault();
  if (bloqueadoPorPreview()) return;
  try {
    const d = await api(`/api/cases/${casoActual.id}/datos`, {
      method: 'PATCH',
      body: JSON.stringify({ linkVideo: $('dato-link').value, pps: $('dato-pps').value, yaApelo: $('dato-apelo').value }),
    });
    casoActual = d.caso; renderDetalles(d.caso);
  } catch (err) { alert(err.message); }
};
$('btn-admin-guardar').onclick = async () => {
  try {
    await api(`/api/cases/${casoActual.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ estado: $('admin-estado').value, gravedad: $('admin-gravedad').value }),
    });
    abrirCaso(casoActual.id);
  } catch (err) { alert(err.message); }
};
$('btn-volver').onclick = () => { casoActual = null; cancelarRespuesta(); cerrarMenuMsg(); mostrar('vista-lista'); };

/* Eliminar el caso completo (solo administradora, con confirmación) */
$('btn-eliminar-caso').onclick = async () => {
  if (!casoActual || yo.rol !== 'admin') return;
  if (!confirm(`¿Eliminar el caso "${casoActual.titulo}"? Se borra el caso completo con su chat y sus adjuntos. Esto no se puede deshacer.`)) return;
  try {
    await api(`/api/cases/${casoActual.id}`, { method: 'DELETE' });
    casoActual = null;
    cancelarRespuesta();
    mostrar('vista-lista');
  } catch (err) { alert(err.message); }
};

/* Extracto de un mensaje para citarlo al responder (espejo del servidor). */
function extractoLocal(m) {
  if (m.eliminado) return 'Mensaje eliminado';
  if (m.tipo === 'texto') return String(m.texto || '').slice(0, 120);
  if (m.tipo === 'sticker') return '🌸 Sticker';
  if (m.tipo === 'audio') return '🎤 Nota de voz';
  if ((m.mime || '').startsWith('image/')) return '🖼️ Foto';
  if ((m.mime || '').startsWith('video/')) return '🎬 Video';
  return '📄 ' + (m.nombreArchivo || 'Documento');
}

async function cargarMensajes(bajar) {
  if (!casoActual) return;
  try {
    const { mensajes } = await api(`/api/cases/${casoActual.id}/messages`);
    mensajesPorId = new Map(mensajes.map((m) => [m.id, m]));
    const caja = $('chat-mensajes');
    const estabaAbajo = caja.scrollHeight - caja.scrollTop - caja.clientHeight < 140;
    caja.innerHTML = mensajes.map((m) => {
      /* Cada quien ve SUS mensajes (texto, stickers y adjuntos) siempre de
         su lado: la clase propio/ajeno se aplica a TODOS los tipos. */
      const mio = m.autorId === yo.id;
      const lado = mio ? 'propio' : 'ajeno';
      if (m.eliminado) {
        return `<div class="msg-row ${mio ? 'mio' : 'ajeno'}" data-id="${m.id}">
          ${avatarHTML(m.autorNombre, m.autorFoto, 'avatar-msg')}
          <div class="msg ${lado} eliminado">🚫 Mensaje eliminado</div>
        </div>`;
      }
      const clase = m.tipo === 'sticker' ? `msg sticker ${lado}` : `msg ${lado}`;
      let cuerpo = '';
      if (m.tipo === 'texto') cuerpo = esc(m.texto).replace(/\n/g, '<br>');
      else if (m.tipo === 'sticker') cuerpo = esc(m.texto);
      else if (m.tipo === 'audio') cuerpo = `<audio controls src="${urlAdjunto(m)}"></audio>`;
      else if ((m.mime || '').startsWith('image/')) cuerpo = `<a href="${urlAdjunto(m)}" target="_blank"><img src="${urlAdjunto(m)}" alt="foto"></a>`;
      else if ((m.mime || '').startsWith('video/')) cuerpo = `<video controls src="${urlAdjunto(m)}"></video>`;
      else cuerpo = `<a class="doc" href="${urlAdjunto(m)}" target="_blank">📄 ${esc(m.nombreArchivo || 'Documento')}</a>`;
      const cita = m.respuesta
        ? `<div class="cita"><strong>${esc(m.respuesta.autorNombre || '')}</strong><span>${esc(m.respuesta.texto || '')}</span></div>`
        : '';
      return `<div class="msg-row ${mio ? 'mio' : 'ajeno'}" data-id="${m.id}">
        ${avatarHTML(m.autorNombre, m.autorFoto, 'avatar-msg')}
        <div class="${clase}">
          ${m.tipo !== 'sticker' ? `<div class="autor">${esc(m.autorNombre || '')}</div>` : ''}
          ${cita}
          ${cuerpo}
          <div class="hora">${hora(m.createdAt)}</div>
        </div>
      </div>`;
    }).join('');
    if (bajar || estabaAbajo) caja.scrollTop = caja.scrollHeight;
  } catch (e) { /* poll silencioso */ }
}

/* ---------------- Responder con cita (tipo WhatsApp) ---------------- */
function activarRespuesta(m) {
  if (!m || m.eliminado) return;
  respondiendoA = m;
  $('reply-autor').textContent = 'Respondiendo a ' + (m.autorNombre || '');
  $('reply-extracto').textContent = extractoLocal(m);
  $('reply-bar').hidden = false;
  $('input-texto').focus();
}
function cancelarRespuesta() {
  respondiendoA = null;
  $('reply-bar').hidden = true;
}
$('btn-cancelar-respuesta').onclick = cancelarRespuesta;

async function enviarTexto() {
  if (bloqueadoPorPreview()) return;
  const t = $('input-texto').value.trim();
  if (!t || !casoActual) return;
  $('input-texto').value = ''; autoAltura();
  const citaId = respondiendoA ? respondiendoA.id : undefined;
  cancelarRespuesta();
  try {
    await api(`/api/cases/${casoActual.id}/messages`, { method: 'POST', body: JSON.stringify({ texto: t, respuestaA: citaId }) });
    cargarMensajes(true);
  } catch (e) { alert(e.message); }
}
$('btn-enviar').onclick = enviarTexto;
$('input-texto').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviarTexto(); }
});
function autoAltura() {
  const ta = $('input-texto');
  ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
}
$('input-texto').addEventListener('input', autoAltura);

/* Menú «+» del composer: un solo botón a la izquierda del campo de texto
   abre un panel con Foto, Video, Archivo y Stickers. El micrófono queda
   fuera del menú, junto al campo. */
$('btn-mas').onclick = () => { $('menu-mas').hidden = !$('menu-mas').hidden; };
function cerrarMenuMas() { $('menu-mas').hidden = true; }

/* Stickers */
$('stickers').innerHTML = STICKERS.map((s) => `<button type="button" data-s="${s}">${s}</button>`).join('');
$('menu-stickers').onclick = () => { cerrarMenuMas(); $('stickers').hidden = !$('stickers').hidden; };
for (const b of $('stickers').querySelectorAll('button')) {
  b.onclick = async () => {
    $('stickers').hidden = true;
    if (bloqueadoPorPreview()) return;
    const citaId = respondiendoA ? respondiendoA.id : undefined;
    cancelarRespuesta();
    try {
      await api(`/api/cases/${casoActual.id}/messages`, { method: 'POST', body: JSON.stringify({ sticker: b.dataset.s, respuestaA: citaId }) });
      cargarMensajes(true);
    } catch (e) { alert(e.message); }
  };
}

/* Adjuntos: se eligen desde el menú «+» y cada opción abre su propio
   selector — 🖼️ fotos, 🎬 videos y 📎 archivos/PDF. */
async function subirAdjunto(f) {
  if (!f || !casoActual) return;
  if (bloqueadoPorPreview()) return;
  const fd = new FormData(); fd.append('file', f);
  try {
    const r = await fetch(`/api/cases/${casoActual.id}/upload`, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'No se pudo subir el archivo.');
    cargarMensajes(true);
  } catch (e) { alert(e.message); }
}
for (const [menuId, inputId] of [['menu-foto', 'input-foto'], ['menu-video', 'input-video'], ['menu-archivo', 'input-archivo']]) {
  $(menuId).onclick = () => { cerrarMenuMas(); $('stickers').hidden = true; $(inputId).click(); };
  $(inputId).onchange = () => {
    const f = $(inputId).files[0];
    $(inputId).value = '';
    subirAdjunto(f);
  };
}

/* Notas de voz */
let recorder = null, chunks = [];
$('btn-audio').onclick = async () => {
  if (bloqueadoPorPreview()) return;
  if (recorder && recorder.state === 'recording') { recorder.stop(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      $('grabando').hidden = true;
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      const fd = new FormData();
      fd.append('file', blob, 'nota-de-voz.webm');
      const r = await fetch(`/api/cases/${casoActual.id}/upload`, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
      if (r.ok) cargarMensajes(true); else alert('No se pudo enviar la nota de voz.');
    };
    recorder.start();
    $('grabando').hidden = false;
  } catch (e) {
    alert('Para mandar notas de voz hay que permitir el micrófono.');
  }
};

/* ------------- Opciones del mensaje: responder y eliminar -------------
   - Teléfono: deslizar el mensaje a la izquierda = responder; mantener
     presionado = menú de opciones.
   - Computadora: clic derecho sobre el mensaje = menú (Responder /
     Eliminar). */
const menuMsg = document.createElement('div');
menuMsg.className = 'msg-menu';
menuMsg.hidden = true;
menuMsg.innerHTML = `
  <button type="button" data-acc="responder">↩️ Responder</button>
  <button type="button" data-acc="eliminar">🗑️ Eliminar</button>`;
document.body.appendChild(menuMsg);
let menuMsgId = null;

function cerrarMenuMsg() {
  menuMsg.hidden = true;
  menuMsgId = null;
}
function puedeEliminar(m) {
  return yo && (yo.rol === 'admin' || m.autorId === yo.id);
}
let menuAbiertoEn = 0;
function abrirMenuMsg(m, x, y) {
  if (!m || m.eliminado) return;
  menuMsgId = m.id;
  menuAbiertoEn = Date.now();
  menuMsg.querySelector('[data-acc="eliminar"]').hidden = !puedeEliminar(m);
  menuMsg.hidden = false;
  const ancho = 190, alto = 110;
  menuMsg.style.left = Math.max(8, Math.min(x, window.innerWidth - ancho - 8)) + 'px';
  menuMsg.style.top = Math.max(8, Math.min(y, window.innerHeight - alto - 8)) + 'px';
}
menuMsg.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-acc]');
  if (!b || menuMsgId == null) return;
  const m = mensajesPorId.get(menuMsgId);
  const acc = b.dataset.acc;
  cerrarMenuMsg();
  if (!m) return;
  if (acc === 'responder') { activarRespuesta(m); return; }
  if (acc === 'eliminar') {
    if (bloqueadoPorPreview()) return;
    if (!confirm('¿Eliminar este mensaje?')) return;
    try {
      await api(`/api/cases/${casoActual.id}/messages/${m.id}`, { method: 'DELETE' });
      if (respondiendoA && respondiendoA.id === m.id) cancelarRespuesta();
      cargarMensajes(false);
    } catch (err) { alert(err.message); }
  }
});
document.addEventListener('click', (e) => {
  if (menuMsg.hidden || menuMsg.contains(e.target)) return;
  /* El toque largo que abre el menú genera un click fantasma al soltar el
     dedo: no debe cerrar el menú que acaba de abrir. */
  if (Date.now() - menuAbiertoEn < 400) return;
  cerrarMenuMsg();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cerrarMenuMsg(); });

const cajaChat = $('chat-mensajes');
/* Clic derecho (computadora) sobre un mensaje: menú de opciones */
cajaChat.addEventListener('contextmenu', (e) => {
  const fila = e.target.closest('.msg-row');
  if (!fila) return;
  e.preventDefault();
  abrirMenuMsg(mensajesPorId.get(Number(fila.dataset.id)), e.clientX, e.clientY);
});
/* Táctil: deslizar a la izquierda = responder; mantener presionado = menú */
let toque = null;
let timerLargo = null;
cajaChat.addEventListener('touchstart', (e) => {
  const fila = e.target.closest('.msg-row');
  if (!fila || e.touches.length !== 1) return;
  const t = e.touches[0];
  toque = { fila, x: t.clientX, y: t.clientY, dx: 0, deslizo: false };
  clearTimeout(timerLargo);
  timerLargo = setTimeout(() => {
    if (toque && !toque.deslizo) {
      abrirMenuMsg(mensajesPorId.get(Number(fila.dataset.id)), toque.x, toque.y);
      toque = null;
    }
  }, 500);
}, { passive: true });
cajaChat.addEventListener('touchmove', (e) => {
  if (!toque) return;
  const t = e.touches[0];
  const dx = t.clientX - toque.x;
  const dy = t.clientY - toque.y;
  if (Math.abs(dy) > 12) { clearTimeout(timerLargo); toque.deslizo = true; toque.fila.style.transform = ''; toque = null; return; }
  if (dx < -8) {
    toque.deslizo = true;
    clearTimeout(timerLargo);
    toque.dx = dx;
    /* El mensaje acompaña el dedo hasta un tope, como en WhatsApp */
    toque.fila.style.transform = `translateX(${Math.max(dx, -72)}px)`;
  }
}, { passive: true });
cajaChat.addEventListener('touchend', () => {
  clearTimeout(timerLargo);
  if (!toque) return;
  const { fila, dx, deslizo } = toque;
  fila.style.transform = '';
  toque = null;
  if (deslizo && dx <= -56) {
    activarRespuesta(mensajesPorId.get(Number(fila.dataset.id)));
  }
}, { passive: true });
cajaChat.addEventListener('touchcancel', () => {
  clearTimeout(timerLargo);
  if (toque) { toque.fila.style.transform = ''; toque = null; }
}, { passive: true });

/* ---------------- Instalación (PWA) ---------------- */
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); deferredInstall = e;
  $('btn-instalar').hidden = false;
});
$('btn-instalar').onclick = async () => {
  if (deferredInstall) { deferredInstall.prompt(); deferredInstall = null; $('btn-instalar').hidden = true; }
  else alert('En iPhone: pulsa Compartir y luego "Añadir a pantalla de inicio". En la computadora: busca el icono de instalar en la barra de direcciones del navegador.');
};
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

/* ---------------- Arranque ---------------- */
(async () => {
  if (!token) return;
  try {
    const d = await api('/api/me');
    entrar({ token, user: d.user });
  } catch (e) { salir(); }
})();
