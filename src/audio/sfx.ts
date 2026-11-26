import { mulberry32 } from '../core/math.ts';
import { Biquad, OnePole, PinkGen, ad, fadeEdges, midiHz, type Rng } from './dsp.ts';
import { pluckInto } from './strings.ts';

// Offline recipes for the one-shot sounds. Each returns one (mono) or two
// (stereo) channels peak-normalised to ~0.9; playback gain sets the level.

export type SfxName =
  | 'splashSmall'
  | 'splashBig'
  | 'land'
  | 'hardLand'
  | 'crash'
  | 'pop'
  | 'kiteDown'
  | 'relaunch'
  | 'ui'
  | 'cheer'
  | 'checkpoint'
  | 'whale'
  | 'gull'
  | 'slap'
  | 'lap'
  | 'pick';

export const SFX_VARIANTS: Record<SfxName, number> = {
  splashSmall: 2,
  splashBig: 2,
  land: 2,
  hardLand: 2,
  crash: 2,
  pop: 2,
  kiteDown: 1,
  relaunch: 1,
  ui: 2,
  cheer: 3,
  checkpoint: 1,
  whale: 2,
  gull: 3,
  slap: 4,
  lap: 3,
  pick: 2,
};

type Fn = (t: number) => number;
type FilterKind = 'lp' | 'hp' | 'bp';

interface Band {
  at?: number;
  dur: number;
  kind: FilterKind;
  freq: Fn | number;
  q: number;
  env: Fn;
  gain: number;
  /** Pink rather than white source; band-passed white noise leaks a lot of hiss through the skirts. */
  pink?: boolean;
  /** A second identical stage for steeper skirts. */
  steep?: boolean;
  /** Extra low-pass ceiling (Hz). */
  top?: number;
}

function setBiquad(bq: Biquad, kind: FilterKind, f: number, q: number, fs: number) {
  if (kind === 'lp') bq.lowpass(f, q, fs);
  else if (kind === 'hp') bq.highpass(f, q, fs);
  else bq.bandpass(f, q, fs);
}

/** Adds filtered noise (optionally swept) with an envelope. */
function band(out: Float32Array, fs: number, r: Rng, b: Band) {
  const f1 = new Biquad(), f2 = new Biquad();
  const ceil = b.top ? new Biquad().lowpass(b.top, 0.7, fs) : null;
  const pink = b.pink ? new PinkGen(r) : null;
  const fixed = b.freq;
  const freq = typeof fixed === 'number' ? () => fixed : fixed;
  const i0 = Math.max(0, Math.round((b.at ?? 0) * fs));
  const n = Math.min(out.length - i0, Math.round(b.dur * fs));
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    if ((i & 31) === 0) {
      const f = freq(t);
      setBiquad(f1, b.kind, f, b.q, fs);
      if (b.steep) setBiquad(f2, b.kind, f, b.q, fs);
    }
    let x = pink ? pink.next() : r() * 2 - 1;
    x = f1.run(x);
    if (b.steep) x = f2.run(x);
    if (ceil) x = ceil.run(x);
    out[i0 + i] += x * b.env(t) * b.gain;
  }
}

/** Adds a sine with a frequency contour and envelope. */
function tone(out: Float32Array, fs: number, start: number, dur: number, freq: Fn, env: Fn, gain: number) {
  const i0 = Math.max(0, Math.round(start * fs));
  const n = Math.min(out.length - i0, Math.round(dur * fs));
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    ph += (2 * Math.PI * freq(t)) / fs;
    out[i0 + i] += Math.sin(ph) * env(t) * gain;
  }
}

