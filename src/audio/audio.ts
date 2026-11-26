import { clamp, mulberry32 } from '../core/math.ts';
import { brownNoise, normalizeRms, pinkNoise, seamless, whiteNoise } from './dsp.ts';
import { Beds, type BedTriggers, type NoiseBuffers } from './beds.ts';
import { renderSfx, SFX_VARIANTS, type SfxName } from './sfx.ts';
import { MusicPlayer, NoteBank, type MusicTrack } from './music.ts';

export interface AudioFrame {
  /** Apparent wind at the rider (m/s). */
  wind: number;
  /** Kite airspeed (m/s) and line tension (N). */
  kiteSpeed: number;
  tension: number;
  /** Board speed over the water (m/s); 0 when not riding. */
  boardSpeed: number;
  mode: 'water' | 'riding' | 'air' | 'crash' | 'drag' | 'menu';
  /** 0 offshore .. 1 right at the beach. */
  nearShore: number;
  /** Wave amplitude budget (m) for chop slaps. */
  chop: number;
  /** Kite flagging 0..1. */
  luff: number;
}

export type AudioEvent = 'splash' | 'land' | 'hardLand' | 'crash' | 'pop' | 'kiteDown' | 'relaunch' | 'ui' | 'cheer' | 'checkpoint' | 'whale' | 'gull';

export type DebugBus = 'master' | 'ambience' | 'wind' | 'kite' | 'board' | 'shore' | 'sfx' | 'music';

export interface AudioLevel {
  state: string;
  /** Linear RMS and peak over the analyser's latest window (~85 ms). */
  rms: number;
  peak: number;
  rmsDb: number;
  peakDb: number;
  /** Since the meter was armed (first call) or last reset; sampled every update. */
  maxPeak: number;
  maxPeakDb: number;
  avgRmsDb: number;
  nan: boolean;
  /** Active one-shot voices, music notes started so far, rendered buffer memory. */
  voices: number;
  musicNotes: number;
  bufferMB: number;
  /** Mean main-thread cost of `update()`, excluding background buffer rendering. */
  updateMs: number;
}

/** One-shot levels at strength 1 (linear gain on a ~0.9 peak buffer). */
const LEVEL = {
  splash: 0.42,
  land: 0.34,
  hardLand: 0.42,
  crash: 0.56,
  pop: 0.3,
  kiteDown: 0.3,
  relaunch: 0.24,
  ui: 0.12,
  cheer: 0.3,
  checkpoint: 0.2,
  whale: 0.2,
  gull: 0.12,
  slap: 0.17,
  lap: 0.12,
  wave: 0.3,
};
const MAX_VOICES = 20;
/** One-shots carry little above 8 kHz, so they render at 32 kHz (a third less memory and warm-up time). */
const SFX_RATE = 32000;
const MUSIC_BUS = 1.5;
const WARM_BUDGET_MS = 3;

const db = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

/** Procedural sound: wind, water, kite, effects and music. */
export class AudioEngine {
  private vol = 0.8;
  private mute = false;
  private core: Core | null = null;
  private status: 'locked' | 'unavailable' | 'ready' = 'locked';
  private track: MusicTrack = 'off';
  private frame: AudioFrame | null = null;

  get volume() {
    return this.vol;
  }

  set volume(v: number) {
    this.vol = clamp(Number.isFinite(v) ? v : 0, 0, 1);
    this.core?.setMaster(this.vol, this.mute);
  }

  get muted() {
    return this.mute;
  }

  set muted(m: boolean) {
    this.mute = !!m;
    this.core?.setMaster(this.vol, this.mute);
  }

