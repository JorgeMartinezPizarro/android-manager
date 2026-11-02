// config.js — los ficheros de texto que el panel comparte con droids.sh: uno por línea, # comenta
'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Todo lo tuyo (móviles, apps, ajustes, canciones) va en datos/, que git no ve. Lo que las versiones anteriores dejaban
// junto al proyecto se mueve ahí al arrancar
const ROOT = path.resolve(__dirname, '..');
const DATA = process.env.PANEL_DATA || path.join(ROOT, 'datos');
const OWN = ['devices.txt', 'names.txt', 'apps.json', 'settings.json', 'music.json', 'keep.txt', 'keep.txt.bak', 'apks', 'musica', 'debloat'];
fs.mkdirSync(DATA, { recursive: true });
if (!process.env.PANEL_DATA) {
  for (const name of OWN) {
    const from = path.join(ROOT, name), to = path.join(DATA, name);
    try {
      if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to);
    } catch (e) {
      console.error(`No he podido mover ${name} a datos/ (${e.code}): muévelo tú con el panel cerrado`);
    }
  }
}
const file = name => path.join(DATA, name);

function readLines(name) {
  try { return fs.readFileSync(file(name), 'utf8').split(/\r?\n/); } catch { return []; }
}

function parse(line) {
  const i = line.indexOf('#');
  return { value: (i < 0 ? line : line.slice(0, i)).trim(), note: i < 0 ? '' : line.slice(i + 1).trim() };
}

const readList = name => readLines(name).map(parse).filter(e => e.value);

// Quita las líneas cuyo valor cumpla «drop» y, si se pasa, añade «line» al final; el resto queda igual
function edit(name, drop, line) {
  const lines = readLines(name).filter(l => !drop(parse(l).value));
  while (lines.length && lines.at(-1) === '') lines.pop();
  if (line) lines.push(line);
  fs.writeFileSync(file(name), lines.join('\n') + '\n');
}

// keep.txt: apps de terceros que se conservan. Ahora manda el catálogo (apps.json) y keep.txt
// se reescribe desde él para que «droids.sh prune» siga sabiendo qué no quitar
const readKeep = () => new Map(readList('keep.txt').map(e => [e.value, e.note]));

function writeKeep(apps) {
  const lines = apps.map(a => `${a.pkg.padEnd(28)} # ${a.name.replace(/[\r\n]/g, ' ')}`);
  fs.writeFileSync(file('keep.txt'),
    ['# Apps comunes: se editan en el panel (pestaña Apps); «./droids.sh prune --yes» quita las demás', ...lines].join('\n') + '\n');
}

// names.txt: «número de serie  nombre» para reconocer cada móvil
const names = () => new Map(readList('names.txt').map(e => {
  const [id, ...name] = e.value.split(/\s+/);
  return [id, name.join(' ')];
}));

function setName(id, name) {
  name = String(name || '').replace(/[#\r\n]/g, '').trim().slice(0, 40);
  edit('names.txt', v => v.split(/\s+/)[0] === id, name && `${id}  ${name}`);
}

// devices.txt: IPs a las que reconectar por wifi. droids.sh les pone siempre :5555,
// así que solo se guardan las conexiones a ese puerto
const savedIps = () => readList('devices.txt').map(e => e.value);

function saveIp(host) {
  const [ip, port = '5555'] = host.split(':');
  if (port !== '5555' || savedIps().includes(ip)) return;
  edit('devices.txt', () => false, ip);
}

// debloat/<fabricante>.txt: apps del sistema que se quitan en bloque
function debloatLists() {
  let files = [];
  try { files = fs.readdirSync(file('debloat')).filter(f => f.endsWith('.txt')); } catch {}
  return Object.fromEntries(files.map(f => [path.basename(f, '.txt').toLowerCase(), readList(path.join('debloat', f))]));
}

module.exports = { dataPath: file, readKeep, writeKeep, names, setName, savedIps, saveIp, debloatLists };
