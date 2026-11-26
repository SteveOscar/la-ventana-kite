import { DEG, KNOT, clamp, lerp, noise1, smoothstep } from '../core/math.ts';

export interface WindSettings {
  /** Afternoon peak of the day's wind at 10 m, in knots. */
  knots: number;
  /** Compass direction the wind blows from, in degrees (El Norte ~ 10-25). */
  fromDeg: number;
  /** Gust amplitude as a fraction of the mean (0.15 smooth .. 0.35 very gusty). */
  gustiness: number;
}

export const WIND_PRESETS: Record<string, WindSettings & { label: string; labelEs: string }> = {
  light: { knots: 14, fromDeg: 12, gustiness: 0.2, label: 'Light Norte', labelEs: 'Norte ligero' },
  classic: { knots: 19, fromDeg: 16, gustiness: 0.22, label: 'Classic Norte', labelEs: 'Norte clásico' },
  strong: { knots: 25, fromDeg: 20, gustiness: 0.26, label: 'Nuking', labelEs: 'Norte fuerte' },
};

/** Thermal-boosted El Norte: light in the morning, peak mid-afternoon, fading at sunset. */
export function diurnalFactor(hours: number) {
  const rise = smoothstep(8.5, 12.8, hours);
  const fall = 1 - 0.65 * smoothstep(16.6, 18.8, hours);
  return lerp(0.32, 1, rise) * fall;
}

const GUST_N = 256;
/** Metres per gust texel; one tile spans GUST_N * GUST_SCALE metres. */
export const GUST_SCALE = 12;

function periodicNoise(size: number, cells: number, seed: number) {
  const lattice = new Float32Array(cells * cells);
  let s = seed >>> 0;
  for (let i = 0; i < lattice.length; i++) {
    s = (Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9) >>> 0;
    lattice[i] = (s >>> 8) / 16777216;
  }
  const out = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const fx = (i / size) * cells, fz = (j / size) * cells;
      const ix = Math.floor(fx), iz = Math.floor(fz);
      const ax = fx - ix, az = fz - iz;
      const ux = ax * ax * (3 - 2 * ax), uz = az * az * (3 - 2 * az);
      const a = lattice[(iz % cells) * cells + (ix % cells)];
      const b = lattice[(iz % cells) * cells + ((ix + 1) % cells)];
      const c = lattice[((iz + 1) % cells) * cells + (ix % cells)];
      const d = lattice[((iz + 1) % cells) * cells + ((ix + 1) % cells)];
      out[j * size + i] = (a * (1 - ux) + b * ux) * (1 - uz) + (c * (1 - ux) + d * ux) * uz;
    }
  }
  return out;
}

export class Wind {
  settings: WindSettings;
  /** Seconds of simulated time. */
  time = 0;
  hours = 13;
  /** Current mean speed at 10 m (m/s), before gusts and local effects. */
  base = 8;
  /** Current direction the wind comes from (radians, compass). */
  fromRad = 15 * DEG;
  /** Accumulated advection of the gust pattern (metres). */
  readonly gustOffset = { x: 0, z: 0 };
  /** Tileable gust field in [-1, 1], shared with the water shader. */
  readonly gustField: Float32Array;
  readonly gustSize = GUST_N;

  constructor(settings: WindSettings, seed = 7) {
    this.settings = { ...settings };
    const a = periodicNoise(GUST_N, 8, seed);
    const b = periodicNoise(GUST_N, 21, seed + 11);
    const c = periodicNoise(GUST_N, 47, seed + 23);
    this.gustField = new Float32Array(GUST_N * GUST_N);
    for (let i = 0; i < this.gustField.length; i++) {
      const v = a[i] * 0.55 + b[i] * 0.3 + c[i] * 0.15;
      this.gustField[i] = clamp((v - 0.5) * 3.2, -1, 1);
    }
    this.fromRad = settings.fromDeg * DEG;
    this.update(0, this.hours);
  }

  update(dt: number, hours: number) {
    this.time += dt;
    this.hours = hours;
    const s = this.settings;
    const surge = 1 + 0.09 * noise1(this.time / 75, 3) + 0.05 * noise1(this.time / 23, 5);
    this.base = s.knots * KNOT * diurnalFactor(hours) * surge;
    this.fromRad = (s.fromDeg + 7 * noise1(this.time / 140, 9)) * DEG;
    const vx = -Math.sin(this.fromRad) * this.base;
    const vz = Math.cos(this.fromRad) * this.base;
    // Gust patches drift a little slower than the mean wind, like cat's paws on the water.
    this.gustOffset.x += vx * 0.85 * dt;
    this.gustOffset.z += vz * 0.85 * dt;
  }

  /** Gust value in [-1, 1] at a world point. */
  gust(x: number, z: number) {
    const n = GUST_N;
    const fx = (((x - this.gustOffset.x) / GUST_SCALE) % n + n) % n;
    const fz = (((z - this.gustOffset.z) / GUST_SCALE) % n + n) % n;
    const i = Math.floor(fx), j = Math.floor(fz);
    const ax = fx - i, az = fz - j;
    const i1 = (i + 1) % n, j1 = (j + 1) % n;
    const g = this.gustField;
    return (g[j * n + i] * (1 - ax) + g[j * n + i1] * ax) * (1 - az) + (g[j1 * n + i] * (1 - ax) + g[j1 * n + i1] * ax) * az;
  }

  /** Local multiplier from the coast: lighter right at the beach and on land, stronger in the channel. */
  static localFactor(sdf: number) {
    if (sdf > 0) return lerp(0.8, 0.45, smoothstep(0, 400, sdf));
    const off = -sdf;
    return lerp(0.86, 1, smoothstep(0, 140, off)) * (1 + 0.12 * smoothstep(600, 4500, off));
  }

  /**
   * Wind velocity (m/s) at a point. `sdf` is the coast distance there (positive on land).
   * Writes the horizontal components to `out` and returns the speed.
   */
  sample(x: number, y: number, z: number, sdf: number, out: { x: number; z: number }) {
    const gust = this.gust(x, z);
    const height = Math.pow(clamp(y, 0.5, 200) / 10, 0.11);
    const speed = Math.max(0, this.base * (1 + this.settings.gustiness * gust) * Wind.localFactor(sdf) * height);
    out.x = -Math.sin(this.fromRad) * speed;
    out.z = Math.cos(this.fromRad) * speed;
    return speed;
  }

  /** Unit vector the wind blows toward. */
  get downwindX() {
    return -Math.sin(this.fromRad);
  }
  get downwindZ() {
    return Math.cos(this.fromRad);
  }
}
