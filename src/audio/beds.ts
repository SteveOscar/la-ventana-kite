import { clamp, smoothstep } from '../core/math.ts';
import { gauss, type Rng } from './dsp.ts';
import type { AudioFrame } from './audio.ts';

export interface NoiseBuffers {
  white: AudioBuffer;
  pink: AudioBuffer;
  brown: AudioBuffer;
}

export interface BedOutputs {
  wind: AudioNode;
  kite: AudioNode;
  board: AudioNode;
  shore: AudioNode;
}

/** One-shots the beds ask for; the engine owns voices and their limits. */
export interface BedTriggers {
  slap(level: number, pan: number): void;
  lap(level: number, pan: number): void;
  wave(level: number): void;
  gull(level: number): void;
}

/** Layer levels at full scale. */
const K = {
  windBody: 0.55,
  windAir: 0.5,
  howl: 1.3,
  roar: 1.4,
  kiteHiss: 0.25,
  sing: 2.2,
  flutter: 1.6,
  hiss: 0.75,
  rush: 0.8,
  shore: 0.32,
};

/** Smoothed AudioParam target that skips redundant automation events. */
class Smooth {
  private p: AudioParam;
  private tc: number;
  private last: number;

  constructor(p: AudioParam, tc: number, initial: number) {
    this.p = p;
    this.tc = tc;
    this.last = initial;
    p.value = initial;
  }

  set(v: number, now: number, tc = this.tc) {
    if (!Number.isFinite(v) || Math.abs(v - this.last) <= 1e-5 + 0.004 * Math.abs(this.last)) return;
    this.p.setTargetAtTime(v, now, tc);
    this.last = v;
  }
}

/** Exact Ornstein–Uhlenbeck step (stable for any dt): unit-variance noise with correlation time `tau` seconds. */
function ou(x: number, tau: number, dt: number, r: Rng) {
  const a = Math.exp(-dt / tau);
  return x * a + Math.sqrt(1 - a * a) * gauss(r);
}

/** Q for Web Audio low/high-pass filters is a resonance in dB, not a linear Q. */
const qDb = (q: number) => 20 * Math.log10(q);

/**
 * Continuous layers: a wind bed (brown body, pink air, faint howl), the kite's
 * roar, line hum and luffing flutter, the board's hiss and rush, and a shore wash.
 * Parameters follow the frame at ~30 Hz through `setTargetAtTime`, so nothing
 * steps; stochastic gusts keep the bed alive even when the inputs are steady.
 */
export class Beds {
  private ctx: BaseAudioContext;
  private r: Rng;
  private windBodyG: Smooth;
  private windBodyF: Smooth;
  private windAirG: Smooth;
  private windAirF: Smooth;
  private howlG: Smooth;
  private howlF: Smooth;
  private roarG: Smooth;
  private roarF: Smooth;
  private kiteHissG: Smooth;
  private singG: Smooth;
  private singF: Smooth;
  private flutterG: Smooth;
  private flutterF: Smooth;
  private lfoF: Smooth;
  private hissG: Smooth;
  private hissF: Smooth;
  private rushG: Smooth;
  private rushF: Smooth;
  private shoreG: Smooth;
  private gSlow = 0;
  private gMid = 0;
  private gFast = 0;
  private chatter = 0;
  private acc = 1;
  private slapT = 0.5;
  private lapT = 0.4;
  private waveT = 1.2;
  private gullT = 6;
  private luffHold = 0;
  /** Recent wind on the water: in the air the rider drifts with the wind and the apparent wind collapses. */
  private windMem = 9;
  /** Set by the kiteDown/relaunch events; cleared whenever the rider is up. */
  kiteDown = false;
  readonly nodeCount: number;

