import * as THREE from 'three';
import { DEG, clamp, mulberry32, wrapAngle } from '../core/math.ts';
import { Kiter } from './kiter.ts';
import { RIDER_LOOKS } from '../render/riderModel.ts';
import { KITE_PALETTES } from '../render/kiteModel.ts';
import { RiderEffects, type Spray } from '../render/effects.ts';
import { NO_INPUT, type RigInput } from '../sim/rig.ts';
import type { PilotIntent } from '../sim/autopilot.ts';
import type { Game } from './game.ts';

interface Brain {
  /** Which way along the beach the rider is heading: +1 offshore (east), -1 inshore. */
  tack: 1 | -1;
  /** Offshore band they ride in, metres from the coast. */
  near: number;
  far: number;
  /** Home spot along the beach they try to hold. */
  homeZ: number;
  /** Upwind pointing (radians above a beam reach). */
  point: number;
  jumpTimer: number;
  jumpHold: number;
  holding: number;
  trick: { spin: number; flip: number; grab: number };
  skill: number;
}

export interface AiKiter {
  k: Kiter;
  brain: Brain;
  fx: RiderEffects;
  active: boolean;
}

/** Other riders sharing the bay: same physics, a simple brain, an autopilot on the bar. */
export class AiRiders {
  readonly riders: AiKiter[] = [];
  readonly group = new THREE.Group();
  private rand = mulberry32(2024);

  constructor(game: Game, count: number) {
    game.world.scene.add(this.group);
    const lm = game.world.data.world.landmarks;
    const hotspots = [lm.mainBeach.z, lm.campNorth.z, lm.campNorth.z - 600, lm.elSargento.z, lm.elSargento.z + 900, lm.hotSprings.z];
    for (let i = 0; i < count; i++) {
      const r = this.rand;
      const look = RIDER_LOOKS[(i + 1) % RIDER_LOOKS.length];
      const palette = KITE_PALETTES[(i + 1) % KITE_PALETTES.length];
      const k = new Kiter(9, look, palette, 0x3a3a3a);
      const fx = new RiderEffects();
      this.group.add(k.group, fx.wake.mesh);
      const homeZ = hotspots[i % hotspots.length] + (r() - 0.5) * 700;
      const brain: Brain = {
        tack: r() < 0.5 ? 1 : -1,
        near: 60 + r() * 120,
        far: 350 + r() * 900,
        homeZ,
        point: (18 + r() * 22) * DEG,
        jumpTimer: 4 + r() * 14,
        jumpHold: 0,
        holding: 0,
        trick: { spin: 0, flip: 0, grab: 0 },
        skill: r(),
      };
      this.riders.push({ k, brain, fx, active: true });
    }
  }

  /** Re-seeds riders around the bay for a new session (kite sizes to suit the wind). */
  reset(game: Game) {
    const w = game.world;
    const knots = w.wind.settings.knots;
    const size = knots >= 23 ? 7 : knots >= 17 ? 9 : 12;
    for (const a of this.riders) {
      const r = this.rand;
      const kSize = Math.max(6, size + Math.round((r() - 0.5) * 3));
      if (a.k.rig.kite.size !== kSize) {
        const palette = KITE_PALETTES[Math.floor(r() * KITE_PALETTES.length)];
        a.k.setKiteSize(kSize, palette);
      }
      const z = a.brain.homeZ + (r() - 0.5) * 300;
      const coast = w.data.coastX(z) ?? 100;
      const x = coast + a.brain.near + r() * (a.brain.far - a.brain.near);
      const down = w.downwindHeading;
      a.brain.tack = r() < 0.5 ? 1 : -1;
      const heading = down - a.brain.tack * (Math.PI / 2) * 0.95;
      a.k.rig.spawn(x, z, heading, w.env);
      // Start most riders already up and riding.
      a.k.rig.mode = 'riding';
      a.k.rig.vel.set(Math.sin(heading) * 7, 0, -Math.cos(heading) * 7);
      a.k.rig.kite.u.set(w.wind.downwindX * 0.55 + Math.sin(heading) * 0.55, 0.62, w.wind.downwindZ * 0.55 - Math.cos(heading) * 0.55).normalize();
      a.k.pilot.reset();
      a.active = true;
    }
  }

