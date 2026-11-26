import * as THREE from 'three';
import { mulberry32 } from '../../core/math.ts';
import { KITE_PALETTES } from '../../render/kiteModel.ts';
import type { MeshBuilder } from './builder.ts';
import { NO_BOTTOM } from './builder.ts';
import type { Atlas, TileName } from './atlas.ts';
import type { ChunkSet } from './chunks.ts';
import { type Site, polygonBounds, pointInPolygon, rr } from './site.ts';
import {
  DOG_COATS,
  PANGA_BANDS,
  type PersonLook,
  beachClutter,
  beachFurniture,
  cloth,
  dog,
  kiteboard,
  palapaUmbrella,
  panga,
  parkedKite,
  person,
} from './props.ts';

const col = (h: number) => new THREE.Color(h);
const THATCH = [0xc8a66a, 0xb99a62, 0xaa8e66, 0xd4b77b];

/** Prevailing Norte: wind from ~16 degrees, so downwind points SSW. */
const DOWNWIND_YAW = Math.atan2(-Math.cos(196 * (Math.PI / 180)), Math.sin(196 * (Math.PI / 180)));

const SKIN = [0x8d5a3b, 0xb07650, 0xc68a5e, 0xe0a982, 0xf1c7a4, 0x6f4630, 0xd49a70];
const HAIR = [0x1a120c, 0x2a1b12, 0x5a3a22, 0xa0522d, 0xd8b25a, 0x777777];
const BRIGHT = [0x14a3a8, 0xe63946, 0xffc928, 0x3a86ff, 0xff6b4a, 0x2a9d8f, 0x9b5de5, 0xf15bb5, 0xffffff, 0x8ecae6, 0x90be6d];

export type PalmSpot = [x: number, z: number, kind: 0 | 1];

export class BeachLife {
  private readonly site: Site;
  private readonly atlas: Atlas;
  private readonly chunks: ChunkSet;
  private readonly anim: MeshBuilder;
  readonly palms: PalmSpot[] = [];
  stats = { pangas: 0, umbrellas: 0, kites: 0, people: 0, dogs: 0, banners: 0 };

  constructor(site: Site, atlas: Atlas, chunks: ChunkSet, anim: MeshBuilder) {
    this.site = site;
    this.atlas = atlas;
    this.chunks = chunks;
    this.anim = anim;
  }

  build() {
    const lm = this.site.data.world.landmarks;
    const rnd = mulberry32(777);
    // Fishing beaches: El Sargento's panga beach and La Ventana's.
    for (const z of [-3575, -3500, -3420, -3330, -3245]) this.pangaCluster(rnd, z, 3 + Math.floor(rnd() * 3));
    for (const z of [-170, -95, 60, 125]) this.pangaCluster(rnd, z, 2 + Math.floor(rnd() * 3));
    this.pangaCluster(rnd, lm.hotSprings.z + 140, 2);
    for (const [z, s] of [[-3460, -55], [-3380, -85], [-3300, -48], [-40, -60], [95, -80]] as const) this.anchoredPanga(rnd, z, s);

    // Kite launch spots.
    this.launchSpot(rnd, lm.mainBeach.z, 7, 3, true);
    this.launchSpot(rnd, lm.campNorth.z, 6, 2, true);
    this.launchSpot(rnd, lm.elSargento.z + 25, 4, 2, true);
    this.launchSpot(rnd, lm.hotSprings.z, 4, 1, false);

    // Beach palapas in front of restaurants, hotels and camps.
    const kinds = new Set(['restaurant', 'cafe', 'hotel', 'guest_house', 'hostel', 'fast_food', 'camp_site', 'chalet']);
    for (const p of this.site.data.world.pois) {
      if (!kinds.has(p.kind) || this.site.data.sdf(p.x, p.z) > 220) continue;
      this.umbrellaRow(rnd, p.z, 3 + Math.floor(rnd() * 3), p.kind === 'restaurant' || p.kind === 'fast_food' || p.kind === 'cafe');
    }
    this.umbrellaRow(rnd, lm.mainBeach.z - 40, 5, false);
    this.umbrellaRow(rnd, lm.campNorth.z + 60, 4, false);
    this.umbrellaRow(rnd, lm.elSargento.z - 70, 4, true);
    this.umbrellaRow(rnd, lm.hotSprings.z - 50, 2, false);

    // Strollers and beach dogs along both villages.
    for (let z = -4700; z < 250; z += rr(rnd, 70, 160)) {
      if (z > -2900 && z < -1300 && rnd() < 0.6) continue;
      if (rnd() < 0.35) this.beachDog(rnd, z, rr(rnd, 6, 30));
      if (rnd() < 0.55) this.beachPerson(rnd, z + rr(rnd, -15, 15), rr(rnd, 4, 25));
    }
    this.hotSpringPools(rnd, lm.hotSprings.z);
    this.schoolFlags(rnd);
    this.signBoard(rnd, -193.6, 'signTacos');
    this.signBoard(rnd, -3826.4, 'signMariscos');
  }

