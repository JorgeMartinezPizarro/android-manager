// music.js — música por casa: cada móvil abre en Chrome la página de altavoz (public/speaker.html) y suenan a la vez las
// canciones de la carpeta musica/. No se manda «play» a cada móvil, porque cada uno tarda distinto en obedecer (de 0,2 a 3 s):
// todos ajustan su reloj con el del PC y el PC les dice a qué hora exacta empieza la canción.
'use strict';
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const adb = require('./adb');
const cfg = require('./config');

// Los móviles llegan por adb reverse a este puerto del PC, que solo escucha en el propio PC. Los de Android 7, que no
// pueden, llegan por la wifi de casa: para ellos el puerto escucha también en la IP del PC, solo para las IP de esos móviles
const PORT = Number(process.env.MUSIC_PORT) || (Number(process.env.PORT) || 8765) + 2;
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
// MUSIC_SILENT=1: los altavoces hacen todo igual pero sin que se oiga, para probar sin molestar en casa
const SILENT = process.env.MUSIC_SILENT === '1';
const ID = /^[\w.:-]{1,64}$/;
const DIR = cfg.dataPath('musica');
const PUBLIC = path.join(__dirname, 'public');
const TYPES = {
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
  '.wav': 'audio/wav', '.flac': 'audio/flac',
};
const TEST = '*prueba'; // la prueba de sincronía; «*» no puede estar en un nombre de archivo de Windows
const CAL = '*calibrar'; // la que suena mientras el panel calibra los altavoces con el micrófono; no sale en la lista
const isTest = id => id === TEST || id === CAL;
const LEAD = 800; // ms entre que el PC fija la hora de empezar y que empieza: lo que tarda el aviso en llegar a todos
const WAIT = 15000; // lo que se espera, como mucho, a que todos los altavoces hayan cargado la canción

// El reloj del PC con decimales; el de los altavoces se ajusta a este
const now = () => performance.timeOrigin + performance.now();

// ── Canciones ──

// Los archivos de audio de musica/ y sus subcarpetas, en orden alfabético; el id es la ruta con «/»
function songs() {
  let files = [];
  try { files = fs.readdirSync(DIR, { recursive: true }); } catch {}
  return files.map(f => f.split(path.sep).join('/'))
    .filter(f => Object.hasOwn(TYPES, path.extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, 'es', { numeric: true }))
    .map(id => ({ id, name: nameOf(id) }));
}

// El nombre sin lo que añade la descarga de YouTube: el código del vídeo ([p4QqMKe3rwY]), la extensión del vídeo original y
// coletillas como «(Official Music Video)» o «[4K]». Lo que distingue versiones, como «(Live 1977)», se queda
const JUNK = /\s*[([](?:\s*(?:official|oficial|music|lyrics?|video|audio|hd|hq|4k|upgrade|vinyl|visualizer|animated|high|quality|remastered|with)\b)+\s*[)\]]/gi;
const nameOf = id => (id === TEST ? 'Prueba de sincronía (pitidos)' : id === CAL ? 'Calibrando con el micrófono' : id.replace(/\.[^./]+$/, '').replace(/\s*\[[\w-]{11}\]$/, '')
  .replace(/\.(avi|mp4|mkv|webm|flv)$/i, '').replace(JUNK, '').trim().replace(/\//g, ' · '));

// WAV mono de 16 bits con la onda que dé sample(t), entre -1 y 1
function wav(seconds, sample, rate = 22050) {
  const n = Math.round(seconds * rate);
  const out = Buffer.alloc(44 + n * 2);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + n * 2, 4);
  out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // un canal
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample(i / rate))) * 32000), 44 + i * 2);
  return out;
}

