import { Vector3 } from 'three';
import { DEG, G, RHO_AIR, clamp, damp, dampAngle, headingOf, wrapAngle } from '../core/math.ts';
import { Kite, type KiteEnv } from './kite.ts';
import { Waves } from '../world/waves.ts';

export type RiderMode = 'water' | 'riding' | 'air' | 'crash' | 'drag';

export interface RigInput {
  /** -1 carve left .. 1 carve right (relative to the direction of travel). */
  carve: number;
  /** Loading the edge for a jump; releasing it while riding pops. */
  edge: boolean;
  /** Air rotations: -1..1 around the vertical axis and the lateral axis. */
  spin: number;
  flip: number;
  /** 0 = no grab, otherwise a grab slot 1..4. */
  grab: number;
  /** Body-drag direction preference when the board is lost (-1..1). */
  drag: number;
}

export const NO_INPUT: RigInput = { carve: 0, edge: false, spin: 0, flip: 0, grab: 0, drag: 0 };

export interface RigEnv extends KiteEnv {
  waves: Waves;
  depth(x: number, z: number): number;
}

export type LandingQuality = 'clean' | 'hard' | 'crash';

export interface JumpResult {
  height: number;
  airtime: number;
  distance: number;
  spins: number;
  flips: number;
  /** Rotation directions: +1 / -1 per completed rotation (sign of the rotation). */
  spinDir: number;
  flipDir: number;
  grabTime: number;
  grabs: number[];
  kiteloop: boolean;
  quality: LandingQuality;
  switchLanding: boolean;
  reason?: string;
}

export interface RigEvents {
  takeoff?(rig: Rig, lofted: boolean): void;
  land?(rig: Rig, jump: JumpResult): void;
  crash?(rig: Rig, reason: string): void;
  waterstart?(rig: Rig): void;
  sink?(rig: Rig): void;
  kiteDown?(rig: Rig): void;
  relaunched?(rig: Rig): void;
  boardRecovered?(rig: Rig): void;
}

const HARNESS: Record<RiderMode, number> = { water: 0.15, riding: 1.0, air: 1.0, crash: 0.3, drag: 0.2 };
const tmp = new Vector3();

/**
 * A rider, board and kite. The kite's line tension pulls the rider; the board
 * planes, edges against the pull and carves; jumps come from popping off the
 * edge while the kite sweeps up through the window.
 */
export class Rig {
  readonly kite: Kite;
  readonly pos = new Vector3();
  readonly vel = new Vector3();
  readonly harness = new Vector3();
  readonly force = new Vector3();
  /** Compass heading of the board's direction of travel. */
  heading = Math.PI / 2;
  mode: RiderMode = 'water';
  modeTime = 0;
  mass = 78;
  hasBoard = true;
  readonly boardPos = new Vector3();
  readonly boardVel = new Vector3();

  /** 0..1 how hard the rider is digging the rail in. */
  edge = 0;
  /** Smoothed body lean against the kite (radians, visual). */
  lean = 0;
  /** Lateral slip ratio (0 = gripping, >1 = skidding). */
  slip = 0;
  speed = 0;

  // Jump bookkeeping.
  spin = 0;
  flip = 0;
  grab = 0;
  grabTime = 0;
  airTime = 0;
  maxHeight = 0;
  readonly takeoffPos = new Vector3();
  grabs = new Set<number>();
  kiteTurn = 0;
  private prevKiteH = new Vector3();
  private prevEdge = false;
  private edgeHeld = 0;
  private sinkTimer = 0;
  private loftVel = 0;
  private overTimer = 0;
  private slipTimer = 0;
  crashReason = '';
  /** True-wind downwind direction, refreshed every step. */
  windX = 0;
  windZ = 1;
  /** Seconds since the rider last landed or stood up, for "landed clean" grace. */
  sinceLanding = 99;
  events: RigEvents = {};

