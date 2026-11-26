import * as THREE from 'three';
import { mulberry32 } from '../../core/math.ts';
import { KITE_PALETTES } from '../../render/kiteModel.ts';
import type { MeshBuilder } from './builder.ts';
import { NO_BOTTOM } from './builder.ts';
import type { Atlas } from './atlas.ts';
import type { ChunkSet } from './chunks.ts';
import type { HouseFactory } from './houses.ts';
import type { BeachLife, PalmSpot } from './beach.ts';
import { parkedKite } from './props.ts';
import { type Site, pickWeighted, pointInPolygon, polygonBounds, rr } from './site.ts';

const col = (h: number) => new THREE.Color(h);
const WHITE = col(0xf2f1ed);
const TYRE = col(0x1e1e1f);
const GLASS = col(0x1b232a);
const STRIPES = [0x2b5c8a, 0x8a3b2b, 0x6b5a3e, 0x2a7f7a, 0x404a57, 0xb5652f];
const VAN = [0xe07b39, 0x3d7bb6, 0x6aa36f, 0xe8d9b0, 0xc8333a, 0xf2c14e, 0x88b7c9, 0xffffff];
const TENT = [0xff7a1a, 0x2a9d8f, 0x3a86ff, 0xffc928, 0x6a994e, 0xe63946, 0x9b5de5];

type Vehicle = 'motorhome' | 'trailer' | 'airstream' | 'van' | 'sprinter' | 'truckCamper' | 'tent';

export class Campground {
  private readonly site: Site;
  private readonly atlas: Atlas;
  private readonly chunks: ChunkSet;
  private readonly houses: HouseFactory;
  private readonly beach: BeachLife;
  private readonly anim: MeshBuilder;
  readonly palms: PalmSpot[] = [];
  stats = { vehicles: 0, tents: 0, palapas: 0 };

  constructor(site: Site, atlas: Atlas, chunks: ChunkSet, houses: HouseFactory, beach: BeachLife, anim: MeshBuilder) {
    this.site = site;
    this.atlas = atlas;
    this.chunks = chunks;
    this.houses = houses;
    this.beach = beach;
    this.anim = anim;
  }

  build() {
    const rnd = mulberry32(2024);
    for (const a of this.site.data.world.areas) {
      if (a.kind !== 'camp_site' && a.kind !== 'caravan_site') continue;
      const bb = polygonBounds(a.pts);
      const cx = (bb.x0 + bb.x1) / 2, cz = (bb.z0 + bb.z1) / 2;
      if (!this.site.data.heightNear.inside(cx, cz, 200) || cz > 1500) continue;
      this.fillArea(rnd, a.pts, a.kind === 'camp_site' ? 0.45 : 0.15);
    }
    // Beach camping at the south spot, where the coast turns east.
    const lm = this.site.data.world.landmarks;
    this.beachCamp(rnd, lm.campSouth.x, lm.campSouth.z, 9);
    this.beachCamp(rnd, lm.campNorth.x, lm.campNorth.z - 120, 4);
  }

