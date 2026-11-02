// Panel web para gestionar las apps de los Android de casa, sin dependencias: node panel/server.js [--open]
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const adb = require('./adb');
const cfg = require('./config');
const catalog = require('./catalog');
const limpieza = require('./limpieza');
const mirror = require('./mirror');
const music = require('./music');
const settings = require('./settings');
const stores = require('./stores');
const sync = require('./sync');
const { qrSvg } = require('./qr');

const PORT = Number(process.env.PORT) || 8765;
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const SERIAL = /^[\w.:-]+$/;
const ADDR = /^[\w.-]+(:\d{1,5})?$/;
const PUBLIC = path.join(__dirname, 'public');
const STATIC = { 'index.html': 'text/html', 'app.js': 'text/javascript', 'style.css': 'text/css' };

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const need = (ok, message) => { if (!ok) throw new HttpError(400, message); };
const settle = (promise, extra) => promise.then(
  message => ({ ...extra, ok: true, message }),
  e => ({ ...extra, ok: false, message: e.message }));

const routes = [];
function on(method, pattern, handler) {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
  routes.push({ method, re, keys, handler });
}

async function listDevices() {
  const names = cfg.names();
  return (await adb.devices()).map(d => ({ ...d, name: names.get(d.serialno) || '' }));
}

const readyDevices = async () => (await listDevices()).filter(d => d.state === 'device' && !d.error);

// Si su código cambia con el panel en marcha, la página sí carga lo nuevo pero el servidor sigue con lo
// anterior: outdated avisa de que hay que reiniciarlo
const CODE = fs.readdirSync(__dirname).filter(f => f.endsWith('.js')).map(f => path.join(__dirname, f));
const STARTED = Date.now();
const outdated = () => CODE.some(f => { try { return fs.statSync(f).mtimeMs > STARTED; } catch { return false; } });

on('GET', '/api/status', () => ({ adb: adb.adbPath(), outdated: outdated() }));

on('GET', '/api/devices', async () => ({ devices: await listDevices(), saved: cfg.savedIps() }));

on('POST', '/api/connect', async ({ body: { host } }) => {
  need(ADDR.test(host || ''), 'Escribe una IP, como 192.168.1.50');
  const message = await adb.connect(host);
  cfg.saveIp(host);
  dropped.delete(host.split(':')[0]);
  return { message };
});

on('POST', '/api/connect-saved', async () => {
  dropped.clear();
  return { results: await Promise.all(cfg.savedIps().map(ip => settle(adb.connect(ip), { ip }))) };
});

// adb olvida los móviles conectados por IP cuando se reinicia (por ejemplo, si el PC se queda sin memoria): cada minuto
// se reconectan las IP guardadas que falten, salvo las que alguien ha desconectado a mano desde el panel
const dropped = new Set();
let reconnecting = false;
async function keepConnected() {
  if (reconnecting) return;
  reconnecting = true;
  try {
    const attached = await adb.serials();
    const missing = cfg.savedIps().filter(ip => !dropped.has(ip) && !attached.some(s => s.startsWith(`${ip}:`)));
    const back = (await Promise.all(missing.map(ip => settle(adb.connect(ip), { ip })))).filter(r => r.ok);
    for (const r of back) console.log(`  ${r.ip}: reconectado`);
    if (back.length) music.keepPorts();
  } catch {} finally { reconnecting = false; }
}

on('POST', '/api/pair', async ({ body: { host, code } }) => {
  need(/^[\w.-]+:\d{1,5}$/.test(host || ''), 'Escribe la IP y el puerto que muestra el móvil, como 192.168.1.50:37123');
  need(/^\d{6}$/.test(code || ''), 'El código son 6 cifras');
  return { message: await adb.pair(host, code) };
});

// Emparejados por QR en curso: nombre del servicio → { password, state, message, expires }
const qrSessions = new Map();
const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const randomText = n => [...crypto.randomBytes(n)].map(b => ALNUM[b % ALNUM.length]).join('');

