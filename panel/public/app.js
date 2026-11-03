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

// Como ask, pero con varias salidas: buttons es [[valor, texto, clase]]; devuelve el valor elegido o '' si se cancela
function choose(title, html, buttons) {
  const dlg = $('#dialog');
  dlg.className = '';
  dlg.innerHTML = `<form method="dialog">
      <h2>${esc(title)}</h2><div class="dlg-body">${html}</div>
      <menu><button class="btn" value="">Cancelar</button>${buttons.map(([value, label, kind = '']) =>
        `<button class="btn ${kind}" value="${esc(value)}">${esc(label)}</button>`).join('')}</menu>
    </form>`;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise(resolve => dlg.addEventListener('close', () => resolve(dlg.returnValue), { once: true }));
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
  const tab = ['apps', 'music', 'settings'].find(t => hash.startsWith(`#/${t}`)) || 'devices';
  for (const a of document.querySelectorAll('nav a')) a.classList.toggle('active', a.dataset.tab === tab);
  const m = hash.match(/^#\/device\/(.+)$/);
  const show = m ? viewDevice(decodeURIComponent(m[1]), current)
    : tab === 'apps' ? viewOverview(current, hash.startsWith('#/apps/limpiar') ? 'limpiar' : 'favoritas')
    : tab === 'music' ? viewMusic(current)
    : tab === 'settings' ? viewSettings(current)
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
    </section>
    <section class="card lan" id="lan"></section>`;
  state.reload = () => loadGrid(current);
  api('/red').then(s => { if (current() && $('#lan')) $('#lan').innerHTML = lanHtml(s); }).catch(() => {});
  await loadGrid(current);
}

// El panel desde otro móvil, tablet u ordenador de la misma red; con las direcciones para abrirlo, si está encendido
const lanHtml = ({ on, urls, qr }) => `
  <label class="switch"><input type="checkbox" data-act="lan" ${on ? 'checked' : ''}><span class="knob"></span>Abrir el panel desde otros dispositivos de casa</label>
  <p class="muted">${on && urls.length
    ? `Desde el móvil, la tablet u otro ordenador conectados a tu red, abre ${urls.map(u => `<a href="${esc(u)}">${esc(u)}</a>`).join(' o ')}.`
    : 'Para usarlo desde el móvil, la tablet u otro ordenador conectados a la misma red que este PC.'}
    Solo dentro de casa: desde internet no contesta. No pide contraseña, así que cualquiera conectado a tu red podría usarlo.
    «Ver pantalla» abre la pantalla del móvil en este PC.</p>
  ${qr ? `<div class="lan-qr"><div class="qr-code">${qr}</div>
    <p class="muted small">Desde un móvil, apúntale con la cámara: abre la música del panel. Chrome avisará de que la
      conexión no es segura (el panel no usa https): pulsa «Ir al sitio». Luego, en ⋮, «Añadir a pantalla de inicio» lo
      deja a mano.</p></div>` : ''}`;

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
  // En GB de los del móvil (de 1000 MB), que es como lo cuentan sus Ajustes. Poco sitio: menos de 1 GB o del 10 %
  const space = d.storage && (() => {
    const { free, total } = d.storage;
    const used = Math.round((1 - free / total) * 100);
    return `<span class="chip ${free < 1e9 || free < total / 10 ? 'low' : ''}"
      title="Almacenamiento interno: ${gb(free)} libres de ${gb(total)} (${used} % ocupado)">${ICON.disk}${gb(free)} libres</span>`;
  })();
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
      <span class="chip">${d.wifi ? `Wi-Fi · ${esc(d.ip || d.serial.split(':')[0])}` : 'Cable USB'}</span>${battery}${space || ''}
    </div>
    ${problem ? `<p class="problem">${esc(problem)}</p>` : ''}
    <div class="actions">
      ${ready ? `<a class="btn primary" href="#/device/${enc(d.serial)}" title="Acciones rápidas y sus apps">${ICON.control}Controlar</a>` : ''}
      ${ready ? iconBtn('screen', ICON.look, 'Ver pantalla: verla y manejarla desde el PC') : ''}
      ${ready && !d.wifi ? iconBtn('wifi', ICON.wifi, 'Pasar a Wi-Fi: seguir conectado sin el cable') : ''}
      ${retry ? '<button class="btn primary" data-act="reconnect">Reintentar</button>' : ''}
      ${d.wifi ? iconBtn('disconnect', ICON.unplug, 'Desconectar', 'ghost end') : ''}
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

// «Ver pantalla» abre scrcpy en una ventana del PC; en Android 4, que scrcpy no aguanta, el panel responde viewer
async function openScreen(d) {
  const res = await post(`/devices/${enc(d.serial)}/screen`, { title: title(d) });
  if (res.viewer) showViewer(d);
  return res;
}

// El visor de los Android viejos: una captura tras otra mientras esté abierto. Un clic es un toque y arrastrar es
// deslizar el dedo; el móvil los hace en píxeles de la captura
function showViewer(d) {
  const dlg = $('#dialog');
  dlg.className = 'wide';
  dlg.innerHTML = `<form method="dialog">
      <h2>Pantalla de ${esc(title(d))}</h2>
      <div class="viewer"><img class="shot" draggable="false" alt="Pantalla de ${esc(title(d))}"></div>
      <p class="muted small">Android ${esc(d.android)} no deja abrirla en una ventana: aquí se ve a base de capturas, que tardan
        un par de segundos. Haz clic para tocar y arrastra para deslizar el dedo; el móvil tarda un poco en hacerlo.
        Si se ve negra, la pantalla está apagada o descansando: tócala.</p>
      <menu><button class="btn" type="button" data-key="back">Atrás</button><button class="btn" type="button" data-key="home">Inicio</button><button
        class="btn" type="button" data-key="power">Encender / apagar</button><button class="btn primary" value="close">Cerrar</button></menu>
    </form>`;
  const img = dlg.querySelector('.shot'), fail = e => toast(`${title(d)}: ${e.message}`, 'error');
  const point = e => {
    const r = img.getBoundingClientRect(), clamp = (v, max) => Math.max(0, Math.min(max - 1, Math.round(v * max)));
    return { x: clamp((e.clientX - r.left) / r.width, img.naturalWidth), y: clamp((e.clientY - r.top) / r.height, img.naturalHeight) };
  };
  // Un círculo donde se ha tocado, porque el móvil tarda en reaccionar
  const mark = e => {
    const box = img.parentElement.getBoundingClientRect(), dot = document.createElement('i');
    dot.className = 'dot';
    dot.style.left = `${e.clientX - box.left}px`;
    dot.style.top = `${e.clientY - box.top}px`;
    img.parentElement.append(dot);
    setTimeout(() => dot.remove(), 1200);
  };
  let from = null;
  img.addEventListener('pointerdown', e => { e.preventDefault(); if (img.naturalWidth) from = point(e); });
  img.addEventListener('pointerup', e => {
    if (!from) return;
    const to = point(e), start = from;
    from = null;
    mark(e);
    const swipe = Math.hypot(to.x - start.x, to.y - start.y) > img.naturalWidth * 0.03;
    post(`/devices/${enc(d.serial)}/touch`, swipe ? { ...start, x2: to.x, y2: to.y } : start).catch(fail);
  });
  for (const btn of dlg.querySelectorAll('[data-key]')) {
    btn.addEventListener('click', () => post(`/devices/${enc(d.serial)}/do/${btn.dataset.key}`).catch(fail));
  }
  dlg.showModal();
  (async () => {
    while (img.isConnected && dlg.open) {
      try {
        img.src = (await api(`/devices/${enc(d.serial)}/screenshot`)).image;
      } catch (e) {
        if (img.isConnected && dlg.open) fail(e);
        return;
      }
      await new Promise(r => setTimeout(r, 300));
    }
  })();
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
  title="${on ? 'Favorita. Pulsa para quitarla de favoritas' : 'Hacerla favorita: se instalará en todos los móviles'}">★</button>`;

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

// La estrella hace favorita una app (eligiendo de dónde instalarla) o la quita de favoritas
async function toggleKeep(btn) {
  const pkg = ctx(btn, 'pkg');
  if (!btn.classList.contains('on')) {
    const serial = ctx(btn, 'serial') || state.cleanup?.devices.find(d => d.apps[pkg]?.[1])?.serial;
    return addAppDialog({ pkg, serial });
  }
  try {
    if (await removeApp(pkg, state.apps.find(a => a.pkg === pkg)?.note)) await state.reload();
  } catch (e) { toast(e.message, 'error'); }
}

// ── Apps: las favoritas y lo que sobra ──────────────────────────────────────

const SOURCES = { apk: 'APK propio', fdroid: 'F-Droid', play: 'Google Play' };
const time = ts => new Date(ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
const hue = s => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const appIcon = a => (a.icon
  ? `<img class="app-icon" src="${esc(a.icon)}" alt="">`
  : `<span class="app-icon letter" style="--hue:${hue(a.pkg)}">${esc((a.name || a.pkg)[0].toUpperCase())}</span>`);

// Dos pestañas: Favoritas, las apps que quieres y en qué móviles, y Limpiar, todo lo demás. La que se ve va en la dirección
// (#/apps o #/apps/limpiar), sin volver a cargar la página al cambiar
async function viewOverview(current, tab) {
  view.innerHTML = `<div class="page-head"><h1>Apps</h1>
      <p class="muted">Tus favoritas, en los móviles que las necesitan; lo demás, fuera.</p></div>
    <div class="segmented apps-tabs" role="tablist">
      <button type="button" role="tab" data-act="apps-tab" data-tab="favoritas">Favoritas</button>
      <button type="button" role="tab" data-act="apps-tab" data-tab="limpiar">Limpiar<span id="clean-count"></span></button>
    </div>
    <section id="catalog" data-tab="favoritas">${loading('Comprobando qué tiene cada móvil…')}</section>
    <section id="cleanup" data-tab="limpiar">${loading('Mirando todas las apps de cada móvil…')}</section>`;
  showAppsTab(tab);
  state.reloadCleanup = () => api('/cleanup').then(data => {
    if (!current()) return;
    state.cleanup = data;
    renderCleanup();
  });
  state.reload = () => Promise.all([
    api('/catalog').then(data => {
      if (!current()) return;
      state.catalog = data;
      state.devices = data.devices;
      $('#catalog').innerHTML = catalogHtml(data);
    }),
    state.reloadCleanup(),
  ]);
  await state.reload();
}

function showAppsTab(tab) {
  for (const b of document.querySelectorAll('.apps-tabs [data-tab]')) b.classList.toggle('on', b.dataset.tab === tab);
  for (const s of document.querySelectorAll('section[data-tab]')) s.hidden = s.dataset.tab !== tab;
  history.replaceState(null, '', tab === 'limpiar' ? '#/apps/limpiar' : '#/apps');
}

function catalogHtml({ apps, devices, auto, last }) {
  const pending = (d, a) => d.status?.[a.pkg] && !['ok', 'skip'].includes(d.status[a.pkg].state);
  const total = devices.reduce((n, d) => n + apps.filter(a => pending(d, a)).length, 0);
  // En la cabecera de cada móvil, poner de una vez las favoritas que le faltan
  const head = d => {
    const n = apps.filter(a => pending(d, a)).length;
    return `<th class="dev-col" data-serial="${esc(d.serial)}">${esc(title(d))}${n ? `<button class="btn small dev-act" data-act="sync-phone"
      title="Instala en ${esc(title(d))} las ${n} favoritas que le faltan o tienen versión nueva">Poner (${n})</button>` : ''}</th>`;
  };
  const bar = `<div class="card bar">
      <button class="btn primary" data-act="add-app">＋ Añadir favorita</button>
      <button class="btn" data-act="sync-all" ${total ? '' : 'disabled'}>${total ? `Instalar lo pendiente (${total})` : 'Todo al día ✓'}</button>
      <span class="spacer"></span>
      <label class="switch" title="Cada 5 minutos instala y actualiza en los móviles conectados las apps de APK propio y F-Droid">
        <input type="checkbox" data-act="auto" ${auto ? 'checked' : ''}><span class="knob"></span>Instalar y actualizar solas</label>
      ${last ? `<span class="muted small">Última vez a las ${time(last.at)}: ${last.ok} ${last.ok === 1 ? 'hecha' : 'hechas'}${last.failed ? `, ${last.failed} con error` : ''}</span>` : ''}
    </div>`;
  if (!apps.length) return `${bar}<div class="card empty"><strong>Aún no hay favoritas.</strong>
    <p class="muted">Añade las que quieres en los móviles: tu propio APK, una app de F-Droid o una de Google Play.</p></div>`;
  const rows = apps.map(a => `<tr data-pkg="${esc(a.pkg)}">
      <td class="app-cell"><div class="app-id">${appIcon(a)}<div>
        <div class="app-name">${esc(a.name)}</div>
        <code class="app-pkg">${esc(a.pkg).replace(/\./g, '.<wbr>')}</code>
        <div class="app-src">${tag((a.url ? 'Enlace' : SOURCES[a.source]) + (a.versionName ? ` · ${a.versionName}` : ''), `src-${a.source}`)}</div>
      </div></div></td>
      ${devices.map(d => statusCell(d, a)).join('')}
      <td class="row-actions">
        ${!devices.some(d => pending(d, a)) ? '' : a.source === 'play'
    ? iconBtn('sync-app', ICON.store, 'Abrir Google Play en los móviles donde falta, para pulsar «Instalar»', 'small')
    : iconBtn('sync-app', ICON.download, 'Instalarla en los móviles donde falta o tiene versión nueva', 'small')}
        ${iconBtn('rename-app', ICON.edit, 'Cambiar el nombre', 'small ghost')}
        ${iconBtn('remove-app', ICON.trash, 'Quitarla de favoritas y, si quieres, desinstalarla de todos', 'small ghost danger')}
      </td>
    </tr>`).join('');
  return `${bar}
    ${devices.length ? '' : '<p class="problem">No hay móviles listos: conéctalos en <a href="#/">Dispositivos</a>.</p>'}
    <div class="card flush scroll-x"><table class="matrix catalog">
      <thead><tr><th>Favorita</th>${devices.map(head).join('')}<th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="legend muted small">
      <span><span class="st ok">✓</span> instalada</span><span><span class="st update">↑</span> hay versión nueva</span>
      <span><span class="st missing">+</span> falta</span><span><span class="st missing">▶</span> falta, de Google Play</span>
      <span><span class="st skip">–</span> ese móvil no la necesita</span><span><span class="st error">!</span> falló</span>
      <span>· Pulsa una celda para instalarla, quitarla de ese móvil o marcar que no la necesita.</span></p>`;
}

function statusCell(d, a) {
  const s = d.status?.[a.pkg];
  if (!s) return `<td class="cell" data-label="${esc(title(d))}"><span class="none" title="${esc(d.status?.error || 'No se pudo leer el móvil')}">?</span></td>`;
  const where = title(d);
  const [label, kind, tip] = s.state === 'skip' ? (s.have != null
    ? ['✓', 'skip', `Instalada en ${where}, aunque has dicho que no la necesita`] : ['–', 'skip', `${where} no la necesita: ni se instala ni se actualiza`])
    : s.state === 'ok' ? ['✓', 'ok', `Instalada en ${where}${s.have ? ` (versión ${s.have})` : ''}`]
    : s.error ? ['!', 'error', `Falló en ${where}: ${s.error}`]
    : s.state === 'update' ? ['↑', 'update', `Hay versión nueva para ${where} (tiene la ${s.have})`]
    : a.source === 'play' ? ['▶', 'missing', `Falta en ${where}; se instala desde Google Play`]
    : ['+', 'missing', `Falta en ${where}`];
  return `<td class="cell" data-serial="${esc(d.serial)}" data-label="${esc(where)}"><button class="st ${kind}" data-act="app-cell"
    title="${esc(tip)}. Pulsa para elegir qué hacer" aria-label="${esc(tip)}">${label}</button></td>`;
}

// Una favorita en un móvil: instalarla o ponerla al día, quitarla de ese móvil, o marcar si la necesita
async function appCell(btn) {
  const pkg = ctx(btn, 'pkg'), serial = ctx(btn, 'serial');
  const a = state.catalog.apps.find(x => x.pkg === pkg), d = state.catalog.devices.find(x => x.serial === serial);
  const s = d.status[pkg], play = a.source === 'play';
  const screen = play ? '<p class="muted">Se abre Google Play en el móvil y su pantalla en el PC, para que pulses «Instalar».</p>' : '';
  const [text, buttons] = s.state === 'skip' ? (s.have != null
    ? ['<p>Está instalada, aunque has dicho que este móvil no la necesita.</p>', [['uninstall', 'Desinstalarla', 'danger'], ['want', 'Sí la necesita', 'primary']]]
    : [`<p>Este móvil no la necesita: ni se instala ni se actualiza.</p>${screen}`, [['add', 'Ponerla en este móvil', 'primary']]])
    : s.state === 'ok' ? [`<p>Instalada${s.have ? ` (versión ${esc(s.have)})` : ''}.</p><p class="muted">«Quitarla» la desinstala de este móvil,
        con sus datos, y deja de instalarse aquí. En los demás sigue igual.</p>`, [['remove', 'Quitarla de este móvil', 'danger']]]
    : [`<p>${esc(s.error ? `Falló: ${s.error}` : s.state === 'update' ? `Tiene la versión ${s.have} y hay una nueva.` : 'No está instalada.')}</p>${screen}`,
      [['skip', 'No la necesita'], ['install', play ? 'Abrir Google Play' : s.state === 'update' ? 'Actualizar' : 'Instalar', 'primary']]];
  const choice = await choose(`${a.name} en ${title(d)}`, text, buttons);
  if (!choice) return;
  const want = on => post(`/catalog/${enc(pkg)}/want`, { serialno: d.serialno, on });
  await busy(btn, async () => {
    if (choice === 'install') return syncNow({ pkg, serial }, 'Instalando');
    if (choice === 'add') {
      await want(true);
      return syncNow({ pkg, serial }, 'Instalando');
    }
    if (choice === 'remove' || choice === 'uninstall') {
      toast((await post(`/devices/${enc(serial)}/apps/${enc(pkg)}/uninstall`)).message);
      if (choice === 'remove') await want(false);
    }
    if (choice === 'skip') await want(false);
    if (choice === 'want') await want(true);
    await state.reload();
  });
}

// ── Limpiar ──
// Lo que sobra: tus apps que no son favoritas y las del sistema que sugiere el panel o que marcas tú, más las del sistema
// que ya se quitaron, para poder recuperarlas. Nunca las favoritas, las de «No tocar» ni las imprescindibles. En cada
// móvil, «on» si la tiene y «off» si se quitó

const CLEAN_KIND = { mine: '', suggested: 'Sugerida', marked: 'Marcada por ti', removed: 'Quitada' };
const appLabel = pkg => state.names?.[pkg]?.name || state.cleanup?.suggested[pkg] || pkg;

function cleanupRows({ devices, favorites, suggested, marked, ignored }) {
  const fav = new Set(favorites), skip = new Set(ignored), mine = new Set(marked);
  const rows = new Map();
  for (const d of devices) {
    for (const [pkg, [system, installed, , needed]] of Object.entries(d.apps)) {
      if (fav.has(pkg) || needed || (!system && !installed)) continue;
      const kind = !system ? 'mine' : mine.has(pkg) ? 'marked' : pkg in suggested ? 'suggested' : 'removed';
      if (kind !== 'removed' && skip.has(pkg)) continue;
      if (!rows.has(pkg)) rows.set(pkg, { pkg, system: Boolean(system), kind, cells: new Map() });
      rows.get(pkg).cells.set(d.serial, installed ? 'on' : 'off');
    }
  }
  // De las que no están en ninguna lista, solo las que algún móvil tiene quitadas
  return [...rows.values()].filter(r => r.kind !== 'removed' || [...r.cells.values()].includes('off'))
    .sort((a, b) => a.system - b.system || appLabel(a.pkg).localeCompare(appLabel(b.pkg), 'es'));
}

// Lo que se quitaría (de un móvil, de una app o de todo): sus celdas «on», salvo las de «Quitada», que no están en ninguna lista
const removable = (serial, pkg) => (state.cleanRows || []).filter(r => r.kind !== 'removed' && (!pkg || r.pkg === pkg))
  .flatMap(r => [...r.cells].filter(([s, v]) => v === 'on' && (!serial || s === serial))
    .map(([s]) => ({ serial: s, pkg: r.pkg, note: appLabel(r.pkg) })));

function renderCleanup() {
  const data = state.cleanup, { devices } = data;
  const rows = state.cleanRows = cleanupRows(data);
  const total = removable().length;
  $('#clean-count').textContent = total ? ` (${total})` : '';
  const head = d => {
    const n = removable(d.serial).length;
    return `<th class="dev-col" data-serial="${esc(d.serial)}">${esc(title(d))}${n ? `<button class="btn small danger dev-act" data-act="clean-phone"
      title="Quita de ${esc(title(d))} las ${n} apps que sobran">Limpiar (${n})</button>` : ''}</th>`;
  };
  const group = (label, list) => (list.length
    ? `<tr class="group"><th colspan="${devices.length + 3}">${label}</th></tr>${list.map(cleanRow).join('')}` : '');
  $('#cleanup').innerHTML = `
    <div class="card bar">
      <span>${total ? `Sobran <strong>${total}</strong> ${total === 1 ? 'app' : 'apps'} en los móviles` : 'Los móviles están limpios ✓'}</span>
      <span class="spacer"></span>
      <button class="btn danger" data-act="clean-all" ${total ? '' : 'disabled'}>Limpiar todos…</button>
    </div>
    ${devices.filter(d => d.error).map(d => `<p class="problem">${esc(title(d))}: ${esc(d.error)}</p>`).join('')}
    ${rows.length ? `<div class="card flush scroll-x"><table class="matrix cleanup">
      <thead><tr><th></th><th>App</th>${devices.map(head).join('')}<th></th></tr></thead>
      <tbody>${group('Instaladas por ti', rows.filter(r => !r.system))}${group('Del sistema', rows.filter(r => r.system))}</tbody>
    </table></div>
    <p class="legend muted small"><span><span class="st update">●</span> sobra: púlsala para quitarla de ese móvil</span>
      <span><span class="st skip">○</span> quitada: púlsala para recuperarla</span><span><span class="none">·</span> no la tiene</span>
      <span>· Las del sistema se quitan solo para el usuario del móvil: no se borran y se pueden recuperar.</span></p>` : ''}
    <div class="card clean-search">
      <h3>¿Sobra alguna más?</h3>
      <p class="muted small">Busca entre las apps del sistema de los móviles y márcala para quitarla. No salen las favoritas ni las
        imprescindibles: Chrome, Google Play, el escritorio, el teclado y el propio sistema.</p>
      <input type="search" id="clean-search" placeholder="Busca por nombre o paquete: facebook, música, samsung…" autocomplete="off"
        aria-label="Buscar apps del sistema" value="${esc(state.cleanQuery || '')}">
      <ul class="clean-results" id="clean-results"></ul>
    </div>
    ${data.ignored.length ? `<details class="card"><summary>No se tocan (${data.ignored.length})</summary>
      <p class="muted small">Ni se sugieren ni se quitan al limpiar.</p>
      <ul class="clean-results">${data.ignored.map(pkg => cleanItem(pkg, '',
        '<button class="btn small" data-act="clean-mark" data-mark="">Volver a sugerir</button>')).join('')}</ul></details>` : ''}`;
  searchCleanup();
  fetchNames([...rows.map(r => r.pkg), ...data.ignored]);
}

function cleanRow(r) {
  const { devices, suggested } = state.cleanup;
  const info = state.names?.[r.pkg];
  // Con el nombre de Google Play, lo que dice la sugerencia va debajo (si no dice lo mismo)
  const why = info?.name && suggested[r.pkg] && fold(suggested[r.pkg]) !== fold(info.name)
    ? `<span class="why">${esc(suggested[r.pkg])}</span>` : '';
  const cells = devices.map(d => {
    const v = r.cells.get(d.serial), where = title(d);
    if (!v) return `<td class="cell" data-label="${esc(where)}"><span class="none" title="${esc(where)} no la tiene">·</span></td>`;
    const [label, kind, tip] = v === 'on'
      ? ['●', r.kind === 'removed' ? 'missing' : 'update', `En ${where}. Pulsa para quitarla de ese móvil`]
      : ['○', 'skip', `Quitada de ${where}. Pulsa para recuperarla`];
    return `<td class="cell" data-serial="${esc(d.serial)}" data-label="${esc(where)}"><button class="st ${kind}" data-act="clean-cell"
      title="${esc(tip)}" aria-label="${esc(tip)}">${label}</button></td>`;
  }).join('');
  const has = v => [...r.cells.values()].includes(v);
  const actions = [
    r.kind !== 'removed' && has('on') && '<button class="btn small danger" data-act="clean-row" title="Quitarla de todos los móviles que la tienen">Quitar de todos</button>',
    has('off') && '<button class="btn small" data-act="restore-row" title="Recuperarla en los móviles donde se quitó">Recuperar</button>',
    r.kind !== 'removed' && '<button class="btn small ghost" data-act="clean-mark" data-mark="ignore" title="Que no se sugiera ni se quite al limpiar">No tocar</button>',
  ].filter(Boolean).join('');
  return `<tr data-pkg="${esc(r.pkg)}">
    <td class="star-cell">${r.system ? '' : starButton(r.pkg, false)}</td>
    <td class="app-cell"><div class="app-id">${appIcon({ pkg: r.pkg, name: appLabel(r.pkg), icon: info?.icon })}<div>
      <div class="app-name">${esc(appLabel(r.pkg))}</div>
      <div class="app-meta">${why}<code>${esc(r.pkg)}</code>${CLEAN_KIND[r.kind] ? tag(CLEAN_KIND[r.kind], r.kind === 'removed' ? '' : 'warn') : ''}</div>
    </div></div></td>
    ${cells}
    <td class="row-actions"><div class="stack">${actions}</div></td>
  </tr>`;
}

// Una app en una lista corta (lo buscado, las de «No tocar»): icono, nombre, paquete, una nota y un botón
const cleanItem = (pkg, note, button) => `<li data-pkg="${esc(pkg)}">${appIcon({ pkg, name: appLabel(pkg), icon: state.names?.[pkg]?.icon })}
  <span class="clean-name"><strong>${esc(appLabel(pkg))}</strong><code>${esc(pkg)}</code>${note ? `<span class="muted small">${esc(note)}</span>` : ''}</span>
  ${button}</li>`;

// Las del sistema que aún no están en la lista y coinciden con lo buscado, para marcarlas (como mucho 30)
function searchCleanup() {
  const box = $('#clean-results'), text = (state.cleanQuery || '').trim(), q = fold(text);
  if (!box) return;
  if (q.length < 2) {
    box.innerHTML = '';
    return;
  }
  const { devices, favorites, ignored } = state.cleanup;
  const listed = new Set([...state.cleanRows.filter(r => r.kind !== 'removed').map(r => r.pkg), ...favorites, ...ignored]);
  const found = new Map();
  for (const d of devices) {
    for (const [pkg, [system, installed, , needed]] of Object.entries(d.apps)) {
      if (!system || needed || listed.has(pkg) || !fold(`${pkg} ${appLabel(pkg)}`).includes(q)) continue;
      if (!found.has(pkg)) found.set(pkg, []);
      if (installed) found.get(pkg).push(title(d));
    }
  }
  const list = [...found].slice(0, 30);
  box.innerHTML = list.map(([pkg, where]) => cleanItem(pkg, where.length ? `En ${where.join(', ')}` : 'Quitada en todos',
    '<button class="btn small danger" data-act="clean-mark" data-mark="remove">Sobra</button>')).join('')
    || `<li class="muted">Ninguna app del sistema coincide con «${esc(text)}».</li>`;
  fetchNames(list.map(([pkg]) => pkg));
}

// Nombres e iconos de Google Play, de 40 en 40, para lo que se está enseñando; al llegar se vuelve a pintar (si se está
// escribiendo en el buscador, solo lo buscado, para no quitarle el foco)
const askedNames = new Set();
async function fetchNames(pkgs) {
  const missing = [...new Set(pkgs)].filter(p => !askedNames.has(p));
  missing.forEach(p => askedNames.add(p));
  for (let i = 0; i < missing.length; i += 40) {
    let names;
    try { ({ names } = await post('/appnames', { pkgs: missing.slice(i, i + 40) })); } catch { return; }
    if (!Object.keys(names).length) continue;
    state.names = { ...state.names, ...names };
    if (!$('#cleanup') || !state.cleanup) return;
    if (document.activeElement === $('#clean-search')) searchCleanup();
    else renderCleanup();
  }
}

// Quitar o recuperar una app en un móvil, desde su celda
async function cleanCell(btn) {
  const serial = ctx(btn, 'serial'), pkg = ctx(btn, 'pkg');
  const r = state.cleanRows.find(x => x.pkg === pkg), d = deviceBy(serial);
  const on = r.cells.get(serial) === 'on';
  if (on && !await ask(`¿Quitar ${appLabel(pkg)} de ${title(d)}?`, r.system
    ? '<p>Se quita para el usuario del móvil: no se borra, y se recupera pulsando otra vez su celda.</p>'
    : '<p>Se desinstala, con sus datos.</p>', 'Quitar')) return;
  await busy(btn, async () => {
    toast(`${appLabel(pkg)}: ${(await post(`/devices/${enc(serial)}/apps/${enc(pkg)}/${on ? 'uninstall' : 'restore'}`)).message}`);
    await state.reloadCleanup();
  });
}

async function cleanJobs(btn, jobs, question) {
  if (!jobs.length) return;
  const system = new Set(state.cleanRows.filter(r => r.system).map(r => r.pkg));
  const mine = jobs.some(j => !system.has(j.pkg)), theirs = jobs.some(j => system.has(j.pkg));
  const how = [theirs && 'Las del sistema no se borran: se pueden recuperar.', mine && 'Las tuyas se desinstalan, con sus datos.'];
  const ok = await ask(question, `<p>Se quitarán ${jobs.length === 1 ? 'esta app' : `estas ${jobs.length} apps`}.
    ${how.filter(Boolean).join(' ')}</p>${jobList(jobs)}`, `Quitar ${jobs.length}`);
  if (ok) await busy(btn, () => runJobs(jobs, 'uninstall', state.reloadCleanup));
}

// Sobra, No tocar o Volver a sugerir: se guarda y se pinta otra vez sin volver a preguntar a los móviles
async function cleanMark(btn) {
  const pkg = ctx(btn, 'pkg'), mark = btn.dataset.mark;
  await busy(btn, async () => {
    await post('/cleanup/mark', { pkg, mark });
    const c = state.cleanup;
    c.marked = c.marked.filter(p => p !== pkg).concat(mark === 'remove' ? [pkg] : []);
    c.ignored = c.ignored.filter(p => p !== pkg).concat(mark === 'ignore' ? [pkg] : []);
    if (mark === 'remove') toast(`${appLabel(pkg)}: marcada; pulsa sus ● o «Quitar de todos»`);
    renderCleanup();
  });
}

// Ejecuta acciones sobre varias apps: en paralelo entre móviles, de una en una dentro de cada móvil
async function runJobs(jobs, action, after = state.reload) {
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
  await after();
}

const jobList = jobs => [...Map.groupBy(jobs, j => j.serial)].map(([serial, list]) =>
  `<p><strong>${esc(title(deviceBy(serial)))}</strong></p><ul>${list.map(j => `<li>${j.note && j.note !== j.pkg ? `${esc(j.note)} ` : ''}<code>${esc(j.pkg)}</code></li>`).join('')}</ul>`).join('');

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
  if (play) toast(`Abierto Google Play en ${play} ${play === 1 ? 'móvil' : 'móviles'}: pulsa «Instalar» en su pantalla`);
  // Y la pantalla de cada uno en el PC, para pulsarlo desde aquí
  for (const serial of new Set(done.filter(r => r.message.includes('Google Play')).map(r => r.serial))) {
    const d = deviceBy(serial);
    openScreen(d).catch(e => toast(`${title(d)}: ${e.message}`, 'error'));
  }
  for (const r of results.filter(x => !x.ok)) {
    toast(`${title(deviceBy(r.serial))}${r.pkg ? ` · ${names.get(r.pkg) || r.pkg}` : ''}: ${r.message}`, 'error');
  }
  await state.reload();
}

// Deja de ser favorita; si está en algún móvil, se puede dejar ahí (pasa a Limpiar) o desinstalar de todos
async function removeApp(pkg, name) {
  name ||= state.catalog?.apps.find(a => a.pkg === pkg)?.name || pkg;
  const where = (state.catalog?.devices || []).filter(d => d.status?.[pkg]?.have != null);
  const choice = await choose(`¿Quitar ${name} de favoritas?`, `<p>Deja de instalarse y de ponerse al día.</p>${where.length
    ? `<p>Ahora está en ${where.length === 1 ? title(where[0]) : `${where.length} móviles`}: puedes dejarla ahí (saldrá en «Limpiar») o desinstalarla, con sus datos.</p>` : ''}`,
  [['list', where.length ? 'Solo quitar de favoritas' : 'Quitar de favoritas', where.length ? '' : 'danger'],
    ...(where.length ? [['all', where.length === 1 ? 'Desinstalarla también' : `Desinstalarla de los ${where.length}`, 'danger']] : [])]);
  if (!choice) return false;
  await post(`/catalog/${enc(pkg)}/remove`);
  if (choice === 'all') await runJobs(where.map(d => ({ serial: d.serial, pkg })), 'uninstall', async () => {});
  toast(`${name} ya no es favorita`);
  return true;
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

// Diálogo para añadir una favorita; con serial ofrece copiar el APK desde ese móvil
function addAppDialog({ pkg = '', serial = null } = {}) {
  const tabs = [
    serial && ['copy', `Copiar de ${title(deviceBy(serial))}`],
    ['play', 'Google Play'],
    ['fdroid', 'F-Droid'],
    ['apk', 'Subir APK'],
    ['url', 'Enlace'],
  ].filter(Boolean);
  const dlg = $('#dialog');
  dlg.className = 'wide';
  dlg.innerHTML = `<form method="dialog">
      <h2>Añadir favorita</h2>
      <div class="segmented" role="tablist">${tabs.map(([k, label]) => `<button type="button" role="tab" data-tab="${k}">${esc(label)}</button>`).join('')}</div>
      <p class="muted" data-panel="copy">Se copia el APK de <code>${esc(pkg)}</code> desde ese móvil y se instala igual en los demás.
        Vale para apps de una sola pieza, como tus apps privadas; las de Google Play suelen venir partidas y no se pueden copiar.</p>
      <p class="muted" data-panel="play">Google Play no deja instalar desde fuera: el panel abre la ficha de la app en cada móvil donde falte
        y allí pulsas «Instalar». Después Play la mantiene al día.</p>
      <p class="muted" data-panel="fdroid">El panel descarga la última versión de F-Droid, la instala en todos y la actualiza cuando salga otra.</p>
      <label class="drop compact" data-panel="apk"><input type="file" accept=".apk" hidden>
        <strong>Elige o arrastra aquí el .apk</strong><span class="muted small">Se guarda en el panel y se instala tal cual en todos los móviles.</span></label>
      <p class="muted" data-panel="url">El PC descarga el .apk de ese enlace (de una release de GitHub, de la web de la app…),
        comprueba que es una app y la instala en todos, como un APK subido. Para tener una versión nueva, añade otra vez el enlace.</p>
      <label class="field" data-panel="play fdroid"><span>Paquete o enlace de la tienda</span>
        <input name="pkg" value="${esc(pkg)}" placeholder="org.videolan.vlc o https://play.google.com/store/apps/details?id=…" autocomplete="off"></label>
      <label class="field" data-panel="url"><span>Enlace al archivo .apk</span>
        <input name="url" type="url" placeholder="https://github.com/…/releases/download/…/app.apk" autocomplete="off"></label>
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
    if (tab === 'url' && !f.url.trim()) return void (error.textContent = 'Pega primero el enlace al .apk');
    await busy($('#add-ok'), async () => {
      try {
        const { app } = tab === 'apk'
          ? await api(`/catalog/upload?name=${enc(name)}&file=${enc(apk.name.replace(/\.apk$/i, ''))}`, { method: 'POST', file: apk })
          : tab === 'url' ? await post('/catalog/url', { url: f.url, name })
          : tab === 'copy' ? await post('/catalog/copy', { serial, pkg, name })
          : await post('/catalog/add', { source: tab, pkg: f.pkg, name });
        dlg.close();
        toast(`${app.name} es ya favorita`);
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
// Iconos de trazo, como el de actualizar de la cabecera
const icon = (paths, size = 16) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICON = {
  sound: icon('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>'),
  muted: icon('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m16 9 6 6m0-6-6 6"/>'),
  look: icon('<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>'),
  screenOn: icon('<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>'),
  screenOff: icon('<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M3 3l18 18"/>'),
  reload: icon('<path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4h-4"/>'),
  songs: icon('<path d="M3 6h12M3 11h12M3 16h7"/><path d="M19 17V5l3 1"/><circle cx="16.5" cy="17" r="2.5"/>', 18),
  close: icon('<path d="M6 6l12 12M18 6 6 18"/>', 20),
  info: icon('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>', 15),
  control: icon('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>', 18),
  wifi: icon('<path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01"/>', 18),
  unplug: icon('<path d="m19 5 3-3M2 22l3-3M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4zM7.5 13.5 10 11M10.5 16.5 13 14M12 6l6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0z"/>', 18),
  download: icon('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
  store: icon('<path d="M7 4.5v15l12-7.5z"/>'),
  edit: icon('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>'),
  trash: icon('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>'),
  mic: icon('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
  disk: icon('<ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>', 13),
};
// 4555700000 → «4,6 GB»; por encima de 10, sin decimales
const gb = bytes => `${(bytes / 1e9).toLocaleString('es-ES', { maximumFractionDigits: bytes < 1e10 ? 1 : 0 })} GB`;
// Un botón solo con icono; lo que hace sale al pasar el ratón y lo leen los lectores de pantalla
const iconBtn = (act, svg, label, kind = '') =>
  `<button class="btn icon ${kind}" data-act="${act}" title="${esc(label)}" aria-label="${esc(label)}">${svg}</button>`;
// Una «i» que explica algo al pasar el ratón (o al llegar con el tabulador)
const info = text => `<span class="info" tabindex="0" role="img" aria-label="${esc(text)}" title="${esc(text)}">${ICON.info}</span>`;
const DELAY_HELP = 'Si un móvil se oye antes que los demás, súbele el retraso; si se oye después, bájalo. '
  + 'La prueba de sincronía (en Canciones) da un pitido por segundo para cuadrarlos de oído.';
const SPEAKER_STATE = {
  tap: ['Esperando un toque', 'diff', 'Chrome necesita que alguien toque la pantalla del móvil antes de dejar sonar la música. El panel lo hace solo al abrirlo; si no, tócala tú o pulsa la lupa («Ver pantalla») y hazlo desde el PC'],
  idle: ['Listo', 'ok', ''],
  ready: ['Listo', 'ok', ''],
  loading: ['Cargando…', '', 'Está descargando la canción del PC'],
  playing: ['Sonando', 'ok', ''],
};

async function viewMusic(current) {
  view.innerHTML = `<div class="page-head"><h1>Música</h1>
      <p class="muted">Tus canciones sonando a la vez en los móviles que elijas. Cada móvil hace de altavoz con una página que abre en Chrome.</p></div>
    <section id="music">${loading('Buscando móviles…')}</section>
    <dialog id="songs-dlg" class="full" aria-labelledby="songs-title">
      <div class="full-head">
        <h2 id="songs-title">Canciones <span class="muted small" id="songs-count"></span></h2>
        <input type="search" id="song-filter" placeholder="Buscar canción o artista" aria-label="Buscar canción" autocomplete="off">
        <label class="btn">Subir canciones<input type="file" id="song-files" accept="audio/*,.mp3,.m4a,.aac,.ogg,.opus,.wav,.flac" multiple hidden></label>
        <button class="btn" data-act="music-folder" title="Abre en el PC la carpeta de la música: lo que copies ahí aparece aquí">Abrir la carpeta</button>
        <button class="btn ghost icon" data-act="songs-close" title="Cerrar (Esc)" aria-label="Cerrar">${ICON.close}</button>
      </div>
      <ul class="song-list" id="songs"></ul>
      <p class="empty muted" id="songs-none" hidden></p>
    </dialog>`;
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
        <div class="now-title"><span class="muted now-state"><span class="eq" aria-hidden="true"><i></i><i></i><i></i></span><span id="now-state"></span></span><strong id="now-song"></strong><span class="muted small" id="now-next"></span></div>
        <div class="now-controls">
          <button class="btn" data-act="songs" title="Elegir qué suena">${ICON.songs}Canciones</button>
          <div class="transport">
            ${mb('previous', '⏮', 'Anterior; si ya lleva unos segundos, vuelve al principio')}
            <button class="btn primary" id="now-toggle" data-act="music" data-action="toggle"></button>
            ${mb('next', '⏭', 'Siguiente')}
            ${mb('stop', 'Parar', 'Para la música en todos los altavoces', 'ghost')}
          </div>
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
        <button class="btn" id="all-btn" data-act="music" data-action="none"></button>
        <button class="btn" data-act="calibrate" title="Mide con el micrófono de este PC cuándo se oye cada altavoz encendido y les pone el retraso que los cuadra">${ICON.mic}Calibrar</button>
        <button class="btn" data-act="speaker-all" title="Abre la página de altavoz en todos los móviles conectados">Abrir en todos</button>
        <button class="btn" data-act="screen-all" title="Abre en este PC la pantalla de cada móvil, para verlas y manejarlas a la vez">Mostrar todos</button>
      </div></div>
    ${devices.length ? `<div class="card flush scroll-x"><table class="matrix speakers">
      <thead><tr><th>Móvil</th><th>Estado</th><th>Volumen</th><th>Retraso (ms)${info(DELAY_HELP)}</th><th></th></tr></thead>
      <tbody>${devices.map(speakerRow).join('')}</tbody>
    </table></div>` : '<p class="problem">No hay móviles listos: conéctalos en <a href="#/">Dispositivos</a>.</p>'}`;
  updateMusic();
}

// Las canciones, a pantalla completa: se busca escribiendo y se elige con un clic, o con Enter la primera que quede
function openSongs() {
  $('#songs-dlg').showModal();
  $('#song-filter').value = '';
  filterSongs();
  $('#songs .song.playing')?.scrollIntoView({ block: 'center' });
  $('#song-filter').focus();
}

// Sin tildes ni mayúsculas: «cancion» encuentra «Canción»
const fold = s => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
function filterSongs() {
  const text = $('#song-filter').value.trim(), words = fold(text).split(/\s+/).filter(Boolean);
  let shown = 0;
  for (const b of document.querySelectorAll('#songs .song')) {
    const hit = words.every(w => b.dataset.key.includes(w));
    b.parentElement.hidden = !hit;
    shown += hit;
  }
  $('#songs-none').hidden = shown > 0 || !text;
  $('#songs-none').textContent = `Ninguna canción con «${text}»`;
}

function speakerRow(d) {
  const tip = 'Si este móvil se oye antes que los demás, súbelo; si se oye después, bájalo';
  return `<tr data-serial="${esc(d.serial)}" data-id="${esc(d.serialno)}">
    <td class="app-cell"><div class="app-name">${esc(title(d))}</div>${d.name ? `<div class="muted small">${esc(model(d))}</div>` : ''}</td>
    <td class="sp-state"></td>
    <td class="nowrap sp-vol"><button class="btn small icon mute" data-act="mute"></button><input type="range" class="vol" min="0" max="100" step="1"
      disabled aria-label="Volumen de la música en ${esc(title(d))}"><span class="vol-val small">…</span><button class="btn small"
      data-act="music" data-action="solo" title="Que suene solo en este móvil; los demás se quedan en silencio">Solo</button></td>
    <td class="nowrap sp-delay"><button class="btn small icon" data-act="delay" data-step="-1" title="${esc(tip)}" aria-label="1 ms menos de retraso">−</button><input
      type="number" class="delay-val" min="-1000" max="1000" step="1" title="${esc(tip)}. Puedes escribirlo, de −1000 a 1000"
      aria-label="Retraso de ${esc(title(d))} en milisegundos"><button class="btn small icon" data-act="delay"
      data-step="1" title="${esc(tip)}" aria-label="1 ms más de retraso">+</button></td>
    <td class="row-actions"><button class="btn small icon screen-mode" data-act="screen-mode"></button><button class="btn small icon" data-act="screen" aria-label="Ver pantalla"
      title="Ver pantalla: verla y manejarla desde el PC, para desbloquearlo o tocar «Toca para activar el altavoz»">${ICON.look}</button><button
      class="btn small" data-act="speaker-open"></button></td>
  </tr>`;
}

// Lo que cambia con cada consulta, sin rehacer la página (para no perder un clic a medias)
let songsKey = '';
function updateMusic() {
  const { now, rooms, songs } = state.music;
  $('#now-song').textContent = now.song ? now.name : 'Nada sonando';
  $('#now-next').textContent = now.song && now.next ? `Después: ${now.next}` : '';
  $('#now-state').textContent = !now.song ? 'Elige una canción en «Canciones»' : now.waiting ? 'Preparando los altavoces…' : now.playing ? 'Sonando' : 'En pausa';
  $('#now-toggle').textContent = now.playing ? '⏸ Pausa' : now.song ? '▶ Seguir' : '▶ Reproducir';
  $('#now-pos').textContent = now.song ? mmss(now.position) : '';
  $('#now-dur').textContent = now.song ? mmss(now.duration) : '';
  $('#now-bar').style.width = now.song && now.duration ? `${Math.min(100, now.position / now.duration * 100)}%` : '0';
  $('.card.now').classList.toggle('playing', Boolean(now.song && now.playing && !now.waiting));
  // Si alguno de los que están abiertos suena, el botón los silencia todos; si no, los hace sonar
  const anyOn = Object.values(rooms).some(r => r.linked && r.on);
  const all = $('#all-btn');
  if (all.dataset.action !== (anyOn ? 'none' : 'all') || !all.innerHTML) {
    all.dataset.action = anyOn ? 'none' : 'all';
    all.innerHTML = anyOn ? `${ICON.muted}Silenciar todos` : `${ICON.sound}Que suenen todos`;
    all.title = anyOn ? 'Silencia todos los altavoces' : 'Quita el silencio a todos los altavoces';
  }
  if (document.activeElement !== $('#shuffle')) $('#shuffle').checked = now.shuffle;
  if (document.activeElement !== $('#sleep') && !now.stopAt) $('#sleep').value = '0';
  $('#sleep-at').textContent = now.stopAt ? `Se pausa a las ${time(now.stopAt)}` : '';

  for (const tr of document.querySelectorAll('#music tr[data-id]')) {
    const room = rooms[tr.dataset.id];
    const [text, kind, tip] = !room?.linked ? (room?.error ? ['No se abrió', 'bad', '']
      : ['Sin abrir', '', 'Pulsa «Abrir»: el móvil abre la página de altavoz en Chrome'])
      : room.phase === 'tap' ? SPEAKER_STATE.tap
      : room.error ? ['Error', 'bad', '']
      : SPEAKER_STATE[room.phase] || ['Conectado', '', ''];
    // Sonando, lo que se ha ido de donde debería ir (lo corrige solo, acelerando o frenando un poco); si no, el margen de su reloj
    const margin = room?.rtt != null ? `Su reloj puede desviarse ±${Math.max(1, Math.round(room.rtt / 2))} ms del del PC` : '';
    const num = n => String(Math.abs(n)).replace('.', ',');
    const drift = room?.off != null && `Va ${num(room.off)} ms ${room.off > 0 ? 'adelantado' : 'retrasado'} respecto a donde debería. `
      + `Lo corrige solo, sin saltos: ahora va un ${num(room.speed || 0)} % más ${room.speed < 0 ? 'despacio' : 'deprisa'}. ${margin}. `
      + `Recolocado de golpe ${room.fixes} ${room.fixes === 1 ? 'vez' : 'veces'}`
      + (room.jitter != null ? `. Lo que baila la lectura de su audio: ±${num(room.jitter)} ms` : '');
    const off = Math.round(room?.off ?? 0);
    const clock = room?.linked && room.phase === 'playing' && drift
      ? `<span class="muted small sp-clock" title="${esc(drift)}">${off < 0 ? '−' : '+'}${Math.abs(off)} ms</span>` : '';
    tr.querySelector('.sp-state').innerHTML = `<span class="val ${kind}" title="${esc([tip, room?.linked && margin].filter(Boolean).join('. '))}">${esc(text)}</span>${clock}`
      + (room?.lan ? `<span class="tag" title="Su Android es viejo: llega al PC por la wifi y Chrome no le deja mantener la pantalla encendida. Enchufado, con «Pantalla encendida mientras carga» (Ajustes), no se apaga. Déjalo enchufado">wifi</span>` : '')
      + (room?.screen === false ? '<span class="tag" title="Solo altavoz: suena con la pantalla apagada">sin pantalla</span>' : '')
      + (room?.error ? `<div class="err-text small">${esc(room.error)}</div>` : '');
    // Los botones de icono se rehacen solo al cambiar, para no pisar uno que está trabajando
    const on = room ? room.on : true;
    // Con pantalla o sin ella (solo altavoz, con la pantalla apagada para que gaste menos)
    const screen = room?.screen !== false, mode = tr.querySelector('.screen-mode');
    if (mode.dataset.on !== String(screen)) {
      mode.dataset.on = screen;
      mode.innerHTML = screen ? ICON.screenOn : ICON.screenOff;
      mode.classList.toggle('headless', !screen);
      mode.title = screen ? 'Con pantalla: se ve el reproductor. Pulsa para dejarlo solo de altavoz, con la pantalla apagada (gasta menos)'
        : 'Sin pantalla: solo altavoz, con la pantalla apagada. Pulsa para volver a ver el reproductor';
      mode.setAttribute('aria-label', screen ? 'Dejarlo sin pantalla' : 'Volver a ver la pantalla');
    }
    const mute = tr.querySelector('.mute');
    if (mute.dataset.on !== String(on)) {
      mute.dataset.on = on;
      mute.innerHTML = on ? ICON.sound : ICON.muted;
      mute.classList.toggle('off', !on);
      mute.title = on ? 'Suena: pulsa para silenciarlo' : 'Silenciado: pulsa para que vuelva a sonar';
      mute.setAttribute('aria-label', on ? 'Silenciar' : 'Que suene');
    }
    tr.classList.toggle('silenced', !on);
    const delayInput = tr.querySelector('.delay-val');
    if (document.activeElement !== delayInput) delayInput.value = room?.delay || 0;
    // Si ya funciona, el botón la recarga (por si algo va raro); si no, la abre
    const open = tr.querySelector('[data-act=speaker-open]');
    const working = Boolean(room?.linked && room.phase && room.phase !== 'tap' && !room.error);
    if (open.dataset.again !== (working ? '1' : '')) {
      open.dataset.again = working ? '1' : '';
      open.innerHTML = working ? ICON.reload : 'Abrir';
      open.classList.toggle('primary', !working);
      open.classList.toggle('ghost', working);
      open.classList.toggle('icon', working);
      open.setAttribute('aria-label', working ? 'Reabrir' : 'Abrir altavoz');
      open.title = working ? 'Reabrir: vuelve a cargar la página de altavoz en este móvil' : 'Abre la página de altavoz en Chrome en este móvil';
    }
  }

  const key = songs.map(s => s.id).join('\n');
  if (key !== songsKey || !$('#songs').children.length) {
    songsKey = key;
    $('#songs').innerHTML = songs.map(s => `<li><button class="song" data-act="pick" data-song="${esc(s.id)}" data-key="${esc(fold(s.name))}"
        title="Ponerla en los altavoces marcados"><span class="song-name">${esc(s.name)}</span>${s.test ? tag('Para cuadrar los altavoces') : ''}<span
        class="dur muted small"></span></button></li>`).join('') + (songs.length > 1 ? '' : `<li class="empty muted">Aún no hay canciones.
        Súbelas con «Subir canciones» o cópialas a la carpeta <code>datos/musica</code> del proyecto (mp3, m4a, ogg, wav o flac).</li>`);
    $('#songs-count').textContent = songs.filter(s => !s.test).length || '';
    if ($('#songs-dlg').open) filterSongs();
  }
  const byId = new Map(songs.map(s => [s.id, s]));
  for (const b of document.querySelectorAll('#songs .song')) {
    b.classList.toggle('playing', b.dataset.song === now.song);
    b.querySelector('.dur').textContent = mmss(byId.get(b.dataset.song)?.duration);
  }
}

async function refreshMusic() {
  state.music = await api('/music');
  if ($('#music .now')) updateMusic();
}

// ── Calibrar con el micrófono ──
// Cada altavoz se cuadra con el reloj del PC, pero cada móvil tarda distinto en sacar el sonido por su altavoz, y eso solo
// se sabe oyéndolo. El panel hace sonar uno a uno los que están encendidos, con un barrido cada segundo (CHIRP, el mismo de
// music.js), lo graba con el micrófono de este PC y busca cuándo llega cada barrido. Lo que tarde el micrófono es igual
// para todos y se anula: queda cuánto antes o después se oye cada uno, desde donde esté el micrófono

const CAL = '*calibrar';
const CHIRP = { from: 1000, to: 4000, length: 0.04 };
const pcNow = () => performance.timeOrigin + performance.now();
const pause = ms => new Promise(r => setTimeout(r, ms));
const middle = list => { const s = [...list].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function chirpTemplate(rate) {
  const out = new Float32Array(Math.round(CHIRP.length * rate));
  for (let i = 0; i < out.length; i++) {
    const d = i / rate;
    out[i] = Math.sin(2 * Math.PI * (CHIRP.from * d + (CHIRP.to - CHIRP.from) * d * d / (2 * CHIRP.length))) * Math.sin(Math.PI * d / CHIRP.length) ** 2;
  }
  return out;
}

// El barrido en rec entre los índices from y to. Se toma el primer punto de la correlación que llega a la mitad del máximo
// (un eco puede oírse más fuerte que el sonido directo, pero llega después); quality, cuánto destaca sobre el ruido
function findChirp(rec, tpl, from, to) {
  from = Math.max(0, Math.round(from));
  to = Math.min(rec.length - tpl.length, Math.round(to));
  if (to - from < tpl.length) return null;
  const corr = new Float32Array(to - from);
  let peak = 0, at = 0, energy = 0;
  for (let k = from; k < to; k++) {
    let sum = 0;
    for (let j = 0; j < tpl.length; j++) sum += rec[k + j] * tpl[j];
    const v = Math.abs(sum);
    corr[k - from] = v;
    energy += v * v;
    if (v > peak) { peak = v; at = k - from; }
  }
  let first = at;
  for (let k = at; k >= Math.max(0, at - (tpl.length >> 1)); k--) if (corr[k] >= peak / 2) first = k;
  return { index: from + first, quality: peak / Math.sqrt(energy / corr.length) };
}

// Graba el micrófono sin que el navegador lo toque (ni quitar eco ni ruido ni subir el volumen) en rec.data. rec.diff
// pasa del reloj del audio al del PC (ms), con lo que dice getOutputTimestamp cada 200 ms
async function startMic() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
  });
  const ac = new AudioContext();
  const code = `registerProcessor('grabar', class extends AudioWorkletProcessor {
    constructor() { super(); this.buf = new Float32Array(4096); this.n = 0; this.start = 0; }
    process(inputs) {
      const ch = inputs[0][0];
      if (!ch) return true;
      if (!this.n) this.start = currentFrame;
      this.buf.set(ch, this.n);
      this.n += ch.length;
      if (this.n + ch.length > this.buf.length) {
        this.port.postMessage({ frame: this.start, data: this.buf.slice(0, this.n) });
        this.n = 0;
      }
      return true;
    }
  });`;
  await ac.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
  const node = new AudioWorkletNode(ac, 'grabar'), mute = ac.createGain();
  mute.gain.value = 0; // con salida, para que Chrome lo haga funcionar; en silencio
  ac.createMediaStreamSource(stream).connect(node).connect(mute).connect(ac.destination);
  const rec = { rate: ac.sampleRate, data: new Float32Array(ac.sampleRate * 300), first: null, length: 0, clock: [] };
  node.port.onmessage = ({ data: { frame, data } }) => {
    if (rec.first === null) rec.first = frame;
    const at = frame - rec.first;
    if (at + data.length <= rec.data.length) rec.data.set(data, at);
    rec.length = Math.max(rec.length, at + data.length);
  };
  const tick = setInterval(() => {
    const ts = ac.getOutputTimestamp();
    if (ts.performanceTime) rec.clock = rec.clock.slice(-50).concat(performance.timeOrigin + ts.performanceTime - ts.contextTime * 1000);
  }, 200);
  rec.diff = () => middle(rec.clock);
  rec.stop = () => {
    clearInterval(tick);
    for (const t of stream.getTracks()) t.stop();
    ac.close();
  };
  if (ac.state !== 'running') await ac.resume();
  for (let i = 0; i < 40 && (rec.first === null || !rec.clock.length); i++) await pause(100);
  if (rec.first === null) {
    rec.stop();
    throw new Error('El micrófono no manda sonido: mira que esté conectado y elegido en el navegador');
  }
  return rec;
}

// El panel pone a sonar la calibración desde el principio (con ese altavoz solo) y devuelve la hora del PC a la que empieza
async function restartCal(previous) {
  await post('/music/seek', { position: 0 });
  for (let i = 0; i < 60; i++) {
    const { now } = await api('/music');
    if (now.song === CAL && now.startAt && now.startAt !== previous) return now.startAt;
    await pause(300);
  }
  throw new Error('La calibración no ha empezado a sonar');
}

// Mide un altavoz: cada barrido, cuánto después de su hora llega (ms); cuando cuatro seguidos coinciden (±3 ms) da la
// mediana. El modo ligero (Android 4) tarda más en cuadrarse tras arrancar, así que se le espera más
async function measureRoom(rec, tpl, { startAt, delay, light }, cancelled, progress) {
  const limit = pcNow() + (light ? 45000 : 15000);
  const toIndex = ms => (ms - rec.diff()) * rec.rate / 1000 - rec.first;
  let s = Math.max(1, Math.ceil((pcNow() + 1500 - startAt - delay) / 1000)); // el anterior ya callado y este sonando
  let last = null;
  const found = [];
  while (pcNow() < limit && !cancelled()) {
    const center = startAt + delay + s * 1000 + (last ?? 0), span = last == null ? 500 : 80;
    if (rec.length < toIndex(center + span) + tpl.length + rec.rate * 0.1) { await pause(150); continue; }
    const hit = findChirp(rec.data, tpl, toIndex(center - span), toIndex(center + span));
    s++;
    if (!hit || hit.quality < 8) {
      last = null; // no se oyó: el siguiente se busca en todo el segundo
      found.push(null);
      progress(found);
      continue;
    }
    last = (hit.index + rec.first) * 1000 / rec.rate + rec.diff() - (startAt + delay + (s - 1) * 1000);
    found.push({ err: last, quality: hit.quality });
    progress(found);
    const four = found.slice(-4);
    if (four.length === 4 && four.every(Boolean) && Math.max(...four.map(f => f.err)) - Math.min(...four.map(f => f.err)) <= 6) {
      return { err: middle(four.map(f => f.err)), quality: middle(four.map(f => f.quality)) };
    }
    await pause(50);
  }
  return null;
}

// Los que se calibran: abiertos, sonando y encendidos (los silenciados se dejan como están)
async function calibrate() {
  await refreshMusic();
  const { rooms } = state.music;
  const list = state.devices.filter(d => rooms[d.serialno]?.on && rooms[d.serialno].linked
    && !['tap', 'error'].includes(rooms[d.serialno].phase));
  if (list.length < 2) return toast('Para cuadrarlos hacen falta al menos dos altavoces abiertos y sin silenciar', 'error');
  const dlg = $('#dialog');
  dlg.className = 'wide';
  dlg.innerHTML = `<form method="dialog">
      <h2>Calibrar con el micrófono</h2>
      <div class="dlg-body">
        <p>Pon el micrófono de este PC donde escuchas la música. Sonarán unos barridos cortos, cada altavoz por su cuenta
          (unos 10 s cada uno; el tablet, algo más), y el panel medirá cuándo llega cada uno. Luego vuelve la canción.</p>
        <table class="cal"><tbody>${list.map(d => `<tr data-id="${esc(d.serialno)}"><td>${esc(title(d))}</td>
          <td class="cal-state muted">En espera</td></tr>`).join('')}</tbody></table>
        <p class="muted small" id="cal-note">Los silenciados no se miden. El navegador pedirá permiso para usar el micrófono.</p>
      </div>
      <menu><button class="btn" value="close" id="cal-close">Cancelar</button><button class="btn primary" type="button" id="cal-go">Empezar</button></menu>
    </form>`;
  dlg.showModal();
  let cancelled = false;
  dlg.addEventListener('close', () => { cancelled = true; }, { once: true });
  const row = d => dlg.querySelector(`tr[data-id="${CSS.escape(d.serialno)}"] .cal-state`);
  $('#cal-go').onclick = () => runCalibration(list, row, () => cancelled).catch(e => {
    $('#cal-go').disabled = false;
    $('#cal-note').textContent = e.name === 'NotAllowedError' ? 'Sin permiso para el micrófono: dalo en el candado de la barra de direcciones' : e.message;
  });
}

async function runCalibration(list, row, cancelled) {
  const go = $('#cal-go');
  go.disabled = true;
  $('#cal-note').textContent = 'Abriendo el micrófono…';
  const rec = await startMic();
  const tpl = chirpTemplate(rec.rate);
  const before = state.music, results = [];
  try {
    $('#cal-note').textContent = 'Preparando la calibración en los altavoces…';
    await post('/music/solo', { id: list[0].serialno });
    await post('/music/play', { song: CAL });
    let startAt = null;
    for (const d of list) {
      if (cancelled()) break;
      const room = state.music.rooms[d.serialno];
      row(d).textContent = 'Arrancando…';
      await post('/music/solo', { id: d.serialno });
      startAt = await restartCal(startAt);
      $('#cal-note').textContent = `Escuchando ${title(d)}…`;
      const r = await measureRoom(rec, tpl, { startAt, delay: room.delay || 0, light: room.light }, cancelled, found => {
        const ok = found.filter(Boolean);
        row(d).textContent = ok.length ? `Oído ${ok.length} ${ok.length === 1 ? 'vez' : 'veces'}: ${ms(ok[ok.length - 1].err)}`
          : `Escuchando… (sin oírlo ${found.length} ${found.length === 1 ? 'vez' : 'veces'})`;
      });
      results.push({ d, delay: room.delay || 0, ...r });
      row(d).textContent = r ? `Medido` : 'No se oye bien: acércalo al micrófono o súbele el volumen';
      row(d).className = `cal-state ${r ? '' : 'bad'}`;
    }
  } finally {
    rec.stop();
    await restoreMusic(before).catch(e => toast(e.message, 'error'));
  }
  if (cancelled()) return;
  showCalibration(results.filter(r => r.err != null), list, row);
}

const ms = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v))} ms`;

// Como estaba: los encendidos y silenciados, y la canción por donde iba (o parada, si no había)
async function restoreMusic(before) {
  for (const [id, room] of Object.entries(before.rooms)) await post('/music/room', { id, on: room.on });
  const { song, playing, position } = before.now;
  if (!song || song === CAL) await post('/music/stop');
  else {
    await post('/music/play', { song });
    if (!playing) await post('/music/toggle');
    if (position > 1) await post('/music/seek', { position });
  }
  await refreshMusic();
}

// Lo que se oye de cada uno respecto a la mediana, y el retraso que lo cuadra: el que se oye tarde se adelanta y al revés
function showCalibration(results, list, row) {
  if (results.length < 2) {
    $('#cal-note').textContent = 'No se han podido medir al menos dos: no se cambia nada.';
    return;
  }
  const target = middle(results.map(r => r.delay + r.err));
  for (const r of results) {
    r.late = r.delay + r.err - target;
    r.next = Math.max(-1000, Math.min(1000, Math.round(target - r.err)));
    row(r.d).innerHTML = `Se oye ${Math.abs(r.late) < 2 ? 'a la par' : `${ms(r.late)} ${r.late > 0 ? '(tarde)' : '(pronto)'}`}`
      + ` · retraso ${r.delay} → <strong>${r.next}</strong> ms`;
  }
  $('#cal-note').textContent = 'Medido desde el micrófono. «Aplicar» pone esos retrasos; la prueba de sincronía sirve para comprobarlo de oído.';
  const go = $('#cal-go');
  go.textContent = 'Aplicar';
  go.disabled = false;
  $('#cal-close').textContent = 'Cerrar';
  go.onclick = () => busy(go, async () => {
    for (const r of results) await post('/music/room', { id: r.d.serialno, delay: r.next });
    $('#dialog').close();
    toast('Retrasos puestos');
    await refreshMusic();
  });
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

// El retraso de un altavoz, de milisegundo en milisegundo con − y +, o escrito
async function setDelay(el, ms) {
  await post('/music/room', { id: ctx(el, 'id'), serial: ctx(el, 'serial'), delay: Math.round(ms) || 0 });
  await refreshMusic();
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
// conectado o ido algún móvil. Con las canciones abiertas sigue (marca la que suena); con otra ventana, no
let musicPolling = false, musicTicks = 0;
setInterval(async () => {
  if (musicPolling || document.hidden || !$('#music .now') || $('#dialog').open) return;
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
      <p class="muted">Un perfil común para todos los móviles: elige cómo quieres cada ajuste y aplícalo de una vez. Si algún móvil
        lo necesita distinto (uno que solo es altavoz, otro que solo hace de mando), pulsa su casilla.</p></div>
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

// Lo que tiene que tener cada móvil: lo suyo, si lo tiene distinto («» es que en ese móvil no se toca), o el perfil
const own = (d, s) => state.settings.exceptions?.[d.serialno]?.[s.key];
const wantFor = (d, s) => own(d, s) ?? state.settings.profile[s.key];

// ok: el móvil ya lo tiene como debe · diff: hay que cambiarlo · free: no se toca
function settingState(d, s) {
  const want = wantFor(d, s);
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
      <td class="want" data-label="Perfil común"><select class="want" aria-label="${esc(s.name)} en el perfil común">
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
      <span><span class="val ok">Así</span> como debe estar</span>
      <span><span class="val diff">Así</span> distinto: falta cambiarlo</span>
      <span><span class="val">Así</span> no se toca</span>
      <span><span class="val ok own">Así</span> ese móvil lo tiene distinto del perfil</span>
      <span><span class="none">—</span> su Android no lo tiene</span>
      <span>· Pulsa una casilla para cambiar ese móvil.</span></p>`;
}