  /** Point on the beach `s` m inland at latitude z, with its inland normal. */
  private beach(z: number, s: number) {
    const p = this.site.shore(z, s);
    if (!p) return null;
    const [nx, nz] = this.site.inland(p[0], p[1]);
    return { x: p[0], z: p[1], nx, nz, y: this.site.ground(p[0], p[1]) };
  }

  /** Frame on the sand that follows the local slope (for things lying flat). */
  private groundFrame(b: MeshBuilder, x: number, z: number, yaw: number, sink: number) {
    const e = 1.5;
    const g = this.site;
    const hx = (g.ground(x + e, z) - g.ground(x - e, z)) / (2 * e), hz = (g.ground(x, z + e) - g.ground(x, z - e)) / (2 * e);
    const fx = Math.cos(yaw), fz = Math.sin(yaw);
    b.frameBasis(x, g.ground(x, z) - sink, z, fx, fx * hx + fz * hz, fz, -hx, 1, -hz);
  }

  private pangaCluster(rnd: () => number, z0: number, n: number) {
    const spacing = rr(rnd, 2.7, 3.6);
    let placed = 0;
    for (let i = 0; i < n; i++) {
      const z = z0 + (i - (n - 1) / 2) * spacing + rr(rnd, -0.4, 0.4);
      const s = rr(rnd, 8, 14);
      const p = this.beach(z, s);
      if (!p || p.y < 0.45) continue;
      const len = rr(rnd, 6.6, 7.6);
      const yaw = Math.atan2(p.nz, p.nx) + rr(rnd, -0.18, 0.18);
      const fx = Math.cos(yaw), fz = Math.sin(yaw);
      const sx = p.x - fx * (len / 2), sz = p.z - fz * (len / 2);
      const bx = p.x + fx * (len / 2), bz = p.z + fz * (len / 2);
      if (!this.site.isFree(p.x, p.z, 1.5) || this.site.hitsBuilding(p.x, p.z, 4)) continue;
      const ys = this.site.ground(sx, sz), yBow = this.site.ground(bx, bz);
      const roll = rr(rnd, -0.07, 0.07);
      const b = this.chunks.at(p.x, p.z);
      b.frameBasis(sx, ys - 0.04, sz, fx * len, yBow - ys, fz * len, -fz * roll, 1, fx * roll);
      panga(b, col(PANGA_BANDS[Math.floor(rnd() * PANGA_BANDS.length)]), rnd, true, len);
      b.identity();
      for (const t of [-0.35, 0, 0.35]) this.site.occupy(p.x + fx * len * t, p.z + fz * len * t, 1.25);
      placed++;
      this.stats.pangas++;
    }
    if (placed === 0) return;
    // Gear by the bows, a panguero and the inevitable dog.
    for (let k = 0; k < 2 + Math.floor(rnd() * 4); k++) {
      const p = this.beach(z0 + rr(rnd, -spacing * n * 0.6, spacing * n * 0.6), rr(rnd, 15, 21));
      if (!p || !this.site.isFree(p.x, p.z, 0.6)) continue;
      const b = this.chunks.at(p.x, p.z);
      b.frame(p.x, p.y - 0.02, p.z, rnd() * 6.28);
      beachClutter(b, rnd);
      b.identity();
      this.site.occupy(p.x, p.z, 0.6);
    }
    if (rnd() < 0.85) {
      const q = this.beach(z0 + rr(rnd, -4, 4), rr(rnd, 16.5, 19));
      if (q) this.personAt(rnd, q.x, q.z, Math.atan2(-q.nz, -q.nx) + rr(rnd, -1, 1), 'local', false, true);
    }
    if (rnd() < 0.5) this.beachDog(rnd, z0 + rr(rnd, -6, 6), rr(rnd, 15, 22));
  }

