export const DEG = Math.PI / 180;
export const KNOT = 0.514444;
export const G = 9.81;
export const RHO_AIR = 1.2;

export const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Frame-rate independent exponential approach: `rate` is 1/seconds. */
export const damp = (current: number, target: number, rate: number, dt: number) =>
  lerp(current, target, 1 - Math.exp(-rate * dt));

export const wrapAngle = (a: number) => {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
};
export const dampAngle = (current: number, target: number, rate: number, dt: number) =>
  current + wrapAngle(target - current) * (1 - Math.exp(-rate * dt));

/** Compass heading (0 = north, PI/2 = east) to a horizontal unit vector in x-east, z-south space. */
export const headingX = (h: number) => Math.sin(h);
export const headingZ = (h: number) => -Math.cos(h);
export const headingOf = (x: number, z: number) => Math.atan2(x, -z);

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(i: number, j: number, seed: number) {
  let h = (i * 374761393 + j * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Smooth value noise in [0, 1]. */
export function noise2(x: number, z: number, seed = 0) {
  const i = Math.floor(x), j = Math.floor(z);
  const fx = x - i, fz = z - j;
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  const a = hash2(i, j, seed), b = hash2(i + 1, j, seed), c = hash2(i, j + 1, seed), d = hash2(i + 1, j + 1, seed);
  return (a * (1 - ux) + b * ux) * (1 - uz) + (c * (1 - ux) + d * ux) * uz;
}

export function fbm2(x: number, z: number, octaves = 3, seed = 0) {
  let sum = 0, amp = 0.5, norm = 0, f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += noise2(x * f, z * f, seed + o * 17) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return sum / norm;
}

/** 1D smooth noise in [-1, 1], handy for slow wind drifts. */
export function noise1(t: number, seed = 0) {
  return noise2(t, seed * 13.7, seed) * 2 - 1;
}

export function formatClock(hours: number) {
  const h = Math.floor(hours);
  const m = Math.floor((hours - h) * 60);
  return `${h}:${m.toString().padStart(2, '0')}`;
}

/**
 * Carve command toward a desired heading that turns through downwind rather than through
 * the wind for big turns (kiters can't tack through the no-go zone). `state.dir` holds the
 * committed turn direction between calls.
 */
export function carveToward(heading: number, desired: number, downwind: number, state: { dir: number }, gain = 1.6) {
  const err = wrapAngle(desired - heading);
  if (Math.abs(err) < 0.5) state.dir = 0;
  if (Math.abs(err) > 1.2 && state.dir === 0) {
    const a = wrapAngle(downwind - heading);
    const viaShort = Math.sign(a) === Math.sign(err) && Math.abs(a) < Math.abs(err);
    state.dir = viaShort ? Math.sign(err) : -Math.sign(err);
  }
  if (state.dir !== 0) return state.dir;
  return clamp(err * gain, -1, 1);
}
