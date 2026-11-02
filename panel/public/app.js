'use strict';
// Panel de móviles: una página sin dependencias; cada vista se elige con el #hash de la URL.

const $ = sel => document.querySelector(sel);
const view = $('#view');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const enc = encodeURIComponent;
const cap = s => (s ? s[0].toUpperCase() + s.slice(1) : '');

// reload: vuelve a pedir los datos de la vista actual tras una acción
const state = { devices: [], apps: [], overview: null, query: '', showSystem: false, reload: async () => {} };

// ── Utilidades ──────────────────────────────────────────────────────────────

const RESTART = 'El panel se ha actualizado y sigue con la versión anterior: cierra su ventana negra y vuelve a abrir panel.cmd';

async function api(path, { method = 'GET', body, file } = {}) {
  const init = { method, headers: { 'X-Panel': '1' } };
  if (file) init.body = file;
  else if (body) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`/api${path}`, init);
  const data = await res.json().catch(() => ({}));
  if (res.status === 404 && data.error === 'No existe') throw new Error(RESTART);
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}
const post = (path, body = {}) => api(path, { method: 'POST', body });

function toast(text, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 9000 : 4000);
}

// Bloquea el botón mientras dura la acción; los errores acaban en un aviso
async function busy(btn, fn) {
  btn.disabled = true;
  btn.classList.add('busy');
  try { return await fn(); } catch (e) { toast(e.message, 'error'); } finally {
    btn.disabled = false;
    btn.classList.remove('busy');
  }
}

// Diálogo de confirmación; devuelve true si se acepta
function ask(title, html, okLabel = 'Aceptar', kind = 'danger') {
  const dlg = $('#dialog');
  dlg.className = '';
  dlg.innerHTML = `<form method="dialog">
      <h2>${esc(title)}</h2><div class="dlg-body">${html}</div>
      <menu><button class="btn" value="no">Cancelar</button><button class="btn ${kind}" value="yes">${esc(okLabel)}</button></menu>
    </form>`;
  dlg.returnValue = '';
  dlg.showModal();
  dlg.querySelector('input')?.select();
  return new Promise(resolve => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'yes'), { once: true }));
}

const model = d => [cap(d.maker), d.model].filter(Boolean).join(' ');
const title = d => d.name || model(d) || d.serial;
const deviceBy = serial => state.devices.find(d => d.serial === serial) || { serial };
const ctx = (el, key) => el.closest(`[data-${key}]`)?.dataset[key];
const tag = (text, kind = '') => `<span class="tag ${kind}">${esc(text)}</span>`;
const appName = a => (a.note ? `<div class="app-name">${esc(a.note)}</div>` : '');
const loading = text => `<div class="loading"><span class="spinner"></span>${esc(text)}</div>`;
const PHONE = '<svg class="phone" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M10.5 18.5h3"/></svg>';

// ── Navegación ──────────────────────────────────────────────────────────────

