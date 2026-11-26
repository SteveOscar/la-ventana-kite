import * as THREE from 'three';
import { Rig, type RigEnv, type RigInput } from '../sim/rig.ts';
import { KitePilot, type PilotIntent } from '../sim/autopilot.ts';
import { RiderModel, type RiderLook } from '../render/riderModel.ts';
import { KiteModel, type KitePalette } from '../render/kiteModel.ts';

export const PHYSICS_DT = 1 / 120;

/** A rider with board and kite: simulation plus the visible models. */
export class Kiter {
  readonly rig: Rig;
  readonly pilot = new KitePilot();
  readonly rider: RiderModel;
  readonly kite: KiteModel;
  readonly group = new THREE.Group();
  /** Manual kite flying (no autopilot); steer/sheet come from `manualSteer`/`manualSheet`. */
  manual = false;
  manualSteer = 0;
  manualSheet = 0.8;
  /** Waterstart on its own after a moment in assisted mode (off for the kite school). */
  autoStart = true;
  private acc = 0;

  constructor(kiteSize: number, look: RiderLook, palette: KitePalette, lineColor?: number) {
    this.rig = new Rig(kiteSize);
    this.rider = new RiderModel(look);
    this.kite = new KiteModel(kiteSize, palette, lineColor);
    this.group.add(this.rider.root, this.kite.group, this.kite.lines, this.rider.lostBoard);
  }

  setKiteSize(size: number, palette: KitePalette) {
    this.group.remove(this.kite.group, this.kite.lines);
    const k = new KiteModel(size, palette);
    (this as { kite: KiteModel }).kite = k;
    this.rig.kite.size = size;
    this.group.add(k.group, k.lines);
  }

  /** Fixed-step simulation. Returns the number of physics steps taken. */
  simulate(dt: number, input: RigInput, intent: PilotIntent, env: RigEnv, maxSteps = 10) {
    this.acc = Math.min(this.acc + dt, PHYSICS_DT * maxSteps);
    let steps = 0;
    while (this.acc >= PHYSICS_DT) {
      this.acc -= PHYSICS_DT;
      if (this.manual) {
        this.rig.kite.steer = this.manualSteer;
        this.rig.kite.sheet = this.manualSheet;
        if (this.rig.kite.mode === 'down' && intent.relaunch) this.rig.relaunch(PHYSICS_DT, 1);
      } else {
        this.pilot.update(PHYSICS_DT, this.rig, intent);
        this.rig.kite.steer = this.pilot.steer;
        this.rig.kite.sheet = this.pilot.sheet;
      }
      this.rig.step(PHYSICS_DT, input, env);
      // One-shot intents only apply to the first sub-step.
      intent = { ...intent, loop: false };
      steps++;
    }
    return steps;
  }

  updateVisuals(dt: number) {
    this.rider.update(dt, this.rig);
    this.kite.update(dt, this.rig.kite, this.rider.barLeft, this.rider.barRight, this.rider.barCenter);
  }
}
