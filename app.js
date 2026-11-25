'use strict';

// ---------------------------------------------------------------------------
// Data sources
// ---------------------------------------------------------------------------

// US DOT / BTS National Transportation Noise Map tile caches. Both releases are
// rendered with the same seven colour classes.
const DATASETS = {
  2022: {
    label: '2022/23',
    detail: '2022 aviation and rail, 2023 roads',
    base: 'https://tiles.arcgis.com/tiles/xOi1kZaI0eWDREZv/arcgis/rest/services',
    services: {
      all: 'NTAD_Noise_2022_CONUS_aviation_rail_road',
      road: 'NTAD_Noise_2022_CONUS_road',
      rail: 'NTAD_Noise_2022_CONUS_rail',
      aviation: 'NTAD_Noise_2022_CONUS_aviation',
    },
  },
  2020: {
    label: '2020',
    detail: '2020 aviation, rail and roads',
    base: 'https://geo.dot.gov/server/rest/services/Hosted',
    services: {
      all: 'NTAD_Noise_2020_CONUS_Aviation_Road_Rail',
      road: 'NTAD_Noise_2020_CONUS_Road',
      rail: 'NTAD_Noise_2020_CONUS_Rail',
      aviation: 'NTAD_Noise_2020_CONUS_Aviation',
    },
  },
};
const SOURCES = {
  all: { name: 'All sources' },
  road: { name: 'Road' },
  rail: { name: 'Rail' },
  aviation: { name: 'Aviation' },
};
const PER_SOURCE = ['road', 'rail', 'aviation'];
let dataYear = '2022';
let mapSource = 'all';
const serviceUrl = (key, year = dataYear) => `${DATASETS[year].base}/${DATASETS[year].services[key]}/MapServer`;
const noiseTileUrl = key => `${serviceUrl(key)}/tile/{z}/{y}/{x}`;

// Westchester County GIS: address locator (address points + tax parcels) and parcel polygons.
const COUNTY_GIS = 'https://giswww.westchestergov.com/arcgis/rest/services';
const GEOCODER = `${COUNTY_GIS}/geocoding/GeocodeServer`;
const PARCELS = `${COUNTY_GIS}/DataHub_TaxParcels/MapServer/0`;
const WESTCHESTER = L.latLngBounds([40.875, -73.99], [41.37, -73.48]);

// The noise tiles are only cached down to zoom 12, which matches the model's
// native ~30 m grid. All readings are taken from zoom-12 pixels.
const DATA_ZOOM = 12;
const TILE = 256;
const WORLD_PX = TILE * 2 ** DATA_ZOOM;
const EARTH_CIRCUMFERENCE_M = 2 * Math.PI * 6378137;
const RINGS_M = [100, 250, 500];
const SEARCH_RADIUS_M = 500;

// Legend classes exactly as the DOT service renders them.
const BANDS = [
  { label: '45–50 dB', rgb: [255, 193, 7],  feel: 'Quiet. Distant traffic at most.' },
  { label: '50–55 dB', rgb: [255, 128, 0],  feel: 'Low background traffic hum.' },
  { label: '55–60 dB', rgb: [255, 0, 0],    feel: 'Moderate. Traffic is noticeable outdoors.' },
  { label: '60–70 dB', rgb: [255, 51, 153], feel: 'Loud. Typical next to a busy road or rail line.' },
  { label: '70–80 dB', rgb: [163, 0, 204],  feel: 'Very loud. Typical beside a highway.' },
  { label: '80–90 dB', rgb: [82, 0, 204],   feel: 'Extremely loud. On or right beside a highway.' },
  { label: '90+ dB',   rgb: [0, 0, 255],    feel: 'Extreme. Typically the roadway or runway itself.' },
];
BANDS.forEach(b => { b.hex = '#' + b.rgb.map(v => v.toString(16).padStart(2, '0')).join(''); });
const QUIET = { label: 'Under 45 dB', hex: '#dfe3ea', feel: 'Below the lowest level the map shows.' };
const bandInfo = i => (i < 0 ? QUIET : BANDS[i]);
const COLOR_TO_BAND = new Map(BANDS.map((b, i) => [b.rgb.join(','), i]));

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

