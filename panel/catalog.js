// catalog.js — las apps comunes a todos los móviles. Manda apps.json; keep.txt se reescribe desde aquí.
//   source: 'apk'    APK subido por ti (apks/<paquete>.apk)
//           'fdroid' la última versión de F-Droid, que el panel descarga
//           'play'   Google Play: el panel abre la ficha en el móvil y allí se pulsa Instalar
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('./config');
const { readApkInfo } = require('./apkinfo');

const FILE = 'apps.json';
const apkFile = pkg => cfg.dataPath(path.join('apks', `${pkg}.apk`));
const fdroidDir = () => cfg.dataPath(path.join('apks', 'f-droid'));

function save(data) {
  data.apps.sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
  fs.writeFileSync(cfg.dataPath(FILE), `${JSON.stringify(data, null, 2)}\n`);
  cfg.writeKeep(data.apps);
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(cfg.dataPath(FILE), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`${FILE} está dañado: ${e.message}`);
  }
  // La primera vez se parte de keep.txt (guardando una copia, porque se va a reescribir);
  // del comentario, lo que va antes de la primera coma es el nombre
  const keep = cfg.dataPath('keep.txt');
  if (fs.existsSync(keep) && !fs.existsSync(`${keep}.bak`)) fs.copyFileSync(keep, `${keep}.bak`);
  const data = {
    auto: false,
    apps: [...cfg.readKeep()].map(([pkg, note]) => ({ pkg, name: note.split(/[,;]/)[0].trim() || pkg, source: 'play' })),
  };
  save(data);
  return data;
}

// Añade o sustituye una app; si no se da nombre o icono se conservan los que tuviera
// (fallbackName solo se usa para una app nueva sin nombre, como el nombre del archivo subido)
function put(entry) {
  const data = load();
  const old = data.apps.find(a => a.pkg === entry.pkg) || {};
  const app = {
    pkg: entry.pkg,
    name: entry.name || old.name || entry.fallbackName || entry.pkg,
    source: entry.source,
    icon: entry.icon || old.icon,
    versionCode: entry.source === 'play' ? undefined : entry.versionCode,
    versionName: entry.source === 'play' ? undefined : entry.versionName,
    url: entry.url, // de dónde se descargó el APK, si vino de un enlace
    skip: old.skip,
  };
  if (old.source === 'apk' && app.source !== 'apk') fs.rmSync(apkFile(app.pkg), { force: true });
  data.apps = data.apps.filter(a => a.pkg !== app.pkg).concat(app);
  save(data);
  return app;
}

// Guarda un APK (subido, copiado de un móvil o descargado de un enlace) como origen de su app
function putApk(file, name, fallbackName, url) {
  const info = readApkInfo(file);
  fs.mkdirSync(path.dirname(apkFile(info.pkg)), { recursive: true });
  fs.copyFileSync(file, apkFile(info.pkg));
  return put({ ...info, name, fallbackName, url, source: 'apk' });
}

function rename(pkg, name) {
  const data = load();
  const app = data.apps.find(a => a.pkg === pkg);
  if (!app) throw new Error('Esa app no está en la lista');
  app.name = String(name || '').trim().slice(0, 60) || pkg;
  save(data);
}

// skip: los móviles (por número de serie) que no la necesitan; ahí ni se instala ni se actualiza. Los demás, y los que
// lleguen nuevos, sí la llevan
function setWanted(pkg, serialno, on) {
  const data = load();
  const app = data.apps.find(a => a.pkg === pkg);
  if (!app) throw new Error('Esa app no está en la lista');
  const skip = new Set(app.skip || []);
  if (on) skip.delete(serialno);
  else skip.add(serialno);
  app.skip = skip.size ? [...skip].sort() : undefined;
  save(data);
}

function remove(pkg) {
  const data = load();
  data.apps = data.apps.filter(a => a.pkg !== pkg);
  save(data);
  fs.rmSync(apkFile(pkg), { force: true });
}

function setAuto(on) {
  const data = load();
  data.auto = Boolean(on);
  save(data);
}

module.exports = { load, put, putApk, rename, setWanted, remove, setAuto, apkFile, fdroidDir };