  /** Must be called from a user gesture before anything is heard. */
  unlock() {
    if (this.status === 'unavailable') return;
    if (this.core) {
      this.core.resume(this.mute);
      return;
    }
    const g = globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext; document?: Document };
    const Ctor = g.document ? (g.AudioContext ?? g.webkitAudioContext) : undefined;
    if (!Ctor) {
      this.status = 'unavailable';
      return;
    }
    let ctx: AudioContext;
    try {
      ctx = new Ctor({ latencyHint: 'interactive' });
    } catch {
      this.status = 'unavailable';
      return;
    }
    // Audio is optional: if the graph cannot be built, the game runs silent.
    try {
      this.core = new Core(ctx, this.vol, this.mute);
    } catch (err) {
      console.warn('Audio disabled:', err);
      void ctx.close().catch(() => {});
      this.status = 'unavailable';
      return;
    }
    this.status = 'ready';
    this.core.resume(this.mute);
    if (this.frame) this.core.update(0, this.frame);
    this.core.music.play(this.track);
  }

  update(dt: number, f: AudioFrame) {
    const s = sanitize(f, this.frame);
    this.frame = s;
    this.core?.update(Number.isFinite(dt) ? dt : 0, s);
  }

  event(name: AudioEvent, strength = 1) {
    this.core?.event(name, clamp(Number.isFinite(strength) ? strength : 1, 0, 1));
  }

  music(track: 'menu' | 'session' | 'off') {
    this.track = track;
    this.core?.music.play(track);
  }

  setVolume(v: number) {
    this.volume = v;
  }

  /** Output (or bus) level for debugging and automated checks. */
  debugLevel(bus: DebugBus = 'master', reset = false): AudioLevel {
    if (!this.core) {
      return { state: this.status, rms: 0, peak: 0, rmsDb: -Infinity, peakDb: -Infinity, maxPeak: 0, maxPeakDb: -Infinity, avgRmsDb: -Infinity, nan: false, voices: 0, musicNotes: 0, bufferMB: 0, updateMs: 0 };
    }
    return this.core.level(bus, reset);
  }

  /** Renders the continuous beds and master chain offline for `seconds` and times it (CPU estimate). */
  debugBenchmark(seconds = 10, frame?: Partial<AudioFrame>) {
    return this.core?.benchmark(seconds, { ...RIDING, ...frame }) ?? Promise.resolve(null);
  }
}

const RIDING: AudioFrame = { wind: 12, kiteSpeed: 11, tension: 600, boardSpeed: 9, mode: 'riding', nearShore: 0.3, chop: 0.5, luff: 0.15 };
const MODES = new Set(['water', 'riding', 'air', 'crash', 'drag', 'menu']);

/** Clamps every field to a sane finite range (a NaN reaching an AudioParam would throw). */
function sanitize(f: AudioFrame, prev: AudioFrame | null): AudioFrame {
  const n = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? clamp(v, lo, hi) : lo);
  const out = prev ?? { ...RIDING };
  out.wind = n(f.wind, 0, 40);
  out.kiteSpeed = n(f.kiteSpeed, 0, 60);
  out.tension = n(f.tension, 0, 6000);
  out.boardSpeed = n(f.boardSpeed, 0, 30);
  out.mode = MODES.has(f.mode) ? f.mode : 'menu';
  out.nearShore = n(f.nearShore, 0, 1);
  out.chop = n(f.chop, 0, 2);
  out.luff = n(f.luff, 0, 1);
  return out;
}

interface Voice {
  src: AudioBufferSourceNode;
  gain: GainNode;
  kind: string;
  prio: number;
  end: number;
}

interface PlayOpts {
  gain: number;
  rate?: number;
  pan?: number;
  prio?: number;
  /** Most voices of this sound at once; the oldest is faded out to make room. */
  max?: number;
  /** Reverb send level. */
  send?: number;
  bus?: AudioNode;
  variant?: number;
}

interface Meter {
  an: AnalyserNode;
  buf: Float32Array<ArrayBuffer>;
  rms: number;
  peak: number;
  maxPeak: number;
  sumSq: number;
  count: number;
  nan: boolean;
}