const map = L.map('map', { minZoom: 8, maxZoom: 19, zoomSnap: 0.5 });
map.fitBounds(WESTCHESTER);

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
const esriTiles = (service, options) => L.tileLayer(`${ESRI}/${service}/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 19, ...options });

// Street labels sit in their own pane above the noise colours so they stay readable.
map.createPane('labels');
map.getPane('labels').style.zIndex = 350;
map.getPane('labels').style.pointerEvents = 'none';

const basemaps = {
  streets: L.layerGroup([
    esriTiles('Canvas/World_Light_Gray_Base', { maxNativeZoom: 16, zIndex: 1, attribution: 'Base map &copy; Esri, HERE, Garmin, OpenStreetMap contributors' }),
    esriTiles('Canvas/World_Light_Gray_Reference', { maxNativeZoom: 16, pane: 'labels' }),
  ]),
  aerial: L.layerGroup([
    esriTiles('World_Imagery', { zIndex: 1, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' }),
    esriTiles('Reference/World_Boundaries_and_Places', { pane: 'labels' }),
  ]),
};
let activeBasemap = basemaps.streets.addTo(map);

const noiseLayer = L.tileLayer(noiseTileUrl('all'), {
  maxNativeZoom: DATA_ZOOM,
  maxZoom: 19,
  opacity: 0.6,
  zIndex: 2,
  className: 'noise-tiles',
  crossOrigin: 'anonymous',
  attribution: 'Noise: <a href="https://www.bts.gov/geospatial/national-transportation-noise-map">US DOT BTS National Transportation Noise Map</a>',
}).addTo(map);

const overlay = L.layerGroup().addTo(map);
let houseMarker = null;
let currentLabel = '';
let currentPoint = null;

// ---------------------------------------------------------------------------
// Reading noise values from the tiles
// ---------------------------------------------------------------------------

function toWorldPx(lat, lng) {
  const s = Math.sin(lat * Math.PI / 180);
  return {
    x: (lng + 180) / 360 * WORLD_PX,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * WORLD_PX,
  };
}

function fromWorldPx(x, y) {
  const n = Math.PI - 2 * Math.PI * y / WORLD_PX;
  return L.latLng(180 / Math.PI * Math.atan(Math.sinh(n)), x / WORLD_PX * 360 - 180);
}

const metersPerPx = lat => EARTH_CIRCUMFERENCE_M * Math.cos(lat * Math.PI / 180) / WORLD_PX;

function classifyPixel(data, offset) {
  if (data[offset + 3] < 128) return -1;
  const r = data[offset], g = data[offset + 1], b = data[offset + 2];
  const exact = COLOR_TO_BAND.get(`${r},${g},${b}`);
  if (exact !== undefined) return exact;
  let best = -1, bestDist = Infinity;
  BANDS.forEach((band, i) => {
    const d = (band.rgb[0] - r) ** 2 + (band.rgb[1] - g) ** 2 + (band.rgb[2] - b) ** 2;
    if (d < bestDist) { bestDist = d; best = i; }
  });
  return best;
}

const tileCache = new Map();

function getNoiseTile(sourceKey, tx, ty) {
  const url = `${serviceUrl(sourceKey)}/tile/${DATA_ZOOM}/${ty}/${tx}`;
  if (!tileCache.has(url)) {
    const promise = loadNoiseTile(url);
    promise.catch(() => tileCache.delete(url));
    tileCache.set(url, promise);
  }
  return tileCache.get(url);
}

async function loadNoiseTile(url) {
  const res = await fetch(url);
  if (res.status === 404) return null; // no tile: nothing above 45 dB here
  if (!res.ok) throw new Error(`Noise data request failed (HTTP ${res.status})`);
  const bitmap = await createImageBitmap(await res.blob(), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = TILE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, TILE, TILE).data;
}

async function bandAt(sourceKey, lat, lng) {
  const { x, y } = toWorldPx(lat, lng);
  const px = Math.floor(x), py = Math.floor(y);
  const tx = Math.floor(px / TILE), ty = Math.floor(py / TILE);
  const data = await getNoiseTile(sourceKey, tx, ty);
  return data ? classifyPixel(data, ((py - ty * TILE) * TILE + (px - tx * TILE)) * 4) : -1;
}

// Every ~30 m grid cell whose centre lies within radiusM of the point.
async function cellsAround(sourceKey, lat, lng, radiusM) {
  const { x, y } = toWorldPx(lat, lng);
  const mpp = metersPerPx(lat);
  const r = radiusM / mpp;
  const x0 = Math.floor(x - r), x1 = Math.floor(x + r);
  const y0 = Math.floor(y - r), y1 = Math.floor(y + r);

  const tiles = new Map();
  const jobs = [];
  for (let ty = Math.floor(y0 / TILE); ty <= Math.floor(y1 / TILE); ty++) {
    for (let tx = Math.floor(x0 / TILE); tx <= Math.floor(x1 / TILE); tx++) {
      jobs.push(getNoiseTile(sourceKey, tx, ty).then(data => tiles.set(`${tx},${ty}`, data)));
    }
  }
  await Promise.all(jobs);

  const cells = [];
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const dx = px + 0.5 - x, dy = py + 0.5 - y;
      const dist = Math.hypot(dx, dy);
      if (dist > r) continue;
      const tx = Math.floor(px / TILE), ty = Math.floor(py / TILE);
      const data = tiles.get(`${tx},${ty}`);
      cells.push({
        px, py,
        band: data ? classifyPixel(data, ((py - ty * TILE) * TILE + (px - tx * TILE)) * 4) : -1,
        distM: dist * mpp,
        bearing: (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360,
      });
    }
  }
  return cells;
}

function loudestCell(cells) {
  let best = null;
  for (const c of cells) {
    if (!best || c.band > best.band || (c.band === best.band && c.distM < best.distM)) best = c;
  }
  return best;
}

function bandShares(cells, maxDistM) {
  const inside = cells.filter(c => c.distM <= maxDistM);
  const counts = new Array(BANDS.length + 1).fill(0); // index 0 = quiet
  inside.forEach(c => { counts[c.band + 1]++; });
  return { total: inside.length, shares: counts.map(n => (inside.length ? n / inside.length : 0)) };
}

// ---------------------------------------------------------------------------
// County address lookup and parcels
// ---------------------------------------------------------------------------

async function getJson(url, params) {
  const u = new URL(url);
  u.search = new URLSearchParams(params);
  const res = await fetch(u);
  if (!res.ok) throw new Error(`Request failed (HTTP ${res.status})`);
  const json = await res.json();
  if (json && json.error) throw new Error(json.error.message || 'Request failed');
  return json;
}

async function suggestAddresses(text) {
  const json = await getJson(`${GEOCODER}/suggest`, { text, maxSuggestions: 6, f: 'json' });
  return json.suggestions || [];
}

const LOCATOR_RANK = { AddressPoints: 0, TaxParcel: 1, Street: 2 };

async function geocode(text, magicKey) {
  const params = { SingleLine: text, outSR: 4326, maxLocations: 6, outFields: 'Loc_name,Addr_type', f: 'json' };
  if (magicKey) params.magicKey = magicKey;
  const json = await getJson(`${GEOCODER}/findAddressCandidates`, params);
  const candidates = (json.candidates || []).filter(c => c.score >= 80);
  candidates.sort((a, b) =>
    ((LOCATOR_RANK[a.attributes.Loc_name] ?? 9) - (LOCATOR_RANK[b.attributes.Loc_name] ?? 9)) || (b.score - a.score));
  const best = candidates[0];
  if (best) return { lat: best.location.y, lng: best.location.x, label: best.address };

  // Fallback for places the county locator doesn't know (e.g. landmarks).
  const osm = await getJson('https://nominatim.openstreetmap.org/search', {
    q: text, format: 'jsonv2', limit: 1, countrycodes: 'us', bounded: 1,
    viewbox: `${WESTCHESTER.getWest()},${WESTCHESTER.getNorth()},${WESTCHESTER.getEast()},${WESTCHESTER.getSouth()}`,
  });
  if (osm.length) return { lat: +osm[0].lat, lng: +osm[0].lon, label: osm[0].display_name.split(', ').slice(0, 3).join(', ') };
  return null;
}

async function fetchParcel(lat, lng) {
  const json = await getJson(`${PARCELS}/query`, {
    geometry: `${lng},${lat}`, geometryType: 'esriGeometryPoint', inSR: 4326,
    spatialRel: 'esriSpatialRelIntersects', outFields: 'OBJECTID', returnGeometry: true, outSR: 4326, f: 'geojson',
  });
  return json.features && json.features[0] ? json.features[0] : null;
}

// Outer rings of a GeoJSON Polygon/MultiPolygon, converted to world pixels.
function parcelRingsPx(feature) {
  const g = feature.geometry;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  return polys.map(p => p[0].map(([lng, lat]) => toWorldPx(lat, lng)));
}

function insideRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------------------
// Analysis and rendering
// ---------------------------------------------------------------------------

const $ = id => document.getElementById(id);
const escapeHtml = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compass = deg => COMPASS[Math.round(deg / 45) % 8];
const swatch = i => `<span class="swatch" style="background:${bandInfo(i).hex}"></span>`;

function setStatus(message, isError = false) {
  const el = $('status');
  el.textContent = message;
  el.classList.toggle('error', isError);
}

function describeSpot(cell, mpp) {
  if (!cell) return '—';
  if (cell.band < 0) return `${swatch(-1)} Under 45 dB`;
  const where = cell.distM < mpp * 0.75 ? 'at the house' : `${Math.round(cell.distM / 10) * 10} m ${compass(cell.bearing)}`;
  return `${swatch(cell.band)} ${bandInfo(cell.band).label}<div class="sub">${where}</div>`;
}

let runId = 0;

async function analyse(lat, lng, label) {
  const run = ++runId;
  currentLabel = label;
  currentPoint = { lat, lng };
  drawHouse(lat, lng);
  setStatus('Reading noise data…');

  const parcelPromise = fetchParcel(lat, lng).catch(() => null);
  const keys = ['all', ...PER_SOURCE];
  let readings;
  try {
    readings = await Promise.all(keys.map(async key => ({
      key,
      atHouse: await bandAt(key, lat, lng),
      cells: await cellsAround(key, lat, lng, SEARCH_RADIUS_M),
    })));
  } catch (err) {
    if (run === runId) setStatus(`Couldn't load the noise data: ${err.message}`, true);
    return;
  }
  const parcel = await parcelPromise;
  if (run !== runId) return; // a newer search started meanwhile

  const byKey = Object.fromEntries(readings.map(r => [r.key, r]));
  const all = byKey.all;
  const mpp = metersPerPx(lat);

  // Headline
  const head = bandInfo(all.atHouse);
  $('result-address').textContent = label;
  $('result-year').textContent = `${DATASETS[dataYear].label} data`;
  $('headline-swatch').style.background = head.hex;
  $('headline-db').textContent = head.label;
  $('headline-feel').textContent = head.feel;

  // Range across the lot, if the parcel covers more than one grid cell
  let lotText = '';
  if (parcel) {
    L.geoJSON(parcel, { style: { color: '#fff', opacity: 0.9, weight: 5, fill: false }, interactive: false }).addTo(overlay);
    L.geoJSON(parcel, { style: { color: '#1d2330', weight: 2, fill: false }, interactive: false }).addTo(overlay);
    const rings = parcelRingsPx(parcel);
    const lotCells = all.cells.filter(c => rings.some(ring => insideRing(c.px + 0.5, c.py + 0.5, ring)));
    if (lotCells.length > 1) {
      const lo = Math.min(...lotCells.map(c => c.band));
      const hi = Math.max(...lotCells.map(c => c.band));
      lotText = lo === hi
        ? `The whole lot (outlined) falls in the same band.`
        : `Across the lot (outlined), levels range from ${bandInfo(lo).label} to ${bandInfo(hi).label}.`;
    }
  }
  $('lot-range').textContent = lotText;

  // Per-source table
  $('source-rows').innerHTML = PER_SOURCE.map(key => {
    const r = byKey[key];
    return `<tr><td>${SOURCES[key].name}</td>
      <td>${swatch(r.atHouse)} ${bandInfo(r.atHouse).label}</td>
      <td>${describeSpot(loudestCell(r.cells), mpp)}</td></tr>`;
  }).join('');

  // Ring bars
  $('rings').innerHTML = RINGS_M.map(radius => {
    const { shares } = bandShares(all.cells, radius);
    const dominant = shares.indexOf(Math.max(...shares)) - 1;
    const loud = shares.slice(3).reduce((a, b) => a + b, 0); // 55 dB and up
    const segments = shares.map((share, idx) => share > 0
      ? `<span style="width:${(share * 100).toFixed(2)}%;background:${bandInfo(idx - 1).hex}" title="${bandInfo(idx - 1).label}: ${Math.round(share * 100)}%"></span>`
      : '').join('');
    const loudText = loud > 0 ? ` · ${Math.round(loud * 100)}% at 55 dB+` : '';
    return `<div class="ring">
      <div class="ring-head"><span>Within ${radius} m</span><span class="ring-summary">mostly ${bandInfo(dominant).label}${loudText}</span></div>
      <div class="bar">${segments}</div></div>`;
  }).join('');

  // Loudest nearby spot on the map
  const loudest = loudestCell(all.cells);
  if (loudest && loudest.band >= 0 && loudest.distM >= mpp * 0.75) {
    const spot = fromWorldPx(loudest.px + 0.5, loudest.py + 0.5);
    L.circleMarker(spot, { radius: 7, color: '#fff', weight: 2, fillColor: bandInfo(loudest.band).hex, fillOpacity: 1 })
      .bindTooltip(`Loudest within 500 m: ${bandInfo(loudest.band).label}`, { direction: 'top' })
      .addTo(overlay);
  }

  $('result').hidden = false;
  setStatus('');
}