  constructor(kiteSize: number) {
    this.kite = new Kite(kiteSize);
  }

  get harnessHeight() {
    return HARNESS[this.mode];
  }

  /** Unit horizontal direction of travel. */
  get dirX() {
    return Math.sin(this.heading);
  }
  get dirZ() {
    return -Math.cos(this.heading);
  }

  /** +1 when the kite is on the rider's right of the direction of travel. */
  get kiteSide() {
    const nx = Math.cos(this.heading), nz = Math.sin(this.heading);
    return this.kite.u.x * nx + this.kite.u.z * nz >= 0 ? 1 : -1;
  }

  /** Places the rider floating in the water with the kite at 12 o'clock. */
  spawn(x: number, z: number, heading: number, env: RigEnv) {
    this.pos.set(x, env.surface(x, z) - 0.2, z);
    this.vel.set(0, 0, 0);
    this.heading = heading;
    this.setMode('water');
    this.hasBoard = true;
    this.kite.parkAtZenith(env.wind.downwindX, env.wind.downwindZ);
    this.harness.copy(this.pos).setY(this.pos.y + this.harnessHeight);
    this.kite.position.copy(this.harness).addScaledVector(this.kite.u, this.kite.lineLength);
    this.spin = this.flip = 0;
    this.edge = 0;
  }

  private setMode(mode: RiderMode) {
    this.mode = mode;
    this.modeTime = 0;
  }

  surface(env: RigEnv, x: number, z: number) {
    return env.surface(x, z);
  }

  step(dt: number, input: RigInput, env: RigEnv) {
    this.modeTime += dt;
    this.sinceLanding += dt;
    this.windX = env.wind.downwindX;
    this.windZ = env.wind.downwindZ;
    this.harness.copy(this.pos);
    this.harness.y += this.harnessHeight;
    const wasFlying = this.kite.mode === 'flying';
    this.prevKiteH.copy(this.kite.h);
    this.kite.step(dt, this.harness, this.vel, env);
    if (wasFlying && this.kite.mode === 'down') this.events.kiteDown?.(this);
    if (this.mode === 'air' && this.kite.mode === 'flying') {
      tmp.crossVectors(this.prevKiteH, this.kite.h);
      this.kiteTurn += Math.atan2(tmp.dot(this.kite.u), this.prevKiteH.dot(this.kite.h));
    }
    this.force.copy(this.kite.u).multiplyScalar(this.kite.tension);

    switch (this.mode) {
      case 'riding':
        this.stepRiding(dt, input, env);
        break;
      case 'air':
        this.stepAir(dt, input, env);
        break;
      case 'water':
        this.stepWater(dt, input, env);
        break;
      case 'crash':
        this.stepCrash(dt, env);
        break;
      case 'drag':
        this.stepDrag(dt, input, env);
        break;
    }
    this.keepOffBeach(env);
    this.speed = Math.hypot(this.vel.x, this.vel.z);
    this.prevEdge = input.edge;
  }

