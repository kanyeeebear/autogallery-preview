/* Browser-only demo controls; no customer data is sent or stored. */
(async () => {
  'use strict';
  const data = await fetch('/autogallery-preview/preview-data.json').then(r => r.json());
  const params = new URLSearchParams(location.search);
  for (const form of document.querySelectorAll('form[data-preview-readonly]')) {
    form.addEventListener('submit', e => e.preventDefault());
    const intent = form.querySelector('[name=intent]');
    if (intent && ['viewing','finance','import','general'].includes(params.get('intent'))) intent.value = params.get('intent');
    const car = data.find(v => v.id === params.get('vehicle'));
    if (car) {
      const intro = document.querySelector('.lead-intro');
      const selected = document.createElement('div'); selected.className = 'selected-vehicle';
      const label = document.createElement('span'); label.textContent = 'Демонстраційний запит щодо авто';
      const link = document.createElement('a'); link.href = car.url; link.textContent = car.title;
      selected.append(label, link); intro?.append(selected);
    }
  }
  const form = document.getElementById('catalog-filters');
  if (!form) return;
  for (const input of form.elements) {
    if (!input.name || !params.has(input.name)) continue;
    if (input.type === 'checkbox') input.checked = params.getAll(input.name).includes(input.value);
    else input.value = params.get(input.name);
  }
  const value = key => params.get(key) || '';
  const numeric = key => value(key) !== '' && Number.isFinite(Number(value(key))) ? Number(value(key)) : null;
  const currency = ['USD','EUR','UAH'].includes(value('currency')) ? value('currency') : 'USD';
  const exact = ['brand','model','body_type','fuel_type','transmission','drive_type'];
  let cars = data.filter(car => car.currency === currency && exact.every(key => !value(key) || String(car[key]) === value(key)));
  for (const [key,field,lower] of [['min_price','price',true],['max_price','price',false],['min_year','year',true],['max_year','year',false],['max_mileage','mileage',false]]) {
    const n = numeric(key);
    if (n !== null) cars = cars.filter(car => lower ? Number(car[field]) >= n : Number(car[field]) <= n);
  }
  if (params.getAll('features').length) cars = cars.filter(car => params.getAll('features').every(v => car.features.includes(v)));
  const comparators = {price_asc:(a,b)=>Number(a.price)-Number(b.price),price_desc:(a,b)=>Number(b.price)-Number(a.price),year_desc:(a,b)=>b.year-a.year,mileage_asc:(a,b)=>a.mileage-b.mileage};
  if (comparators[value('sort')]) cars.sort(comparators[value('sort')]);
  const size = Math.max(1,Math.min(100,Math.floor(numeric('page_size') || 12)));
  const pages = Math.max(1,Math.ceil(cars.length / size));
  const page = Math.max(1,Math.min(pages,Math.floor(numeric('page') || 1)));
  const shown = cars.slice((page-1)*size,page*size);
  const grid = form.querySelector('.cars');
  const nodes = new Map(Array.from(grid.querySelectorAll('.car-card')).map(el => [new URL(el.querySelector('a').href).pathname,el]));
  nodes.forEach(el => {el.style.display='none'});
  for (const car of shown) {const el=nodes.get(car.url);if(el){el.style.display='';grid.append(el)}}
  if (!cars.length) {
    const empty = document.createElement('div');empty.className='empty-state';
    const title=document.createElement('h2');title.textContent='За вибраними умовами автомобілів не знайдено';
    const message=document.createElement('p');message.textContent='У цій демонстрації три автомобілі. Змініть умови пошуку, щоб переглянути їх.';
    const reset=document.createElement('a');reset.className='button primary';reset.href='/autogallery-preview/cars.html';reset.textContent='Скинути фільтри';
    empty.append(title,message,reset);grid.append(empty);
  }
  const pagination=form.querySelector('.pagination');
  if(pagination){
    pagination.replaceChildren();
    const link=(number,label)=>{const a=document.createElement('a');const q=new URLSearchParams(params);q.set('page',number);a.href='/autogallery-preview/cars.html?'+q;a.className='button outline';a.textContent=label;return a};
    if(page>1)pagination.append(link(page-1,'Попередня'));
    const label=document.createElement('span');label.textContent=`Сторінка ${page} з ${pages} · Автомобілів: ${cars.length}`;pagination.append(label);
    if(page<pages)pagination.append(link(page+1,'Наступна'));
  }
  const note=form.querySelector('.catalog-meta>p');if(note)note.textContent=`Ціни та результати показано у ${currency}. Валюти не перераховуються.`;
})().catch(() => {
  // The initial, labelled catalogue remains visible if optional filtering fails.
});
