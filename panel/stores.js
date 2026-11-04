// stores.js — lo que el panel consulta en F-Droid y Google Play: nombre, icono y, de F-Droid, el APK más reciente
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { readApkInfo } = require('./apkinfo');
const cfg = require('./config');

const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Android Mixer)', 'Accept-Language': 'es' };
const get = (url, ms = 20000) => fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(ms) });
const decode = s => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

// Acepta el paquete tal cual o un enlace de la tienda (play.google.com/...?id=x, f-droid.org/packages/x)
function packageFrom(text) {
  const s = String(text || '').trim();
  return s.match(/[?&]id=([\w.]+)/)?.[1] || s.match(/f-droid\.org\/(?:[\w-]+\/)?packages\/([\w.]+)/)?.[1] || s;
}

async function dataUri(url) {
  const r = await get(url, 10000);
  const type = r.headers.get('content-type') || '';
  if (!r.ok || !type.startsWith('image/')) return undefined;
  const buf = Buffer.from(await r.arrayBuffer());
  return buf.length < 300_000 ? `data:${type};base64,${buf.toString('base64')}` : undefined;
}

// Nombre e icono desde la ficha pública; si la app no existe en esa tienda, error
async function details(source, pkg) {
  const url = source === 'fdroid'
    ? `https://f-droid.org/es/packages/${pkg}/`
    : `https://play.google.com/store/apps/details?id=${pkg}&hl=es`;
  const r = await get(url);
  if (r.status === 404) throw new Error(`${pkg} no está en ${source === 'fdroid' ? 'F-Droid' : 'Google Play'}`);
  if (!r.ok) return {}; // la tienda no contesta bien: se sigue sin nombre ni icono
  const html = await r.text();
  const meta = prop => html.match(new RegExp(`<meta[^>]+property="og:${prop}"[^>]+content="([^"]+)"`))?.[1];
  const name = decode(meta('title') || '').replace(/\s*\|\s*F-Droid.*$/, '').replace(/\s+[-–]\s+[^-–]*Google Play\s*$/, '').trim();
  const image = meta('image');
  // Los iconos de Play aceptan el tamaño tras «=»: se cambia el que traigan por uno pequeño
  const icon = image && await dataUri(source === 'play' ? `${image.replace(/=[^=/]*$/, '')}=s96` : image).catch(() => undefined);
  return { name: name || undefined, icon };
}

// Versión recomendada en F-Droid; se pregunta como mucho una vez por hora y app
const latest = new Map();
async function fdroidLatest(pkg) {
  const hit = latest.get(pkg);
  if (hit && Date.now() - hit.at < 3600_000) return hit.info;
  const r = await get(`https://f-droid.org/api/v1/packages/${pkg}`);
  if (r.status === 404) throw new Error(`${pkg} no está en F-Droid`);
  if (!r.ok) throw new Error(`F-Droid no responde (${r.status})`);
  const json = await r.json();
  const info = {
    versionCode: json.suggestedVersionCode,
    versionName: json.packages.find(p => p.versionCode === json.suggestedVersionCode)?.versionName || '',
  };
  latest.set(pkg, { at: Date.now(), info });
  return info;
}

// Descarga una vez cada versión a la caché, comprueba que es lo que dice ser y borra las anteriores
async function fdroidApk(dir, pkg, versionCode) {
  const file = path.join(dir, `${pkg}_${versionCode}.apk`);
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(dir, { recursive: true });
  const r = await get(`https://f-droid.org/repo/${pkg}_${versionCode}.apk`, 15 * 60_000);
  if (!r.ok) throw new Error(`No se pudo descargar de F-Droid (${r.status})`);
  const part = `${file}.part`;
  try {
    await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(part));
    const info = readApkInfo(part);
    if (info.pkg !== pkg || info.versionCode !== versionCode) throw new Error('El APK descargado de F-Droid no es el esperado');
  } catch (e) {
    fs.rmSync(part, { force: true });
    throw e;
  }
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith(`${pkg}_`) && /^\d+\.apk$/.test(f.slice(pkg.length + 1))) fs.rmSync(path.join(dir, f));
  }
  fs.renameSync(part, file);
  return file;
}

// Un APK desde cualquier enlace http o https (una release de GitHub, la web de un proyecto…), como mucho 500 MB.
// Que de verdad sea una app lo comprueba quien lo guarda, al leerlo
const MAX_APK = 500e6;
async function downloadApk(link, file) {
  let url;
  try { url = new URL(link); } catch { url = null; }
  if (!url || !['http:', 'https:'].includes(url.protocol)) throw new Error('Pega un enlace que empiece por http:// o https://');
  const r = await get(url.href, 15 * 60_000).catch(e => {
    throw new Error(`No se ha podido descargar de ${url.host}: ${e.cause?.code || e.cause?.message || e.message}`);
  });
  if (!r.ok) throw new Error(`No se ha podido descargar (${r.status})`);
  if (Number(r.headers.get('content-length')) > MAX_APK) throw new Error('Pesa demasiado para ser una app');
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(file));
  if (fs.statSync(file).size > MAX_APK) throw new Error('Pesa demasiado para ser una app');
}

// Nombre e icono de varias apps, de Google Play, para enseñarlas por su nombre y no por el paquete. Se guardan en
// nombres-apps.json, también las que no están en Play (null), para no volver a preguntar; si Play no contesta, se pregunta
// la próxima vez. Como mucho 40 nuevas por llamada, de 4 en 4
const NAMES = 'nombres-apps.json';
let known = null;
async function names(pkgs) {
  if (!known) {
    try { known = JSON.parse(fs.readFileSync(cfg.dataPath(NAMES), 'utf8')); } catch { known = {}; }
  }
  const missing = [...new Set(pkgs)].filter(p => !(p in known)).slice(0, 40);
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < missing.length) {
      const pkg = missing[next++];
      try {
        const info = await details('play', pkg);
        if (info.name) known[pkg] = { name: info.name, icon: info.icon };
      } catch (e) {
        if (/no está en/.test(e.message)) known[pkg] = null;
      }
    }
  }));
  if (missing.length) fs.writeFileSync(cfg.dataPath(NAMES), JSON.stringify(known));
  return Object.fromEntries(pkgs.filter(p => known[p]).map(p => [p, known[p]]));
}

module.exports = { packageFrom, details, fdroidLatest, fdroidApk, downloadApk, names };
