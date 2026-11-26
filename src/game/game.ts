import * as THREE from 'three';
import { DEG, KNOT, clamp, headingOf } from '../core/math.ts';
import { Input } from '../core/input.ts';
import type { TerrainData } from '../world/terrainData.ts';
import { WIND_PRESETS } from '../world/wind.ts';
import { World } from './world.ts';
import { Kiter } from './kiter.ts';
import { CameraRig, CAMERA_LABELS } from '../render/cameraRig.ts';
import { Hud } from '../ui/hud.ts';
import { RIDER_LOOKS } from '../render/riderModel.ts';
import { KITE_PALETTES } from '../render/kiteModel.ts';
import { NO_INPUT, type RigInput, type JumpResult } from '../sim/rig.ts';
import type { PilotIntent } from '../sim/autopilot.ts';
import { Scoring } from './scoring.ts';
import { MONTHS, MONTH_DAY } from '../content/culture.ts';
import { Spray, RiderEffects } from '../render/effects.ts';
import { AudioEngine } from '../audio/audio.ts';
import { AiRiders } from './aiRiders.ts';
import { Windsurfers } from './windsurfers.ts';
import { Logbook } from './logbook.ts';
import type { SessionSummary } from '../ui/menu.ts';
import { SPECIES } from '../content/culture.ts';

export type ModeId = 'free' | 'school' | 'downwinder' | 'race';

export interface SessionConfig {
  mode: ModeId;
  kiteSize: number;
  wind: keyof typeof WIND_PRESETS;
  month: number;
  startHours: number;
  assisted: boolean;
}

export const DEFAULT_CONFIG: SessionConfig = {
  mode: 'free',
  kiteSize: 9,
  wind: 'classic',
  month: 2,
  startHours: 13.5,
  assisted: true,
};

/** Hooks a game mode can implement. */
export interface Mode {
  readonly id: ModeId;
  start(game: Game): void;
  update(game: Game, dt: number): void;
  onLand?(game: Game, jump: JumpResult): void;
  onCrash?(game: Game, reason: string): void;
  /** Extra minimap markers. */
  markers?(game: Game): { x: number; z: number; color: string; label?: string }[];
  dispose?(game: Game): void;
}

export type GameState = 'title' | 'playing' | 'paused' | 'summary';

