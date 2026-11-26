import * as THREE from 'three';
import { MeshBuilder } from './builder.ts';
import type { Site } from './site.ts';
import { rr } from './site.ts';

const col = (h: number) => new THREE.Color(h);
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/** Fan palm (Washingtonia): skinny trunk, shaggy dead-frond skirt, round crown of jagged fans. */
function fanPalmGeometry() {
  const b = new MeshBuilder(false, [0, 0], 1024);
  trunk(b, 6, 4, 0.28, 0.17, [0x8b7b68, 0x9a8a74, 0x8f7f6b, 0x7d6e5c]);
  // Crown parts use uv.y = 1 and metres above the trunk top (y = 1).
  b.pu = 0;
  b.pv = 1;
  skirt(b);
  const n = 18;
  for (let k = 0; k < n; k++) {
    const th = k * GOLDEN + 0.3;
    const tier = k / n;
    const el = tier < 0.28 ? rrDet(k, 0.85, 1.25) : tier < 0.68 ? rrDet(k, 0.05, 0.5) : rrDet(k, -0.75, -0.25);
    const green = tier < 0.68 ? [0x5d8e3b, 0x6c9a45, 0x4f7f35, 0x77a24f][k % 4] : [0x8f9a4c, 0xa59457, 0x96a050][k % 3];
    b.color(col(green));
    fanLeaf(b, th, el, rrDet(k + 7, 0.75, 1.0), rrDet(k + 3, 0.95, 1.2));
  }
  return b.build(false).geometry;
}

/** Hanging skirt of dead fronds with a ragged hem. */
function skirt(b: MeshBuilder) {
  const sides = 8;
  const top = 1.12, r0 = 0.55, r1 = 0.36;
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2, a1 = ((i + 1) / sides) * Math.PI * 2;
    const h0 = 1.5 + (i % 2) * 0.45, h1 = 1.5 + ((i + 1) % 2) * 0.45;
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    b.color(col(i % 2 ? 0x9b8460 : 0x86704f));
    b.quad(c1 * r1, top - h1, s1 * r1, c0 * r1, top - h0, s0 * r1, c0 * r0, top, s0 * r0, c1 * r0, top, s1 * r0);
  }
}

/** Date palm: stout banded trunk, arching grey-green pinnate fronds, orange dates. */
function datePalmGeometry() {
  const b = new MeshBuilder(false, [0, 0], 2048);
  trunk(b, 7, 6, 0.36, 0.29, [0x7a6448, 0x8f7755, 0x7a6448, 0x8f7755, 0x7a6448, 0x8f7755]);
  b.pu = 0;
  b.pv = 1;
  b.color(col(0x6f5a3f));
  b.cylinder(0, 0.5, 0, 0.32, 0.42, 0.6, 7, 0, true);
  const n = 22;
  for (let k = 0; k < n; k++) {
    const th = k * GOLDEN;
    const tier = k / n;
    const el = 1.25 - tier * 1.75;
    const green = tier < 0.3 ? 0x86a067 : tier < 0.8 ? [0x71895b, 0x7a9162, 0x6a8255][k % 3] : 0x9a955e;
    b.color(col(green));
    pinnateFrond(b, th, el, rrDet(k, 2.9, 3.6));
  }
  b.color(col(0xd5862a));
  for (let k = 0; k < 3; k++) {
    const a = k * 2.1 + 0.4;
    b.blob(Math.cos(a) * 0.45, 0.65, Math.sin(a) * 0.45, 0.22, 0.32, 0.22, 4);
  }
  return b.build(false).geometry;
}

function rrDet(k: number, a: number, b: number) {
  const t = (Math.sin(k * 12.9898 + 4.1) * 43758.5453) % 1;
  return a + (b - a) * Math.abs(t);
}

