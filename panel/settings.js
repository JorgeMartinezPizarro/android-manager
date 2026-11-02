// settings.js — los ajustes comunes a todos los móviles: modo oscuro, pantalla, animaciones y filtro de internet.
// El perfil que se elige en el panel se guarda en settings.json; lo que no está en el perfil no se toca.
'use strict';
const fs = require('node:fs');
const cfg = require('./config');
const adb = require('./adb');

const FILE = 'settings.json';
const ANDROID = { 28: '9', 29: '10' }; // nivel de API mínimo → versión de Android que se le dice al usuario
const num = (v, fallback) => (v == null || v === '' || v === 'null' ? fallback : Number(v));
const YES_NO = [['1', 'Sí'], ['0', 'No']];

function duration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return String(ms);
  if (n >= 86_400_000) return 'Nunca';
  return n < 60_000 ? `${Math.round(n / 1000)} s` : n < 3_600_000 ? `${Math.round(n / 60_000)} min` : `${Math.round(n / 3_600_000)} h`;
}

// Para las escalas (letra, animaciones): la opción que coincide, o el número tal cual
const scale = (options, v) => {
  const n = num(v, 1);
  return options.find(([o]) => Math.abs(Number(o) - n) < 0.01)?.[0] ?? String(n);
};

const FONT = [['0.85', 'Pequeña'], ['1', 'Normal'], ['1.15', 'Grande'], ['1.3', 'Muy grande']];
const ANIMATIONS = [['1', 'Normales'], ['0.5', 'Rápidas'], ['0', 'Sin animaciones']];
const ANIMATION_KEYS = ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale'];

// Servidores de DNS privado (DNS sobre TLS) que filtran
const DNS = { ads: 'dns.adguard-dns.com', family: 'family.adguard-dns.com', adult: 'family.cloudflare-dns.com' };

// read: su valor a partir de adb.readSettings · write: las órdenes que lo cambian · other: cómo mostrar un valor fuera de la lista
const SETTINGS = [
  {
    key: 'dark', name: 'Modo oscuro', minSdk: 29,
    options: [['no', 'Claro'], ['yes', 'Oscuro']],
    read: s => s.night,
    other: v => ({ auto: 'Automático', custom: 'Programado' })[v] || v,
    write: v => [`cmd uimode night ${v}`],
  },
  {
    key: 'brightness', name: 'Brillo automático', options: YES_NO,
    read: s => s.system.screen_brightness_mode,
    write: v => [`settings put system screen_brightness_mode ${v}`],
  },
  {
    key: 'timeout', name: 'Apagar la pantalla tras',
    options: [15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000].map(ms => [String(ms), duration(ms)]),
    read: s => s.system.screen_off_timeout,
    other: duration,
    write: v => [`settings put system screen_off_timeout ${v}`],
  },
  {
    key: 'font', name: 'Tamaño de letra', options: FONT,
    read: s => scale(FONT, s.system.font_scale),
    other: v => `×${v}`,
    write: v => [`settings put system font_scale ${v}`],
  },
  {
    key: 'rotation', name: 'Girar la pantalla sola', options: YES_NO,
    read: s => s.system.accelerometer_rotation,
    write: v => [`settings put system accelerometer_rotation ${v}`],
  },
  {
    key: 'stayOn', name: 'Encendida mientras carga', options: YES_NO,
    hint: 'La pantalla no se apaga mientras está enchufado: para usarlo de reloj o marco de fotos.',
    read: s => (num(s.global.stay_on_while_plugged_in, 0) > 0 ? '1' : '0'),
    write: v => [`settings put global stay_on_while_plugged_in ${v === '1' ? 7 : 0}`], // 7: con cargador, USB o inalámbrica
  },
  {
    key: 'animations', name: 'Animaciones', options: ANIMATIONS,
    hint: 'Sin animaciones, los móviles viejos parecen más rápidos.',
    read: s => scale(ANIMATIONS, s.global.window_animation_scale),
    other: v => `×${v}`,
    write: v => ANIMATION_KEYS.map(k => `settings put global ${k} ${v}`),
  },
  {
    key: 'dns', name: 'Filtro de internet', minSdk: 28,
    options: [['auto', 'Sin filtro'], ['ads', 'Sin anuncios'], ['family', 'Familiar'], ['adult', 'Sin adultos']],
    hint: 'DNS privado: filtra en todo el móvil, también dentro de las apps. «Sin anuncios» y «Familiar» (sin anuncios ni webs para adultos) usan AdGuard DNS; «Sin adultos», Cloudflare.',
    read: s => {
      const mode = s.global.private_dns_mode;
      if (mode === 'off') return 'off';
      if (mode !== 'hostname') return 'auto';
      const host = s.global.private_dns_specifier || '';
      return Object.keys(DNS).find(k => DNS[k] === host) || host;
    },
    other: v => (v === 'off' ? 'Desactivado' : v),
    write: v => (v === 'auto' ? ['settings put global private_dns_mode opportunistic']
      : [`settings put global private_dns_specifier ${DNS[v]}`, 'settings put global private_dns_mode hostname']),
  },
];

const byKey = new Map(SETTINGS.map(s => [s.key, s]));
const valid = (key, value) => byKey.get(key)?.options.some(([v]) => v === value);
const text = (s, v) => s.options.find(([o]) => o === v)?.[1] ?? (s.other ? s.other(v) : v);

// Lo que necesita la página: nombre, explicación, opciones y desde qué Android existe
const definitions = () => SETTINGS.map(({ key, name, hint, minSdk, options }) => ({ key, name, hint, options, android: ANDROID[minSdk] }));

function profile() {
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(cfg.dataPath(FILE), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`${FILE} está dañado: ${e.message}`);
  }
  return Object.fromEntries(Object.entries(data).filter(([k, v]) => valid(k, v)));
}

// value vacío: el ajuste sale del perfil y deja de tocarse
function setProfile(key, value) {
  if (!byKey.has(key)) throw new Error('Ajuste desconocido');
  if (value && !valid(key, value)) throw new Error('Valor no válido');
  const p = profile();
  if (value) p[key] = value;
  else delete p[key];
  fs.writeFileSync(cfg.dataPath(FILE), `${JSON.stringify(p, null, 2)}\n`);
}

// Los ajustes de un móvil: { clave: { value, text } }, o { na } si su Android no lo tiene
async function read(serial) {
  const s = await adb.readSettings(serial);
  return Object.fromEntries(SETTINGS.map(def => {
    if (s.sdk < (def.minSdk || 0)) return [def.key, { na: `Necesita Android ${ANDROID[def.minSdk]}` }];
    const value = def.read(s);
    return [def.key, value == null ? {} : { value, text: text(def, value) }];
  }));
}

// Cambia en el móvil lo que no coincide con el perfil (todo, o solo «key») y comprueba que lo ha aceptado
async function apply(serial, key) {
  const want = profile();
  const differs = values => SETTINGS.filter(d => (!key || d.key === key) && want[d.key] && !values[d.key].na && values[d.key].value !== want[d.key]);
  const todo = differs(await read(serial));
  if (!todo.length) return 'Ya estaba como el perfil';
  await adb.writeSettings(serial, todo.flatMap(d => d.write(want[d.key])));
  const refused = differs(await read(serial));
  if (refused.length) throw new Error(`El móvil no ha aceptado: ${refused.map(d => d.name.toLowerCase()).join(', ')}`);
  return todo.length === 1 ? `${todo[0].name}: ${text(todo[0], want[todo[0].key])}` : `${todo.length} ajustes cambiados`;
}

module.exports = { definitions, profile, setProfile, read, apply };