let renderId = 0;
function route() {
  const id = ++renderId;
  const current = () => id === renderId;
  const hash = location.hash || '#/';
  const tab = ['apps', 'music', 'settings', 'install'].find(t => hash.startsWith(`#/${t}`)) || 'devices';
  for (const a of document.querySelectorAll('nav a')) a.classList.toggle('active', a.dataset.tab === tab);
  const m = hash.match(/^#\/device\/(.+)$/);
  const show = m ? viewDevice(decodeURIComponent(m[1]), current)
    : tab === 'apps' ? viewOverview(current)
    : tab === 'music' ? viewMusic(current)
    : tab === 'settings' ? viewSettings(current)
    : tab === 'install' ? viewInstall(current)
    : viewDevices(current);
  show.catch(e => current() && (view.innerHTML = `<div class="card problem">${esc(e.message)}</div>`));
}

async function checkStatus() {
  const { adb, outdated } = await api('/status');
  $('#banner').innerHTML = (outdated ? `<div class="banner"><strong>Hay una versión nueva del panel.</strong>
    Para usarla, cierra la ventana negra del panel y vuelve a abrir <code>panel.cmd</code>.</div>` : '')
    + (adb ? '' : `<div class="banner">
    <strong>Falta adb</strong>, la herramienta con la que el panel habla con los móviles. Instálala desde una terminal con
    <code>winget install Google.PlatformTools</code> y pulsa ↻ arriba. También vale descargar las
    <a href="https://developer.android.com/tools/releases/platform-tools" target="_blank" rel="noopener">SDK Platform-Tools</a>
    y descomprimirlas en la carpeta del proyecto (quedará <code>platform-tools\\adb.exe</code>).</div>`);
}

// ── Dispositivos ────────────────────────────────────────────────────────────

async function viewDevices(current) {
  view.innerHTML = `
    <div class="page-head"><h1>Dispositivos</h1><p class="muted">Los móviles conectados a este PC, por cable o por wifi.</p></div>
    <section id="grid" class="grid">${loading('Buscando móviles…')}</section>
    <section class="card add">
      <h2>Añadir un móvil</h2>
      <div class="ways">
        <div class="way">
          <h3>Con código QR ${tag('Android 11 o superior')}</h3>
          <p class="muted">Sin cables: el móvil escanea un código que muestra el panel y queda añadido por wifi.</p>
          <button class="btn primary" data-act="qr">Mostrar código QR</button>
        </div>
        <div class="way">
          <h3>Por cable USB</h3>
          <p class="muted">Enchúfalo con la depuración USB activada y aparecerá arriba. Después pulsa «Pasar a Wi-Fi» y ya puedes quitar el cable.</p>
        </div>
      </div>
      <p id="saved" class="muted small"></p>
      <details>
        <summary>Otras formas: por IP o con código de vinculación</summary>
        <p class="muted">Si el móvil ya escucha por wifi (tras «Pasar a Wi-Fi»), conéctalo por su IP:</p>
        <form class="inline" data-form="connect">
          <input name="host" placeholder="192.168.1.50" required autocomplete="off" aria-label="IP del móvil">
          <button class="btn">Conectar</button>
        </form>
        <p class="muted">O vincúlalo con código: en el móvil, Depuración inalámbrica → <em>Vincular dispositivo con código de vinculación</em>,
          y escribe la IP:puerto y el código que aparecen:</p>
        <form class="inline" data-form="pair">
          <input name="host" placeholder="192.168.1.50:37123" required autocomplete="off" aria-label="IP y puerto de vinculación">
          <input name="code" placeholder="Código" inputmode="numeric" maxlength="6" required size="8" autocomplete="off" aria-label="Código de vinculación">
          <button class="btn">Vincular</button>
        </form>
      </details>
      <details>
        <summary>¿No encuentras las «Opciones de desarrollador»?</summary>
        <p>En el móvil: Ajustes → Información del teléfono → toca 7 veces «Número de compilación» (en Xiaomi, «Versión de MIUI» o «de HyperOS»).
          Aparecen en Ajustes → Sistema (o Ajustes adicionales). Ahí están la depuración USB y la inalámbrica.</p>
      </details>
    </section>`;
  state.reload = () => loadGrid(current);
  await loadGrid(current);
}

async function loadGrid(current = () => true) {
  const { devices, saved } = await api('/devices');
  if (!current() || !$('#grid')) return;
  state.devices = devices;
  $('#grid').innerHTML = devices.map(deviceCard).join('') || `<div class="card empty">
      <strong>Aún no hay ningún móvil.</strong>
      <p class="muted">Enchufa uno por USB con la depuración USB activada (los pasos están en el README) o conéctalo por su IP aquí abajo.</p>
    </div>`;
  $('#saved').innerHTML = saved.length
    ? `Guardados para reconectar: ${saved.map(esc).join(', ')} <button class="btn small" data-act="connect-saved">Reconectar</button>` : '';
}

function deviceCard(d) {
  const ready = d.state === 'device' && !d.error;
  // Las conexiones por IP atascadas se rehacen con «Reintentar»; las de cable, desenchufando
  const retry = !ready && d.serial.includes(':');
  const problem = d.state === 'unauthorized'
    ? `Desbloquea el móvil y acepta «¿Permitir depuración?» (marca «Permitir siempre»).${retry ? ' Después pulsa «Reintentar».' : ''}`
    : d.state === 'offline' ? `No responde. ${retry ? 'Pulsa «Reintentar».' : 'Desenchúfalo y vuelve a enchufarlo.'}`
    : d.state !== 'device' ? `Estado: ${d.state}` : d.error;
  const battery = d.battery == null ? '' : `<span class="chip" title="Batería${d.charging ? ' (cargando)' : ''}">
      <span class="batt ${d.battery <= 20 ? 'low' : ''}"><i style="width:${d.battery}%"></i></span>${d.battery} %${d.charging ? ' ⚡' : ''}</span>`;
  return `<article class="card device ${ready ? '' : 'warn'}" data-serial="${esc(d.serial)}">
    <div class="dev-head">
      ${PHONE}
      <div class="dev-title">
        <h3>${esc(title(d))}</h3>
        <p class="muted">${esc(ready ? [d.name && model(d), `Android ${d.android}`].filter(Boolean).join(' · ') : d.serial)}</p>
      </div>
      ${ready ? '<button class="btn ghost icon" data-act="rename" title="Ponerle nombre">✎</button>' : ''}
    </div>
    <div class="chips">
      <span class="chip">${d.wifi ? `Wi-Fi · ${esc(d.ip || d.serial.split(':')[0])}` : 'Cable USB'}</span>${battery}
    </div>
    ${problem ? `<p class="problem">${esc(problem)}</p>` : ''}
    <div class="actions">
      ${ready ? `<a class="btn primary" href="#/device/${enc(d.serial)}" title="Acciones rápidas y sus apps">Controlar</a>` : ''}
      ${ready ? '<button class="btn" data-act="screen" title="Ver y manejar su pantalla desde el PC">Ver pantalla</button>' : ''}
      ${ready && !d.wifi ? '<button class="btn" data-act="wifi">Pasar a Wi-Fi</button>' : ''}
      ${retry ? '<button class="btn primary" data-act="reconnect">Reintentar</button>' : ''}
      ${d.wifi ? '<button class="btn ghost" data-act="disconnect">Desconectar</button>' : ''}
    </div>
  </article>`;
}

async function renameDevice(btn) {
  const d = deviceBy(ctx(btn, 'serial'));
  const ok = await ask('Nombre del móvil', `<p>Para reconocerlo de un vistazo, como «Cocina» o «Tablet niños».</p>
    <input id="new-name" value="${esc(d.name)}" placeholder="${esc(model(d))}" maxlength="40">`, 'Guardar', 'primary');
  if (!ok) return;
  await busy(btn, async () => {
    await post('/names', { id: d.serialno, name: $('#new-name').value });
    await state.reload();
  });
}

// Muestra el QR de emparejado y pregunta cada 2 s si el móvil ya lo ha escaneado
async function showQr({ name, svg }) {
  const dlg = $('#dialog');
  dlg.className = 'wide';
  dlg.innerHTML = `<form method="dialog">
      <h2>Añadir un móvil con código QR</h2>
      <div class="qr-body">
        <div class="qr-code">${svg}</div>
        <ol>
          <li>Conecta el móvil a la misma wifi que este ordenador.</li>
          <li>En el móvil: Ajustes → Opciones de desarrollador → <strong>Depuración inalámbrica</strong>, y actívala.</li>
          <li>Toca <strong>Vincular dispositivo con código QR</strong> y escanea este código.</li>
        </ol>
      </div>
      <div class="qr-status" id="qr-status">${loading('Esperando a que el móvil escanee el código…')}</div>
      <p class="muted small">Si Windows pregunta si adb puede usar la red, permite las redes privadas: lo necesita para encontrar el móvil.</p>
      <menu><button class="btn" value="close">Cerrar</button></menu>
    </form>`;
  dlg.showModal();
  const status = $('#qr-status');
  const open = () => dlg.open && dlg.contains(status); // sigue abierto y con este mismo código
  const started = Date.now();
  while (open()) {
    await new Promise(r => setTimeout(r, 2000));
    if (!open()) return;
    const r = await api(`/qr/${enc(name)}`).catch(e => ({ state: 'error', message: e.message }));
    if (!open()) return;
    if (r.state === 'waiting') {
      if (Date.now() - started > 120000) {
        status.innerHTML = loading('Sigo esperando… Comprueba que el móvil y el ordenador están en la misma wifi.');
      }
      continue;
    }
    status.className = `qr-status ${r.state === 'done' ? 'ok-text' : 'err-text'}`;
    status.textContent = r.state === 'done' ? `✓ ${r.message}` : r.message;
    if (r.state === 'done') {
      toast(r.message);
      state.reload().catch(() => {});
      setTimeout(() => open() && dlg.close(), 2500);
    }
    return;
  }
}

// Refresca la lista de móviles cada poco, para ver los que se conectan o aceptan la depuración
let polling = false;
setInterval(async () => {
  if (polling || document.hidden || !$('#grid') || document.querySelector('.busy, dialog[open]')) return;
  polling = true;
  try { await loadGrid(); } catch {} finally { polling = false; }
}, 8000);

// ── Apps de un móvil ────────────────────────────────────────────────────────

async function viewDevice(serial, current) {
  view.innerHTML = `<a class="back" href="#/">← Dispositivos</a>${loading('Leyendo las apps del móvil…')}`;
  const [{ apps }] = await Promise.all([
    api(`/devices/${enc(serial)}/apps`),
    state.devices.some(d => d.serial === serial) ? null : api('/devices').then(r => { state.devices = r.devices; }),
  ]);
  if (!current()) return;
  const d = deviceBy(serial);
  state.apps = apps;
  view.innerHTML = `
    <a class="back" href="#/">← Dispositivos</a>
    <div class="page-head row"><div><h1>${esc(title(d))}</h1>
      <p class="muted">${esc(model(d))}${d.android ? ` · Android ${esc(d.android)}` : ''} · <code>${esc(serial)}</code></p></div>
      <button class="btn" data-act="screen" data-serial="${esc(serial)}" title="Ver y manejar su pantalla desde el PC">Ver pantalla</button></div>
    ${quickCard(d)}
    <h2>Apps</h2>
    <div class="toolbar">
      <input type="search" id="q" placeholder="Buscar app…" value="${esc(state.query)}" aria-label="Buscar app">
      <label class="check"><input type="checkbox" id="sys" ${state.showSystem ? 'checked' : ''}> Mostrar las del sistema</label>
      <span id="counts" class="muted small"></span>
    </div>
    <div class="card flush" data-serial="${esc(serial)}"><table class="apps"><tbody id="rows"></tbody></table></div>`;
  $('#q').oninput = e => { state.query = e.target.value; renderRows(); };
  $('#sys').onchange = e => { state.showSystem = e.target.checked; renderRows(); };
  renderRows();
  state.reload = async () => {
    state.apps = (await api(`/devices/${enc(serial)}/apps`)).apps;
    if (current()) renderRows();
  };
}

// Acciones rápidas de la ficha de un móvil: van al del [data-serial] que las contiene
const qb = (action, label, tip) => `<button class="btn small" data-act="quick" data-action="${action}" title="${esc(tip)}">${label}</button>`;
const qGroup = (name, ...buttons) => `<div class="quick-group"><span class="muted small">${name}</span><div>${buttons.join('')}</div></div>`;

// «Cerrar» cierra la app con la que se abrió ese enlace (YouTube, el navegador…): por eso el enlace se queda escrito
function quickCard(d) {
  return `<section class="card quick" data-serial="${esc(d.serial)}">
    <div class="quick-groups">
      ${qGroup('Pantalla', qb('wake', 'Encender', 'Enciende la pantalla'),
        qb('unlock', 'Desbloquear', 'Enciende la pantalla y quita el bloqueo de deslizar; si tiene PIN, se queda pidiéndolo'),
        qb('lock', 'Apagar', 'Apaga la pantalla'),
        '<button class="btn small" data-act="screenshot" title="Ver lo que hay ahora en su pantalla">Captura</button>')}
      ${qGroup('Girar', qb('landscape', 'Horizontal', 'Fija la pantalla en horizontal (las apps que solo van en vertical no giran)'),
        qb('portrait', 'Vertical', 'Fija la pantalla en vertical'), qb('autoRotate', 'Girar sola', 'Vuelve al giro automático'))}
      ${qGroup('Abrir', qb('calendar', 'Calendario', 'Abre su calendario en la última vista que se usó (mes, semana…)'))}
      ${qGroup('Sonido', qb('volumeDown', 'Vol −', 'Baja el volumen de la música'), qb('volumeUp', 'Vol +', 'Sube el volumen de la música'),
        qb('ring', 'Hacer sonar', 'Para encontrarlo: suena hasta que lo pares en el móvil'))}
      ${qGroup('Música', qb('previous', '⏮', 'Canción anterior'), qb('playPause', '⏯', 'Play / pausa'), qb('next', '⏭', 'Canción siguiente'))}
    </div>
    <form class="inline" data-form="open">
      <input name="url" type="url" required placeholder="https://www.youtube.com/watch?v=…" autocomplete="off" aria-label="Enlace para abrir">
      <button class="btn" value="open" title="Si el móvil está bloqueado, aparece al desbloquearlo">Abrir en el móvil</button>
      <button class="btn" value="close" title="Cierra la app con la que se abre este enlace (YouTube, el navegador…)">Cerrar</button>
    </form>
    ${d.sdk >= 29 ? `<form class="inline" data-form="notify">
      <input name="text" required maxlength="200" placeholder="Escribe un aviso para que salga en el móvil" autocomplete="off" aria-label="Aviso">
      <button class="btn">Mandar aviso</button>
    </form>` : '<p class="muted small">Los avisos necesitan Android 10 o superior.</p>'}
  </section>`;
}

const runQuick = async (serial, action, body = {}) => toast((await post(`/devices/${enc(serial)}/do/${action}`, body)).message);

async function showScreenshot(btn) {
  const d = deviceBy(ctx(btn, 'serial'));
  const { image } = await api(`/devices/${enc(d.serial)}/screenshot`);
  const stamp = new Date().toLocaleString('sv').replace(/[ :]/g, '-');
  const file = `captura-${title(d).replace(/[^\p{L}\p{N}]+/gu, '-')}-${stamp}.png`;
  const dlg = $('#dialog');
  dlg.className = 'wide';
  dlg.innerHTML = `<form method="dialog">
      <h2>Pantalla de ${esc(title(d))}</h2>
      <img class="shot" src="${image}" alt="Captura de la pantalla de ${esc(title(d))}">
      <p class="muted small">Si sale negra, la pantalla estaba apagada o la app que se ve no deja hacer capturas.</p>
      <menu><a class="btn" href="${image}" download="${esc(file)}">Guardar</a><button class="btn primary" value="close">Cerrar</button></menu>
    </form>`;
  dlg.showModal();
}

function renderRows() {
  const q = state.query.trim().toLowerCase();
  const mine = state.apps.filter(a => !a.system && a.installed).length;
  const system = state.apps.filter(a => a.system && a.installed).length;
  $('#counts').textContent = `${mine} instaladas por ti · ${system} del sistema`;
  const list = state.apps
    .filter(a => (state.showSystem || !a.system) && (!q || a.pkg.toLowerCase().includes(q) || a.note.toLowerCase().includes(q)))
    .sort((a, b) => a.system - b.system || a.pkg.localeCompare(b.pkg));
  $('#rows').innerHTML = list.map(appRow).join('')
    || `<tr><td class="empty muted">${q ? 'Ninguna app coincide con la búsqueda.' : 'No hay apps instaladas por ti. Marca «Mostrar las del sistema» para ver el resto.'}</td></tr>`;
}

function appRow(a) {
  const btn = (action, label, cls = '') => `<button class="btn small ${cls}" data-act="app" data-action="${action}">${label}</button>`;
  const tags = [
    a.system && tag('Sistema'),
    !a.installed && tag('Quitada', 'danger'),
    a.installed && !a.enabled && tag('Desactivada', 'warn'),
  ].filter(Boolean).join('');
  const buttons = !a.installed ? btn('restore', 'Restaurar') : [
    a.enabled && btn('open', 'Abrir', 'ghost'),
    a.enabled ? btn('disable', 'Desactivar') : btn('enable', 'Activar'),
    btn('uninstall', a.system ? 'Quitar' : 'Desinstalar', 'danger'),
  ].filter(Boolean).join('');
  return `<tr data-pkg="${esc(a.pkg)}" data-system="${a.system ? 1 : ''}" class="${a.installed && a.enabled ? '' : 'dim'}">
    <td class="star-cell">${a.system ? '' : starButton(a.pkg, a.keep)}</td>
    <td class="app-cell">${appName(a)}<code>${esc(a.pkg)}</code>${tags}</td>
    <td class="row-actions">${buttons}</td>
  </tr>`;
}

const starButton = (pkg, on) => `<button class="star ${on ? 'on' : ''}" data-act="keep" aria-pressed="${on}"
  title="${on ? 'App común. Pulsa para quitarla de la lista' : 'Hacerla app común: se instalará en todos los móviles'}">★</button>`;

async function appAction(btn) {
  const serial = ctx(btn, 'serial'), pkg = ctx(btn, 'pkg'), action = btn.dataset.action;
  const system = ctx(btn, 'system') === '1';
  const where = esc(title(deviceBy(serial)));
  const warnings = {
    uninstall: system
      ? ['¿Quitar app del sistema?', `<p>Se quita <code>${esc(pkg)}</code> de <strong>${where}</strong> para su usuario. No se borra del todo: puedes recuperarla con «Restaurar».</p>
         <p>Quitar algunas apps del sistema puede dejar el móvil inestable; si dudas, mejor «Desactivar».</p>`, 'Quitar']
      : ['¿Desinstalar?', `<p>Se desinstala <code>${esc(pkg)}</code> de <strong>${where}</strong> y se borran sus datos.</p>`, 'Desinstalar'],
    disable: system && ['¿Desactivar app del sistema?', `<p>Desactivar <code>${esc(pkg)}</code> puede dejar partes del móvil sin funcionar.
      Se arregla con «Activar».</p>`, 'Desactivar'],
  };
  if (warnings[action] && !await ask(...warnings[action])) return;
  await busy(btn, async () => {
    const r = await post(`/devices/${enc(serial)}/apps/${enc(pkg)}/${action}`);
    toast(`${pkg}: ${r.message}`);
    await state.reload();
  });
}

// La estrella hace común una app (eligiendo de dónde instalarla) o la quita de la lista
async function toggleKeep(btn) {
  const pkg = ctx(btn, 'pkg');
  if (!btn.classList.contains('on')) {
    const serial = ctx(btn, 'serial') || state.overview?.devices.find(d => d.third.includes(pkg))?.serial;
    return addAppDialog({ pkg, serial });
  }
  try {
    if (await removeApp(pkg, state.apps.find(a => a.pkg === pkg)?.note)) await state.reload();
  } catch (e) { toast(e.message, 'error'); }
}

// ── Apps comunes ────────────────────────────────────────────────────────────

const SOURCES = { apk: 'APK propio', fdroid: 'F-Droid', play: 'Google Play' };
const time = ts => new Date(ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
const hue = s => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const appIcon = a => (a.icon
  ? `<img class="app-icon" src="${esc(a.icon)}" alt="">`
  : `<span class="app-icon letter" style="--hue:${hue(a.pkg)}">${esc((a.name || a.pkg)[0].toUpperCase())}</span>`);

async function viewOverview(current) {
  view.innerHTML = `<div class="page-head"><h1>Apps</h1>
      <p class="muted">Las apps comunes se instalan y se mantienen al día en todos los móviles.</p></div>
    <section id="catalog">${loading('Comprobando qué tiene cada móvil…')}</section>
    <section id="others"></section>`;
  state.reload = () => Promise.all([
    api('/catalog').then(data => {
      if (!current()) return;
      state.catalog = data;
      state.devices = data.devices;
      $('#catalog').innerHTML = catalogHtml(data);
    }),
    api('/overview').then(data => {
      if (!current()) return;
      state.overview = data;
      $('#others').innerHTML = othersHtml(data);
    }),
  ]);
  await state.reload();
}

function catalogHtml({ apps, devices, auto, last }) {
  const pending = (d, a) => d.status?.[a.pkg] && d.status[a.pkg].state !== 'ok';
  const total = devices.reduce((n, d) => n + apps.filter(a => pending(d, a)).length, 0);
  const bar = `<div class="card bar">
      <button class="btn primary" data-act="add-app">＋ Añadir app</button>
      <button class="btn" data-act="sync-all" ${total ? '' : 'disabled'}>${total ? `Instalar lo pendiente (${total})` : 'Todo al día ✓'}</button>
      <span class="spacer"></span>
      <label class="switch" title="Cada 5 minutos instala y actualiza en los móviles conectados las apps de APK propio y F-Droid">
        <input type="checkbox" data-act="auto" ${auto ? 'checked' : ''}><span class="knob"></span>Instalar y actualizar solas</label>
      ${last ? `<span class="muted small">Última vez a las ${time(last.at)}: ${last.ok} ${last.ok === 1 ? 'hecha' : 'hechas'}${last.failed ? `, ${last.failed} con error` : ''}</span>` : ''}
    </div>`;
  if (!apps.length) return `${bar}<div class="card empty"><strong>Aún no hay apps comunes.</strong>
    <p class="muted">Añade las que quieres en todos los móviles: tu propio APK, una app de F-Droid o una de Google Play.</p></div>`;
  const rows = apps.map(a => `<tr data-pkg="${esc(a.pkg)}">
      <td class="app-cell"><div class="app-id">${appIcon(a)}<div>
        <div class="app-name">${esc(a.name)}</div>
        <div class="app-meta"><code>${esc(a.pkg)}</code>${tag(SOURCES[a.source] + (a.versionName ? ` · ${a.versionName}` : ''), `src-${a.source}`)}</div>
      </div></div></td>
      ${devices.map(d => statusCell(d, a)).join('')}
      <td class="row-actions">
        <button class="btn small" data-act="sync-app" ${devices.some(d => pending(d, a)) ? '' : 'disabled'}>${a.source === 'play' ? 'Abrir en Play' : 'Instalar en todos'}</button>
        <button class="btn ghost icon small" data-act="rename-app" title="Cambiar el nombre">✎</button>
        <button class="btn ghost icon small danger" data-act="remove-app" title="Quitar de las apps comunes">✕</button>
      </td>
    </tr>`).join('');
  return `${bar}
    ${devices.length ? '' : '<p class="problem">No hay móviles listos: conéctalos en <a href="#/">Dispositivos</a>.</p>'}
    <div class="card flush scroll-x"><table class="matrix catalog">
      <thead><tr><th>App común</th>${devices.map(d => `<th class="dev-col">${esc(title(d))}</th>`).join('')}<th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="legend muted small">
      <span><span class="st ok">✓</span> instalada</span><span><span class="st update">↑</span> hay versión nueva</span>
      <span><span class="st missing">+</span> falta</span><span><span class="st missing">▶</span> abrir en Google Play</span>
      <span><span class="st error">!</span> falló</span><span>· Pasa el ratón por una celda para ver detalles y púlsala para instalar.</span></p>`;
}

function statusCell(d, a) {
  const s = d.status?.[a.pkg];
  if (!s) return `<td class="cell"><span class="none" title="${esc(d.status?.error || 'No se pudo leer el móvil')}">?</span></td>`;
  if (s.state === 'ok') return `<td class="cell"><span class="st ok" title="Instalada${s.have ? ` (versión ${s.have})` : ''}">✓</span></td>`;
  const where = title(d);
  const [label, tip] = s.error ? ['!', `Falló en ${where}: ${s.error}. Pulsa para reintentar`]
    : s.state === 'update' ? ['↑', `Actualizar en ${where} (tiene la versión ${s.have})`]
    : a.source === 'play' ? ['▶', `Abrir Google Play en ${where} para instalarla`]
    : ['+', `Instalar en ${where}`];
  return `<td class="cell" data-serial="${esc(d.serial)}"><button class="st ${s.error ? 'error' : s.state}" data-act="sync-cell"
    title="${esc(tip)}" aria-label="${esc(tip)}">${label}</button></td>`;
}

function othersHtml({ devices, keep }) {
  if (!devices.length) return '';
  const common = new Set(keep.map(k => k.pkg));
  const pkgs = [...new Set(devices.flatMap(d => d.third))].filter(p => !common.has(p)).sort();
  const rows = pkgs.map(pkg => `<tr data-pkg="${esc(pkg)}">
      <td class="star-cell">${starButton(pkg, false)}</td>
      <td class="app-cell"><code>${esc(pkg)}</code></td>
      ${devices.map(d => (d.third.includes(pkg)
        ? `<td class="cell" data-serial="${esc(d.serial)}"><button class="cell-btn" data-act="app" data-action="uninstall"
            title="Instalada en ${esc(title(d))}. Pulsa para desinstalarla" aria-label="Desinstalar de ${esc(title(d))}"></button></td>`
        : '<td class="cell"><span class="none">·</span></td>')).join('')}
    </tr>`).join('');

  const debloat = devices.map(d => {
    const db = d.debloat;
    const status = !db.exists ? `<span class="muted">sin lista: crea <code>${esc(db.file)}</code></span>`
      : db.pkgs.length ? `${db.pkgs.length} por quitar <button class="btn small danger" data-act="debloat">Quitar…</button>`
      : '<span class="ok-text">nada por quitar ✓</span>';
    return `<li data-serial="${esc(d.serial)}"><strong>${esc(title(d))}</strong>${d.name ? ` <span class="muted">(${esc(model(d))})</span>` : ''} — ${status}</li>`;
  }).join('');

  return `
    <h2>Otras apps en los móviles</h2>
    <div class="card summary">
      <div class="muted">${pkgs.length ? 'Instaladas en algún móvil pero no son comunes. ★ la hace común; pulsar su ✓ la desinstala de ese móvil.'
        : 'Ninguna: los móviles solo tienen apps comunes ✓'}</div>
      <button class="btn danger" data-act="prune" ${pkgs.length && keep.length ? '' : 'disabled'}
        title="${keep.length ? 'Desinstala de todos los móviles las apps que no son comunes' : 'Añade antes las apps comunes'}">Quitarlas todas…</button>
    </div>
    ${devices.filter(d => d.error).map(d => `<p class="problem">${esc(title(d))}: ${esc(d.error)}</p>`).join('')}
    ${pkgs.length ? `<div class="card flush scroll-x"><table class="matrix">
      <thead><tr><th></th><th>App</th>${devices.map(d => `<th class="dev-col">${esc(title(d))}</th>`).join('')}</tr></thead>
      <tbody>${rows}</tbody>
    </table></div>` : ''}
    <h2>Apps del sistema que sobran</h2>
    <div class="card">
      <p class="muted">Para quitar en bloque apps del sistema (bloatware), crea <code>debloat/&lt;fabricante&gt;.txt</code> en la carpeta del proyecto
        con un paquete por línea. Se quitan solo para el usuario y se recuperan con «Restaurar» en la ficha del móvil.</p>
      <ul class="debloat">${debloat}</ul>
    </div>`;
}

// Ejecuta acciones sobre varias apps: en paralelo entre móviles, de una en una dentro de cada móvil
async function runJobs(jobs, action) {
  const errors = [];
  const bySerial = Map.groupBy(jobs, j => j.serial);
  await Promise.all([...bySerial].map(async ([serial, list]) => {
    for (const { pkg } of list) {
      try { await post(`/devices/${enc(serial)}/apps/${enc(pkg)}/${action}`); } catch (e) {
        errors.push(`${title(deviceBy(serial))} · ${pkg}: ${e.message}`);
      }
    }
  }));
  toast(`Hecho: ${jobs.length - errors.length} de ${jobs.length}`, errors.length ? 'error' : 'ok');
  errors.forEach(e => toast(e, 'error'));
  await state.reload();
}

const jobList = jobs => [...Map.groupBy(jobs, j => j.serial)].map(([serial, list]) =>
  `<p><strong>${esc(title(deviceBy(serial)))}</strong></p><ul>${list.map(j => `<li><code>${esc(j.pkg)}</code>${j.note ? ` — ${esc(j.note)}` : ''}</li>`).join('')}</ul>`).join('');

async function prune(btn) {
  const keep = new Set(state.overview.keep.map(k => k.pkg));
  const jobs = state.overview.devices.flatMap(d => d.third.filter(p => !keep.has(p)).map(pkg => ({ serial: d.serial, pkg })));
  const ok = await ask('¿Quitar las apps que sobran?',
    `<p>Se desinstalarán estas ${jobs.length} apps, con sus datos, porque no son apps comunes:</p>${jobList(jobs)}`, `Desinstalar ${jobs.length}`);
  if (ok) await busy(btn, () => runJobs(jobs, 'uninstall'));
}

async function debloat(btn) {
  const d = state.overview.devices.find(x => x.serial === ctx(btn, 'serial'));
  const jobs = d.debloat.pkgs.map(p => ({ serial: d.serial, ...p }));
  const ok = await ask(`¿Quitar apps del sistema de ${title(d)}?`,
    `<p>Según <code>${esc(d.debloat.file)}</code> se quitarán (se pueden restaurar):</p>${jobList(jobs)}`, `Quitar ${jobs.length}`);
  if (ok) await busy(btn, () => runJobs(jobs, 'uninstall'));
}

// Instala lo pendiente (de una app, de un móvil o de todo) y resume cómo ha ido
async function syncNow(body, what) {
  toast(`${what}… puede tardar unos minutos`);
  const { results } = await post('/catalog/sync', body);
  const names = new Map((state.catalog?.apps || []).map(a => [a.pkg, a.name]));
  const done = results.filter(r => r.ok);
  const play = done.filter(r => r.message.includes('Google Play')).length;
  if (!results.length) toast('Nada que hacer: ya estaba todo al día');
  const installed = done.length - play;
  if (installed) toast(`Listo: ${installed} ${installed === 1 ? 'app instalada o actualizada' : 'apps instaladas o actualizadas'}`);
  if (play) toast(`Abierto Google Play en ${play} ${play === 1 ? 'móvil' : 'móviles'}: pulsa «Instalar» en la pantalla`);
  for (const r of results.filter(x => !x.ok)) {
    toast(`${title(deviceBy(r.serial))}${r.pkg ? ` · ${names.get(r.pkg) || r.pkg}` : ''}: ${r.message}`, 'error');
  }
  await state.reload();
}

async function removeApp(pkg, name) {
  name ||= state.catalog?.apps.find(a => a.pkg === pkg)?.name || pkg;
  const ok = await ask(`¿Quitar ${name} de las apps comunes?`,
    '<p>No se desinstala de ningún móvil: deja de instalarse en los demás y pasa a «Otras apps».</p>', 'Quitar de la lista');
  if (ok) {
    await post(`/catalog/${enc(pkg)}/remove`);
    toast(`${name} ya no es una app común`);
  }
  return ok;
}

async function renameApp(btn) {
  const pkg = ctx(btn, 'pkg');
  const app = state.catalog.apps.find(a => a.pkg === pkg);
  if (!await ask('Nombre de la app', `<input id="new-name" value="${esc(app.name)}" maxlength="60">`, 'Guardar', 'primary')) return;
  await busy(btn, async () => {
    await post(`/catalog/${enc(pkg)}/rename`, { name: $('#new-name').value });
    await state.reload();
  });
}

// Diálogo para añadir una app común; con serial ofrece copiar el APK desde ese móvil
function addAppDialog({ pkg = '', serial = null } = {}) {
  const tabs = [
    serial && ['copy', `Copiar de ${title(deviceBy(serial))}`],
    ['play', 'Google Play'],
    ['fdroid', 'F-Droid'],
    ['apk', 'Subir APK'],
  ].filter(Boolean);
  const dlg = $('#dialog');
  dlg.className = 'wide';
  dlg.innerHTML = `<form method="dialog">
      <h2>Añadir app común</h2>
      <div class="segmented" role="tablist">${tabs.map(([k, label]) => `<button type="button" role="tab" data-tab="${k}">${esc(label)}</button>`).join('')}</div>
      <p class="muted" data-panel="copy">Se copia el APK de <code>${esc(pkg)}</code> desde ese móvil y se instala igual en los demás.
        Vale para apps de una sola pieza, como tus apps privadas; las de Google Play suelen venir partidas y no se pueden copiar.</p>
      <p class="muted" data-panel="play">Google Play no deja instalar desde fuera: el panel abre la ficha de la app en cada móvil donde falte
        y allí pulsas «Instalar». Después Play la mantiene al día.</p>
      <p class="muted" data-panel="fdroid">El panel descarga la última versión de F-Droid, la instala en todos y la actualiza cuando salga otra.</p>
      <label class="drop compact" data-panel="apk"><input type="file" accept=".apk" hidden>
        <strong>Elige o arrastra aquí el .apk</strong><span class="muted small">Se guarda en el panel y se instala tal cual en todos los móviles.</span></label>
      <label class="field" data-panel="play fdroid"><span>Paquete o enlace de la tienda</span>
        <input name="pkg" value="${esc(pkg)}" placeholder="org.videolan.vlc o https://play.google.com/store/apps/details?id=…" autocomplete="off"></label>
      <label class="field"><span>Nombre <span class="muted small">(opcional: si no, el de la tienda o el del archivo)</span></span>
        <input name="name" maxlength="60" autocomplete="off"></label>
      <label class="check"><input type="checkbox" name="now" checked> Instalarla ya en todos los móviles</label>
      <p class="err-text small" id="add-error" role="alert"></p>
      <menu><button class="btn" value="no" formnovalidate>Cancelar</button><button class="btn primary" value="yes" id="add-ok">Añadir</button></menu>
    </form>`;
  const form = dlg.querySelector('form');
  const error = $('#add-error');
  let tab, apk = null;
  const show = k => {
    tab = k;
    for (const b of form.querySelectorAll('[data-tab]')) b.classList.toggle('on', b.dataset.tab === k);
    for (const el of form.querySelectorAll('[data-panel]')) el.hidden = !el.dataset.panel.split(' ').includes(k);
    error.textContent = '';
  };
  form.querySelector('.segmented').onclick = e => { const b = e.target.closest('[data-tab]'); if (b) show(b.dataset.tab); };
  const drop = form.querySelector('.drop');
  const pick = file => {
    apk = file;
    drop.classList.toggle('has', Boolean(file));
    drop.querySelector('strong').textContent = file ? `${file.name} · ${(file.size / 1048576).toFixed(1)} MB` : 'Elige o arrastra aquí el .apk';
  };
  drop.querySelector('input').onchange = e => pick(e.target.files[0]);
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); pick(e.dataTransfer.files[0]); };

  form.onsubmit = async e => {
    if (e.submitter?.value !== 'yes') return;
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    const name = (f.name || '').trim();
    if (tab === 'apk' && !apk) return void (error.textContent = 'Elige primero el archivo .apk');
    await busy($('#add-ok'), async () => {
      try {
        const { app } = tab === 'apk'
          ? await api(`/catalog/upload?name=${enc(name)}&file=${enc(apk.name.replace(/\.apk$/i, ''))}`, { method: 'POST', file: apk })
          : tab === 'copy' ? await post('/catalog/copy', { serial, pkg, name })
          : await post('/catalog/add', { source: tab, pkg: f.pkg, name });
        dlg.close();
        toast(`${app.name} es ya una app común`);
        if (f.now) await syncNow({ pkg: app.pkg }, `Instalando ${app.name}`);
        else await state.reload();
      } catch (err) {
        if (dlg.open) error.textContent = err.message;
        else toast(err.message, 'error');
      }
    });
  };
  show(tabs[0][0]);
  dlg.showModal();
}