function drawHouse(lat, lng) {
  overlay.clearLayers();
  RINGS_M.forEach(radius => {
    // White halo under a dark dashed line, so the ring reads on both street and aerial maps.
    L.circle([lat, lng], { radius, color: '#fff', opacity: 0.8, weight: 4, fill: false, interactive: false }).addTo(overlay);
    L.circle([lat, lng], { radius, color: '#1d2330', weight: 1.5, dashArray: '4 5', fill: false, interactive: false }).addTo(overlay);
    const labelAt = L.latLng(lat + radius / 111320, lng);
    L.marker(labelAt, {
      icon: L.divIcon({ className: '', html: `<span class="ring-label">${radius} m</span>`, iconSize: null }),
      interactive: false, keyboard: false,
    }).addTo(overlay);
  });

  if (!houseMarker) {
    houseMarker = L.marker([lat, lng], { draggable: true, title: 'House (drag to adjust)', zIndexOffset: 1000 }).addTo(map);
    houseMarker.on('dragend', () => {
      const p = houseMarker.getLatLng();
      analyse(p.lat, p.lng, currentLabel.replace(/ \(marker moved\)$/, '') + ' (marker moved)');
    });
  } else {
    houseMarker.setLatLng([lat, lng]);
  }
}

// Click anywhere: read all four layers at that spot.
map.on('click', async e => {
  const { lat, lng } = e.latlng;
  const popup = L.popup().setLatLng(e.latlng).setContent('<div class="point-popup">Reading…</div>').openOn(map);
  try {
    const bands = await Promise.all(['all', ...PER_SOURCE].map(k => bandAt(k, lat, lng)));
    const rows = PER_SOURCE.map((k, i) =>
      `<tr><td>${SOURCES[k].name}</td><td>${swatch(bands[i + 1])} ${bandInfo(bands[i + 1]).label}</td></tr>`).join('');
    popup.setContent(`<div class="point-popup">
      <div class="popup-title">${swatch(bands[0])} ${bandInfo(bands[0]).label} combined</div>
      <table>${rows}</table>
      <div class="popup-year">${DATASETS[dataYear].label} data</div></div>`);
  } catch (err) {
    popup.setContent(`<div class="point-popup">Couldn't read noise data here: ${escapeHtml(err.message)}</div>`);
  }
});

