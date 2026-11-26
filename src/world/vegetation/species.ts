import * as THREE from 'three';
import { lerp, mulberry32, smoothstep } from '../../core/math.ts';
import { GeoBuilder, mixRGB, shade, srgb, type RGB } from './geometry.ts';

/** A plant model: LOD geometries normalised to unit width/height, plus its reference size. */
export interface PlantModel {
  lods: THREE.BufferGeometry[];
  /** Reference crown width and height in metres (the unit geometry's scale). */
  width: number;
  height: number;
  /** Linear species colour; per-instance tints are variations of it. */
  base: RGB;
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

interface Stem {
  path: THREE.Vector3[];
  radii: number[];
  trunk: boolean;
  top: number;
}

interface Extent {
  width: number;
  height: number;
}

/** Width (twice the largest horizontal reach from the axis) and height above ground of a builder. */
function extent(b: GeoBuilder): Extent {
  let r = 0, h = 0;
  const P = b.positions;
  for (let i = 0; i < P.length; i += 3) {
    r = Math.max(r, Math.abs(P[i]), Math.abs(P[i + 2]));
    h = Math.max(h, P[i + 1]);
  }
  return { width: 2 * r, height: h };
}

function pathAt(path: THREE.Vector3[], y: number) {
  for (let i = 1; i < path.length; i++) {
    if (path[i].y >= y) {
      const a = path[i - 1], b = path[i];
      return a.clone().lerp(b, (y - a.y) / Math.max(1e-4, b.y - a.y));
    }
  }
  return path[path.length - 1].clone();
}

function pick<T>(arr: T[], idx: number[]) {
  return idx.filter((i) => i < arr.length).map((i) => arr[i]);
}

function finish(builders: GeoBuilder[], base: RGB, ext?: Extent): PlantModel {
  const e = ext ?? extent(builders[0]);
  return { lods: builders.map((b) => b.build(e.width, e.height)), width: e.width, height: e.height, base };
}

function shuffled(n: number, rng: () => number) {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------- cardón

const CARDON_STEM = srgb(0.47, 0.53, 0.43);
const CARDON_BARK = srgb(0.55, 0.51, 0.44);
const CARDON_TIP = srgb(0.6, 0.6, 0.47);

/** Trunk plus arms that leave it low at ~45 degrees and turn up to run parallel to it (a candelabra). */
function cardonStems(seed: number, H: number, R: number, arms: number, bMin: number, bMax: number, tMin: number, tMax: number): Stem[] {
  const rng = mulberry32(seed);
  const leanX = (rng() - 0.5) * 0.5, leanZ = (rng() - 0.5) * 0.5;
  const top = H - R * 0.85;
  const ys = [-0.9, 0.2, 0.9, 1.8];
  for (let y = 3.2; y < top - 1.2; y += 2.2) ys.push(y);
  ys.push(top);
  const trunk = ys.map((y) => {
    const t = Math.max(0, y) / H;
    return V(leanX * t * t, y, leanZ * t * t);
  });
  const radii = ys.map((y) => (y < 0.3 ? R * 1.2 : y < 1.0 ? R * 1.08 : R * lerp(1.0, 0.88, y / H)));
  const stems: Stem[] = [{ path: trunk, radii, trunk: true, top }];
  const order = shuffled(arms, rng);
  const az0 = rng() * Math.PI * 2;
  for (let a = 0; a < arms; a++) {
    const outer = a % 2 === 1 && arms > 3;
    const az = az0 + (a / arms) * Math.PI * 2 + (rng() - 0.5) * (Math.PI / arms) * 0.8;
    const hb = lerp(bMin, bMax, (order[a] + rng() * 0.7) / arms);
    const ra = R * lerp(0.56, 0.7, rng());
    const gap = lerp(0.04, 0.22, rng()) + (outer ? lerp(0.2, 0.45, rng()) : 0);
    const reach = R + ra + gap;
    const rise = reach * lerp(1.7, 2.4, rng());
    const aTop = Math.max(hb + rise + 1.4, H * lerp(tMin, tMax, rng())) - ra * 0.8;
    const dir = V(Math.cos(az), 0, Math.sin(az));
    const o = pathAt(trunk, hb);
    const p = (d: number, up: number) => o.clone().addScaledVector(dir, d).add(V(0, up, 0));
    const path = [p(0, 0), p(R * 0.75, R * 1.0), p(reach * 0.8, rise * 0.45), p(reach * 0.98, rise * 0.78), p(reach, rise)];
    const yStart = hb + rise;
    const segs = Math.max(1, Math.round((aTop - yStart) / 2.4));
    const drift = (rng() - 0.5) * 0.35;
    for (let s = 1; s <= segs; s++) {
      const t = s / segs;
      path.push(p(reach + drift * t * t, rise + (aTop - yStart) * t));
    }
    const ar = path.map((_, i) => ra * (i === 0 ? 0.95 : i === 2 ? 0.94 : i === path.length - 1 ? 0.95 : 1));
    stems.push({ path, radii: ar, trunk: false, top: aTop });
  }
  return stems;
}

function cardonColor(stem: Stem) {
  return (t: number, y: number, groove: boolean): RGB => {
    let c: RGB = CARDON_STEM;
    if (stem.trunk) c = mixRGB(CARDON_BARK, CARDON_STEM, smoothstep(0.2, 2.4, y));
    else c = shade(c, lerp(0.82, 1, smoothstep(0, 0.3, t)));
    c = mixRGB(c, CARDON_TIP, smoothstep(stem.top - 0.7, stem.top + 0.4, y) * 0.75);
    c = shade(c, lerp(0.78, 1, smoothstep(-0.2, 3, y)));
    return groove ? shade(c, 0.6) : c;
  };
}

function cardonLod(stems: Stem[], lod: 0 | 1 | 2) {
  const b = new GeoBuilder(CARDON_STEM);
  const arms = stems.filter((s) => !s.trunk).sort((a, c) => c.top - a.top);
  const used = lod === 2 ? [stems[0], ...arms.slice(0, 3)] : stems;
  for (const s of used) {
    const color = cardonColor(s);
    const n = s.path.length;
    if (lod === 0) {
      const ids = s.trunk ? Array.from({ length: n }, (_, i) => i) : [0, 1, 2, 4, ...Array.from({ length: n - 5 }, (_, i) => i + 5)];
      b.tube({ path: pick(s.path, ids), radii: pick(s.radii, ids), sides: 0, ribs: s.trunk ? 10 : 7, ribDepth: 0.2, facet: 0.65, cap: 'dome', color });
    } else if (lod === 1) {
      const ids = s.trunk ? [0, 2, Math.floor((n + 2) / 2), n - 1] : [0, 2, 4, n - 1];
      const uniq = [...new Set(ids)].sort((a, c) => a - c);
      b.tube({ path: pick(s.path, uniq), radii: pick(s.radii, uniq), sides: s.trunk ? 6 : 4, phase: s.trunk ? 0 : Math.PI / 4, cap: 'point', capLength: 0.9, color });
    } else {
      const ids = [0, n - 1];
      b.tube({
        path: pick(s.path, ids),
        // Thickened: at 600 m+ real stems are well under a pixel wide.
        radii: pick(s.radii, ids).map((r) => r * 1.5),
        sides: s.trunk ? 4 : 3,
        phase: s.trunk ? Math.PI / 4 : 0,
        cap: s.trunk ? 'point' : 'none',
        capLength: 1.2,
        color,
      });
    }
  }
  return b;
}

export interface CardonSpec {
  seed: number;
  height: number;
  radius: number;
  arms: number;
  branch: [number, number];
  tops: [number, number];
}

export function cardonModel(spec: CardonSpec): PlantModel {
  const stems = cardonStems(spec.seed, spec.height, spec.radius, spec.arms, spec.branch[0], spec.branch[1], spec.tops[0], spec.tops[1]);
  return finish([cardonLod(stems, 0), cardonLod(stems, 1), cardonLod(stems, 2)], CARDON_STEM);
}

// ---------------------------------------------------------------- pitaya dulce (organ pipe)

const PITAYA = srgb(0.34, 0.43, 0.3);
const PITAYA_TIP = srgb(0.52, 0.48, 0.36);

export function pitayaModel(seed: number): PlantModel {
  const rng = mulberry32(seed);
  const stems: Stem[] = [];
  const n = 11;
  for (let k = 0; k < n; k++) {
    const az = (k / n) * Math.PI * 2 + (rng() - 0.5) * 0.5;
    const r0 = 0.05 + 0.18 * rng();
    const spread = 0.3 + 0.8 * rng();
    const top = lerp(2.3, 4.6, rng());
    const ys = [-0.4, 0.5, 1.6, top];
    const path = ys.map((y) => {
      const off = r0 + spread * (1 - Math.exp(-Math.max(0, y + 0.3) / 0.8));
      return V(Math.cos(az) * off, y, Math.sin(az) * off);
    });
    const r = lerp(0.085, 0.115, rng());
    stems.push({ path, radii: ys.map((y) => (y < 0.4 ? r * 0.85 : r)), trunk: false, top });
  }
  stems.sort((a, b) => b.top - a.top);
  const color = (stem: Stem) => (_t: number, y: number, groove: boolean): RGB => {
    let c = shade(PITAYA, lerp(0.72, 1, smoothstep(0, 1.6, y)));
    c = mixRGB(c, PITAYA_TIP, smoothstep(stem.top - 0.45, stem.top + 0.15, y) * 0.8);
    return groove ? shade(c, 0.72) : c;
  };
  const near = new GeoBuilder(PITAYA), mid = new GeoBuilder(PITAYA), far = new GeoBuilder(PITAYA);
  stems.forEach((s, i) => {
    near.tube({ path: s.path, radii: s.radii, sides: 5, phase: i, cap: 'dome', color: color(s) });
    if (i < 8) mid.tube({ path: pick(s.path, [0, 2, 3]), radii: pick(s.radii, [0, 2, 3]), sides: 3, phase: i, cap: 'point', capLength: 1, color: color(s) });
    if (i < 4) far.tube({ path: pick(s.path, [0, 3]), radii: pick(s.radii, [0, 3]).map((r) => r * 1.6), sides: 3, phase: i, cap: 'none', color: color(s) });
  });
  return finish([near, mid, far], PITAYA);
}

// ---------------------------------------------------------------- pitaya agria (sprawling)

const AGRIA = srgb(0.47, 0.52, 0.4);
const AGRIA_TIP = srgb(0.58, 0.47, 0.38);

export function agriaModel(seed: number): PlantModel {
  // Stems arch up from the centre, flop over and touch down, their tips turning up again.
  const rng = mulberry32(seed);
  const b = new GeoBuilder(AGRIA);
  const n = 10;
  for (let k = 0; k < n; k++) {
    const az = (k / n) * Math.PI * 2 + (rng() - 0.5) * 0.6;
    const L = lerp(0.8, 1.8, rng());
    const lift = lerp(0.45, 1.0, rng());
    const side = (rng() - 0.5) * 0.7;
    const up = lerp(0.1, 0.35, rng());
    const dx = Math.cos(az), dz = Math.sin(az);
    const path = [0, 0.22, 0.48, 0.74, 1].map((f) => {
      const y = -0.1 + lift * Math.sin(Math.PI * Math.min(1, f * 1.05)) * (1 - 0.3 * f) + up * smoothstep(0.7, 1, f) + 0.08;
      const w = side * Math.sin(Math.PI * f);
      return V(dx * f * L - dz * w, y, dz * f * L + dx * w);
    });
    const r = lerp(0.07, 0.09, rng());
    b.tube({
      path,
      radii: path.map(() => r),
      sides: 4,
      phase: rng(),
      cap: 'dome',
      color: (t, y) => mixRGB(shade(AGRIA, lerp(0.72, 1, smoothstep(0, 0.7, y))), AGRIA_TIP, smoothstep(0.85, 1, t) * 0.7),
    });
  }
  return finish([b], AGRIA);
}

// ---------------------------------------------------------------- cholla

const CHOLLA = srgb(0.8, 0.76, 0.57);
const CHOLLA_OLD = srgb(0.5, 0.46, 0.37);
const CHOLLA_TRUNK = srgb(0.3, 0.27, 0.23);

export function chollaModel(seed: number): PlantModel {
  const rng = mulberry32(seed);
  const b = new GeoBuilder(CHOLLA);
  const trunkTop = 0.6;
  b.tube({ path: [V(0, -0.2, 0), V(0.02, 0.3, 0), V(0, trunkTop, 0.02)], radii: [0.085, 0.075, 0.07], sides: 4, cap: 'none', color: () => CHOLLA_TRUNK });
  const up = V(0, 1, 0);
  const grow = (start: THREE.Vector3, dir: THREE.Vector3, depth: number) => {
    const len = lerp(0.22, 0.34, rng());
    const end = start.clone().addScaledVector(dir, len);
    const age = depth / 2;
    b.tube({
      path: [start, end],
      radii: [0.055, 0.06],
      sides: 4,
      phase: rng() * 2,
      cap: 'point',
      capLength: 0.9,
      color: (_t, y) => shade(mixRGB(CHOLLA_OLD, CHOLLA, 0.35 + 0.65 * age), lerp(0.8, 1, smoothstep(0.3, 1.4, y))),
    });
    if (depth >= 2) return;
    const kids = depth === 0 ? 2 : rng() < 0.55 ? 2 : 1;
    for (let k = 0; k < kids; k++) {
      const axis = V(rng() - 0.5, 0, rng() - 0.5).normalize();
      const nd = dir.clone().applyAxisAngle(axis, lerp(0.35, 0.8, rng())).lerp(up, 0.25).normalize();
      grow(end, nd, depth + 1);
    }
  };
  for (let k = 0; k < 4; k++) {
    const az = (k / 4) * Math.PI * 2 + rng();
    const dir = V(Math.cos(az) * 0.7, 0.75, Math.sin(az) * 0.7).normalize();
    grow(V(0, trunkTop - 0.05 - k * 0.08, 0), dir, 0);
  }
  return finish([b], CHOLLA);
}

// ---------------------------------------------------------------- clump crowns (trees and bushes)

interface CrownSpec {
  center: THREE.Vector3;
  radii: THREE.Vector3;
  clumps: number;
  clumpR: [number, number];
  /** Clumps sit in a shell from this fraction of the crown radius outward. */
  shell: number;
  /** How far below the crown centre the lowest clumps reach (fraction of the y-radius). */
  floor: number;
  jitter: number;
  detail: 0 | 1;
  leaf: RGB;
  leafDark: RGB;
  /** Random per-clump brightness spread. */
  mottle: number;
}

interface Clump {
  c: THREE.Vector3;
  r: number;
}

function crownClumps(rng: () => number, s: CrownSpec) {
  const out: Clump[] = [];
  const golden = 2.39996;
  const a0 = rng() * 6.28;
  for (let k = 0; k < s.clumps; k++) {
    // Fibonacci-ish directions over the upper part of the ellipsoid.
    const yk = 1 - ((k + 0.5) / s.clumps) * (1 + s.floor);
    const rr = Math.sqrt(Math.max(0, 1 - yk * yk));
    const az = a0 + k * golden + (rng() - 0.5) * 0.4;
    const f = lerp(s.shell, 1, rng());
    const r = lerp(s.clumpR[0], s.clumpR[1], rng());
    out.push({ c: V(Math.cos(az) * rr * f * s.radii.x, yk * f * s.radii.y, Math.sin(az) * rr * f * s.radii.z).add(s.center), r });
  }
  return out;
}

function addCrown(b: GeoBuilder, rng: () => number, s: CrownSpec, clumps: Clump[], squash = 0.8) {
  for (const cl of clumps) {
    const m = 1 + (rng() * 2 - 1) * s.mottle;
    const hy = smoothstep(-s.radii.y, s.radii.y, cl.c.y - s.center.y);
    b.blob({
      center: cl.c,
      radii: V(cl.r, cl.r * squash, cl.r),
      detail: s.detail,
      jitter: s.jitter,
      rng,
      facet: 0.25,
      crown: { center: s.center, radii: s.radii },
      color: (dir) => shade(mixRGB(s.leafDark, s.leaf, smoothstep(-0.9, 0.9, dir.y) * 0.55 + hy * 0.45), m),
    });
  }
}

// ---------------------------------------------------------------- trees

interface TreeSpec {
  seed: number;
  height: number;
  width: number;
  trunks: number;
  trunkR: number;
  fork: [number, number];
  lean: [number, number];
  crownY: number;
  crownH: number;
  clumps: number;
  clumpR: [number, number];
  midClumps: number;
  jitter: number;
  bark: RGB;
  leaf: RGB;
  leafDark: RGB;
  crooked: number;
  mottle: number;
}

function treeModel(s: TreeSpec): PlantModel {
  const rng = mulberry32(s.seed);
  const H = s.height, W = s.width;
  const crown: CrownSpec = {
    center: V(0, H * s.crownY, 0),
    radii: V(W / 2, H * s.crownH, W / 2),
    clumps: s.clumps,
    clumpR: s.clumpR,
    shell: 0.5,
    floor: 0.35,
    jitter: s.jitter,
    detail: 1,
    leaf: s.leaf,
    leafDark: s.leafDark,
    mottle: s.mottle,
  };
  const clumps = crownClumps(rng, crown);
  const near = new GeoBuilder(s.leaf), mid = new GeoBuilder(s.leaf);
  const barkColor = (_t: number, y: number): RGB => shade(s.bark, lerp(0.68, 1, smoothstep(0, H * 0.5, y)));
  const forks: THREE.Vector3[] = [];
  const az0 = rng() * 6.28;
  for (let t = 0; t < s.trunks; t++) {
    const az = az0 + (t / s.trunks) * Math.PI * 2 + (rng() - 0.5) * 0.8;
    const lean = lerp(s.lean[0], s.lean[1], rng());
    const fy = H * lerp(s.fork[0], s.fork[1], rng());
    const d = V(Math.cos(az), 0, Math.sin(az));
    const reach = Math.tan(lean) * fy;
    const kink = (rng() - 0.5) * s.crooked;
    const path = [
      V(d.x * 0.03, -0.35, d.z * 0.03),
      V(d.x * (0.05 + reach * 0.4) - d.z * kink, fy * 0.45, d.z * (0.05 + reach * 0.4) + d.x * kink),
      V(d.x * reach, fy, d.z * reach),
    ];
    const radii = [s.trunkR * 1.15, s.trunkR * 0.9, s.trunkR * 0.7];
    forks.push(path[2]);
    near.tube({ path, radii, sides: 5, cap: 'point', capLength: 1, color: barkColor });
    mid.tube({ path: [path[0], path[2]], radii: [radii[0], radii[2]], sides: 3, cap: 'none', color: barkColor });
  }
  // Limbs from each fork to the clumps nearest it (every second clump keeps the count down).
  for (let k = 0; k < clumps.length; k += 2) {
    const cl = clumps[k];
    let best = forks[0], bd = Infinity;
    for (const f of forks) {
      const dd = Math.hypot(f.x - cl.c.x, f.z - cl.c.z);
      if (dd < bd) {
        bd = dd;
        best = f;
      }
    }
    const end = cl.c.clone();
    const kink = (rng() - 0.5) * s.crooked;
    const midP = best.clone().lerp(end, 0.5).add(V(kink, 0.1, -kink));
    const r0 = s.trunkR * 0.45;
    near.tube({ path: [best.clone(), midP, end], radii: [r0, r0 * 0.6, r0 * 0.3], sides: 3, phase: rng() * 2, cap: 'none', color: barkColor });
  }
  addCrown(near, rng, crown, clumps);
  // Mid LOD: fewer, larger clumps with the same envelope.
  const midCrown: CrownSpec = { ...crown, clumps: s.midClumps, clumpR: [s.clumpR[0] * 1.45, s.clumpR[1] * 1.45], shell: 0.35, detail: 0 };
  addCrown(mid, rng, midCrown, crownClumps(rng, midCrown), 0.75);
  return finish([near, mid], s.leaf);
}

export function paloVerdeModel(seed: number) {
  // Foothill palo verde / palo brea: green multi-stem trunk, airy yellow-green twig crown.
  return treeModel({
    seed,
    height: 4.6,
    width: 5.6,
    trunks: 3,
    trunkR: 0.1,
    fork: [0.22, 0.36],
    lean: [0.3, 0.6],
    crownY: 0.64,
    crownH: 0.34,
    clumps: 12,
    clumpR: [0.65, 1.0],
    midClumps: 7,
    jitter: 0.28,
    bark: srgb(0.52, 0.6, 0.33),
    leaf: srgb(0.6, 0.66, 0.36),
    leafDark: srgb(0.42, 0.49, 0.26),
    crooked: 0.2,
    mottle: 0.12,
  });
}

export function mesquiteModel(seed: number) {
  return treeModel({
    seed,
    height: 5.4,
    width: 7.4,
    trunks: 3,
    trunkR: 0.16,
    fork: [0.25, 0.4],
    lean: [0.45, 0.8],
    crownY: 0.64,
    crownH: 0.32,
    clumps: 17,
    clumpR: [0.75, 1.15],
    midClumps: 8,
    jitter: 0.25,
    bark: srgb(0.27, 0.22, 0.18),
    leaf: srgb(0.34, 0.43, 0.24),
    leafDark: srgb(0.2, 0.27, 0.14),
    crooked: 0.6,
    mottle: 0.1,
  });
}

const TOROTE_TONE = srgb(0.5, 0.5, 0.39);

export function toroteModel(seed: number): PlantModel {
  // Elephant tree: a fat, fast-tapering pale trunk, a few thick limbs and a small, sparse crown.
  const rng = mulberry32(seed);
  const bark = srgb(0.68, 0.63, 0.55);
  const barkDark = srgb(0.5, 0.43, 0.37);
  const leaf = srgb(0.4, 0.48, 0.28);
  const leafDark = srgb(0.27, 0.34, 0.19);
  const near = new GeoBuilder(TOROTE_TONE), mid = new GeoBuilder(TOROTE_TONE);
  const barkColor = (_t: number, y: number): RGB => shade(mixRGB(barkDark, bark, smoothstep(0, 1.2, y)), lerp(0.8, 1, smoothstep(0, 2, y)));
  const trunk = [V(0, -0.4, 0), V(0.02, 0.3, 0.01), V(0.06, 0.9, 0.03), V(0.1, 1.3, 0.05)];
  near.tube({ path: trunk, radii: [0.44, 0.37, 0.25, 0.17], sides: 7, cap: 'none', color: barkColor });
  mid.tube({ path: [trunk[0], trunk[3]], radii: [0.44, 0.17], sides: 4, cap: 'none', color: barkColor });
  const limbs = 5;
  for (let k = 0; k < limbs; k++) {
    const az = (k / limbs) * Math.PI * 2 + (rng() - 0.5) * 0.8;
    const out = lerp(0.9, 1.6, rng());
    const top = lerp(2.4, 3.4, rng());
    const d = V(Math.cos(az), 0, Math.sin(az));
    const start = trunk[3].clone().add(V(0, -0.1 * rng(), 0));
    const midP = start.clone().addScaledVector(d, out * 0.5).add(V(0, (top - start.y) * 0.35, 0));
    const end = start.clone().addScaledVector(d, out).add(V(0, top - start.y, 0));
    near.tube({ path: [start, midP, end], radii: [0.14, 0.09, 0.045], sides: 4, cap: 'point', color: barkColor });
    mid.tube({ path: [start, end], radii: [0.14, 0.06], sides: 3, cap: 'none', color: barkColor });
    const crown: CrownSpec = {
      center: end.clone().add(V(0, 0.15, 0)),
      radii: V(0.75, 0.45, 0.75),
      clumps: 3,
      clumpR: [0.32, 0.45],
      shell: 0.3,
      floor: 0.3,
      jitter: 0.3,
      detail: 1,
      leaf,
      leafDark,
      mottle: 0.1,
    };
    addCrown(near, rng, crown, crownClumps(rng, crown));
    const midCrown: CrownSpec = { ...crown, clumps: 1, clumpR: [0.6, 0.7], shell: 0 };
    addCrown(mid, rng, midCrown, crownClumps(rng, midCrown), 0.6);
  }
  return finish([near, mid], TOROTE_TONE);
}

// ---------------------------------------------------------------- palo adán

const PALO_ADAN = srgb(0.5, 0.48, 0.42);

export function paloAdanModel(seed: number): PlantModel {
  const rng = mulberry32(seed);
  const b = new GeoBuilder(PALO_ADAN);
  const stem = srgb(0.5, 0.47, 0.41);
  const leafy = srgb(0.44, 0.5, 0.3);
  const flower = srgb(0.8, 0.26, 0.17);
  const n = 13;
  for (let k = 0; k < n; k++) {
    const az = rng() * Math.PI * 2;
    const lean = lerp(0.1, 0.6, rng());
    const L = lerp(2.0, 3.6, rng());
    const d = V(Math.cos(az), 0, Math.sin(az));
    const bend = lerp(0.05, 0.25, rng());
    const path = [0, 0.4, 1].map((f) => {
      const a = lean + bend * f;
      return V(d.x * Math.sin(a) * L * f + d.x * 0.05, Math.cos(a) * L * f - 0.15, d.z * Math.sin(a) * L * f + d.z * 0.05);
    });
    const blooms = rng() < 0.4;
    b.tube({
      path,
      radii: [0.045, 0.032, 0.016],
      sides: 3,
      phase: rng() * 2,
      cap: 'point',
      capLength: 2.5,
      color: (t) => mixRGB(stem, leafy, smoothstep(0.3, 0.9, t) * 0.8),
    });
    if (blooms) {
      const tip = path[2];
      b.blob({ center: tip.clone().add(V(0, 0.08, 0)), radii: V(0.07, 0.12, 0.07), detail: 0, jitter: 0.2, rng, facet: 0.3, color: () => flower });
    }
  }
  return finish([b], PALO_ADAN);
}

// ---------------------------------------------------------------- bushes

interface BushSpec {
  seed: number;
  width: number;
  height: number;
  clumps: number;
  clumpR: [number, number];
  shell: number;
  jitter: number;
  detail: 0 | 1;
  leaf: RGB;
  leafDark: RGB;
  mottle: number;
  twigs: number;
  twig: RGB;
  squash?: number;
  flowers?: { color: RGB; count: number };
}

function bushModel(s: BushSpec): PlantModel {
  const rng = mulberry32(s.seed);
  const b = new GeoBuilder(s.leaf);
  const W = s.width, H = s.height;
  const crown: CrownSpec = {
    center: V(0, H * 0.4, 0),
    radii: V(W / 2, H * 0.6, W / 2),
    clumps: s.clumps,
    clumpR: s.clumpR,
    shell: s.shell,
    floor: 0.25,
    jitter: s.jitter,
    detail: s.detail,
    leaf: s.leaf,
    leafDark: s.leafDark,
    mottle: s.mottle,
  };
  const clumps = crownClumps(rng, crown);
  for (let k = 0; k < s.twigs; k++) {
    const cl = clumps[(k * 3) % clumps.length];
    const root = V((rng() - 0.5) * W * 0.15, -0.1, (rng() - 0.5) * W * 0.15);
    const end = cl.c.clone().lerp(V(0, cl.c.y, 0), -0.15);
    b.tube({ path: [root, root.clone().lerp(end, 0.5).add(V(0, 0.05, 0)), end], radii: [W * 0.025, W * 0.018, W * 0.01], sides: 3, phase: rng() * 2, cap: 'none', color: () => s.twig });
  }
  addCrown(b, rng, crown, clumps, s.squash ?? 0.8);
  if (s.flowers) {
    const fc = s.flowers.color;
    for (let k = 0; k < s.flowers.count; k++) {
      const cl = clumps[Math.floor(rng() * clumps.length)];
      const dir = V(rng() - 0.5, 0.8, rng() - 0.5).normalize();
      const base = cl.c.clone().addScaledVector(dir, cl.r * 0.7);
      const tip = base.clone().add(V(0, H * 0.42, 0)).addScaledVector(dir, H * 0.12);
      b.spike(base, tip, W * 0.008, 0, s.leafDark, s.leafDark);
      b.blob({ center: tip, radii: V(W * 0.045, W * 0.025, W * 0.045), detail: 0, jitter: 0.1, rng, facet: 0.2, color: () => fc });
    }
  }
  return finish([b], s.leaf);
}

export function lomboyModel(seed: number) {
  // Lomboy (Jatropha cinerea): a dense, rounded olive bush, the commonest shrub on the hills.
  return bushModel({
    seed,
    width: 2.0,
    height: 1.5,
    clumps: 9,
    clumpR: [0.34, 0.46],
    shell: 0.3,
    jitter: 0.3,
    detail: 1,
    leaf: srgb(0.47, 0.51, 0.34),
    leafDark: srgb(0.27, 0.3, 0.2),
    mottle: 0.12,
    twigs: 2,
    twig: srgb(0.42, 0.38, 0.33),
  });
}

export function twigBushModel(seed: number) {
  // Matacora / leafless thornscrub: grey stems fanning out with a few small grey-olive leaf clusters.
  const rng = mulberry32(seed);
  const tone = srgb(0.52, 0.52, 0.44);
  const b = new GeoBuilder(tone);
  const stem = srgb(0.5, 0.48, 0.43), stemDark = srgb(0.36, 0.34, 0.31);
  const leaf = srgb(0.5, 0.53, 0.38), leafDark = srgb(0.34, 0.36, 0.27);
  const tips: THREE.Vector3[] = [];
  const n = 10;
  for (let k = 0; k < n; k++) {
    const az = (k / n) * Math.PI * 2 + (rng() - 0.5) * 0.7;
    const lean = lerp(0.25, 0.85, rng());
    const L = lerp(0.9, 1.6, rng());
    const d = V(Math.cos(az), 0, Math.sin(az));
    const bend = lerp(-0.15, 0.3, rng());
    const path = [0, 0.5, 1].map((f) => {
      const a = lean + bend * f;
      return V(d.x * Math.sin(a) * L * f, Math.cos(a) * L * f - 0.1, d.z * Math.sin(a) * L * f);
    });
    tips.push(path[2]);
    b.tube({ path, radii: [0.035, 0.024, 0.01], sides: 3, phase: rng() * 2, cap: 'none', color: (t) => mixRGB(stemDark, stem, t) });
    // A side twig off each stem.
    const mid = path[1];
    const side = mid.clone().add(V((rng() - 0.5) * 0.5, lerp(0.2, 0.45, rng()), (rng() - 0.5) * 0.5));
    b.tube({ path: [mid, side], radii: [0.018, 0.008], sides: 3, phase: rng() * 2, cap: 'none', color: () => stem });
  }
  const center = V(0, 0.75, 0), radii = V(0.9, 0.75, 0.9);
  for (let k = 0; k < 6; k++) {
    const t = tips[(k * 2) % n].clone().multiplyScalar(lerp(0.75, 0.95, rng()));
    const r = lerp(0.16, 0.24, rng());
    const m = 1 + (rng() * 2 - 1) * 0.12;
    b.blob({ center: t, radii: V(r, r * 0.8, r), detail: 1, jitter: 0.3, rng, facet: 0.3, crown: { center, radii }, color: (dir) => shade(mixRGB(leafDark, leaf, dir.y * 0.5 + 0.5), m) });
  }
  return finish([b], tone);
}

export function brittlebushModel(seed: number) {
  // Brittlebush: a silvery grey-green dome with yellow daisies held up on long stalks.
  return bushModel({
    seed,
    width: 1.1,
    height: 0.75,
    clumps: 9,
    clumpR: [0.17, 0.23],
    shell: 0.45,
    jitter: 0.35,
    detail: 1,
    leaf: srgb(0.62, 0.67, 0.5),
    leafDark: srgb(0.34, 0.38, 0.28),
    mottle: 0.06,
    twigs: 0,
    twig: srgb(0.5, 0.47, 0.4),
    squash: 0.85,
    flowers: { color: srgb(0.97, 0.79, 0.15), count: 10 },
  });
}

export function creosoteModel(seed: number): PlantModel {
  const rng = mulberry32(seed);
  const leaf = srgb(0.36, 0.41, 0.24);
  const b = new GeoBuilder(leaf);
  const stem = srgb(0.42, 0.39, 0.35);
  const dark = srgb(0.24, 0.28, 0.16);
  const tops: THREE.Vector3[] = [];
  const n = 7;
  for (let k = 0; k < n; k++) {
    const az = (k / n) * Math.PI * 2 + rng();
    const lean = lerp(0.15, 0.55, rng());
    const L = lerp(1.0, 1.45, rng());
    const d = V(Math.cos(az), 0, Math.sin(az));
    const top = V(d.x * Math.sin(lean) * L, Math.cos(lean) * L, d.z * Math.sin(lean) * L);
    tops.push(top);
    b.tube({ path: [V(d.x * 0.03, -0.1, d.z * 0.03), top.clone().multiplyScalar(0.5), top], radii: [0.03, 0.022, 0.012], sides: 3, cap: 'none', color: () => stem });
  }
  const center = V(0, 0.85, 0), radii = V(0.8, 0.6, 0.8);
  for (let k = 0; k < 9; k++) {
    const t = tops[k % n].clone().multiplyScalar(lerp(0.55, 1.0, rng()));
    const r = lerp(0.17, 0.26, rng());
    const m = 1 + (rng() * 2 - 1) * 0.12;
    b.blob({ center: t, radii: V(r, r * 0.75, r), detail: 1, jitter: 0.3, rng, facet: 0.3, crown: { center, radii }, color: (dir) => shade(mixRGB(dark, leaf, dir.y * 0.5 + 0.5), m) });
  }
  return finish([b], leaf);
}

export function bursageModel(seed: number) {
  // Small grey-green hummocks (white bursage, saltbush) that dot the ground between larger shrubs.
  return bushModel({
    seed,
    width: 0.8,
    height: 0.5,
    clumps: 6,
    clumpR: [0.14, 0.2],
    shell: 0.5,
    jitter: 0.4,
    detail: 1,
    leaf: srgb(0.56, 0.58, 0.43),
    leafDark: srgb(0.31, 0.32, 0.25),
    mottle: 0.14,
    twigs: 4,
    twig: srgb(0.45, 0.42, 0.36),
    squash: 0.8,
  });
}

export function grassModel(seed: number): PlantModel {
  const rng = mulberry32(seed);
  const grass = srgb(0.78, 0.71, 0.52);
  const b = new GeoBuilder(grass);
  const base = srgb(0.52, 0.47, 0.34), tip = srgb(0.9, 0.84, 0.64);
  const n = 7;
  for (let k = 0; k < n; k++) {
    const az = rng() * Math.PI * 2;
    const lean = lerp(0.12, 0.75, rng());
    const L = lerp(0.28, 0.46, rng());
    const d = V(Math.cos(az), 0, Math.sin(az));
    const root = V((rng() - 0.5) * 0.08, -0.03, (rng() - 0.5) * 0.08);
    const tipP = root.clone().add(V(d.x * Math.sin(lean) * L, Math.cos(lean) * L, d.z * Math.sin(lean) * L));
    b.spike(root, tipP, 0.016, rng() * 2, base, tip);
  }
  return finish([b], grass);
}

// ---------------------------------------------------------------- shared far LODs

/** Shared far LOD for every shrub: a soft six-sided mound, coloured entirely by the instance tint. */
export function shrubFarGeometry() {
  const b = new GeoBuilder([1, 1, 1]);
  const ring: number[] = [];
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    const n = V(Math.cos(a), 0.6, Math.sin(a)).normalize();
    ring.push(b.vertex(V(Math.cos(a) * 0.5, -0.05, Math.sin(a) * 0.5), n, [0.62, 0.62, 0.62]));
  }
  const apex = b.vertex(V(0, 0.95, 0), V(0, 1, 0), [1.02, 1.02, 1.02]);
  for (let k = 0; k < 6; k++) b.tri(ring[k], ring[(k + 1) % 6], apex);
  return b.build(1, 1);
}

/** Shared far LOD for trees: a squat double diamond crown; the instance tint is the canopy colour. */
export function treeFarGeometry(seed: number) {
  const rng = mulberry32(seed);
  const b = new GeoBuilder([1, 1, 1]);
  const color = (dir: THREE.Vector3): RGB => {
    const s = lerp(0.62, 1.02, dir.y * 0.5 + 0.5);
    return [s, s, s];
  };
  b.blob({ center: V(0, 0.6, 0), radii: V(0.5, 0.34, 0.5), detail: 0, jitter: 0.05, rng, facet: 0.15, color });
  b.blob({ center: V(0.12, 0.72, -0.08), radii: V(0.33, 0.25, 0.36), detail: 0, jitter: 0.05, rng, facet: 0.15, color });
  return b.build(1, 1);
}

/** Shared mid LOD for trees: a few crown clumps on a thin trunk; the instance tint is the canopy colour. */
export function treeMidGeometry(seed: number) {
  const rng = mulberry32(seed);
  const b = new GeoBuilder([1, 1, 1]);
  b.tube({ path: [V(0, -0.1, 0), V(0.02, 0.5, 0)], radii: [0.04, 0.025], sides: 3, cap: 'none', color: () => [0.45, 0.4, 0.34] });
  const crown: CrownSpec = {
    center: V(0, 0.64, 0),
    radii: V(0.5, 0.33, 0.5),
    clumps: 4,
    clumpR: [0.24, 0.3],
    shell: 0.45,
    floor: 0.4,
    jitter: 0.2,
    detail: 1,
    leaf: [1.02, 1.02, 1.02],
    leafDark: [0.6, 0.6, 0.6],
    mottle: 0.08,
  };
  addCrown(b, rng, crown, crownClumps(rng, crown), 0.8);
  return b.build(1, 1);
}

/** Shared mid LOD for shrubs: three clumps in a mound; the instance tint is the foliage colour. */
export function bushMidGeometry(seed: number) {
  const rng = mulberry32(seed);
  const b = new GeoBuilder([1, 1, 1]);
  const crown: CrownSpec = {
    center: V(0, 0.42, 0),
    radii: V(0.5, 0.62, 0.5),
    clumps: 2,
    clumpR: [0.33, 0.38],
    shell: 0.55,
    floor: 0.3,
    jitter: 0.35,
    detail: 1,
    leaf: [1.05, 1.05, 1.05],
    leafDark: [0.5, 0.5, 0.5],
    mottle: 0.1,
  };
  addCrown(b, rng, crown, crownClumps(rng, crown), 0.85);
  return b.build(1, 1);
}

/**
 * Camera-facing card for distant plants (the shader turns it to the camera and keeps it at least a
 * pixel or so wide). `taper` narrows the top for cactus strokes; `lift` raises the bottom for bush dots.
 */
export function cardGeometry(taper: number, lift: number, lo = 0.72, hi = 1.02) {
  const b = new GeoBuilder([1, 1, 1]);
  const n = V(0, 0, 1);
  const a = b.vertex(V(-0.5, lift, 0), n, [lo, lo, lo]);
  const c = b.vertex(V(0.5, lift, 0), n, [lo, lo, lo]);
  const d = b.vertex(V(0.5 * taper, 1, 0), n, [hi, hi, hi]);
  const e = b.vertex(V(-0.5 * taper, 1, 0), n, [hi, hi, hi]);
  b.tri(a, c, d);
  b.tri(a, d, e);
  return b.build(1, 1);
}