// ── Música ──────────────────────────────────────────────────────────────────

const isReady = d => d.state === 'device' && !d.error;
const mmss = s => (s == null ? '' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);
const mb = (action, label, tip, cls = '') => `<button class="btn ${cls}" data-act="music" data-action="${action}" title="${esc(tip)}">${label}</button>`;
const SPEAKER_STATE = {
  tap: ['Esperando un toque', 'diff', 'Chrome necesita que alguien toque la pantalla del móvil antes de dejar sonar la música. El panel lo hace solo al abrirlo; si no, tócala tú'],
  idle: ['Listo', 'ok', ''],
  ready: ['Listo', 'ok', ''],
  loading: ['Cargando…', '', 'Está descargando la canción del PC'],
  playing: ['Sonando', 'ok', ''],
};

async function viewMusic(current) {
  view.innerHTML = `<div class="page-head"><h1>Música</h1>
      <p class="muted">Tus canciones sonando a la vez en los móviles que elijas. Cada móvil hace de altavoz con una página que abre en Chrome.</p></div>
    <section id="music">${loading('Buscando móviles…')}</section>`;
  state.reload = async () => {
    const [{ devices }, music] = await Promise.all([api('/devices'), api('/music')]);
    if (!current()) return;
    state.devices = devices;
    state.music = music;
    renderMusic();
    refreshVolumes().catch(() => {});
  };
  await state.reload();
}