  private stepRiding(dt: number, input: RigInput, env: RigEnv) {
    const m = this.mass;
    const F = this.force;

    // Carving rotates the board and, mostly, the velocity with it.
    let vf = this.vel.x * this.dirX + this.vel.z * this.dirZ;
    const absV = Math.abs(vf);
    const turnRate = clamp(0.45 + 0.17 * absV, 0.45, 1.85);
    // Loading the edge for a jump means carving a little upwind, away from the kite.
    const loadCarve = input.edge && this.edgeHeld < 0.45 && input.carve === 0 ? -this.kiteSide * 0.65 : 0;
    const dpsi = (input.carve + loadCarve) * turnRate * dt;
    if (dpsi !== 0) {
      this.heading = wrapAngle(this.heading + dpsi);
      const c = Math.cos(dpsi * 0.94), s = Math.sin(dpsi * 0.94);
      const vx = this.vel.x, vz = this.vel.z;
      this.vel.x = vx * c - vz * s;
      this.vel.z = vz * c + vx * s;
    }
    if (input.edge) this.edgeHeld += dt;
    else this.edgeHeld = 0;
    const edgeTarget = input.edge ? 1 : 0.25 + 0.35 * Math.abs(input.carve);
    this.edge = damp(this.edge, edgeTarget, 7, dt);

    const bx2 = this.dirX, bz2 = this.dirZ, nx2 = Math.cos(this.heading), nz2 = Math.sin(this.heading);
    vf = this.vel.x * bx2 + this.vel.z * bz2;
    const vl = this.vel.x * nx2 + this.vel.z * nz2;
    const speed = Math.abs(vf);
    const Ff = F.x * bx2 + F.z * bz2;
    const Fl = F.x * nx2 + F.z * nz2;

    // Planing drag: a displacement hump below ~4 m/s, then quadratic; chop and edging add drag.
    const chop = 1 + env.waves.amplitude * 0.9;
    let drag = 2.15 * chop * vf * speed + 105 * vf * Math.max(0, 1 - speed / 4.2);
    // Induced drag of the edge holding the kite's sideways pull: it is what limits pointing upwind.
    drag += Math.sign(vf) * (0.0062 * Fl * Fl) / Math.max(vf * vf, 4);
    drag += 1.1 * vf * speed * this.edge * (input.edge ? 1 : 0.35);
    const af = (Ff - drag) / m;

    const needed = -Fl - (m * vl) / 0.12;
    const grip = 560 + 175 * speed + 420 * this.edge;
    const Flat = clamp(needed, -grip, grip);
    this.slip = Math.abs(needed) / grip;
    const al = (Fl + Flat) / m;
    this.vel.x += (bx2 * af + nx2 * al) * dt;
    this.vel.z += (bz2 * af + nz2 * al) * dt;

    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;

    const depth = env.depth(this.pos.x, this.pos.z);
    const atten = Waves.depthFactor(depth);
    const sy = env.surface(this.pos.x, this.pos.z);
    const sv = env.waves.verticalSpeed(this.pos.x, this.pos.z, atten);
    const lean = Math.atan2(Math.abs(Fl), m * G) * Math.sign(-Fl);
    this.lean = damp(this.lean, clamp(lean, -60 * DEG, 60 * DEG), 8, dt);

    // Popping off the edge: legs plus the line tension stored against the edge.
    if (this.prevEdge && !input.edge && speed > 3.2) {
      const up = Math.max(0, this.kite.u.y);
      const pop = 1.4 + 0.22 * speed + 0.0022 * this.kite.tension * up;
      this.takeoff(Math.max(sv, 0) + clamp(pop, 1.5, 11), false);
      return;
    }
    // The kite can simply lift you off the water (lofting) once the upward pull outlasts your
    // weight for a moment. A loaded edge holds you down a little longer.
    const lift = F.y - m * G * (input.edge ? 1.35 : 1);
    this.loftVel = lift > 0 ? this.loftVel + (lift / m) * dt : Math.max(0, this.loftVel - 4 * dt);
    if (this.loftVel > 0.7) {
      this.loftVel = 0;
      this.takeoff(Math.max(0, sv) + 0.7, true);
      return;
    }
    this.pos.y = sy;
    this.vel.y = sv;

    if (speed < 1.35 || this.kite.mode === 'down') {
      this.sinkTimer += dt;
      // Mid-transition the kite is overhead and the board coasts; give the rider a moment.
      const grace = this.kite.mode === 'down' ? 0.6 : this.kite.u.y > 0.8 ? 2.2 : 1.1;
      if (this.sinkTimer > grace) {
        this.sinkTimer = 0;
        this.setMode('water');
        this.events.sink?.(this);
      }
    } else this.sinkTimer = 0;

    const limit = 2.85 * m * G;
    if (this.kite.tension > limit) this.overTimer += dt;
    else this.overTimer = Math.max(0, this.overTimer - dt);
    if (this.overTimer > 0.3) {
      this.overTimer = 0;
      this.doCrash('Overpowered: the kite yanked you off the board', false);
      return;
    }
    if (this.slip > 2.4 && speed > 3) this.slipTimer += dt;
    else this.slipTimer = Math.max(0, this.slipTimer - dt);
    if (this.slipTimer > 0.6) {
      this.slipTimer = 0;
      this.doCrash('Edge blew out: dragged downwind', false);
    }
  }