// ---------------------------------------------------------------------------
// Search box with county address suggestions
// ---------------------------------------------------------------------------

const input = $('address');
const list = $('suggestions');
let suggestions = [];
let highlighted = -1;
let suggestTimer = null;
let suggestRun = 0;

function renderSuggestions() {
  list.innerHTML = suggestions.map((s, i) =>
    `<li role="option" data-index="${i}" aria-selected="${i === highlighted}">${escapeHtml(s.text)}</li>`).join('');
  list.hidden = suggestions.length === 0;
  input.setAttribute('aria-expanded', String(!list.hidden));
}

function closeSuggestions() {
  suggestions = [];
  highlighted = -1;
  renderSuggestions();
}

input.addEventListener('input', () => {
  clearTimeout(suggestTimer);
  const text = input.value.trim();
  if (text.length < 3) { closeSuggestions(); return; }
  suggestTimer = setTimeout(async () => {
    const run = ++suggestRun;
    try {
      const found = await suggestAddresses(text);
      if (run !== suggestRun) return;
      suggestions = found;
      highlighted = -1;
      renderSuggestions();
    } catch { /* suggestions are optional */ }
  }, 200);
});

input.addEventListener('keydown', e => {
  if (list.hidden) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const step = e.key === 'ArrowDown' ? 1 : -1;
    highlighted = (highlighted + step + suggestions.length) % suggestions.length;
    renderSuggestions();
  } else if (e.key === 'Enter' && highlighted >= 0) {
    e.preventDefault();
    choose(suggestions[highlighted]);
  } else if (e.key === 'Escape') {
    closeSuggestions();
  }
});

