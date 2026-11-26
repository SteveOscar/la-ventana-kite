import * as THREE from 'three';
import { mulberry32 } from '../../core/math.ts';
import type { LineBuilder, MeshBuilder, UVRect } from './builder.ts';
import type { Atlas, TileName } from './atlas.ts';
import { subUV } from './atlas.ts';
import type { ChunkSet } from './chunks.ts';
import { type Site, pickWeighted, rr } from './site.ts';

const col = (h: number) => new THREE.Color(h);

/** Stucco colours of the two villages (sRGB), weighted. */
export const WALL_COLORS: readonly (readonly [number, number])[] = [
  [0xf4f0e6, 16], // whitewash
  [0xf1e4c6, 9], // cream
  [0xe8d3a6, 4], // sand
  [0xcf6d43, 5], // terracotta
  [0xe9a5b6, 5], // pink
  [0xd6587f, 3], // rosa mexicano
  [0x3fb0aa, 5], // turquoise
  [0x9fd8d2, 4], // aqua
  [0xdca53a, 5], // mustard
  [0xf2d06b, 4], // yellow
  [0xb69bd6, 4], // lilac
  [0xa9cd5d, 3], // lime
  [0x86bfe6, 4], // sky blue
  [0xf2b48c, 3], // peach
  [0xe58b6d, 3], // salmon
  [0xa7dcbb, 3], // mint
];
const ROOF_COLORS: readonly (readonly [number, number])[] = [
  [0xa24c37, 4], // red-oxide waterproofing
  [0xe9e6df, 3], // white waterproofing
  [0xa9a49b, 5], // bare concrete
];
const THATCH = [0xc8a66a, 0xb99a62, 0xa88f6a, 0xd2b57b];
const SHEET = [0xb3b8bb, 0x9aa0a4, 0x9b6345, 0x4c79a8, 0xb5513f, 0x5f8f5a];
const CLAY = [0xb8613a, 0xc4744c, 0xa9553a];
/** Pale stucco for hotels and schools. */
const PALE_COLORS: readonly (readonly [number, number])[] = [
  [0xf6f2e8, 6], [0xf1e4c6, 4], [0xe9d6b0, 2], [0xf2c9a8, 2], [0xbfe3de, 2], [0xf3dfa0, 1],
];
const BLOCK = 0xb1ada5;
const STONE = col(0xa89f91);
const WOOD = 0x6b4a2f;

export type HouseKind = 'flat' | 'palapa' | 'open' | 'gable' | 'shed';

export interface HouseInfo {
  index: number;
  x: number;
  z: number;
  rot: number;
  hw: number;
  hd: number;
  floor: number;
  top: number;
  kind: HouseKind;
  front: number;
  sdf: number;
}

/**
 * Faces of a footprint in its local frame (x = width axis). Face f runs from
 * corner f + 1 (left, seen from outside) to corner f (right); FACE_N is its
 * outward normal. HouseInfo.front indexes these.
 */
export const FACE_N: readonly (readonly [number, number])[] = [[0, -1], [1, 0], [0, 1], [-1, 0]];
export const CORNER: readonly (readonly [number, number])[] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

interface Style {
  wall: THREE.Color;
  upper: THREE.Color;
  plinth: THREE.Color;
  trim: THREE.Color;
  winG: TileName;
  winU: TileName;
  door: TileName;
  plainG: TileName;
  plainU: TileName;
  unfinished: boolean;
}

export class HouseFactory {
  private readonly site: Site;
  private readonly atlas: Atlas;
  private readonly chunks: ChunkSet;
  private readonly lines: LineBuilder;
  private readonly rebar = col(0x5b3a26);
  private readonly wire = col(0x2a2a2a);
  private readonly tmp = [0, 0, 0];
  readonly houses: HouseInfo[] = [];
  /** Counts for QA. */
  stats = { houses: 0, tinacos: 0, palapas: 0, twoStorey: 0, rebar: 0 };

  constructor(site: Site, atlas: Atlas, chunks: ChunkSet, lines: LineBuilder) {
    this.site = site;
    this.atlas = atlas;
    this.chunks = chunks;
    this.lines = lines;
  }

  buildAll() {
    const blds = this.site.data.world.buildings;
    for (let i = 0; i < blds.length; i++) {
      const [x, z, w, d, rot] = blds[i];
      if (!this.site.data.heightNear.inside(x, z, 150)) continue;
      this.build(i, x, z, w, d, rot);
    }
  }