  private anchoredPanga(rnd: () => number, z: number, s: number) {
    const p = this.site.shore(z, s);
    if (!p || this.site.data.depth(p[0], p[1]) < 0.9) return;
    const len = rr(rnd, 6.6, 7.4);
    const b = this.anim;
    b.frame(p[0] - len / 2, -0.24, p[1], 0);
    b.pivot(len / 2, 0.24, 0);
    b.anim(4, rnd() * 6.28);
    panga(b, col(PANGA_BANDS[Math.floor(rnd() * PANGA_BANDS.length)]), rnd, false, len);
    b.anim(0);
    b.identity();
    this.stats.pangas++;
  }

  private launchSpot(rnd: () => number, z0: number, kites: number, banners: number, tent: boolean) {
    let placed = 0;
    for (let tries = 0; placed < kites && tries < kites * 6; tries++) {
      const z = z0 + rr(rnd, -55, 55);
      const p = this.beach(z, rr(rnd, 6, 24));
      if (!p || p.y < 0.4) continue;
      const yaw = DOWNWIND_YAW + rr(rnd, -0.25, 0.25);
      const cx = p.x + Math.cos(yaw) * 1.6, cz = p.z + Math.sin(yaw) * 1.6;
      if (!this.site.isFree(cx, cz, 4.2) || this.site.hitsBuilding(cx, cz, 4.5)) continue;
      const b = this.anim;
      this.groundFrame(b, p.x, p.z, yaw, 0.03);
      const pal = KITE_PALETTES[Math.floor(rnd() * KITE_PALETTES.length)];
      parkedKite(b, { canopy: pal.canopy, tube: pal.tube }, rnd, rr(rnd, 0.85, 1.1));
      b.identity();
      this.site.occupy(cx, cz, 4.2);
      this.stats.kites++;
      placed++;
      // Board upwind of the kite, and often its rider.
      if (rnd() < 0.6) {
        const bx = p.x - Math.cos(yaw) * rr(rnd, 1.5, 3), bz = p.z - Math.sin(yaw) * rr(rnd, 1.5, 3) + rr(rnd, -2, 2);
        const sb = this.chunks.at(bx, bz);
        this.groundFrame(sb, bx, bz, rnd() * 6.28, 0.01);
        kiteboard(sb, col(rnd() < 0.5 ? 0xf5f5f2 : BRIGHT[Math.floor(rnd() * BRIGHT.length)]), col(BRIGHT[Math.floor(rnd() * BRIGHT.length)]));
        sb.identity();
      }
      if (rnd() < 0.7) {
        // Rider standing upwind of the parked kite, facing it or the water.
        const ux = -Math.cos(yaw), uz = -Math.sin(yaw);
        const side = rnd() < 0.5 ? -1 : 1;
        const kx = p.x + ux * rr(rnd, 1.2, 2.2) - uz * side * rr(rnd, 1, 3), kz = p.z + uz * rr(rnd, 1.2, 2.2) + ux * side * rr(rnd, 1, 3);
        this.personAt(rnd, kx, kz, rnd() < 0.5 ? yaw : Math.atan2(-p.nz, -p.nx), 'kiter', false, true);
      }
    }
    // Kite-school feather banners and a pop-up shade at the back of the beach.
    for (let i = 0; i < banners; i++) {
      const p = this.beach(z0 + (i - (banners - 1) / 2) * rr(rnd, 5, 8) + rr(rnd, -1, 1), rr(rnd, 28, 36));
      if (!p || this.site.hitsBuilding(p.x, p.z, 1)) continue;
      this.featherBanner(rnd, p.x, p.y, p.z);
    }
    if (tent) {
      const p = this.beach(z0 + rr(rnd, -10, 10), rr(rnd, 26, 32));
      if (p && this.site.isFree(p.x, p.z, 2.5) && !this.site.hitsBuilding(p.x, p.z, 3)) {
        const b = this.chunks.at(p.x, p.z);
        b.frame(p.x, p.y - 0.02, p.z, Math.atan2(p.nz, p.nx));
        popupShade(b, col(BRIGHT[Math.floor(rnd() * 6)]));
        // Boards leaning on a rack.
        for (let k = 0; k < 4; k++) {
          b.color(col(BRIGHT[Math.floor(rnd() * BRIGHT.length)]));
          b.box(-1.1, 0.7, -1.2 + k * 0.8, 0.02, 0.69, 0.2, 63);
        }
        b.identity();
        this.site.occupy(p.x, p.z, 2.5);
        if (rnd() < 0.8) this.beachPerson(rnd, p.z + 1, rr(rnd, 26, 30), 'kiter');
      }
    }
  }