on('POST', '/api/qr', () => {
  for (const [name, s] of qrSessions) if (s.expires < Date.now()) qrSessions.delete(name);
  const name = `panel-${randomText(6)}`;
  const password = randomText(10);
  qrSessions.set(name, { password, state: 'waiting', message: '', expires: Date.now() + 10 * 60000 });
  // El mismo formato que usa Android Studio; el móvil lo lee en «Vincular dispositivo con código QR»
  return { name, svg: qrSvg(`WIFI:T:ADB;S:${name};P:${password};;`) };
});

// La página lo consulta cada poco: cada consulta mira si el móvil ya ha escaneado el código
on('GET', '/api/qr/:name', async ({ params }) => {
  const s = qrSessions.get(params.name);
  if (!s || s.expires < Date.now()) throw new HttpError(404, 'Este código ha caducado; genera otro');
  if (s.state === 'waiting') {
    s.step ||= adb.pairQr(params.name, s.password)
      .then(addr => { if (addr) Object.assign(s, { state: 'done', message: `Móvil añadido (${addr})` }); })
      .catch(e => Object.assign(s, { state: 'error', message: e.message }))
      .finally(() => { s.step = null; });
    await s.step;
  }
  return { state: s.state, message: s.message };
});

on('POST', '/api/devices/:serial/wifi', async ({ params }) => {
  const ip = await adb.enableWifi(params.serial);
  cfg.saveIp(ip);
  return { message: `Conectado por wifi (${ip}). Ya puedes quitar el cable.` };
});

on('POST', '/api/devices/:serial/disconnect', async ({ params }) => {
  const message = await adb.disconnect(params.serial);
  dropped.add(params.serial.split(':')[0]);
  return { message };
});

on('POST', '/api/devices/:serial/reconnect', async ({ params }) => ({ message: await adb.reconnect(params.serial) }));

// Acciones rápidas (teclas, sonar, abrir un enlace, mandar un aviso); url y text solo para las que los usan
on('POST', '/api/devices/:serial/do/:action', async ({ params, body }) => ({ message: await adb.quick(params.serial, params.action, body) }));

on('GET', '/api/devices/:serial/screenshot', async ({ params }) => ({
  image: `data:image/png;base64,${(await adb.screenshot(params.serial)).toString('base64')}`,
}));

// El título es el nombre del móvil, para la ventana de scrcpy
on('POST', '/api/devices/:serial/screen', async ({ params, body: { title } }) => ({
  message: await mirror.open(params.serial, String(title || '').replace(/[^\p{L}\p{N} ._()-]/gu, '').slice(0, 60)),
}));

// keep: la app está en el catálogo de apps comunes; note: el nombre que le has dado
const common = () => new Map(catalog.load().apps.map(a => [a.pkg, a.name]));

on('GET', '/api/devices/:serial/apps', async ({ params }) => {
  const names = common();
  const apps = await adb.apps(params.serial);
  return { apps: apps.map(a => ({ ...a, keep: names.has(a.pkg), note: names.get(a.pkg) || '' })) };
});

on('POST', '/api/devices/:serial/apps/:pkg/:action', async ({ params: { serial, pkg, action } }) => ({
  message: await adb.appAction(serial, pkg, action),
}));

// ── Catálogo de apps comunes ──

on('GET', '/api/catalog', async () => {
  const devices = await readyDevices();
  const status = await sync.status(devices, catalog.load().apps);
  const { auto, apps } = catalog.load(); // de nuevo: las de F-Droid pueden haber cambiado de versión
  return { auto, last: sync.last(), apps, devices: devices.map(d => ({ ...d, status: status[d.serial] })) };
});

// El APK llega tal cual en el cuerpo; ?name= es el nombre a mostrar y ?file= el del archivo, por si no hay otro
on('POST', '/api/catalog/upload', async ({ req, url }) => {
  const tmp = path.join(os.tmpdir(), `panel-${process.pid}-${Date.now()}.apk`);
  try {
    await pipeline(req, fs.createWriteStream(tmp));
    const q = url.searchParams;
    return { app: catalog.putApk(tmp, (q.get('name') || '').slice(0, 60), (q.get('file') || '').slice(0, 60)) };
  } finally {
    fs.rm(tmp, { force: true }, () => {});
  }
});