  update(dt: number, game: Game) {
    const w = game.world;
    const cam = game.cam.camera.position;
    const spray: Spray = game.spray;
    const others: { x: number; z: number }[] = [];
    for (const a of this.riders) {
      const rig = a.k.rig;
      const dist = Math.hypot(rig.pos.x - cam.x, rig.pos.z - cam.z);
      // Riders far away are simulated more coarsely and hidden.
      const visible = dist < 3500;
      a.k.group.visible = visible;
      a.fx.wake.mesh.visible = dist < 600;
      if (game.state === 'playing' || game.state === 'title') {
        const { input, intent } = this.think(a, game, dt);
        a.k.simulate(dt, input, intent, w.env, dist < 1500 ? 8 : 3);
      }
      if (visible) a.k.updateVisuals(dt);
      if (dist < 600) a.fx.update(dt, rig, w.env, dist < 120 ? spray : DUMMY_SPRAY);
      others.push({ x: rig.pos.x, z: rig.pos.z });
    }
    game.others = others;
  }

  private think(a: AiKiter, game: Game, dt: number): { input: RigInput; intent: PilotIntent } {
    const b = a.brain;
    const rig = a.k.rig;
    const w = game.world;
    const coast = w.data.coastX(rig.pos.z) ?? 0;
    const off = rig.pos.x - coast;
    // Turn around at the edges of the riding band.
    if (b.tack === 1 && off > b.far) b.tack = -1;
    else if (b.tack === -1 && off < b.near) b.tack = 1;
    // Hold station: drifted downwind (south) of home → point higher; upwind of it → bear off.
    const drift = rig.pos.z - b.homeZ;
    const point = clamp(b.point + drift * 0.0009, 5 * DEG, 48 * DEG);
    const down = w.downwindHeading;
    // Tack +1 travels to the left of downwind (east here), -1 to the right.
    const beam = down - b.tack * (Math.PI / 2);
    const desired = beam - b.tack * point;
    let carve = 0;
    let bearAway = false;
    if (rig.mode === 'riding' || rig.mode === 'water') {
      const err = wrapAngle(desired - rig.heading);
      carve = clamp(err * 1.6, -1, 1);
      bearAway = carve * rig.kiteSide > 0.3;
    }
    // Avoid the player.
    const p = game.player.rig.pos;
    const dx = p.x - rig.pos.x, dz = p.z - rig.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 30 && rig.mode === 'riding') {
      const ahead = (dx * rig.dirX + dz * rig.dirZ) / (d || 1);
      if (ahead > 0.3) carve = clamp(carve + (dx * rig.dirZ - dz * rig.dirX > 0 ? -0.8 : 0.8), -1, 1);
    }

    // Jumps and the odd trick.
    let edge = false;
    b.jumpTimer -= dt;
    if (rig.mode === 'riding' && rig.speed > 6.5 && b.jumpTimer <= 0 && b.holding <= 0) {
      b.holding = 0.45 + b.skill * 0.5;
      b.jumpTimer = 7 + (1 - b.skill) * 16 + this.rand() * 10;
      const r = this.rand();
      b.trick = { spin: 0, flip: 0, grab: 0 };
      if (b.skill > 0.5 && r < 0.35) b.trick.flip = this.rand() < 0.7 ? -1 : 1;
      else if (b.skill > 0.3 && r < 0.6) b.trick.grab = 1 + Math.floor(this.rand() * 4);
    }
    if (b.holding > 0) {
      b.holding -= dt;
      edge = b.holding > 0;
    }
    let spin = 0, flip = 0, grab = 0;
    if (rig.mode === 'air') {
      const full = Math.abs(rig.flip) >= Math.PI * 2 - 0.4;
      if (b.trick.flip && !full && rig.airTime > 0.2) flip = b.trick.flip;
      if (b.trick.grab && rig.airTime > 0.3 && rig.vel.y > -3) grab = b.trick.grab;
    }
    const input: RigInput = { ...NO_INPUT, carve: rig.mode === 'air' ? 0 : carve, edge, spin, flip, grab };
    const intent: PilotIntent = {
      power: rig.speed < 5 ? 1 : 0,
      send: edge && rig.mode === 'riding',
      loop: false,
      relaunch: rig.kite.downTime > 2,
      go: rig.modeTime > 2 + b.skill,
      bearAway,
    };
    return { input, intent };
  }
}

const DUMMY_SPRAY = { emit() {}, burst() {}, update() {} } as unknown as Spray;