/** Trunk of unit height (scaled per instance) with near-horizontal normals. */
function trunk(b: MeshBuilder, sides: number, segs: number, r0: number, r1: number, bands: number[]) {
  b.pu = 0;
  b.pv = 0;
  for (let i = 0; i < segs; i++) {
    const y0 = i / segs, y1 = (i + 1) / segs;
    const ra = r0 + (r1 - r0) * y0 + (i === 0 ? 0.08 : 0), rb = r0 + (r1 - r0) * y1;
    b.color(col(bands[i % bands.length]));
    const base = b.nv;
    for (let k = 0; k <= sides; k++) {
      const a = (k / sides) * Math.PI * 2 + i * 0.3;
      const c = Math.cos(a), s = Math.sin(a);
      b.vert(c * ra, y0, s * ra, c, 0.05, s, 0, 0);
      b.vert(c * rb, y1, s * rb, c, 0.05, s, 0, 0);
    }
    for (let k = 0; k < sides; k++) {
      const a = base + k * 2, c = a + 2;
      b.quadIdx(c, a, a + 1, c + 1);
    }
  }
}

/** One fan leaf: a stalk and a pleated, ragged-edged fan held out from the crown. */
function fanLeaf(b: MeshBuilder, th: number, el: number, stalk: number, R: number) {
  const dx = Math.cos(th) * Math.cos(el), dy = Math.sin(el), dz = Math.sin(th) * Math.cos(el);
  const tx = -Math.sin(th), tz = Math.cos(th);
  // Leaf plane normal.
  let nx = dy * tz, ny = dz * tx - dx * tz, nz = -dy * tx;
  if (ny < 0) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }
  const cy = 1.15;
  const px = dx * stalk, py = cy + dy * stalk - 0.08 * stalk, pz = dz * stalk;
  // Stalk.
  const w = 0.05;
  const s0 = b.vert(tx * w, cy, tz * w, nx, ny, nz, 0, 1);
  const s1 = b.vert(-tx * w, cy, -tz * w, nx, ny, nz, 0, 1);
  const s2 = b.vert(px - tx * w, py, pz - tz * w, nx, ny, nz, 0.4, 1);
  const s3 = b.vert(px + tx * w, py, pz + tz * w, nx, ny, nz, 0.4, 1);
  b.quadIdx(s0, s1, s2, s3);
  // Blade.
  const c = b.vert(px, py, pz, nx, ny, nz, 0.45, 1);
  const pts: number[] = [];
  const m = 8;
  for (let i = 0; i <= m; i++) {
    const a = -1.4 + (2.8 * i) / m;
    const ca = Math.cos(a), sa = Math.sin(a);
    const r = R * (i % 2 ? 0.72 : 1);
    const pleat = (i % 2 ? 1 : -1) * 0.06;
    const droop = 0.22 * r * (1 - ca) + 0.3 * r * Math.max(0, -dy);
    const x = px + r * (ca * dx + sa * tx) + nx * pleat;
    const y = py + r * ca * dy - droop + ny * pleat;
    const z = pz + r * (ca * dz + sa * tz) + nz * pleat;
    pts.push(b.vert(x, y, z, nx, ny, nz, i % 2 ? 0.8 : 1, 1));
  }
  for (let i = 0; i < m; i++) b.tri(c, pts[i], pts[i + 1]);
}

/** Arching pinnate frond with a V cross-section. */
function pinnateFrond(b: MeshBuilder, th: number, el: number, L: number) {
  const dx = Math.cos(th) * Math.cos(el), dy = Math.sin(el), dz = Math.sin(th) * Math.cos(el);
  const sx = -Math.sin(th), sz = Math.cos(th);
  const steps = 4;
  const droop = L * (0.25 + 0.35 * (1 - Math.max(0, Math.sin(el))));
  const spine: [number, number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const s = i / steps;
    spine.push([dx * L * s, 1.05 + dy * L * s - droop * s * s, dz * L * s]);
  }
  for (let i = 0; i < steps; i++) {
    const s0 = i / steps, s1 = (i + 1) / steps;
    const w0 = 0.5 * Math.sin(Math.PI * Math.min(1, s0 * 1.1 + 0.05)), w1 = 0.5 * Math.sin(Math.PI * Math.min(1, s1 * 1.1 + 0.05)) * (i === steps - 1 ? 0.15 : 1);
    const [ax, ay, az] = spine[i], [cx, cy, cz] = spine[i + 1];
    for (const side of [-1, 1]) {
      const v0 = b.vert(ax, ay, az, 0, 1, 0, s0, 1);
      const v1 = b.vert(cx, cy, cz, 0, 1, 0, s1, 1);
      const v2 = b.vert(cx + sx * side * w1, cy + w1 * 0.35, cz + sz * side * w1, -sx * side * 0.3, 1, -sz * side * 0.3, s1, 1);
      const v3 = b.vert(ax + sx * side * w0, ay + w0 * 0.35, az + sz * side * w0, -sx * side * 0.3, 1, -sz * side * 0.3, s0, 1);
      b.quadAuto(v0, v1, v2, v3);
    }
  }
}

