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
  const title = catalog.querySelector('#catalog-title');
  const baseSkip = document.querySelector('.skip-link');
  const moved = [];
  const abort = new AbortController();
  let active = true;
  let ready = false;
  let released = false;
  let config;
  let viewportWidth = 0;
  let viewportHeight = 0;
  let travel = 0;
  let sceneTop = 0;
  let progress = 0;
  let wantedTime = 0;
  let lastSeekTime = -1;
  let mediaObjectURL;
  let raf = 0;
  let resizeFrame = 0;
  let loadingTimer;

  const clamp = (value, low = 0, high = 1) => Math.min(high, Math.max(low, value));
  const mix = (a, b, amount) => a + (b - a) * amount;
  const easeOut = value => value >= 1 ? 1 : 1 - Math.pow(2, -10 * value);

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
    body.classList.remove('cullinan-enhanced', 'cullinan-released', 'cullinan-instrument');
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
    if (value) body.classList.remove('cullinan-instrument');
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
        Math.abs(window.innerHeight - viewportHeight) < 140) { schedule(); return; }
    const oldTravel = travel;
    const oldProgress = oldTravel ? clamp((window.scrollY - sceneTop) / oldTravel) : 0;
    const catalogOffset = Math.max(0, window.scrollY - sceneTop - oldTravel);
    viewportWidth = document.documentElement.clientWidth;
    viewportHeight = window.innerHeight;
    travel = Math.round(viewportHeight * (viewportWidth <= 800 ? 1.25 : 1.75));
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
    schedule();
  }

  function filmRect() {
    const small = viewportWidth <= 800;
    const zoom = small ? 1 + 0.24 * easeOut(clamp(progress / 0.7)) : 1;
    const scale = Math.min(viewportWidth / video.videoWidth, viewportHeight / video.videoHeight) * zoom;
    const width = video.videoWidth * scale;
    const height = video.videoHeight * scale;
    return {width, height, x: (viewportWidth - width) / 2,
      y: (viewportHeight - height) / 2 + (small ? 30 * (1 - clamp(progress / 0.5)) : 0)};
  }

  function screenQuad(time) {
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
    const amount = easeOut(expansion);
    body.classList.toggle('cullinan-instrument', expansion === 0);
    const frame = filmRect();
    Object.assign(video.style, {width: `${frame.width}px`, height: `${frame.height}px`,
      left: `${frame.x}px`, top: `${frame.y}px`});
    if (intro) {
      intro.style.opacity = String(1 - clamp(progress / 0.24));
      intro.style.visibility = progress >= 0.24 ? 'hidden' : 'visible';
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
    cue.style.opacity = String(1 - clamp(progress / 0.3));
  }

  function seek() {
    if (!active || !ready || video.seeking) return;
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

  function render() {
    raf = 0;
    if (!active) return;
    progress = clamp((window.scrollY - sceneTop) / travel);
    setReleased(progress >= 1);
    if (!ready || released) return;
    wantedTime = Math.min(config.duration, video.duration - 0.04) * clamp(progress / config.expandStartProgress);
    seek();
    renderPortal(video.currentTime);
  }

  function schedule() {
    if (active && !raf) raf = requestAnimationFrame(render);
  }

  function validateManifest(data) {
    const frames = data.portalKeyframes;
    if (typeof data.video !== 'string' || !Number.isFinite(data.duration) || data.duration <= 0 ||
        !Number.isFinite(data.portalStart) || data.portalStart < 0 || data.portalStart >= data.duration ||
        !Array.isArray(frames) || !frames.length || frames.some(frame =>
          !Number.isFinite(frame.time) || !Array.isArray(frame.quad) || frame.quad.length !== 4 ||
          frame.quad.some(point => !Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)))) {
      throw new Error('Incomplete cinematic manifest');
    }
    return {
      ...data,
      portalKeyframes: [...frames].sort((a, b) => a.time - b.time),
      expandStartProgress: clamp(Number.isFinite(data.expandStartProgress) ? data.expandStartProgress : 0.87, 0.75, 0.95),
      portalFadeDuration: Math.max(0.08, Math.min(0.25, (data.duration - data.portalStart) / 3)),
    };
  }

  function assetURL(path) {
    const base = new URL(scene.dataset.mediaBase || scene.dataset.manifest, window.location.href);
    const url = new URL(path, base);
    if (url.origin !== base.origin || !['http:', 'https:'].includes(url.protocol)) {
      throw new Error('Unexpected cinematic media origin');
    }
    return url.href;
  }

  // Progressive enhancement starts with the poster, and has a bounded fallback.
  moveIntoCatalog(document.querySelector('.site-header'), true);
  moveIntoCatalog(document.querySelector('.demo-strip'), true);
  moveIntoCatalog(document.querySelector('.site-footer'));
  scene.hidden = false;
  body.classList.add('cullinan-enhanced');
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
    renderPortal(video.currentTime);
    seek();
  }, {signal: abort.signal});
  const readyWhenSeekable = () => {
    if (ready || !active || video.readyState < 2) return;
    if (!config || !video.videoWidth || !video.videoHeight || !Number.isFinite(video.duration)) return showRegularCatalog();
    // Retain the loading timeout until this browser can actually scrub the clip.
    if (!video.seekable.length || video.seekable.end(video.seekable.length - 1) <= 0) return;
    clearTimeout(loadingTimer);
    ready = true;
    measure();
  };
  video.addEventListener('loadeddata', readyWhenSeekable, {signal: abort.signal});
  video.addEventListener('canplay', readyWhenSeekable, {signal: abort.signal});
  loadingTimer = setTimeout(() => showRegularCatalog(scene.contains(document.activeElement)), 10000);
  measure();

  fetch(scene.dataset.manifest, {signal: abort.signal, cache: 'no-cache'})
    .then(response => {
      if (!response.ok) throw new Error('Cinematic assets unavailable');
      return response.json();
    })
    .then(data => {
      if (!active) return;
      config = validateManifest(data);
      if (config.poster) video.poster = assetURL(config.poster);
      // The local Django static server does not provide byte-range seeking.
      // Load this short clip once; an object URL provides reliable local scrubbing.
      return fetch(assetURL(config.video), {signal: abort.signal, cache: 'force-cache'})
        .then(response => {
          if (!response.ok) throw new Error('Cinematic video unavailable');
          return response.blob();
        })
        .then(blob => {
          if (!active) return;
          if (!blob.size) throw new Error('Cinematic video is empty');
          mediaObjectURL = URL.createObjectURL(blob);
          video.src = mediaObjectURL;
          video.load();
        });
    })
    .catch(() => {
      if (active) showRegularCatalog(scene.contains(document.activeElement));
    });
})();