  /** Rows of rigs facing the sea inside a camp polygon. */
  private fillArea(rnd: () => number, pts: [number, number][], tentShare: number) {
    const bb = polygonBounds(pts);
    const cx = (bb.x0 + bb.x1) / 2, cz = (bb.z0 + bb.z1) / 2;
    const [nx, nz] = this.site.inland(cx, cz);
    // Rows run along the shore (t), sites step back from the sea (n).
    const tx = -nz, tz = nx;
    const r = Math.hypot(bb.x1 - bb.x0, bb.z1 - bb.z0) / 2 + 10;
    let palapas = 0;
    for (let n = -r; n <= r; n += rr(rnd, 14, 18)) {
      for (let t = -r; t <= r; t += rr(rnd, 11, 14)) {
        const x = cx + nx * n + tx * t + rr(rnd, -1.5, 1.5), z = cz + nz * n + tz * t + rr(rnd, -1.5, 1.5);
        if (!pointInPolygon(x, z, pts)) continue;
        if (rnd() < 0.32) continue;
        if (this.site.hitsBuilding(x, z, 5) || this.site.data.overlayAt(x, z)[0] > 0.3 || this.site.slopeAt(x, z) > 0.14) continue;
        if (!this.site.isFree(x, z, 4.5)) continue;
        const kind: Vehicle = rnd() < tentShare ? 'tent' : pickWeighted(rnd, [
          ['motorhome', 4], ['trailer', 3], ['airstream', 1.2], ['van', 3], ['sprinter', 2], ['truckCamper', 2],
        ] as const);
        const facing = Math.atan2(-nz, -nx) + (rnd() < 0.5 ? Math.PI : 0) + rr(rnd, -0.15, 0.15);
        this.place(rnd, kind, x, z, facing);
        if (palapas < 6 && rnd() < 0.3) {
          // Shade palapa beside the rig.
          const px = x + tx * 5.2, pz = z + tz * 5.2;
          if (this.site.isFree(px, pz, 2.4) && !this.site.hitsBuilding(px, pz, 3)) {
            this.campPalapa(rnd, px, pz, Math.atan2(tz, tx));
            palapas++;
          }
        }
      }
    }
  }

  private beachCamp(rnd: () => number, x0: number, z0: number, n: number) {
    const [nx, nz] = this.site.inland(x0, z0);
    const tx = -nz, tz = nx;
    let placed = 0;
    for (let k = 0; k < n * 5 && placed < n; k++) {
      const t = rr(rnd, -90, 90);
      const [x, z] = this.site.atDistance(x0 + tx * t, z0 + tz * t, rr(rnd, 22, 48));
      if (this.site.data.sdf(x, z) < 15 || this.site.hitsBuilding(x, z, 5) || !this.site.isFree(x, z, 4.5) || this.site.slopeAt(x, z) > 0.12) continue;
      const kind: Vehicle = pickWeighted(rnd, [['van', 4], ['tent', 3], ['truckCamper', 2], ['sprinter', 2], ['motorhome', 1]] as const);
      this.place(rnd, kind, x, z, Math.atan2(-nz, -nx) + rr(rnd, -0.5, 0.5));
      placed++;
      if (rnd() < 0.4) this.palms.push([x + tx * 6, z + tz * 6, 0]);
    }
  }

  private place(rnd: () => number, kind: Vehicle, x: number, z: number, yaw: number) {
    const g = this.site.ground(x, z);
    const b = this.chunks.at(x, z);
    b.frame(x, g - 0.03, z, yaw);
    switch (kind) {
      case 'motorhome':
        motorhome(b, this.atlas, rnd);
        break;
      case 'trailer':
        trailer(b, this.atlas, rnd);
        break;
      case 'airstream':
        airstream(b, rnd);
        break;
      case 'van':
        camperVan(b, this.atlas, rnd);
        break;
      case 'sprinter':
        sprinter(b, rnd);
        break;
      case 'truckCamper':
        truckCamper(b, rnd);
        break;
      case 'tent':
        domeTent(b, rnd);
        break;
    }
    // Awning, chairs and a cooler on the door side.
    if (kind !== 'tent' && kind !== 'truckCamper' && rnd() < 0.5) awning(b, this.atlas, rnd, kind === 'van' || kind === 'sprinter' ? 2.4 : 2.9);
    if (rnd() < 0.6) campChairs(b, rnd, kind === 'tent' ? 2.2 : 3.2);
    b.identity();
    this.site.occupy(x, z, kind === 'tent' ? 2.2 : 4.5);
    if (kind === 'tent') this.stats.tents++;
    else this.stats.vehicles++;
    // Kites drying in the sun and the camp dogs.
    const c = Math.cos(yaw), s = Math.sin(yaw);
    if (rnd() < 0.18) {
      const kx = x - s * 7, kz = z + c * 7;
      if (this.site.isFree(kx, kz, 4) && !this.site.hitsBuilding(kx, kz, 4)) {
        const pal = KITE_PALETTES[Math.floor(rnd() * KITE_PALETTES.length)];
        this.anim.frame(kx, this.site.ground(kx, kz) - 0.03, kz, rr(rnd, 1.6, 2.2));
        parkedKite(this.anim, { canopy: pal.canopy, tube: pal.tube }, rnd, rr(rnd, 0.8, 1));
        this.anim.identity();
        this.site.occupy(kx, kz, 4);
      }
    }
    if (rnd() < 0.1) this.beach.dogAt(rnd, x - s * 3.5 + rr(rnd, -1, 1), z + c * 3.5, rnd() * 6.28, rnd() < 0.6);
  }

