import * as THREE from 'three';
import { MeshBuilder } from './builder.ts';

const OX = -700;
const OZ = -6000;

export interface ChunkMesh {
  full: THREE.Mesh;
  /** Same chunk with simplified houses (null when the chunk has no houses). */
  lod: THREE.Mesh | null;
  /** World-space bounding sphere. */
  center: THREE.Vector3;
  radius: number;
}

/**
 * Spatial chunks of merged geometry so frustum culling can skip whole blocks.
 * Busy cells are `fine` metres across; sparse cells fold into `coarse` ones so
 * scattered ranches do not each cost a draw call. Houses are written between
 * beginHouses/endHouses so a distant stand-in can replace just that range.
 */
export class ChunkSet {
  private readonly builders = new Map<number, MeshBuilder>();
  private readonly lods = new Map<number, MeshBuilder>();
  private readonly houseStart = new Map<number, [number, number]>();
  private readonly houseEnd = new Map<number, [number, number]>();
  private inHouses = false;
  private readonly fine: number;
  private readonly coarse: number;
  private readonly dense: Set<number>;
  private readonly plain: readonly [number, number];

  constructor(plain: readonly [number, number], dense: Set<number>, fine: number, coarse: number) {
    this.plain = plain;
    this.dense = dense;
    this.fine = fine;
    this.coarse = coarse;
  }

  static fineKey(x: number, z: number, fine: number) {
    return (Math.floor((x - OX) / fine) + 512) * 1024 + (Math.floor((z - OZ) / fine) + 512);
  }

  private keyOf(x: number, z: number) {
    const f = ChunkSet.fineKey(x, z, this.fine);
    if (this.dense.has(f)) return f;
    return -1 - ChunkSet.fineKey(x, z, this.coarse);
  }

  at(x: number, z: number) {
    const k = this.keyOf(x, z);
    let b = this.builders.get(k);
    if (!b) {
      b = new MeshBuilder(false, this.plain, 8192);
      this.builders.set(k, b);
      if (this.inHouses) this.houseStart.set(k, [0, 0]);
    }
    return b;
  }

  lodAt(x: number, z: number) {
    const k = this.keyOf(x, z);
    let b = this.lods.get(k);
    if (!b) {
      b = new MeshBuilder(false, this.plain, 2048);
      this.lods.set(k, b);
    }
    return b;
  }

  beginHouses() {
    this.inHouses = true;
    for (const [k, b] of this.builders) this.houseStart.set(k, [b.nv, b.ni]);
  }

  endHouses() {
    this.inHouses = false;
    for (const [k, b] of this.builders) this.houseEnd.set(k, [b.nv, b.ni]);
  }

  get triangles() {
    let n = 0;
    for (const b of this.builders.values()) n += b.triangles;
    return n;
  }

  get lodTriangles() {
    let n = 0;
    for (const b of this.lods.values()) n += b.triangles;
    return n;
  }

  build(material: THREE.Material, name: string): ChunkMesh[] {
    const out: ChunkMesh[] = [];
    const mesh = (b: MeshBuilder, suffix: string) => {
      const { geometry, center } = b.build();
      const m = new THREE.Mesh(geometry, material);
      m.position.copy(center);
      m.name = name + suffix;
      m.castShadow = false;
      m.receiveShadow = false;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      return m;
    };
    for (const [k, b] of this.builders) {
      if (b.ni === 0) continue;
      const full = mesh(b, '');
      const lodB = this.lods.get(k);
      const s = this.houseStart.get(k), e = this.houseEnd.get(k);
      const lod = lodB && s && e ? mesh(splice(b, s, e, lodB, this.plain), '-lod') : null;
      const bs = full.geometry.boundingSphere!;
      out.push({ full, lod, center: bs.center.clone().add(full.position), radius: bs.radius });
      if (lod) lod.visible = false;
    }
    return out;
  }
}

/** Copy of `full` with its vertex/index range [s, e) replaced by everything in `lod`. */
function splice(full: MeshBuilder, s: [number, number], e: [number, number], lod: MeshBuilder, plain: readonly [number, number]) {
  const nv = s[0] + lod.nv + (full.nv - e[0]);
  const out = new MeshBuilder(false, plain, Math.max(16, nv));
  const copy = (dst: number, src: MeshBuilder, from: number, to: number) => {
    out.pos.set(src.pos.subarray(from * 3, to * 3), dst * 3);
    out.nor.set(src.nor.subarray(from * 3, to * 3), dst * 3);
    out.col.set(src.col.subarray(from * 3, to * 3), dst * 3);
    out.uv.set(src.uv.subarray(from * 2, to * 2), dst * 2);
  };
  copy(0, full, 0, s[0]);
  copy(s[0], lod, 0, lod.nv);
  copy(s[0] + lod.nv, full, e[0], full.nv);
  const ni = s[1] + lod.ni + (full.ni - e[1]);
  const idx = new Uint32Array(ni);
  idx.set(full.idx.subarray(0, s[1]), 0);
  for (let i = 0; i < lod.ni; i++) idx[s[1] + i] = lod.idx[i] + s[0];
  const shift = lod.nv - (e[0] - s[0]);
  for (let i = e[1], o = s[1] + lod.ni; i < full.ni; i++, o++) idx[o] = full.idx[i] + shift;
  out.idx = idx;
  out.nv = nv;
  out.ni = ni;
  return out;
}
