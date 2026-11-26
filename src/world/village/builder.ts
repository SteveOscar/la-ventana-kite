import * as THREE from 'three';

export type UVRect = readonly [number, number, number, number];

/** Box face flags. */
export const PX = 1, NX = 2, PY = 4, NY = 8, PZ = 16, NZ = 32;
export const ALL_FACES = 63;
export const NO_BOTTOM = ALL_FACES & ~NY;

/**
 * Growable vertex/index buffers for merged geometry. Primitives are given in a
 * local frame (origin + orthonormal axes) and written in world space.
 */
export class MeshBuilder {
  pos: Float32Array;
  nor: Float32Array;
  col: Float32Array;
  uv: Float32Array;
  piv: Float32Array | null;
  anm: Float32Array | null;
  idx: Uint32Array;
  nv = 0;
  ni = 0;
  r = 1;
  g = 1;
  b = 1;
  /** UV used by untextured geometry (a pure white atlas texel). */
  pu = 0;
  pv = 0;
  pivX = 0;
  pivY = 0;
  pivZ = 0;
  an0 = 0;
  an1 = 0;
  an2 = 0;
  an3 = 0;
  // Frame: world = t + X * lx + Y * ly + Z * lz.
  private xx = 1; private xy = 0; private xz = 0;
  private yx = 0; private yy = 1; private yz = 0;
  private zx = 0; private zy = 0; private zz = 1;
  private tx = 0; private ty = 0; private tz = 0;

  constructor(animated = false, plainUV: readonly [number, number] = [0, 0], verts = 4096) {
    this.pos = new Float32Array(verts * 3);
    this.nor = new Float32Array(verts * 3);
    this.col = new Float32Array(verts * 3);
    this.uv = new Float32Array(verts * 2);
    this.piv = animated ? new Float32Array(verts * 3) : null;
    this.anm = animated ? new Float32Array(verts * 4) : null;
    this.idx = new Uint32Array(verts * 2);
    this.pu = plainUV[0];
    this.pv = plainUV[1];
  }

  get triangles() {
    return this.ni / 3;
  }

  private growVerts(need: number) {
    let cap = this.pos.length / 3;
    if (this.nv + need <= cap) return;
    while (this.nv + need > cap) cap *= 2;
    const grow = <T extends Float32Array>(a: T, n: number) => {
      const b = new Float32Array(cap * n);
      b.set(a);
      return b;
    };
    this.pos = grow(this.pos, 3);
    this.nor = grow(this.nor, 3);
    this.col = grow(this.col, 3);
    this.uv = grow(this.uv, 2);
    if (this.piv) this.piv = grow(this.piv, 3);
    if (this.anm) this.anm = grow(this.anm, 4);
  }

  private growIdx(need: number) {
    let cap = this.idx.length;
    if (this.ni + need <= cap) return;
    while (this.ni + need > cap) cap *= 2;
    const b = new Uint32Array(cap);
    b.set(this.idx);
    this.idx = b;
  }

  color(c: THREE.Color, k = 1) {
    this.r = c.r * k;
    this.g = c.g * k;
    this.b = c.b * k;
    return this;
  }

  rgb(r: number, g: number, b: number) {
    this.r = r;
    this.g = g;
    this.b = b;
    return this;
  }