const optionText = (s, v) => s.options.find(([o]) => o === v)?.[1] ?? v;

function settingCell(d, s) {
  if (!d.settings) return `<td class="cell" data-label="${esc(title(d))}"><span class="none" title="${esc(d.error || 'No se pudo leer')}">?</span></td>`;
  const v = d.settings[s.key];
  if (v.na) return `<td class="cell" data-label="${esc(title(d))}"><span class="none" title="${esc(`${title(d)}: ${v.na}`)}">—</span></td>`;
  const st = settingState(d, s), now = v.text ?? '?', mine = own(d, s), want = wantFor(d, s);
  const tip = [`${title(d)}: ${now}`, st === 'diff' && `tiene que estar en ${optionText(s, want)}`,
    mine !== undefined && (mine === '' ? 'en este móvil no se toca' : 'propio de este móvil'), 'Pulsa para elegir'].filter(Boolean).join('. ');
  return `<td class="cell" data-serial="${esc(d.serial)}" data-label="${esc(title(d))}"><button class="val ${st} ${mine !== undefined ? 'own' : ''}" data-act="setting-cell"
    title="${esc(tip)}" aria-label="${esc(tip)}">${esc(now)}</button></td>`;
}

// Un ajuste en un móvil: elegir su valor (si no es el del perfil, queda como propio de ese móvil), volver a como el
// perfil o no tocarlo ahí. Se cambia en el móvil al momento
async function settingChoice(btn) {
  const d = deviceBy(ctx(btn, 'serial')), s = state.settings.settings.find(x => x.key === ctx(btn, 'key'));
  const now = d.settings[s.key].text ?? '?', mine = own(d, s), common = state.settings.profile[s.key], want = wantFor(d, s);
  const html = `<p>Ahora tiene <strong>${esc(now)}</strong>. En el perfil común: <strong>${esc(common ? optionText(s, common) : 'No tocar')}</strong>.</p>
    ${mine !== undefined ? `<p>Este móvil lo tiene distinto: <strong>${esc(mine === '' ? 'No tocar' : optionText(s, mine))}</strong>.</p>` : ''}
    <p class="muted">Elige qué quieres en ${esc(title(d))}; se cambia ya.</p>`;
  const choice = await choose(`${s.name} en ${title(d)}`, html, [
    ...s.options.map(([v, text]) => [`v:${v}`, text, v === want ? 'primary' : '']),
    ...(common && mine !== '' ? [['skip', 'No tocar aquí']] : []),
    ...(mine !== undefined ? [['profile', 'Como el perfil']] : []),
  ]);
  if (!choice) return;
  const value = choice === 'profile' ? null : choice === 'skip' ? '' : choice.slice(2) === common ? null : choice.slice(2);
  await busy(btn, async () => {
    await post('/settings/device', { serialno: d.serialno, key: s.key, value });
    if (value === '' || (value === null && !common)) await state.reload();
    else await applySettings({ serials: [d.serial], key: s.key });
  });
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

// ── Botones y formularios ───────────────────────────────────────────────────

const actions = {
  app: appAction,
  keep: toggleKeep,
  rename: renameDevice,
  'apps-tab': btn => showAppsTab(btn.dataset.tab),
  lan: async btn => {
    try {
      $('#lan').innerHTML = lanHtml(await post('/red', { on: btn.checked }));
    } catch (e) {
      btn.checked = !btn.checked;
      toast(e.message, 'error');
    }
  },
  'add-app': () => addAppDialog(),
  'sync-all': btn => busy(btn, () => syncNow({}, 'Instalando lo pendiente')),
  'sync-app': btn => busy(btn, () => syncNow({ pkg: ctx(btn, 'pkg') }, 'Instalando')),
  'sync-phone': btn => busy(btn, () => syncNow({ serial: ctx(btn, 'serial') }, `Poniendo las favoritas en ${title(deviceBy(ctx(btn, 'serial')))}`)),
  'clean-cell': cleanCell,
  'clean-mark': cleanMark,
  'clean-row': btn => cleanJobs(btn, removable(null, ctx(btn, 'pkg')), `¿Quitar ${appLabel(ctx(btn, 'pkg'))} de todos los móviles?`),
  'clean-phone': btn => cleanJobs(btn, removable(ctx(btn, 'serial')), `¿Limpiar ${title(deviceBy(ctx(btn, 'serial')))}?`),
  'clean-all': btn => cleanJobs(btn, removable(), '¿Limpiar todos los móviles?'),
  'restore-row': btn => {
    const pkg = ctx(btn, 'pkg');
    const jobs = [...state.cleanRows.find(r => r.pkg === pkg).cells].filter(([, v]) => v === 'off').map(([serial]) => ({ serial, pkg }));
    return busy(btn, () => runJobs(jobs, 'restore', state.reloadCleanup));
  },
  'app-cell': appCell,
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
  'setting-cell': settingChoice,
  quick: btn => busy(btn, () => runQuick(ctx(btn, 'serial'), btn.dataset.action)),
  music: btn => busy(btn, async () => {
    const { warning } = await post(`/music/${btn.dataset.action}`, { song: ctx(btn, 'song'), id: ctx(btn, 'id') });
    if (warning) toast(warning, 'error');
    await refreshMusic();
  }),
  'speaker-open': btn => busy(btn, () => openSpeakers([deviceBy(ctx(btn, 'serial'))], btn.dataset.again === '1')),
  'speaker-all': btn => busy(btn, () => openSpeakers(state.devices.filter(isReady))),
  // La pantalla de cada móvil en una ventana del PC (scrcpy), todas a la vez; la de un Android 4, en el visor del panel
  'screen-all': btn => busy(btn, async () => {
    const list = state.devices.filter(isReady);
    if (!list.length) return toast('No hay móviles listos', 'error');
    const results = await Promise.all(list.map(d => openScreen(d)
      .then(() => ({ d, ok: true }), e => ({ d, ok: false, message: e.message }))));
    const ok = results.filter(r => r.ok).length;
    if (ok) toast(`Abriendo en el PC la pantalla de ${ok === 1 ? title(results.find(r => r.ok).d) : `${ok} móviles`}`);
    for (const r of results.filter(x => !x.ok)) toast(`${title(r.d)}: ${r.message}`, 'error');
  }),
  calibrate: btn => busy(btn, calibrate),
  'music-folder': btn => busy(btn, () => post('/music/folder')),
  songs: openSongs,
  'songs-close': () => $('#songs-dlg').close(),
  pick: btn => busy(btn, async () => {
    const { warning } = await post('/music/play', { song: btn.dataset.song });
    if (warning) toast(warning, 'error');
    $('#songs-dlg').close();
    await refreshMusic();
  }),
  mute: btn => busy(btn, () => toggleMute(btn)),
  'screen-mode': btn => busy(btn, async () => {
    const id = ctx(btn, 'id'), screen = state.music.rooms[id]?.screen !== false;
    await post('/music/room', { id, serial: ctx(btn, 'serial'), screen: !screen });
    toast(screen ? `${title(deviceBy(ctx(btn, 'serial')))}: sin pantalla; se apaga en cuanto descanse (15 s)` : `${title(deviceBy(ctx(btn, 'serial')))}: con pantalla otra vez`);
    await refreshMusic();
  }),
  seek: (bar, e) => seekTo(bar, e).catch(err => toast(err.message, 'error')),
  delay: btn => busy(btn, async () => {
    const id = ctx(btn, 'id');
    await setDelay(btn, (state.music.rooms[id]?.delay || 0) + Number(btn.dataset.step));
  }),
  screenshot: btn => busy(btn, () => showScreenshot(btn)),
  screen: btn => busy(btn, async () => {
    const d = deviceBy(ctx(btn, 'serial'));
    const { message } = await openScreen(d);
    if (message) toast(message);
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
  if (e.target.matches('#song-filter')) filterSongs();
  if (e.target.matches('#clean-search')) {
    state.cleanQuery = e.target.value;
    searchCleanup();
  }
});

view.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !e.target.matches('#song-filter')) return;
  e.preventDefault();
  $('#songs li:not([hidden]) .song')?.click();
});

