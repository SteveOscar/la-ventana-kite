import { mulberry32 } from '../core/math.ts';
import type { Rng } from './dsp.ts';
import type { StringInstrument } from './strings.ts';

// An original son-style tune in a lilting 6/8 that drops into 3/4 at cadences and
// through the minor bridge (sesquiáltera), for nylon guitar strums, a requinto
// lead (in thirds on repeats, trío style) and a guitarrón bass. The written
// material is fixed; each cycle re-plans textures, voicings, ornaments, bass walks
// and the key, so a full pass (~2.3 min) never repeats a section verbatim.

export interface NoteEvent {
  /** Seconds from the start of the bar (may be slightly negative for grace notes). */
  t: number;
  midi: number;
  vel: number;
  inst: StringInstrument;
  /** A new note on the same instrument and voice damps the previous one (strings, monophonic lines). */
  voice: number;
  /** Damp the note this many seconds after it starts (muted strokes). */
  cut?: number;
  /** Strum-stroke noise level for the first string of a stroke; `muted` selects the chasquido. */
  pick?: number;
  muted?: boolean;
}

export interface Bar {
  seconds: number;
  events: NoteEvent[];
  label: string;
}

export interface BarSource {
  next(): Bar;
}

interface Chord {
  root: number;
  tones: number[];
  minor: boolean;
}

interface BarSpec {
  chords: Chord[];
  /** 6 = 6/8 (two dotted beats), 3 = 3/4 (three quarter beats); a bar is always six eighths. */
  meter: 6 | 3;
  mel: [number | null, number][];
}

const PC: Record<string, number> = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
const mod12 = (x: number) => ((x % 12) + 12) % 12;