// Un pitido corto cada segundo, más agudo uno de cada cuatro: si los altavoces van a la vez, se oye uno solo
const beeps = (seconds = 40) => wav(seconds, t => {
  const s = Math.floor(t), d = t - s;
  if (s < 1 || d > 0.05) return 0;
  return Math.sin(2 * Math.PI * (s % 4 === 1 ? 1760 : 880) * t) * Math.min(1, d / 0.003, (0.05 - d) / 0.003) * 0.6;
});
// Para calibrar con el micrófono: cada segundo, un barrido corto de 1 a 4 kHz. Al revés que un pitido, su eco no se parece
// a él mismo un poco antes o después, así que el panel encuentra en la grabación cuándo llegó con menos de 1 ms de error.
// public/app.js tiene la misma forma (CHIRP), para buscarlo
const CHIRP = { from: 1000, to: 4000, length: 0.04 };
const chirp = d => (d < 0 || d > CHIRP.length ? 0
  : Math.sin(2 * Math.PI * (CHIRP.from * d + (CHIRP.to - CHIRP.from) * d * d / (2 * CHIRP.length))) * Math.sin(Math.PI * d / CHIRP.length) ** 2);
const sweeps = (seconds = 150) => wav(seconds, t => (t < 1 ? 0 : chirp(t - Math.floor(t)) * 0.8));
let testWav = null, calWav = null;

// ── Habitaciones y altavoces ──

// Por número de serie del móvil (no cambia aunque cambie su conexión): si suena (o está silenciado), su retraso para
// cuadrarlo de oído y la última conexión de adb, para volver a abrirle el puerto. Y si las canciones van en aleatorio
const ROOMS = cfg.dataPath('music.json');
const saved = (() => { try { return JSON.parse(fs.readFileSync(ROOMS, 'utf8')); } catch { return {}; } })();
const rooms = saved.rooms || {};
const prefs = { shuffle: Boolean(saved.shuffle) };
const saveRooms = () => fs.writeFileSync(ROOMS, JSON.stringify({ rooms, ...prefs }, null, 2) + '\n');

// Las páginas de altavoz abiertas: su conexión de avisos y lo último que han contado de sí mismas. page: la hora a la que
// se cargó la pestaña que hace de altavoz; si Chrome abre otra, cuenta solo la más nueva. active: ya ha sonado alguna vez, así que si vuelve a pedir un toque (se ha recargado) el panel se lo da; taps: toques seguidos sin éxito
const speakers = new Map();
function speaker(id) {
  if (!speakers.has(id)) {
    speakers.set(id, {
      clients: new Set(), page: 0, status: {}, openedAt: 0, tapUntil: 0, tapping: false, taps: 0, active: false, tapError: '',
      rest: false, lighting: false, lightError: '',
    });
  }
  return speakers.get(id);
}

// La versión de la página de altavoz: cuando cambia, las páginas abiertas se recargan solas
const pageVersion = () => ['speaker.html', 'speaker.js']
  .map(f => { try { return fs.statSync(path.join(PUBLIC, f)).mtimeMs; } catch { return 0; } }).join('-');
const linked = sp => sp.clients.size > 0;

// ── Lo que suena ──

// startAt: la hora del PC a la que suena el principio de la canción; null mientras se espera a los altavoces.
// stopAt: la hora (Date.now) a la que se pausa sola, si se ha puesto el temporizador. next: la que sonará después, que
// los altavoces van cargando de antemano para no hacer pausa entre canciones
const st = { song: null, playing: false, startAt: null, position: 0, since: 0, stopAt: null, next: null };
const durations = new Map();
let endTimer = null, waitTimer = null, sleepTimer = null;

const position = () => (st.playing && st.startAt != null ? Math.max(0, (now() - st.startAt) / 1000) : st.position);

function view(id, list = songs(), v = pageVersion()) {
  const room = rooms[id] || {};
  return {
    song: st.song, title: st.song && nameOf(st.song), duration: (st.song && durations.get(st.song)) || null,
    playing: st.playing, startAt: st.startAt, position: st.position, next: st.next,
    stopAt: st.stopAt, on: Boolean(room.on), delay: room.delay || 0, room: cfg.names().get(id) || '',
    screen: room.screen !== false, songs: list.map(s => [s.id, s.name]), v,
  };
}

function broadcast() {
  const list = songs(), v = pageVersion();
  for (const [id, sp] of speakers) {
    const data = `data: ${JSON.stringify(view(id, list, v))}\n\n`;
    for (const res of sp.clients) res.write(data);
  }
  scheduleEnd();
}

