import * as THREE from 'three';

export type RGB = readonly [number, number, number];

const tmpColor = new THREE.Color();

/** sRGB components (0..1) to the linear working space vertex colours are stored in. */
export function srgb(r: number, g: number, b: number): RGB {
  tmpColor.setRGB(r, g, b, THREE.SRGBColorSpace);
  return [tmpColor.r, tmpColor.g, tmpColor.b];
}

export function mixRGB(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function shade(c: RGB, s: number): RGB {
  return [c[0] * s, c[1] * s, c[2] * s];
}

export interface TubeSpec {
  path: THREE.Vector3[];
  /** Radius at each path point. */
  radii: number[];
  sides: number;
  /** Alternating crest/groove profile with this many ribs (overrides `sides`). */
  ribs?: number;
  ribDepth?: number;
  /** 0 = round normals, 1 = flat facets around the stem. */
  facet?: number;
  phase?: number;
  /** Rounded tip, a cone point, or open. */
  cap?: 'dome' | 'point' | 'none';
  /** Tip length as a fraction of the end radius. */
  capLength?: number;
  /** t = 0..1 along the path, y = height of the vertex, groove = vertex sits in a rib groove. */
  color: (t: number, y: number, groove: boolean) => RGB;
}

export interface BlobSpec {
  center: THREE.Vector3;
  radii: THREE.Vector3;
  /** 0 = octahedron (8 faces), 1 = icosahedron (20), 2 = subdivided icosahedron (80). */
  detail: 0 | 1 | 2;
  /** Random radial displacement as a fraction of the radius. */
  jitter: number;
  rng: () => number;
  /** Vertices below center.y - floor * radii.y are flattened onto that plane. */
  floor?: number;
  /** 0 = ellipsoid normals (soft foliage), 1 = flat faces. */
  facet?: number;
  /** Shade as part of a larger crown: smooth normals point away from this ellipsoid instead of the blob's. */
  crown?: { center: THREE.Vector3; radii: THREE.Vector3 };
  /** dir = unit direction of the vertex from the centre before jitter. */
  color: (dir: THREE.Vector3, p: THREE.Vector3) => RGB;
}

const PHI = (1 + Math.sqrt(5)) / 2;
const ICO_V = [
  [-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0],
  [0, -1, PHI], [0, 1, PHI], [0, -1, -PHI], [0, 1, -PHI],
  [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1],
];
const ICO_F = [
  [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
  [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
];
const OCTA_V = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const OCTA_F = [[0, 2, 4], [4, 2, 1], [1, 2, 5], [5, 2, 0], [0, 4, 3], [4, 1, 3], [1, 5, 3], [5, 0, 3]];

interface Poly {
  verts: THREE.Vector3[];
  faces: number[][];
}
const polyCache = new Map<number, Poly>();

function polyhedron(detail: 0 | 1 | 2): Poly {
  const cached = polyCache.get(detail);
  if (cached) return cached;
  let poly: Poly;
  if (detail === 0) {
    poly = { verts: OCTA_V.map(([x, y, z]) => new THREE.Vector3(x, y, z)), faces: OCTA_F };
  } else {
    poly = { verts: ICO_V.map(([x, y, z]) => new THREE.Vector3(x, y, z).normalize()), faces: ICO_F };
    if (detail === 2) {
      const verts = poly.verts.slice();
      const mid = new Map<string, number>();
      const midpoint = (a: number, b: number) => {
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        let m = mid.get(key);
        if (m === undefined) {
          m = verts.length;
          verts.push(verts[a].clone().add(verts[b]).normalize());
          mid.set(key, m);
        }
        return m;
      };
      const faces: number[][] = [];
      for (const [a, b, c] of poly.faces) {
        const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
        faces.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
      }
      poly = { verts, faces };
    }
  }
  polyCache.set(detail, poly);
  return poly;
}

const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

/**
 * Accumulates low-poly plant parts into one indexed geometry. Colours are given in linear RGB and
 * stored relative to the species base colour, which the per-instance tint multiplies back in.
 */
export class GeoBuilder {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly colors: number[] = [];
  readonly indices: number[] = [];
  private readonly base: RGB;

  constructor(base: RGB = [1, 1, 1]) {
    this.base = base;
  }

  get triangles() {
    return this.indices.length / 3;
  }

  vertex(p: THREE.Vector3, n: THREE.Vector3, c: RGB) {
    this.positions.push(p.x, p.y, p.z);
    this.normals.push(n.x, n.y, n.z);
    this.colors.push(c[0] / this.base[0], c[1] / this.base[1], c[2] / this.base[2]);
    return this.positions.length / 3 - 1;
  }

  /** Adds a triangle, flipping its winding when it disagrees with the vertex normals. */
  tri(a: number, b: number, c: number) {
    const P = this.positions, N = this.normals;
    _a.set(P[a * 3], P[a * 3 + 1], P[a * 3 + 2]);
    _b.set(P[b * 3], P[b * 3 + 1], P[b * 3 + 2]).sub(_a);
    _c.set(P[c * 3], P[c * 3 + 1], P[c * 3 + 2]).sub(_a);
    _b.cross(_c);
    const nx = N[a * 3] + N[b * 3] + N[c * 3];
    const ny = N[a * 3 + 1] + N[b * 3 + 1] + N[c * 3 + 1];
    const nz = N[a * 3 + 2] + N[b * 3 + 2] + N[c * 3 + 2];
    if (_b.x * nx + _b.y * ny + _b.z * nz < 0) this.indices.push(a, c, b);
    else this.indices.push(a, b, c);
  }

  tube(s: TubeSpec) {
    const path = s.path;
    const n = path.length;
    const len = [0];
    for (let i = 1; i < n; i++) len.push(len[i - 1] + path[i].distanceTo(path[i - 1]));
    const total = len[n - 1] || 1;
    const T = path.map((_, i) => path[Math.min(n - 1, i + 1)].clone().sub(path[Math.max(0, i - 1)]).normalize());
    // Projection-based parallel transport keeps the rings from twisting along bends.
    const N: THREE.Vector3[] = [];
    const B: THREE.Vector3[] = [];
    let ref = Math.abs(T[0].y) < 0.95 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    for (let i = 0; i < n; i++) {
      const nv = ref.clone().addScaledVector(T[i], -ref.dot(T[i]));
      if (nv.lengthSq() < 1e-8) nv.set(1, 0, 0);
      nv.normalize();
      N.push(nv);
      B.push(new THREE.Vector3().crossVectors(T[i], nv).normalize());
      ref = nv;
    }
    const ribbed = !!s.ribs;
    const M = ribbed ? s.ribs! * 2 : s.sides;
    const depth = s.ribDepth ?? 0.12;
    const facet = s.facet ?? 0;
    const phase = s.phase ?? 0;
    const prof: { c: number; s: number; f: number }[] = [];
    for (let k = 0; k < M; k++) {
      const th = phase + (k / M) * Math.PI * 2;
      prof.push({ c: Math.cos(th), s: Math.sin(th), f: ribbed && k % 2 === 1 ? 1 - depth : 1 });
    }
    // Facet normals in the ring plane (2D, in the N/B frame).
    const facetN: { x: number; y: number }[] = [];
    for (let k = 0; k < M; k++) {
      const a = prof[k], b = prof[(k + 1) % M];
      const ex = b.c * b.f - a.c * a.f, ey = b.s * b.f - a.s * a.f;
      let nx = ey, ny = -ex;
      const l = Math.hypot(nx, ny) || 1;
      nx /= l;
      ny /= l;
      if (nx * (a.c + b.c) + ny * (a.s + b.s) < 0) {
        nx = -nx;
        ny = -ny;
      }
      facetN.push({ x: nx, y: ny });
    }
    const flat = facet > 0;
    const ringStart: number[] = [];
    for (let i = 0; i < n; i++) {
      const r = s.radii[i];
      const dr = (s.radii[Math.min(n - 1, i + 1)] - s.radii[Math.max(0, i - 1)]) / Math.max(1e-4, len[Math.min(n - 1, i + 1)] - len[Math.max(0, i - 1)]);
      const t = len[i] / total;
      ringStart.push(this.positions.length / 3);
      if (!flat) {
        for (let k = 0; k < M; k++) {
          const q = prof[k];
          _n.copy(N[i]).multiplyScalar(q.c).addScaledVector(B[i], q.s);
          _p.copy(path[i]).addScaledVector(_n, r * q.f);
          _n.addScaledVector(T[i], -dr).normalize();
          this.vertex(_p, _n, s.color(t, _p.y, ribbed && k % 2 === 1));
        }
      } else {
        // Two vertices per facet so each rib face can carry its own (partly flat) normal.
        for (let k = 0; k < M; k++) {
          const fn = facetN[k];
          for (let e = 0; e < 2; e++) {
            const kk = (k + e) % M;
            const q = prof[kk];
            _a.copy(N[i]).multiplyScalar(q.c).addScaledVector(B[i], q.s);
            _p.copy(path[i]).addScaledVector(_a, r * q.f);
            _b.copy(N[i]).multiplyScalar(fn.x).addScaledVector(B[i], fn.y);
            _n.copy(_a).lerp(_b, facet).addScaledVector(T[i], -dr).normalize();
            this.vertex(_p, _n, s.color(t, _p.y, ribbed && kk % 2 === 1));
          }
        }
      }
    }
    for (let i = 0; i + 1 < n; i++) {
      const r0 = ringStart[i], r1 = ringStart[i + 1];
      for (let k = 0; k < M; k++) {
        const a0 = flat ? r0 + k * 2 : r0 + k;
        const b0 = flat ? r0 + k * 2 + 1 : r0 + ((k + 1) % M);
        const a1 = flat ? r1 + k * 2 : r1 + k;
        const b1 = flat ? r1 + k * 2 + 1 : r1 + ((k + 1) % M);
        this.tri(a0, b0, b1);
        this.tri(a0, b1, a1);
      }
    }
    const cap = s.cap ?? 'none';
    if (cap === 'none') return;
    const last = n - 1;
    const rEnd = s.radii[last];
    const capLen = (s.capLength ?? (cap === 'dome' ? 0.85 : 1.6)) * rEnd;
    // Smooth ring at the end so the tip can share vertices with it.
    let prev = this.positions.length / 3;
    const rings = cap === 'dome' ? [0, 0.62] : [0];
    let prevStart = prev;
    for (let ri = 0; ri < rings.length; ri++) {
      const ang = rings[ri] * (Math.PI / 2);
      const rr = rEnd * Math.cos(ang);
      const lift = capLen * Math.sin(ang);
      prevStart = this.positions.length / 3;
      for (let k = 0; k < M; k++) {
        const q = prof[k];
        _a.copy(N[last]).multiplyScalar(q.c).addScaledVector(B[last], q.s);
        _p.copy(path[last]).addScaledVector(_a, rr * q.f).addScaledVector(T[last], lift);
        const tilt = cap === 'dome' ? Math.max(ang, 0.35) : 0.5;
        _n.copy(_a).multiplyScalar(Math.cos(tilt)).addScaledVector(T[last], Math.sin(tilt)).normalize();
        this.vertex(_p, _n, s.color(1, _p.y, ribbed && k % 2 === 1));
      }
      if (ri > 0) {
        for (let k = 0; k < M; k++) {
          const k1 = (k + 1) % M;
          this.tri(prev + k, prev + k1, prevStart + k1);
          this.tri(prev + k, prevStart + k1, prevStart + k);
        }
      }
      prev = prevStart;
    }
    _p.copy(path[last]).addScaledVector(T[last], capLen);
    const tip = this.vertex(_p, T[last], s.color(1, _p.y, false));
    for (let k = 0; k < M; k++) this.tri(prevStart + k, prevStart + ((k + 1) % M), tip);
  }

  blob(s: BlobSpec) {
    const poly = polyhedron(s.detail);
    const pts = poly.verts.map((v) => {
      const k = 1 + (s.rng() * 2 - 1) * s.jitter;
      const p = new THREE.Vector3(v.x * s.radii.x * k, v.y * s.radii.y * k, v.z * s.radii.z * k);
      if (s.floor !== undefined) p.y = Math.max(p.y, -s.floor * s.radii.y);
      return p.add(s.center);
    });
    const facet = s.facet ?? 0.35;
    const fn = new THREE.Vector3();
    const en = new THREE.Vector3();
    for (const f of poly.faces) {
      const [a, b, c] = f;
      fn.subVectors(pts[b], pts[a]).cross(_c.subVectors(pts[c], pts[a]));
      if (fn.lengthSq() < 1e-12) continue;
      fn.normalize();
      _a.copy(pts[a]).add(pts[b]).add(pts[c]).multiplyScalar(1 / 3).sub(s.center);
      if (fn.dot(_a) < 0) fn.negate();
      const ids: number[] = [];
      for (const v of f) {
        const d = poly.verts[v];
        if (s.crown) {
          const c = s.crown;
          en.subVectors(pts[v], c.center);
          en.set(en.x / (c.radii.x * c.radii.x), en.y / (c.radii.y * c.radii.y), en.z / (c.radii.z * c.radii.z)).normalize();
          // Blend in the blob's own normal so clumps keep a little volume.
          _p.set(d.x / s.radii.x, d.y / s.radii.y, d.z / s.radii.z).normalize();
          en.lerp(_p, 0.35).normalize();
        } else en.set(d.x / s.radii.x, d.y / s.radii.y, d.z / s.radii.z).normalize();
        _n.copy(en).lerp(fn, facet).normalize();
        ids.push(this.vertex(pts[v], _n, s.color(d, pts[v])));
      }
      this.tri(ids[0], ids[1], ids[2]);
    }
  }

  /** A three-sided spike from base to tip (grass blades, thorns): 3 triangles. */
  spike(base: THREE.Vector3, tip: THREE.Vector3, radius: number, phase: number, c0: RGB, c1: RGB) {
    const axis = _a.subVectors(tip, base).normalize().clone();
    const ref = Math.abs(axis.y) < 0.95 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const u = ref.clone().addScaledVector(axis, -ref.dot(axis)).normalize();
    const w = new THREE.Vector3().crossVectors(axis, u);
    const ids: number[] = [];
    for (let k = 0; k < 3; k++) {
      const th = phase + (k / 3) * Math.PI * 2;
      const dir = u.clone().multiplyScalar(Math.cos(th)).addScaledVector(w, Math.sin(th));
      _p.copy(base).addScaledVector(dir, radius);
      _n.copy(dir).multiplyScalar(0.6).addScaledVector(axis, 0.3).add(new THREE.Vector3(0, 0.6, 0)).normalize();
      ids.push(this.vertex(_p, _n, c0));
    }
    _n.copy(axis).add(new THREE.Vector3(0, 0.8, 0)).normalize();
    const t = this.vertex(tip, _n, c1);
    for (let k = 0; k < 3; k++) this.tri(ids[k], ids[(k + 1) % 3], t);
  }

  /** Geometry scaled so the plant's reference width/height become 1 (instances carry metres). */
  build(width = 1, height = 1) {
    const pos = new Float32Array(this.positions.length);
    const nor = new Float32Array(this.normals.length);
    for (let i = 0; i < pos.length; i += 3) {
      pos[i] = this.positions[i] / width;
      pos[i + 1] = this.positions[i + 1] / height;
      pos[i + 2] = this.positions[i + 2] / width;
      // Inverse-transpose of the scale keeps normals perpendicular to the squashed surface.
      _n.set(this.normals[i] * width, this.normals[i + 1] * height, this.normals[i + 2] * width).normalize();
      nor[i] = _n.x;
      nor[i + 1] = _n.y;
      nor[i + 2] = _n.z;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.colors), 3));
    const count = this.positions.length / 3;
    geo.setIndex(count > 65535 ? new THREE.BufferAttribute(new Uint32Array(this.indices), 1) : new THREE.BufferAttribute(new Uint16Array(this.indices), 1));
    return geo;
  }
}