  private campPalapa(rnd: () => number, x: number, z: number, yaw: number) {
    const g = this.site.ground(x, z);
    const b = this.chunks.at(x, z);
    // Frame origin on the ground, so heights below are local.
    b.frame(x, g, z, yaw);
    const hw = rr(rnd, 1.6, 2.2), hd = rr(rnd, 1.6, 2.2), top = 2.5;
    b.color(col(0x6b4a2f));
    for (const [a, c] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) b.box(a * (hw - 0.1), top / 2, c * (hd - 0.1), 0.08, top / 2 + 0.05, 0.08, NO_BOTTOM);
    this.houses.hipRoof(b, hw, hd, top, 0.5, 0.55, col(0xc4a56c).offsetHSL(0, 0, rr(rnd, -0.04, 0.03)));
    b.color(col(0x8a6a4a));
    b.box(0, 0.74, 0, 0.9, 0.035, 0.38, 63);
    b.box(0, 0.37, 0, 0.06, 0.36, 0.3, 63 & ~8);
    b.identity();
    this.site.occupy(x, z, 2.4);
    this.stats.palapas++;
  }
}

/** Wheels as squat dark boxes on both sides. */
function wheels(b: MeshBuilder, xs: number[], halfW: number, r = 0.38) {
  b.color(TYRE);
  for (const x of xs) for (const s of [-1, 1]) b.box(x, r, s * (halfW - 0.1), r, r, 0.12, 63 & ~8);
}

function motorhome(b: MeshBuilder, atlas: Atlas, rnd: () => number) {
  const T = atlas.tiles;
  const L = rr(rnd, 7.2, 8.4), W = 1.25, x0 = -L / 2, xc = L / 2 - 1.7;
  const stripe = col(STRIPES[Math.floor(rnd() * STRIPES.length)]);
  wheels(b, [x0 + 1.4, xc + 0.6], W);
  // Coach box with tinted swoosh graphics on both sides.
  const y0 = 0.55, y1 = 3.15;
  b.color(stripe);
  b.quad(x0, y0, W, xc, y0, W, xc, y1, W, x0, y1, W, T.rvSide);
  b.quad(xc, y0, -W, x0, y0, -W, x0, y1, -W, xc, y1, -W, [T.rvSide[2], T.rvSide[1], T.rvSide[0], T.rvSide[3]]);
  b.color(WHITE);
  b.quad(x0, y0, -W, x0, y0, W, x0, y1, W, x0, y1, -W);
  b.quad(x0, y1, W, xc, y1, W, xc, y1, -W, x0, y1, -W);
  b.color(WHITE, 0.6);
  b.quad(x0, y0, -W, xc, y0, -W, xc, y0, W, x0, y0, W);
  // Cab-over alcove and cab.
  b.color(WHITE);
  b.box(xc + 0.55, 2.65, 0, 0.55, 0.45, W - 0.05, 63);
  b.box(xc + 0.85, 1.35, 0, 0.85, 0.8, W - 0.12, 63 & ~8);
  b.box(xc + 1.85, 0.95, 0, 0.25, 0.4, W - 0.15, 63 & ~8);
  b.color(GLASS);
  b.quad(xc + 1.71, 1.45, W - 0.1, xc + 1.71, 1.45, -W + 0.1, xc + 1.71, 2.05, -W + 0.1, xc + 1.71, 2.05, W - 0.1);
  for (const s of [-1, 1]) b.quadFacing(xc + 0.4, 1.45, s * (W - 0.11), xc + 1.5, 1.45, s * (W - 0.11), xc + 1.5, 2.05, s * (W - 0.11), xc + 0.4, 2.05, s * (W - 0.11), 0, 0, s);
  // Roof gear: AC unit and maybe solar panels.
  b.color(WHITE, 0.92);
  b.box(x0 + L * 0.4, y1 + 0.17, 0, 0.45, 0.17, 0.4, 63 & ~8);
  if (rnd() < 0.5) {
    b.color(col(0x1f2b45));
    b.box(x0 + 1.6, y1 + 0.06, 0, 0.8, 0.04, 0.55, 63 & ~8);
  }
}

