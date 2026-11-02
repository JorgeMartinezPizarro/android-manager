'use strict';
// Página de altavoz: el panel la abre en Chrome en cada móvil. Ajusta su reloj con el del PC y empieza cada canción a la
// hora que diga el PC con el audio del navegador, que sabe arrancar un sonido en un instante exacto.
// Escrito para el Chrome más viejo de casa (el 101 del Nexus 6). Con ?silencio hace todo igual, pero sin que se oiga.

(function () {
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const ID = params.get('id') || '';
  const SILENT = params.has('silencio');
  const JUMP = 0.03; // s de desfase con el PC a partir de los que se recoloca la canción de golpe; por debajo, sin saltos
  const HORIZON = 10; // s en los que se quiere absorber un desfase pequeño, acelerando o frenando
  const LEARN = 400; // s²: lo despacio que aprende cuánto adelanta o atrasa de por sí el reloj del audio de este móvil
  const MAX_RATE = 0.005; // como mucho un 0,5 % más rápido o más lento: el tono no cambia de forma que se note
  const SIMULATED = (Number(params.get('deriva')) || 0) / 1e6; // ?deriva=<ppm>: para probar, como si el audio se fuera desviando
  const BORN = performance.now();
  const clamp = (x, max) => Math.max(-max, Math.min(max, x));
  const PAUSE = 'M6 5h4v14H6zm8 0h4v14h-4z', PLAY = 'M8 5v14l11-7z';

  let state = null; // lo último que ha dicho el PC
  let linked = false;
  let ctx = null, gain = null;
  let track = null; // { song, buffer }: la canción ya cargada
  let loading = null, failed = null, error = '';
  // Lo que está sonando: en el instante at del reloj del audio iba por pos (s de la canción) y avanza a rate s por s;
  // target es la hora del PC (más el retraso) a la que empezó, y errors, los desfases medidos en los últimos 10 s
  let current = null;
  let drift = 0; // lo que hay que acelerar (o frenar, si es negativo) de base para seguir al PC; se va aprendiendo
  let offBy = null; // desfase con el PC (s, mediana de los últimos 10 s): positivo, va adelantado
  let fixes = 0; // veces que se ha recolocado de golpe una canción ya empezada
  let phase = '';

  // ── Reloj: la diferencia con el PC, de las medidas más rápidas de los últimos 60 s (las menos deformadas por la red). Los
  // relojes se van separando poco a poco: con una recta que pase por esas medidas se sigue esa deriva sin saltos ──

  const clock = { offset: 0, slope: 0, at: 0, rtt: null, ok: false, samples: [] };
  const offsetAt = t => clock.offset + (t - clock.at) * clock.slope; // ms que hay que sumar a la hora de aquí para tener la del PC

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
    const mean = f => best.reduce((sum, s) => sum + f(s), 0) / best.length;
    const at = mean(s => s.at), offset = mean(s => s.offset);
    const spread = mean(s => (s.at - at) ** 2);
    // La pendiente solo con medidas de al menos 20 s: con menos, lo que mide es el ruido de la red
    const slope = spread > 4e8 / 12 ? clamp(mean(s => (s.at - at) * (s.offset - offset)) / spread, 0.001) : 0;
    Object.assign(clock, { offset, slope, at, rtt: Math.round(best[0].rtt), ok: true });
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

  async function load(song) {
    loading = song;
    track = null;
    error = '';
    stopSound();
    try {
      const res = await fetch('/song/' + encodeURIComponent(song));
      if (!res.ok) throw new Error('el PC no la encuentra');
      const data = await res.arrayBuffer();
      if (loading !== song) return;
      const buffer = await audio().decodeAudioData(data);
      if (loading !== song) return;
      track = { song, buffer };
    } catch (e) {
      if (loading !== song) return;
      failed = song;
      error = 'No he podido cargar la canción: ' + (e.message || 'formato no válido');
    }
    loading = null;
    update();
  }

  // El instante del reloj del audio en que se oye lo que suena a la hora serverMs del PC. getOutputTimestamp ya cuenta
  // lo que tarda el sonido en salir por el altavoz; recién arrancado aún no lo sabe y se usa la latencia que diga Chrome
  function ctxTime(serverMs) {
    let ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
    if (!ts || !ts.performanceTime) {
      ts = { contextTime: ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0), performanceTime: performance.now() };
    }
    return ts.contextTime + (serverMs - offsetAt(ts.performanceTime) - performance.timeOrigin - ts.performanceTime) / 1000
      + (performance.now() - BORN) / 1000 * SIMULATED;
  }

  const posAt = (c, t) => c.pos + (t - c.at) * c.rate; // por dónde va la canción (s) en el instante t del reloj del audio
  const median = list => list.slice().sort((a, b) => a - b)[list.length >> 1];

  // Si ya suena, mide cuánto se ha ido de donde debería estar y lo corrige acelerando o frenando un poco, sin saltos. Solo
  // si se ha ido mucho (al empezar, al saltar en la canción, al cambiar bastante el retraso) se recoloca de golpe: la nueva
  // empieza justo donde para la vieja, sin hueco
  function schedule() {
    const target = state.startAt + state.delay;
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
    if (pos >= track.buffer.duration) return;
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
    if (!current) return;
    try { current.source.stop(); } catch (e) {}
    current = null;
  }

  // ── Lo que hay que hacer según lo que diga el PC; se llama con cada aviso y cada poco ──

  function update() {
    const s = state;
    if (s && s.song !== failed) failed = null; // con otra canción, la que falló se podrá volver a intentar
    if (!s || !s.song) {
      track = null;
      error = '';
      stopSound();
    } else if (s.song !== failed && s.song !== loading && (!track || track.song !== s.song)) {
      load(s.song);
    }
    const go = s && s.song && s.playing && s.on && s.startAt != null && track && track.song === s.song
      && ctx && ctx.state === 'running' && clock.ok;
    if (go) schedule(); else stopSound();
    phase = !ctx || ctx.state !== 'running' ? 'tap' : error ? 'error' : loading ? 'loading' : current ? 'playing' : track ? 'ready' : 'idle';
    render();
    report();
  }

  // Al PC le cuenta cómo está, cuando cambia y cada 10 s. visible: la página está delante (el PC solo la toca entonces)
  let lastKey = '', lastSent = 0;
  function report() {
    if (!linked) return;
    const body = {
      id: ID, phase, song: loading || (track && track.song) || null, duration: track ? track.buffer.duration : null,
      error, rtt: clock.rtt, fixes, visible: !document.hidden, rest: resting,
      off: offBy == null ? null : Math.round(offBy * 1e4) / 10, speed: current ? Math.round((current.rate - 1) * 1e5) / 1e3 : null,
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

  let songsKey = '';
  function render() {
    const s = state || {};
    $('activate').hidden = phase !== 'tap';
    $('room').textContent = s.room ? 'Altavoz · ' + s.room : 'Altavoz';
    $('link').textContent = linked ? '' : 'Sin conexión con el PC';
    $('title').textContent = s.song ? s.title : 'Nada sonando';
    const text = !linked ? 'Buscando el PC… (el panel tiene que estar abierto)'
      : error ? error
      : !s.song ? 'Elige una canción'
      : !s.on ? 'Aquí no suena: pulsa «Que suene aquí»'
      : loading ? 'Cargando la canción…'
      : !s.playing ? 'En pausa'
      : current ? 'Sonando' : 'Preparando…';
    const until = s.stopAt && s.playing
      ? ' · se pausa a las ' + new Date(s.stopAt).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : '';
    $('state').textContent = text + until;
    $('state').className = !linked || error || (s.song && !s.on) ? 'warn' : '';
    $('toggle-icon').setAttribute('d', s.playing ? PAUSE : PLAY);
    $('toggle').setAttribute('aria-label', s.playing ? 'Pausa' : 'Reproducir');
    $('here').classList.toggle('on', Boolean(s.on));
    $('here-text').textContent = s.on ? 'Suena aquí' : 'Que suene aquí';
    const list = s.songs || [];
    const key = JSON.stringify([list, s.song]);
    if (key !== songsKey) {
      songsKey = key;
      $('songs').innerHTML = list.length ? '' : '<li class="empty">Aún no hay canciones: cópialas en el PC a la carpeta «musica».</li>';
      for (const [id, name] of list) {
        const b = document.createElement('button');
        b.textContent = name;
        b.dataset.song = id;
        if (id === s.song) b.className = 'now';
        const li = document.createElement('li');
        li.append(b);
        $('songs').append(li);
      }
    }
    wake(phase !== 'tap');
  }

  // Pantalla encendida mientras la página esté delante: con la pantalla apagada, Android puede dormir Chrome y dejaría de oír al PC
  let lock = null;
  async function wake(on) {
    if (!on || document.hidden || lock || !navigator.wakeLock) return;
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

  // Descanso: si nadie la toca en unos minutos se atenúa, el PC baja el brillo del móvil al mínimo y cada minuto se mueve
  // unos píxeles, para que la imagen fija no se quede grabada en las pantallas OLED (como la del Nexus 6). El toque que la
  // despierta no pulsa nada. Solo descansa estando delante: con otra app delante, el brillo tiene que estar normal
  const REST = (Number(params.get('descanso')) || 180) * 1000; // ?descanso=<s>, para probar
  let touched = Date.now(), resting = false, shifted = 0;
  function shift(px) {
    const d = () => Math.round((Math.random() * 2 - 1) * px) + 'px';
    for (const el of document.querySelectorAll('header, main')) el.style.transform = px ? 'translate(' + d() + ', ' + d() + ')' : '';
  }
  function setRest(on) {
    resting = on;
    document.body.classList.toggle('rest', on);
    if (!on) shift(0);
    report();
  }
  document.addEventListener('pointerdown', () => { touched = Date.now(); }, true);
  $('rest').onclick = () => setRest(false);
  document.addEventListener('visibilitychange', () => {
    touched = Date.now();
    if (document.hidden && resting) setRest(false);
  });
  setInterval(() => {
    if (!resting && !document.hidden && Date.now() - touched > REST) setRest(true);
    if (resting && Date.now() - shifted > 60000) {
      shifted = Date.now();
      shift(12);
    }
  }, 5000);

  $('activate').onclick = () => {
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
  $('songs').onclick = e => {
    const b = e.target.closest('[data-song]');
    if (b) send('/control', { action: 'play', song: b.dataset.song });
  };

  // Para depurar desde la consola: offBy, el desfase con el PC (s); rate, la velocidad a la que va; drift, la aprendida
  window.altavoz = () => ({
    phase, song: current && current.song, rtt: clock.rtt, offset: clock.offset, ppm: Math.round(clock.slope * 1e6), offBy, drift, fixes,
    rate: current && current.rate, errors: current && current.errors.map(x => Math.round(x.e * 1e4) / 10),
  });

  // ── Arranque ──

  const events = new EventSource('/events?id=' + encodeURIComponent(ID));
  events.onopen = () => { linked = true; lastKey = ''; update(); };
  events.onmessage = e => {
    linked = true;
    state = JSON.parse(e.data);
    checkVersion(state.v);
    update();
  };
  events.onerror = () => { linked = false; render(); }; // EventSource vuelve a intentarlo solo

  audio(); // sin un toque se queda en pausa; si Chrome ya deja sonar, no hace falta tocar
  syncClock(8).then(update);
  setInterval(() => syncClock(2).then(update), 5000);
  setInterval(update, 2000);
})();
