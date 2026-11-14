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
  const skip = scene.querySelector('.cullinan-skip');
  const cue = scene.querySelector('.cullinan-scroll-cue');
  const intro = scene.querySelector('.cullinan-intro');
  const actions = scene.querySelector('.cullinan-actions');
  const toolbar = scene.querySelector('.cullinan-toolbar');
  const title = catalog.querySelector('#catalog-title');
  const baseSkip = document.querySelector('.skip-link');
  const moved = [];
  const abort = new AbortController();
  let active = true;
  let ready = false;
  let released = false;
  let config;
  let filmKey;
  let clipGeneration = 0;
  // The raw manifest is kept so the film can be chosen again when the window changes shape.
  let manifest;
  let revision = '';
  // Poster proportions for upright phones, known from the page before the manifest arrives.
  let posterSize;
  let viewportWidth = 0;
  let viewportHeight = 0;
  let travel = 0;
  let sceneTop = 0;
  // `target` follows the scroll position; `progress` eases towards it so that
  // wheel ticks and touch flicks scrub the film without visible steps.
  let target = 0;
  let progress = 0;
  let lastFrame = 0;
  let wantedTime = 0;
  let lastSeekTime = -1;
  let mediaObjectURL;
  // The film as numbered stills on a canvas; see startSequence().
  let sequence;
  let raf = 0;
  let resizeFrame = 0;
  let loadingTimer;

  const clamp = (value, low = 0, high = 1) => Math.min(high, Math.max(low, value));
  const mix = (a, b, amount) => a + (b - a) * amount;
  const easeOut = value => value >= 1 ? 1 : 1 - Math.pow(2, -10 * value);
  const easeInOut = value => value < 0.5 ? 4 * value * value * value : 1 - Math.pow(-2 * value + 2, 3) / 2;
  const SMOOTHING = 110; // milliseconds for the eased progress to close most of a gap
  const DEFAULT_FILM_END = 0.76;

  function focusCatalog() {
    if (title) {
      title.setAttribute('tabindex', '-1');
      title.focus({preventScroll: true});
    }
  }

  // Move the original nodes once. There is only one catalogue and one set of forms.
  function moveIntoCatalog(node, prepend = false) {
    if (!node) return;
    const marker = document.createComment('Cullinan preview original position');
    node.before(marker);
    moved.push({node, marker});
    if (prepend) catalog.prepend(node);
    else catalog.append(node);
  }

  function showRegularCatalog(focus = false) {
    if (!active) return;
    active = false;
    abort.abort();
    clearTimeout(loadingTimer);
    cancelAnimationFrame(raf);
    cancelAnimationFrame(resizeFrame);
    stopSequence();
    video.pause();
    video.removeAttribute('src');
    video.load();
    if (mediaObjectURL) {
      URL.revokeObjectURL(mediaObjectURL);
      mediaObjectURL = undefined;
    }
    catalog.inert = false;
    catalog.removeAttribute('aria-hidden');
    catalog.removeAttribute('style');
    anchor.style.removeProperty('min-height');
    body.classList.remove('cullinan-enhanced', 'cullinan-released', 'cullinan-instrument', 'cullinan-entering', 'cullinan-portrait', 'cullinan-immersed');
    scene.style.removeProperty('--cullinan-chrome');
    scene.style.removeProperty('--cullinan-actions');
    body.style.removeProperty('--cullinan-height');
    body.style.removeProperty('--cullinan-travel');
    for (const {node, marker} of moved) marker.replaceWith(node);
    scene.hidden = true;
    window.scrollTo({top: 0, behavior: 'instant'});
    if (focus) focusCatalog();
  }

  function onSkip(event) {
    event.preventDefault();
    showRegularCatalog(true);
  }

  function setReleased(value) {
    if (released === value) return;
    released = value;
    body.classList.toggle('cullinan-released', value);
    if (value) body.classList.remove('cullinan-instrument', 'cullinan-entering', 'cullinan-immersed');
    if (!value && catalog.contains(document.activeElement)) skip.focus({preventScroll: true});
    catalog.inert = !value;
    if (value) {
      catalog.removeAttribute('aria-hidden');
      catalog.style.removeProperty('height');
    } else catalog.setAttribute('aria-hidden', 'true');
    if (value && scene.contains(document.activeElement)) focusCatalog();
  }

  function measure() {
    if (!active) return;
    if (viewportWidth <= 800 && viewportWidth === document.documentElement.clientWidth &&
        Math.abs(window.innerHeight - viewportHeight) < 140 &&
        (!manifest || filmKey === wantedFilmKey())) { schedule(); return; }
    const oldTravel = travel;
    const oldProgress = oldTravel ? clamp((window.scrollY - sceneTop) / oldTravel) : 0;
    const catalogOffset = Math.max(0, window.scrollY - sceneTop - oldTravel);
    viewportWidth = document.documentElement.clientWidth;
    viewportHeight = window.innerHeight;
    travel = Math.round(viewportHeight * (viewportWidth <= 800 ? 1.5 : 2));
    body.style.setProperty('--cullinan-height', `${viewportHeight}px`);
    body.style.setProperty('--cullinan-travel', `${travel}px`);
    sceneTop = scene.getBoundingClientRect().top + window.scrollY;
    // Fixed positioning must not remove the document's eventual catalogue height.
    anchor.style.minHeight = `${Math.max(catalog.scrollHeight, viewportHeight)}px`;
    if (oldTravel && released) {
      window.scrollTo({top: sceneTop + travel + catalogOffset, behavior: 'instant'});
    } else if (oldTravel && oldProgress > 0) {
      window.scrollTo({top: sceneTop + oldProgress * travel, behavior: 'instant'});
    }
    if (manifest && config && filmKey !== wantedFilmKey()) {
      try { chooseFilm(); } catch (_) { showRegularCatalog(); return; }
    }
    placeFilm();
    schedule();
  }

  // Share of the film already played, independent of the closing expansion.
  function filmProgress() {
    return clamp(progress / (config ? config.expandStartProgress : DEFAULT_FILM_END));
  }

  function filmRect() {
    const small = viewportWidth <= 800;
    const played = filmProgress();
    // The poster has the film's proportions, so the frame is known before the clip loads.
    const size = (sequence && sequence.size) || (config && config.dimensions) || posterSize || [1920, 1080];
    const sourceWidth = (!sequence && video.videoWidth) || size[0];
    const sourceHeight = (!sequence && video.videoHeight) || size[1];
    const contain = Math.min(viewportWidth / sourceWidth, viewportHeight / sourceHeight);
    let zoom = 1;
    let lift = 0;
    if (sourceHeight > sourceWidth) {
      // An upright film starts whole and grows until it covers the phone.
      const cover = Math.max(viewportWidth / sourceWidth, viewportHeight / sourceHeight) / contain;
      zoom = 1 + (Math.min(cover, 1.3) - 1) * easeOut(clamp(played / 0.6));
    } else if (small) {
      zoom = 1 + 0.24 * easeOut(clamp(played / 0.8));
      lift = 30 * (1 - clamp(played / 0.55));
    }
    const width = sourceWidth * contain * zoom;
    const height = sourceHeight * contain * zoom;
    return {width, height, x: (viewportWidth - width) / 2, y: (viewportHeight - height) / 2 + lift};
  }

  function placeFilm() {
    if (!active || released || !viewportWidth) return;
    const frame = filmRect();
    const box = {width: `${frame.width}px`, height: `${frame.height}px`, left: `${frame.x}px`, top: `${frame.y}px`};
    Object.assign(video.style, box);
    if (sequence) Object.assign(sequence.canvas.style, box);
  }

  // A bounded neighbourhood of decoded frames, with the desired frame requested first.
  // The browser HTTP cache can retain compressed files without keeping the whole film decoded.
  function startSequence(spec, revision) {
    const canvas = document.createElement('canvas');
    canvas.className = 'cullinan-film';
    canvas.width = spec.dimensions[0];
    canvas.height = spec.dimensions[1];
    canvas.setAttribute('aria-hidden', 'true');
    const compact = spec.dimensions[0] < 1920;
    sequence = {canvas, context: canvas.getContext('2d'), size: spec.dimensions, count: spec.count,
      fps: spec.fps || (spec.count - 1) / config.duration,
      images: new Map(), failures: new Set(), pending: 0, shown: -1, wanted: 0, direction: 1,
      capacity: compact ? 10 : 20, concurrency: compact ? 3 : 4,
      address: index => assetURL(spec.pattern.replace('{index}', String(index).padStart(3, '0'))) + revision};
    if (!sequence.context) return showRegularCatalog();
    drawSequence(config.duration * filmProgress());
  }

  function frameOrder(film) {
    const order = [film.wanted];
    // Two frames forward for each frame behind; reverse the priorities when scrolling back.
    for (let distance = 1; order.length < film.capacity && distance < film.count; distance += 1) {
      for (const offset of [distance * 2 - 1, distance * 2, -distance]) {
        const index = film.wanted + offset * film.direction;
        if (index >= 0 && index < film.count && !order.includes(index)) order.push(index);
        if (order.length === film.capacity) break;
      }
    }
    return order;
  }

  function discardFrame(film, index, entry) {
    entry.image.onload = null;
    entry.image.onerror = null;
    if (!entry.loaded) film.pending -= 1;
    entry.image.src = '';
    film.images.delete(index);
  }

  function loadFrames() {
    const film = sequence;
    if (!film || released) return;
    const order = frameOrder(film);
    const keep = new Set(order);
    for (const [index, entry] of film.images) {
      if (!keep.has(index)) discardFrame(film, index, entry);
    }
    for (const index of order) {
      if (film.pending >= film.concurrency) break;
      if (film.images.has(index) || film.failures.has(index)) continue;
      const image = new Image();
      const entry = {image, loaded: false};
      film.images.set(index, entry);
      film.pending += 1;
      image.decoding = 'async';
      image.onload = async () => {
        try { if (image.decode) await image.decode(); }
        catch (_) { if (image.onerror) image.onerror(); return; }
        if (sequence !== film || film.images.get(index) !== entry) return;
        film.pending -= 1;
        entry.loaded = true;
        if (!ready && index === film.wanted) {
          video.after(film.canvas);
          ready = true;
          clearTimeout(loadingTimer);
          placeFilm();
        }
        loadFrames();
        schedule();
      };
      image.onerror = () => {
        if (sequence !== film || film.images.get(index) !== entry) return;
        film.pending -= 1;
        film.images.delete(index);
        film.failures.add(index);
        // A broken scene must never lock access to the actual catalogue.
        if (index === film.wanted || film.failures.size > 6) showRegularCatalog();
        else loadFrames();
      };
      image.src = film.address(index);
    }
  }

  function drawSequence(time) {
    const film = sequence;
    const wanted = Math.min(film.count - 1, Math.floor(Math.max(0, time) * film.fps));
    if (wanted !== film.wanted) film.direction = wanted > film.wanted ? 1 : -1;
    film.wanted = wanted;
    loadFrames();
    if (sequence !== film) return;
    // Keep the last painted image while the exact new frame arrives, rather than
    // jumping to a distant keyframe. The portal follows the painted image too.
    const entry = film.images.get(wanted);
    if (!entry || !entry.loaded || wanted === film.shown) return;
    film.context.drawImage(entry.image, 0, 0, film.canvas.width, film.canvas.height);
    film.shown = wanted;
    film.canvas.dataset.frame = String(wanted);
  }

  function stopSequence() {
    if (!sequence) return;
    for (const [index, entry] of sequence.images) discardFrame(sequence, index, entry);
    sequence.canvas.remove();
    sequence = undefined;
  }

  function hideControls(node, hidden, fallback) {
    if (!node || node.inert === hidden) return;
    if (hidden && node.contains(document.activeElement)) fallback.focus({preventScroll: true});
    node.inert = hidden;
    if (hidden) node.setAttribute('aria-hidden', 'true');
    else node.removeAttribute('aria-hidden');
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

  function renderPortal(time) {
    if (!active || !ready || released) return;
    const portalVisible = clamp((time - config.portalStart) / config.portalFadeDuration);
    const expansion = clamp((progress - config.expandStartProgress) / (1 - config.expandStartProgress));
    const amount = easeInOut(expansion);
    const played = filmProgress();
    const covering = config.portalFill ? portalVisible : 0;
    const instrument = expansion === 0 && !config.portalFill;
    if (instrument !== body.classList.contains('cullinan-instrument')) {
      body.classList.toggle('cullinan-instrument', instrument);
      // Phones swap the compact display layout for the real page; soften that cut.
      if (viewportWidth <= 800 && portalVisible === 1 && catalog.animate) {
        catalog.animate([{opacity: 0.2}, {opacity: 1}], {duration: 240, easing: 'ease-out'});
      }
    }
    // The stage controls leave as the page takes over, instead of showing around it.
    body.classList.toggle('cullinan-entering', expansion >= 0.3 || covering >= 0.5);
    scene.style.setProperty('--cullinan-chrome', String(1 - Math.max(clamp(expansion / 0.3), clamp(covering * 2))));
    // A full-screen film should not play behind the two large buttons; the skip link stays.
    const immersed = config.upright ? clamp((played - 0.12) / 0.2) : 0;
    scene.style.setProperty('--cullinan-actions', String(1 - immersed));
    body.classList.toggle('cullinan-immersed', immersed >= 1);
    const controlsHidden = expansion >= 0.3 || covering >= 0.5;
    hideControls(toolbar, controlsHidden, baseSkip);
    hideControls(actions, controlsHidden || immersed >= 1, controlsHidden ? baseSkip : skip);
    if (intro) {
      intro.style.opacity = String(1 - clamp(played / 0.28));
      intro.style.visibility = played >= 0.28 ? 'hidden' : 'visible';
    }
    const quad = screenQuad(time);
    const full = [[0, 0], [viewportWidth, 0], [viewportWidth, viewportHeight], [0, viewportHeight]];
    const expanded = quad.map((point, index) => [
      mix(point[0], full[index][0], amount), mix(point[1], full[index][1], amount),
    ]);
    const length = (first, last) => Math.hypot(last[0] - first[0], last[1] - first[1]);
    const projectedWidth = (length(expanded[0], expanded[1]) + length(expanded[3], expanded[2])) / 2;
    const projectedHeight = (length(expanded[0], expanded[3]) + length(expanded[1], expanded[2])) / 2;
    const surfaceHeight = Math.max(1, viewportWidth * projectedHeight / projectedWidth);
    // Reveal more of the page as the aperture grows; do not squash its typography.
    catalog.style.height = `${surfaceHeight}px`;
    catalog.style.transform = project(expanded, surfaceHeight);
    catalog.style.opacity = String(expansion > 0 ? 1 : portalVisible);
    cue.style.opacity = String(1 - clamp(played / 0.12));
  }

  function seek() {
    if (!active || !ready || sequence || video.seeking) return;
    let seekable = false;
    for (let index = 0; index < video.seekable.length; index += 1) {
      const start = video.seekable.start(index);
      const end = video.seekable.end(index);
      if (end > start && wantedTime >= start && wantedTime <= end) seekable = true;
    }
    if (!seekable || wantedTime === lastSeekTime) return;
    if (Math.abs(video.currentTime - wantedTime) > 0.025) {
      lastSeekTime = wantedTime;
      try { video.currentTime = wantedTime; }
      catch (_) { showRegularCatalog(); }
    }
  }

  function render(now) {
    raf = 0;
    if (!active) return;
    target = clamp((window.scrollY - sceneTop) / travel);
    setReleased(target >= 1);
    if (released) {
      // Release decoded frames after entry; scrolling back requests its neighbourhood anew.
      if (sequence) for (const [index, entry] of sequence.images) discardFrame(sequence, index, entry);
      progress = 1;
      lastFrame = 0;
      return;
    }
    // A long gap between frames (a throttled or background tab) simply lands on the target.
    const elapsed = lastFrame ? now - lastFrame : 16;
    lastFrame = now;
    const gap = target - progress;
    progress = Math.abs(gap) < 0.0004 ? target : progress + gap * (1 - Math.exp(-elapsed / SMOOTHING));
    placeFilm();
    if (sequence) {
      wantedTime = config.duration * filmProgress();
      drawSequence(wantedTime);
      if (sequence && sequence.shown >= 0) renderPortal(sequence.shown / sequence.fps);
    } else if (ready) {
      wantedTime = Math.min(config.duration, video.duration - 0.04) * filmProgress();
      seek();
      renderPortal(video.currentTime);
    }
    if (progress === target) lastFrame = 0;
    else schedule();
  }

  function schedule() {
    if (active && !raf) raf = requestAnimationFrame(render);
  }

  function validateManifest(data) {
    const portalFill = data.portal === 'viewport';
    const keyframes = portalFill ? [] : data.portalKeyframes;
    const size = data.dimensions;
    if (typeof data.video !== 'string' || !Number.isFinite(data.duration) || data.duration <= 0 ||
        (size !== undefined && !(Array.isArray(size) && size.length === 2 && size.every(side => Number.isFinite(side) && side > 0))) ||
        !Number.isFinite(data.portalStart) || data.portalStart < 0 || data.portalStart >= data.duration ||
        !Array.isArray(keyframes) || (!portalFill && !keyframes.length) || keyframes.some(frame =>
          !Number.isFinite(frame.time) || !Array.isArray(frame.quad) || frame.quad.length !== 4 ||
          frame.quad.some(point => !Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)))) {
      throw new Error('Incomplete cinematic manifest');
    }
    const remaining = data.duration - data.portalStart;
    const stills = spec => (spec && typeof spec.pattern === 'string' && spec.pattern.includes('{index}') &&
      Number.isInteger(spec.count) && spec.count >= 2 && spec.count <= 400 &&
      (spec.fps === undefined || (Number.isFinite(spec.fps) && spec.fps > 0 && spec.fps <= 60)) &&
      Array.isArray(spec.dimensions) && spec.dimensions.length === 2 &&
      spec.dimensions.every(side => Number.isFinite(side) && side > 0) ? spec : undefined);
    return {
      ...data,
      frames: stills(data.frames),
      framesCompact: stills(data.framesCompact),
      portalFill,
      portalKeyframes: [...keyframes].sort((a, b) => a.time - b.time),
      expandStartProgress: clamp(Number.isFinite(data.expandStartProgress) ? data.expandStartProgress : DEFAULT_FILM_END, 0.6, 0.95),
      // The full-viewport handover may take the film's whole closing stretch.
      portalFadeDuration: portalFill ? Math.max(0.08, remaining * 0.9) : Math.max(0.08, Math.min(0.25, remaining / 3)),
    };
  }

  function uprightPhone() {
    const width = document.documentElement.clientWidth;
    return width <= 800 && window.innerHeight > width * 1.2;
  }

  function wantsUpright() {
    return Boolean(manifest && manifest.portrait) && uprightPhone();
  }

  function wantedFilmKey() {
    // Touch laptops and wide tablets deserve full resolution too.
    return wantsUpright() ? 'portrait' : (document.documentElement.clientWidth <= 800 ? 'compact' : 'wide');
  }

  function armLoadingTimeout() {
    clearTimeout(loadingTimer);
    loadingTimer = setTimeout(() => showRegularCatalog(scene.contains(document.activeElement)), 10000);
  }

  // Pick the film for the current window: upright or wide, and how detailed its stills are.
  function chooseFilm() {
    filmKey = wantedFilmKey();
    clipGeneration += 1;
    let next;
    if (wantsUpright()) {
      // Upright phones get their own film, with its own timings and handover.
      try {
        next = {...validateManifest(manifest.portrait), upright: true};
      } catch (_) { /* keep the wide film */ }
    }
    config = next || validateManifest(manifest);
    if (!config.upright) posterSize = undefined;
    body.classList.toggle('cullinan-portrait', Boolean(config.upright));
    if (config.poster) {
      const poster = assetURL(config.poster);
      if (video.poster !== poster) video.poster = poster;
    }
    stopSequence();
    ready = false;
    lastSeekTime = -1;
    video.removeAttribute('src');
    video.load();
    if (mediaObjectURL) URL.revokeObjectURL(mediaObjectURL);
    mediaObjectURL = undefined;
    armLoadingTimeout();
    // The film is drawn from numbered stills in every browser; the video file is only a fallback.
    const compact = filmKey === 'compact';
    const spec = (compact && config.framesCompact) || config.frames;
    if (spec) startSequence(spec, revision);
    else loadClip(revision);
    placeFilm();
  }

  function assetURL(path) {
    const base = new URL(scene.dataset.mediaBase || scene.dataset.manifest, window.location.href);
    const url = new URL(path, base);
    if (url.origin !== base.origin || !['http:', 'https:'].includes(url.protocol)) {
      throw new Error('Unexpected cinematic media origin');
    }
    return url.href;
  }

  // The local Django static server does not provide byte-range seeking.
  // Load this short clip once; an object URL provides reliable local scrubbing.
  function loadClip(revision) {
    const generation = clipGeneration;
    fetch(assetURL(config.video) + revision, {signal: abort.signal, cache: 'force-cache'})
      .then(response => {
        if (!response.ok) throw new Error('Cinematic video unavailable');
        return response.blob();
      })
      .then(blob => {
        if (!active || generation !== clipGeneration) return;
        if (!blob.size) throw new Error('Cinematic video is empty');
        mediaObjectURL = URL.createObjectURL(blob);
        // Safari keeps to preload="none" even after load(); ask for the data outright.
        video.preload = 'auto';
        video.src = mediaObjectURL;
        video.load();
      })
      .catch(() => {
        if (active && generation === clipGeneration) showRegularCatalog(scene.contains(document.activeElement));
      });
  }

  // Progressive enhancement starts with the poster, and has a bounded fallback.
  moveIntoCatalog(document.querySelector('.site-header'), true);
  moveIntoCatalog(document.querySelector('.demo-strip'), true);
  moveIntoCatalog(document.querySelector('.site-footer'));
  scene.hidden = false;
  body.classList.add('cullinan-enhanced');
  if (uprightPhone() && scene.dataset.portraitPoster) {
    const size = (scene.dataset.portraitSize || '').split('x').map(Number);
    if (size.length === 2 && size.every(side => Number.isFinite(side) && side > 0)) {
      posterSize = size;
      video.poster = scene.dataset.portraitPoster;
    }
  }
  catalog.inert = true;
  catalog.setAttribute('aria-hidden', 'true');
  scene.querySelectorAll('.cullinan-skip').forEach(link =>
    link.addEventListener('click', onSkip, {signal: abort.signal}));
  if (baseSkip) baseSkip.addEventListener('click', onSkip, {signal: abort.signal});
  window.addEventListener('scroll', schedule, {passive: true, signal: abort.signal});
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(measure);
  }, {passive: true, signal: abort.signal});
  motion.addEventListener('change', event => {
    if (event.matches) showRegularCatalog(scene.contains(document.activeElement));
  }, {signal: abort.signal});
  video.addEventListener('error', () => showRegularCatalog(scene.contains(document.activeElement)), {signal: abort.signal});
  video.addEventListener('seeked', () => {
    if (sequence) return;
    renderPortal(video.currentTime);
    seek();
  }, {signal: abort.signal});
  const readyWhenSeekable = () => {
    if (ready || !active || sequence || video.readyState < 2) return;
    if (!config || !video.videoWidth || !video.videoHeight || !Number.isFinite(video.duration)) return showRegularCatalog();
    // Retain the loading timeout until this browser can actually scrub the clip.
    if (!video.seekable.length || video.seekable.end(video.seekable.length - 1) <= 0) return;
    clearTimeout(loadingTimer);
    ready = true;
    measure();
  };
  video.addEventListener('loadeddata', readyWhenSeekable, {signal: abort.signal});
  video.addEventListener('canplay', readyWhenSeekable, {signal: abort.signal});
  armLoadingTimeout();
  measure();

  fetch(scene.dataset.manifest, {signal: abort.signal, cache: 'no-cache'})
    .then(response => {
      if (!response.ok) throw new Error('Cinematic assets unavailable');
      return response.json();
    })
    .then(data => {
      if (!active) return;
      manifest = data;
      // Media stays in the browser cache; a new revision in the manifest replaces it.
      revision = typeof data.revision === 'string' && data.revision ? `?v=${encodeURIComponent(data.revision)}` : '';
      chooseFilm();
    })
    .catch(() => {
      if (active) showRegularCatalog(scene.contains(document.activeElement));
    });
})();