  private featherBanner(rnd: () => number, x: number, y: number, z: number) {
    const tiles: TileName[] = ['bannerA', 'bannerB', 'bannerC'];
    const b = this.anim;
    b.frame(x, y, z, 0);
    b.anim(0);
    b.color(col(0x2c2c2c));
    b.box(0, 2.1, 0, 0.025, 2.1, 0.025, NO_BOTTOM);
    cloth(b, this.atlas.tiles[tiles[Math.floor(rnd() * tiles.length)]], 0.78, 0.75, 4.15, 0.55, rnd, true);
    b.identity();
    this.site.occupy(x, z, 1.2);
    this.stats.banners++;
  }

  private umbrellaRow(rnd: () => number, z0: number, n: number, restaurant: boolean) {
    const thatch = col(THATCH[Math.floor(rnd() * THATCH.length)]);
    const step = rr(rnd, 6.5, 8.5);
    const s0 = rr(rnd, 20, 30);
    for (let i = 0; i < n; i++) {
      const z = z0 + (i - (n - 1) / 2) * step + rr(rnd, -0.8, 0.8);
      const p = this.beach(z, s0 + rr(rnd, -2, 2));
      if (!p || p.y < 0.5) continue;
      if (!this.site.isFree(p.x, p.z, 2.6) || this.site.hitsBuilding(p.x, p.z, 3)) continue;
      const b = this.chunks.at(p.x, p.z);
      b.frame(p.x, p.y - 0.05, p.z, 0);
      palapaUmbrella(b, thatch.clone().offsetHSL(0, 0, rr(rnd, -0.03, 0.03)), this.atlas.tiles.thatch, rr(rnd, 1.8, 2.3), rr(rnd, 2.3, 2.6), rnd);
      const seaward = Math.atan2(-p.nz, -p.nx);
      if (restaurant || rnd() < 0.75) beachFurniture(b, rnd, seaward);
      b.identity();
      this.site.occupy(p.x, p.z, 2.6);
      this.stats.umbrellas++;
      if (rnd() < 0.3) {
        const a = rnd() * 6.28;
        this.personAt(rnd, p.x + Math.cos(a) * 1.1, p.z + Math.sin(a) * 1.1, seaward + rr(rnd, -0.5, 0.5), 'tourist', rnd() < 0.6, true);
      }
      if (rnd() < 0.12) this.dogAt(rnd, p.x + rr(rnd, -1, 1), p.z + rr(rnd, -1, 1), rnd() * 6.28, true);
      // A couple of palms behind beach restaurants.
      if (restaurant && rnd() < 0.5) {
        const q = this.beach(z + rr(rnd, -3, 3), s0 + rr(rnd, 9, 16));
        if (q && !this.site.hitsBuilding(q.x, q.z, 1.2)) this.palms.push([q.x, q.z, rnd() < 0.85 ? 0 : 1]);
      }
    }
  }

  private beachPerson(rnd: () => number, z: number, s: number, role: 'local' | 'kiter' | 'tourist' = 'tourist') {
    const p = this.beach(z, s);
    if (!p || p.y < 0.3) return;
    const face = Math.atan2(-p.nz, -p.nx) + rr(rnd, -1.2, 1.2);
    this.personAt(rnd, p.x, p.z, face, role, role === 'tourist' && rnd() < 0.25);
  }

