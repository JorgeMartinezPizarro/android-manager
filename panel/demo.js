// npm run demo — el panel con tres móviles de mentira, sin tocar los ficheros reales del proyecto
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-demo-'));
const keep = path.resolve(__dirname, '..', 'keep.txt');
if (fs.existsSync(keep)) fs.copyFileSync(keep, path.join(dir, 'keep.txt'));
fs.writeFileSync(path.join(dir, 'devices.txt'), '192.168.1.51\n');
fs.mkdirSync(path.join(dir, 'debloat'));
fs.writeFileSync(path.join(dir, 'debloat', 'samsung.txt'),
  'com.facebook.katana       # Facebook\ncom.facebook.appmanager   # Facebook App Manager\ncom.samsung.android.bixby.agent  # Bixby\n');

Object.assign(process.env, {
  ADB: path.join(__dirname, 'fake-adb.js'),
  PANEL_DATA: dir,
  FAKE_ADB_STATE: path.join(dir, 'adb.json'),
  PORT: process.env.PORT || '8766',
  MUSIC_PORT: process.env.MUSIC_PORT || '8768',
});

// Dos «canciones» cortas para probar la música: una escala y un arpegio
const { wav } = require('./music');
const tune = notes => t => {
  const i = Math.floor(t / 0.5), d = t - i * 0.5;
  return i < notes.length ? Math.sin(2 * Math.PI * 440 * 2 ** (notes[i] / 12) * t) * Math.min(1, d / 0.01, (0.5 - d) / 0.05) * 0.5 : 0;
};
fs.mkdirSync(path.join(dir, 'musica'));
fs.writeFileSync(path.join(dir, 'musica', 'Escala.wav'), wav(4.5, tune([0, 2, 4, 5, 7, 9, 11, 12])));
fs.writeFileSync(path.join(dir, 'musica', 'Arpegio.wav'), wav(3.5, tune([0, 4, 7, 12, 7, 4])));

console.log(`Demo con móviles simulados; sus ficheros están en ${dir}; altavoces en http://localhost:${process.env.MUSIC_PORT}/?id=<número de serie>`);
require('./server');