/** Falling water drops: short rising "plinks" (bubble resonances) scattered in time. */
function droplets(out: Float32Array, fs: number, r: Rng, count: number, t0: number, t1: number, fLo: number, fHi: number, gain: number) {
  for (let k = 0; k < count; k++) {
    const t = t0 + (t1 - t0) * Math.pow(r(), 1.5);
    const f0 = fLo * Math.pow(fHi / fLo, r());
    const amp = gain * (0.3 + 0.7 * r()) * (1 - (0.6 * (t - t0)) / Math.max(1e-3, t1 - t0));
    const damp = 0.043 * f0 + 0.0014 * Math.pow(f0, 1.5);
    const len = Math.min(0.06, 7 / damp);
    const i0 = Math.round(t * fs);
    const n = Math.min(out.length - i0, Math.round(len * fs));
    let ph = r() * 6.28;
    for (let i = 0; i < n; i++) {
      const tt = i / fs;
      ph += (2 * Math.PI * f0 * (1 + (0.5 * tt) / len)) / fs;
      out[i0 + i] += amp * Math.sin(ph) * Math.exp(-tt * damp) * (1 - Math.exp(-tt / 0.0004));
    }
  }
}

function lowpassAll(x: Float32Array, fs: number, f: number) {
  const bq = new Biquad().lowpass(f, 0.7, fs);
  for (let i = 0; i < x.length; i++) x[i] = bq.run(x[i]);
  return x;
}

const buf = (fs: number, sec: number) => new Float32Array(Math.round(sec * fs));
const env = (a: number, tau: number): Fn => (t) => ad(t, a, tau);

/** Removes infrasonic rumble, peak-normalises the channels together and fades their edges. */
function finish(fs: number, chans: Float32Array[], peak = 0.9) {
  for (const c of chans) {
    const hp = new Biquad().highpass(35, 0.7, fs);
    for (let i = 0; i < c.length; i++) c[i] = hp.run(c[i]);
  }
  let p = 0;
  for (const c of chans) for (let i = 0; i < c.length; i++) p = Math.max(p, Math.abs(c[i]));
  for (const c of chans) {
    if (p > 0) for (let i = 0; i < c.length; i++) c[i] *= peak / p;
    fadeEdges(c, fs, 0.0005, 0.03);
  }
  return chans;
}

function splash(fs: number, r: Rng, size: number) {
  const dur = 0.5 + 1.2 * size;
  const common = buf(fs, dur);
  tone(common, fs, 0, 0.35, (t) => (95 - 35 * size) * (0.6 + 0.4 * Math.exp(-t / 0.06)), env(0.003, 0.035 + 0.06 * size), 0.35 + 0.2 * size);
  band(common, fs, r, { dur: 0.3, kind: 'bp', freq: (t) => 420 - 150 * Math.min(1, t / 0.05), q: 1, pink: true, steep: true, env: env(0.002, 0.03 + 0.03 * size), gain: 2.4 });
  band(common, fs, r, { dur, kind: 'bp', freq: (t) => 500 + 1500 * Math.exp(-t / (0.07 + 0.12 * size)), q: 0.8, pink: true, top: 6500, env: env(0.008, 0.09 + 0.3 * size), gain: 2.2 });
  band(common, fs, r, { dur, kind: 'lp', freq: 600, q: 0.7, pink: true, env: env(0.01, 0.12 + 0.25 * size), gain: 1.1 * size });
  const chans = [0, 1].map(() => {
    const c = common.slice();
    band(c, fs, r, { dur, kind: 'hp', freq: 2400, q: 0.7, pink: true, top: 8000, env: (t) => ad(t, 0.03, 0.18 + 0.45 * size), gain: 0.9 });
    droplets(c, fs, r, Math.round(4 + 24 * size), 0.04, dur * 0.85, 600, 3800, 0.22);
    return c;
  });
  return finish(fs, chans);
}

function land(fs: number, r: Rng) {
  const x = buf(fs, 0.7);
  band(x, fs, r, { dur: 0.3, kind: 'bp', freq: 190, q: 1.3, pink: true, steep: true, env: env(0.0015, 0.035), gain: 3.2 });
  tone(x, fs, 0, 0.3, (t) => 58 + 27 * Math.exp(-t / 0.04), env(0.003, 0.05), 0.4);
  band(x, fs, r, { dur: 0.7, kind: 'bp', freq: (t) => 1300 + 1500 * Math.exp(-t / 0.12), q: 0.7, pink: true, top: 7000, env: env(0.01, 0.17), gain: 2.2 });
  band(x, fs, r, { dur: 0.7, kind: 'hp', freq: 3500, q: 0.7, pink: true, top: 9000, env: env(0.02, 0.25), gain: 0.6 });
  droplets(x, fs, r, 6, 0.05, 0.5, 700, 3200, 0.12);
  return finish(fs, [x]);
}