  constructor(ctx: BaseAudioContext, noise: NoiseBuffers, out: BedOutputs, r: Rng) {
    this.ctx = ctx;
    this.r = r;
    let nodes = 0;
    const loop = (b: AudioBuffer, rate: number, offset: number) => {
      const s = ctx.createBufferSource();
      s.buffer = b;
      s.loop = true;
      s.playbackRate.value = rate;
      s.start(0, offset % b.duration);
      nodes++;
      return s;
    };
    const filter = (type: BiquadFilterType, f: number, q: number, mono = false) => {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.Q.value = type === 'lowpass' || type === 'highpass' ? qDb(q) : q;
      if (mono) {
        b.channelCount = 1;
        b.channelCountMode = 'explicit';
      }
      nodes++;
      return b;
    };
    const gain = (dest: AudioNode) => {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(dest);
      nodes++;
      return g;
    };

    // Wind: deep brown body, airy pink band, and a narrow wandering howl for strong gusts.
    const body = filter('lowpass', 400, 0.6);
    const bodyG = gain(out.wind);
    loop(noise.brown, 1, 0).connect(body).connect(bodyG);
    const air = filter('bandpass', 900, 0.6);
    const airG = gain(out.wind);
    loop(noise.pink, 0.93, 1.7).connect(air).connect(airG);
    const howl = filter('bandpass', 600, 7);
    const howlG = gain(out.wind);
    loop(noise.pink, 1.07, 3.1).connect(howl).connect(howlG);
    this.windBodyG = new Smooth(bodyG.gain, 0.12, 0);
    this.windBodyF = new Smooth(body.frequency, 0.25, 400);
    this.windAirG = new Smooth(airG.gain, 0.12, 0);
    this.windAirF = new Smooth(air.frequency, 0.25, 900);
    this.howlG = new Smooth(howlG.gain, 0.4, 0);
    this.howlF = new Smooth(howl.frequency, 0.6, 600);

    // Kite: canopy roar, air over the lines, line hum, and luffing flutter.
    const roar = filter('bandpass', 300, 0.9, true);
    const roarG = gain(out.kite);
    loop(noise.pink, 0.88, 2.3).connect(roar).connect(roarG);
    const kHiss = filter('bandpass', 3000, 0.7, true);
    const kHissG = gain(out.kite);
    loop(noise.pink, 1.04, 0.4).connect(kHiss).connect(kHissG);
    const sing = filter('bandpass', 800, 28, true);
    const singG = gain(out.kite);
    loop(noise.white, 0.97, 1.1).connect(sing).connect(singG);
    // Flutter: noise through a VCA driven by a sharp-attack pulse train at the flapping rate.
    const flut = filter('bandpass', 700, 0.7, true);
    const vca = ctx.createGain();
    vca.gain.value = 0;
    const flutG = gain(out.kite);
    loop(noise.pink, 1.13, 4.2).connect(flut).connect(vca).connect(flutG);
    const lfo = ctx.createOscillator();
    lfo.type = 'sawtooth';
    lfo.frequency.value = 11;
    const shape = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.pow((1 - x) / 2, 3);
    }
    shape.curve = curve;
    lfo.connect(shape).connect(vca.gain);
    lfo.start();
    nodes += 3;
    this.roarG = new Smooth(roarG.gain, 0.1, 0);
    this.roarF = new Smooth(roar.frequency, 0.15, 300);
    this.kiteHissG = new Smooth(kHissG.gain, 0.1, 0);
    this.singG = new Smooth(singG.gain, 0.2, 0);
    this.singF = new Smooth(sing.frequency, 0.2, 800);
    this.flutterG = new Smooth(flutG.gain, 0.06, 0);
    this.flutterF = new Smooth(flut.frequency, 0.1, 700);
    this.lfoF = new Smooth(lfo.frequency, 0.08, 11);

    // Board: spray hiss and the rush of water under the hull.
    const hp = filter('highpass', 1400, 0.6);
    const lp = filter('lowpass', 6000, 0.6);
    const hissG = gain(out.board);
    loop(noise.pink, 1, 1.3).connect(hp).connect(lp).connect(hissG);
    const rush = filter('bandpass', 450, 0.7);
    const rushG = gain(out.board);
    loop(noise.pink, 0.97, 0.8).connect(rush).connect(rushG);
    this.hissG = new Smooth(hissG.gain, 0.06, 0);
    this.hissF = new Smooth(lp.frequency, 0.12, 6000);
    this.rushG = new Smooth(rushG.gain, 0.08, 0);
    this.rushF = new Smooth(rush.frequency, 0.12, 450);

