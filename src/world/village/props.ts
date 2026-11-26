import * as THREE from 'three';
import type { MeshBuilder, UVRect } from './builder.ts';
import { NO_BOTTOM } from './builder.ts';
import { rr } from './site.ts';

const col = (h: number) => new THREE.Color(h);
const WHITE = col(0xf3f2ee);
const WOOD = col(0x6b4a2f);

/** Station table of a 7 m panga: x fraction, half-beam fraction, keel height, sheer height. */
const PANGA_STATIONS: readonly (readonly [number, number, number, number])[] = [
  [0.0, 0.82, 0.07, 0.8],
  [0.18, 0.94, 0.02, 0.78],
  [0.42, 1.0, 0.0, 0.8],
  [0.66, 0.92, 0.03, 0.88],
  [0.84, 0.64, 0.13, 1.0],
  [0.95, 0.3, 0.32, 1.1],
  [1.0, 0.03, 0.56, 1.16],
];

/** Cross-section points (z, y) of one hull side at a station, keel to sheer. */
function section(st: readonly [number, number, number, number], beam: number): [number, number][] {
  const [, hbF, yk, ys] = st;
  const hb = beam * hbF;
  const yc = yk + 0.24;
  return [
    [0, yk],
    [0.42 * hb, yk + 0.07],
    [0.92 * hb, yc],
    [0.985 * hb, yc + 0.6 * (ys - yc)],
    [hb, ys],
  ];
}

export const PANGA_BANDS = [0x1f6fb5, 0x17a2a0, 0xc8333a, 0xf0c33c, 0x2a4f9c, 0x34b38a, 0xe0703a];

/**
 * Open fibreglass panga, bow toward local +x, transom at x = 0, keel at y = 0.
 * `tilted` raises the outboard as on the beach.
 */
export function panga(b: MeshBuilder, band: THREE.Color, rnd: () => number, tilted: boolean, length = 7.2) {
  const beam = 0.95 * (length / 7.2);
  const L = length;
  const secs = PANGA_STATIONS.map((st) => section(st, beam));
  // Outer hull, both sides.
  for (const side of [1, -1]) {
    for (let k = 0; k < 4; k++) {
      b.color(k === 3 ? band : WHITE, k === 0 ? 0.9 : 1);
      for (let i = 0; i + 1 < PANGA_STATIONS.length; i++) {
        const A = secs[i], B = secs[i + 1];
        const xa = PANGA_STATIONS[i][0] * L, xb = PANGA_STATIONS[i + 1][0] * L;
        b.quadFacing(
          xa, A[k][1], side * A[k][0],
          xb, B[k][1], side * B[k][0],
          xb, B[k + 1][1], side * B[k + 1][0],
          xa, A[k + 1][1], side * A[k + 1][0],
          0, k === 0 ? -1 : k === 1 ? -0.4 : 0, side,
        );
      }
    }
    // Inside of the hull and the gunwale cap.
    for (let i = 0; i + 1 < PANGA_STATIONS.length - 1; i++) {
      const A = secs[i], B = secs[i + 1];
      const xa = PANGA_STATIONS[i][0] * L, xb = PANGA_STATIONS[i + 1][0] * L;
      b.color(WHITE, 0.82);
      b.quadFacing(
        xa, A[2][1] + 0.04, side * A[2][0] * 0.93,
        xb, B[2][1] + 0.04, side * B[2][0] * 0.93,
        xb, B[4][1], side * B[4][0] * 0.94,
        xa, A[4][1], side * A[4][0] * 0.94,
        0, 0.3, -side,
      );
      b.color(band, 0.85);
      b.quadFacing(
        xa, A[4][1], side * A[4][0] * 0.94,
        xb, B[4][1], side * B[4][0] * 0.94,
        xb, B[4][1] + 0.02, side * B[4][0],
        xa, A[4][1] + 0.02, side * A[4][0],
        0, 1, 0,
      );
    }
  }
  // Floor.
  b.color(WHITE, 0.75);
  for (let i = 0; i + 1 < 5; i++) {
    const A = secs[i], B = secs[i + 1];
    const xa = PANGA_STATIONS[i][0] * L, xb = PANGA_STATIONS[i + 1][0] * L;
    const ya = A[2][1] + 0.04, yb = B[2][1] + 0.04;
    b.quadFacing(xa, ya, -A[2][0] * 0.93, xb, yb, -B[2][0] * 0.93, xb, yb, B[2][0] * 0.93, xa, ya, A[2][0] * 0.93, 0, 1, 0);
  }
  // Transom.
  const t = secs[0];
  b.color(WHITE, 0.95);
  for (const side of [1, -1]) {
    for (let k = 0; k < 4; k++) {
      b.quadFacing(0, t[k][1], side * t[k][0], 0, t[k + 1][1], side * t[k + 1][0], 0, t[k + 1][1], 0, 0, t[k][1], 0, -1, 0, 0);
    }
  }
  // Thwarts.
  b.color(WHITE, 0.92);
  for (const f of [0.34, 0.6]) {
    const st = PANGA_STATIONS[f < 0.5 ? 2 : 3];
    const hb = beam * st[1] * 0.92;
    b.box(f * L, st[3] - 0.22, 0, 0.16, 0.03, hb, 63);
  }
  // Outboard.
  const cowl = col([0x5b6066, 0xe7e7e4, 0x26282b, 0x3b5f8a][Math.floor(rnd() * 4)]);
  const ys = PANGA_STATIONS[0][3];
  b.color(col(0x3a3d40));
  if (tilted) {
    b.beam(-0.2, ys - 0.05, 0, -1.05, ys + 0.2, 0, 0.1, 0.16);
    b.box(-1.1, ys + 0.18, 0, 0.12, 0.05, 0.1, 63);
    b.color(cowl);
    b.box(-0.32, ys + 0.22, 0, 0.3, 0.26, 0.22, 63);
  } else {
    b.beam(-0.22, ys - 0.1, 0, -0.22, -0.55, 0, 0.1, 0.16);
    b.color(cowl);
    b.box(-0.34, ys + 0.28, 0, 0.24, 0.32, 0.21, 63);
  }
  b.color(cowl, 0.6);
  b.box(-0.15, ys + 0.05, 0, 0.08, 0.06, 0.1, 63);
}