function hardLand(fs: number, r: Rng) {
  const x = buf(fs, 0.9);
  band(x, fs, r, { dur: 0.35, kind: 'bp', freq: 150, q: 1.1, pink: true, steep: true, env: env(0.0015, 0.05), gain: 3.4 });
  tone(x, fs, 0, 0.4, (t) => 45 + 25 * Math.exp(-t / 0.05), env(0.003, 0.08), 0.55);
  band(x, fs, r, { at: 0.075, dur: 0.15, kind: 'bp', freq: 260, q: 1.4, pink: true, steep: true, env: env(0.001, 0.02), gain: 1.6 });
  band(x, fs, r, { at: 0.16, dur: 0.15, kind: 'bp', freq: 240, q: 1.4, pink: true, steep: true, env: env(0.001, 0.02), gain: 1 });
  band(x, fs, r, { dur: 0.9, kind: 'bp', freq: (t) => 1000 + 1300 * Math.exp(-t / 0.14), q: 0.7, pink: true, top: 6500, env: env(0.008, 0.22), gain: 2.6 });
  band(x, fs, r, { dur: 0.9, kind: 'hp', freq: 3200, q: 0.7, pink: true, top: 8500, env: env(0.02, 0.3), gain: 0.7 });
  droplets(x, fs, r, 10, 0.06, 0.7, 600, 3400, 0.15);
  return finish(fs, [x]);
}

function crash(fs: number, r: Rng) {
  const dur = 2.2;
  const common = buf(fs, dur);
  tone(common, fs, 0, 0.6, (t) => 38 + 17 * Math.exp(-t / 0.08), env(0.004, 0.16), 0.6);
  band(common, fs, r, { dur: 0.4, kind: 'bp', freq: (t) => 300 - 100 * Math.min(1, t / 0.08), q: 0.8, pink: true, steep: true, env: env(0.002, 0.06), gain: 3.2 });
  band(common, fs, r, { dur, kind: 'bp', freq: (t) => 420 + 1400 * Math.exp(-t / 0.25), q: 0.7, pink: true, top: 6000, env: env(0.01, 0.45), gain: 3 });
  band(common, fs, r, { dur, kind: 'lp', freq: 500, q: 0.7, pink: true, env: env(0.02, 0.5), gain: 1.4 });
  // Head under water: a muffled, bubbly gloop.
  band(common, fs, r, { at: 0.35, dur: 1.5, kind: 'lp', freq: 350, q: 0.7, pink: true, env: (t) => Math.sin(Math.PI * Math.min(1, t / 1.5)) ** 2, gain: 0.5 });
  droplets(common, fs, r, 18, 0.35, 1.8, 150, 520, 0.25);
  const chans = [0, 1].map(() => {
    const c = common.slice();
    band(c, fs, r, { dur, kind: 'hp', freq: 2400, q: 0.7, pink: true, top: 8000, env: env(0.04, 0.7), gain: 1.1 });
    droplets(c, fs, r, 34, 0.08, 1.9, 600, 3800, 0.25);
    return c;
  });
  return finish(fs, chans);
}

function pop(fs: number, r: Rng) {
  const x = buf(fs, 0.6);
  band(x, fs, r, { dur: 0.6, kind: 'bp', freq: (t) => 300 * Math.pow(2400 / 300, Math.min(1, t / 0.28)), q: 1.1, pink: true, top: 7000, env: env(0.045, 0.14), gain: 3 });
  band(x, fs, r, { dur: 0.3, kind: 'hp', freq: 2200, q: 0.7, pink: true, top: 8000, env: env(0.003, 0.06), gain: 1.8 });
  band(x, fs, r, { dur: 0.5, kind: 'bp', freq: 140, q: 0.8, pink: true, env: env(0.04, 0.12), gain: 1.4 });
  return finish(fs, [x]);
}