on('POST', '/api/catalog/add', async ({ body: { source, pkg, name } }) => {
  need(['fdroid', 'play'].includes(source), 'Origen no válido');
  pkg = stores.packageFrom(pkg);
  need(adb.PKG.test(pkg), 'Escribe el nombre del paquete o pega el enlace de la tienda');
  const info = await stores.details(source, pkg);
  const version = source === 'fdroid' ? await stores.fdroidLatest(pkg) : {};
  return { app: catalog.put({ pkg, source, name: String(name || '').trim() || info.name, icon: info.icon, ...version }) };
});

// Un APK desde un enlace: se descarga al PC y queda como APK propio, recordando el enlace (añadirlo otra vez lo actualiza)
on('POST', '/api/catalog/url', async ({ body: { url, name } }) => {
  const link = String(url || '').trim();
  const tmp = path.join(os.tmpdir(), `panel-${process.pid}-${Date.now()}.apk`);
  try {
    await stores.downloadApk(link, tmp);
    const file = decodeURIComponent(new URL(link).pathname.split('/').pop() || '').replace(/\.apk$/i, '').slice(0, 60);
    try {
      return { app: catalog.putApk(tmp, String(name || '').trim(), file, link) };
    } catch (e) {
      throw new HttpError(400, `Lo que hay en ese enlace no es una app de Android (¿es la página de descarga en vez del archivo .apk?): ${e.message}`);
    }
  } finally {
    fs.rm(tmp, { force: true }, () => {});
  }
});

on('POST', '/api/catalog/copy', async ({ body: { serial, pkg, name } }) => {
  need(SERIAL.test(serial || '') && adb.PKG.test(pkg || ''), 'Móvil o paquete no válido');
  const tmp = path.join(os.tmpdir(), `panel-${process.pid}-${Date.now()}.apk`);
  try {
    await adb.pullApk(serial, pkg, tmp);
    return { app: catalog.putApk(tmp, String(name || '').trim()) };
  } finally {
    fs.rm(tmp, { force: true }, () => {});
  }
});

on('POST', '/api/catalog/:pkg/rename', ({ params, body: { name } }) => (catalog.rename(params.pkg, name), {}));
on('POST', '/api/catalog/:pkg/remove', ({ params }) => (catalog.remove(params.pkg), {}));
// Si un móvil (por su número de serie) necesita esa app o no
on('POST', '/api/catalog/:pkg/want', ({ params, body: { serialno, on: wanted } }) => {
  need(SERIAL.test(serialno || ''), 'Móvil no válido');
  catalog.setWanted(params.pkg, serialno, Boolean(wanted));
  return {};
});
on('POST', '/api/catalog/auto', ({ body: { on: enabled } }) => {
  catalog.setAuto(enabled);
  if (enabled) sync.run({ auto: true }).catch(() => {}); // empieza ya, sin esperar a la próxima vuelta
  return {};
});

// Sin pkg ni serial: todas las apps en todos los móviles
on('POST', '/api/catalog/sync', async ({ body: { pkg, serial } }) => {
  need(!pkg || adb.PKG.test(pkg), 'Nombre de paquete no válido');
  need(!serial || SERIAL.test(serial), 'Móvil no válido');
  return { results: await sync.run({ pkg, serial }) };
});

// ── Ajustes comunes ──

on('GET', '/api/settings', async () => {
  const devices = await readyDevices();
  await Promise.all(devices.map(async d => {
    try { d.settings = await settings.read(d.serial); } catch (e) { d.error = e.message; }
  }));
  return { settings: settings.definitions(), profile: settings.profile(), exceptions: settings.exceptions(), devices };
});

on('POST', '/api/settings/profile', ({ body: { key, value } }) => {
  try { settings.setProfile(key, value); } catch (e) { throw new HttpError(400, e.message); }
  return {};
});

// Un ajuste distinto en un móvil (por su número de serie): value «» es no tocarlo ahí, y null, como el perfil
on('POST', '/api/settings/device', ({ body: { serialno, key, value } }) => {
  need(SERIAL.test(serialno || ''), 'Móvil no válido');
  try { settings.setException(serialno, key, value ?? null); } catch (e) { throw new HttpError(400, e.message); }
  return {};
});

