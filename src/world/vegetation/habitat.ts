import type { TerrainData } from '../terrainData.ts';

/** Terrain attributes at a point, used by the species density functions. */
export interface Env {
  h: number;
  sdf: number;
  /** |grad h| over ~24 m (near grid) or ~140 m (outer hills). */
  slope: number;
  /** +1 steep north-facing .. -1 steep south-facing (0 on flats). */
  north: number;
  /** Positive in drainages/valleys, negative on ridges (metres of relief). */
  valley: number;
  /** 0..1 proximity to arroyo sand beds. */
  wash: number;
  /** 0..1 proximity to buildings and yards. */
  town: number;
}

// Both terrain meshes are triangulations of the height data (see buildGrid in terrain.ts): the near
// mesh at 24 m, the wide mesh at 140 m and lowered 0.6 m so the near mesh wins where they overlap.
const NEAR_STEP = 24;
const WIDE_STEP = 140;
const WIDE_DROP = 0.6;

function boxBlur(src: Float32Array, nx: number, nz: number, r: number) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const w = 2 * r + 1;
  for (let j = 0; j < nz; j++) {
    const row = j * nx;
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += src[row + Math.min(nx - 1, Math.max(0, i))];
    for (let i = 0; i < nx; i++) {
      tmp[row + i] = acc / w;
      acc += src[row + Math.min(nx - 1, i + r + 1)] - src[row + Math.max(0, i - r)];
    }
  }
  for (let i = 0; i < nx; i++) {
    let acc = 0;
    for (let j = -r; j <= r; j++) acc += tmp[Math.min(nz - 1, Math.max(0, j)) * nx + i];
    for (let j = 0; j < nz; j++) {
      out[j * nx + i] = acc / w;
      acc += tmp[Math.min(nz - 1, j + r + 1) * nx + i] - tmp[Math.max(0, j - r) * nx + i];
    }
  }
  return out;
}

interface Area {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  pts: [number, number][];
}

/** A vertex grid matching one of the terrain meshes, with per-vertex habitat fields. */
class MeshGrid {
  readonly x0: number;
  readonly z0: number;
  readonly step: number;
  readonly nx: number;
  readonly nz: number;
  readonly drop: number;
  readonly h: Float32Array;
  readonly sdf: Float32Array;
  readonly slope: Float32Array;
  readonly north: Float32Array;
  readonly valley: Float32Array;
  wash: Float32Array | null = null;
  town: Float32Array | null = null;

  constructor(data: TerrainData, x0: number, z0: number, step: number, nx: number, nz: number, drop: number) {
    this.x0 = x0;
    this.z0 = z0;
    this.step = step;
    this.nx = nx;
    this.nz = nz;
    this.drop = drop;
    const n = nx * nz;
    const h = (this.h = new Float32Array(n));
    const sdf = (this.sdf = new Float32Array(n));
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const x = x0 + i * step, z = z0 + j * step;
        h[j * nx + i] = data.height(x, z);
        sdf[j * nx + i] = data.sdf(x, z);
      }
    }
    this.slope = new Float32Array(n);
    this.north = new Float32Array(n);
    this.valley = new Float32Array(n);
    const H = (i: number, j: number) => h[Math.min(nz - 1, Math.max(0, j)) * nx + Math.min(nx - 1, Math.max(0, i))];
    // Drainage relief at roughly 50 m and 120 m whatever the grid spacing.
    const r1 = Math.max(1, Math.round(48 / step)), r2 = Math.max(2, Math.round(120 / step));
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        const dx = (H(i + 1, j) - H(i - 1, j)) / (2 * step);
        const dz = (H(i, j + 1) - H(i, j - 1)) / (2 * step);
        const s = Math.hypot(dx, dz);
        this.slope[k] = s;
        // Height rising to the south means the ground faces north (north is -z).
        this.north[k] = s > 1e-4 ? (dz / s) * Math.min(1, s / 0.2) : 0;
        const c = h[k];
        const l1 = (H(i - r1, j) + H(i + r1, j) + H(i, j - r1) + H(i, j + r1)) * 0.25 - c;
        const l2 = (H(i - r2, j) + H(i + r2, j) + H(i, j - r2) + H(i, j + r2)) * 0.25 - c;
        this.valley[k] = l1 + 0.5 * l2;
      }
    }
  }

  /** Height of the rendered surface: same vertices and diagonal choice as the mesh. */
  ground(x: number, z: number) {
    const fx = Math.min(this.nx - 1.001, Math.max(0, (x - this.x0) / this.step));
    const fz = Math.min(this.nz - 1.001, Math.max(0, (z - this.z0) / this.step));
    const i = Math.floor(fx), j = Math.floor(fz);
    const u = fx - i, v = fz - j;
    const h = this.h, nx = this.nx, o = j * nx + i;
    const h00 = h[o], h10 = h[o + 1], h01 = h[o + nx], h11 = h[o + nx + 1];
    let y: number;
    if (Math.abs(h00 - h11) < Math.abs(h10 - h01)) {
      y = u >= v ? h00 + (h10 - h00) * u + (h11 - h10) * v : h00 + (h01 - h00) * v + (h11 - h01) * u;
    } else {
      y = u + v <= 1 ? h00 + (h10 - h00) * u + (h01 - h00) * v : h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v);
    }
    return y - this.drop;
  }

  sample(f: Float32Array, x: number, z: number) {
    const fx = Math.min(this.nx - 1.001, Math.max(0, (x - this.x0) / this.step));
    const fz = Math.min(this.nz - 1.001, Math.max(0, (z - this.z0) / this.step));
    const i = Math.floor(fx), j = Math.floor(fz);
    const u = fx - i, v = fz - j;
    const nx = this.nx, o = j * nx + i;
    return (f[o] * (1 - u) + f[o + 1] * u) * (1 - v) + (f[o + nx] * (1 - u) + f[o + nx + 1] * u) * v;
  }
}