function kiteDown(fs: number, r: Rng) {
  const pre = 0.06;
  const x = buf(fs, 1.4);
  [0, 0.085, 0.15].forEach((t, i) => band(x, fs, r, { at: pre + t, dur: 0.1, kind: 'bp', freq: 850, q: 0.9, pink: true, env: env(0.0015, 0.018), gain: 1.6 - i * 0.3 }));
  tone(x, fs, pre + 0.2, 0.5, (t) => 48 + 24 * Math.exp(-t / 0.05), env(0.008, 0.1), 0.35);
  band(x, fs, r, { at: pre + 0.2, dur: 0.6, kind: 'lp', freq: 420, q: 0.7, pink: true, env: env(0.008, 0.14), gain: 1 });
  band(x, fs, r, { at: pre + 0.21, dur: 1, kind: 'bp', freq: (t) => 450 + 700 * Math.exp(-t / 0.1), q: 0.7, pink: true, env: env(0.015, 0.32), gain: 2.4 });
  droplets(x, fs, r, 8, pre + 0.3, 0.9, 500, 2000, 0.08);
  lowpassAll(x, fs, 2600);
  return finish(fs, [x]);
}

function relaunch(fs: number, r: Rng) {
  const x = buf(fs, 1.7);
  droplets(x, fs, r, 12, 0, 0.7, 700, 2600, 0.12);
  band(x, fs, r, { dur: 1.7, kind: 'bp', freq: (t) => 220 + 600 * Math.min(1, t / 0.9), q: 0.8, pink: true, env: (t) => (t < 0.85 ? (t / 0.85) ** 2 : Math.exp(-(t - 0.85) / 0.2)), gain: 2.2 });
  [0.3, 0.52, 0.68].forEach((t, i) => band(x, fs, r, { at: t, dur: 0.1, kind: 'bp', freq: 800, q: 1, pink: true, env: env(0.0015, 0.02), gain: 0.8 + i * 0.15 }));
  tone(x, fs, 0.86, 0.4, (t) => 62 + 33 * Math.exp(-t / 0.04), env(0.006, 0.09), 0.45);
  band(x, fs, r, { at: 0.86, dur: 0.5, kind: 'lp', freq: 360, q: 0.7, pink: true, env: env(0.006, 0.1), gain: 1 });
  return finish(fs, [x]);
}

function ui(fs: number, r: Rng, v: number) {
  const x = buf(fs, 0.09);
  const f = v ? 1320 : 1180;
  tone(x, fs, 0, 0.09, () => f, env(0.0008, 0.016), 0.7);
  tone(x, fs, 0, 0.05, () => f * 2.24, env(0.0005, 0.007), 0.25);
  band(x, fs, r, { dur: 0.01, kind: 'hp', freq: 3000, q: 0.7, top: 9000, env: env(0.0002, 0.0018), gain: 0.25 });
  return finish(fs, [x], 0.85);
}

function checkpoint(fs: number) {
  const x = buf(fs, 1.9);
  const bell = (f: number, t0: number, amp: number) => {
    const partials: [number, number, number][] = [
      [1, 1, 0.9],
      [1.0018, 0.25, 0.8],
      [2, 0.15, 0.35],
      [4, 0.28, 0.3],
      [10, 0.04, 0.08],
    ];
    for (const [k, a, tau] of partials) tone(x, fs, t0, Math.min(1.9 - t0, tau * 8), () => f * k, env(0.003, tau), a * amp);
  };
  bell(midiHz(81), 0, 1);
  bell(midiHz(86), 0.12, 1);
  return finish(fs, [x], 0.85);
}

function whale(fs: number, r: Rng, v: number) {
  const k = v ? 0.85 : 1;
  const x = buf(fs, 2.8);
  // Turbulent exhale with a slow random roughness, then a shorter inhale.
  const am = new OnePole(25, fs);
  const ex = buf(fs, 1.5);
  band(ex, fs, r, { dur: 1.5, kind: 'bp', freq: 650 * k, q: 0.6, pink: true, env: env(0.07, 0.42 / k), gain: 2.6 });
  band(ex, fs, r, { dur: 1.5, kind: 'lp', freq: 260 * k, q: 0.7, pink: true, env: env(0.05, 0.3 / k), gain: 0.5 });
  for (let i = 0; i < ex.length; i++) x[i] += ex[i] * (0.75 + 1.2 * am.run(r() * 2 - 1));
  tone(x, fs, 0, 0.8, (t) => (62 + 16 * Math.exp(-t / 0.15)) * k, env(0.03, 0.18), 0.08);
  const t1 = 1.45 + 0.2 * v;
  band(x, fs, r, { at: t1, dur: 1.2, kind: 'bp', freq: (t) => 700 + 500 * Math.min(1, t / 0.5), q: 0.8, pink: true, env: env(0.18, 0.16), gain: 1.1 });
  lowpassAll(x, fs, 2600);
  return finish(fs, [x]);
}

