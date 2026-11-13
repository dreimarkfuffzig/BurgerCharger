// BurgerCharger – Supercharger mit passendem Restaurant in Laufweite, entlang einer Route.
/* global maplibregl */

const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const GEOCODER = 'https://photon.komoot.io/api/';
const ROUTER = 'https://router.project-osrm.org/route/v1/driving/';
const BBOX = '2.5,45.5,17.5,58.2'; // grob NL/DE/DK/CH/AT, bevorzugt Treffer in der Region
const STORE_KEY = 'burgercharger.v1';
const CAT_LABELS = {
  fast_food: 'Fast Food', restaurant: 'Restaurants', cafe: 'Cafés', food_court: 'Food Courts',
  ice_cream: 'Eis', bakery: 'Bäckereien', supermarket: 'Supermärkte', convenience: 'Shops & Kioske',
};
const CAT_ORDER = Object.keys(CAT_LABELS);

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...children);
  return n;
};

const state = {
  data: null,
  chainByKey: new Map(),
  selected: new Set(),
  radius: 200,
  corridor: 5,
  start: null,   // {lat, lon, label}
  dest: null,
  route: null,   // {coords, cum, distance, duration}
  routeInfo: new Map(), // siteId -> {off, along} in Metern
  userPos: null,
  openId: null,
  results: [],
};

// ---------- Persistenz (nur Komfort, App funktioniert auch ohne) ----------
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (!p) return false;
    if (Array.isArray(p.selected)) state.selected = new Set(p.selected);
    if (p.radius) state.radius = p.radius;
    if (p.corridor) state.corridor = p.corridor;
    return Array.isArray(p.selected);
  } catch { return false; }
}
function savePrefs() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      selected: [...state.selected], radius: state.radius, corridor: state.corridor,
    }));
  } catch { /* egal */ }
}

// ---------- Geometrie ----------
const RAD = Math.PI / 180;
function haversine(lat1, lon1, lat2, lon2) {
  const a = Math.sin((lat2 - lat1) * RAD / 2) ** 2
    + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin((lon2 - lon1) * RAD / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(a));
}

function prepareRoute(coords) {
  const cum = new Float64Array(coords.length);
  for (let i = 1; i < coords.length; i++) {
    cum[i] = cum[i - 1] + haversine(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
  }
  return cum;
}

// Kürzester Abstand eines Punkts zur Route und Position entlang der Route (beides in Metern).
function projectOnRoute(lat, lon, coords, cum) {
  const ky = 110540, kx = 111320 * Math.cos(lat * RAD);
  let best = Infinity, along = 0;
  let ax = (coords[0][0] - lon) * kx, ay = (coords[0][1] - lat) * ky;
  for (let i = 1; i < coords.length; i++) {
    const bx = (coords[i][0] - lon) * kx, by = (coords[i][1] - lat) * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? -(ax * dx + ay * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + t * dx, py = ay + t * dy;
    const d2 = px * px + py * py;
    if (d2 < best) { best = d2; along = cum[i - 1] + t * (cum[i] - cum[i - 1]); }
    ax = bx; ay = by;
  }
  return { off: Math.sqrt(best), along };
}

// ---------- Formatierung ----------
const fmtKm = (m) => (m >= 10000 ? Math.round(m / 1000) : (m / 1000).toFixed(1).replace('.', ',')) + ' km';
const fmtDur = (s) => {
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
};
const chainLabel = (k, fallback) => state.chainByKey.get(k)?.label || fallback;

// ---------- Karte ----------
const map = new maplibregl.Map({
  container: 'map', style: MAP_STYLE, center: [10.2, 51.2], zoom: 5,
  attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false,
});
map.touchZoomRotate.disableRotation();
map.addControl(new maplibregl.GeolocateControl({
  positionOptions: { enableHighAccuracy: true }, trackUserLocation: true,
}), 'top-right');

const emptyFC = () => ({ type: 'FeatureCollection', features: [] });
const mapReady = new Promise((res) => map.on('load', res));

async function setupLayers() {
  await mapReady;
  map.addSource('route', { type: 'geojson', data: emptyFC() });
  map.addSource('sites', { type: 'geojson', data: emptyFC() });
  map.addLayer({ id: 'route-case', type: 'line', source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': 8 } });
  map.addLayer({ id: 'route-line', type: 'line', source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#1a73e8', 'line-width': 5 } });
  map.addLayer({ id: 'sites-other', type: 'circle', source: 'sites',
    filter: ['!=', ['get', 'kind'], 'hit'],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 2.5, 10, 5],
      'circle-color': ['case', ['==', ['get', 'kind'], 'far'], '#e9a39d', '#8a8a94'],
      'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1, 'circle-opacity': 0.85,
    } });
  map.addLayer({ id: 'sites-hit', type: 'circle', source: 'sites',
    filter: ['==', ['get', 'kind'], 'hit'],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 6, 10, 11],
      'circle-color': ['case', ['get', 'open'], '#16161a', '#c62828'],
      'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5,
    } });
  for (const layer of ['sites-hit', 'sites-other']) {
    map.on('click', layer, (e) => {
      const id = e.features[0].properties.id;
      openSite(id, { fly: false, scroll: true });
    });
    map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
  }
}

// ---------- Kernlogik ----------
function hitsFor(site) {
  return site.pois.filter((p) => state.selected.has(p.k) && p.d <= state.radius);
}

function compute() {
  const { sites } = state.data;
  const maxOff = state.corridor * 1000;
  const features = [];
  const results = [];
  for (const s of sites) {
    const hits = hitsFor(s);
    const info = state.route ? state.routeInfo.get(s.id) : null;
    let kind = 'none';
    if (hits.length) kind = !state.route || info.off <= maxOff ? 'hit' : 'far';
    if (kind === 'hit') {
      const dist = !state.route && state.userPos
        ? haversine(state.userPos.lat, state.userPos.lon, s.lat, s.lon) : null;
      results.push({ site: s, hits, info, dist });
    }
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      properties: { id: s.id, kind, open: s.id === state.openId } });
  }
  if (state.route) results.sort((a, b) => a.info.along - b.info.along);
  else if (state.userPos) results.sort((a, b) => a.dist - b.dist);
  else results.sort((a, b) => a.site.name.localeCompare(b.site.name, 'de'));
  state.results = results;
  map.getSource('sites')?.setData({ type: 'FeatureCollection', features });
  renderResults();
}

