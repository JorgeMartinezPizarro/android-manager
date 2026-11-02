// limpieza.js — dejar los móviles lo más limpios posible: qué apps del sistema sobran (las que sugiere el panel y las que
// marques en la web), cuáles no hay que tocar y cuáles no se ofrecen nunca porque sin ellas el móvil o el altavoz dejan
// de funcionar. Lo que marcas se guarda en limpieza.json, que la primera vez parte de las listas de datos\debloat\ de antes
'use strict';
const fs = require('node:fs');
const cfg = require('./config');

const FILE = 'limpieza.json';
const PKG = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+$/;

// Apps de serie que se pueden quitar sin que el móvil deje de funcionar (se quitan solo para su usuario y vuelven con
// «Recuperar»), con lo que es cada una para decidir sin buscar el paquete
const SUGGESTED = {
  // Facebook, Microsoft y otras que vienen preinstaladas
  'com.facebook.appmanager': 'Facebook: gestor de la app preinstalada',
  'com.facebook.services': 'Facebook: servicios en segundo plano',
  'com.facebook.system': 'Facebook: instalador de la app',
  'com.facebook.katana': 'Facebook',
  'flipboard.boxer.app': 'Flipboard, las noticias de Samsung',
  'com.microsoft.skydrive': 'OneDrive',
  'com.microsoft.office.word': 'Word',
  'com.microsoft.office.excel': 'Excel',
  'com.microsoft.office.powerpoint': 'PowerPoint',
  'com.microsoft.office.onenote': 'OneNote',
  'com.netflix.mediaclient': 'Netflix',
  'com.netflix.partner.activation': 'Netflix: activación',
  'com.linkedin.android': 'LinkedIn',
  // Google: las que no hacen falta para que funcione el móvil
  'com.google.android.apps.tachyon': 'Google Duo / Meet',
  'com.google.android.music': 'Google Play Música, que ya no funciona',
  'com.google.android.videos': 'Google TV / Play Películas',
  'com.google.android.apps.books': 'Google Play Libros',
  'com.google.android.apps.magazines': 'Google Noticias',
  'com.google.android.apps.docs': 'Google Drive',
  'com.google.android.apps.docs.editors.docs': 'Documentos de Google',
  'com.google.android.apps.docs.editors.sheets': 'Hojas de cálculo de Google',
  'com.google.android.apps.docs.editors.slides': 'Presentaciones de Google',
  'com.google.android.apps.photos': 'Google Fotos',
  'com.google.android.apps.maps': 'Google Maps',
  'com.google.android.gm': 'Gmail',
  'com.google.android.keep': 'Google Keep',
  'com.google.android.youtube': 'YouTube',
  'com.google.android.apps.youtube.music': 'YouTube Music',
  'com.google.android.apps.podcasts': 'Google Podcasts',
  'com.google.android.apps.subscriptions.red': 'Google One',
  'com.google.android.apps.wellbeing': 'Bienestar digital',
  'com.google.android.apps.walletnfcrel': 'Google Wallet',
  'com.google.android.apps.googleassistant': 'Asistente de Google',
  'com.google.ar.lens': 'Google Lens',
  'com.google.ar.core': 'Realidad aumentada de Google (ARCore)',
  'com.google.android.feedback': 'Envío de comentarios a Google',
  'com.google.android.partnersetup': 'Configuración de socios de Google',
  // Samsung
  'com.samsung.android.game.gamehome': 'Game Launcher',
  'com.samsung.android.game.gametools': 'Herramientas de juegos',
  'com.enhance.gameservice': 'Servicio de juegos',
  'com.samsung.android.oneconnect': 'SmartThings',
  'com.samsung.android.themestore': 'Tienda de temas',
  'com.sec.android.app.sbrowser': 'Samsung Internet',
  'com.sec.android.app.shealth': 'Samsung Health',
  'com.sec.android.service.health': 'Samsung Health: servicio',
  'com.samsung.android.drivelink.stub': 'Modo coche',
  'com.sec.android.easyMover.Agent': 'Smart Switch: agente',
  'com.samsung.android.bixby.agent': 'Bixby Voice',
  'com.samsung.android.app.spage': 'Bixby Home',
  'com.samsung.android.visionintelligence': 'Bixby Vision',
  'com.samsung.android.app.tips': 'Consejos',
  'com.samsung.android.voc': 'Samsung Members',
  // Huawei
  'com.huawei.himovie.overseas': 'Huawei Vídeo',
  'com.huawei.hifolder': 'Carpetas online',
  'com.huawei.phoneservice': 'Asistencia (HiCare)',
  'com.huawei.appmarket': 'AppGallery',
  'com.huawei.hicloud': 'Huawei Cloud',
  'com.huawei.gameassistant': 'Asistente de juegos',
  'com.huawei.android.tips': 'Consejos',
  'com.huawei.browser': 'Navegador de Huawei',
  // OPPO, realme y OnePlus
  'com.oplus.statistics.rom': 'Estadísticas de uso, que envía a OPPO',
  'com.heytap.mcs': 'Avisos de OPPO (HeyTap)',
  'com.heytap.pictorial': 'Revista de la pantalla de bloqueo',
  'com.heytap.music': 'Música de OPPO',
  'com.coloros.video': 'Vídeos de OPPO',
  'com.oplus.games': 'Espacio de juegos',
  'com.coloros.childrenspace': 'Espacio infantil',
  'com.oppo.quicksearchbox': 'Búsqueda de OPPO',
  'com.heytap.browser': 'Navegador de OPPO',
  'com.heytap.market': 'Tienda de apps de OPPO',
  'com.heytap.cloud': 'Nube de OPPO',
  // Xiaomi
  'com.miui.analytics': 'Estadísticas de uso, que envía a Xiaomi',
  'com.miui.msa.global': 'Anuncios del sistema (MSA)',
  'com.mi.globalbrowser': 'Navegador Mi',
  'com.miui.videoplayer': 'Mi Vídeo',
  'com.miui.player': 'Mi Música',
  'com.xiaomi.mipicks': 'GetApps',
  'com.xiaomi.glgm': 'Juegos de Xiaomi',
};

