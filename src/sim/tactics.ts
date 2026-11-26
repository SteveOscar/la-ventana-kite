import { DEG, carveToward, clamp, headingOf, wrapAngle } from '../core/math.ts';
import { assistCarve } from './autopilot.ts';
import type { Rig } from './rig.ts';

export interface RacerState {
  /** +1 / -1: which side of the wind the beat is sailed on. */
  tack: 1 | -1;
  /** Committed turn direction for big turns (see carveToward). */
  turn: { dir: number };
  /** 0..1: better racers point higher. */
  skill: number;
}

/**
 * Steering toward a mark: straight there when it can be fetched, otherwise a close-hauled
 * beat that changes tack on the layline. Returns the carve command and the bear-away intent.
 */
export function steerToMark(rig: Rig, markX: number, markZ: number, downwind: number, s: RacerState) {
  const toMark = headingOf(markX - rig.pos.x, markZ - rig.pos.z);
  const upwind = downwind + Math.PI;
  const fromWind = wrapAngle(toMark - upwind);
  const limit = (44 + (1 - s.skill) * 12) * DEG;
  let desired = toMark;
  if (Math.abs(fromWind) < limit) {
    if (Math.abs(fromWind) >= limit * 0.35 && Math.sign(fromWind) !== s.tack) s.tack = Math.sign(fromWind) as 1 | -1;
    desired = upwind + s.tack * limit;
  }
  // Nobody waterstarts pointing upwind: get going on a beam reach first.
  if (rig.mode !== 'riding' || (rig.speed < 6 && rig.modeTime < 8)) desired = upwind + s.tack * 95 * DEG;
  let carve = rig.mode === 'riding' ? carveToward(rig.heading, desired, downwind, s.turn, 1.7) : clamp(wrapAngle(desired - rig.heading) * 1.7, -1, 1);
  const bearAway = carve * rig.kiteSide > 0.3;
  carve = assistCarve(rig, carve);
  return { carve, bearAway };
}