  private build(index: number, x: number, z: number, w0: number, d0: number, rot: number) {
    const site = this.site;
    const T = this.atlas.tiles;
    const sdf = site.data.sdf(x, z);
    if (sdf < 6) return;
    const rnd = mulberry32((index * 2654435761) ^ 0x5bd1e995);
    const hw = Math.max(1.1, w0 / 2), hd = Math.max(1.1, d0 / 2);
    const area = hw * hd * 4;
    const c = Math.cos(rot), s = Math.sin(rot);
    const beach = sdf < 170;
    const roadD = site.roadDistance(x, z);

    // Ground under the footprint (slightly enlarged so the walls never float).
    const pts: number[] = [x, z];
    for (const [a, b] of CORNER) {
      const lx = a * (hw + 0.4), lz = b * (hd + 0.4);
      pts.push(x + c * lx - s * lz, z + s * lx + c * lz);
      pts.push(x + c * lx * 0.5 - s * lz * 0.5, z + s * lx * 0.5 + c * lz * 0.5);
    }
    const [gLo, gHi] = site.groundRange(pts);
    const floor = gHi + 0.12;
    const yb = gLo - 0.8;

    let kind: HouseKind;
    if (area < 13) kind = 'shed';
    else {
      const palapaP = (beach ? 0.24 : sdf < 450 ? 0.12 : 0.07) * (area > 260 ? 0.4 : 1);
      const r = rnd();
      if (r < palapaP) kind = beach && area > 28 && area < 400 && rnd() < 0.4 ? 'open' : 'palapa';
      else if (r < palapaP + (area > 500 && !beach ? 0.4 : 0.07)) kind = 'gable';
      else kind = 'flat';
    }

    // Style. Big buildings (hotels, schools) lean to pale colours.
    const wall = col(area > 300 && rnd() < 0.75 ? pickWeighted(rnd, PALE_COLORS) : pickWeighted(rnd, WALL_COLORS));
    wall.offsetHSL(0, rr(rnd, -0.04, 0.03), rr(rnd, -0.035, 0.02));
    const unfinished = kind === 'flat' && rnd() < 0.13;
    if (unfinished) wall.setHex(BLOCK).offsetHSL(0, 0, rr(rnd, -0.04, 0.04));
    const upper = !unfinished && rnd() < 0.2 ? col(pickWeighted(rnd, WALL_COLORS)) : wall;
    const trimR = rnd();
    const trim = trimR < 0.6 || unfinished ? wall.clone() : trimR < 0.85 ? col(0xf4f2ec) : wall.clone().multiplyScalar(0.72);
    const style: Style = {
      wall,
      upper,
      plinth: wall.clone().lerp(STONE, 0.5).multiplyScalar(0.78),
      trim,
      winG: unfinished ? 'gBlockHole' : pickWeighted(rnd, [['gWinBars', 4], ['gWinAlu', 3], ['gWinShutA', 1], ['gWinShutB', 1], ['gWinArch', beach ? 1.5 : 0.6]] as const),
      winU: 'uWinBars',
      door: unfinished ? 'gDoorMetal' : pickWeighted(rnd, [['gDoorWood', 4], ['gDoorMetal', 3], ['gDoorDouble', 1], ['gDoorGlass', beach ? 2 : 0.3]] as const),
      plainG: unfinished ? 'gBlock' : rnd() < 0.5 ? 'gPlain' : 'gPlain2',
      plainU: unfinished ? 'uBlock' : rnd() < 0.5 ? 'uPlain' : 'uPlain2',
      unfinished,
    };
    style.winU = unfinished ? 'uBlockHole' : style.winG === 'gWinAlu' ? 'uWinAlu' : style.winG.startsWith('gWinShut') ? 'uWinShut' : 'uWinBars';

    // Street front: the face looking at the nearest road.
    let front = 0, best = -1;
    for (let f = 0; f < 4; f++) {
      const [nx, nz] = FACE_N[f];
      const lx = nx * (hw + 5), lz = nz * (hd + 5);
      const px = x + c * lx - s * lz, pz = z + s * lx + c * lz;
      const score = site.data.overlayAt(px, pz)[0] + (site.roadDistance(px, pz) < 14 ? 1.2 : 0) + rnd() * 0.15;
      if (score > best) {
        best = score;
        front = f;
      }
    }

    const b = this.chunks.at(x, z);
    const lb = this.chunks.lodAt(x, z);
    b.frame(x, 0, z, rot);
    lb.frame(x, 0, z, rot);
    const h = rr(rnd, 2.75, 3.05);
    let top = floor;

    if (kind === 'shed') {
      const sh = rr(rnd, 2.1, 2.5);
      const shedStyle: Style = { ...style, plainG: rnd() < 0.6 ? 'gBlock' : style.plainG, winG: 'gBlock', door: 'gDoorMetal' };
      if (shedStyle.plainG === 'gBlock') shedStyle.wall = col(BLOCK);
      this.walls(b, rnd, 0, 0, hw, hd, yb, floor, 1, sh, floor + sh, shedStyle, front, false, true);
      top = floor + sh;
      let roofCol: THREE.Color;
      if (rnd() < 0.55) {
        roofCol = col(SHEET[Math.floor(rnd() * SHEET.length)]);
        b.color(roofCol);
        this.leanTo(b, hw + 0.2, hd + 0.2, top + 0.05, 0.25, T.corrugated);
      } else {
        roofCol = col(0xb0aba2);
        b.color(roofCol);
        b.box(0, top + 0.06, 0, hw + 0.12, 0.06, hd + 0.12, 63 & ~8);
      }
      this.lodBlock(lb, 0, 0, hw, hd, yb, top + 0.1, shedStyle.wall, roofCol);
      top += 0.3;
    } else if (kind === 'palapa' || kind === 'open') {
      this.stats.palapas++;
      const wallTop = floor + rr(rnd, 2.6, 2.95);
      if (kind === 'palapa') {
        this.walls(b, rnd, 0, 0, hw, hd, yb, floor, 1, wallTop - floor, wallTop, style, front, false, false);
        this.lodBlock(lb, 0, 0, hw, hd, yb, wallTop, wall, null);
      } else {
        this.openPalapa(b, rnd, hw, hd, yb, floor, wallTop);
        this.lodBlock(lb, 0, 0, hw, hd, yb, floor, col(0xb4683f), null);
      }
      const ov = rr(rnd, 0.6, 1.1);
      const pitch = rr(rnd, 0.62, 0.8);
      const thatch = col(THATCH[Math.floor(rnd() * THATCH.length)]).offsetHSL(0, 0, rr(rnd, -0.04, 0.03));
      top = this.hipRoof(b, hw, hd, wallTop, ov, pitch, thatch);
      this.hipRoof(lb, hw, hd, wallTop, ov, pitch, thatch, 0, 0, true);
    } else if (kind === 'gable') {
      const storeys = area > 160 && rnd() < 0.3 ? 2 : 1;
      const wallTop = floor + storeys * h;
      this.walls(b, rnd, 0, 0, hw, hd, yb, floor, storeys, h, wallTop, style, front, roadD < 22 && rnd() < 0.35, false);
      const tile = beach || rnd() < 0.3 ? 'clay' : 'corrugated';
      const rc = tile === 'clay' ? col(CLAY[Math.floor(rnd() * CLAY.length)]) : col(SHEET[Math.floor(rnd() * SHEET.length)]);
      const pitch = tile === 'clay' ? rr(rnd, 0.42, 0.55) : rr(rnd, 0.2, 0.3), ov = rr(rnd, 0.3, 0.55);
      top = this.gableRoof(b, hw, hd, wallTop, pitch, ov, rc, T[tile], style.wall);
      this.lodBlock(lb, 0, 0, hw, hd, yb, wallTop, wall, null);
      this.gableRoof(lb, hw, hd, wallTop, pitch, ov, rc, null, style.wall);
    } else {
      // Flat concrete roofs with a parapet; some with a partial second storey.
      let storeys = 1;
      const r2 = rnd();
      const p2 = 0.14 + (area > 110 ? 0.1 : 0) + (beach ? 0.08 : 0) + (roadD < 25 ? 0.06 : 0);
      if (area > 50 && r2 < p2) storeys = area > 240 && beach && rnd() < 0.35 ? 3 : 2;
      if (storeys > 1) this.stats.twoStorey++;
      const shop = roadD < 24 && rnd() < 0.4;
      const roofCol = col(pickWeighted(rnd, ROOF_COLORS)).offsetHSL(0, 0, rr(rnd, -0.04, 0.03));
      const partial = storeys >= 2 && hw > 3 && hd > 3 && rnd() < 0.5;
      const lowerStoreys = partial ? 1 : storeys;
      const p1 = rr(rnd, 0.3, 0.75);
      const roof1 = floor + lowerStoreys * h;
      this.walls(b, rnd, 0, 0, hw, hd, yb, floor, lowerStoreys, h, roof1 + p1, style, front, shop, false);
      this.flatRoof(b, 0, 0, hw, hd, roof1, roof1 + p1, roofCol, style.trim);
      this.lodBlock(lb, 0, 0, hw, hd, yb, roof1 + p1, wall, roofCol);
      top = roof1 + p1;
      let roofX = 0, roofZ = 0, roofHW = hw, roofHD = hd, roofY = roof1;
      if (partial) {
        const alongX = hw >= hd;
        const frac = rr(rnd, 0.5, 0.72);
        const side = rnd() < 0.5 ? -1 : 1;
        let uhw = hw - 0.12, uhd = hd - 0.12, ox = 0, oz = 0;
        if (alongX) {
          uhw = hw * frac - 0.12;
          ox = side * (hw - uhw - 0.12);
        } else {
          uhd = hd * frac - 0.12;
          oz = side * (hd - uhd - 0.12);
        }
        const p = rr(rnd, 0.3, 0.7);
        const roof2 = roof1 + (storeys - 1) * h;
        const upStyle: Style = { ...style, wall: style.upper, plainG: style.plainU, winG: style.winU };
        this.walls(b, rnd, ox, oz, uhw, uhd, roof1, roof1, storeys - 1, h, roof2 + p, upStyle, front, false, false, true);
        this.flatRoof(b, ox, oz, uhw, uhd, roof2, roof2 + p, roofCol, style.trim);
        this.lodBlock(lb, ox, oz, uhw, uhd, roof1, roof2 + p, style.upper, roofCol);
        top = roof2 + p;
        // Castillos waiting for the next floor on the exposed terrace.
        const ex = alongX ? -side : 0, ez = alongX ? 0 : -side;
        const cx0 = ex !== 0 ? ex * (hw - 0.25) : 0, cz0 = ez !== 0 ? ez * (hd - 0.25) : 0;
        if (rnd() < 0.7) {
          const span = alongX ? hd - 0.25 : hw - 0.25;
          for (const t of [-1, 1]) {
            this.rebarBundle(b, rnd, alongX ? cx0 : t * span, roof1, alongX ? t * span : cz0, rr(rnd, 0.6, 1.3));
          }
        }
        roofX = ox;
        roofZ = oz;
        roofHW = uhw;
        roofHD = uhd;
        roofY = roof2;
      } else if (storeys >= 1 && (unfinished || rnd() < 0.22)) {
        this.stats.rebar++;
        const hgt = rr(rnd, 0.5, 1.4);
        for (const [a, bb] of CORNER) this.rebarBundle(b, rnd, a * (hw - 0.22), roof1, bb * (hd - 0.22), hgt + rr(rnd, -0.1, 0.1));
        if (hw > 3.6) for (const bb of [-1, 1]) this.rebarBundle(b, rnd, 0, roof1, bb * (hd - 0.22), hgt + rr(rnd, -0.1, 0.1));
        if (hd > 3.6) for (const a of [-1, 1]) this.rebarBundle(b, rnd, a * (hw - 0.22), roof1, 0, hgt + rr(rnd, -0.1, 0.1));
      }
      // Beach hotels often have a thatched terrace on the roof.
      if (storeys >= 2 && beach && roofHW > 2.6 && roofHD > 2.6 && rnd() < 0.35) {
        const phw = Math.min(roofHW - 0.6, 2.2), phd = Math.min(roofHD - 0.6, 2.2);
        const pox = roofX + (roofHW - phw - 0.4) * (rnd() < 0.5 ? -1 : 1), poz = roofZ + (roofHD - phd - 0.4) * (rnd() < 0.5 ? -1 : 1);
        const pt = roofY + 2.4;
        b.color(col(WOOD));
        for (const [a, bb] of CORNER) b.box(pox + a * (phw - 0.1), (roofY + pt) / 2, poz + bb * (phd - 0.1), 0.07, (pt - roofY) / 2, 0.07, 63 & ~8);
        const thatch = col(THATCH[Math.floor(rnd() * THATCH.length)]);
        top = Math.max(top, this.hipRoof(b, phw, phd, pt, 0.4, 0.6, thatch, pox, poz));
        this.hipRoof(lb, phw, phd, pt, 0.4, 0.6, thatch, pox, poz, true);
      } else {
        this.roofClutter(b, rnd, roofX, roofZ, roofHW, roofHD, roofY, unfinished, lb);
      }
    }

    b.identity();
    lb.identity();
    this.stats.houses++;
    this.houses.push({ index, x, z, rot, hw, hd, floor, top, kind, front, sdf });
  }

