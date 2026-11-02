// fake-adb.js — un adb de mentira con tres móviles, para probar el panel sin conectarlos (npm run demo)
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { readApkInfo } = require('./apkinfo');

const STATE = process.env.FAKE_ADB_STATE || path.join(os.tmpdir(), 'fake-adb.json');
const SYSTEM = ['android', 'com.android.chrome', 'com.android.settings', 'com.android.systemui', 'com.android.vending',
  'com.facebook.appmanager', 'com.facebook.katana', 'com.google.android.gm', 'com.google.android.youtube'];

const SDK = { 7: 25, 9: 28, 10: 29, 11: 30, 12: 31, 13: 33 };

// Ajustes de fábrica; cada móvil puede cambiar alguno (tweak) para que no sean todos iguales
const factorySettings = (tweak = {}) => ({
  night: tweak.night || 'no',
  system: { screen_brightness_mode: '1', screen_brightness: '180', screen_off_timeout: '30000', font_scale: '1.0', accelerometer_rotation: '1', ...tweak.system },
  global: { stay_on_while_plugged_in: '0', window_animation_scale: '1.0', transition_animation_scale: '1.0', animator_duration_scale: '1.0', ...tweak.global },
});
const settingsOf = p => (p.settings ||= factorySettings()); // estados guardados antes de que hubiera ajustes

const phone = (sn, maker, model, android, battery, ip, mine, tweak) => ({
  sn, maker, model, android, battery, ip, lowest: tweak?.lowest,
  apps: Object.fromEntries([...SYSTEM.map(p => [p, { system: true }]), ...mine.map(p => [p, {}])]),
  settings: factorySettings(tweak),
});

const initial = () => ({
  polls: 0,
  phones: {
    R58M30ABCDE: phone('R58M30ABCDE', 'samsung', 'SM-A505FN', '9', 87, '192.168.1.50',
      ['at.bitfire.davdroid', 'com.whatsapp', 'com.zhiliaoapp.musically', 'im.vector.app'], { system: { screen_off_timeout: '600000' } }),
    ZY22B4K7QP: phone('ZY22B4K7QP', 'motorola', 'moto g(8)', '10', 18, '192.168.1.51', ['im.vector.app', 'org.videolan.vlc'],
      { system: { screen_off_timeout: '60000', accelerometer_rotation: '0', screen_auto_brightness_adj: '0.0' }, lowest: 17 }),
    '8AFX1JK2': phone('8AFX1JK2', 'Xiaomi', 'Redmi Note 9', '12', 100, '192.168.1.52', [], { system: { font_scale: '1.15' } }),
    // Aún sin conectar: para probar el alta por QR, añade a «mdns» [nombre del QR, '_adb-tls-pairing._tcp', '192.168.1.53:41235', clave]
    '0B281JEC': phone('0B281JEC', 'Google', 'Pixel 4a', '13', 64, '192.168.1.53', ['im.vector.app'], { night: 'yes' }),
  },
  // Servicios mDNS anunciados: [nombre, tipo, ip:puerto, clave de vinculación]
  mdns: [],
  // conexión → [número de serie, estado]
  transports: { R58M30ABCDE: ['R58M30ABCDE', 'device'], '192.168.1.51:5555': ['ZY22B4K7QP', 'device'], '192.168.1.52:5555': ['8AFX1JK2', 'unauthorized'] },
});

