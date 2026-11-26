import { clamp, smoothstep } from '../core/math.ts';

export interface GridMeta {
  x0: number;
  z0: number;
  step: number;
  nx: number;
  nz: number;
}

export interface Landmark {
  x: number;
  z: number;
}

export interface WorldJson {
  attribution: string[];
  origin: { lat: number; lon: number };
  projection: { mPerDegLat: number; mPerDegLon: number };
  grids: { near: GridMeta; wide: GridMeta };
  overlay: GridMeta;
  coast: { z0: number; step: number; x: (number | null)[] };
  landmarks: {
    mainBeach: Landmark;
    campNorth: Landmark;
    campSouth: Landmark;
    elSargento: Landmark;
    hotSprings: Landmark;
    arroyo: Landmark;
    elJalito: Landmark;
    puntaArenas: Landmark;
    cerralvo: { minX: number; maxX: number; minZ: number; maxZ: number; peak: number; peakX: number; peakZ: number };
  };
  places: { name: string; kind: string; x: number; z: number }[];
  /** [x, z, width, depth, rotation, levels] oriented rectangles from OSM footprints. */
  buildings: [number, number, number, number, number, number][];
  mainRoad: [number, number][][];
  pois: { kind: string; x: number; z: number }[];
  areas: { kind: string; pts: [number, number][] }[];
}

export class Grid {
  readonly meta: GridMeta;
  readonly data: Float32Array;
  readonly x1: number;
  readonly z1: number;

  constructor(meta: GridMeta, data: Float32Array) {
    this.meta = meta;
    this.data = data;
    this.x1 = meta.x0 + (meta.nx - 1) * meta.step;
    this.z1 = meta.z0 + (meta.nz - 1) * meta.step;
  }

  inside(x: number, z: number, margin = 0) {
    return x >= this.meta.x0 + margin && x <= this.x1 - margin && z >= this.meta.z0 + margin && z <= this.z1 - margin;
  }

  /** Distance from the grid border (negative outside). */
  borderDistance(x: number, z: number) {
    return Math.min(x - this.meta.x0, this.x1 - x, z - this.meta.z0, this.z1 - z);
  }

  sample(x: number, z: number) {
    const { x0, z0, step, nx, nz } = this.meta;
    const fx = clamp((x - x0) / step, 0, nx - 1.001);
    const fz = clamp((z - z0) / step, 0, nz - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz);
    const ax = fx - i, az = fz - j;
    const d = this.data;
    const o = j * nx + i;
    return (d[o] * (1 - ax) + d[o + 1] * ax) * (1 - az) + (d[o + nx] * (1 - ax) + d[o + nx + 1] * ax) * az;
  }
}

export interface Overlay {
  meta: GridMeta;
  /** RGBA pixels: R road, G loose sand, B settled ground. */
  pixels: Uint8ClampedArray;
  image: ImageBitmap;
}

export class TerrainData {
  readonly world: WorldJson;
  readonly heightNear: Grid;
  readonly heightWide: Grid;
  readonly sdfNear: Grid;
  readonly sdfWide: Grid;
  readonly overlay: Overlay;

  constructor(world: WorldJson, heightNear: Grid, heightWide: Grid, sdfNear: Grid, sdfWide: Grid, overlay: Overlay) {
    this.world = world;
    this.heightNear = heightNear;
    this.heightWide = heightWide;
    this.sdfNear = sdfNear;
    this.sdfWide = sdfWide;
    this.overlay = overlay;
  }

  /** Blend weight of the detailed near grid at a point (1 well inside, 0 outside). */
  nearWeight(x: number, z: number) {
    return smoothstep(0, 400, this.heightNear.borderDistance(x, z));
  }

  height(x: number, z: number) {
    const w = this.nearWeight(x, z);
    if (w >= 1) return this.heightNear.sample(x, z);
    const wide = this.heightWide.sample(x, z);
    if (w <= 0) return wide;
    return wide + (this.heightNear.sample(x, z) - wide) * w;
  }

  /** Signed distance to the coastline in metres (positive on land). */
  sdf(x: number, z: number) {
    const w = this.nearWeight(x, z);
    if (w >= 1) return this.sdfNear.sample(x, z);
    const wide = this.sdfWide.sample(x, z);
    if (w <= 0) return wide;
    return wide + (this.sdfNear.sample(x, z) - wide) * w;
  }

  /** Water depth (positive) or 0 on land. */
  depth(x: number, z: number) {
    return Math.max(0, -this.height(x, z));
  }

  overlayAt(x: number, z: number): [number, number, number] {
    const { x0, z0, step, nx, nz } = this.overlay.meta;
    const i = Math.floor((x - x0) / step), j = Math.floor((z - z0) / step);
    if (i < 0 || j < 0 || i >= nx || j >= nz) return [0, 0, 0];
    const o = (j * nx + i) * 4;
    const p = this.overlay.pixels;
    return [p[o] / 255, p[o + 1] / 255, p[o + 2] / 255];
  }

  /** x of the west shore of the bay at a given z (null where the coast turns east). */
  coastX(z: number): number | null {
    const c = this.world.coast;
    const f = (z - c.z0) / c.step;
    const i = Math.floor(f);
    if (i < 0 || i + 1 >= c.x.length) return null;
    const a = c.x[i], b = c.x[i + 1];
    if (a === null || b === null) return a ?? b;
    return a + (b - a) * (f - i);
  }

  slope(x: number, z: number, e = 6) {
    const hx = this.height(x + e, z) - this.height(x - e, z);
    const hz = this.height(x, z + e) - this.height(x, z - e);
    return Math.hypot(hx, hz) / (2 * e);
  }

  toLatLon(x: number, z: number) {
    const { origin, projection } = this.world;
    return { lat: origin.lat - z / projection.mPerDegLat, lon: origin.lon + x / projection.mPerDegLon };
  }
}

async function fetchI16(url: string, meta: GridMeta, scale: number) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const buf = await res.arrayBuffer();
  const q = new Int16Array(buf);
  if (q.length !== meta.nx * meta.nz) throw new Error(`${url}: expected ${meta.nx * meta.nz} samples, got ${q.length}`);
  const out = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) out[i] = q[i] * scale;
  return new Grid(meta, out);
}

async function loadOverlay(url: string, meta: GridMeta): Promise<Overlay> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const blob = await res.blob();
  const image = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const canvas = new OffscreenCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
  return { meta: { ...meta, nx: image.width, nz: image.height }, pixels, image };
}

export async function loadTerrainData(base: string, onProgress?: (p: number) => void): Promise<TerrainData> {
  const worldRes = await fetch(`${base}world.json`);
  if (!worldRes.ok) throw new Error(`world.json: ${worldRes.status}`);
  const world = (await worldRes.json()) as WorldJson;
  let done = 0;
  const tick = <T>(p: Promise<T>) =>
    p.then((v) => {
      done++;
      onProgress?.(done / 5);
      return v;
    });
  const [heightNear, heightWide, sdfNear, sdfWide, overlay] = await Promise.all([
    tick(fetchI16(`${base}height-near.bin`, world.grids.near, 0.1)),
    tick(fetchI16(`${base}height-wide.bin`, world.grids.wide, 0.1)),
    tick(fetchI16(`${base}sdf-near.bin`, world.grids.near, 0.1)),
    tick(fetchI16(`${base}sdf-wide.bin`, world.grids.wide, 0.1)),
    tick(loadOverlay(`${base}overlay.png`, world.overlay)),
  ]);
  return new TerrainData(world, heightNear, heightWide, sdfNear, sdfWide, overlay);
}
