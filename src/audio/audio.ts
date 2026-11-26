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

/** Procedural sound: wind, water, kite, effects and music. */
export class AudioEngine {
  volume = 0.8;
  muted = false;

  /** Must be called from a user gesture before anything is heard. */
  unlock() {}

  update(dt: number, f: AudioFrame) {
    void dt;
    void f;
  }

  event(name: AudioEvent, strength = 1) {
    void name;
    void strength;
  }

  music(track: 'menu' | 'session' | 'off') {
    void track;
  }

  setVolume(v: number) {
    this.volume = v;
  }
}
