import type { TerrainData } from '../terrainData.ts';

/**
 * Spatial helpers shared by the village builders: the height of the rendered
 * terrain mesh, footprint overlap tests, the beach frame and road distance.
 */
export class Site {
  readonly data: TerrainData;
  private readonly step = 24;
  private readonly gx0: number;
  private readonly gz0: number;
  /** Oriented footprints [cx, cz, ux, uz, hw, hd] in a 40 m hash. */
  private readonly rects: Float64Array;
  private readonly rectHash = new Map<number, number[]>();
  private readonly circles = new Map<number, number[]>();
  private readonly circleData: number[] = [];
  private readonly roadSegs: number[] = [];
  private readonly roadHash = new Map<number, number[]>();

  constructor(data: TerrainData) {
    this.data = data;
    this.gx0 = data.heightNear.meta.x0;
    this.gz0 = data.heightNear.meta.z0;
    const b = data.world.buildings;
    this.rects = new Float64Array(b.length * 6);
    for (let i = 0; i < b.length; i++) {
      const [x, z, w, d, rot] = b[i];
      const o = i * 6;
      this.rects[o] = x;
      this.rects[o + 1] = z;
      this.rects[o + 2] = Math.cos(rot);
      this.rects[o + 3] = Math.sin(rot);
      this.rects[o + 4] = Math.max(1, w / 2);
      this.rects[o + 5] = Math.max(1, d / 2);
      const r = Math.hypot(w, d) / 2;
      this.hashInsert(this.rectHash, x, z, r, i, 40);
    }
    for (const line of data.world.mainRoad) {
      for (let i = 0; i + 1 < line.length; i++) {
        const k = this.roadSegs.length / 4;
        const [ax, az] = line[i], [bx, bz] = line[i + 1];
        this.roadSegs.push(ax, az, bx, bz);
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 50));
        for (let j = 0; j <= n; j++) this.hashInsert(this.roadHash, ax + ((bx - ax) * j) / n, az + ((bz - az) * j) / n, 30, k, 100);
      }
    }
  }

  private key(i: number, j: number) {
    return (i + 4096) * 8192 + (j + 4096);
  }

  private hashInsert(h: Map<number, number[]>, x: number, z: number, r: number, id: number, cell: number) {
    const i0 = Math.floor((x - r) / cell), i1 = Math.floor((x + r) / cell);
    const j0 = Math.floor((z - r) / cell), j1 = Math.floor((z + r) / cell);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = this.key(i, j);
        const list = h.get(k);
        if (list) {
          if (list[list.length - 1] !== id) list.push(id);
        } else h.set(k, [id]);
      }
    }
  }

  /** Height of the drawn terrain surface (24 m mesh, same diagonal split as terrain.ts). */
  ground(x: number, z: number) {
    const d = this.data;
    if (!d.heightNear.inside(x, z, 30)) return d.height(x, z) - 0.6;
    const s = this.step;
    const fx = (x - this.gx0) / s, fz = (z - this.gz0) / s;
    const i = Math.floor(fx), j = Math.floor(fz);
    const ax = fx - i, az = fz - j;
    const x0 = this.gx0 + i * s, z0 = this.gz0 + j * s;
    const h00 = d.height(x0, z0), h10 = d.height(x0 + s, z0), h01 = d.height(x0, z0 + s), h11 = d.height(x0 + s, z0 + s);
    if (Math.abs(h00 - h11) < Math.abs(h10 - h01)) {
      if (az > ax) return h00 + ax * (h11 - h01) + az * (h01 - h00);
      return h00 + ax * (h10 - h00) + az * (h11 - h10);
    }
    if (ax + az < 1) return h00 + ax * (h10 - h00) + az * (h01 - h00);
    return h11 + (1 - ax) * (h01 - h11) + (1 - az) * (h10 - h11);
  }

  /** Lowest and highest drawn ground under a set of points. */
  groundRange(pts: number[]) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      const h = this.ground(pts[i], pts[i + 1]);
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    return [lo, hi];
  }

  /** True if a circle overlaps any OSM building footprint (optionally ignoring one). */
  hitsBuilding(x: number, z: number, r: number, ignore = -1) {
    const cell = 40;
    const i0 = Math.floor((x - r) / cell), i1 = Math.floor((x + r) / cell);
    const j0 = Math.floor((z - r) / cell), j1 = Math.floor((z + r) / cell);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const list = this.rectHash.get(this.key(i, j));
        if (!list) continue;
        for (const id of list) {
          if (id === ignore) continue;
          const o = id * 6;
          const dx = x - this.rects[o], dz = z - this.rects[o + 1];
          const ux = this.rects[o + 2], uz = this.rects[o + 3];
          const lx = dx * ux + dz * uz, lz = -dx * uz + dz * ux;
          const qx = Math.max(Math.abs(lx) - this.rects[o + 4], 0), qz = Math.max(Math.abs(lz) - this.rects[o + 5], 0);
          if (qx * qx + qz * qz < r * r) return true;
        }
      }
    }
    return false;
  }

  /** Oriented rectangle vs footprints, sampled with circles along its long axis. */
  rectHitsBuilding(x: number, z: number, ux: number, uz: number, hl: number, hw: number) {
    const span = Math.max(0, hl - hw);
    const n = Math.max(1, Math.ceil(span / hw));
    for (let k = 0; k <= n; k++) {
      const t = -span + (2 * span * k) / n;
      if (this.hitsBuilding(x + ux * t, z + uz * t, hw)) return true;
    }
    return false;
  }

  /** Registers a placed prop so later props keep clear of it. */
  occupy(x: number, z: number, r: number) {
    const id = this.circleData.length / 3;
    this.circleData.push(x, z, r);
    this.hashInsert(this.circles, x, z, r, id, 20);
  }

  isFree(x: number, z: number, r: number) {
    const cell = 20;
    const i0 = Math.floor((x - r - 8) / cell), i1 = Math.floor((x + r + 8) / cell);
    const j0 = Math.floor((z - r - 8) / cell), j1 = Math.floor((z + r + 8) / cell);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const list = this.circles.get(this.key(i, j));
        if (!list) continue;
        for (const id of list) {
          const cx = this.circleData[id * 3], cz = this.circleData[id * 3 + 1], cr = this.circleData[id * 3 + 2];
          if (Math.hypot(x - cx, z - cz) < r + cr) return false;
        }
      }
    }
    return true;
  }

  /** Distance to the main road centreline (capped at 500 m). */
  roadDistance(x: number, z: number) {
    return this.roadNearest(x, z)[2];
  }

  /** Nearest point on the main road: [x, z, distance] (distance capped at 500 m). */
  roadNearest(x: number, z: number): [number, number, number] {
    const list = this.roadHash.get(this.key(Math.floor(x / 100), Math.floor(z / 100)));
    const out: [number, number, number] = [x, z, 500];
    if (!list) return out;
    for (const k of list) {
      const o = k * 4;
      const ax = this.roadSegs[o], az = this.roadSegs[o + 1], bx = this.roadSegs[o + 2], bz = this.roadSegs[o + 3];
      const vx = bx - ax, vz = bz - az;
      const l2 = vx * vx + vz * vz;
      let t = l2 > 0 ? ((x - ax) * vx + (z - az) * vz) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + vx * t, pz = az + vz * t;
      const dd = Math.hypot(x - px, z - pz);
      if (dd < out[2]) {
        out[0] = px;
        out[1] = pz;
        out[2] = dd;
      }
    }
    return out;
  }

  slopeAt(x: number, z: number) {
    return this.data.slope(x, z, 4);
  }

  /** Unit vector pointing inland (up the sdf gradient). */
  inland(x: number, z: number): [number, number] {
    const e = 3;
    const gx = this.data.sdf(x + e, z) - this.data.sdf(x - e, z);
    const gz = this.data.sdf(x, z + e) - this.data.sdf(x, z - e);
    const l = Math.hypot(gx, gz) || 1;
    return [gx / l, gz / l];
  }

  /**
   * Point at signed distance `s` from the coastline near (x, z), found by
   * walking along the sdf gradient.
   */
  atDistance(x: number, z: number, s: number): [number, number] {
    let px = x, pz = z;
    for (let it = 0; it < 6; it++) {
      const d = this.data.sdf(px, pz);
      const [nx, nz] = this.inland(px, pz);
      const err = s - d;
      if (Math.abs(err) < 0.25) break;
      px += nx * err;
      pz += nz * err;
    }
    return [px, pz];
  }

  /** Point on the west shore at latitude z, `s` metres inland (negative = offshore). */
  shore(z: number, s: number): [number, number] | null {
    const cx = this.data.coastX(z);
    if (cx === null) return null;
    return this.atDistance(cx, z, s);
  }
}

export function pointInPolygon(x: number, z: number, pts: [number, number][]) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i], [xj, zj] = pts[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function polygonBounds(pts: [number, number][]) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of pts) {
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    z0 = Math.min(z0, z);
    z1 = Math.max(z1, z);
  }
  return { x0, x1, z0, z1 };
}

/** Weighted pick from [value, weight] pairs. */
export function pickWeighted<T>(rnd: () => number, items: readonly (readonly [T, number])[]): T {
  let total = 0;
  for (const [, w] of items) total += w;
  let r = rnd() * total;
  for (const [v, w] of items) {
    r -= w;
    if (r <= 0) return v;
  }
  return items[items.length - 1][0];
}

export const rr = (rnd: () => number, a: number, b: number) => a + (b - a) * rnd();
