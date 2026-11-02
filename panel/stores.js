// stores.js — lo que el panel consulta en F-Droid y Google Play: nombre, icono y, de F-Droid, el APK más reciente
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { readApkInfo } = require('./apkinfo');

const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Mis Android)', 'Accept-Language': 'es' };
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

module.exports = { packageFrom, details, fdroidLatest, fdroidApk };
