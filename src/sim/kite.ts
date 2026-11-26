import { Vector3 } from 'three';
import { DEG, RHO_AIR, clamp, damp, smoothstep } from '../core/math.ts';
import type { Wind } from '../world/wind.ts';

/** Angle between the window centre (apparent wind) and its edge. Encodes the kite's lift/drag. */
export const EDGE_ANGLE = 78 * DEG;
export const COS_EDGE = Math.cos(EDGE_ANGLE);

export interface KiteEnv {
  wind: Wind;
  sdf(x: number, z: number): number;
  surface(x: number, z: number): number;
}

export type KiteMode = 'flying' | 'down';

const UP = new Vector3(0, 1, 0);
const tmpA = new Vector3();
const tmpB = new Vector3();
const tmpC = new Vector3();
const windOut = { x: 0, z: 0 };

/**
 * A leading-edge-inflatable kite flying on the surface of a sphere (the line
 * length) around the rider's harness. Its speed and line tension come from the
 * apparent wind and where it sits in the wind window: deep in the window it
 * flies fast and pulls hard, at the edge it parks with a light pull.
 */
export class Kite {
  size: number;
  lineLength = 22;
  /** Unit vector harness -> kite. */
  readonly u = new Vector3(0.3, 0.9, 0.3).normalize();
  /** Unit heading, tangent to the sphere: where the leading edge points. */
  readonly h = new Vector3(0, 1, 0);
  speed = 0;
  tension = 0;
  mode: KiteMode = 'flying';
  /** Bar steering input this step, -1 (left) .. 1 (right), as seen by the rider. */
  steer = 0;
  /** 0 = bar fully out (depowered) .. 1 = bar in. */
  sheet = 0.8;

  /** Unit window centre (direction of the apparent wind at the kite). */
  readonly center = new Vector3(0, 0, 1);
  readonly apparent = new Vector3();
  /** 0 at the window edge .. 1 in the heart of the power zone. */
  depth = 0;
  /** Flagging/luffing amount (0..1) when the kite overflies the edge or front-stalls. */
  luff = 0;
  airspeed = 0;
  /** Seconds spent in the water, and relaunch progress (0..1). */
  downTime = 0;
  relaunch = 0;
  /** World position, refreshed every step. */
  readonly position = new Vector3();
  /** Smoothed steering for the visual bank of the canopy. */
  bank = 0;

  constructor(size: number) {
    this.size = size;
    this.h.copy(UP).addScaledVector(this.u, -this.u.y).normalize();
  }

  get elevation() {
    return Math.asin(clamp(this.u.y, -1, 1));
  }

  /** Signed azimuth from the horizontal window centre (+ = rider's right when facing downwind). */
  get azimuth() {
    const cx = this.center.x, cz = this.center.z;
    const len = Math.hypot(cx, cz) || 1;
    const fx = cx / len, fz = cz / len;
    const rx = -fz, rz = fx;
    return Math.atan2(this.u.x * rx + this.u.z * rz, this.u.x * fx + this.u.z * fz);
  }

  /** Puts the kite at the top of the window (12 o'clock) for a fresh start. */
  parkAtZenith(downwindX: number, downwindZ: number) {
    this.u.set(downwindX * Math.cos(EDGE_ANGLE - 4 * DEG), Math.sin(EDGE_ANGLE - 4 * DEG), downwindZ * Math.cos(EDGE_ANGLE - 4 * DEG)).normalize();
    this.h.copy(UP).addScaledVector(this.u, -this.u.y).normalize();
    this.speed = 0;
    this.mode = 'flying';
    this.luff = 0;
    this.relaunch = 0;
    this.downTime = 0;
  }