function trailer(b: MeshBuilder, atlas: Atlas, rnd: () => number) {
  const T = atlas.tiles;
  const L = rr(rnd, 6.2, 8), W = 1.22, x0 = -L / 2, x1 = L / 2 - 0.5;
  const stripe = col(STRIPES[Math.floor(rnd() * STRIPES.length)]);
  wheels(b, [-0.3, 0.5], W, 0.34);
  const y0 = 0.5, y1 = 3.0;
  b.color(stripe);
  b.quad(x0, y0, W, x1, y0, W, x1, y1, W, x0, y1, W, T.rvSide);
  b.quad(x1, y0, -W, x0, y0, -W, x0, y1, -W, x1, y1, -W, [T.rvSide[2], T.rvSide[1], T.rvSide[0], T.rvSide[3]]);
  b.color(WHITE);
  b.quad(x0, y0, -W, x0, y0, W, x0, y1, W, x0, y1, -W);
  b.quad(x0, y1, W, x1, y1, W, x1, y1, -W, x0, y1, -W);
  // Rounded nose: two slanted panels.
  b.quadFacing(x1, y0, W, x1, y0, -W, x1 + 0.45, y0 + 0.9, -W, x1 + 0.45, y0 + 0.9, W, 1, -0.3, 0);
  b.quadFacing(x1 + 0.45, y0 + 0.9, W, x1 + 0.45, y0 + 0.9, -W, x1, y1, -W, x1, y1, W, 1, 0.5, 0);
  for (const s of [-1, 1]) b.quadFacing(x1, y0, s * W, x1 + 0.45, y0 + 0.9, s * W, x1, y1, s * W, x1, y1, s * W, 0, 0, s);
  b.color(GLASS);
  b.quadFacing(x1 + 0.31, y0 + 1.25, 0.8, x1 + 0.31, y0 + 1.25, -0.8, x1 + 0.12, y0 + 1.95, -0.8, x1 + 0.12, y0 + 1.95, 0.8, 1, 0.4, 0);
  b.color(col(0x2a2a2a));
  b.beam(x1 + 0.2, 0.45, 0, x1 + 1.6, 0.45, 0, 0.1, 0.1);
  b.color(col(0xdcdcd8));
  b.cylinder(x1 + 0.9, 0.5, -0.25, 0.17, 0.17, 0.55, 6, 1);
  b.cylinder(x1 + 0.9, 0.5, 0.25, 0.17, 0.17, 0.55, 6, 1);
}

