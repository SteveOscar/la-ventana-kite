// Downloads AWS Terrain Tiles (Terrarium encoding) around La Ventana, BCS and
// resamples them onto local metric grids used by the game.
//
//   node tools/fetch-dem.mjs            -> public/data/dem-wide.bin, dem-near.bin, dem.json
//   node tools/fetch-dem.mjs --preview  -> also writes .cache/preview-*.png hillshades
//
// Elevation source: Mapzen/AWS Terrain Tiles (SRTM, GMTED, ETOPO1 and others).
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CACHE = path.join(ROOT, '.cache', 'tiles');
const OUT = path.join(ROOT, '.cache', 'dem');
fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

// World origin: the main kite beach in front of the village of La Ventana.
// x = metres east, z = metres south (three.js: north is -z).
export const ORIGIN = { lat: 24.0475, lon: -109.9892 };
const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LON = 111320 * Math.cos((ORIGIN.lat * Math.PI) / 180);

const GRIDS = {
  wide: { x0: -36000, x1: 36000, z0: -48000, z1: 24000, step: 70, zoom: 12 },
  near: { x0: -5200, x1: 4400, z0: -12800, z1: 4800, step: 12, zoom: 13 },
};

const toLatLon = (x, z) => ({
  lat: ORIGIN.lat - z / M_PER_DEG_LAT,
  lon: ORIGIN.lon + x / M_PER_DEG_LON,
});

const lonToTileX = (lon, zoom) => ((lon + 180) / 360) * 2 ** zoom;
const latToTileY = (lat, zoom) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** zoom;
};

async function getTile(z, x, y) {
  const file = path.join(CACHE, `${z}-${x}-${y}.png`);
  if (!fs.existsSync(file)) {
    const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url);
      if (res.ok) {
        fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
        break;
      }
      if (attempt >= 3) throw new Error(`tile ${url} -> ${res.status}`);
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  const png = PNG.sync.read(fs.readFileSync(file));
  const elev = new Float32Array(256 * 256);
  for (let i = 0; i < 256 * 256; i++) {
    const r = png.data[i * 4], g = png.data[i * 4 + 1], b = png.data[i * 4 + 2];
    elev[i] = r * 256 + g + b / 256 - 32768;
  }
  return elev;
}

async function buildGrid(name, g) {
  const nx = Math.round((g.x1 - g.x0) / g.step) + 1;
  const nz = Math.round((g.z1 - g.z0) / g.step) + 1;
  const nw = toLatLon(g.x0, g.z0);
  const se = toLatLon(g.x1, g.z1);
  const tx0 = Math.floor(lonToTileX(nw.lon, g.zoom));
  const tx1 = Math.floor(lonToTileX(se.lon, g.zoom));
  const ty0 = Math.floor(latToTileY(nw.lat, g.zoom));
  const ty1 = Math.floor(latToTileY(se.lat, g.zoom));
  const tiles = new Map();
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      jobs.push(getTile(g.zoom, tx, ty).then((t) => tiles.set(`${tx},${ty}`, t)));
    }
  }
  await Promise.all(jobs);
  console.log(`${name}: ${jobs.length} tiles at z${g.zoom}, grid ${nx}x${nz} @ ${g.step} m`);

  const px = (gx, gy) => {
    const tx = Math.floor(gx / 256), ty = Math.floor(gy / 256);
    const t = tiles.get(`${tx},${ty}`);
    if (!t) return 0;
    return t[(gy - ty * 256) * 256 + (gx - tx * 256)];
  };
  const out = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const { lat, lon } = toLatLon(g.x0 + i * g.step, g.z0 + j * g.step);
      const fx = lonToTileX(lon, g.zoom) * 256 - 0.5;
      const fy = latToTileY(lat, g.zoom) * 256 - 0.5;
      const ix = Math.floor(fx), iy = Math.floor(fy);
      const ax = fx - ix, ay = fy - iy;
      const h00 = px(ix, iy), h10 = px(ix + 1, iy), h01 = px(ix, iy + 1), h11 = px(ix + 1, iy + 1);
      out[j * nx + i] = (h00 * (1 - ax) + h10 * ax) * (1 - ay) + (h01 * (1 - ax) + h11 * ax) * ay;
    }
  }
  return { nx, nz, data: out };
}

function writePreview(name, grid, step) {
  const { nx, nz, data } = grid;
  const png = new PNG({ width: nx, height: nz });
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const h = data[j * nx + i];
      const hx = data[j * nx + Math.min(nx - 1, i + 1)] - data[j * nx + Math.max(0, i - 1)];
      const hz = data[Math.min(nz - 1, j + 1) * nx + i] - data[Math.max(0, j - 1) * nx + i];
      const shade = Math.max(0, Math.min(1, 0.6 - (hx - hz) / (4 * step)));
      let r, gg, b;
      if (h <= 0) {
        const d = Math.min(1, -h / 400);
        r = 40 * (1 - d) + 5 * d; gg = 190 * (1 - d) + 40 * d; b = 200 * (1 - d) + 110 * d;
      } else {
        const t = Math.min(1, h / 900);
        r = (200 - 60 * t) * shade + 30; gg = (170 - 70 * t) * shade + 20; b = (120 - 60 * t) * shade + 10;
      }
      const o = (j * nx + i) * 4;
      png.data[o] = r; png.data[o + 1] = gg; png.data[o + 2] = b; png.data[o + 3] = 255;
    }
  }
  const file = path.join(ROOT, '.cache', `preview-${name}.png`);
  fs.writeFileSync(file, PNG.sync.write(png));
  console.log(`preview -> ${file}`);
}

const preview = process.argv.includes('--preview');
const meta = { origin: ORIGIN, mPerDegLat: M_PER_DEG_LAT, mPerDegLon: M_PER_DEG_LON, grids: {} };
for (const [name, g] of Object.entries(GRIDS)) {
  const grid = await buildGrid(name, g);
  // Stored as int16 decimetres: +-3276 m covers the terrain and the channel floor near the island.
  const q = new Int16Array(grid.data.length);
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < q.length; i++) {
    const h = Math.max(-3270, Math.min(3270, grid.data[i]));
    q[i] = Math.round(h * 10);
    min = Math.min(min, h); max = Math.max(max, h);
  }
  fs.writeFileSync(path.join(OUT, `dem-${name}.bin`), Buffer.from(q.buffer));
  meta.grids[name] = { x0: g.x0, z0: g.z0, step: g.step, nx: grid.nx, nz: grid.nz, scale: 0.1, min, max };
  console.log(`${name}: min ${min.toFixed(1)} m, max ${max.toFixed(1)} m`);
  if (preview) writePreview(name, grid, g.step);
}
fs.writeFileSync(path.join(OUT, 'dem.json'), JSON.stringify(meta, null, 2));
console.log('wrote .cache/dem/dem.json');