// Los altavoces que tienen que sonar y aún no han cargado la canción; los que esperan un toque o fallan no cuentan
const waitingFor = () => [...speakers].filter(([id, sp]) => linked(sp) && rooms[id]?.on
  && !['tap', 'error'].includes(sp.status.phase)
  && !(sp.status.song === st.song && ['ready', 'playing'].includes(sp.status.phase)));

function maybeStart() {
  if (!st.playing || st.startAt != null) return;
  if (waitingFor().length && now() - st.since < WAIT) return;
  clearTimeout(waitTimer);
  st.startAt = now() + LEAD - st.position * 1000;
  broadcast();
}

// Primero los altavoces cargan la canción; cuando todos la tienen (o pasa WAIT), el PC fija la hora de empezar
function startWhenReady() {
  st.startAt = null;
  st.since = now();
  clearTimeout(waitTimer);
  waitTimer = setTimeout(maybeStart, WAIT + 50);
  broadcast();
  maybeStart();
}

// Al acabar, la siguiente; tras la última, otra vez la primera. La prueba de sincronía no sigue con nada
function scheduleEnd() {
  clearTimeout(endTimer);
  const d = durations.get(st.song);
  if (!st.playing || st.startAt == null || !d) return;
  endTimer = setTimeout(() => {
    try { isTest(st.song) ? stop() : skip(1); } catch { stop(); }
  }, Math.max(0, st.startAt + d * 1000 - now()) + 300);
}

// Cuántos altavoces van a sonar; si ninguno, el aviso para el panel
function warning() {
  const n = [...speakers].filter(([id, sp]) => linked(sp) && rooms[id]?.on && sp.status.phase !== 'tap').length;
  return n ? '' : 'No suena en ningún móvil: abre el altavoz en los que quieras y quítales el silencio';
}

function play(song) {
  const list = songs();
  if (!isTest(song) && !list.some(s => s.id === song)) throw new Error('Esa canción ya no está en la carpeta de música');
  Object.assign(st, { song, playing: true, position: 0, next: upcoming(song, list) });
  startWhenReady();
}

// La que sigue a esa: en orden, la de después (tras la última, la primera); en aleatorio, cualquier otra, y si ya había
// una elegida (y cargada en los altavoces) se mantiene. La prueba de sincronía no sigue con nada
function upcoming(song, list = songs()) {
  if (isTest(song) || !list.length) return null;
  if (prefs.shuffle) {
    if (st.next && st.next !== song && list.some(s => s.id === st.next)) return st.next;
    const others = list.filter(s => s.id !== song);
    return others.length ? others[Math.floor(Math.random() * others.length)].id : null;
  }
  const i = list.findIndex(s => s.id === song);
  const next = list[(i + 1) % list.length].id;
  return next === song ? null : next;
}

function pause() {
  if (!st.playing) return;
  Object.assign(st, { position: position(), playing: false, startAt: null });
  broadcast();
}

function resume() {
  if (st.playing) return;
  if (!st.song) return skip(1);
  st.next = upcoming(st.song);
  st.playing = true;
  startWhenReady();
}

function stop() {
  Object.assign(st, { song: null, playing: false, startAt: null, position: 0, next: null });
  broadcast();
}

// Hacia atrás, si ya lleva unos segundos, vuelve al principio de la misma. En aleatorio, hacia delante, cualquier otra
function skip(step) {
  const list = songs();
  if (!list.length) throw new Error('No hay canciones: copia alguna a la carpeta de música');
  if (step < 0 && st.song && position() > 5) return seek(0);
  if (step > 0 && st.next && st.next !== st.song && list.some(s => s.id === st.next)) return play(st.next);
  const i = list.findIndex(s => s.id === st.song);
  if (step > 0 && prefs.shuffle && list.length > 1) {
    const others = list.filter((_, j) => j !== i);
    return play(others[Math.floor(Math.random() * others.length)].id);
  }
  play(list[i < 0 ? (step > 0 ? 0 : list.length - 1) : (i + step + list.length) % list.length].id);
}

// Salta a ese segundo de la canción; los altavoces ya la tienen cargada, así que vuelven a empezar casi a la vez
function seek(seconds) {
  if (!st.song) return;
  const d = durations.get(st.song);
  st.position = Math.max(0, Math.min(Number(seconds) || 0, d ? d - 1 : Infinity));
  return st.playing ? startWhenReady() : broadcast();
}

