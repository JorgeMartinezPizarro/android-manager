// sync.js — compara las apps comunes con lo que tiene cada móvil e instala lo que falta o está anticuado
'use strict';
const adb = require('./adb');
const catalog = require('./catalog');
const stores = require('./stores');

// Fallos por móvil, app y versión: se muestran en el panel y el modo automático no los reintenta
const failures = new Map();
const failKey = (d, pkg, versionCode) => `${d.serialno || d.serial}|${pkg}|${versionCode}`;
let last = null;

// Versión a la que debe estar cada app. Las de F-Droid preguntan por la última y la apuntan en el catálogo
async function targets(apps) {
  const out = {};
  await Promise.all(apps.map(async a => {
    out[a.pkg] = { versionCode: a.versionCode || 0, versionName: a.versionName || '' };
    if (a.source !== 'fdroid') return;
    try {
      const now = await stores.fdroidLatest(a.pkg);
      out[a.pkg] = now;
      if (now.versionCode !== a.versionCode) catalog.put({ ...a, ...now });
    } catch {} // sin conexión con F-Droid se usa la última versión conocida
  }));
  return out;
}

// pkg → { state: ok | update | missing | skip (este móvil no la necesita), have, error }
async function deviceStatus(d, apps, want) {
  const have = await adb.versions(d.serial, apps.map(a => a.pkg));
  return Object.fromEntries(apps.map(a => {
    const v = have[a.pkg];
    if (a.skip?.includes(d.serialno)) return [a.pkg, { state: 'skip', have: v ?? null }];
    const state = v === undefined ? 'missing' : v < want[a.pkg].versionCode ? 'update' : 'ok';
    const error = state === 'ok' ? undefined : failures.get(failKey(d, a.pkg, want[a.pkg].versionCode));
    return [a.pkg, { state, have: v ?? null, error }];
  }));
}

// Estado de todas las apps comunes en los móviles dados: serial → pkg → estado (o { error } si el móvil falla)
async function status(devices, apps) {
  const want = await targets(apps);
  const out = {};
  await Promise.all(devices.map(async d => {
    out[d.serial] = await deviceStatus(d, apps, want).catch(e => ({ error: e.message }));
  }));
  return out;
}

async function doSync({ pkg, serial, auto }) {
  // En automático no se abre Google Play en los móviles: eso solo cuando lo pides tú
  const apps = catalog.load().apps.filter(a => (!pkg || a.pkg === pkg) && !(auto && a.source === 'play'));
  const devices = (await adb.devices()).filter(d => d.state === 'device' && !d.error && (!serial || d.serial === serial));
  const want = await targets(apps);
  const files = new Map(); // cada APK de F-Droid se descarga una vez aunque lo pidan varios móviles
  const fileFor = a => {
    if (!files.has(a.pkg)) {
      files.set(a.pkg, a.source === 'fdroid'
        ? stores.fdroidApk(catalog.fdroidDir(), a.pkg, want[a.pkg].versionCode)
        : Promise.resolve(catalog.apkFile(a.pkg)));
    }
    return files.get(a.pkg);
  };
  const results = [];
  await Promise.all(devices.map(async d => {
    let st;
    try { st = await deviceStatus(d, apps, want); } catch (e) {
      results.push({ serial: d.serial, ok: false, message: e.message });
      return;
    }
    for (const a of apps) { // de una en una por móvil; los móviles van en paralelo
      const { state } = st[a.pkg];
      const key = failKey(d, a.pkg, want[a.pkg].versionCode);
      if (state === 'ok' || state === 'skip' || (auto && failures.has(key))) continue;
      try {
        const message = a.source === 'play'
          ? await adb.openStore(d.serial, a.pkg)
          : (await adb.install(d.serial, await fileFor(a)), state === 'update' ? 'Actualizada' : 'Instalada');
        failures.delete(key);
        results.push({ serial: d.serial, pkg: a.pkg, ok: true, message });
      } catch (e) {
        failures.set(key, e.message);
        results.push({ serial: d.serial, pkg: a.pkg, ok: false, message: e.message });
      }
    }
  }));
  last = { at: Date.now(), auto: Boolean(auto), ok: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length };
  return results;
}

// Las sincronizaciones van en fila: nunca dos instalando a la vez
let queue = Promise.resolve();
function run(opts = {}) {
  const job = queue.then(() => doSync(opts));
  queue = job.catch(() => {});
  return job;
}

module.exports = { status, run, last: () => last };