/** Yellow-footed / Heermann's gull: nasal, harmonic-rich calls with a fast rise and slow fall. */
function gull(fs: number, r: Rng, v: number) {
  const notes: { t: number; len: number; f: number; amp: number; long?: boolean }[] = [];
  if (v === 0) [0, 0.34, 0.66].forEach((t, i) => notes.push({ t, len: 0.23, f: 1150 * Math.pow(0.97, i), amp: 1 - i * 0.1 }));
  else if (v === 1) notes.push({ t: 0, len: 0.62, f: 1250, amp: 1, long: true });
  else for (let i = 0; i < 5; i++) notes.push({ t: i * 0.15, len: i === 4 ? 0.2 : 0.1, f: 1000 * Math.pow(0.98, i), amp: 0.85 + 0.15 * r() });
  const last = notes[notes.length - 1];
  const x = buf(fs, last.t + last.len + 0.15);
  const amps = [1, 0.75, 0.5, 0.36, 0.22, 0.13, 0.07];
  for (const nt of notes) {
    const i0 = Math.round(nt.t * fs);
    const n = Math.round(nt.len * fs);
    let ph = 0;
    for (let i = 0; i < n && i0 + i < x.length; i++) {
      const t = i / fs;
      const u = i / n;
      const c = nt.long
        ? u < 0.13 ? 0.85 + 0.5 * (u / 0.13) : u < 0.75 ? 1.35 - 0.1 * (u - 0.13) : 1.29 - 0.6 * ((u - 0.75) / 0.25)
        : u < 0.22 ? 0.8 + 0.45 * Math.sin(((u / 0.22) * Math.PI) / 2) : 1.25 - 0.57 * Math.pow((u - 0.22) / 0.78, 1.2);
      ph += (2 * Math.PI * nt.f * c) / fs;
      let s = 0;
      for (let h = 0; h < amps.length; h++) s += amps[h] * Math.sin(ph * (h + 1));
      const e = Math.min(1, t / 0.018) * Math.min(1, (nt.len - t) / 0.05) * (1 - 0.25 * u);
      x[i0 + i] += s * nt.amp * e * (1 + 0.22 * Math.sin(2 * Math.PI * 88 * t));
    }
  }
  // Nasal formant plus a little breath.
  const bp = new Biquad().bandpass(2800, 1.3, fs);
  for (let i = 0; i < x.length; i++) x[i] = 0.55 * x[i] + 1.2 * bp.run(x[i]);
  for (const nt of notes) band(x, fs, r, { at: nt.t, dur: nt.len, kind: 'hp', freq: 3500, q: 0.7, top: 8000, env: (t) => Math.min(1, t / 0.02) * Math.max(0, 1 - t / nt.len), gain: 0.08 });
  lowpassAll(x, fs, 4500);
  return finish(fs, [x]);
}

function slap(fs: number, r: Rng) {
  const k = 0.85 + 0.3 * r();
  const x = buf(fs, 0.16);
  band(x, fs, r, { dur: 0.16, kind: 'bp', freq: 210 * k, q: 1.4, pink: true, steep: true, env: env(0.0015, 0.028), gain: 4 });
  tone(x, fs, 0, 0.12, (t) => k * (85 + 30 * Math.exp(-t / 0.02)), env(0.002, 0.022), 0.3);
  band(x, fs, r, { dur: 0.05, kind: 'bp', freq: 1000 * k, q: 1.2, pink: true, steep: true, env: env(0.0008, 0.009), gain: 4.5 });
  band(x, fs, r, { dur: 0.16, kind: 'hp', freq: 2500, q: 0.7, pink: true, top: 7000, env: env(0.004, 0.045), gain: 0.5 });
  return finish(fs, [x]);
}