  private takeoff(vy: number, lofted: boolean) {
    this.setMode('air');
    this.vel.y = vy;
    this.pos.y += 0.05;
    this.airTime = 0;
    this.maxHeight = 0;
    this.takeoffPos.copy(this.pos);
    this.spin = 0;
    this.flip = 0;
    this.grabTime = 0;
    this.grabs.clear();
    this.kiteTurn = 0;
    this.events.takeoff?.(this, lofted);
  }

  private stepAir(dt: number, input: RigInput, env: RigEnv) {
    const m = this.mass;
    const F = this.force;
    const v = this.vel.length();
    const dragK = 0.5 * RHO_AIR * 0.55 * v;
    this.vel.x += ((F.x - dragK * this.vel.x) / m) * dt;
    this.vel.y += ((F.y - dragK * this.vel.y) / m - G) * dt;
    this.vel.z += ((F.z - dragK * this.vel.z) / m) * dt;
    this.pos.addScaledVector(this.vel, dt);
    this.airTime += dt;

    const sy = env.surface(this.pos.x, this.pos.z);
    this.maxHeight = Math.max(this.maxHeight, this.pos.y - sy);

    const grabbing = input.grab > 0;
    if (grabbing) {
      this.grab = input.grab;
      this.grabTime += dt;
      this.grabs.add(input.grab);
    } else this.grab = 0;
    const rate = grabbing ? 0.78 : 1;
    this.spin += input.spin * 6.2 * rate * dt;
    this.flip += input.flip * 5.4 * rate * dt;
    // Without input, partial rotations settle to the nearest whole one (a rider spots the landing).
    if (input.spin === 0) {
      const rem = wrapAngle(this.spin);
      if (Math.abs(rem) < 50 * DEG) this.spin -= rem * Math.min(1, dt * 3.2);
    }
    if (input.flip === 0) {
      const rem = wrapAngle(this.flip);
      if (Math.abs(rem) < 45 * DEG) this.flip -= rem * Math.min(1, dt * 3.2);
    }
    // Riders bear the board away to line it up with the landing.
    const hv = Math.hypot(this.vel.x, this.vel.z);
    if (hv > 1.5 && input.spin === 0) {
      let target = headingOf(this.vel.x, this.vel.z);
      if (Math.abs(wrapAngle(target - this.heading)) > Math.PI / 2) target = wrapAngle(target + Math.PI);
      this.heading = dampAngle(this.heading, target, this.vel.y < 0 ? 2.2 : 1.0, dt);
    }
    this.edge = damp(this.edge, 0.2, 4, dt);
    this.lean = damp(this.lean, 0, 3, dt);

    if (this.pos.y <= sy && this.vel.y < 0) this.land(sy);
  }

