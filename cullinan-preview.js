(() => {
  'use strict';
  const scene = document.getElementById('cullinan-scene');
  const catalog = document.getElementById('cullinan-catalog');
  const anchor = document.getElementById('cullinan-catalog-anchor');
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (!scene || !catalog || !anchor || motion.matches || !('inert' in HTMLElement.prototype) ||
      catalog.querySelector('.errorlist, [role=alert]')) return;

  const body = document.body;
  const video = scene.querySelector('video');
  const play = scene.querySelector('.cullinan-play');
  const status = scene.querySelector('.cullinan-play-status');
  const intro = scene.querySelector('.cullinan-intro');
  const actions = scene.querySelector('.cullinan-actions');
  const skip = scene.querySelector('.cullinan-skip');
  const title = catalog.querySelector('#catalog-title');
  const baseSkip = document.querySelector('.skip-link');
  if (!video || !play || !status) return;
  const abort = new AbortController();
  const moved = [];
  let active = true, ready = false, started = false, wantsPlay = false, playing = false;
  let manifest, config, objectURL, download, generation = 0;
  let raf = 0, resizeRAF = 0, loadTimer, stallTimer, finishAt = null;
  let viewportWidth = 0, viewportHeight = 0, travel = 0, sceneTop = 0;
  let resumeOnVisible = false;
  const clamp = (n, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));
  const mix = (a, b, n) => a + (b - a) * n;
  const ease = n => n * n * (3 - 2 * n);
  const revision = '?v=continuous-20261116-1';

  function state(name, message = '') {
    scene.dataset.playback = name;
    status.textContent = message;
    play.textContent = playing ? 'Пауза' : (started ? 'Продовжити' : 'Відкрити двері');
    play.setAttribute('aria-label', playing ? 'Призупинити відео' : (started ? 'Продовжити відео' : 'Відкрити двері: відтворити відео'));
  }
  function focusCatalog() {
    title?.setAttribute('tabindex', '-1');
    title?.focus({preventScroll: true});
  }
  function restore(focus = false) {
    if (!active) return;
    active = false;
    generation += 1;
    abort.abort();
    download?.abort();
    clearTimeout(loadTimer); clearTimeout(stallTimer);
    cancelAnimationFrame(raf); cancelAnimationFrame(resizeRAF);
    const quality = video.getVideoPlaybackQuality?.();
    if (quality) {
      scene.dataset.decodedFrames = String(quality.totalVideoFrames);
      scene.dataset.droppedFrames = String(quality.droppedVideoFrames);
    }
    scene.dataset.lastFilmTime = String(video.currentTime);
    video.pause(); video.removeAttribute('src'); video.load();
    if (objectURL) URL.revokeObjectURL(objectURL);
    catalog.inert = false;
    catalog.removeAttribute('aria-hidden'); catalog.removeAttribute('style');
    anchor.style.removeProperty('min-height');
    body.classList.remove('cullinan-enhanced', 'cullinan-instrument', 'cullinan-portrait', 'cullinan-immersed', 'cullinan-released');
    body.style.removeProperty('--cullinan-height'); body.style.removeProperty('--cullinan-travel');
    for (const {node, marker} of moved) marker.replaceWith(node);
    scene.hidden = true;
    window.scrollTo({top: 0, behavior: 'instant'});
    if (focus) focusCatalog();
  }
  function move(node, prepend = false) {
    if (!node) return;
    const marker = document.createComment('cinematic original position');
    node.before(marker); moved.push({node, marker});
    if (prepend) catalog.prepend(node); else catalog.append(node);
  }
  function upright() {
    return document.documentElement.clientWidth <= 800 && window.innerHeight > document.documentElement.clientWidth * 1.2;
  }
  function asset(path) {
    const base = new URL(scene.dataset.mediaBase || scene.dataset.manifest, window.location.href);
    const url = new URL(path, base);
    if (url.origin !== base.origin || !['http:', 'https:'].includes(url.protocol)) throw Error('Invalid film origin');
    return url.href;
  }
  function validate(data) {
    if (!data || typeof data.video !== 'string' || !Number.isFinite(data.duration) || data.duration <= 0 ||
        !Number.isFinite(data.portalStart) || data.portalStart < 0 || data.portalStart >= data.duration) throw Error('Invalid film');
    const fill = data.portal === 'viewport';
    const frames = data.portalKeyframes;
    if (!fill && (!Array.isArray(frames) || !frames.length || frames.some(f => !Number.isFinite(f.time) ||
      !Array.isArray(f.quad) || f.quad.length !== 4 || f.quad.some(p => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite))))) throw Error('Invalid portal');
    return {...data, portalFill: fill, portalKeyframes: fill ? [] : [...frames].sort((a,b) => a.time-b.time)};
  }
  async function chooseFilm() {
    const token = ++generation;
    download?.abort(); download = new AbortController();
    ready = false;
    config = {...validate(upright() && manifest.portrait ? manifest.portrait : manifest), upright: Boolean(upright() && manifest.portrait)};
    body.classList.toggle('cullinan-portrait', config.upright);
    video.poster = asset(config.poster);
    state('loading', 'Готуємо відео…');
    clearTimeout(loadTimer);
    loadTimer = setTimeout(() => restore(scene.contains(document.activeElement)), 20000);
    // Download one compact movie completely before playing. No range seeking, no image queue,
    // no reassignment of currentTime while scrolling. The native decoder owns frame pacing.
    try {
      const response = await fetch(asset(config.video) + revision, {signal: download.signal, cache: 'force-cache'});
      if (!response.ok) throw Error('Film unavailable');
      const blob = await response.blob();
      if (!active || token !== generation) return;
      if (!blob.size) throw Error('Empty film');
      video.pause(); video.removeAttribute('src'); video.load();
      if (objectURL) URL.revokeObjectURL(objectURL);
      objectURL = URL.createObjectURL(blob);
      video.muted = true; video.defaultMuted = true; video.playsInline = true; video.preload = 'auto';
      video.src = objectURL; video.load();
    } catch (error) {
      if (active && token === generation && error.name !== 'AbortError') restore(scene.contains(document.activeElement));
    }
    placeFilm();
  }
  function filmProgress() { return config ? clamp(video.currentTime / config.duration) : 0; }
  function filmRect() {
    const size = config?.dimensions || (config?.upright ? [1080,1920] : [1920,1080]);
    const w = video.videoWidth || size[0], h = video.videoHeight || size[1];
    const scale = Math.min(viewportWidth / w, viewportHeight / h);
    // Stable framing: the camera move is already authored in the film.
    return {width: w*scale, height: h*scale, x: (viewportWidth-w*scale)/2, y: (viewportHeight-h*scale)/2};
  }
  function placeFilm() {
    const f = filmRect();
    Object.assign(video.style, {width: `${f.width}px`, height: `${f.height}px`, left: `${f.x}px`, top: `${f.y}px`});
  }
  function measure() {
    if (!active) return;
    viewportWidth = document.documentElement.clientWidth;
    viewportHeight = window.innerHeight;
    travel = Math.round(viewportHeight * 2);
    body.style.setProperty('--cullinan-height', `${viewportHeight}px`);
    body.style.setProperty('--cullinan-travel', `${travel}px`);
    sceneTop = scene.getBoundingClientRect().top + window.scrollY;
    anchor.style.minHeight = `${Math.max(catalog.scrollHeight, viewportHeight)}px`;
    // Rotation never restarts a playing film. Before playback, choose the appropriate cut.
    if (manifest && config && !started && config.upright !== Boolean(upright() && manifest.portrait)) chooseFilm();
    placeFilm(); schedule();
  }
  function screenQuad(time) {
    // A film that ends inside the display hands over the whole viewport.
    if (config.portalFill) return [[0, 0], [viewportWidth, 0], [viewportWidth, viewportHeight], [0, viewportHeight]];
    const frames = config.portalKeyframes;
    let first = frames[0];
    let last = frames[frames.length - 1];
    if (time <= first.time) last = first;
    else if (time >= last.time) first = last;
    else {
      for (let index = 1; index < frames.length; index += 1) {
        if (time <= frames[index].time) {
          first = frames[index - 1];
          last = frames[index];
          break;
        }
      }
    }
    const fraction = last.time === first.time ? 0 : clamp((time - first.time) / (last.time - first.time));
    const frame = filmRect();
    const frameWidth = frame.width;
    const frameHeight = frame.height;
    const offsetX = frame.x;
    const offsetY = frame.y;
    return first.quad.map((point, index) => [
      offsetX + mix(point[0], last.quad[index][0], fraction) * frameWidth,
      offsetY + mix(point[1], last.quad[index][1], fraction) * frameHeight,
    ]);
  }

  // Project this very same rectangular DOM surface onto the filmed display.
  function project(quad, surfaceHeight) {
    const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = quad;
    const dx1 = x1 - x2;
    const dx2 = x3 - x2;
    const dy1 = y1 - y2;
    const dy2 = y3 - y2;
    const sx = x0 - x1 + x2 - x3;
    const sy = y0 - y1 + y2 - y3;
    const determinant = dx1 * dy2 - dx2 * dy1;
    const g = Math.abs(determinant) < 0.00001 ? 0 : (sx * dy2 - dx2 * sy) / determinant;
    const h = Math.abs(determinant) < 0.00001 ? 0 : (dx1 * sy - sx * dy1) / determinant;
    const matrix = [
      (x1 - x0 + g * x1) / viewportWidth,
      (y1 - y0 + g * y1) / viewportWidth, 0, g / viewportWidth,
      (x3 - x0 + h * x3) / surfaceHeight,
      (y3 - y0 + h * y3) / surfaceHeight, 0, h / surfaceHeight,
      0, 0, 1, 0, x0, y0, 0, 1,
    ];
    return `matrix3d(${matrix.join(',')})`;
  }


  function hideActions(hidden) {
    if (hidden && actions.contains(document.activeElement)) skip.focus({preventScroll: true});
    actions.inert = hidden;
    if (hidden) actions.setAttribute('aria-hidden', 'true'); else actions.removeAttribute('aria-hidden');
    scene.style.setProperty('--cullinan-actions', hidden ? '0' : '1');
    body.classList.toggle('cullinan-immersed', hidden);
  }
  function render(now) {
    raf = 0;
    if (!active || !config) return;
    const time = video.currentTime;
    const played = filmProgress();
    scene.dataset.filmTime = time.toFixed(3);
    if (intro) {
      intro.style.opacity = String(1-clamp(played/0.22));
      intro.style.visibility = played >= 0.22 ? 'hidden' : 'visible';
    }
    hideActions(played > 0.2);
    const expansion = finishAt === null ? 0 : ease(clamp((now-finishAt)/650));
    if (time < config.portalStart && finishAt === null) {
      if (playing) schedule();
      return;
    }
    const fade = clamp((time-config.portalStart)/Math.max(0.1,config.duration-config.portalStart-0.08));
    const quad = screenQuad(time);
    const full = [[0,0],[viewportWidth,0],[viewportWidth,viewportHeight],[0,viewportHeight]];
    const expanded = quad.map((point,i)=>[mix(point[0],full[i][0],expansion),mix(point[1],full[i][1],expansion)]);
    const length = (a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
    const w = (length(expanded[0],expanded[1])+length(expanded[3],expanded[2]))/2;
    const h = (length(expanded[0],expanded[3])+length(expanded[1],expanded[2]))/2;
    const surface = Math.max(1,viewportWidth*h/w);
    body.classList.toggle('cullinan-instrument', !config.portalFill && expansion === 0);
    catalog.style.height = `${surface}px`;
    catalog.style.transform = project(expanded,surface);
    catalog.style.opacity = String(expansion > 0 ? 1 : fade);
    if (expansion === 1) { restore(scene.contains(document.activeElement)); return; }
    if (playing || finishAt !== null) schedule();
  }
  function schedule() { if (active && !raf) raf = requestAnimationFrame(render); }
  async function start() {
    wantsPlay = true;
    if (!active || !ready || playing || document.hidden || finishAt !== null) return;
    // Set immediately so rapid wheel/click events cannot create overlapping play attempts.
    playing = true;
    try {
      await video.play();
      if (!active) return;
      started = true;
      state('playing'); schedule();
    } catch (_) {
      if (!active) return;
      playing = false;
      state('ready', 'Натисніть, щоб відтворити відео');
    }
  }
  function pause() {
    wantsPlay = false; resumeOnVisible = false; playing = false;
    video.pause(); clearTimeout(stallTimer); state('paused');
  }

  move(document.querySelector('.site-header'), true);
  move(document.querySelector('.demo-strip'), true);
  move(document.querySelector('.site-footer'));
  scene.hidden = false; body.classList.add('cullinan-enhanced');
  catalog.inert = true; catalog.setAttribute('aria-hidden','true');
  play.hidden = false; status.hidden = false;
  video.muted = true; video.playsInline = true;
  scene.querySelectorAll('.cullinan-skip').forEach(link => link.addEventListener('click',event=>{
    event.preventDefault(); restore(true);
  },{signal:abort.signal}));
  baseSkip?.addEventListener('click',event=>{event.preventDefault();restore(true);},{signal:abort.signal});
  play.addEventListener('click',()=>{ if (playing) pause(); else start(); },{signal:abort.signal});
  window.addEventListener('scroll',()=>{
    if (!active) return;
    const offset = window.scrollY-sceneTop;
    // Wheel inertia must not skip the door opening. The visible catalogue link,
    // Escape and End remain immediate exits, including while loading or paused.
    if (offset > 8 && !started) start();
  },{passive:true,signal:abort.signal});
  window.addEventListener('keydown',event=>{if(event.key==='Escape' || event.key==='End')restore(true);},{signal:abort.signal});
  window.addEventListener('resize',()=>{cancelAnimationFrame(resizeRAF);resizeRAF=requestAnimationFrame(measure);},{passive:true,signal:abort.signal});
  motion.addEventListener('change',event=>{if(event.matches)restore(scene.contains(document.activeElement));},{signal:abort.signal});
  document.addEventListener('visibilitychange',()=>{
    if (document.hidden) {
      resumeOnVisible = playing;
      if (playing) { playing=false;video.pause();clearTimeout(stallTimer); }
    } else if (resumeOnVisible) { resumeOnVisible=false;start(); }
  },{signal:abort.signal});
  video.addEventListener('canplay',()=>{
    if (!active || !objectURL || ready) return;
    clearTimeout(loadTimer); ready=true; state('ready','Прокрутіть або натисніть'); placeFilm();
    if (wantsPlay) start();
  },{signal:abort.signal});
  video.addEventListener('playing',()=>{clearTimeout(stallTimer);if(active){playing=true;state('playing');schedule();}},{signal:abort.signal});
  video.addEventListener('waiting',()=>{
    if (!active || !started || document.hidden) return;
    clearTimeout(stallTimer);state('waiting','Відновлюємо відтворення…');
    stallTimer=setTimeout(()=>restore(scene.contains(document.activeElement)),6000);
  },{signal:abort.signal});
  video.addEventListener('error',()=>restore(scene.contains(document.activeElement)),{signal:abort.signal});
  video.addEventListener('ended',()=>{
    if (!active) return;
    playing=false;clearTimeout(stallTimer);play.hidden=true;
    state('ending'); finishAt=performance.now(); schedule();
  },{signal:abort.signal});
  measure();state('loading','Готуємо відео…');
  loadTimer=setTimeout(()=>restore(),20000);
  fetch(scene.dataset.manifest,{signal:abort.signal,cache:'no-cache'})
    .then(r=>{if(!r.ok)throw Error('Manifest unavailable');return r.json();})
    .then(data=>{if(active){manifest=data;chooseFilm();}})
    .catch(()=>{if(active)restore();});
})();
