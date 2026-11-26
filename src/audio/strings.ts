import { mulberry32 } from '../core/math.ts';
import { OnePole, fadeEdges } from './dsp.ts';

export interface PluckSpec {
  /** Fundamental (Hz). */
  freq: number;
  sampleRate: number;
  seconds: number;
  /** Seconds for the fundamental to fall 60 dB. */
  t60: number;
  /** Excitation brightness: 0 = soft thumb flesh .. 1 = nail. */
  bright: number;
  /** Loop low-pass cutoff in harmonics of the fundamental; lower = duller, faster-dying highs (nylon). */
  damping: number;
  /** Pluck point as a fraction of the string (0.08 near the bridge .. 0.5 mid-string). */
  position: number;
  seed: number;
  /** Fade-in (s): a flesh pluck is softer than the raw noise burst. */
  attack?: number;
}

/**
 * Extended Karplus–Strong plucked string (Jaffe & Smith): a delay line with a
 * two-point average plus a one-pole low-pass in the loop for nylon-like damping
 * of the upper partials, and a first-order all-pass for exact tuning. Adds the
 * note into `out` from sample `offset`.
 */
export function pluckInto(out: Float32Array, offset: number, s: PluckSpec, gain = 1) {
  const fs = s.sampleRate;
  const f0 = s.freq;
  const w0 = (2 * Math.PI * f0) / fs;
  const len = Math.min(out.length - offset, Math.round(s.seconds * fs));
  if (len <= 0) return;

  const fc = Math.min(f0 * s.damping, fs * 0.4);
  const g = fc >= fs * 0.4 ? 0 : Math.exp((-2 * Math.PI * fc) / fs);
  const lpPhase = Math.atan2(g * Math.sin(w0), 1 - g * Math.cos(w0)) / w0;
  const lpMag = (1 - g) / Math.sqrt(1 - 2 * g * Math.cos(w0) + g * g);

  // Loop delay = line + 0.5 (average) + one-pole phase delay + all-pass fraction.
  const p = fs / f0 - 0.5 - lpPhase;
  const n = Math.max(2, Math.floor(p - 0.1));
  const frac = p - n;
  const c = (1 - frac) / (1 + frac);
  const rho = Math.min(0.99995, Math.pow(0.001, 1 / (f0 * s.t60)) / (Math.cos(w0 / 2) * lpMag));

  // Excitation: one period of low-passed noise (the filter is warmed up on a first
  // lap so the period wraps cleanly), then the pluck-position comb, zero mean, unit peak.
  const r = mulberry32(s.seed);
  const noise = new Float32Array(n);
  for (let i = 0; i < n; i++) noise[i] = r() * 2 - 1;
  const exFc = Math.min(fs * 0.45, f0 * (2.5 + 22 * s.bright * s.bright));
  const lpA = new OnePole(exFc, fs), lpB = new OnePole(exFc, fs);
  for (let i = 0; i < n; i++) lpB.run(lpA.run(noise[i]));
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) raw[i] = lpB.run(lpA.run(noise[i]));
  const line = new Float32Array(n);
  const m = Math.max(1, Math.round(s.position * n));
  let mean = 0;
  for (let i = 0; i < n; i++) {
    line[i] = raw[i] - raw[(i - m + n) % n];
    mean += line[i];
  }
  mean /= n;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    line[i] -= mean;
    peak = Math.max(peak, Math.abs(line[i]));
  }
  const k = peak > 0 ? 1 / peak : 0;
  for (let i = 0; i < n; i++) line[i] *= k;

  const note = new Float32Array(len);
  let idx = 0, prev = 0, lp = 0, apX = 0, apY = 0;
  for (let i = 0; i < len; i++) {
    const cur = line[idx];
    note[i] = cur;
    const avg = 0.5 * (cur + prev);
    prev = cur;
    lp = (1 - g) * avg + g * lp;
    const ap = c * lp + apX - c * apY;
    apX = lp;
    apY = ap;
    line[idx] = ap * rho;
    idx = idx + 1 === n ? 0 : idx + 1;
  }
  fadeEdges(note, fs, s.attack ?? 0.002, Math.min(0.25, s.seconds * 0.3));
  for (let i = 0; i < len; i++) out[offset + i] += note[i] * gain;
}

export function pluck(s: PluckSpec, gain = 1) {
  const out = new Float32Array(Math.round(s.seconds * s.sampleRate));
  pluckInto(out, 0, s, gain);
  return out;
}

export type StringInstrument = 'guitar' | 'requinto' | 'bass';

/** Sample rate the note bank renders each instrument at (all well above their useful bandwidth). */
export const INSTRUMENT_RATE: Record<StringInstrument, number> = { guitar: 24000, requinto: 32000, bass: 16000 };

/** Voicing of each instrument: nylon strum guitar/jarana, bright requinto lead, guitarrón bass in octaves. */
export function renderNote(inst: StringInstrument, midi: number, seed: number) {
  const fs = INSTRUMENT_RATE[inst];
  const f = 440 * Math.pow(2, (midi - 69) / 12);
  if (inst === 'bass') {
    const seconds = 1.7;
    const out = new Float32Array(Math.round(seconds * fs));
    const base = { sampleRate: fs, seconds, position: 0.21, seed };
    pluckInto(out, 0, { ...base, freq: f, t60: 2.6, bright: 0.25, damping: 9, attack: 0.004 });
    // Guitarrón courses are doubled at the octave.
    pluckInto(out, 0, { ...base, freq: f * 2, t60: 1.8, bright: 0.3, damping: 8, seed: seed + 1, attack: 0.004 }, 0.45);
    return normalizeTo(out, 0.9);
  }
  if (inst === 'requinto') {
    const t60 = clampN(4.4 - (midi - 55) * 0.08, 1.2, 3.6);
    const seconds = Math.min(1.5, 0.35 + t60 * 0.45);
    return normalizeTo(pluck({ freq: f, sampleRate: fs, seconds, t60, bright: 0.55, damping: 22, position: 0.13, seed }), 0.9);
  }
  const t60 = clampN(4.8 - (midi - 40) * 0.07, 1.4, 4.4);
  const seconds = Math.min(1.7, 0.4 + t60 * 0.45);
  return normalizeTo(pluck({ freq: f, sampleRate: fs, seconds, t60, bright: 0.36, damping: 15, position: 0.17, seed, attack: 0.003 }), 0.9);
}

function clampN(x: number, a: number, b: number) {
  return x < a ? a : x > b ? b : x;
}

function normalizeTo(x: Float32Array, peak: number) {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]));
  if (p > 0) for (let i = 0; i < x.length; i++) x[i] *= peak / p;
  return x;
}
