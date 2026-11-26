// Builds the game's terrain data from the cached DEM and OpenStreetMap extracts.
//
//   node tools/build-terrain.mjs
//
// SRTM has no bathymetry here (the sea is a noisy 0 m), so the sea floor is
// synthesised from the distance to the OSM coastline, and the beach is reshaped
// into a gentle profile. Outputs go to public/data/.
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CACHE = path.join(ROOT, '.cache');
const OUT = path.join(ROOT, 'public', 'data');
fs.mkdirSync(OUT, { recursive: true });

const dem = JSON.parse(fs.readFileSync(path.join(CACHE, 'dem', 'dem.json'), 'utf8'));
const osm = JSON.parse(fs.readFileSync(path.join(CACHE, 'osm.json'), 'utf8'));

const loadGrid = (name) => {
  const g = dem.grids[name];
  const buf = fs.readFileSync(path.join(CACHE, 'dem', `dem-${name}.bin`));
  const q = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
  const data = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) data[i] = q[i] * g.scale;
  return { ...g, data };
};

// ---------------------------------------------------------------- coastline
const segs = [];
for (const line of osm.coastline) {
  for (let i = 0; i + 1 < line.length; i++) segs.push([line[i][0], line[i][1], line[i + 1][0], line[i + 1][1]]);
}
const BUCKET = 250;
const buckets = new Map();
const bkey = (bx, bz) => bx * 100003 + bz;
for (let s = 0; s < segs.length; s++) {
  const [ax, az, bx, bz] = segs[s];
  const x0 = Math.floor(Math.min(ax, bx) / BUCKET), x1 = Math.floor(Math.max(ax, bx) / BUCKET);
  const z0 = Math.floor(Math.min(az, bz) / BUCKET), z1 = Math.floor(Math.max(az, bz) / BUCKET);
  for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) {
    const k = bkey(i, j);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(s);
  }
}

// Signed distance to the coastline: positive on land, negative at sea.
// OSM coastlines keep land on the left of the way direction; with x east and
// z south that is a negative x/z cross product.
function signedDistance(px, pz, maxDist) {
  const cbx = Math.floor(px / BUCKET), cbz = Math.floor(pz / BUCKET);
  let best = Infinity, bestSign = 0;
  const maxRing = Math.ceil(maxDist / BUCKET) + 1;
  for (let ring = 0; ring <= maxRing; ring++) {
    if (best < (ring - 1) * BUCKET) break;
    for (let i = -ring; i <= ring; i++) for (let j = -ring; j <= ring; j++) {
      if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
      const list = buckets.get(bkey(cbx + i, cbz + j));
      if (!list) continue;
      for (const s of list) {
        const [ax, az, bx, bz] = segs[s];
        const dx = bx - ax, dz = bz - az;
        const len2 = dx * dx + dz * dz || 1e-9;
        let t = ((px - ax) * dx + (pz - az) * dz) / len2;
        t = Math.max(0, Math.min(1, t));
        const cx = ax + t * dx, cz = az + t * dz;
        const d = Math.hypot(px - cx, pz - cz);
        if (d < best - 1e-6) {
          best = d;
          const cross = dx * (pz - az) - dz * (px - ax);
          // At segment endpoints the cross product is unreliable; use the
          // direction to the closest point against the segment normal instead.
          bestSign = cross < 0 ? 1 : -1;
        }
      }
    }
  }
  return best === Infinity ? null : bestSign * best;
}