function renderMusic() {
  const devices = state.devices.filter(isReady);
  $('#music').innerHTML = `
    <div class="card now">
      <div class="now-head">
        <div class="now-title"><span class="muted small" id="now-state"></span><strong id="now-song"></strong></div>
        <div class="now-controls">
          ${mb('previous', '⏮', 'Anterior; si ya lleva unos segundos, vuelve al principio')}
          <button class="btn primary" id="now-toggle" data-act="music" data-action="toggle"></button>
          ${mb('next', '⏭', 'Siguiente')}
          ${mb('stop', 'Parar', 'Para la música en todos los altavoces', 'ghost')}
        </div>
      </div>
      <div class="progress" data-act="seek" title="Pulsa para saltar a ese punto de la canción"><i id="now-bar"></i></div>
      <div class="times muted small"><span id="now-pos"></span><span id="now-dur"></span></div>
      <div class="now-options">
        <label class="switch" title="Al acabar una canción, sigue con otra cualquiera en vez de con la siguiente">
          <input type="checkbox" id="shuffle"><span class="knob"></span>Aleatorio</label>
        <label class="check" title="Pausa la música al cabo de ese tiempo">Temporizador
          <select id="sleep" aria-label="Pausar la música dentro de">
            <option value="0">No</option><option value="15">15 min</option><option value="30">30 min</option>
            <option value="60">1 hora</option><option value="90">1 h 30 min</option><option value="120">2 horas</option>
          </select></label>
        <span class="muted small" id="sleep-at"></span>
      </div>
    </div>
    <div class="section-head"><h2>Altavoces</h2>
      <div class="actions">
        ${mb('all', 'Que suenen todos', 'Quita el silencio a todos los altavoces')}
        <button class="btn" data-act="speaker-all" title="Abre la página de altavoz en todos los móviles conectados">Abrir en todos</button>
      </div></div>
    ${devices.length ? `<div class="card flush scroll-x"><table class="matrix speakers">
      <thead><tr><th>Móvil</th><th>Estado</th><th>Volumen</th><th>Sonido</th><th>Retraso</th><th></th></tr></thead>
      <tbody>${devices.map(speakerRow).join('')}</tbody>
    </table></div>` : '<p class="problem">No hay móviles listos: conéctalos en <a href="#/">Dispositivos</a>.</p>'}
    <p class="muted small">El volumen es el de la música de cada móvil, el mismo que cambian sus botones. Con «Suena» lo silencias o le
      vuelves a dar voz de un clic, y con «Solo» suena únicamente ese. Si uno se oye antes que los demás, súbele el retraso, y si se oye
      después, bájalo: la prueba de sincronía da un pitido por segundo para cuadrarlos de oído.
      En los móviles, la página del altavoz ocupa toda la pantalla y la mantiene encendida: desde cualquiera se puede elegir
      canción o pausar todos.</p>
    <div class="section-head"><h2>Canciones</h2>
      <div class="actions">
        <label class="btn">Subir canciones<input type="file" id="song-files" accept="audio/*,.mp3,.m4a,.aac,.ogg,.opus,.wav,.flac" multiple hidden></label>
        <button class="btn" data-act="music-folder" title="Abre en el PC la carpeta de la música: lo que copies ahí aparece aquí">Abrir la carpeta</button>
      </div></div>
    <div class="card flush"><table class="songs"><tbody id="songs"></tbody></table></div>`;
  updateMusic();
}