  /** Distant stand-in: a coloured box with a roof slab (10 triangles). */
  private lodBlock(lb: MeshBuilder, ox: number, oz: number, hw: number, hd: number, y0: number, y1: number, wall: THREE.Color, roof: THREE.Color | null) {
    lb.color(wall);
    for (let f = 0; f < 4; f++) {
      const [lA, lB] = CORNER[(f + 1) % 4], [rA, rB] = CORNER[f];
      const Lx = ox + lA * hw, Lz = oz + lB * hd, Rx = ox + rA * hw, Rz = oz + rB * hd;
      lb.quad(Lx, y0, Lz, Rx, y0, Rz, Rx, y1, Rz, Lx, y1, Lz);
    }
    if (roof) {
      lb.color(roof);
      lb.quadFacing(ox - hw, y1, oz + hd, ox + hw, y1, oz + hd, ox + hw, y1, oz - hd, ox - hw, y1, oz - hd, 0, 1, 0);
    }
  }

  /**
   * Walls of a block centred at local (ox, oz): plinth, storeys of facade
   * bays and a plain band up to `topY` (parapet).
   */
  private walls(
    b: MeshBuilder,
    rnd: () => number,
    ox: number,
    oz: number,
    hw: number,
    hd: number,
    yb: number,
    floor: number,
    storeys: number,
    h: number,
    topY: number,
    st: Style,
    front: number,
    shop: boolean,
    small: boolean,
    upperOnly = false,
  ) {
    const T = this.atlas.tiles;
    const bayTarget = rr(rnd, 2.7, 3.3);
    const parapetUV = subUV(T[st.plainU], 0.1, 0.55, 0.9, 0.85);
    const doorFace = front;
    for (let f = 0; f < 4; f++) {
      const [lA, lB] = CORNER[(f + 1) % 4], [rA, rB] = CORNER[f];
      const Lx = ox + lA * hw, Lz = oz + lB * hd, Rx = ox + rA * hw, Rz = oz + rB * hd;
      const len = Math.hypot(Rx - Lx, Rz - Lz);
      if (yb < floor - 0.01) {
        b.color(st.plinth);
        // On sloping lots the foundation shows; use block coursing when it is tall.
        if (floor - yb > 2.2) b.quadTiled(Lx, yb, Lz, Rx, yb, Rz, Rx, floor, Rz, Lx, floor, Lz, Math.max(1, Math.round(len / 3)), Math.max(1, Math.round((floor - yb) / 3)), T.blockPlinth);
        else b.quad(Lx, yb, Lz, Rx, yb, Rz, Rx, floor, Rz, Lx, floor, Lz);
      }
      const nb = small || len < 2.2 ? 1 : Math.max(1, Math.round(len / bayTarget));
      const bayW = len / nb;
      const isFront = f === doorFace;
      const doorBay = isFront && !upperOnly ? (nb >= 3 ? Math.floor(nb / 2) + (rnd() < 0.5 ? -1 : 0) : nb - 1) : -1;
      let shopBays = 0;
      if (shop && isFront && nb >= 2) shopBays = Math.min(nb - 1, rnd() < 0.5 ? 1 : 2);
      for (let sIdx = 0; sIdx < storeys; sIdx++) {
        const ya = floor + sIdx * h, yc = ya + h;
        const ground = sIdx === 0 && !upperOnly;
        b.color(sIdx > 0 || upperOnly ? st.upper : st.wall);
        for (let j = 0; j < nb; j++) {
          let tile: TileName;
          if (small) tile = isFront && ground && bayW > 1.4 && st.door ? (st.plainG === 'gBlock' ? 'gDoorMetal' : st.door) : st.plainG;
          else if (bayW < 1.9) tile = ground ? st.plainG : st.plainU;
          else if (ground) {
            if (j === doorBay) tile = st.door;
            else if (isFront && j < shopBays) tile = rnd() < 0.55 ? 'gShopShutter' : 'gShopOpen';
            else {
              const pw = isFront ? 0.72 : f === (front + 2) % 4 ? 0.3 : 0.45;
              tile = rnd() < pw ? st.winG : isFront && !st.unfinished && rnd() < 0.2 ? 'gGate' : st.plainG;
            }
          } else {
            const pw = isFront ? 0.7 : 0.42;
            const rr2 = rnd();
            tile = rr2 < pw ? (isFront && rr2 < 0.14 && !st.unfinished ? 'uBalcony' : st.winU) : st.plainU;
          }
          const t0 = j / nb, t1 = (j + 1) / nb;
          const ax = Lx + (Rx - Lx) * t0, az = Lz + (Rz - Lz) * t0, bx = Lx + (Rx - Lx) * t1, bz = Lz + (Rz - Lz) * t1;
          b.quad(ax, ya, az, bx, ya, bz, bx, yc, bz, ax, yc, az, T[tile]);
        }
        // Hand-painted shop sign above the shutters.
        if (ground && shopBays > 0) {
          const signs: TileName[] = ['signAbarrotes', 'signMariscos', 'signTacos', 'signPurificadora'];
          const sTile = signs[Math.floor(rnd() * signs.length)];
          const sw = Math.min(len * 0.85, bayW * shopBays * 1.05, 4.2);
          const sh = sw / 4.2;
          const y1 = Math.min(yc + (storeys > 1 ? 0.05 : 0.45), topY - 0.05), y0 = y1 - sh;
          const [nx, nz] = FACE_N[f];
          const mid = (bayW * shopBays) / 2 / len;
          const cx = Lx + (Rx - Lx) * mid + nx * 0.04, cz = Lz + (Rz - Lz) * mid + nz * 0.04;
          const dx = (Rx - Lx) / len, dz = (Rz - Lz) / len;
          b.quad(cx - (dx * sw) / 2, y0, cz - (dz * sw) / 2, cx + (dx * sw) / 2, y0, cz + (dz * sw) / 2, cx + (dx * sw) / 2, y1, cz + (dz * sw) / 2, cx - (dx * sw) / 2, y1, cz - (dz * sw) / 2, T[sTile]);
        }
      }
      const wallTop = floor + storeys * h;
      if (topY > wallTop + 0.01) {
        b.color(st.trim);
        b.quad(Lx, wallTop, Lz, Rx, wallTop, Rz, Rx, topY, Rz, Lx, topY, Lz, parapetUV);
      }
    }
  }

