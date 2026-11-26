import * as THREE from 'three';

export type RGB = [number, number, number];

/** sRGB hex to linear RGB (vertex colours are read as linear). */
export const rgb = (hex: number): RGB => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};

export const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * Per-vertex rig channels read by the creature shader:
 * side +1 left wing / -1 right wing / 0 body; hand 1 = outer wing segment;
 * flex = weight of the vertical body bend; group = 1 limbs, 2/3 tail prongs, 4 carried item, 5 head.
 */
export interface Rig {
  side: number;
  hand: number;
  flex: number;
  group: number;
}

export const BODY: Rig = { side: 0, hand: 0, flex: 0, group: 0 };
export const rigGroup = (group: number): Rig => ({ side: 0, hand: 0, flex: 0, group });

/** Colour pair: the default plumage and the per-instance variant (mixed by the shader). */
export type Paint = (x: number, y: number, z: number, up: number) => [RGB, RGB];
export const solid = (c: RGB, c2: RGB = c): Paint => () => [c, c2];

export interface Station {
  z: number;
  /** Half width. 0 closes the end to a point. */
  w: number;
  /** Half height above / below the centre line. */
  top: number;
  bot?: number;
  y?: number;
  x?: number;
}

export interface WingStation {
  x: number;
  y: number;
  le: number;
  te: number;
}

/** Accumulates small low-poly parts into one indexed geometry with rig attributes. */
export class GeoBuilder {
  private pos: number[] = [];
  private col: number[] = [];
  private col2: number[] = [];
  private rig: number[] = [];
  private idx: number[] = [];
  private nrm: number[] = [];
  private partV = 0;
  private partI = 0;

  get vertexCount() {
    return this.pos.length / 3;
  }

  vertex(x: number, y: number, z: number, paint: Paint, up: number, r: Rig) {
    return this.vertexC(x, y, z, paint(x, y, z, up), r);
  }

  vertexC(x: number, y: number, z: number, [c, c2]: [RGB, RGB], r: Rig) {
    this.pos.push(x, y, z);
    this.col.push(c[0], c[1], c[2]);
    this.col2.push(c2[0], c2[1], c2[2]);
    this.rig.push(r.side, r.hand, r.flex, r.group);
    return this.vertexCount - 1;
  }

  tri(a: number, b: number, c: number) {
    this.idx.push(a, b, c);
  }

  private begin() {
    this.partV = this.vertexCount;
    this.partI = this.idx.length;
  }