function lap(fs: number, r: Rng) {
  const x = buf(fs, 0.55);
  const k = 0.85 + 0.3 * r();
  band(x, fs, r, { dur: 0.55, kind: 'bp', freq: (t) => k * (300 + 400 * Math.sin(Math.PI * Math.min(1, t / 0.35))), q: 0.8, pink: true, env: env(0.07, 0.11), gain: 2.4 });
  tone(x, fs, 0.05, 0.12, (t) => k * (260 + 1300 * t), env(0.003, 0.03), 0.25);
  tone(x, fs, 0.14, 0.1, (t) => k * (330 + 1600 * t), env(0.003, 0.025), 0.15);
  return finish(fs, [x]);
}

/** Nail/pick noise of a strum stroke; the muted variant is the percussive chasquido. */
function pick(fs: number, r: Rng, v: number) {
  const x = buf(fs, 0.05);
  band(x, fs, r, { dur: 0.05, kind: 'bp', freq: v ? 1800 : 3000, q: 0.9, steep: true, env: env(0.001, v ? 0.012 : 0.006), gain: 1 });
  if (v) band(x, fs, r, { dur: 0.05, kind: 'lp', freq: 260, q: 0.8, pink: true, env: env(0.001, 0.015), gain: 2 });
  return finish(fs, [x]);
}

/** A short friendly rasgueo flourish on the nylon guitars, in D like the menu tune. */
function cheer(fs: number, r: Rng, v: number) {
  const x = buf(fs, 1.7);
  const add = (t: number, midi: number, gain: number, bright = 0.4) =>
    pluckInto(x, Math.round(t * fs), { freq: midiHz(midi), sampleRate: fs, seconds: 1.7 - t, t60: 2.2, bright, damping: 16, position: 0.16, seed: Math.floor(r() * 1e9) }, gain);
  const strum = (t: number, notes: number[], gain: number, up = false, spread = 0.012) =>
    (up ? [...notes].reverse() : notes).forEach((m, i) => add(t + i * spread, m, gain * (0.85 + 0.3 * r())));
  const D = [62, 66, 69, 74, 78];
  if (v === 0) {
    // Four-finger rasgueado roll into a ringing chord.
    [0, 0.055, 0.11, 0.165].forEach((t, i) => strum(t, D, 0.22, i % 2 === 1, 0.008));
    strum(0.3, D, 0.32, false, 0.016);
    add(0.31, 81, 0.5, 0.6);
  } else if (v === 1) {
    [74, 76, 78, 79, 81].forEach((m, i) => add(i * 0.06, m, 0.42, 0.6));
    strum(0.32, D, 0.3, false, 0.014);
    add(0.33, 86, 0.45, 0.6);
  } else {
    strum(0, [57, 61, 64, 67, 69, 73], 0.26, false, 0.014);
    strum(0.28, D, 0.32, false, 0.014);
    add(0.29, 86, 0.5, 0.6);
  }
  return finish(fs, [x], 0.85);
}

export function renderSfx(name: SfxName, variant: number, fs: number): Float32Array[] {
  const r = mulberry32(0x5eed + variant * 7919 + name.length * 104729 + name.charCodeAt(0) * 31);
  switch (name) {
    case 'splashSmall':
      return splash(fs, r, 0.25 + 0.1 * variant);
    case 'splashBig':
      return splash(fs, r, 0.85 + 0.15 * variant);
    case 'land':
      return land(fs, r);
    case 'hardLand':
      return hardLand(fs, r);
    case 'crash':
      return crash(fs, r);
    case 'pop':
      return pop(fs, r);
    case 'kiteDown':
      return kiteDown(fs, r);
    case 'relaunch':
      return relaunch(fs, r);
    case 'ui':
      return ui(fs, r, variant);
    case 'cheer':
      return cheer(fs, r, variant);
    case 'checkpoint':
      return checkpoint(fs);
    case 'whale':
      return whale(fs, r, variant);
    case 'gull':
      return gull(fs, r, variant);
    case 'slap':
      return slap(fs, r);
    case 'lap':
      return lap(fs, r);
    case 'pick':
      return pick(fs, r, variant);
  }
}
