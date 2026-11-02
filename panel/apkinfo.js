// apkinfo.js — paquete y versión de un APK, leídos de su AndroidManifest.xml binario sin herramientas externas
'use strict';
const fs = require('node:fs');
const zlib = require('node:zlib');

// Lee un fichero de dentro del zip sin cargar el APK entero en memoria
function readZipEntry(file, wanted) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const read = (pos, len) => {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      return buf;
    };
    // Fin del directorio central: está en los últimos 64 KB
    const tailLen = Math.min(size, 65557);
    const tail = read(size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('No es un APK válido (no es un zip)');
    const dir = read(tail.readUInt32LE(eocd + 16), tail.readUInt32LE(eocd + 12));
    for (let p = 0; p + 46 <= dir.length && dir.readUInt32LE(p) === 0x02014b50;) {
      const nameLen = dir.readUInt16LE(p + 28);
      if (dir.toString('utf8', p + 46, p + 46 + nameLen) === wanted) {
        const method = dir.readUInt16LE(p + 10), compSize = dir.readUInt32LE(p + 20), offset = dir.readUInt32LE(p + 42);
        const local = read(offset, 30);
        const data = read(offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28), compSize);
        return method === 8 ? zlib.inflateRawSync(data) : data;
      }
      p += 46 + nameLen + dir.readUInt16LE(p + 30) + dir.readUInt16LE(p + 32);
    }
    throw new Error(`No es un APK válido (falta ${wanted})`);
  } finally {
    fs.closeSync(fd);
  }
}

function readStringPool(buf, pos) {
  const count = buf.readUInt32LE(pos + 8), utf8 = (buf.readUInt32LE(pos + 16) & 0x100) !== 0;
  const strings = pos + buf.readUInt32LE(pos + 20), offsets = pos + buf.readUInt16LE(pos + 2);
  const out = [];
  for (let i = 0; i < count; i++) {
    let p = strings + buf.readUInt32LE(offsets + i * 4);
    if (utf8) {
      p += buf[p] & 0x80 ? 2 : 1; // longitud en caracteres, que no hace falta
      let len = buf[p++];
      if (len & 0x80) len = ((len & 0x7f) << 8) | buf[p++];
      out.push(buf.toString('utf8', p, p + len));
    } else {
      let len = buf.readUInt16LE(p);
      p += 2;
      if (len & 0x8000) { len = ((len & 0x7fff) << 16) | buf.readUInt16LE(p); p += 2; }
      out.push(buf.toString('utf16le', p, p + len * 2));
    }
  }
  return out;
}

// Atributos de android: por su id de recurso, por si el APK ha borrado los nombres
const ATTR_IDS = { 0x0101021b: 'versionCode', 0x0101021c: 'versionName' };

function readApkInfo(file) {
  const xml = readZipEntry(file, 'AndroidManifest.xml');
  if (xml.readUInt16LE(0) !== 0x0003) throw new Error('No es un APK válido (manifiesto ilegible)');
  let strings = [];
  const resIds = [];
  for (let pos = xml.readUInt16LE(2); pos + 8 <= xml.length;) {
    const type = xml.readUInt16LE(pos), headerSize = xml.readUInt16LE(pos + 2), size = xml.readUInt32LE(pos + 4);
    if (type === 0x0001) strings = readStringPool(xml, pos);
    else if (type === 0x0180) for (let i = pos + headerSize; i < pos + size; i += 4) resIds.push(xml.readUInt32LE(i));
    else if (type === 0x0102 && strings[xml.readUInt32LE(pos + 20)] === 'manifest') {
      const first = pos + 16 + xml.readUInt16LE(pos + 24), attrSize = xml.readUInt16LE(pos + 26);
      const attrs = {};
      for (let i = 0; i < xml.readUInt16LE(pos + 28); i++) {
        const a = first + i * attrSize;
        const name = xml.readUInt32LE(a + 4), raw = xml.readInt32LE(a + 8), dataType = xml[a + 15], data = xml.readUInt32LE(a + 16);
        attrs[ATTR_IDS[resIds[name]] || strings[name]] = raw >= 0 ? strings[raw] : dataType === 0x03 ? strings[data] : data;
      }
      if (!attrs.package) break;
      return {
        pkg: attrs.package,
        versionCode: Number(attrs.versionCode) || 0,
        versionName: typeof attrs.versionName === 'string' ? attrs.versionName : '',
      };
    }
    pos += size;
  }
  throw new Error('No es un APK válido (sin paquete en el manifiesto)');
}

module.exports = { readApkInfo };