function renderResults() {
  const { results, route } = state;
  const summary = $('summary');
  summary.classList.remove('error');
  summary.replaceChildren();
  if (!state.selected.size) {
    summary.textContent = 'Wähle mindestens eine Kette aus.';
  } else if (route) {
    summary.append(`${results.length} passende Supercharger auf der Route`,
      el('small', {}, `${fmtKm(route.distance)} · ${fmtDur(route.duration)} reine Fahrzeit`));
  } else {
    summary.append(`${results.length} passende Supercharger`,
      el('small', {}, state.userPos ? 'Sortiert nach Entfernung zu dir.' : 'Gib Start und Ziel ein, um nur die Route zu sehen.'));
  }
  const list = $('results');
  list.replaceChildren(...results.slice(0, 150).map(renderItem));
}

function renderItem({ site, hits, info, dist }) {
  const li = el('li', { id: `site-${site.id}` });
  li.dataset.id = site.id;
  const lead = info ? `km ${Math.round(info.along / 1000)}` : dist != null ? fmtKm(dist) : site.cc;
  const meta = [site.stalls ? `${site.stalls} Stalls` : null, site.kw ? `${site.kw} kW` : null].filter(Boolean).join(' · ');
  li.append(el('div', { className: 'r-head' },
    el('span', { className: 'r-km' }, lead),
    el('span', { className: 'r-name' }, site.name),
    el('span', { className: 'r-meta' }, meta)));

  // Pro Kette nur den nächsten Treffer zeigen
  const nearest = new Map();
  for (const h of hits) if (!nearest.has(h.k)) nearest.set(h.k, h);
  li.append(el('div', { className: 'r-hits' },
    [...nearest.values()].map((h) => `${chainLabel(h.k, h.n)} ${h.d} m`).join(' · ')));

  if (site.id === state.openId) li.append(renderDetail(site, info));
  li.addEventListener('click', (e) => {
    if (e.target.closest('.r-detail')) return;
    openSite(site.id === state.openId ? null : site.id, { fly: true, scroll: false });
  });
  return li;
}

function renderDetail(site, info) {
  const box = el('div', { className: 'r-detail' });
  const addr = [site.street, site.city].filter(Boolean).join(', ');
  box.append(el('p', {}, addr + (info ? ` · ${fmtKm(info.off)} abseits der Route` : '')));
  const ul = el('ul');
  for (const p of site.pois.filter((p) => p.d <= state.radius)) {
    const hit = state.selected.has(p.k);
    const name = el('span', {}, p.n);
    if (p.oh) name.append(el('small', {}, p.oh));
    ul.append(el('li', { className: hit ? 'hit' : '' }, name, el('span', {}, `${p.d} m`)));
  }
  box.append(ul);

  const title = `${site.name} Supercharger`;
  const mapsUrl = `https://maps.apple.com/?ll=${site.lat},${site.lon}&q=${encodeURIComponent(title)}`;
  const actions = el('div', { className: 'r-actions' });
  if (navigator.share) {
    const share = el('button', { type: 'button', className: 'primary' }, 'Teilen / an Tesla');
    share.addEventListener('click', () => navigator.share({ title, url: mapsUrl }).catch(() => {}));
    actions.append(share);
  }
  actions.append(el('a', { href: mapsUrl, target: '_blank', rel: 'noopener' }, 'Apple Maps'));
  const copy = el('button', { type: 'button' }, 'Name kopieren');
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(title); copy.textContent = 'Kopiert ✓'; }
    catch { copy.textContent = 'Kopieren nicht möglich'; }
    setTimeout(() => { copy.textContent = 'Name kopieren'; }, 1500);
  });
  actions.append(copy);
  box.append(actions);
  return box;
}

