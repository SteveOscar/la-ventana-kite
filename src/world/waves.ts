import { DEG, G, KNOT, clamp, damp, smoothstep } from '../core/math.ts';

export const WAVE_COUNT = 6;

const LAYOUT = [
  { length: 5.2, share: 0.07, dirOffset: 24, phase: 0.3 },
  { length: 7.9, share: 0.12, dirOffset: -17, phase: 2.1 },
  { length: 11.3, share: 0.17, dirOffset: 9, phase: 4.4 },
  { length: 15.8, share: 0.22, dirOffset: -28, phase: 1.2 },
  { length: 22.6, share: 0.25, dirOffset: 4, phase: 5.3 },
  { length: 41, share: 0.17, dirOffset: 0, phase: 3.7 },
];

/**
 * Wind chop as a handful of Gerstner waves. The same numbers drive the water
 * shader and the board physics, so what you see is what you ride over.
 */
export class Waves {
  time = 0;
  /** Total amplitude budget (m); follows the wind slowly. */
  amplitude = 0.3;
  readonly dirX = new Float32Array(WAVE_COUNT);
  readonly dirZ = new Float32Array(WAVE_COUNT);
  readonly k = new Float32Array(WAVE_COUNT);
  readonly amp = new Float32Array(WAVE_COUNT);
  readonly omega = new Float32Array(WAVE_COUNT);
  readonly phase = new Float32Array(WAVE_COUNT);
  readonly steep = new Float32Array(WAVE_COUNT);
  /** Packed uniforms: (dirX, dirZ, k, amp) and (omega, phase, steepness, 0). */
  readonly uniformA = new Float32Array(WAVE_COUNT * 4);
  readonly uniformB = new Float32Array(WAVE_COUNT * 4);

  constructor() {
    LAYOUT.forEach((w, i) => {
      this.k[i] = (2 * Math.PI) / w.length;
      this.omega[i] = Math.sqrt(G * this.k[i]);
      this.phase[i] = w.phase;
    });
  }

  /** `windSpeed` m/s; `downwind` compass heading the wind blows toward; `swellFromDeg` compass. */
  update(dt: number, windSpeed: number, downwind: number, swellFromDeg = 20) {
    this.time += dt;
    const kn = windSpeed / KNOT;
    const target = clamp(0.011 * Math.pow(Math.max(kn, 4), 1.3), 0.05, 0.95);
    this.amplitude = dt > 0 ? damp(this.amplitude, target, 0.05, dt) : target;
    LAYOUT.forEach((w, i) => {
      const isSwell = i === WAVE_COUNT - 1;
      const heading = isSwell ? (swellFromDeg + 180) * DEG : downwind + w.dirOffset * DEG;
      this.dirX[i] = Math.sin(heading);
      this.dirZ[i] = -Math.cos(heading);
      this.amp[i] = this.amplitude * w.share * (isSwell ? 0.8 : 1);
      // Steepness kept below the loop limit; short chop is the sharpest.
      this.steep[i] = isSwell ? 0.35 : 0.55;
      const a = this.uniformA, b = this.uniformB, o = i * 4;
      a[o] = this.dirX[i];
      a[o + 1] = this.dirZ[i];
      a[o + 2] = this.k[i];
      a[o + 3] = this.amp[i];
      b[o] = this.omega[i];
      b[o + 1] = this.phase[i];
      b[o + 2] = this.steep[i] / (this.k[i] * Math.max(1e-4, this.amp[i]) * WAVE_COUNT);
      b[o + 3] = 0;
    });
  }

  /** Shallow water damps the chop toward the beach. */
  static depthFactor(depth: number) {
    return smoothstep(0.15, 3.5, depth);
  }

  private displaceXZ(x: number, z: number, atten: number, out: { x: number; z: number }) {
    let dx = 0, dz = 0;
    for (let i = 0; i < WAVE_COUNT; i++) {
      const a = this.amp[i] * atten;
      const q = this.uniformB[i * 4 + 2];
      const th = this.k[i] * (this.dirX[i] * x + this.dirZ[i] * z) - this.omega[i] * this.time + this.phase[i];
      const c = Math.cos(th) * q * a;
      dx += this.dirX[i] * c;
      dz += this.dirZ[i] * c;
    }
    out.x = dx;
    out.z = dz;
  }

  private rawHeight(x: number, z: number, atten: number) {
    let h = 0;
    for (let i = 0; i < WAVE_COUNT; i++) {
      const th = this.k[i] * (this.dirX[i] * x + this.dirZ[i] * z) - this.omega[i] * this.time + this.phase[i];
      h += Math.sin(th) * this.amp[i] * atten;
    }
    return h;
  }

  private tmp = { x: 0, z: 0 };

  /** Surface height at a world point; `atten` = depthFactor at that point. */
  height(x: number, z: number, atten = 1) {
    if (atten <= 0) return 0;
    // Invert the horizontal Gerstner displacement with two fixed-point steps.
    let px = x, pz = z;
    for (let it = 0; it < 2; it++) {
      this.displaceXZ(px, pz, atten, this.tmp);
      px = x - this.tmp.x;
      pz = z - this.tmp.z;
    }
    return this.rawHeight(px, pz, atten);
  }

  /** Vertical velocity of the surface (m/s), used for chop bumps under the board. */
  verticalSpeed(x: number, z: number, atten = 1) {
    let v = 0;
    for (let i = 0; i < WAVE_COUNT; i++) {
      const th = this.k[i] * (this.dirX[i] * x + this.dirZ[i] * z) - this.omega[i] * this.time + this.phase[i];
      v += -Math.cos(th) * this.amp[i] * atten * this.omega[i];
    }
    return v;
  }

  /** Surface slope along a horizontal direction (dh/ds). */
  slopeAlong(x: number, z: number, dirX: number, dirZ: number, atten = 1) {
    const e = 0.6;
    return (this.height(x + dirX * e, z + dirZ * e, atten) - this.height(x - dirX * e, z - dirZ * e, atten)) / (2 * e);
  }
}