/** Thatched beach umbrella (palapa) on a palm-trunk pole, origin at the base. */
export function palapaUmbrella(b: MeshBuilder, thatch: THREE.Color, thatchUV: UVRect, r: number, h: number, rnd: () => number) {
  b.color(WOOD);
  b.box(0, (h + 1.1) / 2, 0, 0.08, (h + 1.1) / 2, 0.08, NO_BOTTOM);
  const sides = 9;
  const a0 = rnd() * Math.PI;
  const rise = r * rr(rnd, 0.55, 0.7);
  b.color(thatch);
  b.cone(0, h, 0, r, rise, sides, a0, thatchUV);
  b.color(thatch, 0.45);
  for (let i = 0; i < sides; i++) {
    const t0 = a0 + (i / sides) * Math.PI * 2, t1 = a0 + ((i + 1) / sides) * Math.PI * 2;
    b.triFlat(Math.cos(t0) * r, h, Math.sin(t0) * r, Math.cos(t1) * r, h, Math.sin(t1) * r, 0, h + rise * 0.9, 0);
  }
  // Hanging fringe.
  b.color(thatch, 0.85);
  for (let i = 0; i < sides; i++) {
    const t0 = a0 + (i / sides) * Math.PI * 2, t1 = a0 + ((i + 1) / sides) * Math.PI * 2;
    const c0 = Math.cos(t0), s0 = Math.sin(t0), c1 = Math.cos(t1), s1 = Math.sin(t1);
    const ro = r + 0.06;
    b.quadFacing(c1 * ro, h - 0.32, s1 * ro, c0 * ro, h - 0.32, s0 * ro, c0 * r, h + 0.02, s0 * r, c1 * r, h + 0.02, s1 * r, (c0 + c1) / 2, 0, (s0 + s1) / 2);
    b.quadFacing(c1 * ro, h - 0.32, s1 * ro, c0 * ro, h - 0.32, s0 * ro, c0 * r, h + 0.02, s0 * r, c1 * r, h + 0.02, s1 * r, -(c0 + c1) / 2, 0, -(s0 + s1) / 2);
  }
}

