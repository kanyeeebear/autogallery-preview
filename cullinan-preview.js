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
  const cue = scene.querySelector('.cullinan-scroll-cue');
  const status = scene.querySelector('.cullinan-load-status');
  const intro = scene.querySelector('.cullinan-intro');
  const actions = scene.querySelector('.cullinan-actions');
  const toolbar = scene.querySelector('.cullinan-toolbar');
  const skip = scene.querySelector('.cullinan-skip');
  const title = catalog.querySelector('#catalog-title');
  const baseSkip = document.querySelector('.skip-link');
  if (!video || !status || !cue || !video.requestVideoFrameCallback) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'cullinan-film'; canvas.setAttribute('aria-hidden','true');
  const context = canvas.getContext('2d', {alpha: false});
  if (!context) return;
  const abort = new AbortController();
  const moved = [];
  let active = true, ready = false, released = false, inFlight = false, primed = false;
  let manifest, config, objectURL, download, generation = 0;
  let raf = 0, resizeRAF = 0, frameCallback = 0, loadTimer, seekTimer;
  let viewportWidth = 0, viewportHeight = 0, travel = 0, sceneTop = 0;
  let progress = 0, paintedTime = -1, wantedTime = 0, seekStarted = 0;
  let revision = '';
  const clamp = (n, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));
  const mix = (a,b,n) => a+(b-a)*n;
  const ease = n => n*n*(3-2*n);
  const FILM_END = 0.82;

  function focusCatalog() { title?.setAttribute('tabindex','-1'); title?.focus({preventScroll:true}); }
  function restore(focus = false) {
    if (!active) return;
    active=false; generation++; abort.abort(); download?.abort();
    clearTimeout(loadTimer); clearTimeout(seekTimer);
    cancelAnimationFrame(raf); cancelAnimationFrame(resizeRAF);
    if (frameCallback) video.cancelVideoFrameCallback(frameCallback);
    video.pause(); video.removeAttribute('src'); video.load(); canvas.remove();
    if (objectURL) URL.revokeObjectURL(objectURL);
    catalog.inert=false; catalog.removeAttribute('aria-hidden'); catalog.removeAttribute('style');
    anchor.style.removeProperty('min-height');
    body.classList.remove('cullinan-enhanced','cullinan-instrument','cullinan-portrait','cullinan-immersed','cullinan-released','cullinan-entering');
    body.style.removeProperty('--cullinan-height'); body.style.removeProperty('--cullinan-travel');
    for(const {node,marker} of moved) marker.replaceWith(node);
    scene.hidden=true; window.scrollTo({top:0,behavior:'instant'});
    if(focus)focusCatalog();
  }
  function move(node,prepend=false) {
    if(!node)return;
    const marker=document.createComment('cinematic original position'); node.before(marker);moved.push({node,marker});
    if(prepend)catalog.prepend(node);else catalog.append(node);
  }
  function upright() {const w=document.documentElement.clientWidth;return w<=800 && window.innerHeight>w*1.2;}
  function asset(path) {
    const base=new URL(scene.dataset.mediaBase || scene.dataset.manifest,window.location.href);
    const url=new URL(path,base);
    if(url.origin!==base.origin || !['http:','https:'].includes(url.protocol))throw Error('Invalid film origin');
    return url.href;
  }
  function validate(data) {
    if(!data || typeof data.video!=='string' || !Number.isFinite(data.duration) || data.duration<=0 ||
       !Number.isFinite(data.portalStart) || data.portalStart<0 || data.portalStart>=data.duration)throw Error('Invalid film');
    const fill=data.portal==='viewport', frames=data.portalKeyframes;
    if(!fill && (!Array.isArray(frames) || !frames.length || frames.some(f=>!Number.isFinite(f.time) ||
      !Array.isArray(f.quad) || f.quad.length!==4 || f.quad.some(p=>!Array.isArray(p)||p.length!==2||!p.every(Number.isFinite)))))throw Error('Invalid portal');
    const fps=data.frames?.fps || (fill?24:30);
    if(!Number.isFinite(fps)||fps<1||fps>60)throw Error('Invalid frame rate');
    return {...data,fps,portalFill:fill,portalKeyframes:fill?[]:[...frames].sort((a,b)=>a.time-b.time)};
  }
  async function chooseFilm() {
    const token=++generation;
    download?.abort(); download=new AbortController();
    clearTimeout(loadTimer);clearTimeout(seekTimer);
    if(frameCallback)video.cancelVideoFrameCallback(frameCallback);
    frameCallback=0;ready=false;inFlight=false;primed=false;paintedTime=-1;
    canvas.remove(); video.pause();video.removeAttribute('src');video.load();
    if(objectURL)URL.revokeObjectURL(objectURL);objectURL=undefined;
    config={...validate(upright()&&manifest.portrait?manifest.portrait:manifest),upright:Boolean(upright()&&manifest.portrait)};
    body.classList.toggle('cullinan-portrait',config.upright);
    video.poster=asset(config.poster);
    scene.dataset.playback='loading';status.hidden=false;status.textContent='Готуємо анімацію…';
    placeFilm();
    loadTimer=setTimeout(()=>restore(scene.contains(document.activeElement)),30000);
    try {
      const r=await fetch(asset(config.video)+revision,{signal:download.signal,cache:'force-cache'});
      if(!r.ok)throw Error('Film unavailable');const blob=await r.blob();
      if(!active||token!==generation)return;if(!blob.size)throw Error('Empty film');
      objectURL=URL.createObjectURL(blob);
      video.muted=true;video.defaultMuted=true;video.playsInline=true;video.preload='auto';
      // Register before loading so even the initial decoded frame is observed.
      watchFrame(token);video.src=objectURL;video.load();
    } catch(error) {if(active&&token===generation&&error.name!=='AbortError')restore(scene.contains(document.activeElement));}
  }
  function watchFrame(token) {
    frameCallback=video.requestVideoFrameCallback((now, metadata)=>{
      if(!active||token!==generation)return;
      frameCallback=0;
      if(video.readyState>=2 && video.videoWidth && video.videoHeight) {
        if(canvas.width!==video.videoWidth || canvas.height!==video.videoHeight){canvas.width=video.videoWidth;canvas.height=video.videoHeight;}
        // seeked alone is not proof that WebKit has presented the new image.
        context.drawImage(video,0,0,canvas.width,canvas.height);
        paintedTime=metadata.mediaTime;
        canvas.dataset.frame=String(Math.round(paintedTime*config.fps));
        scene.dataset.filmTime=paintedTime.toFixed(4);
        scene.dataset.seekMs=String(Math.round(inFlight?performance.now()-seekStarted:0));
        inFlight=false;clearTimeout(seekTimer);
        if(!ready){ready=true;video.after(canvas);clearTimeout(loadTimer);status.hidden=true;scene.dataset.playback='scrub';placeFilm();}
        renderPortal();
      }
      watchFrame(token);schedule();
    });
  }
  function updateTarget() {
    progress=clamp((window.scrollY-sceneTop)/travel);
    if(!config)return;
    const lastFrame=Math.max(0,Math.round(config.duration*config.fps)-1);
    wantedTime=Math.round(clamp(progress/FILM_END)*lastFrame)/config.fps;
    scene.dataset.targetTime=wantedTime.toFixed(4);
  }
  function seek() {
    if(!active||!ready||inFlight||video.seeking||document.hidden)return;
    if(Math.abs(wantedTime-paintedTime)<0.5/config.fps)return;
    // One seek at a time. Never cancel a decoder operation on the next scroll event.
    // Once it paints, the newest scroll position wins; no stale queue to play through.
    inFlight=true;seekStarted=performance.now();
    seekTimer=setTimeout(()=>restore(scene.contains(document.activeElement)),4000);
    try{video.currentTime=wantedTime;}catch(_){restore();}
  }
  function setReleased(value) {
    if(released===value)return;
    released=value;body.classList.toggle('cullinan-released',value);
    if(value)body.classList.remove('cullinan-instrument','cullinan-immersed');
    else hide(toolbar,false,baseSkip);
    if(!value && catalog.contains(document.activeElement))skip.focus({preventScroll:true});
    catalog.inert=!value;
    if(value){catalog.removeAttribute('aria-hidden');catalog.style.removeProperty('height');}
    else catalog.setAttribute('aria-hidden','true');
    if(value && scene.contains(document.activeElement))focusCatalog();
  }
  function measure() {
    if(!active)return;
    const width=document.documentElement.clientWidth;
    const changed=config && config.upright!==Boolean(upright()&&manifest?.portrait);
    // Safari's collapsing address bar must not move the scroll-to-frame mapping.
    if(width===viewportWidth && width<=800 && Math.abs(window.innerHeight-viewportHeight)<120 && !changed){schedule();return;}
    const oldTravel=travel, oldProgress=oldTravel?clamp((window.scrollY-sceneTop)/oldTravel):0;
    const past=Math.max(0,window.scrollY-sceneTop-oldTravel);
    viewportWidth=width;viewportHeight=window.innerHeight;
    travel=Math.round(viewportHeight*(width<=800?2:2.5));
    body.style.setProperty('--cullinan-height',`${viewportHeight}px`);body.style.setProperty('--cullinan-travel',`${travel}px`);
    sceneTop=scene.getBoundingClientRect().top+window.scrollY;
    anchor.style.minHeight=`${Math.max(catalog.scrollHeight,viewportHeight)}px`;
    if(oldTravel && (released||oldProgress>0))window.scrollTo({top:sceneTop+(released?travel+past:oldProgress*travel),behavior:'instant'});
    if(changed)chooseFilm();
    placeFilm();schedule();
  }
  function filmRect() {
    const size=config?.dimensions || (config?.upright?[1080,1920]:[1920,1080]);
    const w=video.videoWidth||size[0],h=video.videoHeight||size[1];
    const scale=Math.min(viewportWidth/w,viewportHeight/h);
    return {width:w*scale,height:h*scale,x:(viewportWidth-w*scale)/2,y:(viewportHeight-h*scale)/2};
  }
  function placeFilm() {
    const f=filmRect(),box={width:`${f.width}px`,height:`${f.height}px`,left:`${f.x}px`,top:`${f.y}px`};
    Object.assign(video.style,box);Object.assign(canvas.style,box);
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



  function hide(node,hidden,fallback) {
    if(!node)return;
    if(hidden&&node.contains(document.activeElement))fallback?.focus({preventScroll:true});
    node.inert=hidden;
    if(hidden)node.setAttribute('aria-hidden','true');else node.removeAttribute('aria-hidden');
  }
  function renderPortal() {
    if(!ready || !config || released)return;
    const time=Math.max(0,paintedTime),played=clamp(time/config.duration);
    const expansion=clamp((progress-FILM_END)/(1-FILM_END));
    const amount=ease(expansion);
    const fade=clamp((time-config.portalStart)/Math.max(0.08,config.duration-config.portalStart-1/config.fps));
    if(intro){intro.style.opacity=String(1-clamp(played/0.25));intro.style.visibility=played>=0.25?'hidden':'visible';}
    const immersed=played>0.2;
    scene.style.setProperty('--cullinan-actions',immersed?'0':'1');hide(actions,immersed,skip);
    body.classList.toggle('cullinan-immersed',immersed);
    cue.style.opacity=String(1-clamp(played/0.1));
    body.classList.toggle('cullinan-instrument',!config.portalFill&&expansion===0);
    const covering=config.portalFill?fade:0;
    scene.style.setProperty('--cullinan-chrome',String(1-Math.max(amount,covering)));
    hide(toolbar,amount>=1||covering>=1,baseSkip);
    if(time<config.portalStart && expansion===0){catalog.style.opacity='0';return;}
    const quad=screenQuad(time),full=[[0,0],[viewportWidth,0],[viewportWidth,viewportHeight],[0,viewportHeight]];
    const expanded=quad.map((p,i)=>[mix(p[0],full[i][0],amount),mix(p[1],full[i][1],amount)]);
    const length=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
    const w=(length(expanded[0],expanded[1])+length(expanded[3],expanded[2]))/2;
    const h=(length(expanded[0],expanded[3])+length(expanded[1],expanded[2]))/2;
    const surface=Math.max(1,viewportWidth*h/w);
    catalog.style.height=`${surface}px`;catalog.style.transform=project(expanded,surface);
    catalog.style.opacity=String(expansion>0?1:fade);
  }
  function render() {
    raf=0;if(!active)return;
    updateTarget();setReleased(progress>=1);seek();renderPortal();
  }
  function schedule(){if(active&&!raf)raf=requestAnimationFrame(render);}

  move(document.querySelector('.site-header'),true);move(document.querySelector('.demo-strip'),true);move(document.querySelector('.site-footer'));
  scene.hidden=false;body.classList.add('cullinan-enhanced');catalog.inert=true;catalog.setAttribute('aria-hidden','true');
  video.muted=true;video.playsInline=true;video.pause();
  scene.querySelectorAll('.cullinan-skip').forEach(link=>link.addEventListener('click',e=>{e.preventDefault();restore(true);},{signal:abort.signal}));
  baseSkip?.addEventListener('click',e=>{e.preventDefault();restore(true);},{signal:abort.signal});
  window.addEventListener('scroll',schedule,{passive:true,signal:abort.signal});
  window.addEventListener('resize',()=>{cancelAnimationFrame(resizeRAF);resizeRAF=requestAnimationFrame(measure);},{passive:true,signal:abort.signal});
  window.addEventListener('keydown',e=>{if(e.key==='Escape')restore(true);},{signal:abort.signal});
  motion.addEventListener('change',e=>{if(e.matches)restore(scene.contains(document.activeElement));},{signal:abort.signal});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)schedule();},{signal:abort.signal});
  video.addEventListener('seeked',schedule,{signal:abort.signal});
  video.addEventListener('canplay',()=>{
    if(!active || !objectURL || !config)return;
    placeFilm();
    // Paused media may not present its initial frame until an explicit seek.
    // Prime one adjacent frame, then the normal queue immediately returns to the scroll target.
    if(!ready && !primed){primed=true;video.currentTime=1/config.fps;}
    schedule();
  },{signal:abort.signal});
  video.addEventListener('error',()=>restore(scene.contains(document.activeElement)),{signal:abort.signal});
  measure();loadTimer=setTimeout(()=>restore(),30000);
  fetch(scene.dataset.manifest,{signal:abort.signal,cache:'no-cache'})
    .then(r=>{if(!r.ok)throw Error('Manifest unavailable');return r.json();})
    .then(data=>{if(active){manifest=data;revision='?v=scroll-20261116-1-'+encodeURIComponent(data.revision||'original');chooseFilm();}})
    .catch(()=>{if(active)restore();});
})();