interface PalmInstance {
  x: number;
  z: number;
  kind: 0 | 1;
}

/** Collects palm spots, then builds per-band instanced meshes. */
export class Palms {
  private readonly site: Site;
  private readonly list: PalmInstance[] = [];
  count = [0, 0];

  constructor(site: Site) {
    this.site = site;
  }

  /** Adds a palm if the spot is clear of buildings, roads and other props. */
  add(x: number, z: number, kind: 0 | 1, r = 0.9) {
    if (this.site.hitsBuilding(x, z, r) || !this.site.isFree(x, z, r) || this.site.data.overlayAt(x, z)[0] > 0.3) return false;
    if (this.site.data.sdf(x, z) < 3) return false;
    this.site.occupy(x, z, r);
    this.list.push({ x, z, kind });
    return true;
  }

  build(material: THREE.Material, rnd: () => number) {
    const geos = [fanPalmGeometry(), datePalmGeometry()];
    const meshes: THREE.InstancedMesh[] = [];
    const bands = new Map<string, PalmInstance[]>();
    for (const p of this.list) {
      // Few, large bands: palms are cheap to draw but each band costs a draw call.
      const key = `${p.kind}:${Math.floor((p.z + 6800) / 2600)}:${Math.floor((p.x + 2600) / 4000)}`;
      const l = bands.get(key);
      if (l) l.push(p);
      else bands.set(key, [p]);
    }
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), pos = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    // Palms lean away from the Norte.
    const dwx = -0.276, dwz = 0.961;
    for (const [key, list] of bands) {
      const kind = Number(key.split(':')[0]) as 0 | 1;
      const mesh = new THREE.InstancedMesh(geos[kind], material, list.length);
      const attr = new Float32Array(list.length * 3);
      let cx = 0, cz = 0;
      for (const p of list) {
        cx += p.x;
        cz += p.z;
      }
      cx /= list.length;
      cz /= list.length;
      const cy = this.site.ground(cx, cz);
      list.forEach((p, i) => {
        const g = this.site.ground(p.x, p.z);
        const sc = rr(rnd, 0.85, 1.15);
        pos.set(p.x - cx, g - 0.15 - cy, p.z - cz);
        q.setFromAxisAngle(up, rnd() * Math.PI * 2);
        s.setScalar(sc);
        m.compose(pos, q, s);
        mesh.setMatrixAt(i, m);
        const h = kind === 0 ? rr(rnd, 6.5, 15) : rr(rnd, 4, 8.5);
        const lean = rr(rnd, 0, kind === 0 ? 0.9 : 1.6);
        const la = rr(rnd, -0.9, 0.9);
        attr[i * 3] = h / sc;
        attr[i * 3 + 1] = (dwx * Math.cos(la) - dwz * Math.sin(la)) * lean;
        attr[i * 3 + 2] = (dwx * Math.sin(la) + dwz * Math.cos(la)) * lean;
        this.count[kind]++;
      });
      mesh.geometry = mesh.geometry.clone();
      mesh.geometry.setAttribute('aPalm', new THREE.InstancedBufferAttribute(attr, 3));
      mesh.position.set(cx, cy, cz);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      // The shader raises crowns by up to 15 m; pad the bounds so culling stays correct.
      if (mesh.boundingSphere) mesh.boundingSphere.radius += 16;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.name = kind === 0 ? 'fan-palms' : 'date-palms';
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      meshes.push(mesh);
    }
    return meshes;
  }
}