// Solo suena en ese móvil: los demás quedan silenciados
function solo(id) {
  if (!ID.test(id || '')) throw new Error('Móvil no válido');
  rooms[id] ||= { on: true, delay: 0 };
  for (const [other, room] of Object.entries(rooms)) room.on = other === id;
  saveRooms();
  broadcast();
  maybeStart();
}

// Que suenen todos (on) o silenciarlos todos
function setAll(on) {
  for (const room of Object.values(rooms)) room.on = on;
  saveRooms();
  broadcast();
  maybeStart();
}

// Temporizador: dentro de tantos minutos se pausa (0 lo quita)
function sleep(minutes) {
  minutes = Math.max(0, Math.min(600, Number(minutes) || 0));
  clearTimeout(sleepTimer);
  st.stopAt = minutes ? Date.now() + minutes * 60000 : null;
  if (minutes) sleepTimer = setTimeout(() => { st.stopAt = null; pause(); broadcast(); }, minutes * 60000);
  broadcast();
}

// Las órdenes que se pueden dar desde el panel y desde la pantalla de cada altavoz
const CONTROL = {
  play: ({ song }) => play(String(song || '')),
  toggle: () => (st.playing ? pause() : resume()),
  next: () => skip(1),
  previous: () => skip(-1),
  stop,
  seek: ({ position: p }) => seek(p),
  here: ({ id, on }) => setRoom(id, { on }),
  solo: ({ id }) => solo(id),
  all: () => setAll(true),
  none: () => setAll(false),
  shuffle: ({ on }) => {
    prefs.shuffle = Boolean(on);
    saveRooms();
    st.next = null;
    st.next = st.song && upcoming(st.song);
    broadcast();
  },
  sleep: ({ minutes }) => sleep(minutes),
};

function control(action, body = {}) {
  if (!Object.hasOwn(CONTROL, action)) throw new Error(`Acción desconocida: ${action}`);
  CONTROL[action](body);
  return ['play', 'toggle', 'next', 'previous'].includes(action) && st.playing ? warning() : '';
}

// screen: false es un altavoz sin pantalla (solo suena, con la pantalla apagada); al volver a true se le enciende y se
// le quita la pantalla de bloqueo, para que se vea la página
function setRoom(id, { on, delay, serial, screen } = {}) {
  if (!ID.test(id || '')) throw new Error('Móvil no válido');
  const room = rooms[id] ||= { on: true, delay: 0 };
  if (on !== undefined) room.on = Boolean(on);
  if (delay !== undefined) room.delay = Math.max(-1000, Math.min(1000, Math.round(Number(delay) || 0)));
  if (serial) room.serial = serial;
  if (screen !== undefined) {
    room.screen = Boolean(screen);
    if (room.screen && room.serial) adb.quick(room.serial, 'unlock').catch(() => {});
  }
  saveRooms();
  broadcast();
  maybeStart();
}

// El volumen de la música de un altavoz, desde su propia página: step es un paso más (1) o menos (-1), y 0 solo lo lee.
// Los toques seguidos van en fila, para que cada paso parta del anterior
function stepVolume(id, step) {
  const room = rooms[id];
  if (!ID.test(id || '') || !room?.serial) throw new Error('Este móvil no está en el panel');
  const sp = speaker(id);
  sp.volumeQueue = (sp.volumeQueue || Promise.resolve()).catch(() => {}).then(async () => {
    const now = await adb.musicVolume(room.serial);
    return step ? adb.setMusicVolume(room.serial, now.level + step) : now;
  });
  return sp.volumeQueue;
}