/** White plastic table with chairs, or a pair of loungers, under a palapa. */
export function beachFurniture(b: MeshBuilder, rnd: () => number, facing: number) {
  const plastic = col(rnd() < 0.7 ? 0xf3f3ef : [0xc8102e, 0x1d64b0, 0xf2c14e][Math.floor(rnd() * 3)]);
  if (rnd() < 0.55) {
    b.color(plastic);
    b.box(0, 0.7, 0, 0.42, 0.025, 0.42, 63);
    b.box(0, 0.35, 0, 0.04, 0.34, 0.04, 63 & ~8 & ~4);
    const n = 2 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) {
      const a = facing + (i / n) * Math.PI * 2 + rr(rnd, -0.3, 0.3);
      const cx = Math.cos(a) * 0.75, cz = Math.sin(a) * 0.75;
      b.color(plastic, 0.95);
      b.box(cx, 0.22, cz, 0.2, 0.22, 0.2, 63 & ~8);
      b.box(cx + Math.cos(a) * 0.19, 0.62, cz + Math.sin(a) * 0.19, 0.03 + Math.abs(Math.sin(a)) * 0.17, 0.2, 0.03 + Math.abs(Math.cos(a)) * 0.17, 63 & ~8);
    }
  } else {
    for (const off of [-0.45, 0.45]) {
      const ux = Math.cos(facing), uz = Math.sin(facing);
      const px = -uz * off, pz = ux * off;
      b.color(plastic);
      b.beam(px - ux * 0.9, 0.3, pz - uz * 0.9, px + ux * 0.5, 0.3, pz + uz * 0.5, 0.6, 0.06);
      b.beam(px + ux * 0.5, 0.3, pz + uz * 0.5, px + ux * 0.9, 0.75, pz + uz * 0.9, 0.6, 0.06);
    }
  }
}

export interface KitePalette {
  canopy: number[];
  tube: number;
}

/**
 * Leading-edge-inflatable kite parked on the sand: leading edge on the ground
 * facing upwind (local -x), canopy arching up and back downwind (+x).
 * Canopy vertices carry flutter weights for the animated material (kind 5).
 */