function chord(name: string): Chord {
  const m = /^([A-G](?:#|b)?)(m|7)?$/.exec(name);
  if (!m) throw new Error(`bad chord ${name}`);
  const root = PC[m[1]];
  const iv = m[2] === 'm' ? [0, 3, 7] : m[2] === '7' ? [0, 4, 7, 10] : [0, 4, 7];
  return { root, tones: iv.map((i) => mod12(root + i)), minor: m[2] === 'm' };
}

function note(s: string): number | null {
  if (s === 'r') return null;
  const m = /^([A-G](?:#|b)?)(\d)$/.exec(s);
  if (!m) throw new Error(`bad note ${s}`);
  return 12 * (Number(m[2]) + 1) + PC[m[1]];
}

function bar(chords: string, mel: string, meter: 6 | 3 = 6): BarSpec {
  return {
    chords: chords.split(' ').map(chord),
    meter,
    mel: mel.split(' ').map((tok) => {
      const [n, d] = tok.split('/');
      return [note(n), Number(d)];
    }),
  };
}

type SectionName = 'intro' | 'A' | 'A2' | 'B' | 'B2' | 'inter' | 'coda' | 'rest';

/** Written in D major; transposed per cycle. Durations are in eighths (six per bar). */
export const SECTIONS: Record<SectionName, BarSpec[]> = {
  intro: [bar('D', 'r/6'), bar('G', 'r/6'), bar('A7', 'E5/1 G5/1 E5/1 C#5/1 E5/1 A4/1'), bar('D', 'D5/3 r/3', 3)],
  A: [
    bar('D', 'F#4/2 A4/1 D5/2 C#5/1'),
    bar('G', 'B4/3 G4/2 B4/1'),
    bar('A7', 'A4/2 G4/1 E4/2 C#5/1'),
    bar('D', 'D5/3 A4/3', 3),
    bar('D', 'F#4/2 A4/1 D5/2 E5/1'),
    bar('Bm', 'F#5/3 D5/2 B4/1'),
    bar('E7', 'G#4/2 B4/1 E5/2 D5/1'),
    bar('A7', 'C#5/3 r/3', 3),
  ],
  A2: [
    bar('D', 'F#4/2 A4/1 D5/2 C#5/1'),
    bar('G', 'B4/3 G4/2 B4/1'),
    bar('A7', 'A4/2 G4/1 E4/2 C#5/1'),
    bar('D', 'D5/3 A4/1 B4/1 C5/1', 3),
    bar('D7', 'D5/2 C5/1 A4/2 F#4/1'),
    bar('G Gm', 'G4/2 B4/1 Bb4/2 G4/1'),
    bar('D A7', 'F#4/2 A4/1 G4/2 E4/1'),
    bar('D', 'D4/3 r/3', 3),
  ],
  B: [
    bar('Bm', 'B4/2 C#5/2 D5/2', 3),
    bar('F#7', 'C#5/3 A#4/2 F#4/1'),
    bar('Bm', 'B4/2 D5/2 F#5/2', 3),
    bar('Bm', 'E5/2 D5/1 C#5/2 B4/1'),
    bar('Em', 'G5/2 F#5/2 E5/2', 3),
    bar('A7', 'C#5/2 E5/2 G5/2', 3),
    bar('D', 'F#5/3 D5/2 A4/1'),
    bar('F#7', 'A#4/2 C#5/1 E5/3'),
  ],
  B2: [
    bar('Bm', 'D5/2 C#5/2 B4/2', 3),
    bar('F#7', 'A#4/3 C#5/2 F#5/1'),
    bar('Bm', 'F#5/2 D5/2 B4/2', 3),
    bar('B7', 'D#5/2 C#5/1 B4/2 A4/1'),
    bar('Em', 'G4/2 B4/2 E5/2', 3),
    bar('Gm', 'D5/3 Bb4/2 G4/1'),
    bar('D A7', 'F#4/2 A4/1 C#5/2 E5/1'),
    bar('D', 'D5/3 r/3'),
  ],
  inter: [
    bar('G', 'B4/1 D5/1 G5/1 D5/1 B4/1 D5/1'),
    bar('D', 'A4/1 D5/1 F#5/1 D5/1 A4/1 D5/1'),
    bar('A7', 'G4/1 C#5/1 E5/1 G5/1 E5/1 C#5/1'),
    bar('D', 'D5/2 F#5/1 A5/3', 3),
  ],
  coda: [bar('A7', 'E5/2 C#5/1 A4/2 G4/1'), bar('D', 'F#4/3 D4/3')],
  rest: [bar('D', 'r/6')],
};

type MelMode = 'solo' | 'thirds' | 'low' | 'sparse' | 'none';
type CompMode = 'strum' | 'arp' | 'light' | 'final' | 'none';

interface SectionPlan {
  sec: SectionName;
  mel: MelMode;
  comp: CompMode;
  walk: boolean;
  bass: boolean;
  /** Probability of grace notes and passing tones. */
  orn: number;
  dyn: number;
  /** Lowest strum-voicing pitch the voice leading gravitates to. */
  center: number;
  fill: boolean;
}

interface Stroke {
  down: boolean;
  vel: number;
  muted?: boolean;
}

const D = (vel: number, muted = false): Stroke => ({ down: true, vel, muted });
const U = (vel: number): Stroke => ({ down: false, vel });
const STRUM_68: (Stroke | null)[][] = [
  [D(1), null, U(0.45), D(0.75), null, U(0.5)],
  [D(1), U(0.35), U(0.45), D(0.8), U(0.35), U(0.5)],
  [D(1), null, U(0.4), D(0.8, true), null, U(0.45)],
];
const STRUM_34: (Stroke | null)[][] = [
  [D(1), null, D(0.7), U(0.4), D(0.7), U(0.4)],
  [D(1), U(0.35), D(0.75, true), U(0.4), D(0.7), null],
];
/** Finger-picked broken chords: indexes into the voicing, low to high. */
const ARP_68 = [0, 2, 3, 4, 3, 2];
const ARP_34 = [0, 3, 2, 4, 1, 3];
/** Key offsets from D for successive cycles: D, G (below), C. */
const KEYS = [0, -7, -2];
const MAJOR = [0, 2, 4, 5, 7, 9, 11];

function pick<T>(r: Rng, xs: T[]): T {
  return xs[Math.floor(r() * xs.length)];
}

function makePlan(r: Rng): SectionPlan[] {
  const center = () => pick(r, [49, 50, 52, 53, 55]);
  const p = (sec: SectionName, mel: MelMode, comp: CompMode, walk: boolean, orn: number, dyn: number, fill = false): SectionPlan => ({
    sec,
    mel,
    comp,
    walk,
    bass: sec !== 'rest',
    orn,
    dyn,
    center: center(),
    fill,
  });
  return [
    p('intro', 'solo', pick(r, ['strum', 'arp']), false, 0, 0.7),
    p('A', 'solo', 'strum', false, 0.05, 0.82),
    p('A2', 'solo', 'strum', true, 0.1, 0.85, r() < 0.5),
    p('B', pick(r, ['solo', 'low']), pick(r, ['strum', 'arp']), false, 0.1, 0.9),
    p('B2', 'thirds', 'strum', true, 0.15, 0.95, r() < 0.6),
    p('inter', pick(r, ['solo', 'thirds']), 'light', false, 0, 0.75),
    p('A', 'thirds', pick(r, ['strum', 'arp']), true, 0.25, 0.88),
    p('A2', pick(r, ['thirds', 'solo']), 'strum', true, 0.3, 0.9, r() < 0.6),
    p('B', pick(r, ['low', 'sparse', 'solo']), 'arp', false, 0.2, 0.8),
    p('B2', 'thirds', 'strum', true, 0.25, 0.95, true),
    p('coda', 'solo', 'final', false, 0, 0.8),
    p('rest', 'none', 'none', false, 0, 0),
  ];
}

/** The menu piece. Deterministic for a given seed. */
export class Composer implements BarSource {
  private r: Rng;
  private cycle = 0;
  private plan: SectionPlan[] = [];
  private sec = 0;
  private barIdx = 0;
  private key = 0;
  private eighth = 0.31;
  private prevVoicing: number[] = [];
  private prevBass = 38;
  private pat68: (Stroke | null)[] = STRUM_68[0];
  private pat34: (Stroke | null)[] = STRUM_34[0];

  constructor(seed: number) {
    this.r = mulberry32(seed);
    this.newCycle();
  }

  private newCycle() {
    this.key = KEYS[this.cycle % KEYS.length];
    this.eighth = 0.31 * (0.97 + 0.06 * this.r());
    this.plan = makePlan(this.r);
    this.sec = 0;
    this.barIdx = 0;
    this.newSection();
  }

  private newSection() {
    this.pat68 = pick(this.r, STRUM_68);
    this.pat34 = pick(this.r, STRUM_34);
  }

  /** Spec of the bar after the current one, for bass walks and fills. */
  private peek(): BarSpec {
    const p = this.plan[this.sec];
    if (this.barIdx + 1 < SECTIONS[p.sec].length) return SECTIONS[p.sec][this.barIdx + 1];
    const np = this.plan[(this.sec + 1) % this.plan.length];
    return SECTIONS[np.sec][0];
  }

  next(): Bar {
    const p = this.plan[this.sec];
    const specs = SECTIONS[p.sec];
    const spec = specs[this.barIdx];
    const lastOfSection = this.barIdx === specs.length - 1;
    const b = this.render(spec, p, this.peek(), lastOfSection);
    this.barIdx++;
    if (this.barIdx >= specs.length) {
      this.barIdx = 0;
      this.sec++;
      if (this.sec >= this.plan.length) {
        this.cycle++;
        this.newCycle();
      } else this.newSection();
    }
    return b;
  }

  private render(spec: BarSpec, p: SectionPlan, next: BarSpec, last: boolean): Bar {
    const r = this.r;
    const key = this.key;
    let e = this.eighth;
    if (p.sec === 'coda') e *= last ? 1.22 : 1.08;
    const events: NoteEvent[] = [];
    const label = `${p.sec}:${this.barIdx}`;
    if (p.sec === 'rest') return { seconds: 4 * e, events, label };
    const swell = 0.94 + 0.06 * Math.sin((Math.PI * (this.barIdx % 4)) / 3);
    const dyn = p.dyn * swell;
    const halves = spec.chords.length === 2 ? [0, 3] : [0];
    const chordAt = (slot: number) => (spec.chords.length === 2 && slot >= 3 ? spec.chords[1] : spec.chords[0]);
    const jit = (s: number) => (r() * 2 - 1) * s;

    // Accompaniment.
    const comp = p.comp === 'final' && !last ? 'strum' : p.comp;
    halves.forEach((from, hi) => {
      const to = halves[hi + 1] ?? 6;
      const v = this.voicing(chordAt(from), key, p.center);
      for (let slot = from; slot < to; slot++) {
        const t = slot * e;
        if (comp === 'strum') {
          const s = (spec.meter === 6 ? this.pat68 : this.pat34)[slot];
          if (s) this.strum(events, t + jit(0.004), v, s, dyn);
        } else if (comp === 'arp') {
          const idx = (spec.meter === 6 ? ARP_68 : ARP_34)[slot];
          const m = v[Math.min(idx, v.length - 1)];
          events.push({ t: t + jit(0.006), midi: m, vel: (slot === from ? 0.62 : 0.5) * dyn * (0.9 + 0.2 * r()), inst: 'guitar', voice: Math.min(idx, v.length - 1) });
        } else if (comp === 'light') {
          const beat = spec.meter === 6 ? slot % 3 === 0 : slot % 2 === 0;
          if (beat) this.strum(events, t + jit(0.004), v, D(slot === from ? 0.62 : 0.45), dyn);
        } else if (comp === 'final' && slot === from) {
          this.strum(events, t, v, D(0.8), dyn, 0.09);
        }
      }
    });

    // Guitarrón: root and fifth on the beats, approach notes into chord changes.
    if (p.bass) {
      const slots = halves.length === 2 ? [0, 3] : spec.meter === 6 ? [0, 3] : [0, 4];
      slots.forEach((slot, i) => {
        const ch = chordAt(slot);
        const root = this.bassNear(mod12(ch.root + key));
        const isFifth = halves.length === 1 && i === 1;
        const m = isFifth ? (root + 7 <= 52 ? root + 7 : root - 5) : root;
        events.push({ t: slot * e + jit(0.005), midi: m, vel: (i === 0 ? 0.95 : 0.75) * dyn, inst: 'bass', voice: 0 });
        if (!isFifth) this.prevBass = root;
      });
      const nextRoot = mod12(next.chords[0].root + key);
      const lastChord = spec.chords[spec.chords.length - 1];
      if (p.walk && nextRoot !== mod12(lastChord.root + key) && !(p.comp === 'final' && last)) {
        const target = this.bassNear(nextRoot);
        const scale = MAJOR.map((x) => mod12(x + 2 + key));
        const below = [target - 2, target - 1].find((x) => scale.includes(mod12(x)));
        const above = [target + 2, target + 1].find((x) => scale.includes(mod12(x)));
        // Step into the next root from whichever side is closer, never repeating the last note.
        const last = slots.length ? events.filter((x) => x.inst === 'bass').pop()?.midi ?? target : target;
        const options = [below, above].filter((x): x is number => x !== undefined && x !== last);
        options.sort((a, b) => Math.abs(a - last) - Math.abs(b - last));
        const approach = options[0];
        if (approach !== undefined) events.push({ t: 5 * e + jit(0.005), midi: approach, vel: 0.6 * dyn, inst: 'bass', voice: 0 });
      }
    }

    // Melody.
    if (p.mel !== 'none') {
      let slot = 0;
      const mel = spec.mel;
      const lowLine = p.mel === 'low';
      mel.forEach(([pitch, len], ni) => {
        if (pitch !== null) {
          const m = pitch + key;
          const t = slot * e;
          const strong = spec.meter === 6 ? slot % 3 === 0 : slot % 2 === 0;
          const vel = (strong ? 0.95 : 0.8) * dyn * (0.92 + 0.12 * r());
          const ch = chordAt(slot);
          const scale = chordScale(ch, key);
          if (p.mel !== 'sparse' || (strong && len >= 2)) this.melNote(events, p.mel, t + jit(0.007), m, vel, ch, key);
          const nextPitch = mel[ni + 1]?.[0];
          if (p.mel !== 'sparse' && p.orn > 0) {
            if (len >= 2 && strong && r() < p.orn) {
              // Grace note from a step away, damped by the main note.
              events.push({ t: t - 0.055, midi: stepInScale(m, r() < 0.6 ? 1 : -1, scale) - (lowLine ? 12 : 0), vel: vel * 0.5, inst: lowLine ? 'guitar' : 'requinto', voice: lowLine ? 7 : 0 });
            }
            if (len === 3 && nextPitch != null && r() < p.orn * 0.6) {
              // Passing tone on the last eighth of a long note, toward the next one.
              const pass = stepInScale(m, Math.sign(nextPitch + key - m) || 1, scale);
              this.melNote(events, p.mel, (slot + 2) * e + jit(0.006), pass, vel * 0.8, ch, key);
            }
          }
        } else if (p.fill && last && len >= 3 && slot >= 3) {
          // Requinto run up into the next section's first note.
          const target = next.mel.find(([n]) => n !== null)?.[0];
          if (target != null) {
            const scale = MAJOR.map((x) => mod12(x + 2 + key));
            let m = target + key;
            const run: number[] = [];
            for (let k = 0; k < 3; k++) {
              m = stepInScale(m, -1, scale);
              run.unshift(m);
            }
            run.forEach((n, k) => events.push({ t: (slot + k) * e + jit(0.006), midi: n, vel: 0.7 * dyn, inst: 'requinto', voice: 0 }));
          }
        }
        slot += len;
      });
    }
    return { seconds: 6 * e, events, label };
  }

  private melNote(events: NoteEvent[], mode: MelMode, t: number, m: number, vel: number, ch: Chord, key: number) {
    if (mode === 'low') {
      events.push({ t, midi: m - 12, vel: vel * 0.95, inst: 'guitar', voice: 7 });
      return;
    }
    events.push({ t, midi: m, vel, inst: 'requinto', voice: 0 });
    if (mode === 'thirds') {
      const h = thirdBelow(m, chordScale(ch, key), ch.tones.map((x) => mod12(x + key)));
      if (h !== null && h >= 55) events.push({ t: t + 0.004, midi: h, vel: vel * 0.62, inst: 'requinto', voice: 1 });
    }
  }

  private strum(events: NoteEvent[], t: number, v: number[], s: Stroke, dyn: number, spread?: number) {
    const notes = s.down ? v : v.slice(-3).reverse();
    const total = spread ?? (s.down ? 0.032 : 0.02) * (1.1 - 0.5 * s.vel);
    const step = notes.length > 1 ? total / (notes.length - 1) : 0;
    notes.forEach((m, i) => {
      events.push({
        t: t + i * step,
        midi: m,
        vel: s.vel * dyn * (0.85 + 0.25 * this.r()) * (s.down && i === 0 ? 1.05 : 0.95),
        inst: 'guitar',
        voice: v.indexOf(m),
        cut: s.muted ? 0.05 : undefined,
        pick: i === 0 ? s.vel * dyn : undefined,
        muted: s.muted,
      });
    });
  }

  /** Chooses a voicing near `center`, preferring small moves from the previous chord. */
  private voicing(ch: Chord, key: number, center: number) {
    let best: number[] = [];
    let bestCost = Infinity;
    for (let low = center - 3; low <= center + 3; low++) {
      const v = buildVoicing(ch, key, low);
      const prev = this.prevVoicing;
      const cost = prev.length
        ? Math.abs(avg(v) - avg(prev)) * 2 + Math.abs(v[v.length - 1] - prev[prev.length - 1]) + Math.abs(low - center) * 0.5
        : Math.abs(low - center);
      const c = cost + this.r() * 2;
      if (c < bestCost) {
        bestCost = c;
        best = v;
      }
    }
    this.prevVoicing = best;
    return best;
  }

  /** Bass pitch for a pitch class within the guitarrón's range, nearest the last root. */
  private bassNear(pc: number) {
    let best = 38, bestD = Infinity;
    for (let m = 36; m <= 50; m++) {
      if (mod12(m) !== pc) continue;
      const d = Math.abs(m - this.prevBass);
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    return best;
  }
}

function avg(v: number[]) {
  return v.reduce((a, b) => a + b, 0) / (v.length || 1);
}

/** Guitar-like spread voicing: wider intervals at the bottom, third (and seventh) always present. */
function buildVoicing(ch: Chord, key: number, low: number) {
  const tones = ch.tones.map((x) => mod12(x + key));
  const out: number[] = [];
  for (const o of [0, 6, 11, 15, 19]) {
    const target = low + o;
    let bestP = -1, bestD = 99;
    for (let q = target - 3; q <= target + 3; q++) {
      if (!tones.includes(mod12(q)) || (out.length && q <= out[out.length - 1])) continue;
      const d = Math.abs(q - target);
      if (d < bestD) {
        bestD = d;
        bestP = q;
      }
    }
    if (bestP >= 0) out.push(bestP);
  }
  const need = [tones[1], ...(tones.length > 3 ? [tones[3]] : [])];
  for (const pc of need) {
    if (out.some((q) => mod12(q) === pc)) continue;
    // Replace a doubled tone (not the lowest) with the nearest missing one.
    let bestI = -1, bestQ = 0, bestD = 99;
    for (let i = 1; i < out.length; i++) {
      const dup = out.filter((q) => mod12(q) === mod12(out[i])).length > 1;
      if (!dup) continue;
      for (let q = out[i] - 3; q <= out[i] + 3; q++) {
        if (mod12(q) !== pc || out.includes(q)) continue;
        if (Math.abs(q - out[i]) < bestD) {
          bestD = Math.abs(q - out[i]);
          bestI = i;
          bestQ = q;
        }
      }
    }
    if (bestI >= 0) out[bestI] = bestQ;
    out.sort((a, b) => a - b);
  }
  return out;
}

/** Key scale with the chord's chromatic tones swapped in (G# over E7, Bb over Gm, C over D7...). */
function chordScale(ch: Chord, key: number) {
  const scale = MAJOR.map((x) => mod12(x + 2 + key));
  ch.tones.forEach((t0, i) => {
    const t = mod12(t0 + key);
    if (scale.includes(t)) return;
    // Thirds of major/dominant chords are raised; minor thirds and sevenths are lowered.
    const raised = i === 1 && !ch.minor;
    const j = scale.indexOf(mod12(raised ? t - 1 : t + 1));
    if (j >= 0) scale[j] = t;
  });
  return scale;
}

function stepInScale(m: number, dir: number, scale: number[]) {
  for (let k = 1; k <= 2; k++) {
    const q = m + dir * k;
    if (scale.includes(mod12(q))) return q;
  }
  return m + dir;
}

function thirdBelow(m: number, scale: number[], tones: number[]) {
  const cands = [m - 3, m - 4].filter((q) => scale.includes(mod12(q)));
  if (!cands.length) return null;
  cands.sort((a, b) => Number(tones.includes(mod12(b))) - Number(tones.includes(mod12(a))));
  return cands[0];
}

const SESSION_CHORDS = ['D', 'G', 'A7', 'D', 'Bm', 'Em', 'A7', 'D', 'G', 'Gm', 'D', 'A7'].map(chord);

/** Sparse, quiet guitar for under the wind: a phrase every 8–20 s, silence between. */
export class SessionComposer implements BarSource {
  private r: Rng;
  private wait = 2;
  private idx = 0;
  private eighth = 0.34;

  constructor(seed: number) {
    this.r = mulberry32(seed);
  }

  next(): Bar {
    const e = this.eighth;
    if (this.wait > 0) {
      this.wait--;
      return { seconds: 6 * e, events: [], label: 'session:rest' };
    }
    const r = this.r;
    const events: NoteEvent[] = [];
    const ch = SESSION_CHORDS[this.idx % SESSION_CHORDS.length];
    this.idx++;
    let bars = 1;
    if (r() < 0.55) {
      // Broken chord, low to high and back, with the low note let ring.
      const v = buildVoicing(ch, 0, 48 + Math.floor(r() * 6));
      const order = r() < 0.5 ? [0, 2, 3, 4, 3, 2, 1, 4] : [0, 1, 2, 3, 4, 2];
      order.forEach((i, k) => {
        const idx = Math.min(i, v.length - 1);
        events.push({ t: k * e * (order.length > 6 ? 0.75 : 1), midi: v[idx], vel: (k === 0 ? 0.6 : 0.42) * (0.9 + 0.2 * r()), inst: 'guitar', voice: idx });
      });
    } else {
      // Two bars of the tune on the requinto over one soft strum.
      const pool = [...SECTIONS.A, ...SECTIONS.B, ...SECTIONS.A2];
      const start = Math.floor(r() * (pool.length - 1));
      bars = 2;
      for (let b = 0; b < 2; b++) {
        const spec = pool[start + b];
        const v = buildVoicing(spec.chords[0], 0, 50);
        v.forEach((m, i) => events.push({ t: b * 6 * e + i * 0.03, midi: m, vel: 0.33, inst: 'guitar', voice: i }));
        let slot = 0;
        for (const [n, len] of spec.mel) {
          if (n !== null) events.push({ t: (b * 6 + slot) * e, midi: n, vel: 0.5 * (0.9 + 0.2 * r()), inst: 'requinto', voice: 0 });
          slot += len;
        }
      }
    }
    this.wait = 4 + Math.floor(r() * 7);
    return { seconds: 6 * bars * e, events, label: 'session:phrase' };
  }
}
