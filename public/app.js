'use strict';
/* Soporte Digital Flower Agency — lógica del cliente */
const $ = (id) => document.getElementById(id);
/* Versión de la app (constante ÚNICA: subirla en cada despliegue, junto
   con el ?v=NN del index y el CACHE del sw.js). Se muestra como sello
   «Soporte DFA · vNN» en el pie de la lista de casos y en «Mi perfil»:
   si un teléfono sirve una carcasa vieja, el sello lo delata (muestra
   la versión vieja o no aparece) y no hay que adivinar si un problema
   visual es caché o un bug real. */
const APP_VERSION = 'v18';
for (const idSello of ['version-pie', 'version-perfil']) {
  const sello = $(idSello);
  if (sello) sello.textContent = 'Soporte DFA · ' + APP_VERSION;
}
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
/* Casos de la última lista cargada, por id (para el menú de la lista). */
let casosPorId = new Map();
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
  /* En el chat, el pie del shell se esconde (body.en-chat) para que la
     conversación ocupe toda la altura, como un chat normal. */
  document.body.classList.toggle('en-chat', id === 'vista-chat');
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
  $('btn-usuarias').hidden = true; $('panel-usuarias').hidden = true;
  cerrarMenuCaso();
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
  $('btn-usuarias').hidden = rv !== 'admin';
  if (rv !== 'admin') { $('panel-usuarias').hidden = true; cerrarMenuCaso(); }
  $('franja-preview').hidden = !vistaPrevia;
  /* El botón de entrar a la vista previa es para TODAS las administradoras
     (yo.rol === 'admin', incluidas las promovidas desde el panel), no solo
     para la cuenta principal, y solo fuera de la vista previa (dentro,
     manda el de la franja). */
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

/* ---------------- Administradoras: promover y degradar usuarias ----------------
   Solo lo ve y lo usa una administradora; el servidor vuelve a verificar
   el rol en cada llamada, así que ocultarlo aquí es solo presentación. */
let usuariasCache = [];
$('btn-usuarias').onclick = () => {
  const panel = $('panel-usuarias');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) cargarUsuarias();
};
async function cargarUsuarias() {
  if (!yo || yo.rol !== 'admin') return;
  try {
    const { usuarias } = await api('/api/admin/usuarios');
    usuariasCache = usuarias;
    $('lista-usuarias').innerHTML = usuarias.map((u) => {
      let accion;
      if (u.esPrincipal) {
        accion = '<span class="chip chip-admin">Administradora principal</span>';
      } else if (u.rol === 'admin') {
        accion = `<button type="button" class="btn btn-soft" data-rol="creadora" data-id="${u.id}">Quitar administración</button>`;
      } else {
        accion = `<button type="button" class="btn btn-primary" data-rol="admin" data-id="${u.id}">Hacer administradora</button>`;
      }
      return `<div class="usuaria-item">
        ${avatarHTML(u.nombre, u.foto)}
        <span class="caso-info">
          <span class="t">${esc(u.nombre)}${u.id === yo.id ? ' (tú)' : ''} ${u.tiktok ? `<span class="muted">${esc(u.tiktok)}</span>` : ''}</span>
          <span class="s" style="display:block">${esc(u.email)}</span>
          <span class="chips"><span class="chip ${u.rol === 'admin' ? 'chip-admin' : ''}">${u.rol === 'admin' ? 'Administradora' : 'Creadora'}</span></span>
        </span>
        ${accion}
      </div>`;
    }).join('');
    for (const b of $('lista-usuarias').querySelectorAll('button[data-rol]')) {
      b.onclick = () => cambiarRolUsuaria(Number(b.dataset.id), b.dataset.rol);
    }
  } catch (e) { alert(e.message); }
}
async function cambiarRolUsuaria(id, rol) {
  const u = usuariasCache.find((x) => x.id === id);
  const nombre = u ? u.nombre : 'esta usuaria';
  const texto = rol === 'admin'
    ? `¿Hacer administradora a ${nombre}? Va a ver TODOS los casos de la agencia, igual que tú.`
    : `¿Quitarle la administración a ${nombre}? Volverá a ver solo sus propios casos.`;
  if (!confirm(texto)) return;
  try {
    await api(`/api/admin/usuarios/${id}/rol`, { method: 'PATCH', body: JSON.stringify({ rol }) });
    if (id === yo.id) {
      /* Me cambié el rol a mí misma: refresco mi sesión local al momento. */
      const d = await api('/api/me');
      yo = d.user;
      aplicarVista();
    }
    cargarUsuarias();
    cargarLista();
  } catch (err) { alert(err.message); }
}

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
    casosPorId = new Map(casos.map((c) => [c.id, c]));
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
      return `<div class="caso-item" role="button" tabindex="0" data-id="${c.id}">
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
        ${rolVista() === 'admin' ? `<button type="button" class="btn-opciones" data-opciones="${c.id}" title="Opciones del caso (eliminar)">⋮</button>` : ''}
      </div>`;
    }).join('');
    for (const b of $('lista-casos').querySelectorAll('.caso-item')) {
      b.onclick = (e) => {
        /* El botón ⋮ tiene su propio manejo (abre el menú de eliminar):
           su clic no debe abrir el caso. */
        if (e.target.closest('[data-opciones]')) return;
        /* Tras una pulsación larga (que abre el menú de eliminar), el
           navegador dispara también el clic: no debe abrir el caso. */
        if (Date.now() < suprimirClickCasoHasta) return;
        abrirCaso(Number(b.dataset.id));
      };
      b.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrirCaso(Number(b.dataset.id)); }
      };
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
/* Estado y gravedad de la administradora: se guardan SOLOS al cambiar
   cualquiera de los dos selectores (sin botón de Guardar: en el teléfono
   el panel quedaba dentro de los detalles plegados y los cambios no se
   aplicaban si no se pulsaba Guardar). Al guardar se muestra el ✓ y se
   recarga el caso para que la cabecera y la lista queden al día. */
