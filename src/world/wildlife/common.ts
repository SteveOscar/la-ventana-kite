import type * as THREE from 'three';
import type { TerrainData } from '../terrainData.ts';
import type { WaterFx } from './waterFx.ts';

export type SpeciesId = 'pelican' | 'frigate' | 'dolphin' | 'humpback' | 'sealion' | 'turtle' | 'mobula' | 'osprey';

/** Something audible happened (for the audio engine). `strength` is 0..1. */
export interface WildlifeEvent {
  kind: 'blow' | 'breach' | 'splash' | 'slap' | 'dive';
  species: string;
  x: number;
  y: number;
  z: number;
  strength: number;
}

/** Per-frame state shared by all species. */
export interface Ctx {
  data: TerrainData;
  surface: (x: number, z: number) => number;
  fx: WaterFx;
  focus: THREE.Vector3;
  /** Smoothed focus velocity (m/s). */
  vx: number;
  vz: number;
  camX: number;
  camY: number;
  camZ: number;
  /** Horizontal unit vector the camera looks along. */
  fwdX: number;
  fwdZ: number;
  time: number;
  month: number;
  windX: number;
  windZ: number;
  /** Heading the wind comes from (birds hover and take off into it). */
  windFrom: number;
  /** Reports a candidate sighting (distance and frustum are checked by the owner). */
  sight(id: SpeciesId, x: number, y: number, z: number, range: number): void;
  /** True when the point projects inside the view (with a margin in NDC units). */
  inView(x: number, y: number, z: number, margin?: number): boolean;
  emit(e: WildlifeEvent): void;
}

export interface Species {
  readonly name: string;
  update(ctx: Ctx, dt: number): void;
  clear(): void;
  /** Debug: force an encounter near a point. */
  spawnAt(ctx: Ctx, x: number, z: number, action?: string): void;
  readonly active: number;
}

export const rand = (a: number, b: number) => a + Math.random() * (b - a);
export const randInt = (a: number, b: number) => Math.floor(rand(a, b + 1));
export const pickOne = <T>(arr: readonly T[]) => arr[Math.floor(Math.random() * arr.length)];
/** Poisson arrival with the given mean interval. */
export const arrival = (mean: number) => -Math.log(1 - Math.random()) * mean;
export const fwdX = (h: number) => Math.sin(h);
export const fwdZ = (h: number) => -Math.cos(h);
export const headingTo = (dx: number, dz: number) => Math.atan2(dx, -dz);
export const wrap = (a: number) => {
  a = (a + Math.PI) % (Math.PI * 2);
  return a < 0 ? a + Math.PI : a - Math.PI;
};
export const approach = (v: number, target: number, rate: number, dt: number) => v + (target - v) * (1 - Math.exp(-rate * dt));
export const approachAngle = (v: number, target: number, rate: number, dt: number) => v + wrap(target - v) * (1 - Math.exp(-rate * dt));
export const distXZ = (ax: number, az: number, bx: number, bz: number) => Math.hypot(ax - bx, az - bz);

export interface SeaQuery {
  minR: number;
  maxR: number;
  /** Required water depth (m). */
  minDepth?: number;
  /** Signed coast distance must be below this (negative = offshore). */
  maxSdf?: number;
  minSdf?: number;
  /** Centre direction (compass heading) and total spread of the search fan. */
  heading?: number;
  spread?: number;
  tries?: number;
  /** Search around this point instead of the focus. */
  x?: number;
  z?: number;
}

