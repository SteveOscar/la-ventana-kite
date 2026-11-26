// Pure sample-level helpers shared by the offline synthesis recipes. Nothing here
// touches Web Audio, so it runs (and is checked) under plain Node as well.

export type Rng = () => number;

/** Roughly standard-normal sample (Irwin–Hall of four uniforms). */
export function gauss(r: Rng) {
  return (r() + r() + r() + r() - 2) * 1.7320508;
}

export function whiteNoise(n: number, r: Rng) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = r() * 2 - 1;
  return out;
}

/** Paul Kellet's refined pink filter (within ±0.05 dB of 1/f above ~10 Hz). */
export function pinkNoise(n: number, r: Rng) {
  const out = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = r() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
  }
  return out;
}

/** Streaming version of `pinkNoise`, roughly unit RMS. */
export class PinkGen {
  private b = [0, 0, 0, 0, 0, 0, 0];
  private r: Rng;

  constructor(r: Rng) {
    this.r = r;
  }

  next() {
    const b = this.b;
    const w = this.r() * 2 - 1;
    b[0] = 0.99886 * b[0] + w * 0.0555179;
    b[1] = 0.99332 * b[1] + w * 0.0750759;
    b[2] = 0.969 * b[2] + w * 0.153852;
    b[3] = 0.8665 * b[3] + w * 0.3104856;
    b[4] = 0.55 * b[4] + w * 0.5329522;
    b[5] = -0.7616 * b[5] - w * 0.016898;
    const y = b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + w * 0.5362;
    b[6] = w * 0.115926;
    return y * 0.45;
  }
}

/** Leaky-integrated white noise: 1/f² above ~150 Hz, flat below, so it never drifts. */
export function brownNoise(n: number, r: Rng) {
  const out = new Float32Array(n);
  let last = 0;
  for (let i = 0; i < n; i++) {
    last = (last + 0.02 * (r() * 2 - 1)) / 1.02;
    out[i] = last;
  }
  return out;
}

/**
 * Returns the first `n` samples of `x` (which must hold `n + fade`) with the tail
 * crossfaded into the head, so the buffer loops without a step at the seam.
 */
export function seamless(x: Float32Array, n: number, fade: number) {
  const out = x.slice(0, n);
  for (let i = 0; i < fade; i++) {
    const t = (i / fade) * (Math.PI / 2);
    out[i] = x[i] * Math.sin(t) + x[n + i] * Math.cos(t);
  }
  return out;
}

export function removeDc(x: Float32Array) {
  let m = 0;
  for (let i = 0; i < x.length; i++) m += x[i];
  m /= x.length || 1;
  for (let i = 0; i < x.length; i++) x[i] -= m;
  return x;
}

export function peakOf(x: Float32Array) {
  let p = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > p) p = a;
  }
  return p;
}

export function rmsOf(x: Float32Array, from = 0, to = x.length) {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

export function scale(x: Float32Array, k: number) {
  for (let i = 0; i < x.length; i++) x[i] *= k;
  return x;
}

export function normalizePeak(x: Float32Array, peak: number) {
  const p = peakOf(x);
  return p > 0 ? scale(x, peak / p) : x;
}

/** Scales to an RMS target, then soft-limits the rare outliers into [-1, 1]. */
export function normalizeRms(x: Float32Array, target: number) {
  const r = rmsOf(x);
  if (r > 0) scale(x, target / r);
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (v > 0.9 || v < -0.9) x[i] = Math.sign(v) * (0.9 + 0.1 * Math.tanh((Math.abs(v) - 0.9) / 0.1));
  }
  return x;
}

/** Linear fades at both ends so a one-shot can never start or stop on a step. */
export function fadeEdges(x: Float32Array, sampleRate: number, inSec = 0.001, outSec = 0.02) {
  const a = Math.min(x.length, Math.round(inSec * sampleRate));
  const b = Math.min(x.length, Math.round(outSec * sampleRate));
  for (let i = 0; i < a; i++) x[i] *= i / a;
  for (let i = 0; i < b; i++) x[x.length - 1 - i] *= i / b;
  return x;
}

/** Attack (linear) then exponential decay with time constant `tau`. */
export function ad(t: number, attack: number, tau: number) {
  if (t < 0) return 0;
  if (t < attack) return t / attack;
  return Math.exp(-(t - attack) / tau);
}

/** RBJ-cookbook biquad in transposed direct form II. */
export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private z1 = 0;
  private z2 = 0;

  private set(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number) {
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
    return this;
  }

  private static w(f: number, fs: number) {
    return (2 * Math.PI * Math.min(Math.max(f, 5), fs * 0.45)) / fs;
  }

  lowpass(f: number, q: number, fs: number) {
    const w = Biquad.w(f, fs), c = Math.cos(w), al = Math.sin(w) / (2 * q);
    return this.set((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al);
  }

  highpass(f: number, q: number, fs: number) {
    const w = Biquad.w(f, fs), c = Math.cos(w), al = Math.sin(w) / (2 * q);
    return this.set((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al);
  }

  /** Band-pass with 0 dB gain at the centre. */
  bandpass(f: number, q: number, fs: number) {
    const w = Biquad.w(f, fs), c = Math.cos(w), al = Math.sin(w) / (2 * q);
    return this.set(al, 0, -al, 1 + al, -2 * c, 1 - al);
  }

  run(x: number) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

/** One-pole low-pass smoother. */
export class OnePole {
  private a: number;
  private y = 0;

  constructor(f: number, fs: number) {
    this.a = 1 - Math.exp((-2 * Math.PI * f) / fs);
  }

  setFreq(f: number, fs: number) {
    this.a = 1 - Math.exp((-2 * Math.PI * f) / fs);
  }

  run(x: number) {
    this.y += this.a * (x - this.y);
    return this.y;
  }
}

export const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