// El panel lanza varios adb a la vez: un cerrojo evita que se pisen al guardar el estado
const LOCK = `${STATE}.lock`;
for (let i = 0; ; i++) {
  try { fs.closeSync(fs.openSync(LOCK, 'wx')); break; } catch (e) {
    // EPERM: en Windows, mientras otro proceso lo está borrando
    if (e.code !== 'EEXIST' && e.code !== 'EPERM') throw e;
    if (i > 500) fs.rmSync(LOCK, { force: true }); // cerrojo abandonado
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
process.on('exit', () => { try { fs.rmSync(LOCK, { force: true }); } catch {} });

class Fail extends Error {}
const st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : initial();
const lines = [];
let binary = null; // lo que sale tal cual en vez de las líneas (exec-out)
const out = s => lines.push(s);
const fail = s => { throw new Fail(s); };

function phoneOf(serial) {
  const t = st.transports[serial] || fail(`adb: device '${serial}' not found`);
  if (t[1] !== 'device') fail('adb: device unauthorized.');
  return st.phones[t[0]];
}

const app = (p, pkg) => p.apps[pkg] || fail(`Exception occurred while executing: Unknown package: ${pkg}`);

// Una captura de mentira: un degradado del tamaño de una pantalla pequeña, negro si está apagada
function crc32(buf) {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return ~crc >>> 0;
}

function fakePng(p) {
  const [w, h] = [180, 380];
  const hue = [...p.sn].reduce((a, ch) => a + ch.charCodeAt(0), 0);
  const row = w * 3 + 1;
  const raw = Buffer.alloc(row * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * row + 1 + x * 3;
      if (p.screen === 'off') continue;
      raw[i] = (hue * 7 + y / 2) % 256; raw[i + 1] = (hue * 3 + x) % 256; raw[i + 2] = 200 - y / 3;
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 8 bits por canal
  ihdr[9] = 2; // RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Volumen de la música: «media volume» hasta Android 10 y «cmd media_session volume» desde el 11
function volumeCmd(p, args) {
  p.volume ??= 7;
  const m = args.match(/--(adj|set) (\w+)/);
  if (m?.[1] === 'set') p.volume = Math.min(15, Number(m[2]));
  if (m?.[1] === 'adj') p.volume = Math.max(0, Math.min(15, p.volume + (m[2] === 'raise' ? 1 : m[2] === 'lower' ? -1 : 0)));
  out('[v] Connecting to AudioService');
  if (args.includes('--get')) out(`[v] volume is ${p.volume} in range [0..15]`);
}

function shell(p, c) {
  c = c.replace(/\s+2>&1$/, '');
  const sdk = SDK[p.android] || 30;
  const props = {
    'ro.serialno': p.sn, 'ro.product.manufacturer': p.maker, 'ro.product.model': p.model,
    'ro.build.version.release': p.android, 'ro.build.version.sdk': String(sdk),
  };
  let m;
  if (c === '' || c === 'true') return;
  if ((m = c.match(/^getprop (\S+)$/))) return out(props[m[1]] ?? '');
  if ((m = c.match(/^echo (.*)$/))) return out(m[1]);
  if (c === 'dumpsys battery') return out(`Current Battery Service state:\n  AC powered: false\n  USB powered: ${p.battery < 100}\n  level: ${p.battery}\n  scale: 100`);
  if (c.startsWith('ip ')) return out(`30: wlan0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500\n    inet ${p.ip}/24 brd 192.168.1.255 scope global wlan0`);
  if ((m = c.match(/^(?:pm|cmd package) list packages((?: -\w)*)(?: (\S+))?$/))) {
    for (const [pkg, a] of Object.entries(p.apps).sort()) {
      const f = m[1];
      if ((m[2] && !pkg.includes(m[2])) || (a.removed && !f.includes('-u')) || (f.includes('-3') && a.system)
        || (f.includes('-s') && !a.system) || (f.includes('-d') && !a.disabled)) continue;
      out(`package:${pkg}`);
    }
    return;
  }
  if ((m = c.match(/^pm uninstall --user 0 (\S+)$/))) return (app(p, m[1]).removed = true, out('Success'));
  if ((m = c.match(/^pm disable-user --user 0 (\S+)$/))) return (app(p, m[1]).disabled = true, out(`Package ${m[1]} new state: disabled-user`));
  if ((m = c.match(/^pm enable (\S+)$/))) return (app(p, m[1]).disabled = false, out(`Package ${m[1]} new state: enabled`));
  if ((m = c.match(/^pm install-existing (\S+)$/))) return (app(p, m[1]).removed = false, out(`Package ${m[1]} installed for user: 0`));
  if ((m = c.match(/^monkey -p (\S+) /))) return (app(p, m[1]), out('Events injected: 1'));
  if ((m = c.match(/^dumpsys package (\S+)/))) {
    const a = p.apps[m[1]];
    return a && !a.removed ? out(`    versionCode=${a.versionCode || 1} minSdk=21 targetSdk=33`) : undefined;
  }
  if ((m = c.match(/^am start .*details\?id=([\w.]+)/))) return out(`Starting: Intent { act=android.intent.action.VIEW dat=market://details?id=${m[1]} }`);
  // El reloj solo deja poner temporizadores en los Android 12 o más nuevos (como el OPPO de verdad)
  if (c.includes('SET_TIMER') && sdk < 31) return out('Security exception: Permission Denial: starting Intent { act=android.intent.action.SET_TIMER } requires com.android.alarm.permission.SET_ALARM');
  if (c.startsWith('am start ')) return out(`Starting: Intent { ${c.slice(9, 80)} }`);
  if (c === 'settings get system alarm_alert') return out('content://media/internal/audio/media/11');
  // Solo el Samsung tiene reproductor de música (como el Huawei de verdad); el Motorola, como el Nexus, no
  if (c.startsWith('cmd package query-activities') && c.includes('audio/*')) {
    return out(p.maker === 'samsung' ? '1 activities found:\n  Activity #0:\n    com.sec.android.app.music/.MusicPlayerActivity' : 'No activities found');
  }
  // Enlaces: los de YouTube los abre YouTube en el Samsung, el Xiaomi usa Chrome y el Motorola pregunta (como el OPPO)
  const YOUTUBE = 'com.google.android.youtube/.UrlActivity', CHROME = 'com.android.chrome/com.google.android.apps.chrome.IntentDispatcher';
  if ((m = c.match(/^cmd package (resolve-activity|query-activities) --brief -a android\.intent\.action\.VIEW -d '(.+)'$/))) {
    const video = m[2].includes('youtube.com');
    if (m[1] === 'query-activities') return out(video ? `2 activities found:\n    ${YOUTUBE}\n    ${CHROME}` : `1 activities found:\n    ${CHROME}`);
    return out(!video ? CHROME : p.maker === 'samsung' ? YOUTUBE : p.maker === 'motorola' ? 'android/com.android.internal.app.ResolverActivity' : CHROME);
  }
  if ((m = c.match(/^am force-stop ([\w.]+)$/))) return;
  if ((m = c.match(/^input keyevent (.+)$/))) {
    if (m[1].includes('KEYCODE_SLEEP')) p.screen = 'off';
    if (m[1].includes('KEYCODE_WAKEUP')) p.screen = 'on';
    return;
  }
  if (c === 'sleep 1' || c === 'wm dismiss-keyguard') return;
  if (c === 'wm size') return out('Physical size: 1080x2340');
  if (c.startsWith('dumpsys window policy')) return out(`showing=${p.screen === 'off'} mIsShowing=${p.screen === 'off'}`);
  if (/^input tap \d+ \d+$/.test(c)) return;
  if ((m = c.match(/^(?:media|cmd media_session) volume --stream 3 (.+)$/))) return volumeCmd(p, m[1]);
  // Android 8 o anterior: setStreamVolume del servicio de audio
  if ((m = c.match(/^service call audio 3 i32 3 i32 (\d+) /))) return (p.volume = Math.min(15, Number(m[1])), out("Result: Parcel(00000000    '....')"));
  if (c === 'dumpsys audio') {
    return out(`- STREAM_VOICE_CALL:\n   Max: 5\n   Current: 2 (speaker): 4\n- STREAM_MUSIC:\n   Muted: false\n   Min: 0\n   Max: 15\n`
      + `   Current: 2 (speaker): ${p.volume ?? 7}, 4 (headset): 8, 40000000 (default): 10\n   Devices: speaker\n- STREAM_ALARM:\n   Max: 7`);
  }
  if (c.startsWith('cmd notification post ')) return sdk >= 29 ? out('Notification posted.') : fail('Unknown command: post');
  if ((m = c.match(/^pm path (\S+)$/))) return p.apps[m[1]] ? out(`package:/data/app/${m[1]}-1/base.apk`) : undefined;
  if ((m = c.match(/^cmd uimode night(?: (yes|no))?(?: 2>\/dev\/null)?$/))) {
    if (sdk < 28) return; // en Android 7 no existe: el error va a stderr
    if (m[1]) settingsOf(p).night = m[1];
    return out(`Night mode: ${settingsOf(p).night}`);
  }
  if ((m = c.match(/^settings list (system|global)$/))) {
    return Object.entries(settingsOf(p)[m[1]]).sort().forEach(([k, v]) => out(`${k}=${v}`));
  }
  // Brillo mínimo: en manual no baja de lowest (17 en el Nexus 6); en automático, hasta 1
  if ((m = c.match(/^dumpsys (power|display) \| grep -m1 (\w+)$/))) {
    const line = { power: `mScreenBrightnessSettingMinimum=${p.lowest ?? 1}`, display: 'mScreenBrightnessRangeMinimum=1' }[m[1]];
    return line.includes(m[2]) ? out(`  ${line}`) : undefined;
  }
  if ((m = c.match(/^settings get (system|global) (\S+)$/))) return out(settingsOf(p)[m[1]][m[2]] ?? 'null');
  if ((m = c.match(/^settings put (system|global) (\S+) (\S+)$/))) return void (settingsOf(p)[m[1]][m[2]] = m[3]);
  fail(`/system/bin/sh: ${c}: inaccessible or not found`);
}

function main(args) {
  let serial = null;
  if (args[0] === '-s') [, serial, ...args] = args;
  const [cmd, ...rest] = args;
  switch (cmd) {
    case 'start-server': return;
    case 'devices':
      // El Xiaomi «acepta» la depuración al cabo de unas consultas, como si alguien tocara su pantalla
      if (++st.polls > 3 && st.transports['192.168.1.52:5555']) st.transports['192.168.1.52:5555'][1] = 'device';
      out('List of devices attached');
      for (const [s, [, state]] of Object.entries(st.transports)) out(`${s}\t${state}`);
      return out('');
    case 'connect': {
      const host = rest[0].includes(':') ? rest[0] : `${rest[0]}:5555`;
      if (st.transports[host]) return out(`already connected to ${host}`);
      const p = Object.values(st.phones).find(x => x.ip === host.split(':')[0]);
      if (!p) fail(`failed to connect to '${host}': No route to host`);
      st.transports[host] = [p.sn, 'device'];
      return out(`connected to ${host}`);
    }
    case 'disconnect':
      delete st.transports[rest[0]];
      return out(`disconnected ${rest[0]}`);
    case 'pair': {
      // Por código de 6 cifras vale 123456; por QR, la clave del servicio anunciado
      const svc = st.mdns.find(s => s[2] === rest[0] && s[1].includes('pairing'));
      if (rest[1] !== (svc ? svc[3] : '123456')) fail('Failed: Wrong password or connection was dropped.');
      if (svc) {
        const ip = rest[0].split(':')[0];
        const p = Object.values(st.phones).find(x => x.ip === ip);
        st.mdns = st.mdns.filter(s => s !== svc).concat([[`adb-${p.sn}-Ab12Cd`, '_adb-tls-connect._tcp', `${ip}:40123`]]);
      }
      return out(`Successfully paired to ${rest[0]} [guid=adb-FAKE]`);
    }
    case 'mdns':
      out('List of discovered mdns services');
      for (const [name, type, addr] of st.mdns) out(`${name}\t${type}\t${addr}`);
      return;
    case 'tcpip':
      phoneOf(serial);
      return out(`restarting in TCP mode port: ${rest[0]}`);
    // Los altavoces de la demo son pestañas del navegador: http://localhost:8768/?id=<número de serie>.
    // El Motorola no deja, como el Nexus 6 de verdad (Android 7): el suyo va por la IP del PC en la wifi
    case 'reverse':
      if (phoneOf(serial).maker === 'motorola') fail('adb.exe: error: more than one device/emulator');
      return;
    case 'install': {
      const p = phoneOf(serial);
      // Si es un APK de verdad se lee su manifiesto; si no, se inventa un paquete
      let info;
      try { info = readApkInfo(rest.at(-1)); } catch { info = { pkg: 'com.example.nueva', versionCode: 1 }; }
      const old = p.apps[info.pkg];
      if (old && !old.removed && (old.versionCode || 1) > info.versionCode) fail('Failure [INSTALL_FAILED_VERSION_DOWNGRADE]');
      p.apps[info.pkg] = { ...old, versionCode: info.versionCode, removed: false };
      return out('Performing Streamed Install\nSuccess');
    }
    case 'pull':
      fail(`adb: error: failed to stat remote object '${rest[0]}': el adb de mentira no tiene APKs que copiar`);
    case 'uninstall': {
      const p = phoneOf(serial);
      if (!p.apps[rest[0]] || p.apps[rest[0]].system) fail('Failure [DELETE_FAILED_INTERNAL_ERROR]');
      delete p.apps[rest[0]];
      return out('Success');
    }
    case 'shell': {
      const p = phoneOf(serial);
      for (const c of rest.join(' ').split(';')) shell(p, c.trim());
      return;
    }
    case 'exec-out': {
      const p = phoneOf(serial);
      if (rest.join(' ') !== 'screencap -p') fail(`fake-adb: no sé simular «exec-out ${rest.join(' ')}»`);
      binary = fakePng(p);
      return;
    }
    default: fail(`fake-adb: no sé simular «${args.join(' ')}»`);
  }
}

try {
  main(process.argv.slice(2));
  fs.writeFileSync(STATE, JSON.stringify(st));
  process.stdout.write(binary || (lines.length ? lines.join('\n') + '\n' : ''));
} catch (e) {
  if (!(e instanceof Fail)) throw e;
  process.stdout.write(lines.join('\n'));
  process.stderr.write(`${e.message}\n`);
  process.exitCode = 1;
}