export function parkedKite(b: MeshBuilder, p: KitePalette, rnd: () => number, span = 1) {
  const R = 3.9 * span;
  const arc = 1.22;
  const nT = 14, nS = 3;
  const ph = rnd() * 6.28;
  const le = (t: number) => {
    const a = t * arc;
    return [R * (1 - Math.cos(a)) * 0.85, R * Math.sin(a)];
  };
  const tubeR = (t: number) => 0.2 * span * (1 - 0.45 * t * t);
  const chord = (t: number) => 2.5 * span * (1 - 0.6 * t * t);
  const point = (t: number, s: number): [number, number, number] => {
    const [x0, z0] = le(t);
    const c = chord(t);
    const lift = 1 - 0.9 * t * t;
    const x = x0 + tubeR(t) * 0.6 + s * c * 0.62 + Math.sin(Math.PI * s) * 0.3 * lift;
    const y = tubeR(t) * 1.7 + s * c * 0.78 * lift + Math.sin(Math.PI * s) * 0.12;
    return [x, y, z0 * (1 - 0.05 * s)];
  };
  // Canopy panels (own vertices per quad so panel colours stay crisp).
  const vtx = (t: number, s: number) => {
    const [x, y, z] = point(t, s);
    const [xa, ya] = point(t, Math.min(1, s + 0.05)), [xb, yb] = point(t, Math.max(0, s - 0.05));
    const dx = xa - xb, dy = ya - yb;
    const l = Math.hypot(dx, dy) || 1;
    b.anim(5, ph, s * s);
    return b.vert(x, y, z, -dy / l, dx / l, 0);
  };
  for (let i = 0; i < nT; i++) {
    const t0 = (i / nT) * 2 - 1, t1 = ((i + 1) / nT) * 2 - 1;
    const panel = Math.min(p.canopy.length - 1, Math.floor((((t0 + t1) / 2 + 1) / 2) * p.canopy.length));
    b.color(col(p.canopy[panel]));
    for (let j = 0; j < nS; j++) {
      const s0 = j / nS, s1 = (j + 1) / nS;
      b.quadAuto(vtx(t0, s0), vtx(t1, s0), vtx(t1, s1), vtx(t0, s1));
    }
  }
  // Leading-edge tube (half cylinder facing upwind) and the centre strut.
  b.anim(0);
  b.color(col(p.tube));
  const ring: number[][] = [];
  const angles = [-1.6, -0.6, 0.4, 1.4, 2.4];
  for (let i = 0; i <= nT; i++) {
    const t = (i / nT) * 2 - 1;
    const [x0, z0] = le(t);
    const r = tubeR(t);
    const r2: number[] = [];
    for (const a of angles) {
      const nx = -Math.cos(a), ny = Math.sin(a) * 0.9 + 0.1;
      r2.push(b.vert(x0 + r * 0.6 + nx * r, r + Math.sin(a) * r, z0, nx, ny, 0));
    }
    ring.push(r2);
  }
  for (let i = 0; i < nT; i++) for (let k = 0; k + 1 < angles.length; k++) b.quadAuto(ring[i][k], ring[i + 1][k], ring[i + 1][k + 1], ring[i][k + 1]);
  for (const t of [-0.55, 0, 0.55]) {
    const a = point(t, 0.02), c = point(t, 0.85);
    b.beam(a[0], a[1] + 0.04, a[2], c[0], c[1] + 0.04, c[2], 0.09, 0.07);
  }
}

/** Twin-tip board lying on the sand, long axis along local x. */
export function kiteboard(b: MeshBuilder, base: THREE.Color, accent: THREE.Color) {
  b.color(base);
  b.box(0, 0.02, 0, 0.69, 0.02, 0.21, 63 & ~8);
  b.color(accent);
  b.box(0, 0.042, 0, 0.45, 0.003, 0.12, 4);
  b.color(col(0x222222));
  b.box(0.25, 0.06, 0, 0.05, 0.02, 0.1, 63 & ~8);
  b.box(-0.25, 0.06, 0, 0.05, 0.02, 0.1, 63 & ~8);
}

export interface PersonLook {
  skin: number;
  top: number;
  bottom: number;
  legs: number;
  hair: number;
  hat: number | null;
  sombrero: boolean;
  harness: number | null;
}

/** Low-poly person facing local +x, feet at the origin; head vertices tagged for idle turns. */
export function person(b: MeshBuilder, look: PersonLook, rnd: () => number, sitting = false) {
  const ph = rnd() * 6.28;
  b.pivot(0, 0, 0);
  b.anim(1, ph, 0);
  const skin = col(look.skin), top = col(look.top), bottom = col(look.bottom), legs = col(look.legs);
  const s = rr(rnd, 0.93, 1.07);
  if (!sitting) {
    for (const z of [-0.1, 0.1]) {
      b.color(legs);
      b.box(0, 0.26 * s, z, 0.07, 0.26 * s, 0.06, 63);
      b.color(bottom);
      b.box(0, 0.7 * s, z, 0.08, 0.18 * s, 0.075, 63);
    }
    b.color(top);
    b.box(0, 1.14 * s, 0, 0.11, 0.27 * s, 0.2, 63);
    if (look.harness !== null) {
      b.color(col(look.harness));
      b.box(0, 0.92 * s, 0, 0.125, 0.07, 0.215, 63);
    }
    for (const z of [-0.26, 0.26]) {
      b.color(top);
      b.box(0, 1.33 * s, z, 0.055, 0.08 * s, 0.055, 63);
      b.color(skin);
      b.box(0.02, 1.02 * s, z * 1.02, 0.045, 0.24 * s, 0.045, 63);
    }
  } else {
    for (const z of [-0.1, 0.1]) {
      b.color(bottom);
      b.box(0.2, 0.09, z, 0.2, 0.08, 0.075, 63);
      b.color(legs);
      b.box(0.55, 0.08, z, 0.17, 0.065, 0.06, 63);
    }
    b.color(top);
    b.box(-0.02, 0.45, 0, 0.11, 0.27, 0.2, 63);
    for (const z of [-0.26, 0.26]) {
      b.color(skin);
      b.beam(-0.02, 0.62, z, 0.12, 0.25, z * 1.1, 0.08, 0.08);
    }
  }
  const hy = sitting ? 0.72 : 1.42 * s;
  b.anim(1, ph, 1);
  b.color(skin);
  b.box(0.01, hy + 0.13, 0, 0.1, 0.12, 0.09, 63);
  if (look.sombrero) {
    b.color(col(0xd8bf86));
    b.cylinder(0, hy + 0.22, 0, 0.33, 0.33, 0.02, 8, 3);
    b.cylinder(0, hy + 0.24, 0, 0.12, 0.09, 0.14, 6, 1);
  } else if (look.hat !== null) {
    b.color(col(look.hat));
    b.box(0, hy + 0.26, 0, 0.11, 0.035, 0.1, 63);
    b.box(0.13, hy + 0.235, 0, 0.07, 0.01, 0.085, 63);
  } else {
    b.color(col(look.hair));
    b.box(-0.01, hy + 0.255, 0, 0.11, 0.03, 0.1, 63);
    b.box(-0.07, hy + 0.17, 0, 0.045, 0.08, 0.1, 63);
  }
  b.anim(0);
}