let adminGuardando = false;
async function guardarAdmin() {
  if (!casoActual || adminGuardando) return;
  adminGuardando = true;
  try {
    await api(`/api/cases/${casoActual.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ estado: $('admin-estado').value, gravedad: $('admin-gravedad').value }),
    });
    const aviso = $('admin-guardado');
    if (aviso) { aviso.hidden = false; setTimeout(() => { aviso.hidden = true; }, 2500); }
    await abrirCaso(casoActual.id);
  } catch (err) { alert(err.message); }
  adminGuardando = false;
}
$('admin-estado').addEventListener('change', guardarAdmin);
$('admin-gravedad').addEventListener('change', guardarAdmin);
$('btn-volver').onclick = () => { casoActual = null; cancelarRespuesta(); cerrarMenuMsg(); mostrar('vista-lista'); };

/* Eliminar un caso completo (solo administradoras, con confirmación).
   Lo usan tanto el botón de dentro del caso como el menú de la lista. */
async function eliminarCaso(id, titulo) {
  if (bloqueadoPorPreview()) return;
  if (!confirm(`¿Eliminar el caso "${titulo || ''}"? Se borra el caso completo con su chat y sus adjuntos. Esto no se puede deshacer.`)) return;
  try {
    await api(`/api/cases/${id}`, { method: 'DELETE' });
    if (casoActual && casoActual.id === id) casoActual = null;
    cancelarRespuesta();
    cerrarMenuMsg();
    mostrar('vista-lista');
  } catch (err) { alert(err.message); }
}
$('btn-eliminar-caso').onclick = () => {
  if (!casoActual || yo.rol !== 'admin') return;
  eliminarCaso(casoActual.id, casoActual.titulo);
};

/* ------------- Eliminar caso desde la LISTA (solo administradoras) -------------
   - Teléfono: mantener presionado un caso abre el menú "Eliminar caso".
   - Computadora: clic derecho sobre el caso abre el mismo menú.
   - Siempre (admin): el botón visible ⋮ de cada caso abre ese menú, sin
     depender de gestos que con el mouse no existen.
   Para las creadoras no hay menú: eliminar casos es solo de administradoras
   (y el servidor también lo exige con su propio permiso). */
const menuCaso = document.createElement('div');
menuCaso.className = 'msg-menu';
menuCaso.hidden = true;
menuCaso.innerHTML = `<button type="button" data-acc="eliminar-caso">🗑️ Eliminar caso</button>`;
document.body.appendChild(menuCaso);
let menuCasoId = null;
let menuCasoAbiertoEn = 0;
let suprimirClickCasoHasta = 0;
function cerrarMenuCaso() {
  menuCaso.hidden = true;
  menuCasoId = null;
}
function puedeModerarCasos() { return Boolean(yo) && rolVista() === 'admin'; }
function abrirMenuCaso(id, x, y) {
  if (!puedeModerarCasos()) return;
  menuCasoId = id;
  menuCasoAbiertoEn = Date.now();
  menuCaso.hidden = false;
  const ancho = 210, alto = 64;
  menuCaso.style.left = Math.max(8, Math.min(x, window.innerWidth - ancho - 8)) + 'px';
  menuCaso.style.top = Math.max(8, Math.min(y, window.innerHeight - alto - 8)) + 'px';
}
menuCaso.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-acc="eliminar-caso"]');
  if (!b || menuCasoId == null) return;
  const id = menuCasoId;
  const c = casosPorId.get(id);
  cerrarMenuCaso();
  eliminarCaso(id, c ? c.titulo : '');
});
document.addEventListener('click', (e) => {
  if (menuCaso.hidden || menuCaso.contains(e.target)) return;
  if (Date.now() - menuCasoAbiertoEn < 400) return; // clic fantasma de la pulsación larga
  cerrarMenuCaso();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cerrarMenuCaso(); });

const listaCasosEl = $('lista-casos');
/* Botón visible ⋮ en cada caso (computadora y teléfono): abre el mismo
   menú de eliminar, sin tener que adivinar el clic derecho ni la
   pulsación larga. */
listaCasosEl.addEventListener('click', (e) => {
  const b = e.target.closest('[data-opciones]');
  if (!b) return;
  e.stopPropagation();
  const r = b.getBoundingClientRect();
  abrirMenuCaso(Number(b.dataset.opciones), r.left, r.bottom + 4);
});
/* Clic derecho (computadora) sobre un caso: menú de eliminar */
listaCasosEl.addEventListener('contextmenu', (e) => {
  const item = e.target.closest('.caso-item');
  if (!item || !puedeModerarCasos()) return;
  e.preventDefault();
  abrirMenuCaso(Number(item.dataset.id), e.clientX, e.clientY);
});
/* Pulsación larga (teléfono) sobre un caso: menú de eliminar */
let toqueCaso = null;
let timerCaso = null;
listaCasosEl.addEventListener('touchstart', (e) => {
  if (!puedeModerarCasos()) return;
  const item = e.target.closest('.caso-item');
  if (!item || e.touches.length !== 1) return;
  const t = e.touches[0];
  toqueCaso = { item, x: t.clientX, y: t.clientY };
  clearTimeout(timerCaso);
  timerCaso = setTimeout(() => {
    if (!toqueCaso) return;
    suprimirClickCasoHasta = Date.now() + 600;
    abrirMenuCaso(Number(item.dataset.id), toqueCaso.x, toqueCaso.y);
    toqueCaso = null;
  }, 550);
}, { passive: true });
listaCasosEl.addEventListener('touchmove', (e) => {
  if (!toqueCaso) return;
  const t = e.touches[0];
  if (Math.abs(t.clientX - toqueCaso.x) > 10 || Math.abs(t.clientY - toqueCaso.y) > 10) {
    clearTimeout(timerCaso);
    toqueCaso = null;
  }
}, { passive: true });
function finToqueCaso() { clearTimeout(timerCaso); toqueCaso = null; }
listaCasosEl.addEventListener('touchend', finToqueCaso, { passive: true });
listaCasosEl.addEventListener('touchcancel', finToqueCaso, { passive: true });

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

/* Firma de la última lista de mensajes ya pintada (ids en orden). Sirve
   para NO repintar el chat cuando la vuelta de sondeo trae exactamente
   lo mismo: repintar con innerHTML destruye los elementos <audio> y
   <video> que se están reproduciendo y la nota de voz se cortaba a la
   mitad (el sondeo corre cada 6 segundos). */
let firmaMensajes = '';

async function cargarMensajes(bajar) {
  if (!casoActual) return;
  try {
    const { mensajes } = await api(`/api/cases/${casoActual.id}/messages`);
    mensajesPorId = new Map(mensajes.map((m) => [m.id, m]));
    const caja = $('chat-mensajes');
    const firma = mensajes.map((m) => m.id).join(',');
    if (firma === firmaMensajes) {
      /* Nada nuevo: no se toca el DOM, para no interrumpir un audio o
         video que se esté escuchando. Solo se honra el bajar al final. */
      if (bajar) caja.scrollTop = caja.scrollHeight;
      return;
    }
    const reproduciendo = [...caja.querySelectorAll('audio, video')].some((el) => !el.paused && !el.ended);
    if (reproduciendo) {
      /* Hay cambios, pero alguien está escuchando una nota o viendo un
         video: repintar ahora lo cortaría. Se deja para la próxima
         vuelta (la firma aún no se actualiza, así que se reintenta). */
      return;
    }
    const estabaAbajo = caja.scrollHeight - caja.scrollTop - caja.clientHeight < 140;
    caja.innerHTML = mensajes.map((m) => {
      /* Cada quien ve SUS mensajes (texto, stickers y adjuntos) siempre de
         su lado: la clase propio/ajeno se aplica a TODOS los tipos.
         Los mensajes eliminados ya no llegan aquí: el servidor los borra
         por completo y no los sirve a nadie. */
      const mio = m.autorId === yo.id;
      const lado = mio ? 'propio' : 'ajeno';
      const clase = m.tipo === 'sticker' ? `msg sticker ${lado}` : `msg ${lado}`;
      let cuerpo = '';
      if (m.tipo === 'texto') cuerpo = esc(m.texto).replace(/\n/g, '<br>');
      else if (m.tipo === 'sticker') cuerpo = esc(m.texto);
      else if (m.tipo === 'audio') cuerpo = `<audio controls src="${urlAdjunto(m)}"></audio>`;
      else if ((m.mime || '').startsWith('image/')) cuerpo = `<img class="foto-msg" src="${urlAdjunto(m)}" alt="foto">`;
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
        <button type="button" class="btn-opciones-msg" data-opciones-msg="${m.id}" title="Opciones del mensaje (responder / eliminar)">⋮</button>
      </div>`;
    }).join('');
    firmaMensajes = firma;
    if (bajar || estabaAbajo) caja.scrollTop = caja.scrollHeight;
  } catch (e) { /* poll silencioso */ }
}