list.addEventListener('mousedown', e => {
  const li = e.target.closest('li');
  if (!li) return;
  e.preventDefault();
  choose(suggestions[+li.dataset.index]);
});

input.addEventListener('blur', () => setTimeout(closeSuggestions, 100));

$('search').addEventListener('submit', e => {
  e.preventDefault();
  const text = input.value.trim();
  if (text) search(text);
});

function choose(suggestion) {
  input.value = suggestion.text;
  closeSuggestions();
  search(suggestion.text, suggestion.magicKey);
}

async function search(text, magicKey) {
  clearTimeout(suggestTimer);
  suggestRun++;
  closeSuggestions();
  setStatus('Finding address…');
  let place;
  try {
    place = await geocode(text, magicKey);
  } catch (err) {
    setStatus(`Address lookup failed: ${err.message}`, true);
    return;
  }
  if (!place) {
    setStatus("Couldn't find that address in Westchester County. Try adding the town or ZIP code.", true);
    return;
  }
  map.fitBounds(L.latLng(place.lat, place.lng).toBounds(SEARCH_RADIUS_M * 2.2));
  analyse(place.lat, place.lng, place.label);
}

// ---------------------------------------------------------------------------
// Layer controls and legend
// ---------------------------------------------------------------------------

function wireSegmented(containerId, attr, onChange) {
  const container = $(containerId);
  container.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    container.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
    onChange(btn.dataset[attr]);
  });
}

wireSegmented('source-toggle', 'source', key => {
  mapSource = key;
  noiseLayer.setUrl(noiseTileUrl(key));
});
wireSegmented('year-toggle', 'year', year => {
  dataYear = year;
  noiseLayer.setUrl(noiseTileUrl(mapSource));
  map.closePopup();
  if (currentPoint) analyse(currentPoint.lat, currentPoint.lng, currentLabel);
});
wireSegmented('basemap-toggle', 'basemap', key => {
  map.removeLayer(activeBasemap);
  activeBasemap = basemaps[key].addTo(map);
});
$('opacity').addEventListener('input', e => noiseLayer.setOpacity(e.target.value / 100));

$('legend').innerHTML = [...BANDS.map((b, i) => i), -1].map(i =>
  `<li>${swatch(i)}<span>${bandInfo(i).label}</span><span class="feel">${bandInfo(i).feel}</span></li>`).join('');