  /** Roof slab, parapet inner faces and coping. */
  private flatRoof(b: MeshBuilder, ox: number, oz: number, hw: number, hd: number, roofY: number, topY: number, roofCol: THREE.Color, trim: THREE.Color) {
    const t = 0.15;
    const ihw = hw - t, ihd = hd - t;
    b.color(roofCol);
    b.quadFacing(ox - ihw, roofY, oz + ihd, ox + ihw, roofY, oz + ihd, ox + ihw, roofY, oz - ihd, ox - ihw, roofY, oz - ihd, 0, 1, 0);
    if (topY <= roofY + 0.02) return;
    b.color(trim, 0.86);
    for (let f = 0; f < 4; f++) {
      const [aA, aB] = CORNER[f], [bA, bB] = CORNER[(f + 1) % 4];
      const [nx, nz] = FACE_N[f];
      // Inner face looks back toward the roof centre.
      b.quadFacing(ox + aA * ihw, roofY, oz + aB * ihd, ox + bA * ihw, roofY, oz + bB * ihd, ox + bA * ihw, topY, oz + bB * ihd, ox + aA * ihw, topY, oz + aB * ihd, -nx, 0, -nz);
    }
    b.color(trim, 0.97);
    for (let f = 0; f < 4; f++) {
      const [aA, aB] = CORNER[f], [bA, bB] = CORNER[(f + 1) % 4];
      b.quadFacing(ox + aA * ihw, topY, oz + aB * ihd, ox + bA * ihw, topY, oz + bB * ihd, ox + bA * hw, topY, oz + bB * hd, ox + aA * hw, topY, oz + aB * hd, 0, 1, 0);
    }
  }