function openSite(id, { fly, scroll }) {
  state.openId = id;
  const site = id != null && state.data.sites.find((s) => s.id === id);
  // Angetippter Marker ohne Treffer: trotzdem in der Liste zeigen wäre verwirrend -> nur Karte zentrieren
  compute();
  if (!site) return;
  $('sheet').classList.remove('min');
  if (fly) map.flyTo({ center: [site.lon, site.lat], zoom: Math.max(map.getZoom(), 13), padding: mapPadding() });
  if (scroll) document.getElementById(`site-${id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

const mapPadding = () => ({ top: 60, left: 40, right: 40, bottom: $('sheet').offsetHeight + 30 });

// ---------- Routing ----------
async function updateRoute() {
  const { start, dest } = state;
  if (!start || !dest) {
    state.route = null;
    state.routeInfo.clear();
    map.getSource('route')?.setData(emptyFC());
    compute();
    return;
  }
  $('summary').classList.remove('error');
  $('summary').textContent = 'Berechne Route …';
  try {
    const url = `${ROUTER}${start.lon},${start.lat};${dest.lon},${dest.lat}?overview=full&geometries=geojson`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const r = json.routes?.[0];
    if (!r) throw new Error('keine Route gefunden');
    const coords = r.geometry.coordinates;
    const cum = prepareRoute(coords);
    state.route = { coords, cum, distance: r.distance, duration: r.duration };
    state.routeInfo.clear();
    for (const s of state.data.sites) state.routeInfo.set(s.id, projectOnRoute(s.lat, s.lon, coords, cum));
    map.getSource('route').setData({ type: 'Feature', geometry: r.geometry, properties: {} });
    const b = coords.reduce((bb, c) => bb.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
    map.fitBounds(b, { padding: mapPadding(), duration: 600 });
    state.openId = null;
    compute();
  } catch (err) {
    state.route = null;
    state.routeInfo.clear();
    map.getSource('route')?.setData(emptyFC());
    compute();
    $('summary').classList.add('error');
    $('summary').textContent = `Route konnte nicht berechnet werden (${err.message}).`;
  }
}

// ---------- Ortssuche ----------
function placeLabel(p) {
  const main = p.name || [p.street, p.housenumber].filter(Boolean).join(' ') || p.city || '';
  const sub = [p.name && p.street ? [p.street, p.housenumber].filter(Boolean).join(' ') : null,
    [p.postcode, p.city !== main ? p.city : null].filter(Boolean).join(' '), p.country]
    .filter(Boolean).join(', ');
  return { main, sub };
}

function setupSearch(inputId, key) {
  const input = $(inputId), box = $(`${inputId}-suggest`);
  let timer, seq = 0;
  const close = () => { box.hidden = true; box.replaceChildren(); };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (state[key]) { state[key] = null; updateRoute(); }
    if (q.length < 3) return close();
    timer = setTimeout(async () => {
      const my = ++seq;
      try {
        const res = await fetch(`${GEOCODER}?q=${encodeURIComponent(q)}&limit=5&lang=de&bbox=${BBOX}`);
        const json = await res.json();
        if (my !== seq) return;
        box.replaceChildren(...json.features.map((f) => {
          const { main, sub } = placeLabel(f.properties);
          const li = el('li', {}, main, el('small', {}, sub));
          li.addEventListener('click', () => {
            const [lon, lat] = f.geometry.coordinates;
            input.value = [main, f.properties.city !== main ? f.properties.city : null].filter(Boolean).join(', ');
            state[key] = { lat, lon, label: input.value };
            close(); input.blur(); updateRoute();
          });
          return li;
        }));
        box.hidden = !json.features.length;
      } catch { close(); }
    }, 300);
  });
  input.addEventListener('blur', () => setTimeout(close, 250));
  input.form.addEventListener('submit', (e) => { e.preventDefault(); box.querySelector('li')?.click(); });
}

function useMyLocation() {
  const btn = $('locate');
  if (!navigator.geolocation) return;
  btn.classList.add('busy');
  navigator.geolocation.getCurrentPosition((pos) => {
    btn.classList.remove('busy');
    state.userPos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    state.start = { ...state.userPos, label: 'Mein Standort' };
    $('start').value = 'Mein Standort';
    if (!state.dest) map.flyTo({ center: [state.userPos.lon, state.userPos.lat], zoom: 8, padding: mapPadding() });
    updateRoute();
  }, () => {
    btn.classList.remove('busy');
    $('summary').classList.add('error');
    $('summary').textContent = 'Standort nicht verfügbar – bitte in den Einstellungen erlauben.';
  }, { enableHighAccuracy: false, timeout: 10000 });
}

// ---------- Kettenwahl ----------
function renderChips() {
  const food = state.data.chains.filter((c) => c.cat === 'fast_food' || c.cat === 'restaurant' || c.cat === 'cafe');
  const top = food.slice(0, 8).map((c) => c.k);
  const keys = [...new Set([...[...state.selected].filter((k) => state.chainByKey.has(k)), ...top])];
  keys.sort((a, b) => (state.selected.has(b) - state.selected.has(a))
    || state.chainByKey.get(b).sites - state.chainByKey.get(a).sites);
  const chips = keys.map((k) => {
    const b = el('button', { type: 'button', className: 'chip' }, state.chainByKey.get(k).label);
    b.setAttribute('aria-pressed', state.selected.has(k));
    b.addEventListener('click', () => toggleChain(k));
    return b;
  });
  const more = el('button', { type: 'button', className: 'chip more' }, 'Mehr …');
  more.addEventListener('click', openChainDialog);
  $('chips').replaceChildren(...chips, more);
}

function toggleChain(k, on = !state.selected.has(k)) {
  if (on) state.selected.add(k); else state.selected.delete(k);
  savePrefs();
  renderChips();
  compute();
}

function renderChainList() {
  const q = $('chain-search').value.trim().toLowerCase();
  const groups = new Map();
  for (const c of state.data.chains) {
    if (q && !c.label.toLowerCase().includes(q)) continue;
    if (!groups.has(c.cat)) groups.set(c.cat, []);
    groups.get(c.cat).push(c);
  }
  const out = [];
  const cats = [...groups.keys()].sort((a, b) => (CAT_ORDER.indexOf(a) + 99) % 99 - (CAT_ORDER.indexOf(b) + 99) % 99);
  for (const cat of cats) {
    out.push(el('h3', {}, CAT_LABELS[cat] || cat));
    for (const c of groups.get(cat)) {
      const cb = el('input', { type: 'checkbox', checked: state.selected.has(c.k) });
      cb.addEventListener('change', () => toggleChain(c.k, cb.checked));
      out.push(el('label', {}, cb, el('span', {}, c.label), el('small', {}, `${c.sites}`)));
    }
  }
  $('chain-list').replaceChildren(...out);
}
function openChainDialog() {
  $('chain-search').value = '';
  renderChainList();
  $('chain-dialog').showModal();
}

// ---------- Start ----------
async function init() {
  const hadPrefs = loadPrefs();
  $('radius').value = state.radius;
  $('radius-out').textContent = `${state.radius} m`;
  $('corridor').value = String(state.corridor);

  $('handle').addEventListener('click', () => $('sheet').classList.toggle('min'));
  $('radius').addEventListener('input', (e) => {
    state.radius = +e.target.value;
    $('radius-out').textContent = `${state.radius} m`;
    savePrefs(); compute();
  });
  $('corridor').addEventListener('change', (e) => { state.corridor = +e.target.value; savePrefs(); compute(); });
  $('locate').addEventListener('click', useMyLocation);
  $('swap').addEventListener('click', () => {
    [state.start, state.dest] = [state.dest, state.start];
    $('start').value = state.start?.label || '';
    $('dest').value = state.dest?.label || '';
    updateRoute();
  });
  $('chain-close').addEventListener('click', () => $('chain-dialog').close());
  $('chain-search').addEventListener('input', renderChainList);
  setupSearch('start', 'start');
  setupSearch('dest', 'dest');

  try {
    const [data] = await Promise.all([
      fetch('data/sites.json').then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
      setupLayers(),
    ]);
    state.data = data;
    state.chainByKey = new Map(data.chains.map((c) => [c.k, c]));
    if (!hadPrefs) {
      const bk = data.chains.find((c) => /burger king/i.test(c.label));
      if (bk) state.selected.add(bk.k);
    }
    $('footer').append(`Datenstand ${data.generated} · ${data.sites.length} Supercharger · Quellen: `,
      el('a', { href: 'https://supercharge.info', target: '_blank', rel: 'noopener' }, 'supercharge.info'),
      ', © ', el('a', { href: 'https://www.openstreetmap.org/copyright', target: '_blank', rel: 'noopener' }, 'OpenStreetMap'), '-Mitwirkende');
    renderChips();
    compute();
  } catch (err) {
    $('summary').classList.add('error');
    $('summary').textContent = `Daten konnten nicht geladen werden (${err.message}).`;
  }
}

init();
