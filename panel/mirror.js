// mirror.js — «Ver pantalla»: abre scrcpy, que muestra en el PC la pantalla del móvil y deja manejarlo con ratón y teclado
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const adb = require('./adb');

const EXE = process.platform === 'win32' ? 'scrcpy.exe' : 'scrcpy';
const MISSING = 'Falta scrcpy, el programa que muestra la pantalla. Instálalo desde una terminal con «winget install Genymobile.scrcpy» y vuelve a pulsar.';

// winget lo descomprime en su carpeta de paquetes, dentro de una subcarpeta con la versión
function wingetScrcpy(localAppData) {
  const packages = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
  try {
    return fs.readdirSync(packages).filter(d => d.startsWith('Genymobile.scrcpy')).flatMap(d => {
      const dir = path.join(packages, d);
      return [dir, ...fs.readdirSync(dir).map(sub => path.join(dir, sub))].map(p => path.join(p, EXE));
    });
  } catch { return []; }
}

function scrcpyPath() {
  const { SCRCPY, LOCALAPPDATA, PATH = '' } = process.env;
  const candidates = [
    SCRCPY,
    LOCALAPPDATA && path.join(LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', EXE),
    ...(LOCALAPPDATA ? wingetScrcpy(LOCALAPPDATA) : []),
    ...PATH.split(path.delimiter).filter(Boolean).map(dir => path.join(dir, EXE)),
  ];
  return candidates.find(c => c && fs.existsSync(c)) || null;
}

// scrcpy necesita Android 5: en uno más viejo su servidor revienta en el móvil («Segmentation fault»). Ahí la pantalla
// se ve en el propio panel, a base de capturas ({ viewer: true })
const MIN_SDK = 21;

// Si scrcpy no se cierra enseguida es que va bien (por wifi la ventana tarda 5-10 s en salir);
// si se cierra, su primer error dice por qué
async function open(serial, title) {
  if (await adb.sdkOf(serial) < MIN_SDK) return { viewer: true };
  const bin = scrcpyPath();
  if (!bin) throw new Error(MISSING);
  const adbBin = adb.adbPath();
  if (adbBin?.endsWith('.js')) throw new Error('En la demo no hay pantallas que ver: los móviles son de mentira');
  // scrcpy trae su propio adb; si es de otra versión reinicia el del panel y se caen las conexiones por wifi.
  // detached: la ventana va por su cuenta, sin consola negra, y sigue abierta aunque se cierre el panel
  const child = spawn(bin, ['-s', serial, '--window-title', title || serial, '--no-audio', '--max-size', '1600'], {
    stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ADB: adbBin }, detached: true,
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.unref();
      resolve({ message: 'En unos segundos se abre su pantalla en una ventana aparte: con el ratón lo manejas como si la tocaras' });
    }, 2500);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('exit', code => {
      clearTimeout(timer);
      const why = stderr.replace(/\r/g, '').split('\n').find(l => l.startsWith('ERROR:'))?.replace(/^ERROR:\s*|:\s*$/g, '');
      reject(new Error(/Could not find ADB device/.test(why) ? 'El móvil ya no está conectado: mira en Dispositivos'
        : why || `scrcpy se ha cerrado (código ${code})`));
    });
  });
}

module.exports = { open, scrcpyPath };