  /** `force` skips the clearance test for people placed on purpose beside a prop. */
  personAt(rnd: () => number, x: number, z: number, yaw: number, role: 'local' | 'kiter' | 'tourist', sitting: boolean, force = false) {
    if (!force && !this.site.isFree(x, z, 0.35)) return;
    if (this.site.hitsBuilding(x, z, 0.4)) return;
    const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];
    let look: PersonLook;
    if (role === 'kiter') {
      const suit = rnd() < 0.7;
      look = {
        skin: pick(SKIN),
        top: suit ? 0x1c1c1e : pick(BRIGHT),
        bottom: suit ? 0x1c1c1e : pick([0x1d3557, 0x264653, 0xff6b4a, 0x3a86ff]),
        legs: suit ? 0x1c1c1e : pick(SKIN),
        hair: pick(HAIR),
        hat: rnd() < 0.35 ? pick([0xffffff, 0x222222, 0xe63946]) : null,
        sombrero: false,
        harness: pick([0x14a3a8, 0xff6b4a, 0x222831, 0xffc928, 0x3a86ff]),
      };
    } else if (role === 'local') {
      look = {
        skin: pick([0x8d5a3b, 0xb07650, 0x6f4630, 0xa86c48]),
        top: pick([0xf4f1e8, 0x9fb8c8, 0x5c6b73, 0xd9c7a1, 0x2f5d8a]),
        bottom: pick([0x2b3a55, 0x3d3d3d, 0x5a4a3a]),
        legs: pick([0x2b3a55, 0x3d3d3d]),
        hair: 0x1a120c,
        hat: rnd() < 0.6 ? pick([0xf4f1e8, 0x1d3557, 0xc8333a, 0x2a9d8f]) : null,
        sombrero: rnd() < 0.25,
        harness: null,
      };
    } else {
      const skin = pick(SKIN);
      look = {
        skin,
        top: pick(BRIGHT),
        bottom: pick([0x1d3557, 0x264653, 0xff6b4a, 0x3a86ff, 0xe9c46a, 0xf4f1e8]),
        legs: skin,
        hair: pick(HAIR),
        hat: rnd() < 0.45 ? pick([0xf4f1e8, 0xe9d8a6, 0x222222, 0xe63946]) : null,
        sombrero: false,
        harness: null,
      };
    }
    const b = this.anim;
    b.frame(x, this.site.ground(x, z) - 0.02, z, yaw);
    person(b, look, rnd, sitting);
    b.identity();
    this.site.occupy(x, z, 0.35);
    this.stats.people++;
  }

  private beachDog(rnd: () => number, z: number, s: number) {
    const p = this.beach(z, s);
    if (!p || p.y < 0.3) return;
    this.dogAt(rnd, p.x, p.z, rnd() * 6.28, rnd() < 0.5);
  }

  /** Public so the village and campground can scatter dogs too. */
  dogAt(rnd: () => number, x: number, z: number, yaw: number, lying: boolean) {
    if (!this.site.isFree(x, z, 0.5) || this.site.hitsBuilding(x, z, 0.6)) return;
    const b = this.anim;
    b.frame(x, this.site.ground(x, z) - 0.01, z, yaw);
    dog(b, DOG_COATS[Math.floor(rnd() * DOG_COATS.length)], rnd, lying);
    b.identity();
    this.site.occupy(x, z, 0.5);
    this.stats.dogs++;
  }

  /** Rock-ringed pools dug into the sand at the waterline, where the hot water seeps up. */
  private hotSpringPools(rnd: () => number, z0: number) {
    const rocks = [0x6e655c, 0x857a6d, 0x5a524b, 0x948875];
    for (let k = 0; k < 4; k++) {
      const p = this.beach(z0 + rr(rnd, -45, 45), rr(rnd, 1.5, 4));
      if (!p || !this.site.isFree(p.x, p.z, 2)) continue;
      const r = rr(rnd, 1.1, 1.6);
      const b = this.chunks.at(p.x, p.z);
      b.frame(p.x, p.y, p.z, rnd() * 6.28);
      b.color(col(0x4f8f96));
      b.disc(0, 0.04, 0, r * 0.95, 10, 1);
      const n = Math.round(r * 7);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rr(rnd, -0.1, 0.1);
        b.color(col(rocks[Math.floor(rnd() * rocks.length)]));
        b.blob(Math.cos(a) * r, 0.08, Math.sin(a) * r, rr(rnd, 0.22, 0.36), rr(rnd, 0.13, 0.22), rr(rnd, 0.2, 0.32), 5);
      }
      b.identity();
      this.site.occupy(p.x, p.z, r + 0.4);
      // Bathers sitting in the warm water.
      for (let i = 0; i < 1 + Math.floor(rnd() * 2); i++) {
        const a = rnd() * 6.28;
        this.personAt(rnd, p.x + Math.cos(a) * r * 0.35, p.z + Math.sin(a) * r * 0.35, a + Math.PI, 'tourist', true, true);
      }
    }
  }

  /** Flagpoles with the Mexican flag in the school yards. */
  private schoolFlags(rnd: () => number) {
    for (const a of this.site.data.world.areas) {
      if (a.kind !== 'school') continue;
      const bb = polygonBounds(a.pts);
      let done = false;
      for (let k = 0; k < 40 && !done; k++) {
        const x = bb.x0 + (bb.x1 - bb.x0) * (0.3 + 0.4 * rnd()), z = bb.z0 + (bb.z1 - bb.z0) * (0.3 + 0.4 * rnd());
        if (!pointInPolygon(x, z, a.pts) || this.site.hitsBuilding(x, z, 2)) continue;
        const y = this.site.ground(x, z);
        const b = this.anim;
        b.frame(x, y, z, 0);
        b.anim(0);
        b.color(col(0xd4d4d0));
        b.cylinder(0, 0, 0, 0.3, 0.3, 0.35, 6, 1);
        b.color(col(0xbfc2c4));
        b.cylinder(0, 0.35, 0, 0.06, 0.04, 9.2, 6, 1);
        cloth(b, this.atlas.tiles.flagMx, 2.3, 7.75, 9.15, 0, rnd);
        b.identity();
        this.site.occupy(x, z, 1);
        done = true;
      }
    }
  }

  /** Free-standing hand-painted sign at the back of the beach in front of a restaurant. */
  private signBoard(rnd: () => number, poiZ: number, tile: TileName) {
    const p = this.beach(poiZ, rr(rnd, 38, 44));
    if (!p || this.site.hitsBuilding(p.x, p.z, 2.5)) return;
    const b = this.chunks.at(p.x, p.z);
    // Sign faces the sea: local +x seaward.
    b.frame(p.x, p.y, p.z, Math.atan2(-p.nz, -p.nx));
    b.color(col(0x5b4330));
    for (const z of [-1.5, 1.5]) b.box(0, 1.3, z, 0.06, 1.3, 0.06, NO_BOTTOM);
    b.color(col(0xffffff));
    b.quadFacing(0.07, 1.55, 1.75, 0.07, 1.55, -1.75, 0.07, 2.4, -1.75, 0.07, 2.4, 1.75, 1, 0, 0, this.atlas.tiles[tile]);
    b.color(col(0x5b4330));
    b.box(0, 1.975, 0, 0.05, 0.45, 1.8, 63);
    b.identity();
    this.site.occupy(p.x, p.z, 2);
  }
}