export const DOG_COATS: readonly (readonly [number, number, number])[] = [
  // body, legs/face, snout
  [0xc89b5f, 0xdcc39a, 0x3a2a20],
  [0x2b2725, 0xb8864e, 0x1a1715],
  [0x6e4b31, 0x8a6446, 0x2a1d15],
  [0xebe5da, 0xebe5da, 0x3b3330],
  [0x8a8580, 0xb7b1a8, 0x2c2a28],
  [0x7a5a3a, 0xa27c52, 0x2a2018],
  [0xd9b98a, 0xefe3cc, 0x4a382a],
];

/** Beach dog facing local +x. `lying` dogs rest on the sand. */
export function dog(b: MeshBuilder, coat: readonly [number, number, number], rnd: () => number, lying: boolean) {
  const ph = rnd() * 6.28;
  const body = col(coat[0]), legs = col(coat[1]), snout = col(coat[2]);
  const sc = rr(rnd, 0.85, 1.12);
  const y0 = lying ? 0.0 : 0.3 * sc;
  const bh = 0.13 * sc;
  // Legs (static).
  b.anim(0);
  b.color(legs);
  if (!lying) {
    for (const [x, z] of [[0.22, 0.075], [0.22, -0.075], [-0.24, 0.075], [-0.24, -0.075]]) b.box(x * sc, (y0 + 0.02) / 2, z * sc, 0.035 * sc, (y0 + 0.02) / 2, 0.035 * sc, 63 & ~8);
  } else {
    for (const z of [0.07, -0.07]) b.box(0.36 * sc, 0.03, z * sc, 0.12 * sc, 0.03, 0.03 * sc, 63 & ~8);
  }
  // Body (breathing).
  b.pivot(0, y0, 0);
  b.anim(2, ph, 0);
  b.color(body);
  b.box(0, y0 + bh, 0, 0.3 * sc, bh, 0.11 * sc, 63);
  b.box(0.27 * sc, y0 + bh * 1.5, 0, 0.08 * sc, bh * 1.1, 0.1 * sc, 63);
  // Head.
  const hx = 0.38 * sc, hy = y0 + (lying ? 0.17 : 0.34) * sc;
  b.pivot(0.28 * sc, hy - 0.05, 0);
  b.anim(2, ph, 1);
  b.color(body);
  b.box(hx, hy, 0, 0.1 * sc, 0.09 * sc, 0.085 * sc, 63);
  b.color(legs);
  b.box(hx + 0.13 * sc, hy - 0.03 * sc, 0, 0.06 * sc, 0.045 * sc, 0.05 * sc, 63);
  b.color(snout);
  b.box(hx + 0.19 * sc, hy - 0.02 * sc, 0, 0.012, 0.022, 0.025, 63);
  b.color(body, 0.8);
  const flop = rnd() < 0.4;
  for (const z of [0.055, -0.055]) {
    if (flop) b.box(hx - 0.02, hy + 0.02 * sc, z * sc * 1.6, 0.03 * sc, 0.06 * sc, 0.015, 63);
    else b.box(hx - 0.03, hy + 0.12 * sc, z * sc, 0.025 * sc, 0.05 * sc, 0.022 * sc, 63);
  }
  // Tail.
  b.pivot(-0.3 * sc, y0 + bh * 1.6, 0);
  b.anim(2, ph, 2, lying ? 0.35 : rr(rnd, 0.6, 1.2));
  b.color(body);
  if (lying) b.beam(-0.3 * sc, y0 + 0.06, 0, -0.62 * sc, 0.03, 0.08, 0.05, 0.05);
  else b.beam(-0.3 * sc, y0 + bh * 1.6, 0, -0.48 * sc, y0 + bh * 1.6 + 0.2 * sc, 0, 0.05, 0.05);
  b.anim(0);
}