// Sin serials: en todos los móviles; sin key: todos los ajustes. Cada móvil, con lo suyo encima del perfil
on('POST', '/api/settings/apply', async ({ body: { serials, key } }) => {
  need(!serials || (Array.isArray(serials) && serials.every(s => SERIAL.test(s))), 'Móvil no válido');
  const devices = await readyDevices();
  const targets = serials || devices.map(d => d.serial);
  const serialno = serial => devices.find(d => d.serial === serial)?.serialno;
  return { results: await Promise.all(targets.map(serial => settle(settings.apply(serial, key, serialno(serial)), { serial }))) };
});

// ── Música: los altavoces son una página que el móvil abre en Chrome (music.js) ──

on('GET', '/api/music', () => music.status());

// id: el número de serie del móvil, que no cambia aunque cambie su conexión (serial)
// again: recargar la página aunque ya esté abierta y sonando
on('POST', '/api/music/open', async ({ body: { serial, id, again } }) => {
  need(SERIAL.test(serial || '') && SERIAL.test(id || ''), 'Móvil no válido');
  return { message: await music.open(serial, id, Boolean(again)) };
});

on('POST', '/api/music/room', ({ body: { id, serial, on: enabled, delay, screen } }) => {
  need(SERIAL.test(id || '') && (!serial || SERIAL.test(serial)), 'Móvil no válido');
  music.setRoom(id, { serial, on: enabled, delay, screen });
  return {};
});

// La canción llega tal cual en el cuerpo; ?file= es su nombre
on('POST', '/api/music/upload', async ({ req, url }) => {
  try { return { file: await music.upload(req, url.searchParams.get('file')) }; } catch (e) { throw new HttpError(400, e.message); }
});

on('POST', '/api/music/folder', () => (music.openFolder(), {}));

// El volumen de la música de cada móvil: el suyo, el mismo que cambian sus botones
on('GET', '/api/music/volumes', async ({ url }) => {
  const serials = (url.searchParams.get('serials') || '').split(',').filter(Boolean);
  need(serials.every(s => SERIAL.test(s)), 'Móvil no válido');
  return { volumes: Object.fromEntries(await Promise.all(serials.map(async s => [s, await adb.musicVolume(s).catch(e => ({ error: e.message }))]))) };
});

on('POST', '/api/music/volume', async ({ body: { serial, level } }) => {
  need(SERIAL.test(serial || ''), 'Móvil no válido');
  return { volume: await adb.setMusicVolume(serial, level) };
});

// play (con song), toggle, next, previous, stop, seek, solo, all, shuffle, sleep; warning si no va a sonar en ningún móvil
on('POST', '/api/music/:action', ({ params, body }) => {
  try { return { warning: music.control(params.action, body) }; } catch (e) { throw new HttpError(400, e.message); }
});

on('POST', '/api/names', ({ body: { id, name } }) => {
  need(SERIAL.test(id || ''), 'Móvil no válido');
  cfg.setName(id, name);
  return {};
});

// ── Limpiar: todas las apps de cada móvil, para ver lo que sobra ──

// apps: { paquete: [sistema, instalada, activada, imprescindible] }, en corto porque son cientos por móvil
on('GET', '/api/cleanup', async () => {
  const devices = await readyDevices();
  await Promise.all(devices.map(async d => {
    try {
      d.apps = Object.fromEntries((await adb.apps(d.serial)).map(a => [a.pkg,
        [a.system ? 1 : 0, a.installed ? 1 : 0, a.enabled ? 1 : 0, limpieza.isProtected(a.pkg) ? 1 : 0]]));
    } catch (e) {
      d.apps = {};
      d.error = e.message;
    }
  }));
  return { devices, favorites: catalog.load().apps.map(a => a.pkg), suggested: limpieza.SUGGESTED, ...limpieza.load() };
});

on('POST', '/api/cleanup/mark', ({ body: { pkg, mark } }) => (limpieza.setMark(pkg, mark || ''), {}));