// Deterministic value noise for small seabed and beach variation.
function hash2(i, j) {
  let h = (i * 374761393 + j * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x, z) {
  const i = Math.floor(x), j = Math.floor(z);
  const fx = x - i, fz = z - j;
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  const a = hash2(i, j), b = hash2(i + 1, j), c = hash2(i, j + 1), d = hash2(i + 1, j + 1);
  return (a * (1 - ux) + b * ux) * (1 - uz) + (c * (1 - ux) + d * ux) * uz;
}
const smoothstep = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function seabed(d, x, z) {
  // d = distance offshore (m). Turquoise shelf near the beach, then a steady drop.
  const bars = (vnoise(x / 90, z / 260) - 0.5) * 1.2 * Math.exp(-d / 400);
  const h = -(0.35 + 3.3 * (1 - Math.exp(-d / 55)) + d * 0.018) + bars;
  return Math.max(-90, h);
}

function landHeight(d, raw, x, z) {
  // d = distance inland (m). Gentle beach, berm, then the DEM.
  const beach = 0.25 + d * 0.038 + (vnoise(x / 40, z / 120) - 0.5) * 0.3 * smoothstep(10, 40, d);
  const demH = Math.max(raw, 0.8 + d * 0.006);
  const w = smoothstep(35, 140, d);
  return Math.max(0.15, beach * (1 - w) + demH * w);
}

function buildComposite(name, maxDist) {
  const g = loadGrid(name);
  const height = new Float32Array(g.nx * g.nz);
  const sdf = new Float32Array(g.nx * g.nz);
  let t0 = Date.now();
  for (let j = 0; j < g.nz; j++) {
    for (let i = 0; i < g.nx; i++) {
      const x = g.x0 + i * g.step, z = g.z0 + j * g.step;
      const raw = g.data[j * g.nx + i];
      let sd = signedDistance(x, z, maxDist);
      if (sd === null || Math.abs(sd) > maxDist) sd = (raw > 3 ? 1 : -1) * maxDist;
      sdf[j * g.nx + i] = sd;
      height[j * g.nx + i] = sd >= 0 ? landHeight(sd, raw, x, z) : seabed(-sd, x, z);
    }
  }
  console.log(`${name}: composite ${g.nx}x${g.nz} in ${Date.now() - t0} ms`);
  return { g, height, sdf };
}

const near = buildComposite('near', 3200);
const wide = buildComposite('wide', 3200);

const writeI16 = (file, arr, scale) => {
  const q = new Int16Array(arr.length);
  for (let i = 0; i < arr.length; i++) q[i] = Math.max(-32767, Math.min(32767, Math.round(arr[i] / scale)));
  fs.writeFileSync(path.join(OUT, file), Buffer.from(q.buffer));
};
writeI16('height-near.bin', near.height, 0.1);
writeI16('height-wide.bin', wide.height, 0.1);
writeI16('sdf-near.bin', near.sdf, 0.1);
writeI16('sdf-wide.bin', wide.sdf, 0.1);

// ------------------------------------------------------------------ overlay
// RGB raster over the near grid: R = road (1 paved, ~0.55 dirt, ~0.3 path),
// G = loose sand (beach, arroyo beds), B = settled ground around buildings.
const OV_STEP = 5;
const ov = {
  x0: near.g.x0, z0: near.g.z0, step: OV_STEP,
  nx: Math.round((near.g.x1 ?? near.g.x0 + (near.g.nx - 1) * near.g.step) - near.g.x0) / OV_STEP,
};
ov.nx = Math.round(((near.g.nx - 1) * near.g.step) / OV_STEP);
ov.nz = Math.round(((near.g.nz - 1) * near.g.step) / OV_STEP);
const R = new Float32Array(ov.nx * ov.nz), G = new Float32Array(ov.nx * ov.nz), B = new Float32Array(ov.nx * ov.nz);

function strokePolyline(chan, pts, width, value) {
  const hw = width / 2;
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, az] = pts[k], [bx, bz] = pts[k + 1];
    const minX = Math.floor((Math.min(ax, bx) - hw - OV_STEP - ov.x0) / OV_STEP);
    const maxX = Math.ceil((Math.max(ax, bx) + hw + OV_STEP - ov.x0) / OV_STEP);
    const minZ = Math.floor((Math.min(az, bz) - hw - OV_STEP - ov.z0) / OV_STEP);
    const maxZ = Math.ceil((Math.max(az, bz) + hw + OV_STEP - ov.z0) / OV_STEP);
    const dx = bx - ax, dz = bz - az, len2 = dx * dx + dz * dz || 1e-9;
    for (let j = Math.max(0, minZ); j <= Math.min(ov.nz - 1, maxZ); j++) {
      for (let i = Math.max(0, minX); i <= Math.min(ov.nx - 1, maxX); i++) {
        const px = ov.x0 + (i + 0.5) * OV_STEP, pz = ov.z0 + (j + 0.5) * OV_STEP;
        let t = ((px - ax) * dx + (pz - az) * dz) / len2;
        t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
        const cov = Math.max(0, Math.min(1, (hw - d) / OV_STEP + 0.5));
        const idx = j * ov.nx + i;
        if (cov * value > chan[idx]) chan[idx] = cov * value;
      }
    }
  }
}