/** Polished aluminium Airstream: a lofted, closed capsule. */
function airstream(b: MeshBuilder, rnd: () => number) {
  const L = rr(rnd, 6.5, 7.8);
  const alu = col(0xc8cdd2);
  wheels(b, [-0.2, 0.55], 1.2, 0.33);
  const N = 12, cy = 1.45;
  // Superellipse cross-section (z, y offsets) and its outward normals.
  const prof: [number, number, number, number][] = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    const z = 1.22 * Math.sign(ca) * Math.pow(Math.abs(ca), 0.6);
    const y = 0.95 * Math.sign(sa) * Math.pow(Math.abs(sa), 0.75);
    prof.push([z, y, ca, sa]);
  }
  // Stations: (x fraction, section scale) rounding off both ends.
  const st: [number, number][] = [[-0.5, 0.35], [-0.47, 0.75], [-0.42, 0.93], [-0.33, 1], [0.33, 1], [0.42, 0.93], [0.47, 0.75], [0.5, 0.35]];
  const rings: number[][] = [];
  b.color(alu);
  for (const [fx, sc] of st) {
    const ring: number[] = [];
    const nx = Math.sign(fx) * (1 - sc) * 2.2;
    for (const [z, y, nz, ny] of prof) ring.push(b.vert(fx * L, cy + y * sc, z * sc, nx, ny, nz));
    rings.push(ring);
  }
  for (let i = 0; i + 1 < rings.length; i++) {
    for (let k = 0; k < N; k++) b.quadAuto(rings[i][k], rings[i + 1][k], rings[i + 1][(k + 1) % N], rings[i][(k + 1) % N]);
  }
  for (const [i, dir] of [[0, -1], [rings.length - 1, 1]] as const) {
    const fx = st[i][0] * L;
    const c = b.vert(fx + dir * 0.02, cy, 0, dir, 0, 0);
    for (let k = 0; k < N; k++) b.triAuto(c, rings[i][k], rings[i][(k + 1) % N]);
  }
  b.color(GLASS);
  for (const s of [-1, 1]) {
    for (const x of [-L * 0.22, L * 0.05, L * 0.25]) b.quadFacing(x - 0.4, 1.6, s * 1.215, x + 0.4, 1.6, s * 1.215, x + 0.4, 1.95, s * 1.18, x - 0.4, 1.95, s * 1.18, 0, 0, s);
  }
  b.color(col(0x2a2a2a));
  b.beam(L / 2 - 0.2, 0.45, 0, L / 2 + 1.2, 0.45, 0, 0.1, 0.1);
}

function camperVan(b: MeshBuilder, atlas: Atlas, rnd: () => number) {
  const T = atlas.tiles;
  const body = col(VAN[Math.floor(rnd() * VAN.length)]);
  const L = 4.7, W = 0.93, x0 = -L / 2, x1 = L / 2;
  wheels(b, [x0 + 0.9, x1 - 0.9], W, 0.33);
  const y0 = 0.35, y1 = 1.95;
  b.color(body);
  b.quad(x0, y0, W, x1 - 0.25, y0, W, x1 - 0.25, y1, W, x0, y1, W, T.vanSide);
  b.quad(x1 - 0.25, y0, -W, x0, y0, -W, x0, y1, -W, x1 - 0.25, y1, -W, [T.vanSide[2], T.vanSide[1], T.vanSide[0], T.vanSide[3]]);
  b.quad(x0, y0, -W, x0, y0, W, x0, y1, W, x0, y1, -W);
  // Flat nose with a slanted windscreen.
  b.quadFacing(x1 - 0.25, y0, W, x1 - 0.25, y0, -W, x1, y0 + 0.9, -W, x1, y0 + 0.9, W, 1, 0, 0);
  b.color(GLASS);
  b.quadFacing(x1, y0 + 0.9, W, x1, y0 + 0.9, -W, x1 - 0.25, y1, -W, x1 - 0.25, y1, W, 1, 0.3, 0);
  b.color(WHITE);
  for (const s of [-1, 1]) b.quadFacing(x1 - 0.25, y0, s * W, x1, y0 + 0.9, s * W, x1 - 0.25, y1, s * W, x1 - 0.25, y1, s * W, 0, 0, s);
  b.quad(x0, y1, W, x1 - 0.25, y1, W, x1 - 0.25, y1, -W, x0, y1, -W);
  if (rnd() < 0.35) {
    // Pop-top raised: canvas sides under a white lid.
    b.color(col([0xe9dcc0, 0xd96c3c, 0x6aa36f][Math.floor(rnd() * 3)]));
    b.quadFacing(x0 + 0.5, y1, W - 0.1, x1 - 0.6, y1, W - 0.1, x1 - 0.6, y1 + 0.5, W - 0.1, x0 + 0.5, y1 + 0.9, W - 0.1, 0, 0, 1);
    b.quadFacing(x0 + 0.5, y1, -W + 0.1, x1 - 0.6, y1, -W + 0.1, x1 - 0.6, y1 + 0.5, -W + 0.1, x0 + 0.5, y1 + 0.9, -W + 0.1, 0, 0, -1);
    b.quadFacing(x0 + 0.5, y1, -W + 0.1, x0 + 0.5, y1, W - 0.1, x0 + 0.5, y1 + 0.9, W - 0.1, x0 + 0.5, y1 + 0.9, -W + 0.1, -1, 0, 0);
    b.color(WHITE);
    b.quadFacing(x0 + 0.45, y1 + 0.92, W, x1 - 0.55, y1 + 0.52, W, x1 - 0.55, y1 + 0.52, -W, x0 + 0.45, y1 + 0.92, -W, 0.4, 1, 0);
  } else if (rnd() < 0.5) {
    roofBoards(b, x0 + 0.6, x1 - 0.6, y1, rnd);
  }
}