  private land(sy: number) {
    const spinRem = wrapAngle(this.spin);
    const flipRem = wrapAngle(this.flip);
    const spins = Math.round(Math.abs(this.spin) / (2 * Math.PI));
    const flips = Math.round(Math.abs(this.flip) / (2 * Math.PI));
    const boardHeading = wrapAngle(this.heading + this.spin);
    const hv = Math.hypot(this.vel.x, this.vel.z);
    const velHeading = hv > 0.5 ? headingOf(this.vel.x, this.vel.z) : boardHeading;
    let align = Math.abs(wrapAngle(boardHeading - velHeading));
    const switchLanding = align > Math.PI / 2;
    if (switchLanding) align = Math.PI - align;
    const vy = -this.vel.y;

    let quality: LandingQuality = 'clean';
    let reason: string | undefined;
    if (Math.abs(flipRem) > 55 * DEG) {
      quality = 'crash';
      reason = 'Under-rotated: landed on your back';
    } else if (Math.abs(spinRem) > 75 * DEG && Math.abs(spinRem) < 105 * DEG) {
      quality = 'crash';
      reason = 'Landed sideways';
    } else if (align > 58 * DEG && hv > 2.5) {
      quality = 'crash';
      reason = 'Board not pointing where you were going';
    } else if (vy > 10.5) {
      quality = 'crash';
      reason = 'Way too hard: knees buckled';
    } else if (vy > 6.8 || align > 35 * DEG || Math.abs(flipRem) > 30 * DEG) {
      quality = 'hard';
    }
    if (this.kite.mode === 'down' && quality !== 'crash') {
      quality = 'crash';
      reason = 'Kite fell out of the sky';
    }

    const jump: JumpResult = {
      height: this.maxHeight,
      airtime: this.airTime,
      distance: Math.hypot(this.pos.x - this.takeoffPos.x, this.pos.z - this.takeoffPos.z),
      spins,
      flips,
      spinDir: Math.sign(this.spin),
      flipDir: Math.sign(this.flip),
      grabTime: this.grabTime,
      grabs: [...this.grabs],
      kiteloop: Math.abs(this.kiteTurn) > 1.75 * Math.PI,
      quality,
      switchLanding,
      reason,
    };

    this.pos.y = sy;
    if (quality === 'crash') {
      this.events.land?.(this, jump);
      this.doCrash(reason ?? 'Crash', vy > 8.5 || Math.abs(flipRem) > 100 * DEG);
      return;
    }
    // Line the board up with the landing and keep riding.
    this.heading = switchLanding ? wrapAngle(boardHeading + Math.PI) : boardHeading;
    const keep = quality === 'clean' ? 0.92 : 0.6;
    const bx = this.dirX, bz = this.dirZ;
    const vf = Math.max(2.8, (this.vel.x * bx + this.vel.z * bz) * keep);
    this.vel.set(bx * vf, 0, bz * vf);
    this.spin = 0;
    this.flip = 0;
    this.grab = 0;
    this.setMode('riding');
    this.sinceLanding = 0;
    this.sinkTimer = 0;
    this.events.land?.(this, jump);
  }

  doCrash(reason: string, severe: boolean) {
    this.crashReason = reason;
    this.setMode('crash');
    this.vel.multiplyScalar(0.45);
    this.vel.y = Math.min(this.vel.y, 0);
    if (this.kite.u.y < Math.sin(32 * DEG) || severe) this.kite.crash();
    if (severe && this.hasBoard) {
      this.hasBoard = false;
      // The board skips away downwind of the rider.
      this.boardPos.set(
        this.pos.x + this.kite.center.x * 9 + this.dirX * 4,
        this.pos.y,
        this.pos.z + this.kite.center.z * 9 + this.dirZ * 4,
      );
      this.boardVel.set(0, 0, 0);
    }
    this.spin = 0;
    this.flip = 0;
    this.edge = 0;
    this.events.crash?.(this, reason);
  }

  private floatBody(dt: number, env: RigEnv, extraDrag: number) {
    const m = this.mass;
    const F = this.force;
    const hv = Math.hypot(this.vel.x, this.vel.z);
    const k = 75 + 150 * hv + extraDrag;
    this.vel.x += ((F.x - k * this.vel.x) / m) * dt;
    this.vel.z += ((F.z - k * this.vel.z) / m) * dt;
    this.vel.y = 0;
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    this.pos.y = damp(this.pos.y, env.surface(this.pos.x, this.pos.z) - 0.2, 6, dt);
  }

