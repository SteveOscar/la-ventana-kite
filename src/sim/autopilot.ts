import { Vector3 } from 'three';
import { DEG, G, clamp, damp } from '../core/math.ts';
import { windowPoint } from './kite.ts';
import type { Rig } from './rig.ts';

export interface PilotIntent {
  /** -1 = less power (bar out, kite high) .. 1 = more power (work the kite low). */
  power: number;
  /** Space held: send the kite up for a jump. */
  send: boolean;
  /** Kite-loop request (edge-triggered by the caller). */
  loop: boolean;
  /** Keep working the relaunch while the kite is in the water. */
  relaunch: boolean;
  /** Dive the kite to stand up (waterstart). */
  go: boolean;
  /** The rider is carving toward downwind (about to transition). */
  bearAway: boolean;
}

export type PilotPhase = 'park' | 'dive' | 'ride' | 'transition' | 'send' | 'float' | 'loop' | 'down' | 'drag';

const tmpG = new Vector3();
const tmpC = new Vector3();
const tmpUp = new Vector3();

/**
 * Flies the kite the way a competent rider would: parked at 12 for the
 * waterstart, dived for power, held at ~35 degrees while riding, moved over the
 * top for transitions, sent and redirected for jumps.
 */
export class KitePilot {
  phase: PilotPhase = 'park';
  side = 1;
  readonly target = new Vector3();
  steer = 0;
  sheet = 0.82;
  private sineT = 0;
  private loopTime = 0;
  private loopTurn = 0;
  private loopDir = 1;
  private transitioning = false;
  private prevH = new Vector3();
  /** Seconds since the rider's side of travel last changed (power stroke after a transition). */
  private sinceSideChange = 99;

  reset() {
    this.phase = 'park';
    this.transitioning = false;
    this.loopTime = 0;
    this.steer = 0;
  }

  /** Which side of the window the kite should be on for the rider's direction of travel. */
  private desiredSide(rig: Rig) {
    const c = rig.kite.center;
    const cl = Math.hypot(c.x, c.z) || 1;
    const rx = -c.z / cl, rz = c.x / cl;
    const d = rig.dirX * rx + rig.dirZ * rz;
    if (Math.abs(d) > 0.18) {
      const s = d > 0 ? 1 : -1;
      if (s !== this.side) this.sinceSideChange = 0;
      this.side = s;
    }
    return this.side;
  }