  /** Tinacos, gas tanks, dishes, antennas and laundry on a flat roof. */
  private roofClutter(b: MeshBuilder, rnd: () => number, ox: number, oz: number, hw: number, hd: number, roofY: number, unfinished: boolean, lb: MeshBuilder) {
    if (hw < 1.5 || hd < 1.5) return;
    const [ca, cb] = CORNER[Math.floor(rnd() * 4)];
    const tx = ox + ca * (hw - 0.85), tz = oz + cb * (hd - 0.85);
    if (rnd() < (unfinished ? 0.35 : 0.62)) {
      this.stats.tinacos++;
      let base = roofY;
      if (rnd() < 0.35) {
        const sh = rr(rnd, 0.6, 1.6);
        b.color(col(0xb7b2a8));
        b.box(tx, base + sh / 2, tz, 0.62, sh / 2, 0.62, 63 & ~8);
        base += sh;
      }
      this.tinaco(b, tx, base, tz, rr(rnd, 0.5, 0.6), rr(rnd, 1.0, 1.3));
      if (rnd() < 0.2) this.tinaco(b, tx - ca * 1.25, base, tz, 0.5, 1.05);
      // Black tanks are the signature of these rooftops even from far away.
      lb.rgb(0.03, 0.03, 0.032);
      lb.box(tx, base + 0.55, tz, 0.5, 0.55, 0.5, 63 & ~8);
    }
    if (rnd() < 0.14) {
      // LP gas cylinder by the parapet.
      const gx = ox + -ca * (hw - 0.5), gz = oz + cb * (hd - 0.5);
      b.color(col(0xdedbd4));
      b.cylinder(gx, roofY, gz, 0.18, 0.18, 1.0, 6, 0);
      b.cylinder(gx, roofY + 1.0, gz, 0.18, 0.06, 0.14, 6, 1);
    }
    if (rnd() < 0.2) {
      // Satellite dish facing south (the satellites sit low over the southern horizon).
      const dx = ox + -ca * (hw - 0.6), dz = oz + -cb * (hd - 0.6);
      b.color(col(0xd9d9d6));
      b.box(dx, roofY + 0.35, dz, 0.03, 0.35, 0.03, 63 & ~8 & ~4);
      const [wx, wy, wz] = b.toWorld(dx, roofY + 0.75, dz, this.tmp);
      b.save().frameBasis(wx, wy, wz, 1, 0, 0, 0, 0.8, 0.6);
      b.cylinder(0, -0.08, 0, 0.06, 0.36, 0.12, 7, 1);
      b.restore();
    }
    if (rnd() < 0.1) {
      // Old TV antenna.
      const [ax, ay, az] = b.toWorld(ox + ca * (hw - 0.4), roofY, oz - cb * (hd - 0.4), this.tmp);
      const L = this.lines;
      L.color(this.wire, 1.4);
      L.seg(ax, ay, az, ax, ay + 2.6, az);
      for (let i = 0; i < 3; i++) {
        const y = ay + 1.9 + i * 0.3, w = 0.7 - i * 0.15;
        L.seg(ax - w, y, az, ax + w, y, az);
      }
    }
    if (rnd() < 0.09 && hw > 2.2 && hd > 2.2) this.laundry(b, rnd, ox, oz, hw, hd, roofY);
  }