export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export class Habitat {
  /** The near grid (detailed terrain, overlay) where streamed ground cover lives. */
  readonly near: Rect;
  /** Near grid plus the surrounding hills on the wide mesh, for plants seen from afar. */
  readonly outer: Rect;
  private readonly nearGrid: MeshGrid;
  private readonly wideGrid: MeshGrid;
  private readonly island: Rect;
  private readonly px: Uint8ClampedArray;
  private readonly ox0: number;
  private readonly oz0: number;
  private readonly ostep: number;
  private readonly onx: number;
  private readonly onz: number;
  private readonly areas: Area[];

  constructor(data: TerrainData, outer: Rect) {
    const nearH = data.heightNear;
    const nx = Math.floor((nearH.x1 - nearH.meta.x0) / NEAR_STEP) + 1;
    const nz = Math.floor((nearH.z1 - nearH.meta.z0) / NEAR_STEP) + 1;
    this.nearGrid = new MeshGrid(data, nearH.meta.x0, nearH.meta.z0, NEAR_STEP, nx, nz, 0);
    this.near = { x0: nearH.meta.x0, z0: nearH.meta.z0, x1: nearH.meta.x0 + (nx - 1) * NEAR_STEP, z1: nearH.meta.z0 + (nz - 1) * NEAR_STEP };
    const wide = data.heightWide.meta;
    const wx0 = wide.x0 + Math.floor((outer.x0 - wide.x0) / WIDE_STEP) * WIDE_STEP;
    const wz0 = wide.z0 + Math.floor((outer.z0 - wide.z0) / WIDE_STEP) * WIDE_STEP;
    const wnx = Math.ceil((outer.x1 - wx0) / WIDE_STEP) + 2;
    const wnz = Math.ceil((outer.z1 - wz0) / WIDE_STEP) + 2;
    this.wideGrid = new MeshGrid(data, wx0, wz0, WIDE_STEP, wnx, wnz, WIDE_DROP);
    this.outer = outer;
    const c = data.world.landmarks.cerralvo;
    this.island = { x0: c.minX - 500, z0: c.minZ - 500, x1: c.maxX + 500, z1: c.maxZ + 500 };

    const ov = data.overlay;
    this.px = ov.pixels;
    this.ox0 = ov.meta.x0;
    this.oz0 = ov.meta.z0;
    this.ostep = ov.meta.step;
    this.onx = ov.meta.nx;
    this.onz = ov.meta.nz;
    this.areas = data.world.areas.map((a) => {
      const xs = a.pts.map((p) => p[0]), zs = a.pts.map((p) => p[1]);
      return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs), pts: a.pts };
    });

    // Arroyo and village proximity only exist where the overlay raster does (the near grid).
    const g = this.nearGrid;
    const sand = new Float32Array(g.nx * g.nz);
    const settled = new Float32Array(g.nx * g.nz);
    for (let j = 0; j < g.nz; j++) {
      for (let i = 0; i < g.nx; i++) {
        const k = j * g.nx + i;
        if (g.sdf[k] <= 0) continue;
        const x = g.x0 + i * NEAR_STEP, z = g.z0 + j * NEAR_STEP;
        let sMax = 0, tMax = 0;
        for (let oz = -10; oz <= 10; oz += 10) {
          for (let ox = -10; ox <= 10; ox += 10) {
            sMax = Math.max(sMax, this.overlay(x + ox, z + oz, 1));
            tMax = Math.max(tMax, this.overlay(x + ox, z + oz, 2));
          }
        }
        sand[k] = sMax;
        settled[k] = tMax;
      }
    }
    g.wash = boxBlur(sand, g.nx, g.nz, 3);
    g.town = boxBlur(settled, g.nx, g.nz, 3);
  }

  /** Inside the detailed near grid (exact terrain and overlay). */
  isNear(x: number, z: number) {
    return x >= this.near.x0 && x <= this.near.x1 && z >= this.near.z0 && z <= this.near.z1;
  }

  /** Cerralvo and its surroundings: no plants there. */
  onIsland(x: number, z: number) {
    const r = this.island;
    return x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1;
  }

  private grid(x: number, z: number) {
    return this.isNear(x, z) ? this.nearGrid : this.wideGrid;
  }

  /** Overlay channel (0 road, 1 sand, 2 settled) at a point, 0..1 (0 outside the raster). */
  overlay(x: number, z: number, ch: number) {
    const i = Math.floor((x - this.ox0) / this.ostep), j = Math.floor((z - this.oz0) / this.ostep);
    if (i < 0 || j < 0 || i >= this.onx || j >= this.onz) return 0;
    return this.px[(j * this.onx + i) * 4 + ch] / 255;
  }

  /** Height of the rendered terrain surface at a point. */
  ground(x: number, z: number) {
    return this.grid(x, z).ground(x, z);
  }

  sdf(x: number, z: number) {
    const g = this.grid(x, z);
    return g.sample(g.sdf, x, z);
  }

  slope(x: number, z: number) {
    const g = this.grid(x, z);
    return g.sample(g.slope, x, z);
  }

  env(x: number, z: number, out: Env) {
    const g = this.grid(x, z);
    out.h = g.sample(g.h, x, z);
    out.sdf = g.sample(g.sdf, x, z);
    out.slope = g.sample(g.slope, x, z);
    out.north = g.sample(g.north, x, z);
    out.valley = g.sample(g.valley, x, z);
    out.wash = g.wash ? g.sample(g.wash, x, z) : 0;
    out.town = g.town ? g.sample(g.town, x, z) : 0;
    return out;
  }

  /** Inside a sports pitch, school, campground or cemetery polygon. */
  inArea(x: number, z: number) {
    for (const a of this.areas) {
      if (x < a.minX || x > a.maxX || z < a.minZ || z > a.maxZ) continue;
      let inside = false;
      const p = a.pts;
      for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
        const xi = p[i][0], zi = p[i][1], xj = p[j][0], zj = p[j][1];
        if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
      }
      if (inside) return true;
    }
    return false;
  }

  /** Free of roads, buildings and yards at the point and `clear` metres around it. */
  clearOfTown(x: number, z: number, clear: number) {
    if (this.overlay(x, z, 0) >= 0.2 || this.overlay(x, z, 2) >= 0.25) return false;
    if (clear <= 0) return true;
    for (let k = 0; k < 4; k++) {
      const ox = k === 0 ? clear : k === 1 ? -clear : 0;
      const oz = k === 2 ? clear : k === 3 ? -clear : 0;
      if (this.overlay(x + ox, z + oz, 0) >= 0.2 || this.overlay(x + ox, z + oz, 2) >= 0.25) return false;
    }
    return true;
  }
}