function speakerRow(d) {
  const tip = 'Si este móvil se oye antes que los demás, súbelo; si se oye después, bájalo';
  return `<tr data-serial="${esc(d.serial)}" data-id="${esc(d.serialno)}">
    <td class="app-cell"><div class="app-name">${esc(title(d))}</div>${d.name ? `<div class="muted small">${esc(model(d))}</div>` : ''}</td>
    <td class="sp-state"></td>
    <td class="nowrap"><input type="range" class="vol" min="0" max="100" step="1" disabled
      aria-label="Volumen de la música en ${esc(title(d))}"><span class="vol-val small">…</span></td>
    <td class="nowrap"><button class="btn small mute" data-act="mute"></button><button class="btn small" data-act="music"
      data-action="solo" title="Que suene solo en este móvil; los demás se quedan en silencio">Solo</button></td>
    <td class="nowrap"><button class="btn small icon" data-act="delay" data-step="-10" title="${esc(tip)}" aria-label="Menos retraso">−</button><span
      class="delay-val"></span><button class="btn small icon" data-act="delay" data-step="10" title="${esc(tip)}" aria-label="Más retraso">+</button></td>
    <td class="row-actions"><button class="btn small primary" data-act="speaker-open" title="Abre la página de altavoz en Chrome en este móvil">Abrir altavoz</button></td>
  </tr>`;
}