  /** Frame rotated about +y: local x -> (cos a, 0, sin a), local z -> (-sin a, 0, cos a). */
  frame(ox: number, oy: number, oz: number, yaw = 0) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    this.xx = c; this.xy = 0; this.xz = s;
    this.yx = 0; this.yy = 1; this.yz = 0;
    this.zx = -s; this.zy = 0; this.zz = c;
    this.tx = ox; this.ty = oy; this.tz = oz;
    return this;
  }

  /** Frame from a forward (local x) and approximate up (local y) axis; z = x cross y. */
  frameBasis(ox: number, oy: number, oz: number, fx: number, fy: number, fz: number, ux: number, uy: number, uz: number) {
    let l = Math.hypot(fx, fy, fz);
    fx /= l; fy /= l; fz /= l;
    // Make up orthogonal to forward.
    const d = ux * fx + uy * fy + uz * fz;
    ux -= fx * d; uy -= fy * d; uz -= fz * d;
    l = Math.hypot(ux, uy, uz);
    ux /= l; uy /= l; uz /= l;
    this.xx = fx; this.xy = fy; this.xz = fz;
    this.yx = ux; this.yy = uy; this.yz = uz;
    this.zx = fy * uz - fz * uy;
    this.zy = fz * ux - fx * uz;
    this.zz = fx * uy - fy * ux;
    this.tx = ox; this.ty = oy; this.tz = oz;
    return this;
  }

  identity() {
    return this.frame(0, 0, 0, 0);
  }

  private readonly frames: number[][] = [];

  /** Pushes the current frame so a nested frame can be used and then undone. */
  save() {
    this.frames.push([this.xx, this.xy, this.xz, this.yx, this.yy, this.yz, this.zx, this.zy, this.zz, this.tx, this.ty, this.tz]);
    return this;
  }

  restore() {
    const f = this.frames.pop();
    if (f) [this.xx, this.xy, this.xz, this.yx, this.yy, this.yz, this.zx, this.zy, this.zz, this.tx, this.ty, this.tz] = f;
    return this;
  }

  /** Writes the world position of a local point into `out`. */
  toWorld(lx: number, ly: number, lz: number, out: number[]) {
    out[0] = this.tx + this.xx * lx + this.yx * ly + this.zx * lz;
    out[1] = this.ty + this.xy * lx + this.yy * ly + this.zy * lz;
    out[2] = this.tz + this.xz * lx + this.yz * ly + this.zz * lz;
    return out;
  }

  /** Animation pivot given in the local frame. */
  pivot(lx: number, ly: number, lz: number) {
    this.pivX = this.tx + this.xx * lx + this.yx * ly + this.zx * lz;
    this.pivY = this.ty + this.xy * lx + this.yy * ly + this.zy * lz;
    this.pivZ = this.tz + this.xz * lx + this.yz * ly + this.zz * lz;
    return this;
  }

  anim(a0: number, a1 = 0, a2 = 0, a3 = 0) {
    this.an0 = a0;
    this.an1 = a1;
    this.an2 = a2;
    this.an3 = a3;
    return this;
  }

  vert(lx: number, ly: number, lz: number, nx: number, ny: number, nz: number, u = this.pu, v = this.pv) {
    this.growVerts(1);
    const i = this.nv++;
    const o = i * 3;
    this.pos[o] = this.tx + this.xx * lx + this.yx * ly + this.zx * lz;
    this.pos[o + 1] = this.ty + this.xy * lx + this.yy * ly + this.zy * lz;
    this.pos[o + 2] = this.tz + this.xz * lx + this.yz * ly + this.zz * lz;
    let wx = this.xx * nx + this.yx * ny + this.zx * nz;
    let wy = this.xy * nx + this.yy * ny + this.zy * nz;
    let wz = this.xz * nx + this.yz * ny + this.zz * nz;
    const l = Math.hypot(wx, wy, wz) || 1;
    wx /= l; wy /= l; wz /= l;
    this.nor[o] = wx;
    this.nor[o + 1] = wy;
    this.nor[o + 2] = wz;
    this.col[o] = this.r;
    this.col[o + 1] = this.g;
    this.col[o + 2] = this.b;
    this.uv[i * 2] = u;
    this.uv[i * 2 + 1] = v;
    if (this.piv && this.anm) {
      this.piv[o] = this.pivX;
      this.piv[o + 1] = this.pivY;
      this.piv[o + 2] = this.pivZ;
      const q = i * 4;
      this.anm[q] = this.an0;
      this.anm[q + 1] = this.an1;
      this.anm[q + 2] = this.an2;
      this.anm[q + 3] = this.an3;
    }
    return i;
  }

  tri(a: number, b: number, c: number) {
    this.growIdx(3);
    const t = this.idx;
    t[this.ni++] = a;
    t[this.ni++] = b;
    t[this.ni++] = c;
  }

  /** Triangle oriented so its face normal agrees with the stored normal of `a`. */
  triAuto(a: number, b: number, c: number) {
    const p = this.pos, n = this.nor;
    const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
    const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const hx = n[a * 3] + n[b * 3] + n[c * 3], hy = n[a * 3 + 1] + n[b * 3 + 1] + n[c * 3 + 1], hz = n[a * 3 + 2] + n[b * 3 + 2] + n[c * 3 + 2];
    if (cx * hx + cy * hy + cz * hz < 0) this.tri(a, c, b);
    else this.tri(a, b, c);
  }

  /** Quad from four vertex indices, counter-clockwise seen from the front. */
  quadIdx(a: number, b: number, c: number, d: number) {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  quadAuto(a: number, b: number, c: number, d: number) {
    this.triAuto(a, b, c);
    this.triAuto(a, c, d);
  }

  /**
   * Planar quad p0..p3 (bottom-left, bottom-right, top-right, top-left as seen
   * from the front). UV rect maps u0..u1 left to right and v0..v1 bottom to top.
   */
  quad(
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
    x3: number, y3: number, z3: number,
    uv?: UVRect,
  ) {
    const ax = x2 - x0, ay = y2 - y0, az = z2 - z0;
    const bx = x3 - x1, by = y3 - y1, bz = z3 - z1;
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const u0 = uv ? uv[0] : this.pu, v0 = uv ? uv[1] : this.pv, u1 = uv ? uv[2] : this.pu, v1 = uv ? uv[3] : this.pv;
    const a = this.vert(x0, y0, z0, nx, ny, nz, u0, v0);
    const b = this.vert(x1, y1, z1, nx, ny, nz, u1, v0);
    const c = this.vert(x2, y2, z2, nx, ny, nz, u1, v1);
    const d = this.vert(x3, y3, z3, nx, ny, nz, u0, v1);
    this.quadIdx(a, b, c, d);
  }

  /** Quad whose winding is flipped if needed so it faces along the hint direction. */
  quadFacing(
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
    x3: number, y3: number, z3: number,
    hx: number, hy: number, hz: number,
    uv?: UVRect,
  ) {
    const ax = x2 - x0, ay = y2 - y0, az = z2 - z0;
    const bx = x3 - x1, by = y3 - y1, bz = z3 - z1;
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    if (nx * hx + ny * hy + nz * hz >= 0) this.quad(x0, y0, z0, x1, y1, z1, x2, y2, z2, x3, y3, z3, uv);
    else this.quad(x1, y1, z1, x0, y0, z0, x3, y3, z3, x2, y2, z2, uv ? [uv[2], uv[1], uv[0], uv[3]] : undefined);
  }

  /** Tiled quad (see quadTiled) flipped to face along the hint. */
  quadTiledFacing(
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
    x3: number, y3: number, z3: number,
    cols: number,
    rows: number,
    uv: UVRect,
    hx: number, hy: number, hz: number,
  ) {
    // Normal from the bottom edge and the left side (robust when the top edge collapses to a point).
    const ex = x1 - x0, ey = y1 - y0, ez = z1 - z0;
    const mx = (x2 + x3) / 2 - x0, my = (y2 + y3) / 2 - y0, mz = (z2 + z3) / 2 - z0;
    const nx = ey * mz - ez * my, ny = ez * mx - ex * mz, nz = ex * my - ey * mx;
    if (nx * hx + ny * hy + nz * hz >= 0) this.quadTiled(x0, y0, z0, x1, y1, z1, x2, y2, z2, x3, y3, z3, cols, rows, uv);
    else this.quadTiled(x1, y1, z1, x0, y0, z0, x3, y3, z3, x2, y2, z2, cols, rows, [uv[2], uv[1], uv[0], uv[3]]);
  }

  /** Both sides of a thin quad (for cloth, awnings, kites). */
  quad2(
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
    x3: number, y3: number, z3: number,
    uv?: UVRect,
  ) {
    this.quad(x0, y0, z0, x1, y1, z1, x2, y2, z2, x3, y3, z3, uv);
    const r: UVRect | undefined = uv ? [uv[2], uv[1], uv[0], uv[3]] : undefined;
    this.quad(x1, y1, z1, x0, y0, z0, x3, y3, z3, x2, y2, z2, r);
  }

  /** Planar quad subdivided into columns that each repeat the full UV rect. */
  quadTiled(
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
    x3: number, y3: number, z3: number,
    cols: number,
    rows: number,
    uv: UVRect,
  ) {
    for (let i = 0; i < cols; i++) {
      const a = i / cols, b = (i + 1) / cols;
      // Bottom and top edge points of this column.
      const bax = x0 + (x1 - x0) * a, bay = y0 + (y1 - y0) * a, baz = z0 + (z1 - z0) * a;
      const bbx = x0 + (x1 - x0) * b, bby = y0 + (y1 - y0) * b, bbz = z0 + (z1 - z0) * b;
      const tax = x3 + (x2 - x3) * a, tay = y3 + (y2 - y3) * a, taz = z3 + (z2 - z3) * a;
      const tbx = x3 + (x2 - x3) * b, tby = y3 + (y2 - y3) * b, tbz = z3 + (z2 - z3) * b;
      for (let j = 0; j < rows; j++) {
        const c = j / rows, d = (j + 1) / rows;
        this.quad(
          bax + (tax - bax) * c, bay + (tay - bay) * c, baz + (taz - baz) * c,
          bbx + (tbx - bbx) * c, bby + (tby - bby) * c, bbz + (tbz - bbz) * c,
          bbx + (tbx - bbx) * d, bby + (tby - bby) * d, bbz + (tbz - bbz) * d,
          bax + (tax - bax) * d, bay + (tay - bay) * d, baz + (taz - baz) * d,
          uv,
        );
      }
    }
  }

  /** Triangle with a computed flat normal (counter-clockwise from the front). */
  triFlat(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, uv?: UVRect) {
    const ax = x1 - x0, ay = y1 - y0, az = z1 - z0;
    const bx = x2 - x0, by = y2 - y0, bz = z2 - z0;
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const a = this.vert(x0, y0, z0, nx, ny, nz, uv ? uv[0] : this.pu, uv ? uv[1] : this.pv);
    const b = this.vert(x1, y1, z1, nx, ny, nz, uv ? uv[2] : this.pu, uv ? uv[1] : this.pv);
    const c = this.vert(x2, y2, z2, nx, ny, nz, uv ? (uv[0] + uv[2]) / 2 : this.pu, uv ? uv[3] : this.pv);
    this.tri(a, b, c);
  }

  /** Axis-aligned box in the local frame. */
  box(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, faces = ALL_FACES) {
    const x0 = cx - hx, x1 = cx + hx, y0 = cy - hy, y1 = cy + hy, z0 = cz - hz, z1 = cz + hz;
    if (faces & PX) this.quad(x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1);
    if (faces & NX) this.quad(x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0);
    if (faces & PZ) this.quad(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1);
    if (faces & NZ) this.quad(x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0);
    if (faces & PY) this.quad(x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0);
    if (faces & NY) this.quad(x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1);
  }

  /** Box spanning from a to b (local points) with a square cross-section, e.g. posts and beams. */
  beam(ax: number, ay: number, az: number, bx: number, by: number, bz: number, w: number, h = w) {
    let dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return;
    dx /= len; dy /= len; dz /= len;
    // Side vector: perpendicular to the beam and as horizontal as possible.
    let sx = -dz, sy = 0, sz = dx;
    let sl = Math.hypot(sx, sy, sz);
    if (sl < 1e-4) {
      sx = 1; sy = 0; sz = 0; sl = 1;
    }
    sx /= sl; sy /= sl; sz /= sl;
    const ux = dy * sz - dz * sy, uy = dz * sx - dx * sz, uz = dx * sy - dy * sx;
    const hw = w / 2, hh = h / 2;
    const corner = (t: number, a: number, b: number): [number, number, number] => [
      (t ? bx : ax) + sx * a * hw + ux * b * hh,
      (t ? by : ay) + sy * a * hw + uy * b * hh,
      (t ? bz : az) + sz * a * hw + uz * b * hh,
    ];
    const sides: [number, number][] = [[1, -1], [1, 1], [-1, 1], [-1, -1]];
    for (let k = 0; k < 4; k++) {
      const [a0, b0] = sides[k], [a1, b1] = sides[(k + 1) % 4];
      const p0 = corner(0, a0, b0), p1 = corner(0, a1, b1), p2 = corner(1, a1, b1), p3 = corner(1, a0, b0);
      // Outward normal is the mean of the two corner offsets; orient accordingly.
      const ox = sx * (a0 + a1) + ux * (b0 + b1), oy = sy * (a0 + a1) + uy * (b0 + b1), oz = sz * (a0 + a1) + uz * (b0 + b1);
      const ex = p1[0] - p0[0], ey = p1[1] - p0[1], ez = p1[2] - p0[2];
      const nx = ey * dz - ez * dy, ny = ez * dx - ex * dz, nz = ex * dy - ey * dx;
      // quad(p0..p3) faces along e x d; flip when that points inward.
      if (nx * ox + ny * oy + nz * oz >= 0) this.quad(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2], p3[0], p3[1], p3[2]);
      else this.quad(p1[0], p1[1], p1[2], p0[0], p0[1], p0[2], p3[0], p3[1], p3[2], p2[0], p2[1], p2[2]);
    }
  }

  /**
   * Vertical (frustum of a) cylinder in the local frame. `caps`: 1 top, 2 bottom.
   * `flat` gives faceted normals.
   */
  cylinder(cx: number, cy: number, cz: number, r0: number, r1: number, h: number, sides: number, caps = 1, flat = false, a0 = 0) {
    const slope = (r0 - r1) / h;
    if (flat) {
      for (let i = 0; i < sides; i++) {
        const t0 = a0 + (i / sides) * Math.PI * 2, t1 = a0 + ((i + 1) / sides) * Math.PI * 2;
        const c0 = Math.cos(t0), s0 = Math.sin(t0), c1 = Math.cos(t1), s1 = Math.sin(t1);
        this.quad(
          cx + c1 * r0, cy, cz + s1 * r0,
          cx + c0 * r0, cy, cz + s0 * r0,
          cx + c0 * r1, cy + h, cz + s0 * r1,
          cx + c1 * r1, cy + h, cz + s1 * r1,
        );
      }
    } else {
      const base = this.nv;
      for (let i = 0; i <= sides; i++) {
        const t = a0 + (i / sides) * Math.PI * 2;
        const c = Math.cos(t), s = Math.sin(t);
        this.vert(cx + c * r0, cy, cz + s * r0, c, slope, s);
        this.vert(cx + c * r1, cy + h, cz + s * r1, c, slope, s);
      }
      for (let i = 0; i < sides; i++) {
        const a = base + i * 2, b = a + 2;
        // b(bottom) -> a(bottom) -> a(top) -> b(top) is counter-clockwise from outside.
        this.quadIdx(b, a, a + 1, b + 1);
      }
    }
    if (caps & 1 && r1 > 0) this.disc(cx, cy + h, cz, r1, sides, 1, a0);
    if (caps & 2 && r0 > 0) this.disc(cx, cy, cz, r0, sides, -1, a0);
  }

  /** Horizontal disc facing up (dir 1) or down (dir -1). */
  disc(cx: number, cy: number, cz: number, r: number, sides: number, dir: 1 | -1, a0 = 0) {
    const c = this.vert(cx, cy, cz, 0, dir, 0);
    const base = this.nv;
    for (let i = 0; i < sides; i++) {
      const t = a0 + (i / sides) * Math.PI * 2;
      this.vert(cx + Math.cos(t) * r, cy, cz + Math.sin(t) * r, 0, dir, 0);
    }
    for (let i = 0; i < sides; i++) {
      const a = base + i, b = base + ((i + 1) % sides);
      if (dir > 0) this.tri(c, b, a);
      else this.tri(c, a, b);
    }
  }

  /** Cone (or pyramid) from a base ring up to an apex, faceted. */
  cone(cx: number, cy: number, cz: number, r: number, h: number, sides: number, a0 = 0, uv?: UVRect) {
    for (let i = 0; i < sides; i++) {
      const t0 = a0 + (i / sides) * Math.PI * 2, t1 = a0 + ((i + 1) / sides) * Math.PI * 2;
      this.triFlat(cx + Math.cos(t1) * r, cy, cz + Math.sin(t1) * r, cx + Math.cos(t0) * r, cy, cz + Math.sin(t0) * r, cx, cy + h, cz, uv);
    }
  }

  /** Low-poly ellipsoid blob (octahedron-ish, 2 rings). */
  blob(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, sides = 6) {
    const rings = [-1, -0.45, 0.45, 1];
    const base = this.nv;
    const top = this.vert(cx, cy + ry, cz, 0, 1, 0);
    const bot = this.vert(cx, cy - ry, cz, 0, -1, 0);
    for (let k = 1; k < 3; k++) {
      const y = rings[k];
      const rr = Math.sqrt(1 - y * y);
      for (let i = 0; i < sides; i++) {
        const t = (i / sides) * Math.PI * 2 + k * 0.4;
        const nx = Math.cos(t) * rr, nz = Math.sin(t) * rr;
        this.vert(cx + nx * rx, cy + y * ry, cz + nz * rz, nx / rx, y / ry, nz / rz);
      }
    }
    const ring = (k: number, i: number) => base + 2 + (k - 1) * sides + (i % sides);
    for (let i = 0; i < sides; i++) {
      this.triAuto(top, ring(2, i), ring(2, i + 1));
      this.triAuto(bot, ring(1, i + 1), ring(1, i));
      this.quadAuto(ring(1, i), ring(1, i + 1), ring(2, i + 1), ring(2, i));
    }
  }

  /** Returns the geometry, recentred on its bounds unless `recenter` is false. */
  build(recenter = true): { geometry: THREE.BufferGeometry; center: THREE.Vector3 } {
    const n = this.nv;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    const p = this.pos;
    for (let i = 0; i < n; i++) {
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const center = recenter ? new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2) : new THREE.Vector3();
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = p[i * 3] - center.x;
      pos[i * 3 + 1] = p[i * 3 + 1] - center.y;
      pos[i * 3 + 2] = p[i * 3 + 2] - center.z;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(this.nor.slice(0, n * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col.slice(0, n * 3), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(this.uv.slice(0, n * 2), 2));
    if (this.piv && this.anm) {
      const pv = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        pv[i * 3] = this.piv[i * 3] - center.x;
        pv[i * 3 + 1] = this.piv[i * 3 + 1] - center.y;
        pv[i * 3 + 2] = this.piv[i * 3 + 2] - center.z;
      }
      geo.setAttribute('aPivot', new THREE.BufferAttribute(pv, 3));
      geo.setAttribute('aAnim', new THREE.BufferAttribute(this.anm.slice(0, n * 4), 4));
    }
    const index = n > 65535 ? new THREE.BufferAttribute(this.idx.slice(0, this.ni), 1) : new THREE.BufferAttribute(Uint16Array.from(this.idx.subarray(0, this.ni)), 1);
    geo.setIndex(index);
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return { geometry: geo, center };
  }
}