// Abre la página de altavoz en el móvil. Cuando diga que espera un toque (Chrome no deja sonar sin él), se lo da el panel;
// si el móvil está bloqueado con PIN, lo vuelve a intentar con cada aviso de la página durante 2 minutos
// again: recargarla aunque ya esté abierta y sonando
async function open(serial, id, again = false) {
  const sp = speaker(id);
  const working = linked(sp) && sp.status.phase && sp.status.phase !== 'tap';
  if (working && !again) return (remember(id, serial), 'Ya estaba abierto');
  Object.assign(sp, { openedAt: Date.now(), tapUntil: Date.now() + 120000, taps: 0, tapError: '' });
  let base = `http://localhost:${PORT}`, lan = null;
  try {
    try {
      await adb.reverse(serial, PORT);
    } catch (e) {
      if (!e.oldAdb) throw e;
      ({ base, ip: lan } = await viaWifi(serial));
    }
    // t: una dirección distinta cada vez, para que Chrome la cargue de nuevo y no se limite a enseñar la pestaña
    const t = Date.now();
    await adb.openSpeaker(serial, `${base}/?id=${encodeURIComponent(id)}${SILENT ? '&silencio' : ''}&t=${t}`);
    adb.closeOldSpeakerTabs(serial, { port: PORT, id, t }).catch(() => {}); // sin esperar: tarda lo que tarde Chrome en abrirla
  } catch (e) {
    Object.assign(sp, { openedAt: 0, tapUntil: 0 });
    throw e;
  }
  remember(id, serial, lan);
  return working ? 'Reabriendo el altavoz' : lan ? 'Abriendo el altavoz por la wifi' : 'Abriendo el altavoz';
}

// Cada móvil que ha hecho de altavoz queda guardado; de primeras, suena. lan: su IP, si llega al PC por la wifi
function remember(id, serial, lan) {
  const room = rooms[id] ||= { on: true, delay: 0 };
  if (serial) {
    room.serial = serial;
    if (lan) room.lan = lan;
    else delete room.lan;
  }
  saveRooms();
}

// ── Altavoces por la wifi (Android 7) ──

const lanServers = new Map(); // IP del PC → promesa de su servidor escuchando
const allowed = new Set(); // IP de los móviles que llegan por la wifi
const plain = address => String(address || '').replace(/^::ffff:/, '');

// La IP del PC en la misma red que el móvil
function pcAddress(phoneIp) {
  const int = ip => ip.split('.').reduce((n, b) => n * 256 + Number(b), 0);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && (int(a.address) & int(a.netmask)) === (int(phoneIp) & int(a.netmask))) return a.address;
    }
  }
  return null;
}

function listenLan(address) {
  if (!lanServers.has(address)) {
    lanServers.set(address, new Promise((resolve, reject) => {
      const lanServer = http.createServer(handle);
      lanServer.once('error', e => {
        lanServers.delete(address);
        reject(new Error(e.code === 'EADDRINUSE' ? `El puerto ${PORT} de ${address} está ocupado` : e.message));
      });
      lanServer.listen(PORT, address, resolve);
    }));
  }
  return lanServers.get(address);
}

async function viaWifi(serial) {
  const ip = await adb.wifiIp(serial);
  const address = ip && pcAddress(ip);
  if (!address) throw new Error('Su Android es viejo y tiene que llegar al PC por la wifi, pero no lo encuentro en la misma red que el PC');
  allowed.add(ip);
  await listenLan(address);
  return { base: `http://${address}:${PORT}`, ip };
}

function report(id, s) {
  if (!ID.test(id || '')) throw new Error('Móvil no válido');
  const sp = speaker(id);
  if ((Number(s.page) || 0) < sp.page) return; // una pestaña vieja: no cuenta
  const song = typeof s.song === 'string' ? s.song : null;
  sp.status = {
    phase: String(s.phase || ''), song, error: String(s.error || '').slice(0, 200),
    rtt: Number.isFinite(s.rtt) ? s.rtt : null, fixes: Number(s.fixes) || 0,
    off: Number.isFinite(s.off) ? s.off : null, speed: Number.isFinite(s.speed) ? s.speed : null,
    jitter: Number.isFinite(s.jitter) ? s.jitter : null, light: s.light === true,
  };
  if (song && s.duration > 0) durations.set(song, Number(s.duration));
  // Pide un toque: recién abierta por el panel, o recargada tras haber sonado. Solo si está delante (si no, el toque
  // caería en otra app) y como mucho 3 veces seguidas
  if (sp.status.phase === 'tap' && (sp.tapUntil > Date.now() || sp.active) && s.visible !== false
    && !sp.tapping && sp.taps < 3 && rooms[id]?.serial) {
    sp.tapping = true;
    adb.tapScreen(rooms[id].serial)
      .then(() => { sp.taps++; sp.tapError = ''; })
      .catch(e => { sp.tapError = e.message; })
      .finally(() => { sp.tapping = false; });
  }
  if (sp.status.phase && sp.status.phase !== 'tap') Object.assign(sp, { active: true, taps: 0, tapUntil: 0, tapError: '' });
  sp.reportedAt = Date.now();
  sp.visible = s.visible !== false;
  if (typeof s.rest === 'boolean') {
    sp.rest = s.rest;
    light(id);
  }
  maybeStart();
  scheduleEnd();
}

