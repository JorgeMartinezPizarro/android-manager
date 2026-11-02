'use strict';
// Página de altavoz: el panel la abre en Chrome en cada móvil. Ajusta su reloj con el del PC y empieza cada canción a la
// hora que diga el PC con el audio del navegador, que sabe arrancar un sonido en un instante exacto.
// Escrito para el Chrome más viejo de casa (el 101 del Nexus 6). Con ?silencio hace todo igual, pero sin que se oiga.

(function () {
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const ID = params.get('id') || '';
  const SILENT = params.has('silencio');
  const TOLERANCE = 0.03; // s de desfase con el PC a partir de los que se vuelve a cuadrar la canción
  const PAUSE = 'M6 5h4v14H6zm8 0h4v14h-4z', PLAY = 'M8 5v14l11-7z';

  let state = null; // lo último que ha dicho el PC
  let linked = false;
  let ctx = null, gain = null;
  let track = null; // { song, buffer }: la canción ya cargada
  let loading = null, failed = null, error = '';
  let current = null; // { source, song, zero }: lo que está sonando; zero es el instante del audio en que empezó la canción
  let fixes = 0; // veces que se ha vuelto a cuadrar una canción ya empezada
  let phase = '';

  // ── Reloj: la diferencia con el PC, de la medida más rápida de los últimos 60 s (la menos deformada por la red) ──

  const clock = { offset: 0, rtt: null, ok: false, samples: [] };

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
    const best = clock.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    Object.assign(clock, { offset: best.offset, rtt: Math.round(best.rtt), ok: true });
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
    return ts.contextTime + (serverMs - clock.offset - performance.timeOrigin - ts.performanceTime) / 1000;
  }

  // Si ya suena y va a la hora, nada; si se ha desviado, la nueva empieza justo donde para la vieja, sin hueco
  function schedule() {
    const zero = ctxTime(state.startAt + state.delay);
    if (current && current.song === state.song && Math.abs(current.zero - zero) < TOLERANCE) return;
    const when = Math.max(zero, ctx.currentTime + 0.1);
    const offset = when - zero;
    if (current) {
      if (current.song === state.song) fixes++;
      try { current.source.stop(when); } catch (e) {}
      current = null;
    }
    if (offset >= track.buffer.duration) return;
    const source = ctx.createBufferSource();
    source.buffer = track.buffer;
    source.connect(gain);
    source.onended = () => {
      source.disconnect();
      if (current && current.source === source) { current = null; update(); }
    };
    source.start(when, offset);
    current = { source, song: state.song, zero };
  }

  function stopSound() {
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

  // Para depurar desde la consola: zero es la hora del PC (ms) a la que esta página hizo empezar la canción
  window.altavoz = () => ({
    phase, song: current && current.song, rtt: clock.rtt, offset: clock.offset,
    zero: current && current.zero !== undefined ? ctxToServer(current.zero) : null, startAt: state && state.startAt,
  });
  const ctxToServer = c => {
    const ts = ctx.getOutputTimestamp();
    return ts.performanceTime + (c - ts.contextTime) * 1000 + performance.timeOrigin + clock.offset;
  };

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