// Lo que cambia con cada consulta, sin rehacer la página (para no perder un clic a medias)
let songsKey = '';
function updateMusic() {
  const { now, rooms, songs } = state.music;
  $('#now-song').textContent = now.song ? now.name : 'Nada sonando';
  $('#now-state').textContent = !now.song ? 'Elige una canción abajo' : now.waiting ? 'Preparando los altavoces…' : now.playing ? 'Sonando' : 'En pausa';
  $('#now-toggle').textContent = now.playing ? '⏸ Pausa' : now.song ? '▶ Seguir' : '▶ Reproducir';
  $('#now-pos').textContent = now.song ? mmss(now.position) : '';
  $('#now-dur').textContent = now.song ? mmss(now.duration) : '';
  $('#now-bar').style.width = now.song && now.duration ? `${Math.min(100, now.position / now.duration * 100)}%` : '0';
  if (document.activeElement !== $('#shuffle')) $('#shuffle').checked = now.shuffle;
  if (document.activeElement !== $('#sleep') && !now.stopAt) $('#sleep').value = '0';
  $('#sleep-at').textContent = now.stopAt ? `Se pausa a las ${time(now.stopAt)}` : '';

  for (const tr of document.querySelectorAll('#music tr[data-id]')) {
    const room = rooms[tr.dataset.id];
    const [text, kind, tip] = !room?.linked ? (room?.error ? ['No se abrió', 'bad', '']
      : ['Sin abrir', '', 'Pulsa «Abrir altavoz»: el móvil abre la página de altavoz en Chrome'])
      : room.phase === 'tap' ? SPEAKER_STATE.tap
      : room.error ? ['Error', 'bad', '']
      : SPEAKER_STATE[room.phase] || ['Conectado', '', ''];
    const clock = room?.linked && room.rtt != null ? `<span class="muted small sp-clock" title="Lo que puede desviarse su reloj del del PC">±${Math.max(1, Math.round(room.rtt / 2))} ms</span>` : '';
    tr.querySelector('.sp-state').innerHTML = `<span class="val ${kind}" title="${esc(tip)}">${esc(text)}</span>${clock}`
      + (room?.error ? `<div class="err-text small">${esc(room.error)}</div>` : '')
      + (room?.lan ? `<div class="muted small" title="Su Android es viejo: llega al PC por la wifi y Chrome no le deja mantener la pantalla encendida. Enchufado, con «Pantalla encendida mientras carga» (Ajustes), no se apaga">Por la wifi: déjalo enchufado</div>` : '');
    const on = room ? room.on : true;
    const mute = tr.querySelector('.mute');
    mute.textContent = on ? '🔊 Suena' : '🔇 Silenciado';
    mute.classList.toggle('off', !on);
    mute.title = on ? 'Silenciar este móvil' : 'Que vuelva a sonar';
    tr.classList.toggle('silenced', !on);
    const delay = room?.delay || 0;
    tr.querySelector('.delay-val').textContent = `${delay > 0 ? '+' : ''}${delay} ms`;
    // Si ya funciona, el botón la recarga (por si algo va raro); si no, la abre
    const open = tr.querySelector('[data-act=speaker-open]');
    const working = Boolean(room?.linked && room.phase && room.phase !== 'tap' && !room.error);
    open.textContent = working ? 'Reabrir' : 'Abrir altavoz';
    open.classList.toggle('primary', !working);
    open.classList.toggle('ghost', working);
    open.dataset.again = working ? '1' : '';
    open.title = working ? 'Vuelve a cargar la página de altavoz en este móvil' : 'Abre la página de altavoz en Chrome en este móvil';
  }

  const key = songs.map(s => s.id).join('\n');
  if (key !== songsKey || !$('#songs').children.length) {
    songsKey = key;
    $('#songs').innerHTML = songs.map(s => `<tr data-song="${esc(s.id)}">
        <td class="play-cell"><button class="btn small" data-act="music" data-action="play" title="Ponerla en los altavoces marcados">▶</button></td>
        <td class="app-cell"><span class="song-name">${esc(s.name)}</span>${s.test ? tag('Para cuadrar los altavoces') : ''}</td>
        <td class="dur muted small"></td>
      </tr>`).join('') + (songs.length > 1 ? '' : `<tr><td colspan="3" class="empty muted">Aún no hay canciones.
        Súbelas con «Subir canciones» o cópialas a la carpeta <code>musica</code> del proyecto (mp3, m4a, ogg, wav o flac).</td></tr>`);
  }
  for (const tr of document.querySelectorAll('#songs tr[data-song]')) {
    const s = songs.find(x => x.id === tr.dataset.song);
    tr.classList.toggle('playing', tr.dataset.song === now.song);
    tr.querySelector('.dur').textContent = mmss(s?.duration);
  }
}

async function refreshMusic() {
  state.music = await api('/music');
  if ($('#music .now')) updateMusic();
}

// El volumen de cada móvil (lo que diga el propio móvil, también si lo cambian con sus botones)
async function refreshVolumes() {
  const serials = state.devices.filter(isReady).map(d => d.serial);
  if (!serials.length) return;
  state.volumes = { ...state.volumes, ...(await api(`/music/volumes?serials=${enc(serials.join(','))}`)).volumes };
  updateVolumes();
}

// Cada móvil tiene sus pasos de volumen (15, 16, 25…): en el panel todos van de 0 a 100 %
const toPct = (level, max) => Math.round(level / max * 100);
const toLevel = (pct, max) => Math.round(pct / 100 * max);

// La barra se rellena hasta el valor (el color va en --p, de 0 a 1) y el texto dice el % del paso en que quedará
function showVolume(input) {
  const max = Number(input.dataset.max);
  input.style.setProperty('--p', input.value / 100);
  input.nextElementSibling.textContent = `${toPct(toLevel(input.value, max), max)} %`;
}

