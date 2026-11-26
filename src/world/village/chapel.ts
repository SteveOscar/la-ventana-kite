import * as THREE from 'three';
import type { MeshBuilder } from './builder.ts';
import type { Atlas } from './atlas.ts';
import { subUV } from './atlas.ts';
import { type Site, pointInPolygon } from './site.ts';

const col = (h: number) => new THREE.Color(h);

export interface ChapelSite {
  /** Centre of the front facade. */
  x: number;
  z: number;
  /** Local +x (the way the doors face) as an angle from +x toward +z. */
  yaw: number;
}

// Local footprint samples: nave (x -15..0, z -3.8..3.8), tower (x -3.2..0.4, z -7.4..-3.8), atrium (x 0..6.5, z -6..6).
const FOOTPRINT: [number, number][] = [];
for (let x = -15; x <= 6.5; x += 2.5) for (let z = -7.4; z <= 6; z += 2.4) {
  const inNave = x <= 0.4 && z >= -3.8;
  const inTower = x >= -3.2 && x <= 0.4 && z < -3.8;
  const inAtrium = x >= 0 && z >= -6;
  if (inNave || inTower || inAtrium) FOOTPRINT.push([x, z]);
}

/** Nearest free spot to (tx, tz) that fronts the main road without touching buildings, streets or the pitch. */
export function findChapelSite(site: Site, tx: number, tz: number): ChapelSite | null {
  const pitches = site.data.world.areas.filter((a) => a.kind === 'pitch').map((a) => a.pts);
  for (let r = 0; r <= 140; r += 3) {
    const n = r === 0 ? 1 : Math.ceil((Math.PI * 2 * r) / 3);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const x = tx + Math.cos(a) * r, z = tz + Math.sin(a) * r;
      const [rx, rz, rd] = site.roadNearest(x, z);
      if (rd < 15 || rd > 34) continue;
      const fx = (rx - x) / rd, fz = (rz - z) / rd;
      let ok = true;
      for (const [lx, lz] of FOOTPRINT) {
        const wx = x + fx * lx - fz * lz, wz = z + fz * lx + fx * lz;
        if (site.hitsBuilding(wx, wz, 2.2) || site.data.overlayAt(wx, wz)[0] > 0.25 || pitches.some((p) => pointInPolygon(wx, wz, p))) {
          ok = false;
          break;
        }
      }
      if (ok) return { x, z, yaw: Math.atan2(fz, fx) };
    }
  }
  return null;
}

