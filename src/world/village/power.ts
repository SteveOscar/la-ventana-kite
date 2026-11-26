import * as THREE from 'three';
import { mulberry32 } from '../../core/math.ts';
import type { LineBuilder } from './builder.ts';
import type { ChunkSet } from './chunks.ts';
import type { HouseInfo } from './houses.ts';
import { type Site, rr } from './site.ts';

const col = (h: number) => new THREE.Color(h);

interface Pole {
  x: number;
  z: number;
  y: number;
  /** Unit vector along the crossarm (across the road). */
  ax: number;
  az: number;
  h: number;
}

/**
 * CFE-style concrete poles every ~40 m along the highway with sagging
 * primaries, a secondary rack and service drops to the nearest houses.
 */
export class PowerLines {
  private readonly site: Site;
  private readonly chunks: ChunkSet;
  private readonly lines: LineBuilder;
  private readonly houseHash = new Map<number, HouseInfo[]>();
  poles = 0;

  constructor(site: Site, chunks: ChunkSet, lines: LineBuilder, houses: HouseInfo[]) {
    this.site = site;
    this.chunks = chunks;
    this.lines = lines;
    for (const h of houses) {
      const k = this.key(h.x, h.z);
      const list = this.houseHash.get(k);
      if (list) list.push(h);
      else this.houseHash.set(k, [h]);
    }
  }

  private key(x: number, z: number) {
    return (Math.floor(x / 50) + 1000) * 4096 + Math.floor(z / 50) + 1000;
  }

  build() {
    const rnd = mulberry32(31337);
    const concrete = col(0xaaa59b), steel = col(0x55595c), porcelain = col(0x8f8274);
    const wire = col(0x262626);
    for (const line of this.site.data.world.mainRoad) {
      let prev: Pole | null = null;
      let carry = 0;
      for (let i = 0; i + 1 < line.length; i++) {
        const [ax, az] = line[i], [bx, bz] = line[i + 1];
        const segLen = Math.hypot(bx - ax, bz - az);
        if (segLen < 1e-3) continue;
        const dx = (bx - ax) / segLen, dz = (bz - az) / segLen;
        let t = carry;
        while (t < segLen) {
          const px = ax + dx * t, pz = az + dz * t;
          t += rr(rnd, 37, 44);
          if (pz < -6800 || pz > 2600 || !this.site.data.heightNear.inside(px, pz, 300)) {
            prev = null;
            continue;
          }
          // Seaward shoulder first; the other side if a house is in the way.
          const nx = -dz, nz = dx;
          const sea = this.site.data.sdf(px + nx * 5, pz + nz * 5) < this.site.data.sdf(px - nx * 5, pz - nz * 5) ? 1 : -1;
          let pole: Pole | null = null;
          for (const side of [sea, -sea]) {
            const x = px + nx * 5.5 * side, z = pz + nz * 5.5 * side;
            if (this.site.hitsBuilding(x, z, 0.8) || !this.site.isFree(x, z, 0.5)) continue;
            // Crossarm axis points away from the road so the lamp arm (local -x) reaches over it.
            pole = { x, z, y: this.site.ground(x, z), ax: nx * side, az: nz * side, h: rr(rnd, 10, 11) };
            break;
          }
          if (!pole) continue;
          this.pole(pole, rnd, concrete, steel, porcelain);
          if (prev && Math.hypot(prev.x - pole.x, prev.z - pole.z) < 95) this.span(prev, pole, wire);
          this.serviceDrops(pole, rnd, wire);
          prev = pole;
        }
        carry = t - segLen;
      }
    }
  }