function sprinter(b: MeshBuilder, rnd: () => number) {
  const L = rr(rnd, 5.6, 6.6), W = 1.0, x0 = -L / 2, x1 = L / 2;
  const body = col(rnd() < 0.7 ? 0xf3f3f0 : [0x8e9aa4, 0x2f3a46, 0xd9d2c0][Math.floor(rnd() * 3)]);
  wheels(b, [x0 + 1.0, x1 - 1.2], W, 0.36);
  b.color(body);
  b.box(-0.35, 1.55, 0, L / 2 - 0.35, 1.15, W, 63 & ~8);
  b.box(x1 - 0.55, 1.0, 0, 0.55, 0.6, W - 0.06, 63 & ~8);
  b.color(GLASS);
  b.quadFacing(x1 - 0.7, 1.6, W - 0.05, x1 - 0.7, 1.6, -W + 0.05, x1 - 1.05, 2.4, -W + 0.05, x1 - 1.05, 2.4, W - 0.05, 1, 0.5, 0);
  for (const s of [-1, 1]) b.quadFacing(x1 - 1.9, 1.75, s * (W + 0.01), x1 - 1.1, 1.75, s * (W + 0.01), x1 - 1.1, 2.3, s * (W + 0.01), x1 - 1.9, 2.3, s * (W + 0.01), 0, 0, s);
  b.quadFacing(x0 + 1.0, 1.85, W + 0.01, x0 + 2.2, 1.85, W + 0.01, x0 + 2.2, 2.25, W + 0.01, x0 + 1.0, 2.25, W + 0.01, 0, 0, 1);
  if (rnd() < 0.6) roofBoards(b, x0 + 0.5, x1 - 1.4, 2.7, rnd);
}

function truckCamper(b: MeshBuilder, rnd: () => number) {
  const truck = col([0xf3f3f0, 0x9aa3ab, 0x2f3a46, 0x7a1f1f, 0x2b4a6b][Math.floor(rnd() * 5)]);
  wheels(b, [-1.6, 1.7], 0.98, 0.4);
  b.color(truck);
  b.box(1.7, 1.0, 0, 0.75, 0.42, 0.95, 63 & ~8);
  b.box(0.55, 1.35, 0, 0.45, 0.75, 0.95, 63 & ~8);
  b.color(GLASS);
  b.quadFacing(0.98, 1.65, 0.9, 0.98, 1.65, -0.9, 0.82, 2.05, -0.9, 0.82, 2.05, 0.9, 1, 0.5, 0);
  // Camper shell on the bed with its cab-over nose.
  b.color(col(0xeeede8));
  b.box(-1.3, 1.7, 0, 1.45, 0.95, 1.05, 63 & ~8);
  b.box(0.4, 2.3, 0, 0.6, 0.38, 1.0, 63);
  b.color(col(STRIPES[Math.floor(rnd() * STRIPES.length)]));
  for (const s of [-1, 1]) b.quadFacing(-2.75, 1.3, s * 1.06, 0.15, 1.3, s * 1.06, 0.15, 1.45, s * 1.06, -2.75, 1.45, s * 1.06, 0, 0, s);
  b.color(GLASS);
  for (const s of [-1, 1]) b.quadFacing(-2.0, 1.85, s * 1.06, -1.1, 1.85, s * 1.06, -1.1, 2.25, s * 1.06, -2.0, 2.25, s * 1.06, 0, 0, s);
}

