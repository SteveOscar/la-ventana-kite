import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rig, NO_INPUT, type RigEnv, type RigInput, type JumpResult } from '../src/sim/rig.ts';
import { KitePilot, type PilotIntent } from '../src/sim/autopilot.ts';
import { Wind } from '../src/world/wind.ts';
import { Waves } from '../src/world/waves.ts';
import { DEG, KNOT } from '../src/core/math.ts';
import { steerToMark, type RacerState } from '../src/sim/tactics.ts';

const DT = 1 / 120;

function setup(knots: number, size: number) {
  const wind = new Wind({ knots, fromDeg: 0, gustiness: 0 });
  const waves = new Waves();
  wind.update(0, 14.5);
  waves.update(0, wind.base, Math.PI);
  const env: RigEnv = { wind, waves, sdf: () => -2000, depth: () => 30, surface: (x, z) => waves.height(x, z, 1) };
  const rig = new Rig(size);
  const pilot = new KitePilot();
  rig.spawn(0, 0, 90 * DEG, env);
  const run = (secs: number, input: Partial<RigInput> = {}, intent: Partial<PilotIntent> = {}) => {
    for (let i = 0; i < Math.round(secs / DT); i++) {
      wind.update(DT, 14.5);
      waves.update(DT, wind.base, Math.PI);
      pilot.update(DT, rig, { power: 0, send: false, loop: false, relaunch: true, go: true, bearAway: false, ...intent });
      rig.kite.steer = pilot.steer;
      rig.kite.sheet = pilot.sheet;
      rig.step(DT, { ...NO_INPUT, ...input }, env);
      assert.ok(Number.isFinite(rig.pos.x) && Number.isFinite(rig.vel.y) && Number.isFinite(rig.kite.tension), 'state stays finite');
    }
  };
  return { rig, pilot, env, run };
}

test('waterstarts within a few seconds and planes on a beam reach in 19 knots', () => {
  const { rig, run } = setup(19, 9);
  let t = 0;
  while (rig.mode !== 'riding' && t < 6) {
    run(0.1);
    t += 0.1;
  }
  assert.equal(rig.mode, 'riding', 'stood up');
  assert.ok(t < 4, `waterstart took ${t.toFixed(1)} s`);
  run(12);
  const kn = rig.speed / KNOT;
  assert.ok(kn > 12 && kn < 24, `beam reach speed ${kn.toFixed(1)} kn`);
  assert.ok(rig.kite.elevation > 28 * DEG && rig.kite.elevation < 50 * DEG, 'kite parked around 35-40 degrees');
});

test('can work upwind at ~45 degrees off the wind but not at 30', () => {
  for (const [offWind, expectUp] of [
    [48, true],
    [30, false],
  ] as const) {
    const { rig, run } = setup(19, 9);
    run(12);
    const target = offWind * DEG; // heading measured from north = upwind
    while (rig.heading > target) run(0.05, { carve: -1 });
    const z0 = rig.pos.z;
    run(20);
    const gained = z0 - rig.pos.z;
    if (expectUp) assert.ok(gained > 40, `gained ${gained.toFixed(0)} m upwind at ${offWind} deg`);
    else assert.ok(gained < 40, `should not point ${offWind} deg (gained ${gained.toFixed(0)} m)`);
  }
});

test('a loaded jump in 19 knots on a 9 m goes a few metres and lands', () => {
  const { rig, run } = setup(19, 9);
  run(14);
  let jump: JumpResult | null = null;
  rig.events.land = (_r, j) => (jump = j);
  run(0.7, { edge: true }, { send: true });
  let t = 0;
  while (!jump && t < 12) {
    run(0.05);
    t += 0.05;
  }
  const j = jump as JumpResult | null;
  assert.ok(j, 'landed');
  assert.ok(j!.height > 1.8 && j!.height < 9, `height ${j!.height.toFixed(1)} m`);
  assert.ok(j!.airtime > 1.5 && j!.airtime < 7, `airtime ${j!.airtime.toFixed(1)} s`);
  assert.notEqual(j!.quality, 'crash');
});

test('stronger wind jumps higher than lighter wind', () => {
  const height = (knots: number) => {
    const { rig, run } = setup(knots, 9);
    run(14);
    let h = 0;
    rig.events.land = (_r, j) => (h = Math.max(h, j.height));
    run(0.7, { edge: true }, { send: true });
    run(8);
    return h;
  };
  assert.ok(height(25) > height(16) + 1, 'more wind, more air');
});

test('a back roll held in the air is counted and landed', () => {
  const { rig, run } = setup(22, 9);
  run(14);
  let jump: JumpResult | null = null;
  rig.events.land = (_r, j) => (jump = j);
  run(0.7, { edge: true }, { send: true });
  let t = 0;
  while (rig.mode === 'air' && Math.abs(rig.flip) < 2 * Math.PI - 0.3 && t < 3) {
    run(0.02, { flip: -1 });
    t += 0.02;
  }
  while (!jump && t < 12) {
    run(0.05);
    t += 0.05;
  }
  const j = jump as JumpResult | null;
  assert.ok(j, 'landed');
  assert.equal(j!.flips, 1);
  assert.equal(j!.flipDir, -1);
});

test('a race AI beats up to a mark 430 m upwind and rounds it without getting lofted', () => {
  const wind = new Wind({ knots: 19, fromDeg: 16, gustiness: 0.22 });
  const waves = new Waves();
  wind.update(0, 14);
  waves.update(0, wind.base, Math.PI);
  const env: RigEnv = { wind, waves, sdf: () => -500, depth: () => 20, surface: (x, z) => waves.height(x, z, 1) };
  const rig = new Rig(9);
  const pilot = new KitePilot();
  const down = Math.atan2(wind.downwindX, -wind.downwindZ);
  rig.spawn(0, 0, down + Math.PI / 2, env);
  const mark = { x: 300, z: -430 };
  const state: RacerState = { tack: 1, turn: { dir: 0 }, skill: 0.6 };
  let lofts = 0;
  rig.events.takeoff = () => lofts++;
  let t = 0;
  let rounded = false;
  while (t < 170 && !rounded) {
    wind.update(DT, 14);
    waves.update(DT, wind.base, Math.PI);
    const { carve, bearAway } = steerToMark(rig, mark.x, mark.z, down, state);
    pilot.update(DT, rig, { power: rig.speed < 6 ? 1 : 0, send: false, loop: false, relaunch: true, go: true, bearAway });
    rig.kite.steer = pilot.steer;
    rig.kite.sheet = pilot.sheet;
    rig.step(DT, { ...NO_INPUT, carve: rig.mode === 'air' ? 0 : carve }, env);
    t += DT;
    rounded = Math.hypot(rig.pos.x - mark.x, rig.pos.z - mark.z) < 40;
  }
  assert.ok(rounded, `reached the mark (${t.toFixed(0)} s)`);
  assert.ok(lofts <= 1, `lofted ${lofts} times`);
});
