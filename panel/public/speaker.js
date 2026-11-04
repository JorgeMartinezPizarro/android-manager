'use strict';
// Página de altavoz: el panel la abre en Chrome en cada móvil. Ajusta su reloj con el del PC y empieza cada canción a la
// hora que diga el PC con el audio del navegador, que sabe arrancar un sonido en un instante exacto.
// Escrito también para los Chrome viejos de Android 7. Con ?silencio hace todo igual, pero sin que se oiga.

(function () {
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const ID = params.get('id') || '';
  const SILENT = params.has('silencio');
  const JUMP = 0.03; // s de desfase con el PC a partir de los que se recoloca la canción de golpe; por debajo, sin saltos
  const HORIZON = 10; // s en los que se quiere absorber un desfase pequeño, acelerando o frenando
  const LEARN = 400; // s²: lo despacio que aprende cuánto adelanta o atrasa de por sí el reloj del audio de este móvil
  const MAX_RATE = 0.005; // como mucho un 0,5 % más rápido o más lento: el tono no cambia de forma que se note
  const AHEAD = 45; // s antes de que acabe una canción en los que se descomprime la siguiente (ya descargada) para tenerla lista
  const SIMULATED = (Number(params.get('deriva')) || 0) / 1e6; // ?deriva=<ppm>: para probar, como si el audio se fuera desviando
  // Modo ligero, para los Android 4 (poca RAM y un procesador lento): la canción no se descomprime entera en
  // memoria (unos 80 MB, y otro tanto mientras se convierte), que allí acababa con Chrome; la va leyendo un <audio> poco a
  // poco. ?ligero lo fuerza y ?ligero=0 lo quita, para probar
  const LIGHT = params.has('ligero') ? params.get('ligero') !== '0' : /Android [1-4]\./.test(navigator.userAgent);
  const LIGHT_JUMP = 0.25; // s de desfase a partir de los que el modo ligero vuelve a arrancar donde toca; por debajo, sin saltos
  const LIGHT_RATE = 0.01; // y para absorber uno pequeño, como mucho un 1 % más rápido o más lento (el <audio> mantiene el tono)
  const SETTLE = 2000; // ms tras arrancar en los que su currentTime aún no dice por dónde suena de verdad
  const BORN = performance.now();
  const PAGE = Date.now(); // para el PC: si hay varias pestañas de altavoz en el móvil, cuenta la más nueva
  const clamp = (x, max) => Math.max(-max, Math.min(max, x));
  // Recta por unos puntos {x (ms), y}: su valor en cada x y lo que se separan de ella (rms). La pendiente, solo si los puntos
  // abarcan al menos minSpan ms (con menos, lo que mediría es el ruido) y como mucho maxSlope
  function fitLine(points, minSpan, maxSlope) {
    const mean = f => points.reduce((sum, p) => sum + f(p), 0) / points.length;
    const x0 = mean(p => p.x), y0 = mean(p => p.y), spread = mean(p => (p.x - x0) ** 2);
    const slope = spread > minSpan ** 2 / 12 ? clamp(mean(p => (p.x - x0) * (p.y - y0)) / spread, maxSlope) : 0;
    const at = x => y0 + (x - x0) * slope;
    return { at, slope, rms: Math.sqrt(mean(p => (p.y - at(p.x)) ** 2)) };
  }
  const PAUSE = 'M6 5h4v14H6zm8 0h4v14h-4z', PLAY = 'M8 5v14l11-7z';

  let state = null; // lo último que ha dicho el PC
  let linked = false;
  let replaced = false; // el PC ha dicho que hay otra pestaña de altavoz más nueva
  let ctx = null, gain = null;
  let track = null; // { song, buffer }: la canción ya cargada
  let loading = null, failed = null, error = '';
  // La siguiente que va a sonar, preparándose: se descarga en cuanto suena la actual, pero se descomprime solo al final de
  // esta (descomprimida ocupa mucho y los móviles viejos tienen poca memoria). data y decoding son promesas; ready, el audio
  let ahead = null; // { song, data, decoding, ready }
  // Lo que está sonando: en el instante at del reloj del audio iba por pos (s de la canción) y avanza a rate s por s;
  // target es la hora del PC (más el retraso) a la que empezó, y errors, los desfases medidos en los últimos 10 s
  let current = null;
  let drift = 0; // lo que hay que acelerar (o frenar, si es negativo) de base para seguir al PC; se va aprendiendo
  let offBy = null; // desfase con el PC (s, mediana de los últimos 10 s): positivo, va adelantado
  let fixes = 0; // veces que se ha recolocado de golpe una canción ya empezada
  let phase = '';

  // ── Reloj: la diferencia con el PC, de las medidas más rápidas de los últimos 60 s (las menos deformadas por la red). Los
  // relojes se van separando poco a poco: con una recta que pase por esas medidas se sigue esa deriva sin saltos ──

  const clock = { fit: null, rtt: null, ok: false, samples: [] };
  const offsetAt = t => (clock.fit ? clock.fit.at(t) : 0); // ms que hay que sumar a la hora de aquí para tener la del PC

  async function measure() {
    const t0 = performance.now();
    const { t } = await (await fetch('/clock', { cache: 'no-store' })).json();
    const t1 = performance.now();
    return { rtt: t1 - t0, offset: t - (performance.timeOrigin + (t0 + t1) / 2), at: t1 };
  }

  async function syncClock(n) {
    for (let i = 0; i < n; i++) {
      try { clock.samples.push(await measure()); } catch (e) { break; }
    }
    clock.samples = clock.samples.filter(s => performance.now() - s.at < 60000).slice(-40);
    if (!clock.samples.length) return;
    const best = clock.samples.slice().sort((a, b) => a.rtt - b.rtt).slice(0, Math.max(3, Math.ceil(clock.samples.length / 3)));
    // Pendiente con medidas de al menos 20 s, y como mucho 1000 ppm
    const fit = fitLine(best.map(s => ({ x: s.at, y: s.offset })), 20000, 0.001);
    Object.assign(clock, { fit, rtt: Math.round(best[0].rtt), ok: true });
  }

  // ── Audio ──

  function audio() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
      gain = ctx.createGain();
      gain.gain.value = SILENT ? 0 : 1;
      gain.connect(ctx.destination);
      ctx.onstatechange = update;
    }
    return ctx;
  }

  async function download(song) {
    const res = await fetch('/song/' + encodeURIComponent(song));
    if (!res.ok) throw new Error('el PC no la encuentra');
    return res.arrayBuffer();
  }

  // Si ya estaba preparada, se usa tal cual (al momento) o lo que lleve hecho; si su preparación falló, se carga de nuevo
  async function load(song) {
    const pre = ahead && ahead.song === song ? ahead : null;
    ahead = null;
    error = '';
    stopSound();
    if (LIGHT) return stream(song, pre);
    if (pre && pre.ready) {
      loading = null;
      track = { song, buffer: pre.ready, duration: pre.ready.duration };
      return;
    }
    loading = song;
    track = null;
    try {
      let buffer = pre && pre.decoding ? await pre.decoding.catch(() => null) : null;
      if (loading !== song) return;
      if (!buffer) {
        const data = await (pre && !pre.decoding ? pre.data.catch(() => download(song)) : download(song));
        if (loading !== song) return;
        buffer = await audio().decodeAudioData(data);
      }
      if (loading !== song) return;
      track = { song, buffer, duration: buffer.duration };
    } catch (e) {
      if (loading !== song) return;
      failed = song;
      error = 'No he podido cargar la canción: ' + (e.message || 'formato no válido');
    }
    loading = null;
    update();
  }

  // El reloj del audio contra el de la página: s de audio menos s de página, según getOutputTimestamp (que ya cuenta lo que
  // tarda el sonido en salir por el altavoz). Cada lectura suelta baila unos ms, y en algunos móviles bastantes:
  // perseguirlas hacía oscilar la música. Se usa la mediana de las de los últimos 30 s, que no se mueve con las que bailan (las de
  // algunos móviles van en diente de sierra, unos 30 ms). Una lectura que se sale más de 40 ms se ignora; tres seguidas es que el audio
  // ha dado un salto o ha cambiado la salida (un altavoz Bluetooth) y se empieza de cero
  let audioPoints = [], audioFit = null, strange = 0;
  function middle(points) {
    const y = median(points.map(p => p.y));
    return { at: () => y, slope: 0, rms: Math.sqrt(points.reduce((sum, p) => sum + (p.y - y) ** 2, 0) / points.length) };
  }
  function audioMap(now) {
    const ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
    if (ts && ts.performanceTime) {
      const point = { x: ts.performanceTime, y: ts.contextTime - ts.performanceTime / 1000 };
      strange = audioFit && Math.abs(point.y - audioFit.at(point.x)) > 0.04 ? strange + 1 : 0;
      if (strange === 3) {
        audioPoints = [];
        strange = 0; // si no, tras una mala lectura el contador se pasaba de 3 y se quedaba congelado en ella para siempre
      }
      if (strange === 0) {
        audioPoints = audioPoints.filter(p => now - p.x < 30000).concat(point);
        audioFit = middle(audioPoints);
      }
    }
    // Recién arrancado aún no hay lecturas: la latencia que diga Chrome
    const direct = ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0) - now / 1000;
    // Lo que se oye no va segundos por detrás de lo que el audio ya ha calculado: una recta que diga eso no vale, y con ella las
    // canciones se programarían para mucho más tarde (en silencio y con cara de estar sonando, porque el desfase se mide con ella)
    if (audioFit && Math.abs(audioFit.at(now) - direct) > 2) {
      audioPoints = [];
      audioFit = null;
      strange = 0;
      if (current) current.errors = [];
    }
    return audioFit ? audioFit.at(now) : direct;
  }

  // El instante del reloj del audio en que se oye lo que suena a la hora serverMs del PC
  function ctxTime(serverMs) {
    const now = performance.now();
    return audioMap(now) + (serverMs - offsetAt(now) - performance.timeOrigin) / 1000 + (now - BORN) / 1000 * SIMULATED;
  }

  const posAt = (c, t) => c.pos + (t - c.at) * c.rate; // por dónde va la canción (s) en el instante t del reloj del audio
  // Lo programado para más tarde de lo que da de margen el PC (menos de 2 s, con el retraso) aún no suena: no se dice que sí
  const sounding = () => Boolean(current) && (LIGHT || current.at - ctx.currentTime < 2);
  const median = list => list.slice().sort((a, b) => a - b)[list.length >> 1];

  // Si ya suena, mide cuánto se ha ido de donde debería estar y lo corrige acelerando o frenando un poco, sin saltos. Solo
  // si se ha ido mucho (al empezar, al saltar en la canción, al cambiar bastante el retraso) se recoloca de golpe: la nueva
  // empieza justo donde para la vieja, sin hueco
  function schedule() {
    const target = state.startAt + state.delay;
    if (LIGHT) return scheduleLight(target);
    const zero = ctxTime(target), now = ctx.currentTime; // zero: instante del audio en que debería haber empezado
    if (current && current.song === state.song) {
      if (current.target !== target) { current.target = target; current.errors = []; } // las medidas de antes ya no valen
      current.errors.push({ t: now, e: posAt(current, now) - (now - zero) });
      current.errors = current.errors.filter(x => now - x.t < 10);
      offBy = median(current.errors.map(x => x.e));
      if (Math.abs(offBy) < JUMP) return steer(current, now);
      fixes++;
    }
    const rate = 1 + drift;
    const when = Math.max(zero, now + 0.1);
    const pos = when - zero;
    if (current) {
      try { current.source.stop(when); } catch (e) {}
      current = null;
    }
    if (pos >= track.duration) return;
    const source = ctx.createBufferSource();
    source.buffer = track.buffer;
    source.playbackRate.value = rate;
    source.connect(gain);
    source.onended = () => {
      source.disconnect();
      if (current && current.source === source) { current = null; update(); }
    };
    source.start(when, pos);
    current = { source, song: state.song, target, at: when, pos, rate, errors: [], steered: now };
  }

  // Para quitar el desfase en unos segundos, más lo que ya se sabe que adelanta o atrasa este móvil. Lo aprendido vale
  // también para las siguientes canciones
  function steer(c, now) {
    if (now < c.at) return; // aún no ha empezado a sonar
    drift = clamp(drift - offBy * Math.min(now - c.steered, 10) / LEARN, MAX_RATE / 2);
    c.steered = now;
    const rate = 1 + clamp(drift - offBy / HORIZON, MAX_RATE);
    if (Math.abs(rate - c.rate) < 1e-5) return;
    c.pos = posAt(c, now);
    c.at = now;
    c.rate = rate;
    c.source.playbackRate.setValueAtTime(rate, now);
  }

  function stopSound() {
    offBy = null;
    clearTimeout(startTimer);
    if (!current) return;
    if (LIGHT) {
      current.el.pause();
      current.el.playbackRate = 1;
    } else {
      try { current.source.stop(); } catch (e) {}
    }
    current = null;
  }

  // ── Modo ligero: un <audio> para la que suena y otro para la siguiente, que se va descargando ──

  const players = LIGHT ? [new Audio(), new Audio()] : [];
  for (const p of players) {
    p.preload = 'auto';
    p.muted = SILENT;
  }
  // Un segundo de silencio en bucle: lo que mantiene viva la página cuando no suena nada (keepOutput)
  const hush = LIGHT ? new Audio(silence(8000)) : null;
  if (hush) {
    hush.loop = true;
    hush.muted = SILENT;
  }
  let unlocked = false; // Chrome deja sonar los <audio>: tras un toque, o porque ya dejaba
  let lag = 0.3; // s que tarda en sonar de verdad tras play(); se aprende de cada arranque
  let startTimer = null;
  const canPlay = () => (LIGHT ? unlocked : Boolean(ctx && ctx.state === 'running'));

  // Un WAV de silencio. Con una sola muestra, para saber si Chrome ya deja sonar sin tocar
  function silence(samples = 1) {
    const v = new DataView(new ArrayBuffer(44 + samples * 2));
    const text = (at, s) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
    text(0, 'RIFF'); v.setUint32(4, 36 + samples * 2, true); text(8, 'WAVEfmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 16000, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true); text(36, 'data'); v.setUint32(40, samples * 2, true);
    return URL.createObjectURL(new Blob([v], { type: 'audio/wav' }));
  }

  // Hay Chrome que pide el toque para cada <audio>: play() dentro del toque lo desbloquea y pause() lo deja como estaba
  function unlock() {
    unlocked = true;
    for (const p of players.concat(hush)) {
      if (!p.paused) continue;
      p.play().catch(() => {});
      p.pause();
    }
    update();
  }

  // El Chrome de un móvil con poca memoria no descarga nada de un <audio> hasta que suena (no hace caso de preload): se le
  // hace sonar en silencio hasta que arranca, y se para. El de Android 4 ni eso deja antes de que alguien toque la página
  function warm(el) {
    el.muted = true;
    el.warming = el.play().then(() => el.pause(), e => {
      if (e && e.name === 'NotSupportedError') throw new Error('el PC no la encuentra o no es un formato válido');
      throw e;
    }).finally(() => {
      el.muted = SILENT;
      el.warming = null;
    });
    return el.warming;
  }

  // La canción sin descomprimirla entera: en el <audio> que ya la tenía preparada o en otro; el que sobra se suelta
  async function stream(song, pre) {
    const el = pre ? pre.el : players.filter(p => p.song === song).concat(players)[0];
    for (const p of players) {
      if (p === el || !p.song) continue;
      p.song = null;
      p.removeAttribute('src');
      p.load();
    }
    loading = song;
    track = null;
    try {
      if (el.song !== song) {
        el.song = song;
        el.src = '/song/' + encodeURIComponent(song);
      }
      if (el.warming) await el.warming.catch(() => {}); // la siguiente, que aún se estaba preparando
      if (el.readyState < 1) await warm(el);
      if (loading !== song) return;
      track = { song, el, duration: isFinite(el.duration) ? el.duration : (state && state.duration) || Infinity };
    } catch (e) {
      if (loading !== song) return;
      if (e && e.name === 'NotAllowedError') unlocked = false; // hace falta un toque; luego se vuelve a intentar
      else {
        failed = song;
        error = 'No he podido cargar la canción: ' + e.message;
      }
    }
    loading = null;
    update();
  }

  // Compara por dónde va el <audio> (currentTime, que ya cuenta lo que tarda en salir por el altavoz) con por dónde
  // debería ir. Con poco desfase acelera o frena; con mucho, para y vuelve a arrancar donde toca, contando con lo que
  // tarda en sonar (lag). Se llama cada medio segundo mientras suena
  function scheduleLight(target) {
    const el = track.el, t = performance.now();
    const due = (performance.timeOrigin + t + offsetAt(t) - target) / 1000; // s de canción que deberían estar sonando
    if (current && (current.song !== state.song || current.target !== target)) stopSound(); // otra canción o un salto
    if (!current) current = { song: state.song, target, el, errors: [], calm: 0, learn: false, starting: false };
    if (due >= track.duration || el.ended) return;
    const c = current;
    if (el.paused) {
      if (c.starting) return;
      // Si aún no le toca, espera; si ya debería sonar, arranca por donde irá cuando por fin suene
      c.starting = true;
      const from = Math.max(0, due + lag);
      if (Math.abs(el.currentTime - from) > 0.05) el.currentTime = from;
      startTimer = setTimeout(() => {
        if (current !== c) return;
        el.playbackRate = 1;
        el.play().then(() => {
          c.starting = false;
          c.calm = performance.now() + SETTLE;
          c.learn = true;
          c.errors = [];
        }, e => {
          c.starting = false;
          if (e && e.name === 'NotAllowedError') unlocked = false; // hace falta un toque
          update();
        });
      }, Math.max(0, -due - lag) * 1000);
      return;
    }
    if (el.seeking || t < c.calm) return;
    c.errors.push({ t, e: el.currentTime - due });
    c.errors = c.errors.filter(x => t - x.t < 10000);
    if (c.errors.length < 4) return;
    offBy = median(c.errors.map(x => x.e));
    if (c.learn) {
      c.learn = false;
      lag = Math.max(0, Math.min(3, lag - offBy)); // lo que se desvió al arrancar
    }
    if (Math.abs(offBy) > LIGHT_JUMP) {
      fixes++;
      el.pause(); // y en la siguiente vuelta arranca donde toca
      c.errors = [];
      return;
    }
    const rate = Math.abs(offBy) < 0.015 ? 1 : 1 + clamp(-offBy / HORIZON, LIGHT_RATE);
    if (Math.abs(rate - el.playbackRate) > 1e-4) el.playbackRate = rate;
  }
  if (LIGHT) setInterval(() => { if (current && state && track) schedule(); }, 500);

  // Una señal inaudible mantiene abierta la salida de audio. Si no, Chrome la cierra a los 30 s sin sonido; al reabrirla, la canción
  // arranca desplazada y a los pocos segundos se recoloca de golpe, cada móvil en un momento distinto. Y con la página detrás y sin
  // salida de audio, Android la congela a los pocos minutos: deja de oír al PC y no vuelve hasta que se desbloquea el móvil
  let keeper = null;
  function keepOutput(on) {
    if (LIGHT) {
      const quiet = on && !sounding(); // con la canción sonando no hace falta, y estos móviles andan justos de reproductores
      if (quiet && unlocked && hush.paused) hush.play().catch(() => {});
      if (!quiet && !hush.paused) hush.pause();
      return;
    }
    if (!ctx || on === Boolean(keeper)) return;
    if (on) {
      keeper = ctx.createConstantSource();
      keeper.offset.value = 1e-5;
      keeper.connect(ctx.destination);
      keeper.start();
    } else {
      keeper.stop();
      keeper.disconnect();
      keeper = null;
    }
  }

  // ── Lo que hay que hacer según lo que diga el PC; se llama con cada aviso y cada poco ──

  function update() {
    const s = state;
    if (s && s.song !== failed) failed = null; // con otra canción, la que falló se podrá volver a intentar
    if (!s || !s.song) {
      track = null;
      error = '';
      stopSound();
    } else if (s.song !== failed && s.song !== loading && (!track || track.song !== s.song) && (!LIGHT || unlocked)) {
      load(s.song); // el modo ligero, tras el toque: sin él, Chrome no deja ni descargarla
    }
    const go = s && s.song && s.playing && s.on && s.startAt != null && track && track.song === s.song
      && canPlay() && clock.ok;
    if (go) schedule(); else stopSound();
    // También en pausa, salvo si la página está detrás en un móvil con pantalla: alguien lo estará usando y le gastaría la batería
    keepOutput(Boolean(s && (s.playing || headless() || !document.hidden)));
    prepare(s);
    phase = !canPlay() ? 'tap' : error ? 'error' : loading ? 'loading' : sounding() ? 'playing' : track ? 'ready' : 'idle';
    render();
    report();
  }

  // Va preparando la que sonará después, pero solo con la actual ya cargada, para no quitarle red ni procesador
  function prepare(s) {
    const next = s && s.song && s.next !== s.song ? s.next : null;
    if (ahead && ahead.song !== next) ahead = null;
    if (!next || loading || !track || track.song !== s.song || (!LIGHT && !ctx)) return;
    if (LIGHT) {
      // Sin descomprimirla: basta con que el otro <audio> la vaya descargando
      if (!ahead) {
        const el = players.find(p => p !== track.el);
        el.song = next;
        el.src = '/song/' + encodeURIComponent(next);
        warm(el).catch(() => {});
        ahead = { song: next, el };
      }
      return;
    }
    if (!ahead) {
      ahead = { song: next, data: download(next), decoding: null, ready: null };
      ahead.data.catch(() => {});
    }
    const pcNow = performance.timeOrigin + performance.now() + offsetAt(performance.now());
    const pos = s.playing && s.startAt != null ? (pcNow - s.startAt) / 1000 : s.position || 0;
    if (ahead.decoding || track.duration - pos > AHEAD) return;
    const a = ahead;
    a.decoding = a.data.then(data => ctx.decodeAudioData(data));
    a.decoding.then(buffer => { a.ready = buffer; }, () => {});
  }

  // Al PC le cuenta cómo está, cuando cambia y cada 10 s. visible: la página está delante (el PC solo la toca entonces)
  let lastKey = '', lastSent = 0;
  function report() {
    if (!linked) return;
    const body = {
      id: ID, page: PAGE, phase, song: loading || (track && track.song) || null, duration: track && isFinite(track.duration) ? track.duration : null,
      error, rtt: clock.rtt, fixes, visible: !document.hidden, rest: resting,
      off: offBy == null ? null : Math.round(offBy * 1e4) / 10, speed: current ? Math.round(((LIGHT ? current.el.playbackRate : current.rate) - 1) * 1e5) / 1e3 : null,
      jitter: audioFit ? Math.round(audioFit.rms * 1e4) / 10 : null,
      light: LIGHT, // para calibrar: tarda más en cuadrar tras arrancar
    };
    const key = [phase, body.song, error, body.visible, resting].join('|');
    if (key === lastKey && Date.now() - lastSent < 10000) return;
    lastKey = key;
    lastSent = Date.now();
    send('/status', body);
  }

  const send = (path, body) => fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Altavoz': '1' }, body: JSON.stringify(body),
  }).catch(() => {});

  // ── Pantalla ──

  // Para buscar canciones sin tildes ni mayúsculas: «cancion» encuentra «Canción»
  const fold = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  let songsKey = '';
  const SOUND = 'M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05A4.5 4.5 0 0 0 16.5 12zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06A9 9 0 0 0 14 3.23z';
  const MUTED = 'M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a9 9 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z';

  function render() {
    const s = state || {};
    $('activate').hidden = phase !== 'tap';
    $('room').textContent = s.room || 'Altavoz';
    // «Artista - Canción»: la canción grande y el artista debajo
    const name = s.song ? s.title : 'Nada sonando', dash = name.indexOf(' - ');
    const title = dash > 0 ? name.slice(dash + 3) : name;
    if ($('title-text').textContent !== title) {
      $('title-text').textContent = title;
      fitTitle();
    }
    $('artist').textContent = dash > 0 ? name.slice(0, dash) : '';
    $('artist').hidden = dash <= 0;
    const text = replaced ? 'Hay otra pestaña haciendo de altavoz: toca para usar esta'
      : !linked ? 'Buscando el PC… (el panel tiene que estar en marcha)'
      : error ? error
      : !s.song ? 'Elige una canción'
      : !s.on ? 'Aquí está silenciado'
      : loading ? 'Cargando…'
      : !s.playing ? 'En pausa'
      : sounding() ? 'Sonando' : 'Preparando…';
    const until = s.stopAt && s.playing
      ? ' · hasta las ' + new Date(s.stopAt).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : '';
    $('state-text').textContent = text + until;
    $('state').className = 'chip' + (!linked || error || (s.song && !s.on) ? ' warn' : current && s.playing ? ' playing' : '');
    $('toggle-icon').setAttribute('d', s.playing ? PAUSE : PLAY);
    $('toggle').setAttribute('aria-label', s.playing ? 'Pausa' : 'Reproducir');
    const muted = Boolean(state) && !s.on; // hasta que hable el PC, como si sonara: sin destello ámbar al cargar
    $('here').classList.toggle('off', muted);
    $('here').setAttribute('aria-label', muted ? 'Que vuelva a sonar aquí' : 'Silenciar este altavoz');
    $('here-icon').setAttribute('d', muted ? MUTED : SOUND);
    $('here-text').textContent = muted ? 'Silenciado' : 'Silenciar';
    $('here-hint').textContent = muted ? 'Toca y suena'
      : 'Volumen ' + (volume ? Math.round(volume.level / volume.max * 100) + ' %' : volumeFailed ? '?' : '…');
    progress();
    // La lista se rehace solo si cambian las canciones; al cambiar la que suena, solo se mueve la marca (así no salta
    // mientras alguien la recorre)
    const list = s.songs || [];
    const key = JSON.stringify(list);
    if (key !== songsKey) {
      songsKey = key;
      $('songs').innerHTML = list.length ? '' : '<li class="empty">Aún no hay canciones: cópialas en el PC a la carpeta «musica».</li>';
      for (const [id, name] of list) {
        const b = document.createElement('button');
        b.textContent = name;
        b.dataset.song = id;
        b.dataset.key = fold(name);
        const li = document.createElement('li');
        li.append(b);
        $('songs').append(li);
      }
      const none = document.createElement('li');
      none.className = 'empty';
      none.id = 'none';
      none.hidden = true;
      $('songs').append(none);
      filter();
    }
    for (const b of $('songs').querySelectorAll('button')) b.classList.toggle('now', b.dataset.song === s.song);
    wake(phase !== 'tap');
  }

  // Si el título no cabe en su línea por poco (hasta un 15 %), la letra se encoge lo justo; si sobra más, se desliza hasta el
  // final a unos 45 px por segundo (se lee mientras pasa), espera 2 s y vuelve. Se mide al cambiar de canción y al girar o
  // redimensionar; en reposo se queda quieto
  let slide = null;
  function fitTitle() {
    if (slide) slide.cancel();
    slide = null;
    const box = $('title'), text = $('title-text');
    box.classList.remove('slide');
    box.style.fontSize = '';
    const room = box.clientWidth - 24; // 24: el margen de los bordes difuminados
    if (text.offsetWidth > room && text.offsetWidth * 0.85 <= room) {
      box.style.fontSize = Math.floor(parseFloat(getComputedStyle(box).fontSize) * room / text.offsetWidth) + 'px';
    }
    const extra = text.offsetWidth - room;
    if (extra <= 0) return;
    box.classList.add('slide');
    const move = extra / 45 * 1000, wait = 2000, total = 2 * (move + wait);
    const at = (x, t) => ({ transform: 'translateX(' + x + 'px)', offset: t / total, easing: 'ease-in-out' });
    slide = text.animate([at(0, 0), at(0, wait), at(-extra, wait + move), at(-extra, 2 * wait + move), at(0, total)],
      { duration: total, iterations: Infinity });
    if (resting) slide.pause();
  }
  window.addEventListener('resize', fitTitle);

  // El volumen de la música del móvil, el mismo que cambian sus botones: una página no puede tocarlo, así que se lo pide al
  // PC. Cada toque se ve al momento; el PC los aplica de uno en uno, y lo que diga cuenta cuando ha contestado a todos
  let volume = null, volumeFailed = false, volumePending = 0;
  async function changeVolume(step) {
    if (volume && step) volume = { level: Math.max(0, Math.min(volume.max, volume.level + step)), max: volume.max };
    volumePending++;
    render();
    let answer = null;
    try {
      answer = await (await fetch('/volume', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Altavoz': '1' }, body: JSON.stringify({ id: ID, step }),
      })).json();
    } catch (e) {}
    volumePending--;
    if (answer && answer.max) {
      if (!volumePending) volume = answer;
      volumeFailed = false;
    } else volumeFailed = !volume;
    render();
  }
  for (const b of document.querySelectorAll('[data-volume]')) b.onclick = () => changeVolume(Number(b.dataset.volume));
  // Por si lo cambian con los botones del propio móvil
  setInterval(() => { if (linked && !document.hidden && !resting) changeVolume(0); }, 60000);

  // Por dónde va la canción, con la hora del PC: también en un móvil silenciado, que no la carga. La duración la da el PC
  // (la sabe en cuanto algún altavoz la ha cargado) o, si no, la canción cargada aquí
  const mmss = t => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
  let shown = 0;
  function progress() {
    const s = state || {};
    const dur = s.duration || (track && track.song === s.song && isFinite(track.duration) ? track.duration : 0);
    const pcNow = performance.timeOrigin + performance.now() + offsetAt(performance.now());
    const pos = Math.min(dur, s.playing && s.startAt != null ? Math.max(0, (pcNow - s.startAt) / 1000) : s.position || 0);
    const pct = s.song && dur ? pos / dur * 100 : 0;
    $('bar').style.transition = pct < shown ? 'none' : ''; // al empezar otra canción, vuelve al principio sin deslizarse
    $('bar').style.width = pct + '%';
    shown = pct;
    $('pos').textContent = s.song && dur ? mmss(pos) : '';
    $('dur').textContent = s.song && dur ? mmss(dur) : '';
  }
  setInterval(progress, 1000);

  // Las canciones, a pantalla completa: se abren con «Canciones» y se cierran al elegir una, con la X o con el botón
  // de volver del móvil (por eso abrirlas añade un paso al historial: sin él, volver sacaría de la página)
  function showPicker(on) {
    if (on === !$('picker').hidden) return;
    $('picker').hidden = !on;
    if (!on) {
      if (history.state && history.state.picker) history.back();
      return;
    }
    history.pushState({ picker: true }, '');
    $('find').value = '';
    filter();
    const now = $('songs').querySelector('.now');
    $('songs').scrollTop = 0;
    if (now) now.scrollIntoView({ block: 'center' });
  }
  window.addEventListener('popstate', () => { $('picker').hidden = true; });

  function filter() {
    const text = $('find').value.trim(), words = fold(text).split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const b of $('songs').querySelectorAll('button')) {
      const hit = words.every(w => b.dataset.key.indexOf(w) >= 0);
      b.parentNode.hidden = !hit;
      if (hit) shown++;
    }
    const none = $('none');
    if (!none) return;
    none.hidden = shown > 0 || !text;
    none.textContent = 'Ninguna canción con «' + text + '»';
  }

  // Pantalla encendida mientras la página esté delante: con la pantalla apagada, Android puede dormir Chrome y dejaría de oír al PC.
  // Un altavoz «sin pantalla» (lo elige el panel) no la pide, y la suelta si la tenía: suena con la pantalla apagada
  let lock = null;
  const headless = () => Boolean(state && state.screen === false);
  async function wake(on) {
    if (headless() && lock && lock.release) {
      lock.release();
      lock = null;
    }
    if (!on || headless() || document.hidden || lock || !navigator.wakeLock) return;
    lock = 'pidiendo';
    try {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { lock = null; });
    } catch (e) { lock = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && reloadPending) return location.reload();
    wake(phase !== 'tap');
    report();
  });

  // Si el panel trae una versión nueva de esta página, se recarga sola (cuando esté delante, para que el PC la pueda tocar)
  let version = null, reloadPending = false;
  function checkVersion(v) {
    if (version === null) version = v;
    if (v === version) return;
    if (document.hidden) reloadPending = true;
    else location.reload();
  }

  // Cualquier toque la pone a pantalla completa (Chrome solo deja hacerlo al tocar): se ve solo el reproductor
  document.addEventListener('click', () => {
    const page = document.documentElement;
    if (!document.fullscreenElement && page.requestFullscreen) page.requestFullscreen().catch(() => {});
  });

  // Descanso: si nadie la toca en unos minutos se queda en negro y el PC baja el brillo del móvil al mínimo. En las pantallas
  // OLED el negro apaga los píxeles: no se ve nada ni se graba la imagen. Vuelve en cuanto baja el dedo,
  // aunque lo arrastre (así no hay clic), y ese toque no pulsa nada. Solo descansa estando delante: con otra app delante, el
  // brillo tiene que estar normal. Sin pantalla descansa a los 15 s, y al descansar el panel le apaga la pantalla
  const REST = (Number(params.get('descanso')) || 180) * 1000; // ?descanso=<s>, para probar
  const HEADLESS_REST = 15000;
  let touched = Date.now(), resting = false;
  function setRest(on) {
    resting = on;
    document.body.classList.toggle('rest', on);
    if (on) showPicker(false); // al despertar, el reproductor
    else changeVolume(0);
    if (slide && on) slide.pause();
    if (slide && !on) slide.play();
    report();
  }
  document.addEventListener('pointerdown', () => { touched = Date.now(); }, true);
  $('rest').onpointerdown = () => resting && setRest(false);
  document.addEventListener('visibilitychange', () => {
    touched = Date.now();
    if (document.hidden && resting) setRest(false);
  });
  setInterval(() => {
    if (!resting && !document.hidden && Date.now() - touched > (headless() ? HEADLESS_REST : REST)) setRest(true);
  }, 5000);

  $('activate').onclick = () => {
    if (LIGHT) return unlock();
    audio().resume().catch(() => {});
    // Un sonido vacío termina de desbloquear el audio en algunos móviles
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, 22050);
    src.connect(ctx.destination);
    src.start();
  };

  document.querySelector('.controls').onclick = e => {
    const b = e.target.closest('[data-do]');
    if (b) send('/control', { action: b.dataset.do });
  };
  $('here').onclick = () => send('/control', { action: 'here', id: ID, on: !(state && state.on) });
  $('pick').onclick = () => showPicker(true);
  $('picker-close').onclick = () => showPicker(false);
  $('find').oninput = filter;
  // Enter (la lupa del teclado) esconde el teclado para ver lo encontrado
  $('find').onkeydown = e => { if (e.key === 'Enter') $('find').blur(); };
  $('songs').onclick = e => {
    const b = e.target.closest('[data-song]');
    if (!b) return;
    send('/control', { action: 'play', song: b.dataset.song });
    showPicker(false);
  };

  // Para depurar desde la consola: offBy, el desfase con el PC (s); rate, la velocidad a la que va; drift, la aprendida
  window.altavoz = () => ({
    phase, song: current && current.song, rtt: clock.rtt, offset: offsetAt(performance.now()), ppm: clock.fit && Math.round(clock.fit.slope * 1e6), offBy, drift, fixes,
    audio: audioFit && { ppm: Math.round(audioFit.slope * 1e9), jitter: Math.round(audioFit.rms * 1e4) / 10, points: audioPoints.length },
    heard: Math.round(performance.now() - heard), kept: LIGHT ? !hush.paused : Boolean(keeper), light: LIGHT, lag, rate: current && (LIGHT ? current.el.playbackRate : current.rate), errors: current && current.errors.map(x => Math.round(x.e * 1e4) / 10),
  });

  // ── Arranque ──

  // Si el PC dice que hay otra pestaña más nueva, esta se calla y se desconecta; al volver a mirarla, se recarga y pasa
  // a ser ella el altavoz
  let events = null, heard = 0;
  function connect() {
    if (events) events.close();
    heard = performance.now();
    events = new EventSource('/events?id=' + encodeURIComponent(ID) + '&p=' + PAGE);
    events.addEventListener('replaced', () => {
      replaced = true;
      events.close();
      linked = false;
      state = null;
      ahead = null;
      update();
    });
    events.addEventListener('ping', () => { heard = performance.now(); });
    events.onopen = () => { heard = performance.now(); linked = true; lastKey = ''; update(); changeVolume(0); };
    events.onmessage = e => {
      heard = performance.now();
      linked = true;
      state = JSON.parse(e.data);
      checkVersion(state.v);
      update();
    };
    events.onerror = () => { linked = false; render(); }; // EventSource vuelve a intentarlo solo
  }
  connect();
  // El PC da señales cada 15 s. Si pasa mucho sin oírlo, la conexión está muerta aunque Chrome la dé por abierta (ocurre al volver
  // de estar dormido) y la página se quedaría sorda: se abre otra
  setInterval(() => { if (!replaced && performance.now() - heard > 40000) connect(); }, 5000);
  document.addEventListener('visibilitychange', () => { if (replaced && !document.hidden) location.reload(); });
  document.addEventListener('pointerdown', () => { if (replaced) location.reload(); });
  // Sin un toque se queda en pausa; si Chrome ya deja sonar, no hace falta tocar
  if (LIGHT) new Audio(silence()).play().then(() => { unlocked = true; update(); }, () => {});
  else audio();
  syncClock(8).then(update);
  setInterval(() => syncClock(2).then(update), 5000);
  setInterval(update, 2000);
})();