  /** Smooth normals from the faces of the current part only. */
  private end() {
    const n0 = this.partV;
    const count = this.vertexCount - n0;
    const acc = new Float32Array(count * 3);
    const p = this.pos;
    for (let i = this.partI; i < this.idx.length; i += 3) {
      const a = this.idx[i], b = this.idx[i + 1], c = this.idx[i + 2];
      const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
      const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const v of [a, b, c]) {
        const o = (v - n0) * 3;
        acc[o] += nx;
        acc[o + 1] += ny;
        acc[o + 2] += nz;
      }
    }
    for (let k = 0; k < count; k++) {
      const x = acc[k * 3], y = acc[k * 3 + 1], z = acc[k * 3 + 2];
      const l = Math.hypot(x, y, z) || 1;
      this.nrm.push(x / l, y / l, z / l);
    }
  }

  /**
   * Lofts elliptical cross-sections along +z (tail first, nose last). `sq` > 2 squares the
   * section off; `rigAt` can vary the rig channels along the body.
   */
  loft(stations: Station[], sides: number, paint: Paint, r: Rig | ((z: number) => Rig) = BODY, sq = 2) {
    this.begin();
    const rings: number[][] = [];
    const e = 2 / sq;
    for (const s of stations) {
      const rr = typeof r === 'function' ? r(s.z) : r;
      const cx = s.x ?? 0, cy = s.y ?? 0;
      if (s.w <= 1e-4) {
        rings.push([this.vertex(cx, cy, s.z, paint, 0, rr)]);
        continue;
      }
      const ring: number[] = [];
      for (let j = 0; j < sides; j++) {
        const a = (j / sides) * Math.PI * 2;
        const sa = Math.sin(a), ca = Math.cos(a);
        const x = cx + s.w * Math.sign(sa) * Math.pow(Math.abs(sa), e);
        const h = ca >= 0 ? s.top : (s.bot ?? s.top);
        const y = cy + h * Math.sign(ca) * Math.pow(Math.abs(ca), e);
        ring.push(this.vertex(x, y, s.z, paint, ca, rr));
      }
      rings.push(ring);
    }
    for (let i = 0; i + 1 < rings.length; i++) {
      const A = rings[i], B = rings[i + 1];
      for (let j = 0; j < sides; j++) {
        const j1 = (j + 1) % sides;
        if (A.length === 1) this.tri(B[j], B[j1], A[0]);
        else if (B.length === 1) this.tri(A[j], B[0], A[j1]);
        else {
          this.tri(A[j], B[j], A[j1]);
          this.tri(B[j], B[j1], A[j1]);
        }
      }
    }
    this.end();
  }

  /**
   * A thin wing (or fin, or flipper) from root to tip along +x, mirrored for side -1.
   * Each span station gets a vertex at every chord fraction in `chords` (two close
   * fractions give a crisp colour band); `wrist` is the index of the station where the
   * hand begins. Paints receive (span 0..1, chord 0..1, z, +1 top / -1 bottom).
   */
  wing(side: 1 | -1, stations: WingStation[], wrist: number, thick: number, top: Paint, bottom: Paint, chords: number[] = [0, 0.45, 1]) {
    for (const surf of [1, -1]) {
      this.begin();
      const paint = surf > 0 ? top : bottom;
      const rows: number[][] = [];
      stations.forEach((s, i) => {
        const r: Rig = { side, hand: i > wrist ? 1 : 0, flex: 0, group: 0 };
        const y = s.y + (surf * thick) / 2;
        const span = (s.x - stations[0].x) / (stations[stations.length - 1].x - stations[0].x);
        rows.push(chords.map((c) => this.vertexC(s.x * side, y, s.le + (s.te - s.le) * c, paint(span, c, s.le + (s.te - s.le) * c, surf), r)));
      });
      const flip = surf * side < 0;
      for (let i = 0; i + 1 < rows.length; i++) {
        for (let k = 0; k + 1 < chords.length; k++) {
          const a = rows[i][k], b = rows[i + 1][k], c = rows[i][k + 1], d = rows[i + 1][k + 1];
          if (!flip) {
            this.tri(a, b, c);
            this.tri(c, b, d);
          } else {
            this.tri(a, c, b);
            this.tri(c, d, b);
          }
        }
      }
      this.end();
    }
  }

  /** Thin double-sided plate from a convex outline (fan from the first point). `n` = outward normal of side one. */
  plate(points: [number, number, number][], n: [number, number, number], thick: number, paint: Paint, r: Rig = BODY, paint2: Paint = paint) {
    for (const s of [1, -1]) {
      this.begin();
      const ids = points.map(([x, y, z]) => this.vertex(x + (n[0] * s * thick) / 2, y + (n[1] * s * thick) / 2, z + (n[2] * s * thick) / 2, s > 0 ? paint : paint2, n[1] * s, r));
      // Orient the fan so that its face normal agrees with the requested side.
      const [ax, ay, az] = points[0], [bx, by, bz] = points[1], [cx, cy, cz] = points[2];
      const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
      const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
      const agrees = (fx * n[0] + fy * n[1] + fz * n[2]) * s > 0;
      for (let i = 1; i + 1 < ids.length; i++) {
        if (agrees) this.tri(ids[0], ids[i], ids[i + 1]);
        else this.tri(ids[0], ids[i + 1], ids[i]);
      }
      this.end();
    }
  }

  /** Small closed blob (eye, ear, knob) as an octahedron-ish sphere. */
  blob(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, paint: Paint, r: Rig = BODY, seg = 6) {
    this.begin();
    const rings: number[][] = [];
    const n = Math.max(3, Math.round(seg / 2));
    for (let i = 0; i <= n; i++) {
      const v = (i / n) * Math.PI;
      const y = Math.cos(v), rr = Math.sin(v);
      if (i === 0 || i === n) {
        rings.push([this.vertex(cx, cy + ry * y, cz, paint, y, r)]);
        continue;
      }
      const ring: number[] = [];
      for (let j = 0; j < seg; j++) {
        const a = (j / seg) * Math.PI * 2;
        ring.push(this.vertex(cx + rx * rr * Math.sin(a), cy + ry * y, cz + rz * rr * Math.cos(a), paint, y, r));
      }
      rings.push(ring);
    }
    for (let i = 0; i < n; i++) {
      const A = rings[i], B = rings[i + 1];
      for (let j = 0; j < seg; j++) {
        const j1 = (j + 1) % seg;
        if (A.length === 1) this.tri(A[0], B[j], B[j1]);
        else if (B.length === 1) this.tri(A[j], B[0], A[j1]);
        else {
          this.tri(A[j], B[j], A[j1]);
          this.tri(A[j1], B[j], B[j1]);
        }
      }
    }
    this.end();
  }

  /** Overrides the flex weight of every vertex from its rest position. */
  setFlex(fn: (x: number, y: number, z: number) => number) {
    for (let v = 0; v < this.vertexCount; v++) this.rig[v * 4 + 2] = fn(this.pos[v * 3], this.pos[v * 3 + 1], this.pos[v * 3 + 2]);
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('color2', new THREE.Float32BufferAttribute(this.col2, 3));
    g.setAttribute('aRig', new THREE.Float32BufferAttribute(this.rig, 4));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}