  update(dt: number, rig: Rig, intent: PilotIntent) {
    const kite = rig.kite;
    if (kite.mode === 'down') {
      this.phase = 'down';
      this.steer = 0;
      this.transitioning = false;
      if (intent.relaunch) rig.relaunch(dt, 1);
      return;
    }
    this.sinceSideChange += dt;
    const side = this.desiredSide(rig);
    const kiteSide = kite.azimuth >= 0 ? 1 : -1;
    const elev = kite.elevation;
    let sheet = 0.82;
    let elevation = 36 * DEG;
    let inset = -5 * DEG;
    let targetSide = side;

    if (this.phase === 'loop') {
      this.loopTime += dt;
      tmpC.crossVectors(this.prevH, kite.h);
      this.loopTurn += Math.atan2(tmpC.dot(kite.u), this.prevH.dot(kite.h));
      this.prevH.copy(kite.h);
      this.steer = this.loopDir;
      this.sheet = 1;
      if (Math.abs(this.loopTurn) > 1.92 * Math.PI || this.loopTime > 2.6) this.phase = rig.mode === 'air' ? 'float' : 'ride';
      return;
    }
    if (intent.loop && (rig.mode === 'air' || rig.mode === 'riding') && elev > 25 * DEG) {
      this.phase = 'loop';
      this.loopTime = 0;
      this.loopTurn = 0;
      // Loop toward the direction of travel, through the power zone.
      this.loopDir = side * (kite.h.y > 0 ? -1 : 1) || 1;
      this.prevH.copy(kite.h);
      this.steer = this.loopDir;
      return;
    }

    switch (rig.mode) {
      case 'water': {
        const ready = rig.modeTime > 0.7 && rig.hasBoard;
        if (kiteSide !== side && elev < 62 * DEG) {
          this.phase = 'transition';
          targetSide = kiteSide;
          elevation = 80 * DEG;
          inset = -4 * DEG;
        } else if (intent.go && ready && elev > 45 * DEG) {
          this.phase = 'dive';
        } else if (this.phase !== 'dive') {
          this.phase = 'park';
        }
        if (this.phase === 'park') {
          elevation = 74 * DEG;
          inset = -4 * DEG;
          sheet = 0.7;
        } else if (this.phase === 'dive') {
          elevation = 16 * DEG;
          inset = 34 * DEG;
          sheet = 1;
          if (elev < 22 * DEG && kite.depth < 0.3) this.phase = 'park';
        }
        break;
      }
      case 'riding': {
        if (this.transitioning || (kiteSide !== side && Math.abs(kite.azimuth) > 18 * DEG)) {
          this.phase = 'transition';
          this.transitioning = kiteSide !== side;
          if (elev < 64 * DEG && kiteSide !== side) {
            targetSide = kiteSide;
            elevation = 82 * DEG;
            inset = -2 * DEG;
            sheet = 0.7;
            break;
          }
          this.transitioning = false;
        }
        if (intent.send) {
          this.phase = 'send';
          // Sweep the kite up through the window toward 12.
          targetSide = side;
          elevation = 84 * DEG;
          inset = 7 * DEG;
          sheet = 1;
          break;
        }
        // Bearing away toward dead downwind: lift the kite to 12 ready to transition.
        const downwindness = rig.dirX * rig.windX + rig.dirZ * rig.windZ;
        if (downwindness > 0.62 && intent.bearAway) {
          this.phase = 'transition';
          targetSide = kiteSide;
          elevation = 80 * DEG;
          inset = 0;
          sheet = 0.75;
          break;
        }
        this.phase = 'ride';
        if ((this.sinceSideChange < 1.6 && kiteSide === side) || (rig.sinceLanding < 1.1 && rig.speed < 7)) {
          // Power stroke on the new tack after a transition or a landing.
          elevation = 30 * DEG;
          inset = 14 * DEG;
          sheet = 1;
          break;
        }
        const tension = kite.tension;
        const weight = rig.mass * G;
        elevation = (intent.power > 0 ? 27 : intent.power < 0 ? 56 : 37) * DEG;
        sheet = intent.power > 0 ? 1 : intent.power < 0 ? 0.55 : 0.84;
        if (tension > 1.25 * weight) {
          // Overpowered: bar out, keep the kite low enough not to get lofted.
          sheet = Math.min(sheet, 0.84 - 0.5 * clamp((tension / weight - 1.25) / 0.8, 0, 1));
          elevation = Math.min(elevation, 34 * DEG);
        }
        if (rig.speed < 5.2 && intent.power >= 0 && tension < 1.0 * weight) {
          // Underpowered: work the kite in a sine to generate apparent wind.
          this.sineT += dt;
          const s = Math.sin((this.sineT * 2 * Math.PI) / 2.3);
          elevation = (32 + 10 * s) * DEG;
          inset = (12 - 10 * s) * DEG;
          sheet = 1;
        }
        break;
      }
      case 'air': {
        const rising = rig.vel.y > 0.4 && rig.airTime < 2.5;
        if (rising) {
          this.phase = 'send';
          targetSide = side;
          elevation = 84 * DEG;
          inset = 4 * DEG;
          sheet = 1;
        } else {
          // Redirect the kite forward for float and a soft landing.
          this.phase = 'float';
          targetSide = side;
          elevation = 58 * DEG;
          inset = 14 * DEG;
          sheet = 0.95;
        }
        break;
      }
      case 'crash':
        this.phase = 'park';
        targetSide = kiteSide;
        elevation = 70 * DEG;
        sheet = 0.6;
        break;
      case 'drag': {
        this.phase = 'drag';
        const toX = rig.boardPos.x - rig.pos.x, toZ = rig.boardPos.z - rig.pos.z;
        const c = kite.center, cl = Math.hypot(c.x, c.z) || 1;
        targetSide = toX * (-c.z / cl) + toZ * (c.x / cl) >= 0 ? 1 : -1;
        elevation = 30 * DEG;
        inset = 12 * DEG;
        sheet = 0.85;
        break;
      }
    }

    windowPoint(kite.center, elevation, targetSide, inset, this.target);
    this.sheet = damp(this.sheet, sheet, 4, dt);
    // Gentle hands over the top; full lock only when diving or sending.
    const maxSteer = this.phase === 'transition' ? 0.5 : this.phase === 'park' ? 0.6 : this.phase === 'ride' ? 0.85 : 1;
    this.steer = this.steerToward(rig, this.target) * maxSteer;
  }

  /** Committed direction of an ongoing U-turn (0 when not turning around). */
  private uturn = 0;

  /** Heading-error steering toward a target direction on the line sphere. */
  steerToward(rig: Rig, target: Vector3) {
    const kite = rig.kite;
    tmpG.copy(target).sub(kite.u);
    tmpG.addScaledVector(kite.u, -tmpG.dot(kite.u));
    const dist = tmpG.length();
    if (dist < 0.025) {
      this.uturn = 0;
      return 0;
    }
    tmpG.divideScalar(dist);
    tmpC.crossVectors(kite.h, tmpG);
    let err = Math.atan2(tmpC.dot(kite.u), kite.h.dot(tmpG));
    if (Math.abs(err) < 1.6) this.uturn = 0;
    else if (Math.abs(err) > 2.1 || this.uturn !== 0) {
      if (this.uturn === 0) {
        // Low in the window, turn through "up" rather than looping down through the power zone.
        this.uturn = Math.sign(err) || 1;
        tmpUp.set(0, 1, 0).addScaledVector(kite.u, -kite.u.y);
        if (kite.u.y < 0.85 && tmpUp.lengthSq() > 1e-4) {
          tmpUp.normalize();
          tmpC.crossVectors(kite.h, tmpUp);
          const errUp = Math.atan2(tmpC.dot(kite.u), kite.h.dot(tmpUp));
          this.uturn = Math.sign(errUp) || this.uturn;
        }
      }
      err = this.uturn * Math.PI;
    }
    return clamp(err * 1.9, -1, 1) * clamp(dist / 0.06, 0.35, 1);
  }
}