function fillPolygon(chan, pts, value) {
  let minZ = Infinity, maxZ = -Infinity;
  for (const [, z] of pts) { minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
  const j0 = Math.max(0, Math.floor((minZ - ov.z0) / OV_STEP));
  const j1 = Math.min(ov.nz - 1, Math.ceil((maxZ - ov.z0) / OV_STEP));
  for (let j = j0; j <= j1; j++) {
    const pz = ov.z0 + (j + 0.5) * OV_STEP;
    const xs = [];
    for (let k = 0; k < pts.length; k++) {
      const [ax, az] = pts[k], [bx, bz] = pts[(k + 1) % pts.length];
      if ((az <= pz && bz > pz) || (bz <= pz && az > pz)) xs.push(ax + ((pz - az) / (bz - az)) * (bx - ax));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - ov.x0) / OV_STEP - 0.5));
      const i1 = Math.min(ov.nx - 1, Math.floor((xs[k + 1] - ov.x0) / OV_STEP - 0.5));
      for (let i = i0; i <= i1; i++) {
        const idx = j * ov.nx + i;
        if (value > chan[idx]) chan[idx] = value;
      }
    }
  }
}

const ROAD_STYLE = {
  // Paved highway drawn wider than the 5 m raster so its centre line never drops out.
  secondary: [12, 1], tertiary: [11, 1],
  unclassified: [6, 0.55], residential: [5.5, 0.55], service: [4, 0.5], track: [3.2, 0.45],
  path: [1.6, 0.3], footway: [1.6, 0.3], steps: [1.6, 0.3],
};
for (const r of osm.roads) {
  const [w, v] = ROAD_STYLE[r.kind] || [3, 0.4];
  strokePolyline(R, r.pts, w, v);
}
for (const a of osm.areas) {
  if (a.kind === 'water' || a.kind === 'beach' || a.kind === 'sand') fillPolygon(G, a.pts, 0.9);
}
for (const w of osm.waterways) strokePolyline(G, w.pts, 14, 0.7);
for (const b of osm.buildings) {
  fillPolygon(B, b.pts, 1);
  // Yards and parking around houses: a soft halo of packed earth.
  const cx = b.pts.reduce((s, p) => s + p[0], 0) / b.pts.length;
  const cz = b.pts.reduce((s, p) => s + p[1], 0) / b.pts.length;
  strokePolyline(B, [[cx - 1, cz], [cx + 1, cz]], 26, 0.45);
}
for (const a of osm.areas) {
  if (['pitch', 'school', 'camp_site', 'caravan_site', 'cemetery', 'industrial'].includes(a.kind)) fillPolygon(B, a.pts, 0.8);
}
// Natural beach band along the whole coast (OSM only maps part of it).
for (let j = 0; j < ov.nz; j++) {
  for (let i = 0; i < ov.nx; i++) {
    const x = ov.x0 + (i + 0.5) * OV_STEP, z = ov.z0 + (j + 0.5) * OV_STEP;
    const gi = Math.round((x - near.g.x0) / near.g.step), gj = Math.round((z - near.g.z0) / near.g.step);
    const sd = near.sdf[Math.min(near.g.nz - 1, gj) * near.g.nx + Math.min(near.g.nx - 1, gi)];
    const beachW = 38 + vnoise(x / 60, z / 200) * 30;
    const sand = sd > -40 && sd < beachW ? 1 - smoothstep(beachW - 15, beachW, sd) : 0;
    const idx = j * ov.nx + i;
    if (sand > G[idx]) G[idx] = sand;
  }
}

const png = new PNG({ width: ov.nx, height: ov.nz, colorType: 2, inputHasAlpha: false });
const rgb = Buffer.alloc(ov.nx * ov.nz * 3);
for (let i = 0; i < ov.nx * ov.nz; i++) {
  rgb[i * 3] = Math.round(R[i] * 255);
  rgb[i * 3 + 1] = Math.round(G[i] * 255);
  rgb[i * 3 + 2] = Math.round(B[i] * 255);
}
png.data = rgb;
fs.writeFileSync(path.join(OUT, 'overlay.png'), PNG.sync.write(png, { colorType: 2, inputHasAlpha: false }));
console.log(`overlay ${ov.nx}x${ov.nz} @ ${OV_STEP} m`);

// --------------------------------------------------------------- world.json
const sdfAt = (x, z) => {
  const g = near.g;
  const i = Math.round((x - g.x0) / g.step), j = Math.round((z - g.z0) / g.step);
  if (i < 0 || j < 0 || i >= g.nx || j >= g.nz) return null;
  return near.sdf[j * g.nx + i];
};
// Easternmost land/sea transition per row: the west shore of the bay.
const coast = { z0: -12600, step: 25, x: [] };
for (let z = coast.z0; z <= 4600; z += coast.step) {
  let found = null;
  for (let x = 4300; x > -5100; x -= 4) {
    const s = sdfAt(x, z);
    if (s !== null && s >= 0) { found = Math.round(x * 10) / 10; break; }
  }
  coast.x.push(found);
}
const coastX = (z) => coast.x[Math.round((z - coast.z0) / coast.step)];