  private pole(p: Pole, rnd: () => number, concrete: THREE.Color, steel: THREE.Color, porcelain: THREE.Color) {
    const b = this.chunks.at(p.x, p.z);
    // Local frame: x along the crossarm.
    b.frame(p.x, p.y - 0.6, p.z, Math.atan2(p.az, p.ax));
    b.color(concrete);
    b.cylinder(0, 0, 0, 0.19, 0.1, p.h + 0.6, 8, 1, true, Math.PI / 8);
    const top = p.h + 0.6;
    b.color(steel);
    b.box(0, top - 0.4, 0, 1.25, 0.05, 0.05, 63);
    b.color(porcelain);
    for (const x of [-1.1, 0, 1.1]) b.box(x, top - 0.25, 0, 0.05, 0.1, 0.05, 63 & ~8);
    // Secondary rack with three spools.
    b.color(steel);
    b.box(0, top - 2.6, 0.14, 0.04, 0.42, 0.03, 63);
    b.color(porcelain);
    for (const y of [-0.3, 0, 0.3]) b.box(0, top - 2.6 + y, 0.2, 0.05, 0.05, 0.05, 63);
    if (rnd() < 0.12) {
      // Pole-mounted transformer.
      b.color(col(0x8d9296));
      b.cylinder(0, top - 4.3, -0.42, 0.3, 0.3, 0.95, 8, 3);
      b.color(steel);
      b.box(0, top - 3.85, -0.22, 0.1, 0.15, 0.1, 63);
    }
    if (rnd() < 0.3) {
      // Street lamp reaching over the road.
      b.color(steel);
      b.beam(0, top - 3.2, 0, -1.8, top - 2.8, 0, 0.05, 0.05);
      b.color(col(0x6d7175));
      b.box(-1.95, top - 2.85, 0, 0.28, 0.06, 0.12, 63);
    }
    b.identity();
    this.site.occupy(p.x, p.z, 0.5);
    this.poles++;
  }

  private span(a: Pole, c: Pole, wire: THREE.Color) {
    const L = this.lines;
    L.color(wire);
    const d = Math.hypot(a.x - c.x, a.z - c.z);
    const sag = 0.35 + d * 0.012;
    // Keep conductors on the same arm end even when the poles alternate sides.
    const flip = a.ax * c.ax + a.az * c.az < 0 ? -1 : 1;
    for (const o of [-1.1, 0, 1.1]) {
      const ya = a.y - 0.6 + a.h + 0.6 - 0.12, yc = c.y - 0.6 + c.h + 0.6 - 0.12;
      L.catenary(a.x + a.ax * o, ya, a.z + a.az * o, c.x + c.ax * o * flip, yc, c.z + c.az * o * flip, sag, 8);
    }
    for (const yo of [-0.3, 0, 0.3]) {
      const ya = a.y + a.h - 2.6 + yo, yc = c.y + c.h - 2.6 + yo;
      L.catenary(a.x, ya, a.z, c.x, yc, c.z, sag * 1.4, 8);
    }
  }

  private serviceDrops(p: Pole, rnd: () => number, wire: THREE.Color) {
    const L = this.lines;
    L.color(wire, 1.2);
    const i0 = Math.floor(p.x / 50), j0 = Math.floor(p.z / 50);
    let drops = 0;
    for (let i = i0 - 1; i <= i0 + 1; i++) {
      for (let j = j0 - 1; j <= j0 + 1; j++) {
        const list = this.houseHash.get((i + 1000) * 4096 + j + 1000);
        if (!list) continue;
        for (const h of list) {
          if (drops >= 3 || h.kind === 'open' || h.kind === 'shed') continue;
          const d = Math.hypot(h.x - p.x, h.z - p.z);
          if (d > 32 || rnd() > 0.45) continue;
          // Nearest corner at roof-edge height.
          const c = Math.cos(h.rot), s = Math.sin(h.rot);
          let best = Infinity, tx = h.x, tz = h.z;
          for (const [a, bb] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
            const lx = a * h.hw, lz = bb * h.hd;
            const wx = h.x + c * lx - s * lz, wz = h.z + s * lx + c * lz;
            const dd = Math.hypot(wx - p.x, wz - p.z);
            if (dd < best) {
              best = dd;
              tx = wx;
              tz = wz;
            }
          }
          const ty = Math.min(h.top, h.floor + 2.9) - 0.2;
          L.catenary(p.x, p.y + p.h - 2.6, p.z, tx, ty, tz, 0.25 + best * 0.01, 5);
          drops++;
        }
      }
    }
  }
}
