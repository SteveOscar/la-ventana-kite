// Pulls coastline, roads, buildings and place names around La Ventana from
// OpenStreetMap (Overpass API) and converts them to local game coordinates.
//
//   node tools/fetch-osm.mjs -> public/data/osm.json
//
// Data (c) OpenStreetMap contributors, ODbL.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CACHE = path.join(ROOT, '.cache');
const OUT = CACHE;
const meta = JSON.parse(fs.readFileSync(path.join(CACHE, 'dem', 'dem.json'), 'utf8'));
const { origin, mPerDegLat, mPerDegLon } = meta;

const toLocal = (lat, lon) => [
  Math.round((lon - origin.lon) * mPerDegLon * 10) / 10,
  Math.round(-(lat - origin.lat) * mPerDegLat * 10) / 10,
];

const WIDE = '23.80,-110.40,24.55,-109.55';
const NEAR = '23.98,-110.10,24.16,-109.92';
const QUERY = `[out:json][timeout:120];
(
  way["natural"="coastline"](${WIDE});
  way["highway"](${NEAR});
  way["building"](${NEAR});
  node["place"](${WIDE});
  node["amenity"](${NEAR});
  node["tourism"](${NEAR});
  node["leisure"](${NEAR});
  way["leisure"](${NEAR});
  way["tourism"](${NEAR});
  way["amenity"](${NEAR});
  way["landuse"](${NEAR});
  way["natural"~"beach|sand|wetland|water"](${NEAR});
  way["waterway"](${NEAR});
);
out geom;`;

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

async function fetchRaw() {
  const cached = path.join(CACHE, 'osm-raw.json');
  if (fs.existsSync(cached)) {
    try {
      return JSON.parse(fs.readFileSync(cached, 'utf8'));
    } catch {
      fs.unlinkSync(cached);
    }
  }
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'la-ventana-kite-game/0.1 (personal hobby project)',
          Accept: 'application/json',
        },
        body: 'data=' + encodeURIComponent(QUERY),
        signal: AbortSignal.timeout(150000),
      });
      const text = await res.text();
      if (!res.ok || !text.trimStart().startsWith('{')) {
        console.warn(`${url}: HTTP ${res.status}`);
        continue;
      }
      fs.mkdirSync(CACHE, { recursive: true });
      fs.writeFileSync(cached, text);
      return JSON.parse(text);
    } catch (err) {
      console.warn(`${url}: ${err.message}`);
    }
  }
  throw new Error('all Overpass endpoints failed');
}

const raw = await fetchRaw();
const out = { attribution: '(c) OpenStreetMap contributors (ODbL)', coastline: [], roads: [], buildings: [], places: [], pois: [], areas: [], waterways: [] };

for (const e of raw.elements) {
  const t = e.tags || {};
  const geom = e.geometry ? e.geometry.map((p) => toLocal(p.lat, p.lon)) : null;
  if (e.type === 'way' && t.natural === 'coastline') {
    out.coastline.push(geom);
  } else if (e.type === 'way' && t.highway) {
    out.roads.push({ kind: t.highway, surface: t.surface || null, pts: geom });
  } else if (e.type === 'way' && t.building) {
    out.buildings.push({ kind: t.building, levels: Number(t['building:levels']) || null, pts: geom });
  } else if (e.type === 'node' && t.place) {
    out.places.push({ kind: t.place, name: t.name || null, p: toLocal(e.lat, e.lon) });
  } else if (e.type === 'node' && (t.amenity || t.tourism || t.leisure)) {
    out.pois.push({ kind: t.amenity || t.tourism || t.leisure, p: toLocal(e.lat, e.lon) });
  } else if (e.type === 'way' && t.waterway) {
    out.waterways.push({ kind: t.waterway, pts: geom });
  } else if (e.type === 'way') {
    const kind = t.amenity || t.tourism || t.leisure || t.landuse || t.natural;
    if (kind && geom) out.areas.push({ kind, pts: geom });
  }
}

fs.writeFileSync(path.join(OUT, 'osm.json'), JSON.stringify(out));
const count = (k) => out[k].length;
console.log(
  `coastline ${count('coastline')}, roads ${count('roads')}, buildings ${count('buildings')}, places ${count('places')}, pois ${count('pois')}, areas ${count('areas')}, waterways ${count('waterways')}`,
);
for (const p of out.places) console.log('place', p.kind, p.name, p.p.join(', '));
