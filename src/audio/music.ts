import { Composer, SessionComposer, type BarSource, type NoteEvent } from './composer.ts';
import { INSTRUMENT_RATE, renderNote, type StringInstrument } from './strings.ts';

export type MusicTrack = 'menu' | 'session' | 'off';

/** Per-note gain at velocity 1. */
export const INST_GAIN: Record<StringInstrument, number> = { guitar: 0.2, requinto: 0.42, bass: 0.5 };
/** Track level on the music bus: the session guitar sits far under the wind. */
const TRACK_LEVEL: Record<MusicTrack, number> = { menu: 1, session: 0.45, off: 0 };
const INST_PAN: Record<StringInstrument, number> = { guitar: -0.22, requinto: 0.24, bass: 0.02 };
const LOOKAHEAD = 0.2;
const COMPOSE_AHEAD = 0.8;

/**
 * Karplus–Strong note buffers, rendered on first use. Only even MIDI notes are
 * rendered; odd ones play their lower neighbour a semitone fast, which halves
 * memory without an audible change in timbre.
 */
export class NoteBank {
  private ctx: BaseAudioContext;
  private cache = new Map<string, AudioBuffer>();
  bytes = 0;

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
  }

  get(inst: StringInstrument, midi: number) {
    const base = midi - (((midi % 2) + 2) % 2);
    const key = `${inst}${base}`;
    let b = this.cache.get(key);
    if (!b) {
      const data = renderNote(inst, base, base * 131 + inst.length);
      b = this.ctx.createBuffer(1, data.length, INSTRUMENT_RATE[inst]);
      b.getChannelData(0).set(data);
      this.cache.set(key, b);
      this.bytes += data.length * 4;
    }
    return { buffer: b, rate: Math.pow(2, (midi - base) / 12) };
  }

  has(inst: StringInstrument, midi: number) {
    return this.cache.has(`${inst}${midi - (((midi % 2) + 2) % 2)}`);
  }
}

interface Generation {
  out: GainNode;
  inst: Record<StringInstrument, AudioNode>;
  source: BarSource;
  nextBar: number;
  queue: { at: number; ev: NoteEvent }[];
  voices: Map<string, { src: AudioBufferSourceNode; gain: GainNode; stopAt: number }>;
  dieAt: number;
}

/** Look-ahead scheduler: composes bars ~0.8 s ahead and starts notes ~0.2 s ahead of the audio clock. */
export class MusicPlayer {
  private ctx: BaseAudioContext;
  private dest: AudioNode;
  private bank: NoteBank;
  private picks: () => AudioBuffer[];
  private gen: Generation | null = null;
  private dying: Generation[] = [];
  private seed = (Date.now() & 0xffff) ^ 0x2b1d;
  track: MusicTrack = 'off';
  scheduled = 0;

  constructor(ctx: BaseAudioContext, dest: AudioNode, bank: NoteBank, picks: () => AudioBuffer[]) {
    this.ctx = ctx;
    this.dest = dest;
    this.bank = bank;
    this.picks = picks;
  }

  play(track: MusicTrack) {
    if (track === this.track) return;
    this.track = track;
    const now = this.ctx.currentTime;
    const fading = this.gen !== null;
    if (this.gen) {
      this.gen.out.gain.cancelScheduledValues(now);
      this.gen.out.gain.setTargetAtTime(0, now, 0.4);
      this.gen.dieAt = now + 2.5;
      this.dying.push(this.gen);
      this.gen = null;
    }
    if (track === 'off') return;
    const out = this.ctx.createGain();
    out.gain.value = 0;
    out.gain.setTargetAtTime(TRACK_LEVEL[track], now + (fading ? 0.6 : 0), 0.25);
    out.connect(this.dest);
    const inst = {} as Record<StringInstrument, AudioNode>;
    for (const k of Object.keys(INST_PAN) as StringInstrument[]) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = INST_PAN[k];
      p.connect(out);
      inst[k] = p;
    }
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    this.gen = {
      out,
      inst,
      source: track === 'menu' ? new Composer(this.seed) : new SessionComposer(this.seed),
      nextBar: now + (fading ? 0.9 : 0.12),
      queue: [],
      voices: new Map(),
      dieAt: Infinity,
    };
  }

  tick() {
    const now = this.ctx.currentTime;
    for (let i = this.dying.length - 1; i >= 0; i--) {
      if (now < this.dying[i].dieAt) continue;
      this.dying[i].out.disconnect();
      this.dying.splice(i, 1);
    }
    const g = this.gen;
    if (!g) return;
    // After a long stall (hidden tab, debugger) skip ahead instead of bursting.
    if (g.nextBar < now - 1) {
      g.nextBar = now + 0.1;
      g.queue.length = 0;
    }
    let added = false;
    while (g.nextBar < now + COMPOSE_AHEAD) {
      const bar = g.source.next();
      for (const ev of bar.events) g.queue.push({ at: g.nextBar + ev.t, ev });
      g.nextBar += bar.seconds;
      added = true;
    }
    if (added) g.queue.sort((a, b) => a.at - b.at);
    let n = 0;
    while (n < g.queue.length && g.queue[n].at < now + LOOKAHEAD) {
      const q = g.queue[n++];
      if (q.at >= now - 0.03) this.start(g, Math.max(q.at, now), q.ev);
    }
    if (n) g.queue.splice(0, n);
  }

  private start(g: Generation, at: number, ev: NoteEvent) {
    const ctx = this.ctx;
    const { buffer, rate } = this.bank.get(ev.inst, ev.midi);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const gain = ctx.createGain();
    gain.gain.value = Math.min(1.2, ev.vel) * INST_GAIN[ev.inst];
    src.connect(gain).connect(g.inst[ev.inst]);
    src.start(at);
    let stopAt = at + buffer.duration / rate;
    if (ev.cut !== undefined) {
      gain.gain.setTargetAtTime(0, at + ev.cut, 0.012);
      stopAt = Math.min(stopAt, at + ev.cut + 0.1);
      src.stop(stopAt);
    }
    const key = `${ev.inst}${ev.voice}`;
    const prev = g.voices.get(key);
    if (prev && prev.stopAt > at + 0.09) {
      // Same string re-struck: damp the old vibration.
      prev.gain.gain.setTargetAtTime(0, at, 0.012);
      prev.stopAt = at + 0.09;
      prev.src.stop(prev.stopAt);
    }
    g.voices.set(key, { src, gain, stopAt });
    src.onended = () => gain.disconnect();
    if (ev.pick !== undefined) {
      const picks = this.picks();
      const p = picks[ev.muted ? 1 : 0] ?? picks[0];
      if (p) {
        const ps = ctx.createBufferSource();
        ps.buffer = p;
        const pg = ctx.createGain();
        pg.gain.value = ev.pick * (ev.muted ? 0.16 : 0.05);
        ps.connect(pg).connect(g.inst.guitar);
        ps.start(at);
        ps.onended = () => pg.disconnect();
      }
    }
    this.scheduled++;
  }
}