/** Game time runs faster than real time so a session sees the wind build and the sun drop. */
export const TIME_SCALE = 8;

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly world: World;
  readonly input: Input;
  readonly cam: CameraRig;
  readonly hud: Hud;
  readonly player: Kiter;
  readonly scoring = new Scoring();
  readonly spray = new Spray();
  readonly playerFx = new RiderEffects();
  readonly audio = new AudioEngine();
  readonly root: HTMLElement;
  readonly ai: AiRiders;
  readonly logbook = new Logbook();
  /** Per-session statistics for the summary. */
  stats = { distance: 0, topSpeed: 0, sightings: [] as string[], landmarks: [] as string[] };
  onSessionEnd: ((s: SessionSummary) => void) | null = null;
  /** Other riders' positions for the minimap. */
  others: { x: number; z: number }[] = [];
  /** Fixed debug viewpoint (?view=x,y,z,tx,ty,tz) for screenshots. */
  debugView: THREE.Vector3[] | null = null;
  state: GameState = 'title';
  config: SessionConfig = { ...DEFAULT_CONFIG };
  mode: Mode | null = null;
  time = 0;
  sessionTime = 0;
  private last = 0;
  private cineT = 0;
  private hudVisible = true;
  private frames = 0;
  fps = 60;
  private fpsAcc = 0;
  /** Systems that want a per-frame update (AI riders, wildlife, effects, audio). */
  readonly systems: { update(dt: number, game: Game): void }[] = [];
  readonly listeners: {
    land: ((j: JumpResult) => void)[];
    crash: ((reason: string) => void)[];
    takeoff: ((lofted: boolean) => void)[];
    waterstart: (() => void)[];
    splash: ((strength: number) => void)[];
  } = { land: [], crash: [], takeoff: [], waterstart: [], splash: [] };
  onStateChange: ((s: GameState) => void) | null = null;

  constructor(root: HTMLElement, data: TerrainData) {
    this.root = root;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', reversedDepthBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.domElement.className = 'gl';
    root.appendChild(this.renderer.domElement);

    this.world = new World(data, WIND_PRESETS.classic);
    this.input = new Input(window);
    this.cam = new CameraRig(window.innerWidth / window.innerHeight);
    this.cam.attachMouse(this.renderer.domElement);
    this.hud = new Hud(root, data);
    this.hud.root.classList.add('off');

    this.player = new Kiter(9, RIDER_LOOKS[0], KITE_PALETTES[0]);
    this.world.scene.add(this.player.group);
    this.world.scene.add(this.spray.points, this.playerFx.wake.mesh);
    this.listeners.splash.push((strength) => {
      const p = this.player.rig.pos;
      this.spray.burst(p.x, this.world.surface(p.x, p.z), p.z, Math.round(30 + strength * 90), 1.5 + strength * 3);
      this.audio.event('splash', strength);
    });
    this.listeners.takeoff.push(() => this.audio.event('pop'));
    this.listeners.crash.push(() => this.audio.event('crash'));
    this.listeners.land.push((j) => this.audio.event(j.quality === 'clean' ? 'land' : j.quality === 'hard' ? 'hardLand' : 'crash', Math.min(1, j.height / 8)));
    this.world.wildlife.onSighting = (id) => this.handleSighting(id);
    this.ai = new AiRiders(this, 16);
    this.ai.reset(this);
    this.systems.push(this.ai, new Windsurfers(this, 6));
    this.player.rig.events = {
      land: (_r, j) => this.handleLand(j),
      crash: (_r, why) => {
        this.cam.shake(0.25);
        this.scoring.breakCombo();
        for (const l of this.listeners.crash) l(why);
        this.mode?.onCrash?.(this, why);
        for (const l of this.listeners.splash) l(1);
      },
      takeoff: (_r, lofted) => {
        for (const l of this.listeners.takeoff) l(lofted);
        if (lofted && this.player.rig.kite.tension > this.player.rig.mass * 9.81 * 1.6) this.hud.showToast('¡Aguas! Lofted by a gust', 2.5);
      },
      waterstart: () => {
        for (const l of this.listeners.waterstart) l();
      },
      sink: () => this.hud.showToast('Te hundiste · You sank. W to waterstart', 2.5),
      kiteDown: () => {
        this.hud.showToast('¡Cometa al agua! Kite down', 2.5);
        this.audio.event('kiteDown');
        for (const l of this.listeners.splash) l(0.6);
      },
      relaunched: () => {
        this.hud.showToast('¡Arriba! Kite relaunched', 2);
        this.audio.event('relaunch');
      },
      boardRecovered: () => this.hud.showToast('Board recovered', 2),
    };

    window.addEventListener('resize', () => this.resize());
    this.input.onKey((code) => this.onKey(code));
  }

  get rig() {
    return this.player.rig;
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.cam.camera.aspect = w / h;
    this.cam.camera.updateProjectionMatrix();
  }

  setState(s: GameState) {
    this.state = s;
    this.hud.root.classList.toggle('off', s !== 'playing' || !this.hudVisible);
    this.onStateChange?.(s);
  }

  private onKey(code: string) {
    if (this.state !== 'playing') return;
    if (code === 'KeyC') {
      this.cam.cycle();
      this.hud.showToast(CAMERA_LABELS[this.cam.mode], 1.5);
    } else if (code === 'KeyH') this.hud.toggleHelp();
    else if (code === 'KeyM' || code === 'Tab') this.hud.toggleMap();
    else if (code === 'KeyV') {
      this.hudVisible = !this.hudVisible;
      this.hud.root.classList.toggle('off', !this.hudVisible);
    } else if (code === 'Enter') this.hud.skipDialog();
  }

  /** Starts a session with the given config and mode. */
  startSession(config: SessionConfig, mode: Mode) {
    this.mode?.dispose?.(this);
    this.config = { ...config };
    this.world.hours = config.startHours;
    this.world.dayOfYear = MONTH_DAY[config.month] ?? 15;
    this.world.setWind(WIND_PRESETS[config.wind]);
    if (this.player.rig.kite.size !== config.kiteSize) this.player.setKiteSize(config.kiteSize, KITE_PALETTES[0]);
    this.player.manual = !config.assisted;
    this.player.pilot.reset();
    this.hud.setHelp(config.assisted);
    this.hud.showHelpFor(this.logbook.data.sessions < 2 ? 40 : 15);
    this.scoring.score = 0;
    this.scoring.breakCombo();
    this.scoring.jumps = this.scoring.cleanLandings = this.scoring.crashes = 0;
    this.scoring.best = { height: 0, airtime: 0, points: 0 };
    this.sessionTime = 0;
    this.stats = { distance: 0, topSpeed: 0, sightings: [], landmarks: [] };
    this.world.wildlife.setMonth(config.month);
    this.player.autoStart = true;
    this.mode = mode;
    this.ai.reset(this);
    this.hud.clearDialog();
    this.hud.setObjective(null);
    mode.start(this);
    this.cam.snap();
    this.setState('playing');
  }

  /** Puts the player in the water at a spot, heading across the wind on a chosen side. */
  spawnPlayer(x: number, z: number, side: 1 | -1 = 1) {
    const down = this.world.downwindHeading;
    // side +1: travel to the rider's right when facing downwind (toward the beach here).
    const heading = down + side * (Math.PI / 2) * 0.95;
    this.player.rig.spawn(x, z, heading, this.world.env);
    this.player.pilot.reset();
    this.cam.snap();
  }

  private handleSighting(id: string) {
    if (this.state !== 'playing' || this.stats.sightings.includes(id)) return;
    this.stats.sightings.push(id);
    const sp = SPECIES.find((s) => s.id === id);
    const isNew = this.logbook.addSpecies(id);
    if (sp) this.hud.showToast(`${isNew ? '¡Nuevo! ' : ''}${sp.es} · ${sp.en}`, 3.5);
    if (isNew) this.audio.event('checkpoint');
  }

  private visit(id: string, label: string) {
    if (this.stats.landmarks.includes(id)) return;
    this.stats.landmarks.push(id);
    if (this.logbook.addLandmark(id)) this.hud.showToast(`📍 ${label}`, 3);
  }

  /** Landmarks count as visited when you ride past them. */
  private checkLandmarks() {
    const r = this.player.rig.pos;
    const lm = this.world.data.world.landmarks;
    const near = (p: { x: number; z: number }, d: number) => Math.hypot(r.x - p.x, r.z - p.z) < d;
    if (near(lm.hotSprings, 450)) this.visit('hotSprings', 'Aguas termales · Hot Springs beach');
    if (near(lm.elSargento, 600)) this.visit('elSargento', 'El Sargento');
    if (near(lm.campNorth, 400)) this.visit('campground', 'El campamento · The campground');
    if (near(lm.mainBeach, 450)) this.visit('laVentana', 'La Ventana');
    const off = r.x - (this.world.data.coastX(r.z) ?? 0);
    if (off > 1800) this.visit('cerralvo', 'Isla Cerralvo dead ahead: out in the channel');
    // Too far out in the channel or off the map: the rescue panga brings you back.
    this.boundsWarn -= 1 / 60;
    const tooFar = off > 3800 || r.z < -11800 || r.z > 2600;
    if (off > 2800 && this.boundsWarn <= 0) {
      this.boundsWarn = 20;
      this.hud.say([{ who: 'chuy', es: '¡Regresa! Muy lejos.', en: 'Come back in! The channel gets rough out there and nobody will see you if you go down.' }]);
    }
    if (tooFar && this.player.rig.mode !== 'air') {
      const z = Math.min(-150, Math.max(-11000, r.z));
      this.spawnPlayer((this.world.data.coastX(z) ?? 0) + 350, z, -1);
      this.hud.showToast('Don Chuy towed you back to the bay', 3.5);
    }
  }

  private boundsWarn = 0;

  applyQuality(q: 'high' | 'medium') {
    this.renderer.setPixelRatio(q === 'high' ? Math.min(window.devicePixelRatio, 1.75) : 1);
    this.world.sky.sun.shadow.mapSize.set(q === 'high' ? 2048 : 1024, q === 'high' ? 2048 : 1024);
    this.world.sky.sun.shadow.map?.dispose();
    this.world.sky.sun.shadow.map = null;
    this.resize();
  }

  /** Ends the session and shows the summary (modes may supply their own). */
  endSession(reason: string, summary?: SessionSummary) {
    if (this.state === 'summary') return;
    const sc = this.scoring;
    this.logbook.recordSession(Math.round(sc.score), sc.best.height, sc.best.airtime);
    const s: SessionSummary = summary ?? {
      title: reason === 'sunset' ? 'Se acabó el viento · Sunset' : 'Fin de la sesión',
      lines: [
        { label: 'Puntos · Score', value: Math.round(sc.score).toLocaleString() },
        { label: 'Mejor salto · Best jump', value: `${sc.best.height.toFixed(1)} m` },
        { label: 'Vuelo · Hang time', value: `${sc.best.airtime.toFixed(1)} s` },
        { label: 'Saltos · Jumps', value: `${sc.jumps} (${sc.cleanLandings} clean)` },
        { label: 'Distancia', value: `${(this.stats.distance / 1000).toFixed(1)} km` },
        { label: 'Vel. máx · Top speed', value: `${(this.stats.topSpeed / KNOT).toFixed(1)} kn` },
      ],
      note: this.stats.sightings.length
        ? `Wildlife today: ${this.stats.sightings.map((id) => SPECIES.find((x) => x.id === id)?.en ?? id).join(', ')}.`
        : 'Keep an eye out for pelicans, dolphins and whales next time.',
    };
    this.setState('summary');
    this.audio.music('menu');
    this.onSessionEnd?.(s);
  }

  start() {
    const loop = (now: number) => {
      requestAnimationFrame(loop);
      this.frame(now);
    };
    requestAnimationFrame(loop);
  }

  private handleLand(j: JumpResult) {
    const call = this.scoring.land(j);
    if (j.quality !== 'crash') for (const t of call.tags) this.logbook.addTrick(t);
    if (j.height > 1.0 || j.quality === 'crash' || call.tags.length) {
      this.hud.showTrick(call.title, call.detail, call.points, call.cheer, call.good);
    }
    if (j.quality !== 'clean') this.cam.shake(j.quality === 'crash' ? 0.25 : 0.12);
    for (const l of this.listeners.land) l(j);
    for (const l of this.listeners.splash) l(Math.min(1, j.height / 8));
    this.mode?.onLand?.(this, j);
  }

  private readControls(): { input: RigInput; intent: PilotIntent } {
    const inp = this.input;
    const assisted = this.config.assisted;
    const rig = this.player.rig;
    const air = rig.mode === 'air';
    const carveKeys = assisted ? [['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']] : [['KeyA'], ['KeyD']];
    let carve = inp.keyAxis(carveKeys[0], carveKeys[1], 0);
    const powerKeys = assisted ? [['KeyS', 'ArrowDown'], ['KeyW', 'ArrowUp']] : [['KeyS'], ['KeyW']];
    let power = inp.keyAxis(powerKeys[0], powerKeys[1]);
    if (power === 0) power = -inp.axis(1);
    const jump = inp.isDown('Space') || inp.padDown(0);
    const grabHeld = inp.isDown('ShiftLeft', 'ShiftRight') || inp.padDown(2);
    const loop = inp.wasPressed('KeyK') || inp.padPressed(3);
    const relaunchHeld = inp.isDown('KeyR') || inp.padDown(1);

    // Manual bar: arrows steer and sheet.
    if (!assisted) {
      this.player.manualSteer = clamp(inp.keyAxis(['ArrowLeft'], ['ArrowRight'], 2), -1, 1);
      const sheetIn = inp.isDown('ArrowUp') || inp.trigger(1) > 0.3;
      const sheetOut = inp.isDown('ArrowDown') || inp.trigger(0) > 0.3;
      this.player.manualSheet = clamp(this.player.manualSheet + ((sheetIn ? 1 : 0) - (sheetOut ? 1 : 0)) * 0.016, 0.1, 1);
    }

    const side = rig.kiteSide;
    const bearAway = carve * side > 0.3;
    if (assisted && rig.mode === 'riding') {
      const downwindness = rig.dirX * rig.windX + rig.dirZ * rig.windZ;
      // Wait for the kite to reach 12 before carving through the downwind part of a transition.
      if (bearAway && downwindness > 0.1 && rig.kite.elevation < 64 * DEG) carve *= 0.22;
      // After landing pointed downwind, head back up onto a reach.
      if (carve === 0 && downwindness > 0.8 && rig.sinceLanding < 4) carve = -side * 0.6;
    }

    let grab = 0;
    if (air && grabHeld) grab = power > 0.3 ? 4 : power < -0.3 ? 3 : carve !== 0 ? 2 : 1;
    const input: RigInput = {
      ...NO_INPUT,
      carve: air ? 0 : carve,
      edge: jump && (rig.mode === 'riding' || air),
      spin: air ? carve : 0,
      flip: air ? power : 0,
      grab,
      drag: carve,
    };
    const go = power > 0.3 || (assisted && this.player.autoStart && rig.modeTime > 2.4 && (rig.mode === 'water' || rig.mode === 'crash'));
    const intent: PilotIntent = {
      power: air ? 0 : power,
      send: jump && rig.mode === 'riding',
      loop,
      relaunch: relaunchHeld || (assisted && rig.kite.downTime > 1.6),
      go,
      bearAway,
    };
    return { input, intent };
  }

  private updateAudio(dt: number) {
    const rig = this.player.rig;
    const w = this.world;
    const playing = this.state === 'playing';
    w.wind.sample(rig.pos.x, 2, rig.pos.z, w.data.sdf(rig.pos.x, rig.pos.z), tmpApp);
    const ax = tmpApp.x - rig.vel.x, az = tmpApp.z - rig.vel.z;
    const sd = w.data.sdf(this.cam.camera.position.x, this.cam.camera.position.z);
    this.audio.update(dt, {
      wind: playing ? Math.hypot(ax, az) : w.wind.base,
      kiteSpeed: playing ? rig.kite.airspeed : 0,
      tension: playing ? rig.kite.tension : 0,
      boardSpeed: playing && rig.mode === 'riding' ? rig.speed : 0,
      mode: playing ? rig.mode : 'menu',
      nearShore: clamp(1 - Math.abs(sd) / 250, 0, 1),
      chop: w.waves.amplitude,
      luff: playing ? rig.kite.luff : 0,
    });
  }

  private frame(now: number) {
    const dt = Math.min(0.05, (now - (this.last || now)) / 1000);
    this.last = now;
    this.time += dt;
    this.fpsAcc += dt;
    this.frames++;
    if (this.fpsAcc > 0.5) {
      this.fps = this.frames / this.fpsAcc;
      this.fpsAcc = 0;
      this.frames = 0;
    }
    this.input.poll();
    const w = this.world;

    if (this.state === 'playing') {
      this.sessionTime += dt;
      w.hours += (dt * TIME_SCALE) / 3600;
      w.step(dt);
      const { input, intent } = this.readControls();
      this.player.simulate(dt, input, intent, w.env);
      this.scoring.update(dt);
      const rig = this.player.rig;
      if (rig.mode === 'riding') this.stats.distance += rig.speed * dt;
      this.stats.topSpeed = Math.max(this.stats.topSpeed, rig.mode === 'riding' ? rig.speed : 0);
      this.checkLandmarks();
      this.mode?.update(this, dt);
      if (w.hours > 18.15 && this.state === 'playing') this.endSession('sunset');
    } else if (this.state === 'title') {
      w.step(dt);
      this.cineT += dt;
    }
    for (const s of this.systems) s.update(dt, this);
    this.player.updateVisuals(dt);
    if (this.state === 'playing') this.playerFx.update(dt, this.player.rig, w.env, this.spray);
    this.spray.update(dt, w.wind.downwindX * w.wind.base, w.wind.downwindZ * w.wind.base);

    if (this.debugView) {
      this.cam.camera.position.copy(this.debugView[0]);
      this.cam.camera.lookAt(this.debugView[1]);
      this.cam.camera.fov = 55;
      this.cam.camera.updateProjectionMatrix();
    } else if (this.state === 'title') {
      const lm = w.data.world.landmarks;
      this.cam.cinematic(this.cineT, new THREE.Vector3(lm.mainBeach.x + 500, 0, lm.mainBeach.z - 900), { height: (x, z) => w.groundOrWater(x, z) });
    } else {
      this.cam.update(dt, this.player.rig, { height: (x, z) => w.groundOrWater(x, z) });
    }
    const focus = this.state === 'title' ? this.cam.camera.position : this.player.rig.pos;
    w.updateVisuals(dt, this.time, this.cam.camera, focus);
    this.updateAudio(dt);

    if (this.state === 'playing') {
      const rig = this.player.rig;
      const gust = w.wind.base * (1 + w.wind.settings.gustiness * 0.9);
      const pilot = this.player.pilot;
      const tgt = this.config.assisted && rig.kite.mode === 'flying' ? targetAngles(pilot.target, rig.kite.center) : null;
      this.hud.update(dt, {
        rig,
        windKnots: windAt(w, rig.pos.x, rig.pos.z) / KNOT,
        gustKnots: gust / KNOT,
        windFrom: w.wind.fromRad,
        cameraYaw: cameraYaw(this.cam.camera),
        hours: w.hours,
        monthLabel: MONTHS[this.config.month] ?? '',
        score: this.scoring.score,
        combo: this.scoring.combo,
        assisted: this.config.assisted,
        pilotTarget: tgt,
        jumpCue:
          rig.mode === 'riding' && (this.input.isDown('Space') || this.input.padDown(0))
            ? rig.kite.elevation > 50 * DEG && rig.kite.elevation < 76 * DEG && rig.kite.h.y > 0
              ? 'pop'
              : 'load'
            : null,
        others: this.others,
        markers: this.mode?.markers?.(this) ?? [],
      });
    }
    this.renderer.render(w.scene, this.cam.camera);
    this.input.endFrame();
  }
}

const tmpWind = { x: 0, z: 0 };
const tmpApp = { x: 0, z: 0 };
function windAt(w: World, x: number, z: number) {
  return w.wind.sample(x, 10, z, w.data.sdf(x, z), tmpWind);
}

const tmpDir = new THREE.Vector3();
function cameraYaw(camera: THREE.Camera) {
  camera.getWorldDirection(tmpDir);
  return headingOf(tmpDir.x, tmpDir.z);
}

/** Converts an autopilot target direction into gauge azimuth/elevation. */
function targetAngles(t: THREE.Vector3, center: THREE.Vector3) {
  const cl = Math.hypot(center.x, center.z) || 1;
  const fx = center.x / cl, fz = center.z / cl;
  const rx = -fz, rz = fx;
  return { az: Math.atan2(t.x * rx + t.z * rz, t.x * fx + t.z * fz), el: Math.asin(clamp(t.y, -1, 1)) };
}