/* ---------------- Visor de fotos a pantalla completa ----------------
   Las fotos del chat se ven completas en la burbuja; al tocarlas se
   abren aquí, enteras y con su proporción. Doble toque (o doble clic)
   acerca la imagen y se puede recorrer arrastrando; ✕ o tocar el
   fondo la cierra. Antes la foto era un enlace que abría el archivo
   suelto fuera del chat, en una vista pequeña donde había que mover
   la imagen por dentro de un cuadrito. */
function abrirVisor(url) {
  const visor = $('visor-foto');
  $('visor-img').src = url;
  visor.classList.remove('zoom');
  visor.hidden = false;
}
function cerrarVisor() {
  $('visor-foto').hidden = true;
  $('visor-foto').classList.remove('zoom');
  $('visor-img').removeAttribute('src');
}
$('visor-cerrar').onclick = cerrarVisor;
$('visor-foto').addEventListener('click', (e) => { if (e.target === e.currentTarget) cerrarVisor(); });
$('visor-img').addEventListener('dblclick', () => $('visor-foto').classList.toggle('zoom'));
$('chat-mensajes').addEventListener('click', (e) => {
  const img = e.target.closest('img.foto-msg');
  if (img) abrirVisor(img.src);
});

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

/* Como en WhatsApp: con el campo vacío se ven la camarita y el micrófono;
   en cuanto se escribe algo, los dos se reemplazan por el botón de enviar
   (➤). Mientras se está grabando, el micrófono se queda visible: la nota
   se envía sola al soltarlo. */