  /** Line attachment point (harness/bar) in world space. */
  step(dt: number, harness: Vector3, riderVel: Vector3, env: KiteEnv) {
    const L = this.lineLength;
    this.position.copy(harness).addScaledVector(this.u, L);
    const kp = this.position;
    env.wind.sample(kp.x, Math.max(0.5, kp.y), kp.z, env.sdf(kp.x, kp.z), windOut);
    // Apparent wind at the kite in the rider's frame (the kite's own motion excluded).
    this.apparent.set(windOut.x - riderVel.x, -riderVel.y, windOut.z - riderVel.z);
    const wa = this.apparent.length();
    if (wa > 0.05) this.center.copy(this.apparent).divideScalar(wa);
    else this.center.set(env.wind.downwindX, 0, env.wind.downwindZ);

    if (this.mode === 'down') {
      this.stepDown(dt, wa, harness, env);
      return;
    }

    const power = 0.22 + 0.78 * this.sheet;
    let cosA = this.u.dot(this.center);
    this.depth = clamp((cosA - COS_EDGE) / (1 - COS_EDGE), 0, 1);

    // Steering: a kite turns faster the faster it flies.
    const turnRate = (1.25 + 0.115 * this.airspeed) * (0.6 + 0.4 * this.sheet);
    if (this.steer !== 0) this.h.applyAxisAngle(this.u, this.steer * turnRate * dt);
    this.bank = damp(this.bank, this.steer, 6, dt);

    // Left alone, a slow kite pivots to point up and creeps toward 12 o'clock.
    tmpA.copy(UP).addScaledVector(this.u, -this.u.y);
    if (tmpA.lengthSq() > 1e-6) {
      tmpA.normalize();
      tmpB.crossVectors(this.h, tmpA);
      const ang = Math.atan2(this.u.dot(tmpB), this.h.dot(tmpA));
      const climb = 0.5 * (1 - smoothstep(3, 9, this.speed)) * (1 - Math.abs(this.steer));
      this.h.applyAxisAngle(this.u, clamp(ang, -1, 1) * climb * dt);
    }

    // Crosswind speed grows with depth in the window (Loyd); a steered kite keeps some way on
    // even at the edge; gravity matters in light air.
    let target = wa * (1.2 * Math.abs(this.steer) + 2.6 * Math.pow(this.depth, 0.7)) * (0.62 + 0.38 * this.sheet);
    target -= 3.2 * this.h.y * (1 - smoothstep(3.5, 9, wa));
    if (wa < 3.2) target -= (3.2 - wa) * 2;
    this.speed = Math.max(0, damp(this.speed, target, 2.8, dt));

    this.u.addScaledVector(this.h, (this.speed * dt) / L).normalize();
    this.h.addScaledVector(this.u, -this.h.dot(this.u)).normalize();

    // Overflying the edge: the kite stalls and falls back to the edge.
    cosA = this.u.dot(this.center);
    let luffTarget = 0;
    if (cosA < COS_EDGE) {
      tmpC.crossVectors(this.u, this.center);
      const axisLen = tmpC.length();
      if (axisLen > 1e-5) {
        tmpC.divideScalar(axisLen);
        const over = Math.acos(clamp(cosA, -1, 1)) - EDGE_ANGLE;
        this.u.applyAxisAngle(tmpC, over * Math.min(1, dt * 5));
        this.h.addScaledVector(this.u, -this.h.dot(this.u)).normalize();
        luffTarget = clamp(over / (20 * DEG), 0, 1);
        this.speed *= Math.exp(-dt * 3 * luffTarget);
      }
    }
    // Front stall: the kite has ended up well upwind of the rider and falls out of the sky.
    if (cosA < -0.12 || wa < 2.4) {
      luffTarget = 1;
      this.u.y -= dt * 0.45;
      this.u.normalize();
    }
    this.luff = damp(this.luff, luffTarget, 5, dt);

    this.airspeed = Math.sqrt(this.speed * this.speed + wa * wa * (0.25 + 0.75 * this.depth));
    const q = 0.5 * RHO_AIR * this.size * wa * wa;
    const motion = 0.5 * RHO_AIR * this.size * 0.48 * this.speed * this.speed;
    this.tension = (q * (0.56 + 1.05 * this.depth) + motion) * power * (1 - 0.75 * this.luff);

    this.position.copy(harness).addScaledVector(this.u, L);
    if (this.position.y < env.surface(this.position.x, this.position.z) + 0.6) this.crash();
  }

  crash() {
    if (this.mode === 'down') return;
    this.mode = 'down';
    this.speed = 0;
    this.downTime = 0;
    this.relaunch = 0;
  }

  private stepDown(dt: number, wa: number, harness: Vector3, env: KiteEnv) {
    this.downTime += dt;
    this.depth = 0;
    this.luff = 1;
    this.speed = 0;
    // The canopy lies on the water, drifting toward the edge of the window.
    const surfaceY = env.surface(this.position.x, this.position.z) + 0.4;
    const targetY = clamp((surfaceY - harness.y) / this.lineLength, -0.3, 0.2);
    this.u.y = damp(this.u.y, targetY, 3, dt);
    // Drift toward the window edge on whichever side the canopy already lies.
    const phiC = Math.atan2(this.center.z, this.center.x);
    let delta = Math.atan2(this.u.z, this.u.x) - phiC;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    const edge = (delta >= 0 ? 1 : -1) * (EDGE_ANGLE - 6 * DEG);
    delta += (edge - delta) * Math.min(1, dt * 0.35 * (1 + this.relaunch * 3));
    const ang = phiC + delta;
    const ny = this.u.y;
    const nh = Math.sqrt(Math.max(0, 1 - ny * ny));
    this.u.set(Math.cos(ang) * nh, ny, Math.sin(ang) * nh);
    this.h.copy(UP).addScaledVector(this.u, -this.u.y).normalize();
    // A kite in the water still drags the rider downwind a little.
    this.tension = 0.5 * RHO_AIR * this.size * wa * wa * 0.12;
    this.position.copy(harness).addScaledVector(this.u, this.lineLength);
  }

  /** Called while the player works the relaunch; returns true when the kite lifts off. */
  workRelaunch(dt: number, effort: number) {
    if (this.mode !== 'down' || this.downTime < 0.8) return false;
    const wa = this.apparent.length();
    const rate = (0.2 + 0.028 * wa) * effort;
    this.relaunch = Math.min(1, this.relaunch + rate * dt);
    if (this.relaunch >= 1 && wa > 3.5) {
      this.mode = 'flying';
      this.u.y = Math.max(this.u.y, Math.sin(10 * DEG));
      this.u.normalize();
      this.h.copy(UP).addScaledVector(this.u, -this.u.y).normalize();
      this.speed = 4;
      this.luff = 0.6;
      this.relaunch = 0;
      return true;
    }
    return false;
  }
}

/**
 * Point on (or just inside/outside) the window edge for a given elevation and
 * side, used as an autopilot target. `inset` > 0 moves it into the power zone.
 */
export function windowPoint(center: Vector3, elevation: number, side: number, inset: number, out: Vector3) {
  const cx = center.x, cz = center.z;
  const cl = Math.hypot(cx, cz) || 1;
  const fx = cx / cl, fz = cz / cl;
  const rx = -fz, rz = fx;
  const E = clamp(EDGE_ANGLE - inset, 5 * DEG, 89 * DEG);
  const sinE = Math.sin(E), cosE = Math.cos(E);
  const s = clamp(Math.sin(elevation) / sinE, -1, 1);
  let beta = Math.asin(s);
  if (side < 0) beta = Math.PI - beta;
  const ox = rx * Math.cos(beta), oy = Math.sin(beta), oz = rz * Math.cos(beta);
  out.set(fx * cosE + ox * sinE, oy * sinE, fz * cosE + oz * sinE).normalize();
  return out;
}
