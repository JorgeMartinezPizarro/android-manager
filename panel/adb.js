// adb.js — lo poco que el panel necesita de adb. Todo lo que se ejecuta en los móviles pasa por aquí.
'use strict';
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EXE = process.platform === 'win32' ? 'adb.exe' : 'adb';
const PKG = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+$/;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const lastLine = s => s.replace(/\r/g, '').trim().split('\n').pop();
// De un error de Android, la línea que lo explica («…Exception: motivo»), no la última de la traza
const errorLine = s => s.replace(/\r/g, '').split('\n').map(l => l.trim()).find(l => /^[\w.$]*(Exception|Error): \S/.test(l)) || lastLine(s);

// winget deja adb en su carpeta de paquetes y la añade al PATH, que no ven las terminales ya abiertas
function wingetAdb(localAppData) {
  const packages = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
  try {
    return fs.readdirSync(packages).filter(d => d.startsWith('Google.PlatformTools'))
      .map(d => path.join(packages, d, 'platform-tools', EXE));
  } catch { return []; }
}

// Se busca en cada llamada hasta encontrarlo, así se puede instalar adb sin reiniciar el panel
let found = null;
function adbPath() {
  if (found && fs.existsSync(found)) return found;
  const { ADB, ANDROID_HOME, LOCALAPPDATA, PATH = '' } = process.env;
  const candidates = [
    ADB,
    path.join(__dirname, '..', 'platform-tools', EXE),
    ANDROID_HOME && path.join(ANDROID_HOME, 'platform-tools', EXE),
    LOCALAPPDATA && path.join(LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', EXE),
    LOCALAPPDATA && path.join(LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', EXE),
    ...(LOCALAPPDATA ? wingetAdb(LOCALAPPDATA) : []),
    ...PATH.split(path.delimiter).filter(Boolean).map(dir => path.join(dir, EXE)),
  ];
  found = candidates.find(c => c && fs.existsSync(c)) || null;
  return found;
}

// binary: devuelve los bytes tal cual (para las capturas de pantalla) en vez de texto
function run(args, { timeout = 30000, binary = false } = {}) {
  const bin = adbPath();
  if (!bin) return Promise.reject(new Error('No encuentro adb: instala las platform-tools de Android (mira el README)'));
  // Un .js hace de adb de mentira (npm run demo)
  const [cmd, argv] = bin.endsWith('.js') ? [process.execPath, [bin, ...args]] : [bin, args];
  return new Promise((resolve, reject) => {
    execFile(cmd, argv, { timeout, maxBuffer: 32 << 20, windowsHide: true, encoding: binary ? 'buffer' : 'utf8' }, (err, stdout, stderr) => {
      if (!err) return resolve(binary ? stdout : stdout.replace(/\r/g, ''));
      reject(new Error(err.killed ? 'adb no respondió a tiempo' : errorLine(String(stderr)) || errorLine(String(stdout)) || err.message));
    });
  });
}

const shell = (serial, script, opts) => run(['-s', serial, 'shell', script], opts);

// pm y compañía a veces fallan con código de salida 0, así que también se mira el texto
function check(out) {
  if (/Failure|Error|Exception|aborted|failed/i.test(out)) throw new Error(errorLine(out));
  return out;
}

// Arranca el demonio de adb de antemano para que la primera consulta no cargue con ello
function startServer() {
  const bin = adbPath();
  if (!bin || bin.endsWith('.js')) return Promise.resolve();
  return new Promise(resolve => {
    spawn(bin, ['start-server'], { stdio: 'ignore', windowsHide: true }).on('close', resolve).on('error', resolve);
  });
}

// Una sola llamada por móvil: propiedades, batería y red separadas por @@
const INFO = [
  'getprop ro.serialno', 'getprop ro.product.manufacturer', 'getprop ro.product.model',
  'getprop ro.build.version.release', 'getprop ro.build.version.sdk', 'echo @@', 'dumpsys battery', 'echo @@',
  'ip -f inet addr show wlan0 2>/dev/null', 'true',
].join('; ');

async function info(serial) {
  const [props, battery = '', net = ''] = (await shell(serial, INFO)).split('@@\n');
  const [serialno, maker, model, android, sdk] = props.split('\n').map(s => s.trim());
  const level = battery.match(/level:\s*(\d+)/);
  return {
    serialno, maker, model, android, sdk: Number(sdk) || 0,
    battery: level ? Number(level[1]) : null,
    charging: /(AC|USB|Wireless) powered: true/.test(battery),
    ip: net.match(/inet (\d+\.\d+\.\d+\.\d+)/)?.[1] || null,
  };
}

// Solo los números de serie de lo que adb tiene conectado, sin preguntar nada a los móviles
const serials = async () => (await run(['devices'])).split('\n').slice(1).map(line => line.split(/\s+/)[0]).filter(Boolean);

async function devices() {
  const rows = (await run(['devices'])).split('\n').slice(1)
    .map(line => line.match(/^(\S+)\s+(.+)$/)).filter(Boolean)
    .map(([, serial, state]) => ({ serial, state: state.trim(), wifi: serial.includes(':') || serial.includes('._adb-tls-') }));
  await Promise.all(rows.filter(d => d.state === 'device').map(async d => {
    try { Object.assign(d, await info(d.serial)); } catch (e) { d.error = e.message; }
  }));
  // Un móvil enchufado y conectado por wifi a la vez sale dos veces: se queda la conexión por cable
  const byPhone = new Map();
  for (const d of rows.sort((a, b) => a.wifi - b.wifi)) {
    const id = d.serialno || d.serial;
    if (!byPhone.has(id)) byPhone.set(id, d);
  }
  return [...byPhone.values()];
}

const APPS = 'pm list packages; echo @@; pm list packages -3; echo @@; pm list packages -d; echo @@; pm list packages -u';
const pkgSet = text => new Set(text.split('\n').filter(l => l.startsWith('package:')).map(l => l.slice(8).trim()));

// Todas las apps del móvil, incluidas las del sistema quitadas para el usuario (se pueden restaurar)
async function apps(serial) {
  const [installed, third, disabled, all] = (await shell(serial, APPS)).split('@@\n').map(pkgSet);
  return [...all].sort().map(pkg => ({
    pkg, system: !third.has(pkg), installed: installed.has(pkg), enabled: !disabled.has(pkg),
  }));
}

const ACTIONS = {
  // Las del sistema solo se pueden quitar para el usuario; vuelven con «restore»
  async uninstall(s, pkg) {
    const system = (await shell(s, `pm list packages -s ${pkg}`)).split('\n').some(l => l.trim() === `package:${pkg}`);
    check(system ? await shell(s, `pm uninstall --user 0 ${pkg}`) : await run(['-s', s, 'uninstall', pkg]));
    return system ? 'Quitada (se puede restaurar)' : 'Desinstalada';
  },
  disable: async (s, pkg) => (check(await shell(s, `pm disable-user --user 0 ${pkg}`)), 'Desactivada'),
  enable: async (s, pkg) => (check(await shell(s, `pm enable ${pkg}`)), 'Activada'),
  restore: async (s, pkg) => (check(await shell(s, `pm install-existing ${pkg}`)), 'Restaurada'),
  open: async (s, pkg) => (check(await shell(s, `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`)), 'Abierta en el móvil'),
};

function appAction(serial, pkg, action) {
  if (!PKG.test(pkg)) throw new Error('Nombre de paquete no válido');
  if (!Object.hasOwn(ACTIONS, action)) throw new Error(`Acción desconocida: ${action}`);
  return ACTIONS[action](serial, pkg);
}

// Versión instalada (versionCode) de cada paquete pedido; si no está instalado, no aparece
async function versions(serial, pkgs) {
  const safe = pkgs.filter(p => PKG.test(p));
  const script = ['pm list packages', ...safe.map(p => `echo @@${p}; dumpsys package ${p} | grep versionCode`), 'true'];
  const installed = new Set(), found = {};
  let current = null;
  for (const line of (await shell(serial, script.join('; '), { timeout: 60000 })).split('\n')) {
    if (line.startsWith('package:')) installed.add(line.slice(8).trim());
    else if (line.startsWith('@@')) current = line.slice(2).trim();
    else if (current && !(current in found)) {
      const m = line.match(/versionCode=(\d+)/);
      if (m) found[current] = Number(m[1]);
    }
  }
  return Object.fromEntries(safe.filter(p => installed.has(p)).map(p => [p, found[p] ?? 0]));
}

const INSTALL_ERRORS = {
  INSTALL_FAILED_OLDER_SDK: 'Necesita un Android más nuevo que el de este móvil',
  INSTALL_FAILED_UPDATE_INCOMPATIBLE: 'Ya está instalada desde otro sitio (otra firma): desinstálala antes',
  INSTALL_FAILED_VERSION_DOWNGRADE: 'El móvil ya tiene una versión más nueva',
  INSTALL_FAILED_INSUFFICIENT_STORAGE: 'No queda espacio en el móvil',
  INSTALL_FAILED_NO_MATCHING_ABIS: 'No es compatible con el procesador de este móvil',
  INSTALL_FAILED_USER_RESTRICTED: 'El móvil ha bloqueado la instalación: permite «Instalar vía USB» en Opciones de desarrollador',
};

async function install(serial, apk) {
  try {
    check(await run(['-s', serial, 'install', '-r', apk], { timeout: 5 * 60000 }));
  } catch (e) {
    const code = Object.keys(INSTALL_ERRORS).find(k => e.message.includes(k));
    throw code ? new Error(INSTALL_ERRORS[code]) : e;
  }
  return 'Instalada';
}

// Google Play no deja instalar desde fuera: se abre la ficha de la app y en el móvil se pulsa Instalar
async function openStore(serial, pkg) {
  const out = await shell(serial, `am start -a android.intent.action.VIEW -d 'market://details?id=${pkg}'`);
  if (/Error|unable to resolve/i.test(out)) throw new Error('Este móvil no tiene Google Play');
  return 'Abierta en Google Play: pulsa Instalar en el móvil';
}

// Copia el APK de una app instalada (solo las de una pieza: las partidas dependen de cada móvil)
async function pullApk(serial, pkg, dest) {
  if (!PKG.test(pkg)) throw new Error('Nombre de paquete no válido');
  const paths = (await shell(serial, `pm path ${pkg}`)).split('\n').filter(l => l.startsWith('package:')).map(l => l.slice(8).trim());
  if (!paths.length) throw new Error('Esa app no está instalada en ese móvil');
  if (paths.length > 1) throw new Error('Esta app viene partida en varios APK y no se puede copiar: añádela desde Google Play o F-Droid');
  await run(['-s', serial, 'pull', paths[0], dest], { timeout: 5 * 60000 });
}

// Ajustes en una sola llamada: versión de Android, modo oscuro y las tablas de ajustes system y global
const SETTINGS = 'getprop ro.build.version.sdk; echo @@; cmd uimode night 2>/dev/null; echo @@; settings list system; echo @@; settings list global';
const table = text => Object.fromEntries(text.split('\n').map(l => l.match(/^([\w.]+)=(.*)$/)).filter(Boolean).map(([, k, v]) => [k, v.trim()]));

async function readSettings(serial) {
  const [sdk, night = '', system = '', global = ''] = (await shell(serial, SETTINGS)).split('@@\n');
  return { sdk: Number(sdk) || 0, night: night.match(/Night mode: (\w+)/)?.[1], system: table(system), global: table(global) };
}

// Solo estas órdenes, con valores sencillos: los ajustes no pueden colar nada más en el móvil
const SETTING_CMD = /^(settings put (system|global) \w+ [\w.-]+|cmd uimode night (yes|no))$/;

// ColorOS (OPPO, realme, OnePlus) y MIUI no dejan a adb cambiar ajustes ni pulsar teclas hasta activar una opción en el móvil
const blocked = e => (/WRITE_(SECURE_)?SETTINGS|MODIFY_DAY_NIGHT_MODE|INJECT_EVENTS/.test(e.message)
  ? new Error('El móvil no deja que el PC cambie sus ajustes ni pulse teclas. En Opciones de desarrollador activa '
    + '«Desactivar supervisión de permisos» (OPPO, realme, OnePlus) o «Depuración USB (ajustes de seguridad)» (Xiaomi) y vuelve a probar.')
  : e);

// Los errores van a stderr y el código de salida es el de la última orden: 2>&1 para no perder ninguno
async function writeSettings(serial, commands) {
  if (!commands.length || !commands.every(c => SETTING_CMD.test(c))) throw new Error('Ajuste no válido');
  try {
    check(await shell(serial, commands.map(c => `${c} 2>&1`).join('; ')));
  } catch (e) {
    throw blocked(e);
  }
}

// Brillo de la pantalla, para bajarlo al mínimo mientras la página de altavoz descansa (una web no puede). Con el brillo
// automático (mode 1) Android no hace caso del nivel: para bajarlo hay que pasar a manual (0) y luego volver
async function brightness(serial) {
  const [mode, level] = (await shell(serial, 'settings get system screen_brightness_mode; settings get system screen_brightness')).trim().split(/\s+/);
  return { mode: /^[01]$/.test(mode) ? mode : '1', level: /^\d+$/.test(level) ? level : '128' };
}

const setBrightness = (serial, { mode, level }) => writeSettings(serial, [
  `settings put system screen_brightness ${level}`, `settings put system screen_brightness_mode ${mode}`]);

// ── Acciones rápidas ──

const sdkOf = async serial => Number(await shell(serial, 'getprop ro.build.version.sdk')) || 0;
// Entre comillas simples el shell del móvil no interpreta nada; solo hay que escapar la propia comilla
const quote = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Volumen de la música: «media volume» en Android 9 y 10, «cmd media_session volume» desde el 11; antes, solo las teclas
const volumeTool = sdk => (sdk >= 30 ? 'cmd media_session volume --stream 3' : sdk >= 28 ? 'media volume --stream 3' : null);
const volumeText = out => {
  const m = [...out.matchAll(/volume is (\d+) in range \[\d+\.\.(\d+)\]/g)].pop();
  return m && `Volumen de la música: ${m[1]} de ${m[2]}`;
};

async function volume(serial, adj) {
  const tool = volumeTool(await sdkOf(serial));
  if (!tool) {
    await shell(serial, `input keyevent KEYCODE_VOLUME_${adj === 'raise' ? 'UP' : 'DOWN'}`);
    return adj === 'raise' ? 'Volumen subido' : 'Volumen bajado';
  }
  return volumeText(await shell(serial, `${tool} --adj ${adj}; ${tool} --get`)) || 'Hecho';
}

// El volumen de la música tal como lo cuenta el propio Android (dumpsys audio): rápido y igual en todas las versiones.
// Cada salida (altavoz, auriculares…) tiene el suyo; vale el de la que está en uso
async function musicVolume(serial) {
  const block = (await shell(serial, 'dumpsys audio')).split(/\n- STREAM_/).find(b => b.startsWith('MUSIC:'));
  const max = Number(block?.match(/Max: (\d+)/)?.[1]);
  if (!max) throw new Error('El móvil no dice su volumen');
  const device = block.match(/Devices: (\w+)/)?.[1] || 'speaker';
  const level = block.match(new RegExp(`\\(${device}\\): (\\d+)`)) || block.match(/streamVolume:(\d+)/);
  return { level: Number(level?.[1] ?? 0), max };
}

// Sin «media volume» (Android 8 o anterior), setStreamVolume del servicio de audio, que es su llamada 3 hasta Android 9.
// Se comprueba leyéndolo después
async function setMusicVolume(serial, value) {
  const [{ max }, sdk] = await Promise.all([musicVolume(serial), sdkOf(serial)]);
  const level = Math.max(0, Math.min(max, Math.round(Number(value))));
  if (!Number.isFinite(level)) throw new Error('Volumen no válido');
  const tool = volumeTool(sdk);
  try {
    check(await shell(serial, tool ? `${tool} --set ${level} 2>&1` : `service call audio 3 i32 3 i32 ${level} i32 0 s16 com.android.shell 2>&1`));
  } catch (e) {
    throw blocked(e);
  }
  const now = await musicVolume(serial);
  if (now.level !== level) throw new Error(`El móvil no ha cambiado el volumen (sigue en ${now.level} de ${now.max})`);
  return now;
}

async function maxVolume(serial) {
  const tool = volumeTool(await sdkOf(serial));
  if (!tool) return shell(serial, `input keyevent ${Array(15).fill('KEYCODE_VOLUME_UP').join(' ')}`);
  const max = (await shell(serial, `${tool} --get`)).match(/in range \[\d+\.\.(\d+)\]/)?.[1];
  if (max) await shell(serial, `${tool} --set ${max}`);
}

// «Hacer sonar», para encontrarlo. Lo mejor es un temporizador de 1 s en el reloj, que suena hasta que se para en
// el móvil, pero el reloj pide un permiso que adb solo tiene en algunos móviles. Si no, el sonido de la alarma en
// su reproductor de música, con la música al máximo; solo si lo abre un reproductor, no cualquier app que acepte audio
const PLAYER = /music|media|player|audio/i;
const COMPONENT = /^[\w.]+\/[\w.$]+$/;

async function ring(serial) {
  const timer = await shell(serial, 'input keyevent KEYCODE_WAKEUP; am start -a android.intent.action.SET_TIMER '
    + '--ei android.intent.extra.alarm.LENGTH 1 --ez android.intent.extra.alarm.SKIP_UI true 2>&1').catch(e => e.message);
  if (!/Error|Exception|Denial/i.test(timer)) return 'Suena como un temporizador hasta que lo pares en el móvil';
  const uri = lastLine(await shell(serial, 'settings get system alarm_alert'));
  const intent = `-a android.intent.action.VIEW -d ${quote(uri)} -t 'audio/*'`;
  const player = uri.startsWith('content://') && (await shell(serial, `cmd package query-activities --brief ${intent}`))
    .split('\n').map(l => l.trim()).find(l => COMPONENT.test(l) && PLAYER.test(l.split('/')[0]));
  if (!player) throw new Error('Este móvil no tiene con qué sonar: su reloj no deja poner temporizadores desde el PC y no tiene reproductor de música');
  check(await shell(serial, `am start ${intent} -n ${quote(player)}`));
  await maxVolume(serial);
  return 'Suena la alarma en su reproductor de música, con la música al máximo';
}

function webLink(url) {
  let u;
  try { u = new URL(String(url || '').trim()); } catch { u = null; }
  if (!u || !/^https?:$/.test(u.protocol)) throw new Error('Escribe un enlace completo, como https://www.youtube.com/…');
  return u.href;
}

const APP_NAMES = { 'com.google.android.youtube': 'YouTube', 'com.android.chrome': 'Chrome' };
const appName = component => APP_NAMES[component.split('/')[0]] || component.split('/')[0];
const components = text => text.split('\n').map(l => l.trim()).filter(l => COMPONENT.test(l));

// La app que abre un enlace: la predeterminada, o si el móvil preguntaría con cuál (no hay ninguna elegida), la
// primera que no es un navegador: YouTube antes que Chrome para un vídeo. Abrir y cerrar eligen la misma
async function linkApp(serial, href) {
  const query = (cmd, link) => shell(serial, `cmd package ${cmd} --brief -a android.intent.action.VIEW -d ${quote(link)}`).then(components);
  const [preferred] = await query('resolve-activity', href);
  if (preferred && !preferred.startsWith('android/')) return preferred;
  const [all, browsers] = await Promise.all([query('query-activities', href), query('query-activities', 'https://example.com/')]);
  const browser = new Set(browsers.map(c => c.split('/')[0]));
  return all.find(c => !browser.has(c.split('/')[0])) || all[0] || null;
}

async function openUrl(serial, url) {
  const href = webLink(url);
  const app = await linkApp(serial, href);
  check(await shell(serial, `input keyevent KEYCODE_WAKEUP; am start -a android.intent.action.VIEW -d ${quote(href)}${app ? ` -n ${quote(app)}` : ''}`));
  return app ? `Abierto con ${appName(app)}` : 'Abierto';
}

// Cierra del todo la app con la que se abrió el enlace (para el vídeo, la música…)
async function closeUrl(serial, url) {
  const app = await linkApp(serial, webLink(url));
  const pkg = app?.split('/')[0];
  if (!pkg || !PKG.test(pkg) || pkg === 'android' || /systemui|launcher/i.test(pkg)) throw new Error('No sé con qué app se abrió: ciérralo en el móvil');
  check(await shell(serial, `am force-stop ${pkg} 2>&1`));
  return `${appName(app)} cerrado`;
}

// Aparece como una notificación de «Shell»; la orden existe desde Android 10
async function notify(serial, text) {
  text = String(text || '').replace(/[\0-\x1f]+/g, ' ').trim().slice(0, 200);
  if (!text) throw new Error('Escribe el aviso');
  if (await sdkOf(serial) < 29) throw new Error('Los avisos necesitan Android 10 o superior');
  check(await shell(serial, `cmd notification post -S bigtext -t ${quote('Aviso')} aviso${Date.now()} ${quote(text)} 2>&1`));
  return 'Aviso enviado';
}

const KEYS = {
  wake: ['KEYCODE_WAKEUP', 'Pantalla encendida'],
  lock: ['KEYCODE_SLEEP', 'Pantalla apagada'],
  playPause: ['KEYCODE_MEDIA_PLAY_PAUSE', 'Play / pausa'],
  previous: ['KEYCODE_MEDIA_PREVIOUS', 'Canción anterior'],
  next: ['KEYCODE_MEDIA_NEXT', 'Canción siguiente'],
};

const QUICK = {
  ...Object.fromEntries(Object.entries(KEYS).map(([action, [key, message]]) =>
    [action, async s => (check(await shell(s, `input keyevent ${key} 2>&1`)), message)])),
  // Quita el bloqueo de deslizar; con PIN o patrón, adb no puede saltárselo y el móvil se queda pidiéndolo
  unlock: async s => (check(await shell(s, 'input keyevent KEYCODE_WAKEUP 2>&1; sleep 1; wm dismiss-keyguard 2>&1')),
    'Desbloqueado; si tiene PIN, se queda pidiéndolo'),
  // El giro fijo es user_rotation (0 vertical, 1 horizontal), que solo cuenta con el giro automático apagado
  landscape: async s => (await writeSettings(s, ['settings put system accelerometer_rotation 0', 'settings put system user_rotation 1']), 'En horizontal'),
  portrait: async s => (await writeSettings(s, ['settings put system accelerometer_rotation 0', 'settings put system user_rotation 0']), 'En vertical'),
  autoRotate: async s => (await writeSettings(s, ['settings put system accelerometer_rotation 1']), 'Gira sola'),
  // El calendario que tenga cada móvil (el de Google, el de Huawei…); se abre en la última vista que se usó
  calendar: async s => (check(await shell(s, 'input keyevent KEYCODE_WAKEUP 2>&1; am start -a android.intent.action.MAIN -c android.intent.category.APP_CALENDAR 2>&1')),
    'Calendario abierto'),
  volumeUp: s => volume(s, 'raise'),
  volumeDown: s => volume(s, 'lower'),
  ring,
  open: (s, { url }) => openUrl(s, url),
  close: (s, { url }) => closeUrl(s, url),
  notify: (s, { text }) => notify(s, text),
};

async function quick(serial, action, body = {}) {
  if (!Object.hasOwn(QUICK, action)) throw new Error(`Acción desconocida: ${action}`);
  try {
    return await QUICK[action](serial, body);
  } catch (e) {
    throw blocked(e);
  }
}

// ── Altavoces: la página de música del panel abierta en Chrome ──

// adb reverse lleva un puerto del móvil al mismo del PC por la conexión de adb: el móvil abre http://localhost:<port>
// sin que el panel tenga que escuchar en la wifi. El adb de Android 7 lo rechaza por wifi («more than one device»): oldAdb
const reverse = (serial, port) => run(['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`]).catch(e => {
  if (/more than one device/.test(e.message)) e.oldAdb = true;
  throw e;
});

const wifiIp = async serial => (await shell(serial, 'ip -f inet addr show wlan0')).match(/inet (\d+\.\d+\.\d+\.\d+)/)?.[1] || null;

// application_id: Chrome reutiliza la pestaña que abrió antes para la misma app en vez de abrir otra cada vez
async function openSpeaker(serial, url) {
  try {
    check(await shell(serial, 'input keyevent KEYCODE_WAKEUP 2>&1; wm dismiss-keyguard 2>&1; am start -a android.intent.action.VIEW '
      + `-d ${quote(url)} -p com.android.chrome --es com.android.browser.application_id mis-android 2>&1`));
  } catch (e) {
    throw /unable to resolve/i.test(e.message) ? new Error('Este móvil no tiene Chrome, que es lo que hace de altavoz') : blocked(e);
  }
}

// Chrome no deja sonar una página hasta que alguien la toca. Toda la página es el botón de activar, así que vale tocar
// en cualquier punto: (lado corto / 2, lado corto / 2) cae dentro tanto en vertical como en horizontal.
// Con el móvil bloqueado (PIN o patrón) el toque caería en la pantalla de bloqueo: entonces no se toca
async function tapScreen(serial) {
  const out = await shell(serial, "wm size; dumpsys window policy | grep -E 'mIsShowing=|showing='");
  if (/\b(mIsShowing|showing)=true/.test(out)) throw new Error('El móvil está bloqueado: desbloquéalo y el panel activará el altavoz');
  const [, w = 600, h = 600] = [...out.matchAll(/(\d+)x(\d+)/g)].pop() || [];
  const p = Math.round(Math.min(w, h) / 2);
  try {
    check(await shell(serial, `input tap ${p} ${p} 2>&1`));
  } catch (e) {
    throw blocked(e);
  }
}

// Captura en PNG; con la pantalla apagada sale negra
async function screenshot(serial) {
  const png = await run(['-s', serial, 'exec-out', 'screencap', '-p'], { binary: true });
  if (png.subarray(0, 4).toString('latin1') !== '\x89PNG') throw new Error('El móvil no ha devuelto la captura');
  return png;
}

async function connect(host) {
  const target = host.includes(':') ? host : `${host}:5555`;
  const out = lastLine(await run(['connect', target], { timeout: 15000 }).catch(e => e.message));
  if (/connected to/.test(out)) return out;
  // El modo wifi del 5555 se pierde al reiniciar el móvil; solo se recupera desde el cable
  throw new Error(target.endsWith(':5555')
    ? `No responde en ${target}. Si el móvil se ha reiniciado, enchúfalo por cable y pulsa «Pasar a Wi-Fi».`
    : out || 'No se pudo conectar');
}

const disconnect = async serial => lastLine(await run(['disconnect', serial]));

// Una conexión wifi que se quedó en «unauthorized» u «offline» no se recupera sola aunque se acepte
// el permiso en el móvil: hay que rehacerla (y si aún no se había aceptado, el móvil vuelve a preguntar)
async function reconnect(serial) {
  await run(['disconnect', serial]).catch(() => {});
  return connect(serial);
}

async function pair(host, code) {
  const out = lastLine(await run(['pair', host, code], { timeout: 20000 }));
  if (!/Successfully paired/i.test(out)) throw new Error(out || 'No se pudo vincular');
  return out;
}

// Servicios que anuncian por la red los móviles con «Depuración inalámbrica» activa (Android 11+)
async function mdnsServices() {
  return (await run(['mdns', 'services'], { timeout: 10000 })).split('\n')
    .map(line => line.trim().split(/\s+/))
    .filter(f => f.length >= 3 && f[1].includes('_adb-tls-'))
    .map(([name, type, addr]) => ({ name, type, addr }));
}

// Emparejado por QR: tras escanearlo, el móvil anuncia un servicio de vinculación con el nombre del QR.
// Mientras no aparezca devuelve null; cuando aparece se vincula con la clave, se conecta y devuelve la dirección.
// Desde entonces adb lo reconecta solo cada vez que el móvil tenga activa la depuración inalámbrica.
async function pairQr(name, password) {
  const service = (await mdnsServices()).find(s => s.name === name && s.type.includes('pairing'));
  if (!service) return null;
  await pair(service.addr, password);
  const ip = service.addr.split(':')[0];
  for (let i = 1; ; i++) { // el servicio de conexión aparece unos segundos después de vincular
    const conn = (await mdnsServices()).find(s => s.type.includes('connect') && s.addr.startsWith(`${ip}:`));
    if (conn) {
      await connect(conn.addr);
      return conn.addr;
    }
    if (i === 10) throw new Error(`Vinculado, pero no encuentro el móvil en ${ip}: conéctalo con la IP:puerto de «Depuración inalámbrica»`);
    await sleep(1500);
  }
}

// Pone adb del móvil a escuchar por wifi en el 5555 y se conecta; devuelve la IP
async function enableWifi(serial) {
  const { ip } = await info(serial);
  if (!ip) throw new Error('El móvil no tiene IP: conéctalo antes a la wifi');
  await run(['-s', serial, 'tcpip', '5555']);
  for (let i = 1; ; i++) {
    await sleep(1500); // adbd tarda un poco en reiniciarse en modo red
    try {
      await connect(ip);
      return ip;
    } catch {
      if (i === 5) throw new Error(`El móvil no acepta la conexión por wifi en ${ip}: comprueba que está en la misma wifi que el PC`);
    }
  }
}

module.exports = {
  PKG, adbPath, startServer, serials, devices, apps, appAction, versions, install, openStore, pullApk,
  readSettings, writeSettings, brightness, setBrightness, quick, musicVolume, setMusicVolume, screenshot, reverse, wifiIp, openSpeaker, tapScreen, connect, disconnect, reconnect, pair, pairQr, enableWifi,
};