function actualizarBtnEnviar() {
  const escribiendo = $('input-texto').value.trim().length > 0;
  const grabandoAhora = typeof recorder !== 'undefined' && Boolean(recorder) && recorder.state === 'recording';
  $('btn-enviar').hidden = !escribiendo;
  $('btn-audio').hidden = escribiendo && !grabandoAhora;
  $('btn-camara').hidden = escribiendo;
}

async function enviarTexto() {
  if (bloqueadoPorPreview()) return;
  const t = $('input-texto').value.trim();
  if (!t || !casoActual) return;
  $('input-texto').value = ''; autoAltura(); actualizarBtnEnviar();
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
$('input-texto').addEventListener('input', () => { autoAltura(); actualizarBtnEnviar(); });

/* Menú «+» del composer (estilo WhatsApp): un solo botón a la izquierda
   de la barra abre un panel solo con Foto, Video y Archivo. Los stickers
   ya no van en ese panel: se abren con el iconito dentro de la barra de
   escribir. La cámara, al lado de la barra, abre las fotos directamente. */
$('btn-mas').onclick = () => { $('stickers').hidden = true; $('menu-mas').hidden = !$('menu-mas').hidden; };
function cerrarMenuMas() { $('menu-mas').hidden = true; }
$('btn-camara').onclick = () => { cerrarMenuMas(); $('stickers').hidden = true; $('input-foto').click(); };

/* Stickers: botón pequeño dentro de la barra de escribir, en la esquina
   derecha del campo, como en WhatsApp. */
$('stickers').innerHTML = STICKERS.map((s) => `<button type="button" data-s="${s}">${s}</button>`).join('');
$('btn-sticker').onclick = () => { cerrarMenuMas(); $('stickers').hidden = !$('stickers').hidden; };
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

/* Notas de voz — como en WhatsApp: mantener APRETADO el micrófono para
   grabar y SOLTAR para que la nota se envíe sola. Funciona con el dedo y
   con el mouse (pointer events). Un toque accidental muy corto (menos de
   1 segundo) se descarta en vez de mandar un audio vacío. */
let recorder = null, chunks = [];
let grabInicio = 0;         // cuándo arrancó la grabación (tiempo y mínimo de 1 s)
let grabTimer = null;       // intervalo que pinta el tiempo en el indicador
let grabIniciando = false;  // getUserMedia en curso, aún no se está grabando
let soltarAlGrabar = false; // soltó el botón antes de que arrancara la grabación

function fmtTiempoGrab(ms) {
  const s = Math.floor(ms / 1000);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function pintarGrabando() {
  $('grabando').textContent = '🔴 Grabando ' + fmtTiempoGrab(Date.now() - grabInicio) + ' · Suelta el micrófono para enviar';
}
function limpiarIndicadorGrabacion() {
  if (grabTimer) { clearInterval(grabTimer); grabTimer = null; }
  $('grabando').hidden = true;
  $('btn-audio').classList.remove('grabando-on');
}

async function empezarGrabacion() {
  if (bloqueadoPorPreview()) return;
  if (recorder || grabIniciando) return;
  grabIniciando = true;
  soltarAlGrabar = false;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    grabIniciando = false;
    alert('Para mandar notas de voz hay que permitir el micrófono.');
    return;
  }
  chunks = [];
  recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    const duracion = Date.now() - grabInicio;
    const rec = recorder;
    recorder = null;
    limpiarIndicadorGrabacion();
    actualizarBtnEnviar();
    /* Toque accidental (soltó enseguida): no se manda un audio vacío. */
    if (duracion < 1000) return;
    /* El nombre y el tipo salen del formato REAL de la grabación: en el
       iPhone MediaRecorder produce MP4/AAC y en Chrome WebM. Antes el
       archivo se mandaba siempre como ".webm", así que una nota grabada
       en iPhone quedaba guardada con el formato equivocado y no se
       podía reproducir (en iOS daba error). */
    const tipoReal = (rec.mimeType || 'audio/webm').split(';')[0].trim().toLowerCase();
    const EXT_AUDIO = {
      'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a',
      'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/aac': 'aac',
    };
    const blob = new Blob(chunks, { type: tipoReal });
    const fd = new FormData();
    fd.append('file', blob, 'nota-de-voz.' + (EXT_AUDIO[tipoReal] || 'webm'));
    try {
      const r = await fetch(`/api/cases/${casoActual.id}/upload`, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
      const d = await r.json().catch(() => ({}));
      if (r.ok) cargarMensajes(true);
      else alert(d.error || 'No se pudo enviar la nota de voz.');
    } catch (err) {
      alert('No se pudo enviar la nota de voz. Revisa tu conexión e inténtalo de nuevo.');
    }
  };
  grabInicio = Date.now();
  recorder.start();
  grabIniciando = false;
  $('grabando').hidden = false;
  $('btn-audio').classList.add('grabando-on');
  pintarGrabando();
  grabTimer = setInterval(pintarGrabando, 250);
  actualizarBtnEnviar();
  /* Si soltó el botón mientras se pedía el permiso del micrófono, la
     "grabación" dura un instante y el mínimo de 1 s la descarta sola. */
  if (soltarAlGrabar) detenerGrabacion();
}

function detenerGrabacion() {
  if (grabIniciando) { soltarAlGrabar = true; return; }
  if (recorder && recorder.state === 'recording') recorder.stop();
}

const btnAudioEl = $('btn-audio');
btnAudioEl.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  /* Con la captura del puntero, el pointerup llega al botón aunque el
     dedo o el mouse se haya movido un poco fuera de él. */
  try { btnAudioEl.setPointerCapture(e.pointerId); } catch (err) { /* sin captura: valen igual los eventos */ }
  empezarGrabacion();
});
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) {
  btnAudioEl.addEventListener(ev, (e) => { e.preventDefault(); detenerGrabacion(); });
}
/* Al mantener apretado no deben salir el menú contextual ni el callout
   de iOS (el CSS del botón ya quita la selección y el callout). */