  private stepCrash(dt: number, env: RigEnv) {
    this.floatBody(dt, env, 120);
    this.lean = damp(this.lean, 0, 3, dt);
    if (this.modeTime > 1.5) this.setMode(this.hasBoard ? 'water' : 'drag');
  }

  private stepWater(dt: number, input: RigInput, env: RigEnv) {
    this.floatBody(dt, env, 0);
    this.heading = wrapAngle(this.heading + input.carve * 1.5 * dt);
    this.edge = damp(this.edge, 0, 3, dt);
    this.lean = damp(this.lean, 0, 3, dt);
    if (this.kite.mode !== 'flying' || !this.hasBoard || this.modeTime < 0.6) return;
    const bx = this.dirX, bz = this.dirZ;
    const F = this.force;
    const forward = F.x * bx + F.z * bz;
    const vf = this.vel.x * bx + this.vel.z * bz;
    if (forward > 170 && F.y > 150 && vf > 0.6) {
      this.setMode('riding');
      const v = Math.max(vf, 2.7);
      this.vel.set(bx * v, 0, bz * v);
      this.pos.y = env.surface(this.pos.x, this.pos.z);
      this.sinceLanding = 0;
      this.events.waterstart?.(this);
    }
  }

  private stepDrag(dt: number, input: RigInput, env: RigEnv) {
    // Body dragging: the kite pulls you along and an outstretched arm lets you angle it.
    this.floatBody(dt, env, -40);
    const toBoardX = this.boardPos.x - this.pos.x, toBoardZ = this.boardPos.z - this.pos.z;
    const dist = Math.hypot(toBoardX, toBoardZ);
    if (dist > 0.1) {
      const steer = clamp(input.drag, -1, 1) * 0.9;
      this.vel.x += (toBoardX / dist) * (1.2 + steer * 0.2) * dt;
      this.vel.z += (toBoardZ / dist) * (1.2 + steer * 0.2) * dt;
      this.heading = dampAngle(this.heading, headingOf(toBoardX, toBoardZ), 2, dt);
    }
    // The board drifts slowly with the wind.
    this.boardPos.x += env.wind.downwindX * 0.3 * dt;
    this.boardPos.z += env.wind.downwindZ * 0.3 * dt;
    this.boardPos.y = env.surface(this.boardPos.x, this.boardPos.z);
    if (dist < 2.4) {
      this.hasBoard = true;
      this.setMode('water');
      this.events.boardRecovered?.(this);
    }
  }

  /** Never let the rider climb onto the sand: the beach stops you and turns you around. */
  private keepOffBeach(env: RigEnv) {
    const sd = env.sdf(this.pos.x, this.pos.z);
    if (sd < -4) return;
    const e = 3;
    const gx = env.sdf(this.pos.x + e, this.pos.z) - env.sdf(this.pos.x - e, this.pos.z);
    const gz = env.sdf(this.pos.x, this.pos.z + e) - env.sdf(this.pos.x, this.pos.z - e);
    const gl = Math.hypot(gx, gz) || 1;
    const ox = -gx / gl, oz = -gz / gl; // offshore direction
    const push = sd + 4;
    this.pos.x += ox * push;
    this.pos.z += oz * push;
    const into = this.vel.x * -ox + this.vel.z * -oz;
    if (into > 0) {
      this.vel.x += ox * into * 1.6;
      this.vel.z += oz * into * 1.6;
    }
    if (this.mode === 'riding' && this.speed < 2.5) {
      this.heading = headingOf(ox + env.wind.downwindX * 0.3, oz + env.wind.downwindZ * 0.3);
      this.setMode('water');
      this.events.sink?.(this);
    }
  }

  /** Kite relaunch effort while it is in the water (0..1). Returns true on lift-off. */
  relaunch(dt: number, effort: number) {
    const ok = this.kite.workRelaunch(dt, effort);
    if (ok) this.events.relaunched?.(this);
    return ok;
  }
}