function updateVolumes() {
  for (const tr of document.querySelectorAll('#music tr[data-id]')) {
    const v = state.volumes?.[tr.dataset.serial];
    const input = tr.querySelector('.vol'), label = tr.querySelector('.vol-val');
    if (!v || input.classList.contains('busy') || document.activeElement === input) continue;
    input.disabled = Boolean(v.error);
    label.title = v.error || `${v.level} de ${v.max} pasos`;
    if (v.error) { label.textContent = '?'; continue; }
    input.dataset.max = v.max;
    input.value = toPct(v.level, v.max);
    showVolume(input);
  }
}

async function setVolume(input) {
  const serial = ctx(input, 'serial');
  input.classList.add('busy');
  try {
    const { volume } = await post('/music/volume', { serial, level: toLevel(Number(input.value), Number(input.dataset.max)) });
    (state.volumes ||= {})[serial] = volume;
  } catch (e) {
    toast(`${title(deviceBy(serial))}: ${e.message}`, 'error');
  } finally {
    input.classList.remove('busy');
    input.blur();
  }
  updateVolumes();
}

// Pulsar en la barra salta a ese punto de la canción
async function seekTo(bar, e) {
  const { now } = state.music;
  if (!now.song || !now.duration) return;
  const r = bar.getBoundingClientRect();
  await post('/music/seek', { position: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * now.duration });
  await refreshMusic();
}

// La página de altavoz en esos móviles; el panel la toca él solo para que Chrome deje sonar
async function openSpeakers(list, again = false) {
  if (!list.length) return toast('No hay móviles listos', 'error');
  const results = await Promise.all(list.map(d => post('/music/open', { serial: d.serial, id: d.serialno, again })
    .then(r => ({ d, ok: true, message: r.message }), e => ({ d, ok: false, message: e.message }))));
  const done = Map.groupBy(results.filter(r => r.ok), r => r.message);
  if (done.size) toast([...done].map(([message, l]) => `${message} en ${l.length === 1 ? title(l[0].d) : `${l.length} móviles`}`).join(' · '));
  for (const r of results.filter(x => !x.ok)) toast(`${title(r.d)}: ${r.message}`, 'error');
  await refreshMusic();
}

// Silenciar o volver a dar voz a un altavoz, de un clic
async function toggleMute(btn) {
  const id = ctx(btn, 'id');
  const room = state.music.rooms[id];
  await post('/music/room', { id, serial: ctx(btn, 'serial'), on: !(room ? room.on : true) });
  await refreshMusic();
}

async function musicOption(el) {
  try {
    if (el.id === 'shuffle') await post('/music/shuffle', { on: el.checked });
    else await post('/music/sleep', { minutes: Number(el.value) });
    await refreshMusic();
  } catch (e) { toast(e.message, 'error'); }
}

// De una en una, para no mandar varias canciones grandes a la vez
async function uploadSongs(input) {
  const files = [...input.files];
  input.value = '';
  const label = input.closest('label');
  label.classList.add('busy');
  let ok = 0;
  for (const f of files) {
    try {
      await api(`/music/upload?file=${enc(f.name)}`, { method: 'POST', file: f });
      ok++;
    } catch (e) { toast(e.message, 'error'); }
  }
  label.classList.remove('busy');
  if (ok) toast(ok === 1 ? 'Canción subida' : `${ok} canciones subidas`);
  await refreshMusic().catch(() => {});
}

// Cada segundo, cómo va la canción y cada altavoz; cada 5 s, el volumen de cada móvil; cada 10 s, si se ha
// conectado o ido algún móvil
let musicPolling = false, musicTicks = 0;
setInterval(async () => {
  if (musicPolling || document.hidden || !$('#music .now') || document.querySelector('dialog[open]')) return;
  musicPolling = true;
  try {
    await refreshMusic();
    if (++musicTicks % 5 === 0) await refreshVolumes();
    if (musicTicks % 10 === 0) {
      const ready = list => list.filter(isReady).map(d => d.serial).join(',');
      const { devices } = await api('/devices');
      const changed = ready(devices) !== ready(state.devices);
      state.devices = devices;
      if (changed && $('#music .now')) {
        renderMusic();
        updateVolumes();
      }
    }
  } catch {} finally { musicPolling = false; }
}, 1000);

// ── Ajustes comunes ─────────────────────────────────────────────────────────

async function viewSettings(current) {
  view.innerHTML = `<div class="page-head"><h1>Ajustes</h1>
      <p class="muted">Un perfil común para todos los móviles: elige cómo quieres cada ajuste y aplícalo de una vez.</p></div>
    <section id="settings">${loading('Leyendo los ajustes de cada móvil…')}</section>`;
  state.reload = async () => {
    const data = await api('/settings');
    if (!current()) return;
    state.settings = data;
    state.devices = data.devices;
    renderSettings();
  };
  await state.reload();
}

// ok: el móvil ya lo tiene como el perfil · diff: hay que cambiarlo · free: el perfil no lo toca
function settingState(d, s) {
  const want = state.settings.profile[s.key];
  return !want ? 'free' : d.settings[s.key].value === want ? 'ok' : 'diff';
}
const usable = (d, s) => d.settings && !d.settings[s.key].na;
const changes = d => state.settings.settings.filter(s => usable(d, s) && settingState(d, s) === 'diff');

function renderSettings() {
  const { settings, profile, devices } = state.settings;
  const pending = devices.reduce((n, d) => n + changes(d).length, 0);
  const label = !Object.keys(profile).length ? 'Elige abajo algún ajuste'
    : pending ? `Aplicar a todos (${pending} ${pending === 1 ? 'cambio' : 'cambios'})` : 'Todos como el perfil ✓';
  const rows = settings.map(s => `<tr data-key="${esc(s.key)}">
      <td class="app-cell"><div class="app-name">${esc(s.name)}${s.android ? tag(`Android ${s.android} o superior`) : ''}</div>
        ${s.hint ? `<div class="muted small">${esc(s.hint)}</div>` : ''}</td>
      <td class="want"><select class="want" aria-label="${esc(s.name)} en el perfil común">
        <option value="">No tocar</option>
        ${s.options.map(([v, text]) => `<option value="${esc(v)}" ${profile[s.key] === v ? 'selected' : ''}>${esc(text)}</option>`).join('')}
      </select></td>
      ${devices.map(d => settingCell(d, s)).join('')}
    </tr>`).join('');
  $('#settings').innerHTML = `
    <div class="card bar">
      <button class="btn ${pending ? 'primary' : ''}" data-act="apply-all" ${pending ? '' : 'disabled'}>${label}</button>
      <span class="muted small">Lo que dejes en «No tocar» se queda como esté en cada móvil.</span>
    </div>
    ${devices.length ? '' : '<p class="problem">No hay móviles listos: conéctalos en <a href="#/">Dispositivos</a>.</p>'}
    ${devices.filter(d => d.error).map(d => `<p class="problem">${esc(title(d))}: ${esc(d.error)}</p>`).join('')}
    <div class="card flush scroll-x"><table class="matrix settings">
      <thead><tr><th>Ajuste</th><th>Perfil común</th>${devices.map(d => `<th class="dev-col">${esc(title(d))}</th>`).join('')}</tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="legend muted small">
      <span><span class="val ok">Así</span> como el perfil</span>
      <span><span class="val diff">Así</span> distinto: púlsalo para cambiarlo en ese móvil</span>
      <span><span class="val">Así</span> el perfil no lo toca</span>
      <span><span class="none">—</span> su Android no lo tiene</span></p>`;
}

function settingCell(d, s) {
  if (!d.settings) return `<td class="cell"><span class="none" title="${esc(d.error || 'No se pudo leer')}">?</span></td>`;
  const v = d.settings[s.key];
  if (v.na) return `<td class="cell"><span class="none" title="${esc(`${title(d)}: ${v.na}`)}">—</span></td>`;
  const st = settingState(d, s);
  const now = v.text ?? '?';
  if (st !== 'diff') return `<td class="cell"><span class="val ${st}">${esc(now)}</span></td>`;
  const want = s.options.find(([o]) => o === state.settings.profile[s.key])[1];
  const tip = `${title(d)}: ${now} → ${want}. Pulsa para cambiarlo`;
  return `<td class="cell" data-serial="${esc(d.serial)}"><button class="val diff" data-act="apply-cell"
    title="${esc(tip)}" aria-label="${esc(tip)}">${esc(now)}</button></td>`;
}