/** Whitewashed chapel with a bell tower, tiled cupola, crosses and a walled atrium. */
export function buildChapel(b: MeshBuilder, atlas: Atlas, site: Site, cs: ChapelSite) {
  const T = atlas.tiles;
  const c = Math.cos(cs.yaw), s = Math.sin(cs.yaw);
  let lo = Infinity;
  for (const [lx, lz] of FOOTPRINT) lo = Math.min(lo, site.ground(cs.x + c * lx - s * lz, cs.z + s * lx + c * lz));
  // Nave and tower only (the atrium follows the ground).
  let naveHi = -Infinity;
  for (const [lx, lz] of FOOTPRINT) if (lx <= 0.4) naveHi = Math.max(naveHi, site.ground(cs.x + c * lx - s * lz, cs.z + s * lx + c * lz));
  const F = naveHi + 0.35;
  const yb = lo - 0.9;
  b.frame(cs.x, 0, cs.z, cs.yaw);

  const white = col(0xf8f5ee);
  const trim = col(0xdca545);
  const plinth = col(0xb3a893);
  const iron = col(0x2b2622);
  const dome = col(0x2e6db4);
  const stucco = subUV(T.uPlain, 0.1, 0.1, 0.9, 0.9);

  // ---- Nave ----
  const L = 15, W = 3.8, H = 5.6;
  const naveFaces: [number, number, number, number, number][] = [
    // Lx, Lz, Rx, Rz, windows?
    [0, -W, -L, -W, 1],
    [-L, W, 0, W, 1],
    [-L, -W, -L, W, 0],
  ];
  for (const [Lx, Lz, Rx, Rz, win] of naveFaces) {
    const len = Math.hypot(Rx - Lx, Rz - Lz);
    b.color(plinth);
    // Rubble-stone foundation where the lot falls away toward the beach.
    b.quadTiled(Lx, yb, Lz, Rx, yb, Rz, Rx, F + 0.5, Rz, Lx, F + 0.5, Lz, Math.max(1, Math.round(len / 3)), Math.max(1, Math.round((F + 0.5 - yb) / 3)), T.blockPlinth);
    const nb = Math.round(len / 3);
    b.color(white);
    for (let j = 0; j < nb; j++) {
      const t0 = j / nb, t1 = (j + 1) / nb;
      const ax = Lx + (Rx - Lx) * t0, az = Lz + (Rz - Lz) * t0, bx = Lx + (Rx - Lx) * t1, bz = Lz + (Rz - Lz) * t1;
      const uv = win && j > 0 && j < nb - 1 ? T.chWindow : stucco;
      b.quad(ax, F + 0.5, az, bx, F + 0.5, bz, bx, F + H, bz, ax, F + H, az, uv);
    }
    // Ochre cornice line; outward normal is (-r.z, r.x) for r = L -> R.
    b.color(trim);
    const nx = -(Rz - Lz) / len, nz = (Rx - Lx) / len;
    b.quad(Lx + nx * 0.08, F + H - 0.35, Lz + nz * 0.08, Rx + nx * 0.08, F + H - 0.35, Rz + nz * 0.08, Rx + nx * 0.08, F + H - 0.15, Rz + nz * 0.08, Lx + nx * 0.08, F + H - 0.15, Lz + nz * 0.08);
  }
  // Clay-tile gable roof over the nave; the facade hides its front end.
  const pitch = 0.38;
  const tp = Math.tan(pitch);
  const ov = 0.35;
  const yE = F + H - ov * tp, yR = F + H + W * tp;
  const clay = col(0xb5603a);
  for (const side of [-1, 1]) {
    b.color(clay);
    b.quadTiledFacing(0, yE, side * (W + ov), -L - 0.4, yE, side * (W + ov), -L - 0.4, yR, 0, 0, yR, 0, 10, 2, T.clay, 0, 1, side);
    b.color(clay, 0.5);
    b.quadFacing(0, yE, side * (W + ov), -L - 0.4, yE, side * (W + ov), -L - 0.4, yR, 0, 0, yR, 0, 0, -1, -side);
  }
  b.color(white);
  b.quadFacing(-L, F + H, -W, -L, F + H, W, -L, yR - 0.03, 0, -L, yR - 0.03, 0, -1, 0, 0);

  // ---- Front facade with a curved, stepped crest ----
  // Espadaña crest: scrolled shoulders, then a shallow arch to the cross.
  const half: [number, number][] = [[4.3, 6.2], [3.3, 6.2], [2.95, 6.32], [2.65, 6.7], [2.4, 7.08], [2.15, 7.24], [1.6, 7.28], [1.25, 7.55], [0.8, 7.98], [0.4, 8.24], [0, 8.32]];
  const prof: [number, number][] = [...half.map(([z, y]): [number, number] => [-z, y]), ...half.slice(0, -1).reverse()];
  const FX = 0.4;
  b.color(white);
  for (let i = 0; i + 1 < prof.length; i++) {
    const [z0, h0] = prof[i], [z1, h1] = prof[i + 1];
    b.quadFacing(FX, yb, z1, FX, yb, z0, FX, F + h0, z0, FX, F + h1, z1, 1, 0, 0, stucco);
    b.quadFacing(0, yb, z0, 0, yb, z1, 0, F + h1, z1, 0, F + h0, z0, -1, 0, 0);
    b.color(trim);
    b.quadFacing(FX + 0.06, F + h0, z0, FX + 0.06, F + h1, z1, -0.02, F + h1, z1, -0.02, F + h0, z0, 0, 1, 0);
    b.color(white);
  }
  b.quadFacing(FX, yb, -4.3, 0, yb, -4.3, 0, F + 6.2, -4.3, FX, F + 6.2, -4.3, 0, 0, -1);
  b.quadFacing(0, yb, 4.3, FX, yb, 4.3, FX, F + 6.2, 4.3, 0, F + 6.2, 4.3, 0, 0, 1);
  // Facade details sit a few centimetres proud of the wall.
  const D = FX + 0.03;
  b.color(plinth);
  b.quadFacing(D, yb, 4.3, D, yb, -4.3, D, F + 0.5, -4.3, D, F + 0.5, 4.3, 1, 0, 0);
  b.color(white);
  b.quadFacing(D, F, 1.35, D, F, -1.35, D, F + 3.7, -1.35, D, F + 3.7, 1.35, 1, 0, 0, T.chDoor);
  b.quadFacing(D, F + 4.25, 0.8, D, F + 4.25, -0.8, D, F + 5.85, -0.8, D, F + 5.85, 0.8, 1, 0, 0, T.chOculus);
  b.color(trim);
  for (const z of [-3.95, 3.95, -1.9, 1.9]) {
    const top = Math.abs(z) > 3 ? 6.15 : 4.35;
    b.box(FX + 0.08, F + top / 2 + 0.25, z, 0.1, top / 2 - 0.25, 0.22, 63 & ~8);
  }
  b.box(FX + 0.1, F + 6.15, 0, 0.14, 0.12, 4.45, 63 & ~8);
  b.box(FX + 0.08, F + 4.4, 0, 0.1, 0.08, 2.15, 63 & ~8);
  // Steps up to the door.
  b.color(col(0xb9b2a6));
  b.box(FX + 0.6, F - 0.2, 0, 0.6, 0.2, 1.9, 63 & ~8);
  b.box(FX + 1.4, F - 0.45, 0, 0.6, 0.3, 2.1, 63 & ~8);
  cross(b, iron, 0.2, F + 8.4, 0, 1.5);

  // ---- Bell tower ----
  const tx = -1.4, tz = -5.6, th = 1.8;
  const shaftTop = F + 8.6;
  const tfaces: [number, number, number, number][] = [
    [tx + th, tz - th, tx - th, tz - th],
    [tx + th, tz + th, tx + th, tz - th],
    [tx - th, tz - th, tx - th, tz + th],
  ];
  for (const [Lx, Lz, Rx, Rz] of tfaces) {
    b.color(plinth);
    b.quadTiled(Lx, yb, Lz, Rx, yb, Rz, Rx, F + 0.5, Rz, Lx, F + 0.5, Lz, 1, Math.max(1, Math.round((F + 0.5 - yb) / 3)), T.blockPlinth);
    b.color(white);
    b.quad(Lx, F + 0.5, Lz, Rx, F + 0.5, Rz, Rx, shaftTop, Rz, Lx, shaftTop, Lz, stucco);
  }
  // Fourth face (toward the nave) only shows above the nave roof.
  b.quad(tx - th, F + H - 0.2, tz + th, tx + th, F + H - 0.2, tz + th, tx + th, shaftTop, tz + th, tx - th, shaftTop, tz + th, stucco);
  b.color(trim);
  b.box(tx, shaftTop + 0.12, tz, th + 0.15, 0.12, th + 0.15);
  // Belfry with open arches on all sides.
  const bh = 1.6, b0 = shaftTop + 0.24, b1 = b0 + 2.8;
  b.color(white);
  const bf: [number, number, number, number][] = [
    [tx + bh, tz - bh, tx - bh, tz - bh],
    [tx - bh, tz + bh, tx + bh, tz + bh],
    [tx + bh, tz + bh, tx + bh, tz - bh],
    [tx - bh, tz - bh, tx - bh, tz + bh],
  ];
  for (const [Lx, Lz, Rx, Rz] of bf) b.quad(Lx, b0, Lz, Rx, b0, Rz, Rx, b1, Rz, Lx, b1, Lz, T.chBelfry);
  b.color(trim);
  b.box(tx, b1 + 0.1, tz, bh + 0.18, 0.1, bh + 0.18);
  // Tiled cupola and lantern.
  b.color(dome);
  b.cylinder(tx, b1 + 0.2, tz, 1.55, 1.25, 0.6, 8, 0, false, Math.PI / 8);
  b.cylinder(tx, b1 + 0.8, tz, 1.25, 0.55, 0.85, 8, 0, false, Math.PI / 8);
  b.cylinder(tx, b1 + 1.65, tz, 0.55, 0.12, 0.45, 8, 0, false, Math.PI / 8);
  b.color(white);
  b.cylinder(tx, b1 + 2.0, tz, 0.16, 0.16, 0.35, 6, 1);
  cross(b, iron, tx, b1 + 2.35, tz, 1.3);

  // ---- Atrium: low wall, gate posts and an atrial cross ----
  b.color(white);
  const wallH = 1.0;
  const seg = (x0: number, z0: number, x1: number, z1: number) => {
    const n = Math.max(1, Math.round(Math.hypot(x1 - x0, z1 - z0) / 2.5));
    for (let i = 0; i < n; i++) {
      const xa = x0 + ((x1 - x0) * i) / n, za = z0 + ((z1 - z0) * i) / n;
      const xb = x0 + ((x1 - x0) * (i + 1)) / n, zb = z0 + ((z1 - z0) * (i + 1)) / n;
      const mx = (xa + xb) / 2, mz = (za + zb) / 2;
      const g = groundLocal(site, cs, mx, mz);
      b.box(mx, (g - 0.6 + g + wallH) / 2, mz, Math.abs(xb - xa) / 2 + 0.15, (wallH + 0.6) / 2, Math.abs(zb - za) / 2 + 0.15, 63 & ~8);
    }
  };
  seg(6.5, -6, 6.5, -1.6);
  seg(6.5, 1.6, 6.5, 6);
  seg(FX, -6, 6.5, -6);
  seg(FX, 6, 6.5, 6);
  for (const z of [-1.6, 1.6]) {
    const g = groundLocal(site, cs, 6.5, z);
    b.color(white);
    b.box(6.5, g + 0.9, z, 0.3, 1.5, 0.3, 63 & ~8);
    b.color(trim);
    b.box(6.5, g + 2.5, z, 0.36, 0.1, 0.36, 63 & ~8);
  }
  const gc = groundLocal(site, cs, 3.6, 0);
  b.color(white);
  b.box(3.6, gc + 0.3, 0, 0.6, 0.7, 0.6, 63 & ~8);
  b.color(col(0xd8d2c4));
  b.box(3.6, gc + 2.0, 0, 0.12, 1.0, 0.12, 63 & ~8);
  b.box(3.6, gc + 2.45, 0, 0.12, 0.11, 0.6, 63 & ~8);
  b.identity();
  return { floor: F, top: b1 + 3.7 };
}

function groundLocal(site: Site, cs: ChapelSite, lx: number, lz: number) {
  const c = Math.cos(cs.yaw), s = Math.sin(cs.yaw);
  return site.ground(cs.x + c * lx - s * lz, cs.z + s * lx + c * lz);
}

/** Wrought-iron cross standing on (x, y, z), arms across local z. */
function cross(b: MeshBuilder, color: THREE.Color, x: number, y: number, z: number, h: number) {
  b.color(color);
  b.box(x, y + h / 2, z, 0.06, h / 2, 0.06, 63 & ~8);
  b.box(x, y + h * 0.7, z, 0.06, 0.06, h * 0.3, 63);
}