/** A random point over water matching the query, or null. */
export function seaPoint(ctx: Ctx, q: SeaQuery): { x: number; z: number } | null {
  const cx = q.x ?? ctx.focus.x, cz = q.z ?? ctx.focus.z;
  const tries = q.tries ?? 14;
  for (let i = 0; i < tries; i++) {
    const h = q.heading !== undefined ? q.heading + (Math.random() - 0.5) * (q.spread ?? Math.PI * 2) : Math.random() * Math.PI * 2;
    const r = q.minR + Math.sqrt(Math.random()) * (q.maxR - q.minR);
    const x = cx + fwdX(h) * r, z = cz + fwdZ(h) * r;
    const sdf = ctx.data.sdf(x, z);
    if (sdf > (q.maxSdf ?? -8)) continue;
    if (q.minSdf !== undefined && sdf < q.minSdf) continue;
    if (q.minDepth !== undefined && ctx.data.depth(x, z) < q.minDepth) continue;
    return { x, z };
  }
  return null;
}

/**
 * Size boost for distant animals. A screen pixel is several times coarser than the eye, so
 * without it a pelican at 400 m or a breach at 300 m shrinks to a speck on the horizon.
 */
export function readable(ctx: Ctx, x: number, y: number, z: number, gain: number) {
  const d = Math.hypot(x - ctx.camX, y - ctx.camY, z - ctx.camZ);
  const t = Math.min(1, Math.max(0, (d - 60) / 440));
  return 1 + gain * t * (2 - t);
}

/** Compass heading of the camera's view. */
export const viewHeading = (ctx: Ctx) => headingTo(ctx.fwdX, ctx.fwdZ);

/** Picks a spawn point, preferring the view so encounters are actually seen. */
export function encounterPoint(ctx: Ctx, q: SeaQuery, viewBias = 0.75) {
  if (Math.random() < viewBias) {
    const p = seaPoint(ctx, { ...q, heading: viewHeading(ctx), spread: q.spread ?? 1.6 });
    if (p) return p;
  }
  return seaPoint(ctx, { ...q, heading: undefined });
}

/** Cubic Hermite through keyframes (t ascending); tangents from neighbours. */
export function keyframe(keys: readonly (readonly number[])[], t: number, ch: number) {
  const n = keys.length;
  if (t <= keys[0][0]) return keys[0][ch];
  if (t >= keys[n - 1][0]) return keys[n - 1][ch];
  let i = 0;
  while (i < n - 2 && t > keys[i + 1][0]) i++;
  const k0 = keys[Math.max(0, i - 1)], k1 = keys[i], k2 = keys[i + 1], k3 = keys[Math.min(n - 1, i + 2)];
  const h = k2[0] - k1[0];
  const u = (t - k1[0]) / h;
  const m1 = ((k2[ch] - k0[ch]) / Math.max(1e-6, k2[0] - k0[0])) * h;
  const m2 = ((k3[ch] - k1[ch]) / Math.max(1e-6, k3[0] - k1[0])) * h;
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * k1[ch] + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * k2[ch] + (u3 - u2) * m2;
}

/** World position of a point given in an animal's local frame (forward +z, up +y, left +x). */
export function localToWorld(
  out: { x: number; y: number; z: number },
  p: { x: number; y: number; z: number; heading: number; pitch: number; roll: number; scale: number },
  lx: number,
  ly: number,
  lz: number,
) {
  const s = p.scale;
  lx *= s;
  ly *= s;
  lz *= s;
  // Roll about z, pitch about x (nose up), then heading about y.
  const cr = Math.cos(p.roll), sr = Math.sin(p.roll);
  const x1 = lx * cr - ly * sr, y1 = lx * sr + ly * cr, z1 = lz;
  const cp = Math.cos(p.pitch), sp = Math.sin(p.pitch);
  const y2 = y1 * cp + z1 * sp, z2 = -y1 * sp + z1 * cp;
  const fx = Math.sin(p.heading), fz = -Math.cos(p.heading);
  // Local +x (left) maps to the heading rotated 90 degrees anticlockwise.
  const lxw = fz, lzw = -fx;
  out.x = p.x + x1 * lxw + z2 * fx;
  out.y = p.y + y2;
  out.z = p.z + x1 * lzw + z2 * fz;
  return out;
}