// Nombre e icono de las apps que se están enseñando
on('POST', '/api/appnames', async ({ body: { pkgs } }) => {
  need(Array.isArray(pkgs) && pkgs.length <= 400 && pkgs.every(p => adb.PKG.test(p)), 'Paquetes no válidos');
  return { names: await stores.names(pkgs) };
});

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    if ((size += chunk.length) > 100_000) throw new HttpError(413, 'Petición demasiado grande');
    chunks.push(chunk);
  }
  try {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
    return body && typeof body === 'object' ? body : {};
  } catch { throw new HttpError(400, 'JSON no válido'); }
}

async function handleApi(req, url) {
  // Solo responde a su propia página: la cabecera X-Panel impide que cualquier otra web abierta en el navegador mande
  // órdenes a los móviles (quién puede llegar, y con qué nombre, lo decide allowed)
  if (req.headers['x-panel'] !== '1') throw new HttpError(403, 'Prohibido');
  for (const r of routes) {
    const m = r.method === req.method && url.pathname.match(r.re);
    if (!m) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    need(!params.serial || SERIAL.test(params.serial), 'Móvil no válido');
    need(!params.pkg || adb.PKG.test(params.pkg), 'Nombre de paquete no válido');
    const body = /json/.test(req.headers['content-type'] || '') ? await readJson(req) : {};
    return r.handler({ req, url, params, body });
  }
  throw new HttpError(404, 'No existe');
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data ?? {}));
}