// Oriented bounding rectangles for buildings (good enough for Baja block houses).
function orientedRect(pts) {
  let best = null;
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cz = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  for (let a = 0; a < 90; a += 3) {
    const r = (a * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const [x, z] of pts) {
      const u = (x - cx) * c + (z - cz) * s, v = -(x - cx) * s + (z - cz) * c;
      minU = Math.min(minU, u); maxU = Math.max(maxU, u); minV = Math.min(minV, v); maxV = Math.max(maxV, v);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) {
      const mu = (minU + maxU) / 2, mv = (minV + maxV) / 2;
      best = { area, x: cx + mu * c - mv * s, z: cz + mu * s + mv * c, w: maxU - minU, d: maxV - minV, rot: r };
    }
  }
  return best;
}
const buildings = [];
for (const b of osm.buildings) {
  if (b.pts.length < 3) continue;
  const r = orientedRect(b.pts);
  if (r.w < 2 || r.d < 2 || r.w > 60 || r.d > 60) continue;
  const sd = sdfAt(r.x, r.z);
  if (sd !== null && sd < 6) continue;
  buildings.push([Math.round(r.x * 10) / 10, Math.round(r.z * 10) / 10, Math.round(r.w * 10) / 10, Math.round(r.d * 10) / 10, Math.round(r.rot * 1000) / 1000, b.levels || 0]);
}

const mainRoad = osm.roads.filter((r) => r.kind === 'secondary' || r.kind === 'tertiary').map((r) => r.pts);
const pois = osm.pois.map((p) => ({ kind: p.kind, x: p.p[0], z: p.p[1] }));
const areas = osm.areas
  .filter((a) => ['pitch', 'school', 'camp_site', 'caravan_site', 'cemetery'].includes(a.kind))
  .map((a) => ({ kind: a.kind, pts: a.pts }));

// Island extent from the wide grid.
let isl = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, peak: 0, peakX: 0, peakZ: 0 };
for (let j = 0; j < wide.g.nz; j++) for (let i = 0; i < wide.g.nx; i++) {
  const x = wide.g.x0 + i * wide.g.step, z = wide.g.z0 + j * wide.g.step;
  if (x < 4000 || z > -6000) continue;
  const h = wide.height[j * wide.g.nx + i];
  if (h <= 1) continue;
  isl.minX = Math.min(isl.minX, x); isl.maxX = Math.max(isl.maxX, x);
  isl.minZ = Math.min(isl.minZ, z); isl.maxZ = Math.max(isl.maxZ, z);
  if (h > isl.peak) isl = { ...isl, peak: h, peakX: x, peakZ: z };
}

const at = (z, off = 0) => ({ x: Math.round((coastX(z) ?? 0) + off), z });
const world = {
  attribution: [
    'Elevation: Mapzen / AWS Terrain Tiles (SRTM, GMTED, ETOPO1)',
    'Coastline, roads, buildings: (c) OpenStreetMap contributors (ODbL)',
  ],
  origin: dem.origin,
  projection: { mPerDegLat: dem.mPerDegLat, mPerDegLon: dem.mPerDegLon },
  grids: {
    near: { x0: near.g.x0, z0: near.g.z0, step: near.g.step, nx: near.g.nx, nz: near.g.nz },
    wide: { x0: wide.g.x0, z0: wide.g.z0, step: wide.g.step, nx: wide.g.nx, nz: wide.g.nz },
  },
  overlay: { x0: ov.x0, z0: ov.z0, step: OV_STEP, nx: ov.nx, nz: ov.nz },
  coast,
  landmarks: {
    mainBeach: at(-250),
    campNorth: at(-760),
    campSouth: at(620),
    elSargento: at(-3400),
    hotSprings: at(-5600),
    arroyo: at(-6650),
    elJalito: at(-8100),
    puntaArenas: { x: 16437, z: 327 },
    cerralvo: { minX: isl.minX, maxX: isl.maxX, minZ: isl.minZ, maxZ: isl.maxZ, peak: Math.round(isl.peak), peakX: isl.peakX, peakZ: isl.peakZ },
  },
  places: osm.places.filter((p) => p.name).map((p) => ({ name: p.name, kind: p.kind, x: p.p[0], z: p.p[1] })),
  buildings,
  mainRoad,
  pois,
  areas,
};
fs.writeFileSync(path.join(OUT, 'world.json'), JSON.stringify(world));
console.log(`world.json: ${buildings.length} buildings, coast rows ${coast.x.length}`);
console.log('landmarks', JSON.stringify(world.landmarks));