// Nunca se ofrecen: el sistema, los ajustes, la tienda y sus servicios, el escritorio, el teclado, y Chrome con su
// WebView, en los que funciona la página de altavoz
const PROTECTED = new RegExp('^(android|com\\.android\\.(systemui|settings|phone|server\\.telecom|packageinstaller|'
  + 'permissioncontroller|shell|vending|chrome|bluetooth|nfc|providers\\..+)|com\\.google\\.android\\.(gms|gsf|'
  + 'packageinstaller|permissioncontroller)(\\..+)?)$|launcher|inputmethod|keyboard|honeyboard|webview', 'i');
const isProtected = pkg => PKG.test(pkg) ? PROTECTED.test(pkg) : true;

function load() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(cfg.dataPath(FILE), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`${FILE} está dañado: ${e.message}`);
    // La primera vez se parte de las listas de datos\debloat\ de antes, si las hay
    data = { marked: Object.values(cfg.debloatLists()).flat().map(entry => entry.value) };
  }
  const list = v => (Array.isArray(v) ? [...new Set(v.filter(p => PKG.test(p)))] : []);
  return { marked: list(data.marked), ignored: list(data.ignored) };
}

// mark: «remove», sobra (la marcas tú); «ignore», no tocar (ni se sugiere ni se quita en bloque); vacío, ni una cosa ni otra
function setMark(pkg, mark) {
  if (!PKG.test(pkg || '')) throw new Error('Nombre de paquete no válido');
  if (mark && !['remove', 'ignore'].includes(mark)) throw new Error('Marca no válida');
  if (mark === 'remove' && isProtected(pkg)) throw new Error('Esa app hace falta para que funcione el móvil');
  const { marked, ignored } = load();
  const without = l => l.filter(p => p !== pkg);
  const next = { marked: without(marked), ignored: without(ignored) };
  if (mark === 'remove') next.marked.push(pkg);
  if (mark === 'ignore') next.ignored.push(pkg);
  fs.writeFileSync(cfg.dataPath(FILE), `${JSON.stringify(next, null, 2)}\n`);
}

module.exports = { SUGGESTED, isProtected, load, setMark };