/** Line segments with per-vertex colours (wires, rebar). */
export class LineBuilder {
  pos: number[] = [];
  col: number[] = [];
  r = 0.1;
  g = 0.1;
  b = 0.1;

  color(c: THREE.Color, k = 1) {
    this.r = c.r * k;
    this.g = c.g * k;
    this.b = c.b * k;
    return this;
  }

  seg(ax: number, ay: number, az: number, bx: number, by: number, bz: number) {
    this.pos.push(ax, ay, az, bx, by, bz);
    this.col.push(this.r, this.g, this.b, this.r, this.g, this.b);
  }

  /** Sagging wire between two points as `n` straight pieces. */
  catenary(ax: number, ay: number, az: number, bx: number, by: number, bz: number, sag: number, n: number) {
    let px = ax, py = ay, pz = az;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      const y = ay + (by - ay) * t - sag * 4 * t * (1 - t);
      this.seg(px, py, pz, x, y, z);
      px = x;
      py = y;
      pz = z;
    }
  }

  build() {
    const n = this.pos.length / 3;
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < n; i++) {
      cx += this.pos[i * 3];
      cy += this.pos[i * 3 + 1];
      cz += this.pos[i * 3 + 2];
    }
    const center = new THREE.Vector3(cx / Math.max(1, n), cy / Math.max(1, n), cz / Math.max(1, n));
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = this.pos[i * 3] - center.x;
      pos[i * 3 + 1] = this.pos[i * 3 + 1] - center.y;
      pos[i * 3 + 2] = this.pos[i * 3 + 2] - center.z;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
    geo.computeBoundingSphere();
    return { geometry: geo, center };
  }
}