// Mientras la página descansa, el brillo del móvil al mínimo; al tocarla, como estaba. Lo que había se guarda en music.json
// (room.light) por si el panel se cierra con la pantalla baja. Si cambia de idea a medias, el bucle lo deja como pida al final
// Un altavoz sin pantalla no se atenúa: al descansar se le apaga la pantalla (como mucho una vez cada 30 s), y si venía
// atenuado de antes se le devuelve el brillo
async function light(id) {
  const sp = speaker(id), room = rooms[id];
  if (!room?.serial || sp.lighting) return;
  sp.lighting = true;
  const dim = () => sp.rest && room.screen !== false;
  try {
    if (sp.rest && room.screen === false && Date.now() - (sp.offAt || 0) > 30000) {
      sp.offAt = Date.now();
      await adb.quick(room.serial, 'lock');
    }
    while (dim() !== Boolean(room.light)) {
      if (dim()) {
        room.light = await adb.brightness(room.serial);
        saveRooms();
        await adb.setBrightness(room.serial, await adb.darkest(room.serial, room.light));
      } else {
        await adb.setBrightness(room.serial, room.light);
        delete room.light;
        saveRooms();
      }
    }
    sp.lightError = '';
  } catch (e) {
    sp.lightError = `No he podido cambiar el brillo: ${e.message}`;
  } finally {
    sp.lighting = false;
  }
}

// Los altavoces sin pantalla, vigilados cada 15 s:
// - Android puede dormir Chrome si se queda mucho rato sin sonar. Si la música suena y uno sigue conectado pero lleva un
//   rato sin dar señales, o si espera un toque (recién recargada), se le enciende la pantalla y se quita la de bloqueo
//   (como mucho cada 2 minutos): la página despierta, el panel le da el toque si hace falta, vuelve a sonar y a los 15 s
//   descansa y se le apaga otra vez
// - Si la pantalla se enciende con la página detrás (la de bloqueo al tocarlo o al empezar a cargar, otra app…), la página
//   no puede descansar: si sigue encendida a la segunda vuelta (30 s), se apaga
let watching = false;
async function watchHeadless() {
  if (watching) return;
  watching = true;
  try {
    for (const [id, room] of Object.entries(rooms)) {
      const sp = speakers.get(id);
      if (room.screen !== false || !room.serial || !sp) continue;
      if (st.playing && room.on && linked(sp) && (Date.now() - (sp.reportedAt || 0) > 45000 || sp.status.phase === 'tap')
        && Date.now() - (sp.wokenAt || 0) > 120000) {
        sp.wokenAt = Date.now();
        adb.quick(room.serial, 'unlock').catch(() => {});
        continue;
      }
      // Delante y sin descansar: alguien la está usando, y descansará ella sola
      if (linked(sp) && sp.visible && !sp.rest) {
        sp.awakeTicks = 0;
        continue;
      }
      sp.awakeTicks = (await adb.awake(room.serial).catch(() => false)) ? (sp.awakeTicks || 0) + 1 : 0;
      if (sp.awakeTicks < 2) continue;
      sp.awakeTicks = 0;
      adb.quick(room.serial, 'lock').catch(() => {});
    }
  } finally {
    watching = false;
  }
}

// adb pierde el puerto de un móvil cuando este se desconecta o adb se reinicia: se le vuelve a abrir mientras no esté conectado
function keepPorts() {
  for (const [id, room] of Object.entries(rooms)) {
    if (room.serial && !room.lan && !linked(speaker(id))) adb.reverse(room.serial, PORT).catch(() => {});
  }
}