function domeTent(b: MeshBuilder, rnd: () => number) {
  const c = col(TENT[Math.floor(rnd() * TENT.length)]);
  const r = rr(rnd, 1.0, 1.4), h = rr(rnd, 1.0, 1.35);
  b.color(c);
  b.cylinder(0, 0, 0, r, r * 0.8, h * 0.45, 6, 0, true, rnd());
  b.cylinder(0, h * 0.45, 0, r * 0.8, 0.08, h * 0.55, 6, 0, true, rnd());
  b.color(col(0x2a2d31));
  b.quadFacing(r * 0.95, 0.02, -0.35, r * 0.95, 0.02, 0.35, r * 0.78, h * 0.6, 0.2, r * 0.78, h * 0.6, -0.2, 1, 0.2, 0);
}

function awning(b: MeshBuilder, atlas: Atlas, rnd: () => number, h: number) {
  const len = rr(rnd, 3.2, 4.4), out = rr(rnd, 2.2, 2.8), x0 = rr(rnd, -2.2, -1.2);
  const z0 = 1.3;
  b.color(col(STRIPES[Math.floor(rnd() * STRIPES.length)]).lerp(WHITE, 0.15));
  b.quad2(x0, h, z0, x0 + len, h, z0, x0 + len, h - 0.45, z0 + out, x0, h - 0.45, z0 + out, atlas.tiles.awning);
  b.color(col(0x9a9a9a));
  for (const x of [x0 + 0.1, x0 + len - 0.1]) b.box(x, (h - 0.45) / 2, z0 + out - 0.05, 0.02, (h - 0.45) / 2, 0.02, NO_BOTTOM);
}

function campChairs(b: MeshBuilder, rnd: () => number, z: number) {
  const c = col(TENT[Math.floor(rnd() * TENT.length)]);
  for (let i = 0; i < 1 + Math.floor(rnd() * 3); i++) {
    const x = rr(rnd, -1.5, 1.5) + i * 0.9;
    b.color(c);
    b.box(x, 0.42, z, 0.26, 0.03, 0.24, 63);
    b.box(x, 0.7, z + 0.24, 0.26, 0.28, 0.02, 63);
    b.color(col(0x333333));
    b.box(x, 0.2, z, 0.25, 0.2, 0.22, 63 & ~8 & ~4);
  }
  if (rnd() < 0.5) {
    b.color(col(rnd() < 0.5 ? 0x2d6cb5 : 0xe8e8e4));
    b.box(rr(rnd, -2, 2), 0.22, z + 0.8, 0.32, 0.22, 0.22, 63 & ~8);
  }
}

function roofBoards(b: MeshBuilder, x0: number, x1: number, y: number, rnd: () => number) {
  b.color(col(0x2a2a2a));
  for (const x of [x0, x1]) b.box(x, y + 0.06, 0, 0.04, 0.06, 0.9, 63 & ~8);
  const boards = [0xf5f5f2, 0x14a3a8, 0xffc928, 0xff6b4a, 0x3a86ff];
  for (let i = 0; i < 1 + Math.floor(rnd() * 3); i++) {
    b.color(col(boards[Math.floor(rnd() * boards.length)]));
    b.box((x0 + x1) / 2, y + 0.15 + i * 0.05, -0.5 + i * 0.45, (x1 - x0) / 2 + 0.3, 0.025, 0.22, 63);
  }
}