/** Pop-up canopy (kite school shade) centred at the origin. */
function popupShade(b: MeshBuilder, color: THREE.Color) {
  const h = 2.4, r = 1.5;
  b.color(col(0xb9bcbf));
  for (const [x, z] of [[-r, -r], [r, -r], [r, r], [-r, r]]) b.box(x, h / 2, z, 0.025, h / 2, 0.025, NO_BOTTOM);
  b.color(color);
  b.cone(0, h, 0, r * 1.414, 0.7, 4, Math.PI / 4);
  b.color(color, 0.55);
  for (let i = 0; i < 4; i++) {
    const t0 = Math.PI / 4 + (i / 4) * Math.PI * 2, t1 = Math.PI / 4 + ((i + 1) / 4) * Math.PI * 2;
    b.triFlat(Math.cos(t0) * r * 1.414, h, Math.sin(t0) * r * 1.414, Math.cos(t1) * r * 1.414, h, Math.sin(t1) * r * 1.414, 0, h + 0.65, 0);
  }
  // Valance.
  b.color(color, 0.9);
  const c = [[-r, -r], [r, -r], [r, r], [-r, r]];
  for (let i = 0; i < 4; i++) {
    const [ax, az] = c[i], [bx, bz] = c[(i + 1) % 4];
    b.quad2(ax, h - 0.25, az, bx, h - 0.25, bz, bx, h, bz, ax, h, az);
  }
}