/** The live graph. Exists only after `unlock()`. */
class Core {
  readonly ctx: AudioContext;
  readonly music: MusicPlayer;
  private rand = mulberry32((Date.now() & 0xffffff) ^ 0x9e37);
  private noise: NoiseBuffers;
  private master: GainNode;
  private buses: Record<DebugBus, AudioNode>;
  private sfxBus: GainNode;
  private shoreBus: GainNode;
  private boardBus: GainNode;
  private reverbIn: GainNode;
  private beds: Beds;
  private bank: NoteBank;
  private sfx = new Map<string, AudioBuffer>();
  private voices: Voice[] = [];
  private waves = 0;
  private warm: (() => void)[] = [];
  private lastEvent: Partial<Record<AudioEvent, number>> = {};
  private meters = new Map<DebugBus, Meter>();
  private triggers: BedTriggers;
  private muted = false;
  private muteAt = 0;
  private uiFlip = 0;
  private bytes = 0;
  private updateMs = 0;

  constructor(ctx: AudioContext, volume: number, muted: boolean) {
    this.ctx = ctx;
    const sr = ctx.sampleRate;
    const r = mulberry32(0xa11ce);
    const loop = (channels: number, seconds: number, gen: (n: number) => Float32Array) => {
      const n = Math.round(seconds * sr);
      const fade = Math.round(0.05 * sr);
      const b = ctx.createBuffer(channels, n, sr);
      for (let c = 0; c < channels; c++) b.getChannelData(c).set(normalizeRms(seamless(gen(n + fade), n, fade), 0.25));
      this.bytes += n * 4 * channels;
      return b;
    };
    this.noise = {
      white: loop(1, 2, (n) => whiteNoise(n, r)),
      pink: loop(2, 6, (n) => pinkNoise(n, r)),
      brown: loop(2, 6, (n) => brownNoise(n, r)),
    };

    // Master: glue compressor -> limiter -> volume -> soft clip (hard ceiling 0.98) -> meter.
    const pre = ctx.createGain();
    pre.gain.value = 0.6;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 8;
    comp.ratio.value = 2.5;
    comp.attack.value = 0.008;
    comp.release.value = 0.25;
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -3;
    lim.knee.value = 0;
    lim.ratio.value = 20;
    lim.attack.value = 0.002;
    lim.release.value = 0.12;
    this.master = ctx.createGain();
    this.master.gain.value = muted ? 0 : volume * volume;
    this.muted = muted;
    const clip = ctx.createWaveShaper();
    const curve = new Float32Array(2049);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      const a = Math.abs(x);
      curve[i] = a < 0.9 ? x : Math.sign(x) * (0.9 + 0.08 * Math.tanh((a - 0.9) / 0.08));
    }
    clip.curve = curve;
    const an = ctx.createAnalyser();
    an.fftSize = 4096;
    pre.connect(comp).connect(lim).connect(this.master).connect(clip).connect(an).connect(ctx.destination);

    // Reverb: a short, dark patio-like room for music, chimes and distant calls.
    this.reverbIn = ctx.createGain();
    const conv = ctx.createConvolver();
    conv.buffer = this.impulse(1.5);
    const wet = ctx.createGain();
    wet.gain.value = 0.5;
    this.reverbIn.connect(conv).connect(wet).connect(pre);

    const bus = (dest: AudioNode, g = 1) => {
      const n = ctx.createGain();
      n.gain.value = g;
      n.connect(dest);
      return n;
    };
    const ambience = bus(pre);
    const wind = bus(ambience);
    const kite = bus(ambience);
    this.boardBus = bus(ambience);
    this.shoreBus = bus(ambience);
    this.sfxBus = bus(pre);
    // Nylon-guitar body: a little low-mid warmth, softened nail attack.
    const music = bus(pre, MUSIC_BUS);
    const body = ctx.createBiquadFilter();
    body.type = 'peaking';
    body.frequency.value = 210;
    body.Q.value = 1;
    body.gain.value = 2.5;
    const soft = ctx.createBiquadFilter();
    soft.type = 'highshelf';
    soft.frequency.value = 4200;
    soft.gain.value = -2;
    body.connect(soft).connect(music);
    const send = bus(this.reverbIn, 0.32);
    music.connect(send);
    this.buses = { master: an, ambience, wind, kite, board: this.boardBus, shore: this.shoreBus, sfx: this.sfxBus, music };