const CAR_COLORS = [0xf2f2ef, 0xb9bec3, 0x8b1e1e, 0x1f3f6e, 0x222427, 0x6f7a3a, 0x9c6b3c, 0x2f6f73, 0xc9b27c];

/** Work pickup facing local +x, wheels on the ground at y = 0. */
export function pickupTruck(b: MeshBuilder, rnd: () => number) {
  const body = col(CAR_COLORS[Math.floor(rnd() * CAR_COLORS.length)]);
  const W = 0.92;
  wheels(b, [-1.55, 1.6], W, 0.38);
  b.color(body);
  b.box(0, 0.75, 0, 2.65, 0.3, W, 63 & ~8);
  b.box(1.9, 1.12, 0, 0.75, 0.08, W - 0.02, 63 & ~8);
  b.box(0.5, 1.45, 0, 0.62, 0.4, W - 0.04, 63 & ~8);
  b.color(GLASS);
  b.quadFacing(1.13, 1.12, W - 0.08, 1.13, 1.12, -W + 0.08, 0.98, 1.78, -W + 0.08, 0.98, 1.78, W - 0.08, 1, 0.3, 0);
  for (const s of [-1, 1]) b.quadFacing(0.0, 1.25, s * (W - 0.03), 0.95, 1.25, s * (W - 0.03), 0.95, 1.72, s * (W - 0.03), 0.0, 1.72, s * (W - 0.03), 0, 0, s);
  // Bed walls and floor.
  b.color(body, 0.9);
  for (const s of [-1, 1]) b.box(-1.45, 1.25, s * (W - 0.05), 1.2, 0.2, 0.05, 63 & ~8);
  b.box(-2.6, 1.25, 0, 0.05, 0.2, W, 63 & ~8);
  b.color(body, 0.45);
  b.quadFacing(-2.55, 1.08, W - 0.1, -0.15, 1.08, W - 0.1, -0.15, 1.08, -W + 0.1, -2.55, 1.08, -W + 0.1, 0, 1, 0);
  if (rnd() < 0.3) {
    // Something in the bed: water jugs or a cooler.
    b.color(col(rnd() < 0.5 ? 0x5aa7d8 : 0xe8e6e0));
    b.box(-1.3, 1.3, 0, 0.45, 0.22, 0.4, 63 & ~8);
  }
}

/** Old Beetle ("vocho") or a small sedan facing local +x. */
export function smallCar(b: MeshBuilder, rnd: () => number) {
  const vocho = rnd() < 0.45;
  const body = col(vocho ? [0x7fb3d5, 0xf2f2ef, 0xc8333a, 0xf2c14e, 0x6aa36f, 0x2f4f7f][Math.floor(rnd() * 6)] : CAR_COLORS[Math.floor(rnd() * CAR_COLORS.length)]);
  const L = vocho ? 2.0 : 2.25, W = 0.82;
  wheels(b, [-L + 0.7, L - 0.75], W, 0.32);
  b.color(body);
  b.box(0, 0.62, 0, L, 0.27, W, 63 & ~8);
  if (vocho) {
    b.cylinder(-0.15, 0.89, 0, 0.95, 0.55, 0.55, 8, 1, true, Math.PI / 8);
  } else {
    b.box(-0.15, 1.12, 0, 1.1, 0.24, W - 0.08, 63 & ~8);
  }
  b.color(GLASS);
  for (const s of [-1, 1]) b.quadFacing(-0.9, 0.95, s * (W - (vocho ? 0.15 : 0.07)), 0.55, 0.95, s * (W - (vocho ? 0.15 : 0.07)), 0.45, 1.3, s * (W - (vocho ? 0.25 : 0.07)), -0.8, 1.3, s * (W - (vocho ? 0.25 : 0.07)), 0, 0, s);
}