btnAudioEl.addEventListener('contextmenu', (e) => e.preventDefault());

/* ------------- Opciones del mensaje: responder y eliminar -------------
   - Teléfono: deslizar el mensaje a la izquierda = responder; mantener
     presionado = menú de opciones.
   - Computadora: clic derecho sobre el mensaje = menú (Responder /
     Eliminar), y además cada mensaje lleva un botón visible ⋮ que abre
     el mismo menú con el mouse, sin gestos ni adivinanzas. */
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
    if (!confirm('¿Eliminar este mensaje para todos? Desaparece por completo del chat, también para la otra persona.')) return;
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
/* Botón visible ⋮ de cada mensaje: abre el menú de opciones con un clic
   normal del mouse (o del dedo), igual que el clic derecho. */
cajaChat.addEventListener('click', (e) => {
  const b = e.target.closest('[data-opciones-msg]');
  if (!b) return;
  e.stopPropagation();
  const r = b.getBoundingClientRect();
  abrirMenuMsg(mensajesPorId.get(Number(b.dataset.opcionesMsg)), r.left, r.bottom + 4);
});
/* Clic derecho (computadora) sobre un mensaje: menú de opciones */
cajaChat.addEventListener('contextmenu', (e) => {
  const fila = e.target.closest('.msg-row');
  if (!fila) return;
  e.preventDefault();
  abrirMenuMsg(mensajesPorId.get(Number(fila.dataset.id)), e.clientX, e.clientY);
});
/* Táctil: deslizar el mensaje en horizontal = responder (como WhatsApp);
   mantener presionado = menú de opciones.
   La dirección del gesto se decide al principio y se BLOQUEA: si el dedo
   se mueve sobre todo en horizontal, el gesto es de deslizar y la deriva
   vertical posterior ya NO lo cancela; si se mueve sobre todo en vertical,
   es el scroll de la conversación y no se toca nada. Antes, cualquier
   deriva vertical de más de 12px a mitad del gesto lo mataba (toque=null)
   y por eso el mensaje se veía deslizar pero nunca quedaba citado. */