/**
 * Cloth (banner or flag) built along world +x from a pole at the frame origin
 * for the animated material (kind 3). `tile` covers the cloth; `mirror` makes
 * the printing read correctly from the side that faces east (the sea) once the
 * shader swings the cloth downwind in the Norte.
 */
export function cloth(b: MeshBuilder, tile: UVRect, width: number, y0: number, y1: number, topTaper: number, rnd: () => number, mirror = false) {
  const ph = rnd() * 6.28;
  b.pivot(0, 0, 0);
  const n = 5;
  const idx: number[][] = [];
  b.rgb(1, 1, 1);
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const x = u * width;
    // Feather banners round off toward the free edge at the top.
    const top = y1 - topTaper * u * u;
    b.anim(3, ph, u, width);
    const tu = tile[0] + (tile[2] - tile[0]) * (mirror ? 1 - u : u);
    const lo = b.vert(x, y0, 0, 0, 0, 1, tu, tile[1]);
    const hi = b.vert(x, top, 0, 0, 0, 1, tu, tile[1] + (tile[3] - tile[1]) * ((top - y0) / (y1 - y0)));
    idx.push([lo, hi]);
  }
  for (let i = 0; i < n; i++) b.quadIdx(idx[i][0], idx[i + 1][0], idx[i + 1][1], idx[i][1]);
  b.anim(0);
}

/** Plastic fish crates, a drum, a fuel tank or a net pile. */
export function beachClutter(b: MeshBuilder, rnd: () => number) {
  const r = rnd();
  if (r < 0.4) {
    const c = col([0x1d64b0, 0xf2c14e, 0xc8333a, 0x2a9d8f, 0xe76f51][Math.floor(rnd() * 5)]);
    const n = 1 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) {
      b.color(c, 1 - i * 0.05);
      b.box(rr(rnd, -0.05, 0.05), 0.16 + i * 0.3, rr(rnd, -0.05, 0.05), 0.3, 0.15, 0.2, 63 & ~8);
    }
  } else if (r < 0.62) {
    b.color(col([0x1f5fae, 0x2b6cb0, 0x3a7d44][Math.floor(rnd() * 3)]));
    b.cylinder(0, 0, 0, 0.29, 0.29, 0.88, 7, 1);
  } else if (r < 0.8) {
    b.color(col(0xc8102e));
    b.box(0, 0.14, 0, 0.27, 0.14, 0.17, 63 & ~8);
    b.color(col(0x222222));
    b.box(0.15, 0.31, 0, 0.03, 0.03, 0.03, 63 & ~8);
  } else {
    b.color(col([0x2f7d4a, 0xd9682b, 0x2a6fb5][Math.floor(rnd() * 3)]));
    b.blob(0, 0.12, 0, rr(rnd, 0.6, 1.0), 0.22, rr(rnd, 0.5, 0.8), 6);
  }
}