// ── Para el panel ──

function status() {
  return {
    port: PORT,
    songs: [{ id: TEST, name: nameOf(TEST), test: true }, ...songs()].map(s => ({ ...s, duration: durations.get(s.id) || null })),
    now: {
      song: st.song, name: st.song && nameOf(st.song), playing: st.playing, waiting: st.playing && st.startAt == null,
      position: position(), duration: durations.get(st.song) || null, stopAt: st.stopAt, shuffle: prefs.shuffle, startAt: st.startAt,
      next: st.next && nameOf(st.next),
    },
    rooms: Object.fromEntries(Object.entries(rooms).map(([id, room]) => {
      const sp = speaker(id);
      // Se le mandó abrir la página y al rato aún no ha llegado
      const late = !linked(sp) && sp.openedAt && Date.now() - sp.openedAt > 30000
        && 'Chrome no ha abierto la página: mira el móvil. Si tiene PIN, desbloquéalo; la primera vez, Chrome puede pedir que aceptes algo';
      const error = sp.tapError || sp.lightError || late;
      return [id, {
        on: Boolean(room.on), delay: room.delay || 0, lan: Boolean(room.lan), linked: linked(sp), screen: room.screen !== false,
        ...(linked(sp) ? sp.status : {}), ...(error ? { error } : {}),
      }];
    })),
  };
}

