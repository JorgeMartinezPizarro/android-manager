// construir.js — hace el instalador de Windows (npm run instalador): descarga Node.js y scrcpy (que trae adb) en
// instalador\vendor\, comprueba que son los oficiales, dibuja el icono y compila mis-android.iss con Inno Setup
// (winget install JRSoftware.InnoSetup). Sale instalador\salida\MisAndroid-Setup.exe. Lo descargado se queda: la
// próxima vez solo compila
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ico } = require('./icono');

// Las copias fijas que lleva dentro el programa instalado, para no depender de lo que tenga cada PC. Para cambiar de
// versión: la versión, su dirección y su SHA-256 oficial (Node.js: SHASUMS256.txt de esa versión; scrcpy: SHA256SUMS.txt
// de su versión en GitHub)
const NODE = {
  version: '24.22.2',
  url: 'https://nodejs.org/dist/v24.22.2/win-x64/node.exe',
  sha256: '1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9',
};
const SCRCPY = {
  version: '5.0.1',
  url: 'https://github.com/Genymobile/scrcpy/releases/download/v5.0.1/scrcpy-win64-v5.0.1.zip',
  sha256: 'b12a2c4ee8be317422451fc7dcf8ee20a71b5ea7ef9ad73ddd825a25316227a5',
};

const VENDOR = path.join(__dirname, 'vendor');
const SALIDA = path.join(__dirname, 'salida');

async function download(item) {
  const res = await fetch(item.url);
  if (!res.ok) throw new Error(`No se ha podido descargar ${item.url} (${res.status})`);
  const data = Buffer.from(await res.arrayBuffer());
  const sum = crypto.createHash('sha256').update(data).digest('hex');
  if (sum !== item.sha256) throw new Error(`${item.url} no es el oficial: su SHA-256 es ${sum}, no ${item.sha256}`);
  return data;
}

// Cada copia en su carpeta con un .version: si ya está esa versión, no se vuelve a descargar
async function provide(name, item, put) {
  const dir = path.join(VENDOR, name), mark = path.join(dir, '.version');
  if (fs.existsSync(mark) && fs.readFileSync(mark, 'utf8') === item.version) return console.log(`${name} ${item.version}: ya está`);
  console.log(`Descargando ${name} ${item.version}…`);
  const data = await download(item);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  put(data, dir);
  fs.writeFileSync(mark, item.version);
}

// El zip de scrcpy trae una carpeta scrcpy-win64-vX dentro: su contenido va directo a vendor\scrcpy. Lo abre el tar de
// Windows (el de Git Bash no sabe de zips)
function unzipFlat(data, dir) {
  const zip = path.join(os.tmpdir(), `scrcpy-${process.pid}.zip`), tmp = `${dir}.tmp`;
  fs.writeFileSync(zip, data);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp);
  try {
    execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', tmp]);
    const [inner] = fs.readdirSync(tmp);
    for (const f of fs.readdirSync(path.join(tmp, inner))) fs.renameSync(path.join(tmp, inner, f), path.join(dir, f));
  } finally {
    fs.rmSync(zip, { force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function iscc() {
  const { ISCC, LOCALAPPDATA, ProgramFiles } = process.env;
  const found = [ISCC,
    LOCALAPPDATA && path.join(LOCALAPPDATA, 'Programs', 'Inno Setup 6', 'ISCC.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Inno Setup 6', 'ISCC.exe'),
    ProgramFiles && path.join(ProgramFiles, 'Inno Setup 6', 'ISCC.exe'),
  ].find(p => p && fs.existsSync(p));
  if (!found) throw new Error('Falta Inno Setup, con el que se hace el instalador: winget install JRSoftware.InnoSetup');
  return found;
}

async function main() {
  await provide('node', NODE, (data, dir) => fs.writeFileSync(path.join(dir, 'node.exe'), data));
  await provide('scrcpy', SCRCPY, unzipFlat);
  // El icono va dentro del .exe (y lo copia al instalar, para los accesos directos): en salida solo queda el instalador
  fs.writeFileSync(path.join(VENDOR, 'mis-android.ico'), ico());
  fs.mkdirSync(SALIDA, { recursive: true });
  fs.rmSync(path.join(SALIDA, 'mis-android.ico'), { force: true });
  // La versión es la fecha: 2026.11.2, y para Windows con la hora detrás (2026.11.2.1530)
  const d = new Date(), version = `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
  execFileSync(iscc(), ['/Qp', `/DVersion=${version}`, `/DVersionInfo=${version}.${d.getHours() * 100 + d.getMinutes()}`,
    path.join(__dirname, 'mis-android.iss')], { stdio: 'inherit' });
  const exe = path.join(SALIDA, 'MisAndroid-Setup.exe');
  console.log(`\nListo: ${exe} (${Math.round(fs.statSync(exe).size / 1e6)} MB, versión ${version})`);
}

main().catch(e => {
  console.error(e.message);
  process.exit(1);
});