    this.beds = new Beds(ctx, this.noise, { wind, kite, board: this.boardBus, shore: this.shoreBus }, mulberry32(0xbeef));
    this.bank = new NoteBank(ctx);
    this.music = new MusicPlayer(ctx, body, this.bank, () => this.pickBuffers());
    this.triggers = {
      slap: (l, pan) => this.play('slap', { gain: LEVEL.slap * l, pan, rate: 0.9 + 0.2 * this.rand(), max: 4, prio: 0, bus: this.boardBus }),
      lap: (l, pan) => this.play('lap', { gain: LEVEL.lap * l, pan, rate: 0.85 + 0.3 * this.rand(), max: 2, prio: 0, bus: this.boardBus }),
      wave: (l) => this.wave(l),
      gull: (l) => this.gull(l),
    };

    // Render everything else in small slices over the next frames, most urgent first.
    const order: SfxName[] = ['ui', 'checkpoint', 'pick', 'splashSmall', 'splashBig', 'land', 'pop', 'slap', 'lap', 'hardLand', 'crash', 'kiteDown', 'relaunch', 'gull', 'whale', 'cheer'];
    for (const name of order) for (let v = 0; v < SFX_VARIANTS[name]; v++) this.warm.push(() => void this.buffer(name, v));
    const notes: [Parameters<NoteBank['get']>[0], number, number][] = [
      ['bass', 36, 52],
      ['guitar', 43, 80],
      ['requinto', 50, 84],
    ];
    for (const [inst, lo, hi] of notes) for (let m = lo; m <= hi; m += 2) this.warm.push(() => void this.bank.get(inst, m));

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) void ctx.suspend().catch(() => {});
      else this.resume(this.muted);
    });
    // Some browsers (iOS) suspend the context on interruptions; any later gesture may resume it.
    const kick = () => this.resume(this.muted);
    window.addEventListener('pointerdown', kick, { passive: true });
    window.addEventListener('keydown', kick, { passive: true });
  }

  resume(muted: boolean) {
    if (this.ctx.state !== 'running' && !muted && !(typeof document !== 'undefined' && document.hidden)) void this.ctx.resume().catch(() => {});
  }

  setMaster(volume: number, muted: boolean) {
    const now = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(muted ? 0 : volume * volume, now, 0.04);
    if (muted && !this.muted) this.muteAt = now;
    this.muted = muted;
    if (!muted) this.resume(false);
  }

  update(dt: number, f: AudioFrame) {
    const t0 = performance.now();
    const ctx = this.ctx;
    if (ctx.state === 'running') {
      // Muted: once the fade has finished, stop the audio thread entirely.
      if (this.muted && ctx.currentTime - this.muteAt > 0.4) void ctx.suspend().catch(() => {});
      this.beds.update(dt, f, this.triggers);
      this.music.tick();
      this.pruneVoices();
      for (const m of this.meters.values()) this.poll(m);
    }
    const t1 = performance.now();
    this.updateMs += (t1 - t0 - this.updateMs) * 0.05;
    while (this.warm.length && performance.now() - t1 < WARM_BUDGET_MS) this.warm.shift()!();
  }

  event(name: AudioEvent, s: number) {
    if (this.ctx.state !== 'running') return;
    const now = performance.now() / 1000;
    const since = (k: AudioEvent) => now - (this.lastEvent[k] ?? -1e9);
    const j = (a: number) => 1 + (this.rand() * 2 - 1) * a;
    const pan = (a: number) => (this.rand() * 2 - 1) * a;
    switch (name) {
      case 'splash': {
        // The game pairs splashes with landings, crashes and kite drops, which carry their own water.
        if (since('kiteDown') < 0.1) break;
        const k = since('crash') < 0.1 ? 0.35 : since('hardLand') < 0.1 ? 0.7 : since('land') < 0.1 ? 0.45 : 1;
        const big = s > 0.45;
        this.play(big ? 'splashBig' : 'splashSmall', { gain: LEVEL.splash * k * (0.3 + 0.7 * s), rate: (big ? 1.06 - 0.12 * s : 1.1 - 0.2 * s) * j(0.04), pan: pan(0.15), prio: 2, max: 3 });
        break;
      }
      case 'land':
        this.play('land', { gain: LEVEL.land * (0.6 + 0.4 * s), rate: j(0.05), prio: 3, max: 2 });
        break;
      case 'hardLand':
        this.play('hardLand', { gain: LEVEL.hardLand * (0.7 + 0.3 * s), rate: j(0.05), prio: 3, max: 2 });
        break;
      case 'crash':
        if (since('crash') < 0.25) break;
        this.play('crash', { gain: LEVEL.crash * (0.75 + 0.25 * s), rate: j(0.04), prio: 4, max: 2 });
        break;
      case 'pop':
        this.play('pop', { gain: LEVEL.pop * (0.6 + 0.4 * s), rate: j(0.06), prio: 3, max: 2 });
        break;
      case 'kiteDown':
        this.beds.kiteDown = true;
        this.play('kiteDown', { gain: LEVEL.kiteDown * (0.6 + 0.4 * s), rate: j(0.04), pan: pan(0.4), prio: 3, max: 1 });
        break;
      case 'relaunch':
        this.beds.kiteDown = false;
        this.play('relaunch', { gain: LEVEL.relaunch * (0.6 + 0.4 * s), rate: j(0.04), pan: pan(0.3), prio: 3, max: 1 });
        break;
      case 'ui':
        if (since('ui') < 0.035) break;
        this.uiFlip ^= 1;
        this.play('ui', { gain: LEVEL.ui * (0.5 + 0.5 * s), variant: this.uiFlip, prio: 5, max: 3 });
        break;
      case 'cheer':
        if (since('cheer') < 0.5) break;
        this.play('cheer', { gain: LEVEL.cheer * (0.6 + 0.4 * s), send: 0.25, prio: 4, max: 1 });
        break;
      case 'checkpoint':
        if (since('checkpoint') < 0.15) break;
        this.play('checkpoint', { gain: LEVEL.checkpoint * (0.6 + 0.4 * s), send: 0.3, prio: 4, max: 2 });
        break;
      case 'whale':
        this.play('whale', { gain: LEVEL.whale * (0.25 + 0.75 * s), rate: j(0.06), pan: pan(0.6), send: 0.5, prio: 2, max: 1, bus: this.shoreBus });
        break;
      case 'gull':
        this.gull(0.4 + 0.6 * s);
        break;
    }
    this.lastEvent[name] = now;
  }

  private gull(level: number) {
    if (this.voices.some((v) => v.kind === 'gull')) return;
    this.play('gull', { gain: LEVEL.gull * level, rate: 0.9 + 0.22 * this.rand(), pan: (this.rand() * 2 - 1) * 0.7, send: 0.35, prio: 1, max: 1, bus: this.shoreBus });
  }

  /** A wave breaking on the beach: swept low-passed noise, then the backwash fizz over the pebbles. */
  private wave(level: number) {
    if (this.waves >= 3) return;
    const ctx = this.ctx;
    const r = this.rand;
    const t0 = ctx.currentTime + 0.02;
    const rise = 0.6 + 0.8 * r();
    const dur = rise + 2.6 + 1.2 * r();
    const peak = LEVEL.wave * level;
    const src = ctx.createBufferSource();
    src.buffer = this.noise.pink;
    src.loop = true;
    src.playbackRate.value = 0.85 + 0.2 * r();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = -4;
    lp.frequency.setValueAtTime(260, t0);
    lp.frequency.exponentialRampToValueAtTime(1500 + 1000 * r(), t0 + rise);
    lp.frequency.exponentialRampToValueAtTime(420, t0 + dur);
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + rise);
    g.gain.setTargetAtTime(0, t0 + rise, (dur - rise) / 3.5);
    const fizz = ctx.createBufferSource();
    fizz.buffer = this.noise.pink;
    fizz.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 3800;
    bp.Q.value = 0.6;
    const g2 = ctx.createGain();
    g2.gain.value = 0;
    g2.gain.setValueAtTime(0, t0 + rise * 0.85);
    g2.gain.linearRampToValueAtTime(peak * 0.5, t0 + rise + 0.25);
    g2.gain.setTargetAtTime(0, t0 + rise + 0.25, 0.9);
    const p = ctx.createStereoPanner();
    p.pan.value = (r() * 2 - 1) * 0.45;
    src.connect(lp).connect(g).connect(p);
    fizz.connect(bp).connect(g2).connect(p);
    p.connect(this.shoreBus);
    const end = t0 + dur + 1.5;
    src.start(t0, r() * 5);
    fizz.start(t0, r() * 2);
    src.stop(end);
    fizz.stop(end);
    this.waves++;
    src.onended = () => {
      this.waves--;
      p.disconnect();
    };
  }

  private play(name: SfxName, o: PlayOpts) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const prio = o.prio ?? 1;
    this.pruneVoices();
    if (o.max !== undefined) {
      const same = this.voices.filter((v) => v.kind === name);
      if (same.length >= o.max) this.steal(same[0]);
    }
    if (this.voices.length >= MAX_VOICES) {
      let victim: Voice | null = null;
      for (const v of this.voices) if (!victim || v.prio < victim.prio) victim = v;
      if (!victim || victim.prio > prio) return;
      this.steal(victim);
    }
    const buffer = this.buffer(name, o.variant);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = o.rate ?? 1;
    const gain = ctx.createGain();
    gain.gain.value = Math.max(0, o.gain);
    const pan = ctx.createStereoPanner();
    pan.pan.value = clamp(o.pan ?? 0, -1, 1);
    src.connect(gain).connect(pan).connect(o.bus ?? this.sfxBus);
    let send: GainNode | null = null;
    if (o.send) {
      send = ctx.createGain();
      send.gain.value = o.send;
      pan.connect(send).connect(this.reverbIn);
    }
    src.start(now);
    const v: Voice = { src, gain, kind: name, prio, end: now + buffer.duration / (o.rate ?? 1) };
    this.voices.push(v);
    src.onended = () => {
      pan.disconnect();
      send?.disconnect();
      const i = this.voices.indexOf(v);
      if (i >= 0) this.voices.splice(i, 1);
    };
  }

  /** Fades a voice out quickly and frees its slot. */
  private steal(v: Voice) {
    const now = this.ctx.currentTime;
    v.gain.gain.setTargetAtTime(0, now, 0.015);
    v.src.stop(now + 0.1);
    const i = this.voices.indexOf(v);
    if (i >= 0) this.voices.splice(i, 1);
  }

  private pruneVoices() {
    const now = this.ctx.currentTime;
    for (let i = this.voices.length - 1; i >= 0; i--) if (this.voices[i].end < now - 0.5) this.voices.splice(i, 1);
  }

  private buffer(name: SfxName, variant?: number) {
    const n = SFX_VARIANTS[name];
    const v = variant ?? Math.floor(this.rand() * n);
    let b = this.sfx.get(`${name}${v}`);
    for (let k = 0; !b && k < n; k++) b = this.sfx.get(`${name}${k}`);
    if (b) return b;
    const chans = renderSfx(name, v, SFX_RATE);
    b = this.ctx.createBuffer(chans.length, chans[0].length, SFX_RATE);
    chans.forEach((c, i) => b!.getChannelData(i).set(c));
    this.sfx.set(`${name}${v}`, b);
    this.bytes += chans.length * chans[0].length * 4;
    return b;
  }

  private pickBuffers() {
    return [this.sfx.get('pick0'), this.sfx.get('pick1')].filter((b): b is AudioBuffer => !!b);
  }

  /** Exponentially decaying stereo noise that darkens as it decays. */
  private impulse(seconds: number) {
    const sr = this.ctx.sampleRate;
    const n = Math.round(seconds * sr);
    const b = this.ctx.createBuffer(2, n, sr);
    const r = mulberry32(0x1e5);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const a = Math.min(0.9, (2 * Math.PI * (7000 * Math.exp(-t * 2.2) + 600)) / sr);
        lp += a * (r() * 2 - 1 - lp);
        d[i] = t < 0.006 ? 0 : lp * Math.exp((-6.9 * t) / seconds) * Math.min(1, (t - 0.006) / 0.01);
      }
    }
    this.bytes += n * 8;
    return b;
  }

  /** Meters are created on first request and then polled every update. */
  private meter(bus: DebugBus): Meter {
    let an = this.buses.master as AnalyserNode;
    if (bus !== 'master') {
      an = this.ctx.createAnalyser();
      an.fftSize = 4096;
      this.buses[bus].connect(an);
    }
    return { an, buf: new Float32Array(an.fftSize), rms: 0, peak: 0, maxPeak: 0, sumSq: 0, count: 0, nan: false };
  }

  private poll(m: Meter) {
    m.an.getFloatTimeDomainData(m.buf);
    let s = 0, p = 0;
    for (let i = 0; i < m.buf.length; i++) {
      const x = m.buf[i];
      if (x !== x) {
        m.nan = true;
        continue;
      }
      s += x * x;
      const a = x < 0 ? -x : x;
      if (a > p) p = a;
    }
    m.rms = Math.sqrt(s / m.buf.length);
    m.peak = p;
    m.maxPeak = Math.max(m.maxPeak, p);
    m.sumSq += s / m.buf.length;
    m.count++;
  }

  level(bus: DebugBus, reset: boolean): AudioLevel {
    let m = this.meters.get(bus);
    if (!m) {
      m = this.meter(bus);
      this.meters.set(bus, m);
    }
    if (reset) {
      m.maxPeak = 0;
      m.sumSq = 0;
      m.count = 0;
      m.nan = false;
    }
    if (this.ctx.state === 'running') this.poll(m);
    return {
      state: this.ctx.state,
      rms: m.rms,
      peak: m.peak,
      rmsDb: db(m.rms),
      peakDb: db(m.peak),
      maxPeak: m.maxPeak,
      maxPeakDb: db(m.maxPeak),
      avgRmsDb: m.count ? 10 * Math.log10(Math.max(1e-20, m.sumSq / m.count)) : -Infinity,
      nan: m.nan,
      voices: this.voices.length,
      musicNotes: this.music.scheduled,
      bufferMB: (this.bytes + this.bank.bytes) / 1e6,
      updateMs: this.updateMs,
    };
  }

  async benchmark(seconds: number, f: AudioFrame) {
    const sr = this.ctx.sampleRate;
    const off = new OfflineAudioContext(2, Math.round(seconds * sr), sr);
    const comp = off.createDynamicsCompressor();
    const lim = off.createDynamicsCompressor();
    comp.connect(lim).connect(off.destination);
    const out = off.createGain();
    out.gain.value = 0.6;
    out.connect(comp);
    const beds = new Beds(off, this.noise, { wind: out, kite: out, board: out, shore: out }, mulberry32(7));
    const none: BedTriggers = { slap() {}, lap() {}, wave() {}, gull() {} };
    beds.update(0.05, f, none);
    const t0 = performance.now();
    const buf = await off.startRendering();
    const ms = performance.now() - t0;
    let s = 0, p = 0, nan = false;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) {
        const x = d[i];
        if (x !== x) nan = true;
        else {
          s += x * x;
          p = Math.max(p, Math.abs(x));
        }
      }
    }
    return { seconds, renderMs: ms, cpuPercent: (100 * ms) / (seconds * 1000), nodes: beds.nodeCount, rmsDb: db(Math.sqrt(s / (buf.length * buf.numberOfChannels))), peak: p, nan };
  }
}