function serveStatic(pathname, res) {
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!Object.hasOwn(STATIC, name)) {
    res.writeHead(404);
    return res.end('No existe');
  }
  fs.readFile(path.join(PUBLIC, name), (err, data) => {
    if (err) { res.writeHead(500); return res.end(); }
    res.writeHead(200, { 'Content-Type': `${STATIC[name]}; charset=utf-8`, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref();
}

// ── Desde otros dispositivos de casa ──
// El panel escucha siempre en este PC (127.0.0.1). Con «red» encendido (se guarda en panel.json), además en las IP
// privadas del PC, y solo atiende a direcciones de la red de casa: aunque alguien abriera el puerto en el router, a
// internet no le contesta. No pide contraseña: cualquiera conectado a la misma red puede usarlo
const PRIVATE_IP = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.|::1$|f[cd][0-9a-f]{2}:|fe80:)/i;
// Por la red se tiene que llegar con una IP o con el nombre del PC: así una web de fuera no puede hacerse pasar por la
// página del panel cambiando a qué IP apunta su nombre («DNS rebinding»)
const LAN_HOST = new RegExp(`^(\\d{1,3}(\\.\\d{1,3}){3}|\\[[0-9a-f:]+\\]|localhost|${os.hostname().replace(/[^\w-]/g, '')}`
  + '(\\.(local|lan|home|localdomain|home\\.arpa))?)(:\\d+)?$', 'i');
const NETWORK = 'panel.json';
const plainIp = ip => String(ip || '').replace(/^::ffff:/, '');

let lanOn = false;
try { lanOn = JSON.parse(fs.readFileSync(cfg.dataPath(NETWORK), 'utf8')).red === true; } catch {}
const lanServers = new Map(); // IP del PC → el servidor que escucha en ella

// Las IPv4 privadas que tiene ahora el PC (no las de enlace local, 169.254, que no sirven para llegar desde otro aparato).
// Las de las tarjetas virtuales (VirtualBox, Hyper-V y WSL, VMware, Docker) también, pero se marcan: desde otro aparato
// de casa no se llega por ellas, así que no se enseñan. Se reconocen por el fabricante de su MAC o por el nombre
const VIRTUAL_MAC = /^(0a:00:27|08:00:27|00:15:5d|00:50:56|00:0c:29|00:05:69|00:1c:14|02:42)/i;
const VIRTUAL_NAME = /virtual|vethernet|vmware|vbox|hyper-v|wsl|docker/i;
const privateIps = () => Object.entries(os.networkInterfaces()).flatMap(([name, list]) => list
  .filter(i => i.family === 'IPv4' && !i.internal && PRIVATE_IP.test(i.address) && !i.address.startsWith('169.254.'))
  .map(i => ({ address: i.address, virtual: VIRTUAL_MAC.test(i.mac) || VIRTUAL_NAME.test(name) })));

// Escucha en las IP privadas del PC (se mira cada minuto: cambian si cambia de red), o en ninguna si está apagado
function updateLan() {
  const want = new Set(lanOn ? privateIps().map(i => i.address) : []);
  for (const [ip, s] of lanServers) {
    if (want.has(ip)) continue;
    s.close();
    lanServers.delete(ip);
  }
  for (const ip of want) {
    if (lanServers.has(ip)) continue;
    const s = http.createServer(handle);
    s.on('error', e => {
      console.log(`  red: no puedo escuchar en ${ip}: ${e.message}`);
      lanServers.delete(ip);
    });
    s.listen(PORT, ip);
    lanServers.set(ip, s);
  }
}

// Las direcciones para abrirlo desde otro aparato: las de las tarjetas reales (si solo hay virtuales, todas)
function lanStatus() {
  const listening = privateIps().filter(i => lanServers.has(i.address));
  const real = listening.filter(i => !i.virtual);
  return { on: lanOn, urls: (real.length ? real : listening).map(i => `http://${i.address}:${PORT}`) };
}

on('GET', '/api/red', () => lanStatus());
on('POST', '/api/red', ({ body: { on: enabled } }) => {
  lanOn = Boolean(enabled);
  fs.writeFileSync(cfg.dataPath(NETWORK), `${JSON.stringify({ red: lanOn }, null, 2)}\n`);
  updateLan();
  return lanStatus();
});

// Por este PC, solo con su nombre (localhost); por la red, solo desde una dirección de casa y con una IP o el nombre del PC
function allowed(req) {
  const local = plainIp(req.socket.localAddress), host = req.headers.host || '';
  if (local.startsWith('127.') || local === '::1') return LOOPBACK.test(host);
  return lanOn && PRIVATE_IP.test(plainIp(req.socket.remoteAddress)) && LAN_HOST.test(host);
}

async function handle(req, res) {
  if (!allowed(req)) return send(res, 403, { error: 'Prohibido' });
  const url = new URL(req.url, 'http://panel');
  if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);
  try {
    send(res, 200, await handleApi(req, url));
  } catch (e) {
    send(res, e.status || 500, { error: e.message });
  }
}

const server = http.createServer(handle);

// Si ya estaba abierto (por ejemplo, porque arranca solo con Windows), panel.cmd solo lo abre en el navegador
server.on('error', e => {
  if (e.code === 'EADDRINUSE' && process.argv.includes('--open')) {
    console.log(`El panel ya estaba en marcha: lo abro en el navegador (http://localhost:${PORT}).`);
    openBrowser(`http://localhost:${PORT}`);
    setTimeout(() => process.exit(0), 1500);
    return;
  }
  console.error(e.code === 'EADDRINUSE' ? `El puerto ${PORT} está ocupado: ¿ya tienes el panel abierto? Prueba con otro: PORT=8770` : e.message);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', async () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Panel en ${url}  (Ctrl+C para pararlo)`);
  music.start();
  updateLan();
  setInterval(updateLan, 60000).unref();
  if (lanOn) console.log(`Desde otros dispositivos de casa: ${lanStatus().urls.join(' o ')}`);
  if (!adb.adbPath()) console.log('Aviso: no encuentro adb; el panel explica cómo instalarlo.');
  if (process.argv.includes('--open')) openBrowser(url);
  await adb.startServer();
  for (const r of await Promise.all(cfg.savedIps().map(ip => settle(adb.connect(ip), { ip })))) {
    console.log(`  ${r.ip}: ${r.message}`);
  }
  music.keepPorts();
  setInterval(keepConnected, 60000);
  autoSync();
});

// Modo automático: cada 5 minutos pone al día las apps comunes de APK y F-Droid en los móviles conectados
async function autoSync() {
  try {
    if (catalog.load().auto) {
      for (const r of await sync.run({ auto: true })) console.log(`  auto ${r.serial} ${r.pkg || ''}: ${r.message}`);
    }
  } catch (e) {
    console.log(`  auto: ${e.message}`);
  }
  setTimeout(autoSync, 5 * 60_000).unref();
}
