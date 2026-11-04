// cert.js — el certificado del panel para https, hecho aquí mismo (sin openssl ni nada de fuera)
// El micrófono solo se deja usar en páginas seguras: https, o el propio PC (localhost). Para calibrar con el micro de un
// móvil, el panel también contesta por https con un certificado que firma él mismo. No lo avala nadie, así que el
// navegador avisa la primera vez; aceptado ese aviso, la página cuenta como segura. Se guarda en datos/ y se rehace solo
// si caduca o si el PC tiene una IP que no lleva (así no hay que volver a aceptarlo cada vez que arranca)
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const cfg = require('./config');

const FILE = 'panel-https.json';
const DAYS = 397; // lo más largo que aceptan los navegadores; un mes antes de caducar se hace otro

// ── DER: cada valor es etiqueta, longitud y contenido ──
function der(tag, ...parts) {
  const body = Buffer.concat(parts);
  let len = Buffer.from([body.length]);
  if (body.length >= 128) {
    const bytes = [];
    for (let n = body.length; n; n >>= 8) bytes.unshift(n & 255);
    len = Buffer.from([0x80 | bytes.length, ...bytes]);
  }
  return Buffer.concat([Buffer.from([tag]), len, body]);
}
const seq = (...parts) => der(0x30, ...parts);
const int = buf => der(0x02, buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf);
const bool = () => der(0x01, Buffer.from([0xff]));
const octets = buf => der(0x04, buf);
function oid(text) {
  const [a, b, ...rest] = text.split('.').map(Number);
  const out = [40 * a + b];
  for (let n of rest) {
    const part = [n & 127];
    while ((n = Math.floor(n / 128))) part.unshift((n & 127) | 128);
    out.push(...part);
  }
  return der(0x06, Buffer.from(out));
}
// UTCTime (AAMMDDhhmmssZ) hasta 2049, como piden los certificados
const time = d => der(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));

const ECDSA_SHA256 = '1.2.840.10045.4.3.2';

// Un certificado de servidor (no de autoridad) a nombre de «Android Mixer», válido para esos nombres e IP
function make(names, ips) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;
  const who = seq(der(0x31, seq(oid('2.5.4.3'), der(0x0c, Buffer.from('Android Mixer (panel)')))));
  const from = new Date(Date.now() - 86400000), to = new Date(Date.now() + DAYS * 86400000);
  const alt = seq(...names.map(n => der(0x82, Buffer.from(n))), ...ips.map(ip => der(0x87, Buffer.from(ip.split('.').map(Number)))));
  const tbs = seq(
    der(0xa0, int(Buffer.from([2]))), // versión 3
    int(serial),
    seq(oid(ECDSA_SHA256)),
    who,
    seq(time(from), time(to)),
    who,
    publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, seq(
      seq(oid('2.5.29.19'), bool(), octets(seq())), // no es autoridad
      seq(oid('2.5.29.15'), bool(), octets(der(0x03, Buffer.from([7, 0x80])))), // firma digital
      seq(oid('2.5.29.37'), octets(seq(oid('1.3.6.1.5.5.7.3.1')))), // para servidor web
      seq(oid('2.5.29.17'), octets(alt)),
    )),
  );
  const signature = crypto.sign('sha256', tbs, privateKey);
  const certDer = seq(tbs, seq(oid(ECDSA_SHA256)), der(0x03, Buffer.from([0]), signature));
  const pem = (label, buf) => `-----BEGIN ${label}-----\n${buf.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: pem('CERTIFICATE', certDer), names, ips };
}

// El de datos/ si sigue valiendo para estas IP; si no, uno nuevo que vale para estas y las de antes (por si el PC vuelve
// a una). changed: si es nuevo, que habrá que volver a aceptar en cada navegador
function get(ips) {
  const names = ['localhost', os.hostname()];
  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(cfg.dataPath(FILE), 'utf8'));
    const until = new Date(new crypto.X509Certificate(saved.cert).validTo).getTime();
    if (until - Date.now() > 30 * 86400000 && ips.every(ip => saved.ips.includes(ip))) return { ...saved, changed: false };
  } catch {}
  const fresh = make(names, [...new Set([...ips, ...(saved?.ips || [])])].slice(0, 20));
  fs.writeFileSync(cfg.dataPath(FILE), `${JSON.stringify(fresh, null, 2)}\n`);
  return { ...fresh, changed: true };
}

// La huella SHA-256, para reconocerlo en el aviso del navegador
const fingerprint = cert => new crypto.X509Certificate(cert).fingerprint256;

module.exports = { get, fingerprint };