  private tinaco(b: MeshBuilder, x: number, y: number, z: number, r: number, h: number) {
    b.rgb(0.028, 0.028, 0.03);
    b.cylinder(x, y, z, r * 0.92, r, h * 0.12, 8, 0);
    b.cylinder(x, y + h * 0.12, z, r, r, h * 0.72, 8, 0);
    b.cylinder(x, y + h * 0.84, z, r, r * 0.38, h * 0.16, 8, 0);
    b.cylinder(x, y + h, z, r * 0.38, r * 0.34, 0.06, 8, 1);
  }

  private rebarBundle(b: MeshBuilder, rnd: () => number, lx: number, y: number, lz: number, hgt: number) {
    const L = this.lines;
    L.color(this.rebar);
    const bent = rnd() < 0.3;
    for (const [a, c] of CORNER) {
      b.toWorld(lx + a * 0.06, y, lz + c * 0.06, this.tmp);
      const [x0, y0, z0] = this.tmp;
      const hh = hgt + rr(rnd, -0.08, 0.08);
      const tx = x0 + rr(rnd, -0.05, 0.05), tz = z0 + rr(rnd, -0.05, 0.05);
      L.seg(x0, y0, z0, tx, y0 + hh, tz);
      if (bent) L.seg(tx, y0 + hh, tz, tx + 0.12, y0 + hh - 0.05, tz + 0.08);
    }
    // A couple of stirrups.
    for (const yy of [0.25, 0.55]) {
      if (yy > hgt - 0.1) continue;
      const ring: number[][] = [];
      for (const [a, c] of CORNER) ring.push(b.toWorld(lx + a * 0.06, y + yy, lz + c * 0.06, [0, 0, 0]));
      for (let i = 0; i < 4; i++) {
        const p = ring[i], q = ring[(i + 1) % 4];
        L.seg(p[0], p[1], p[2], q[0], q[1], q[2]);
      }
    }
  }