let toque = null;
let timerLargo = null;
cajaChat.addEventListener('touchstart', (e) => {
  const fila = e.target.closest('.msg-row');
  if (!fila || e.touches.length !== 1) return;
  const t = e.touches[0];
  toque = { fila, x: t.clientX, y: t.clientY, dx: 0, dir: null };
  clearTimeout(timerLargo);
  timerLargo = setTimeout(() => {
    if (toque && !toque.dir) {
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
  if (!toque.dir) {
    if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
      toque.dir = 'h';
      clearTimeout(timerLargo);
      toque.fila.classList.add('deslizando');
    } else if (Math.abs(dy) > 10) {
      /* Es scroll vertical: se suelta el gesto sin tocar el mensaje. */
      clearTimeout(timerLargo);
      toque.fila.style.transform = '';
      toque = null;
      return;
    } else {
      return; // todavía no se sabe la dirección del gesto
    }
  }
  if (toque.dir === 'h') {
    /* Sin preventDefault la conversación haría scroll a mitad del gesto
       y el navegador cancelaría el toque sin responder. */
    e.preventDefault();
    toque.dx = dx;
    /* El mensaje acompaña el dedo hasta un tope, como en WhatsApp */
    toque.fila.style.transform = `translateX(${Math.max(-76, Math.min(76, dx))}px)`;
  }
}, { passive: false });
cajaChat.addEventListener('touchend', () => {
  clearTimeout(timerLargo);
  if (!toque) return;
  const { fila, dx, dir } = toque;
  fila.classList.remove('deslizando');
  fila.style.transform = '';
  toque = null;
  if (dir === 'h' && Math.abs(dx) >= 48) {
    activarRespuesta(mensajesPorId.get(Number(fila.dataset.id)));
  }
}, { passive: true });
cajaChat.addEventListener('touchcancel', () => {
  clearTimeout(timerLargo);
  if (toque) {
    toque.fila.classList.remove('deslizando');
    toque.fila.style.transform = '';
    toque = null;
  }
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