    // Shore: a soft continuous wash under the breaking waves.
    const wash = filter('lowpass', 650, 0.5);
    const washG = gain(out.shore);
    loop(noise.pink, 0.81, 5).connect(wash).connect(washG);
    this.shoreG = new Smooth(washG.gain, 0.5, 0);
    this.nodeCount = nodes;
  }

  update(dtIn: number, f: AudioFrame, trig: BedTriggers) {
    const dt = clamp(dtIn, 0, 0.1);
    const r = this.r;
    this.gSlow = ou(this.gSlow, 7, dt, r);
    this.gMid = ou(this.gMid, 1.6, dt, r);
    this.gFast = ou(this.gFast, 0.3, dt, r);
    this.chatter = ou(this.chatter, 0.05, dt, r);

    const menu = f.mode === 'menu';
    const riding = f.mode === 'riding';
    if (riding || f.mode === 'air' || menu) this.kiteDown = false;
    this.luffHold = f.luff > 0.97 ? this.luffHold + dt : Math.max(0, this.luffHold - dt * 3);
    if (f.mode !== 'air' && f.mode !== 'crash') this.windMem += (f.wind - this.windMem) * Math.min(1, dt / 6);
    const chopN = clamp(f.chop / 0.7, 0, 1.4);
    const shore = smoothstep(0.08, 0.85, f.nearShore) * (menu ? 0.8 : 1);

    // Chop slaps: roughly Poisson, faster with speed and rougher water.
    if (riding && f.boardSpeed > 2.5) {
      this.slapT -= dt * 0.35 * f.boardSpeed * (0.3 + chopN);
      if (this.slapT <= 0) {
        const bn = clamp(f.boardSpeed / 12, 0, 1.3);
        trig.slap((0.35 + 0.65 * r()) * (0.4 + 0.6 * bn) * (0.55 + 0.6 * chopN), (r() - 0.5) * 0.5);
        this.slapT = 0.2 - 0.8 * Math.log(1 - 0.95 * r());
      }
    }
    // Water lapping around a rider who is swimming, crashing or body dragging.
    if (f.mode === 'water' || f.mode === 'crash' || f.mode === 'drag') {
      this.lapT -= dt * (f.mode === 'drag' ? 2 : 1);
      if (this.lapT <= 0) {
        trig.lap(0.4 + 0.5 * r(), (r() - 0.5) * 0.6);
        this.lapT = 0.6 + 1.2 * r();
      }
    }
    this.waveT -= dt;
    if (this.waveT <= 0) {
      if (shore > 0.04) trig.wave(shore * (0.6 + 0.4 * r()) * (0.75 + 0.35 * chopN));
      this.waveT = 3.2 + 4 * r();
    }
    this.gullT -= dt * (0.25 + shore);
    if (this.gullT <= 0) {
      if (shore > 0.12) trig.gull(0.35 + 0.65 * shore * (0.5 + 0.5 * r()));
      this.gullT = 14 + 26 * r();
    }

    // Parameters at ~30 Hz.
    this.acc += dt;
    if (this.acc < 1 / 30) return;
    this.acc = 0;
    const now = this.ctx.currentTime;

    const gust = 0.55 * this.gSlow + 0.3 * this.gMid + 0.15 * this.gFast;
    const wind = f.mode === 'air' ? Math.max(f.wind, 0.65 * this.windMem) : f.wind;
    const ws = Math.max(0, wind * (1 + 0.12 * gust));
    const wn = clamp((ws - 2) / 13, 0, 1.4);
    const wl = menu ? 0.42 : 1;
    this.windBodyG.set(K.windBody * Math.pow(wn, 1.3) * wl, now);
    this.windBodyF.set(160 + 520 * wn + 50 * this.gMid, now);
    this.windAirG.set(K.windAir * Math.pow(wn, 1.9) * wl, now);
    this.windAirF.set(500 + 1500 * wn + 180 * this.gFast, now);
    this.howlG.set(K.howl * smoothstep(0.5, 1.15, wn) * (0.55 + 0.45 * clamp(this.gSlow, -1, 1)) * wl, now);
    this.howlF.set(380 + 260 * wn + 80 * this.gSlow, now);

    const kiteOn = !menu && !this.kiteDown && this.luffHold < 1.2 ? 1 : 0;
    const kn = clamp((f.kiteSpeed - 3) / 17, 0, 1.3);
    const tn = clamp(f.tension / 1200, 0, 1.6);
    this.roarG.set(kiteOn * K.roar * Math.pow(kn, 1.2) * (0.35 + 0.65 * tn), now);
    this.roarF.set(110 + 20 * f.kiteSpeed, now);
    this.kiteHissG.set(kiteOn * K.kiteHiss * Math.pow(kn, 2.2), now);
    this.singG.set(kiteOn * K.sing * smoothstep(0.45, 1.2, tn) * kn, now);
    this.singF.set(520 + 30 * f.kiteSpeed, now);
    this.flutterG.set(kiteOn * K.flutter * Math.min(1, f.luff * 1.4) * (0.4 + 0.6 * wn), now);
    this.flutterF.set(650 + 250 * clamp(this.gMid, -1.5, 1.5), now);
    this.lfoF.set((6 + 0.55 * f.wind) * (1 + 0.15 * clamp(this.gFast, -2, 2)), now);

    const bn = clamp(f.boardSpeed / 12, 0, 1.4);
    const chat = 1 + 0.3 * chopN * clamp(this.chatter, -1.5, 1.5);
    this.hissG.set(riding ? K.hiss * Math.pow(bn, 1.3) * (0.75 + 0.35 * chopN) * chat : 0, now, riding ? 0.04 : 0.12);
    this.hissF.set(2500 + 6000 * bn, now);
    const drag = f.mode === 'drag' ? clamp(f.tension / 700, 0, 1) : 0;
    this.rushG.set(riding ? K.rush * Math.pow(bn, 1.1) : K.rush * 0.7 * drag, now);
    this.rushF.set(260 + 380 * (riding ? bn : 0.5 * drag), now);

    this.shoreG.set(K.shore * shore, now);
  }
}