view.addEventListener('change', e => {
  if (e.target.matches('select.want')) setWant(e.target);
  if (e.target.matches('.vol')) setVolume(e.target);
  if (e.target.matches('.delay-val')) {
    setDelay(e.target, Number(e.target.value)).catch(err => toast(err.message, 'error')).finally(() => e.target.blur());
  }
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
// Los temas: el botón de la cabecera abre la lista, cada uno con una muestra de sus colores (fondo, color y su pareja).
// Se cambia al momento y lo recuerda este navegador (cada ordenador o móvil que abra el panel, el suyo)
const THEMES = [
  ['clasico', 'Clásico', 'El verde de siempre, claro u oscuro', '#181c22', '#3ddc84', '#e5e8ee'],
  ['neon', 'Neón', 'Noche de los 80, rejilla y brillos', '#170530', '#ff2fb3', '#22e4ff'],
  ['tocadiscos', 'Tocadiscos', 'Amplificador de madera y vúmetro', '#241a12', '#ffaa1d', '#ff5a1f'],
  ['aurora', 'Aurora', 'Cristal sobre luces de colores', '#0d1220', '#6ff2d0', '#8b7bff'],
  ['casete', 'Casete', 'Etiqueta de cinta, en claro', '#f1e6d0', '#e5542b', '#2b1d14'],
  ['fosforo', 'Fósforo', 'Monitor verde de los de antes', '#020a04', '#39ff6a', '#c6ff3a'],
];
const currentTheme = () => THEMES.find(t => t[0] === document.documentElement.dataset.theme) || THEMES[0];
function showThemes(open) {
  $('#theme-list').hidden = !open;
  $('#theme-btn').setAttribute('aria-expanded', open);
  if (!open) return;
  $('#theme-list').innerHTML = THEMES.map(([id, name, about, bg, a, b]) => `<button role="menuitemradio" data-pick="${id}"
    aria-checked="${id === currentTheme()[0]}"><span class="swatch" style="--s-bg:${bg};--s-a:${a};--s-b:${b}"></span>
    <span><strong>${name}</strong><small>${about}</small></span><span class="check">✓</span></button>`).join('');
  $('#theme-list [aria-checked=true]').focus();
}
$('#theme-name').textContent = currentTheme()[1];
$('#theme-btn').onclick = () => showThemes($('#theme-list').hidden);
$('#theme-list').onclick = e => {
  const pick = e.target.closest('[data-pick]');
  if (!pick) return;
  // El Clásico es no tener tema: así no le llegan los detalles que comparten los demás
  if (pick.dataset.pick === THEMES[0][0]) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = pick.dataset.pick;
  try { localStorage.setItem('tema', pick.dataset.pick); } catch {}
  $('#theme-name').textContent = currentTheme()[1];
  showThemes(false);
};
document.addEventListener('click', e => { if (!e.target.closest('.theme-menu')) showThemes(false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#theme-list').hidden) { showThemes(false); $('#theme-btn').focus(); } });
window.addEventListener('hashchange', route);
checkStatus().catch(e => toast(`No contesta el panel: ${e.message}`, 'error'));
route();
