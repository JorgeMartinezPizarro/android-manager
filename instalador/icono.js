// icono.js — el icono de Mis Android: un móvil con una nota musical, en blanco sobre un cuadrado verde redondeado. Se
// dibuja aquí, para no guardar binarios en git; sale un .ico con varios tamaños, cada uno en PNG
'use strict';
const zlib = require('node:zlib');

// Distancia con signo a un rectángulo redondeado (centro cx, cy; mitades w, h; radio r) y a un círculo: negativa, dentro
function box(x, y, cx, cy, w, h, r) {
  const qx = Math.abs(x - cx) - (w - r), qy = Math.abs(y - cy) - (h - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
const circle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r;

const WHITE = [255, 255, 255];
const TOP = [43, 212, 124], BOTTOM = [15, 123, 82]; // el verde del panel, más claro arriba

// El color de un punto del cuadrado (x, y de 0 a 1), o null si queda fuera del fondo
function color(x, y) {
  if (box(x, y, 0.5, 0.5, 0.5, 0.5, 0.22) > 0) return null;
  const phone = box(x, y, 0.5, 0.5, 0.22, 0.34, 0.07) <= 0 && box(x, y, 0.5, 0.5, 0.165, 0.285, 0.03) > 0;
  const note = circle(x, y, 0.465, 0.58, 0.065) <= 0 || box(x, y, 0.515, 0.44, 0.018, 0.14, 0.005) <= 0
    || box(x, y, 0.565, 0.33, 0.05, 0.03, 0.01) <= 0;
  return phone || note ? WHITE : TOP.map((c, i) => Math.round(c + (BOTTOM[i] - c) * y));
}

// Cada píxel, con 4×4 muestras para que los bordes salgan suaves
function draw(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const n = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const sum = [0, 0, 0];
      let hits = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const c = color((px + (sx + 0.5) / n) / size, (py + (sy + 0.5) / n) / size);
          if (!c) continue;
          hits++;
          c.forEach((v, i) => { sum[i] += v; });
        }
      }
      const o = (py * size + px) * 4;
      if (hits) sum.forEach((v, i) => { rgba[o + i] = Math.round(v / hits); });
      rgba[o + 3] = Math.round(hits / (n * n) * 255);
    }
  }
  return rgba;
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = buf => (buf.reduce((c, b) => CRC[(c ^ b) & 0xff] ^ (c >>> 8), 0xffffffff) ^ 0xffffffff) >>> 0;

function png(size) {
  const rgba = draw(size), raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]), out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(size, 0);
  head.writeUInt32BE(size, 4);
  head[8] = 8; // 8 bits por canal
  head[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head),
    chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// El .ico: una cabecera con un hueco por tamaño y detrás cada PNG (256 se apunta como 0)
function ico(sizes = [16, 24, 32, 48, 64, 128, 256]) {
  const images = sizes.map(png), head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i;
    head[e] = head[e + 1] = s % 256;
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(images[i].length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += images[i].length;
  });
  return Buffer.concat([head, ...images]);
}

module.exports = { ico, png };