// Cambiar el perfil no toca los móviles: marca lo que cambiaría, y se aplica con los botones
async function setWant(select) {
  const key = ctx(select, 'key');
  try {
    await post('/settings/profile', { key, value: select.value });
    const { profile } = state.settings;
    if (select.value) profile[key] = select.value;
    else delete profile[key];
  } catch (e) { toast(e.message, 'error'); }
  renderSettings();
  $(`#settings tr[data-key="${key}"] select`)?.focus();
}

async function applySettings(body) {
  const { results } = await post('/settings/apply', body);
  const ok = results.filter(r => r.ok);
  if (results.length === 1 && ok.length) toast(`${title(deviceBy(ok[0].serial))}: ${ok[0].message}`);
  else if (ok.length) toast(`Ajustes aplicados en ${ok.length} ${ok.length === 1 ? 'móvil' : 'móviles'}`);
  for (const r of results.filter(x => !x.ok)) toast(`${title(deviceBy(r.serial))}: ${r.message}`, 'error');
  await state.reload();
}

// ── Instalar APK ────────────────────────────────────────────────────────────

async function viewInstall(current) {
  let apk = null;
  view.innerHTML = `
    <div class="page-head"><h1>Instalar APK</h1><p class="muted">Instala o actualiza una app en varios móviles a la vez.</p></div>
    <form class="card" id="install-form">
      <label class="drop" id="drop">
        <input type="file" id="apk" accept=".apk" hidden>
        <strong id="drop-text">Arrastra aquí un .apk o haz clic para elegirlo</strong>
        <span class="muted small">De momento solo APK de una pieza; los .apks / .xapk partidos aún no.</span>
      </label>
      <fieldset id="targets"><legend>Instalar en</legend>${loading('Buscando móviles…')}</fieldset>
      <button class="btn primary" id="install-btn">Instalar</button>
      <ul id="results" class="results"></ul>
    </form>`;
  const drop = $('#drop');
  const pick = file => {
    apk = file;
    drop.classList.toggle('has', Boolean(file));
    $('#drop-text').textContent = file ? `${file.name} · ${(file.size / 1048576).toFixed(1)} MB` : 'Arrastra aquí un .apk o haz clic para elegirlo';
  };
  $('#apk').onchange = e => pick(e.target.files[0]);
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => {
    e.preventDefault();
    drop.classList.remove('over');
    pick(e.dataTransfer.files[0]);
  };

  const { devices } = await api('/devices');
  if (!current()) return;
  state.devices = devices;
  const ready = devices.filter(d => d.state === 'device' && !d.error);
  $('#targets').innerHTML = '<legend>Instalar en</legend>' + (ready.map(d => `<label class="check">
      <input type="checkbox" name="serial" value="${esc(d.serial)}" checked> ${esc(title(d))}</label>`).join('')
    || '<p class="muted">No hay móviles listos. Conéctalos en <a href="#/">Dispositivos</a>.</p>');

  $('#install-form').onsubmit = async e => {
    e.preventDefault();
    const serials = [...document.querySelectorAll('input[name=serial]:checked')].map(i => i.value);
    if (!apk) return toast('Elige primero un archivo .apk', 'error');
    if (!serials.length) return toast('Marca al menos un móvil', 'error');
    $('#results').innerHTML = '';
    await busy($('#install-btn'), async () => {
      const { results } = await api(`/install?serials=${enc(serials.join(','))}`, { method: 'POST', file: apk });
      $('#results').innerHTML = results.map(r => `<li><strong>${esc(title(deviceBy(r.serial)))}</strong>:
        <span class="${r.ok ? 'ok-text' : 'err-text'}">${esc(r.message)}</span></li>`).join('');
    });
  };
  state.reload = async () => {};
}

// ── Botones y formularios ───────────────────────────────────────────────────

const actions = {
  app: appAction,
  keep: toggleKeep,
  rename: renameDevice,
  prune,
  debloat,
  'add-app': () => addAppDialog(),
  'sync-all': btn => busy(btn, () => syncNow({}, 'Instalando lo pendiente')),
  'sync-app': btn => busy(btn, () => syncNow({ pkg: ctx(btn, 'pkg') }, 'Instalando')),
  'sync-cell': btn => busy(btn, () => syncNow({ pkg: ctx(btn, 'pkg'), serial: ctx(btn, 'serial') }, 'Instalando')),
  'rename-app': renameApp,
  'remove-app': btn => busy(btn, async () => { if (await removeApp(ctx(btn, 'pkg'))) await state.reload(); }),
  auto: async btn => {
    try {
      await post('/catalog/auto', { on: btn.checked });
      toast(btn.checked ? 'Activado: cada 5 minutos se instalan y actualizan solas las apps de APK y F-Droid' : 'Instalación automática desactivada');
    } catch (e) {
      btn.checked = !btn.checked;
      toast(e.message, 'error');
    }
  },
  'apply-all': btn => busy(btn, () => applySettings({ serials: state.settings.devices.filter(d => changes(d).length).map(d => d.serial) })),
  'apply-cell': btn => busy(btn, () => applySettings({ serials: [ctx(btn, 'serial')], key: ctx(btn, 'key') })),
  quick: btn => busy(btn, () => runQuick(ctx(btn, 'serial'), btn.dataset.action)),
  music: btn => busy(btn, async () => {
    const { warning } = await post(`/music/${btn.dataset.action}`, { song: ctx(btn, 'song'), id: ctx(btn, 'id') });
    if (warning) toast(warning, 'error');
    await refreshMusic();
  }),
  'speaker-open': btn => busy(btn, () => openSpeakers([deviceBy(ctx(btn, 'serial'))], btn.dataset.again === '1')),
  'speaker-all': btn => busy(btn, () => openSpeakers(state.devices.filter(isReady))),
  'music-folder': btn => busy(btn, () => post('/music/folder')),
  mute: btn => busy(btn, () => toggleMute(btn)),
  seek: (bar, e) => seekTo(bar, e).catch(err => toast(err.message, 'error')),
  delay: btn => busy(btn, async () => {
    const id = ctx(btn, 'id');
    await post('/music/room', { id, serial: ctx(btn, 'serial'), delay: (state.music.rooms[id]?.delay || 0) + Number(btn.dataset.step) });
    await refreshMusic();
  }),
  screenshot: btn => busy(btn, () => showScreenshot(btn)),
  screen: btn => busy(btn, async () => {
    const d = deviceBy(ctx(btn, 'serial'));
    toast((await post(`/devices/${enc(d.serial)}/screen`, { title: title(d) })).message);
  }),
  qr: btn => busy(btn, async () => { showQr(await post('/qr')); }),
  wifi: btn => busy(btn, async () => {
    toast('Pasando a wifi; tarda unos segundos…');
    toast((await post(`/devices/${enc(ctx(btn, 'serial'))}/wifi`)).message);
    await state.reload();
  }),
  reconnect: btn => busy(btn, async () => {
    toast((await post(`/devices/${enc(ctx(btn, 'serial'))}/reconnect`)).message);
    await state.reload();
  }),
  disconnect: btn => busy(btn, async () => {
    await post(`/devices/${enc(ctx(btn, 'serial'))}/disconnect`);
    await state.reload();
  }),
  'connect-saved': btn => busy(btn, async () => {
    const { results } = await post('/connect-saved');
    for (const r of results) toast(`${r.ip}: ${r.message}`, r.ok ? 'ok' : 'error');
    await state.reload();
  }),
};

view.addEventListener('click', e => {
  const btn = e.target.closest('[data-act]');
  if (btn && !btn.disabled) actions[btn.dataset.act](btn, e);
});

view.addEventListener('input', e => {
  if (e.target.matches('.vol')) showVolume(e.target);
});

view.addEventListener('change', e => {
  if (e.target.matches('select.want')) setWant(e.target);
  if (e.target.matches('.vol')) setVolume(e.target);
  if (e.target.matches('#shuffle, #sleep')) musicOption(e.target);
  if (e.target.matches('#song-files')) uploadSongs(e.target);
});

view.addEventListener('submit', async e => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const f = Object.fromEntries(new FormData(form));
  const kind = form.dataset.form;
  await busy(e.submitter || form.querySelector('button'), async () => {
    if (kind === 'open') return runQuick(ctx(form, 'serial'), e.submitter?.value === 'close' ? 'close' : 'open', f);
    if (kind === 'notify') {
      await runQuick(ctx(form, 'serial'), 'notify', f);
      return form.reset();
    }
    const r = kind === 'pair' ? await post('/pair', { host: f.host.trim(), code: f.code.trim() }) : await post('/connect', { host: f.host.trim() });
    toast(r.message);
    form.reset();
    await state.reload();
  });
});

$('#refresh').onclick = () => { checkStatus().catch(() => {}); route(); };
window.addEventListener('hashchange', route);
checkStatus().catch(e => toast(`No contesta el panel: ${e.message}`, 'error'));
route();