// La canción llega tal cual en el cuerpo; se escribe aparte y se renombra al final para que no salga a medias en la lista
async function upload(req, name) {
  name = path.basename(String(name || '')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim();
  if (!Object.hasOwn(TYPES, path.extname(name).toLowerCase())) {
    throw new Error(`«${name}» no es una canción: valen mp3, m4a, aac, ogg, opus, wav y flac`);
  }
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = path.join(DIR, `.subiendo-${process.pid}-${Date.now()}`);
  try {
    await pipeline(req, fs.createWriteStream(tmp));
    fs.renameSync(tmp, path.join(DIR, name));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  broadcast();
  return name;
}

function openFolder() {
  fs.mkdirSync(DIR, { recursive: true });
  const [cmd, args] = process.platform === 'win32' ? ['explorer', [DIR]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [DIR]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

// ── El servidor de los altavoces ──

const reply = (res, status, type, body) => {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  res.end(body);
};
const json = (res, data, status = 200) => reply(res, status, 'application/json; charset=utf-8', JSON.stringify(data));

async function readJson(req) {
  let text = '';
  for await (const chunk of req) {
    if ((text += chunk).length > 10_000) throw new Error('Petición demasiado grande');
  }
  const body = JSON.parse(text || '{}');
  return body && typeof body === 'object' ? body : {};
}

// Por trozos (Range) si se piden: el modo ligero de los altavoces la escucha con un <audio>, que para empezar por la mitad
// pide el trozo que le hace falta en vez de descargarla desde el principio. send(start, end) manda esos bytes
function sendRange(req, res, type, size, send) {
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  const partial = Boolean(range && (range[1] || range[2]));
  const start = !partial ? 0 : range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
  const end = partial && range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start > end) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    return res.end();
  }
  res.writeHead(partial ? 206 : 200, {
    'Content-Type': type, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache',
    ...(partial && { 'Content-Range': `bytes ${start}-${end}/${size}` }),
  });
  send(start, end);
}

function sendSong(req, res, id) {
  if (isTest(id)) {
    const data = id === TEST ? (testWav ||= beeps()) : (calWav ||= sweeps());
    return sendRange(req, res, 'audio/wav', data.length, (start, end) => res.end(data.subarray(start, end + 1)));
  }
  const file = path.resolve(DIR, ...id.split('/'));
  const type = TYPES[path.extname(file).toLowerCase()];
  if (!type || !file.startsWith(DIR + path.sep)) return reply(res, 404, 'text/plain', 'No existe');
  fs.stat(file, (err, s) => {
    if (err || !s.isFile()) return reply(res, 404, 'text/plain', 'No existe');
    sendRange(req, res, type, s.size, (start, end) => fs.createReadStream(file, { start, end }).pipe(res));
  });
}

// Avisos del PC a cada página (Server-Sent Events): el estado completo cada vez que cambia algo
function events(req, res, id) {
  if (!ID.test(id || '')) return reply(res, 400, 'text/plain', 'Falta el móvil');
  if (!rooms[id]) remember(id); // una página abierta a mano también es un altavoz
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => clearInterval(ping));
  // Cada móvil, una sola pestaña de altavoz: la más nueva. A las demás se les dice que paren (y siguen conectadas, para
  // que no vuelvan a llamar); las de antes de este cambio no mandan su hora y pierden ante cualquiera que sí la mande
  const sp = speaker(id);
  const page = Number(new URL(req.url, 'http://x').searchParams.get('p')) || 0;
  if (page < sp.page) return res.write('retry: 3000\nevent: replaced\ndata: {}\n\n');
  sp.page = page;
  for (const old of sp.clients) old.write('event: replaced\ndata: {}\n\n');
  sp.clients.clear();
  res.write(`retry: 3000\ndata: ${JSON.stringify(view(id))}\n\n`);
  sp.clients.add(res);
  sp.openedAt = 0; // ya llegó: si luego se va, no es que no se abriera
  req.on('close', () => {
    if (!sp.clients.delete(res)) return; // una pestaña vieja que se cierra
    if (!linked(sp)) {
      sp.status = {};
      sp.rest = false; // si la página se va, que el móvil no se quede con la pantalla a oscuras
      light(id);
    }
    maybeStart();
  });
}

const STATIC = { '/': ['speaker.html', 'text/html'], '/speaker.js': ['speaker.js', 'text/javascript'] };

// Solo para la página de altavoz: el Host frena el «DNS rebinding» y la cabecera X-Altavoz, las órdenes de otras webs.
// Por la wifi, además, solo atiende a los móviles que llegan así y al propio PC
function trusted(req) {
  const local = plain(req.socket.localAddress), remote = plain(req.socket.remoteAddress);
  if (!lanServers.has(local)) return LOOPBACK.test(req.headers.host || '');
  return (allowed.has(remote) || remote === local) && req.headers.host === `${local}:${PORT}`;
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://altavoz');
  if (!trusted(req)) return reply(res, 403, 'text/plain', 'Prohibido');
  try {
    if (req.method === 'GET') {
      if (Object.hasOwn(STATIC, url.pathname)) {
        const [file, type] = STATIC[url.pathname];
        return reply(res, 200, `${type}; charset=utf-8`, fs.readFileSync(path.join(PUBLIC, file)));
      }
      if (url.pathname === '/clock') return json(res, { t: now() });
      if (url.pathname === '/events') return events(req, res, url.searchParams.get('id'));
      if (url.pathname.startsWith('/song/')) return sendSong(req, res, decodeURIComponent(url.pathname.slice(6)));
    }
    if (req.method === 'POST' && req.headers['x-altavoz'] === '1') {
      const body = await readJson(req);
      if (url.pathname === '/status') return (report(body.id, body), json(res, {}));
      if (url.pathname === '/control') return json(res, { warning: control(String(body.action), body) });
      if (url.pathname === '/volume') return json(res, await stepVolume(String(body.id), Math.sign(Number(body.step)) || 0));
    }
    reply(res, 404, 'text/plain', 'No existe');
  } catch (e) {
    json(res, { error: e.message }, 400);
  }
}

function start() {
  const server = http.createServer(handle);
  server.on('error', e => console.log(e.code === 'EADDRINUSE'
    ? `  música: el puerto ${PORT} está ocupado, así que los altavoces no funcionarán` : `  música: ${e.message}`));
  server.listen(PORT, '127.0.0.1');
  // Los altavoces por la wifi que ya había vuelven a encontrar al PC tras reiniciar el panel
  for (const room of Object.values(rooms)) {
    const address = room.lan && pcAddress(room.lan);
    if (!address) continue;
    allowed.add(room.lan);
    listenLan(address).catch(e => console.log(`  música: ${e.message}`));
  }
  setInterval(keepPorts, 20000).unref();
  setInterval(watchHeadless, 15000).unref();
}

module.exports = { PORT, start, keepPorts, status, control, setRoom, open, upload, openFolder, wav };