  private laundry(b: MeshBuilder, rnd: () => number, ox: number, oz: number, hw: number, hd: number, roofY: number) {
    const alongX = hw > hd;
    const len = (alongX ? hw : hd) * 1.2;
    const off = (alongX ? hd : hw) * rr(rnd, -0.4, 0.4);
    const y = roofY + 1.7;
    const p0 = alongX ? [ox - len / 2, oz + off] : [ox + off, oz - len / 2];
    const p1 = alongX ? [ox + len / 2, oz + off] : [ox + off, oz + len / 2];
    const a = b.toWorld(p0[0], y, p0[1], [0, 0, 0]), c = b.toWorld(p1[0], y, p1[1], [0, 0, 0]);
    this.lines.color(this.wire, 1.2);
    this.lines.seg(a[0], roofY, a[2], a[0], y + 0.1, a[2]);
    this.lines.seg(c[0], roofY, c[2], c[0], y + 0.1, c[2]);
    this.lines.catenary(a[0], y, a[2], c[0], y, c[2], 0.08, 4);
    const cloth = [0xe63946, 0xf1faee, 0x457b9d, 0xffb703, 0x2a9d8f, 0xf4a3c0, 0xffffff, 0x8ecae6, 0x264653];
    const n = 3 + Math.floor(rnd() * 4);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n + rr(rnd, -0.04, 0.04);
      const w = rr(rnd, 0.3, 0.6), hh = rr(rnd, 0.35, 0.7);
      const cx = p0[0] + (p1[0] - p0[0]) * t, cz = p0[1] + (p1[1] - p0[1]) * t;
      const dx = alongX ? w / 2 : 0, dz = alongX ? 0 : w / 2;
      const yt = y - 0.08 * 4 * t * (1 - t);
      b.color(col(cloth[Math.floor(rnd() * cloth.length)]));
      b.quad2(cx - dx, yt - hh, cz - dz, cx + dx, yt - hh, cz + dz, cx + dx, yt, cz + dz, cx - dx, yt, cz - dz);
    }
  }

  /** Open-sided palapa restaurant: tiled floor, posts, beams, tables. */
  private openPalapa(b: MeshBuilder, rnd: () => number, hw: number, hd: number, yb: number, floor: number, top: number) {
    const tileFloor = col(rnd() < 0.6 ? 0xb4683f : 0xc9c2b4);
    b.color(tileFloor, 0.7);
    for (let f = 0; f < 4; f++) {
      const [lA, lB] = CORNER[(f + 1) % 4], [rA, rB] = CORNER[f];
      b.quad(lA * hw, yb, lB * hd, rA * hw, yb, rB * hd, rA * hw, floor, rB * hd, lA * hw, floor, lB * hd);
    }
    b.color(tileFloor);
    b.quadFacing(-hw, floor, hd, hw, floor, hd, hw, floor, -hd, -hw, floor, -hd, 0, 1, 0);
    const wood = col(WOOD);
    b.color(wood);
    const nx = Math.max(1, Math.round((hw * 2) / 3.4)), nz = Math.max(1, Math.round((hd * 2) / 3.4));
    const post = (x: number, z: number) => b.box(x, (floor + top) / 2, z, 0.11, (top - floor) / 2, 0.11, 63 & ~8 & ~4);
    for (let i = 0; i <= nx; i++) {
      const x = -hw + 0.15 + ((hw * 2 - 0.3) * i) / nx;
      post(x, -hd + 0.15);
      post(x, hd - 0.15);
    }
    for (let j = 1; j < nz; j++) {
      const z = -hd + 0.15 + ((hd * 2 - 0.3) * j) / nz;
      post(-hw + 0.15, z);
      post(hw - 0.15, z);
    }
    b.color(wood, 0.85);
    b.box(0, top - 0.1, -hd + 0.15, hw, 0.1, 0.08);
    b.box(0, top - 0.1, hd - 0.15, hw, 0.1, 0.08);
    b.box(-hw + 0.15, top - 0.1, 0, 0.08, 0.1, hd);
    b.box(hw - 0.15, top - 0.1, 0, 0.08, 0.1, hd);
    // Plastic tables and chairs.
    const tcol = col(pickWeighted(rnd, [[0xf2f2ee, 3], [0xc8102e, 1], [0x1d64b0, 1], [0xf2c14e, 1]] as const));
    for (let tx = -hw + 1.4; tx <= hw - 1.2; tx += 2.4) {
      for (let tz = -hd + 1.4; tz <= hd - 1.2; tz += 2.4) {
        if (rnd() < 0.25) continue;
        b.color(tcol);
        b.box(tx, floor + 0.72, tz, 0.4, 0.025, 0.4, 63 & ~8);
        b.box(tx, floor + 0.36, tz, 0.04, 0.35, 0.04, 63 & ~8 & ~4);
        b.color(tcol, 0.92);
        for (const [cx, cz] of [[0.65, 0], [-0.65, 0]]) {
          b.box(tx + cx, floor + 0.22, tz + cz, 0.21, 0.22, 0.21, 63 & ~8);
          b.box(tx + cx + Math.sign(cx) * 0.19, floor + 0.62, tz + cz, 0.025, 0.2, 0.2, 63 & ~8);
        }
      }
    }
  }

  /** Thatched hip roof centred at local (ox, oz); returns the ridge height. `lod` skips the underside and fringe. */
  hipRoof(b: MeshBuilder, hw: number, hd: number, wallTop: number, ov: number, pitch: number, thatch: THREE.Color, ox = 0, oz = 0, lod = false) {
    const T = this.atlas.tiles;
    const alongX = hw >= hd;
    const A = alongX ? hw : hd, B = alongX ? hd : hw;
    // Big restaurant palapas keep a sane ridge height.
    const tp = Math.min(Math.tan(pitch), 4.2 / Math.max(B, 0.1));
    const yR = wallTop + B * tp;
    const yE = wallTop - ov * tp;
    const Ae = A + ov, Be = B + ov;
    const Rl = Math.max(0, Ae - Be);
    // P(long, short) in the house frame.
    const P = (l: number, s: number): [number, number] => (alongX ? [ox + l, oz + s] : [ox + s, oz + l]);
    const D = (l: number, s: number): [number, number] => (alongX ? [l, s] : [s, l]);
    const e0 = P(-Ae, -Be), e1 = P(Ae, -Be), e2 = P(Ae, Be), e3 = P(-Ae, Be);
    const r0 = P(-Rl, 0), r1 = P(Rl, 0);
    const sideN = D(0, -1), sideP = D(0, 1), endN = D(-1, 0), endP = D(1, 0);
    const faces: [number[], number[], number[], number[], readonly number[], number][] = [
      [e1, e0, r0, r1, sideN, Ae * 2],
      [e3, e2, r1, r0, sideP, Ae * 2],
      [e2, e1, r1, r1, endP, Be * 2],
      [e0, e3, r0, r0, endN, Be * 2],
    ];
    for (const [p0, p1, p2, p3, n, len] of faces) {
      const cols = lod ? 1 : Math.max(1, Math.round(len / 2.6));
      b.color(thatch);
      if (lod) b.quadFacing(p0[0], yE, p0[1], p1[0], yE, p1[1], p2[0], yR, p2[1], p3[0], yR, p3[1], n[0], 0.7, n[1]);
      else {
        b.quadTiledFacing(p0[0], yE, p0[1], p1[0], yE, p1[1], p2[0], yR, p2[1], p3[0], yR, p3[1], cols, 1, T.thatch, n[0], 0.7, n[1]);
        b.color(thatch, 0.5);
        b.quadTiledFacing(p0[0], yE, p0[1], p1[0], yE, p1[1], p2[0], yR, p2[1], p3[0], yR, p3[1], 1, 1, T.thatch, -n[0], -0.7, -n[1]);
      }
    }
    if (lod) return yR;
    // Ragged eave fringe.
    b.color(thatch, 0.88);
    const ring = [e0, e1, e2, e3];
    const fringe = subUV(T.thatch, 0, 0, 1, 0.3);
    for (let i = 0; i < 4; i++) {
      const p = ring[i], q = ring[(i + 1) % 4];
      const cx = (p[0] + q[0]) / 2 - ox, cz = (p[1] + q[1]) / 2 - oz;
      const l = Math.hypot(cx, cz) || 1;
      const fx = (cx / l) * 0.06, fz = (cz / l) * 0.06;
      const cols = Math.max(1, Math.round(Math.hypot(q[0] - p[0], q[1] - p[1]) / 2.6));
      b.quadTiledFacing(q[0] + fx, yE - 0.3, q[1] + fz, p[0] + fx, yE - 0.3, p[1] + fz, p[0], yE + 0.02, p[1], q[0], yE + 0.02, q[1], cols, 1, fringe, cx, 0, cz);
      b.quadTiledFacing(q[0] + fx, yE - 0.3, q[1] + fz, p[0] + fx, yE - 0.3, p[1] + fz, p[0], yE + 0.02, p[1], q[0], yE + 0.02, q[1], 1, 1, fringe, -cx, 0, -cz);
    }
    return yR;
  }

  /** Gable roof (sheet metal or clay tile) with gable-end triangles; returns the ridge height. */
  private gableRoof(b: MeshBuilder, hw: number, hd: number, wallTop: number, pitch: number, ov: number, roofCol: THREE.Color, tile: UVRect | null, wall: THREE.Color) {
    const alongX = hw >= hd;
    const A = alongX ? hw : hd, B = alongX ? hd : hw;
    const tp = Math.tan(pitch);
    const yR = wallTop + B * tp, yE = wallTop - ov * tp;
    const Ae = A + 0.3, Be = B + ov;
    const P = (l: number, s: number): [number, number] => (alongX ? [l, s] : [s, l]);
    const cols = Math.max(1, Math.round((Ae * 2) / 1.6));
    const rows = Math.max(1, Math.round(Math.hypot(Be, yR - yE) / 2.2));
    for (const side of [-1, 1]) {
      const e0 = P(-Ae, side * Be), e1 = P(Ae, side * Be), r1 = P(Ae, 0), r0 = P(-Ae, 0);
      const n = P(0, side);
      b.color(roofCol);
      if (!tile) {
        b.quadFacing(e0[0], yE, e0[1], e1[0], yE, e1[1], r1[0], yR, r1[1], r0[0], yR, r0[1], n[0], 1, n[1]);
        continue;
      }
      b.quadTiledFacing(e0[0], yE, e0[1], e1[0], yE, e1[1], r1[0], yR, r1[1], r0[0], yR, r0[1], cols, rows, tile, n[0], 1, n[1]);
      b.color(roofCol, 0.55);
      b.quadFacing(e0[0], yE, e0[1], e1[0], yE, e1[1], r1[0], yR, r1[1], r0[0], yR, r0[1], -n[0], -1, -n[1]);
    }
    b.color(wall);
    for (const end of [-1, 1]) {
      const a = P(end * A, -B), c = P(end * A, B), apex = P(end * A, 0);
      const n = P(end, 0);
      b.quadFacing(a[0], wallTop, a[1], c[0], wallTop, c[1], apex[0], yR - 0.02, apex[1], apex[0], yR - 0.02, apex[1], n[0], 0, n[1]);
    }
    return yR;
  }

  /** Single-slope sheet roof for sheds. */
  private leanTo(b: MeshBuilder, hw: number, hd: number, y: number, rise: number, tile: UVRect) {
    const cols = Math.max(1, Math.round((hw * 2) / 1.6));
    b.quadTiledFacing(-hw, y, hd, hw, y, hd, hw, y + rise, -hd, -hw, y + rise, -hd, cols, 1, tile, 0, 1, 0.2);
    b.quadFacing(-hw, y, hd, hw, y, hd, hw, y + rise, -hd, -hw, y + rise, -hd, 0, -1, 0);
  }
}
