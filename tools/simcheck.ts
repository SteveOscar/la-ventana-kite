// Headless physics calibration: node tools/simcheck.ts [knots] [kiteSize]
import { Rig, NO_INPUT, type RigEnv, type RigInput, type JumpResult } from '../src/sim/rig.ts';
import { KitePilot, type PilotIntent } from '../src/sim/autopilot.ts';
import { Wind } from '../src/world/wind.ts';
import { Waves } from '../src/world/waves.ts';
import { DEG, KNOT } from '../src/core/math.ts';

const knots = Number(process.argv[2] ?? 19);
const size = Number(process.argv[3] ?? 9);

function makeEnv(): RigEnv {
  const wind = new Wind({ knots, fromDeg: 0, gustiness: 0 });
  const waves = new Waves();
  wind.update(0, 14.5);
  waves.update(0, wind.base, Math.PI);
  return {
    wind,
    waves,
    sdf: () => -2000,
    depth: () => 30,
    surface: (x, z) => waves.height(x, z, 1),
  };
}

const DT = 1 / 120;
const idle: PilotIntent = { power: 0, send: false, loop: false, relaunch: true, go: true, bearAway: false };

function run(rig: Rig, pilot: KitePilot, env: RigEnv, secs: number, input: Partial<RigInput> = {}, intent: Partial<PilotIntent> = {}, log?: (t: number) => void) {
  const steps = Math.round(secs / DT);
  for (let i = 0; i < steps; i++) {
    env.wind.update(DT, 14.5);
    env.waves.update(DT, env.wind.base, Math.PI);
    const it = { ...idle, ...intent };
    pilot.update(DT, rig, it);
    rig.kite.steer = pilot.steer;
    rig.kite.sheet = pilot.sheet;
    rig.step(DT, { ...NO_INPUT, ...input }, env);
    if (log && i % 60 === 0) log(i * DT);
  }
}

const fmt = (rig: Rig) =>
  `mode=${rig.mode.padEnd(6)} v=${(rig.speed / KNOT).toFixed(1)}kn elev=${(rig.kite.elevation / DEG).toFixed(0)} az=${(rig.kite.azimuth / DEG).toFixed(0)} T=${rig.kite.tension.toFixed(0)}N depth=${rig.kite.depth.toFixed(2)} ks=${rig.kite.speed.toFixed(1)} y=${rig.pos.y.toFixed(2)} hdg=${(rig.heading / DEG).toFixed(0)} pilot=${'' + (rig as any).__phase}`;

function scenario(name: string, fn: () => void) {
  console.log(`\n=== ${name}`);
  fn();
}

const env0 = makeEnv();
console.log(`wind base ${(env0.wind.base / KNOT).toFixed(1)} kn, kite ${size} m2, wave amp ${env0.waves.amplitude.toFixed(2)} m`);

scenario('waterstart + beam reach (heading east, wind from north)', () => {
  const env = makeEnv();
  const rig = new Rig(size);
  const pilot = new KitePilot();
  rig.events.waterstart = () => console.log('  -> waterstart');
  rig.events.sink = () => console.log('  -> sink');
  rig.events.crash = (_r, why) => console.log('  -> crash', why);
  rig.spawn(0, 0, 90 * DEG, env);
  run(rig, pilot, env, 20, {}, {}, (t) => {
    if (t < 6 || Math.round(t) % 4 === 0) console.log(`  t=${t.toFixed(1)} ${fmt(rig)} phase=${pilot.phase}`);
  });
});

for (const upwind of [30, 45, 55, 65]) {
  scenario(`upwind riding at ${upwind} deg above beam`, () => {
    const env = makeEnv();
    const rig = new Rig(size);
    const pilot = new KitePilot();
    rig.spawn(0, 0, 90 * DEG, env);
    run(rig, pilot, env, 12);
    // Heading east = beam reach; north (0) = dead upwind. Turn toward north by `upwind`.
    const target = (90 - upwind) * DEG;
    let t = 0;
    while (rig.heading > target && t < 5) {
      run(rig, pilot, env, 0.05, { carve: -1 });
      t += 0.05;
    }
    const z0 = rig.pos.z;
    run(rig, pilot, env, 20);
    console.log(`  ${fmt(rig)} phase=${pilot.phase} gained upwind ${(z0 - rig.pos.z).toFixed(1)} m in 20 s`);
  });
}

function jumpTest(holdSecs: number) {
  const env = makeEnv();
  const rig = new Rig(size);
  const pilot = new KitePilot();
  let result: JumpResult | null = null;
  rig.events.land = (_r, j) => (result = j);
  rig.events.crash = (_r, why) => console.log('  -> crash', why);
  rig.spawn(0, 0, 90 * DEG, env);
  run(rig, pilot, env, 14);
  const before = fmt(rig);
  result = null;
  run(rig, pilot, env, holdSecs, { edge: true }, { send: true });
  const atPop = fmt(rig);
  let t = 0;
  while (!result && t < 15) {
    run(rig, pilot, env, 0.05);
    t += 0.05;
  }
  const r = result as JumpResult | null;
  console.log(`  hold ${holdSecs}s | before: ${before}\n    at pop: ${atPop}`);
  console.log(r ? `    height ${r.height.toFixed(1)} m airtime ${r.airtime.toFixed(1)} s dist ${r.distance.toFixed(0)} m quality ${r.quality} ${r.reason ?? ''}` : '    no landing');
  run(rig, pilot, env, 3);
  console.log(`    after: ${fmt(rig)}`);
}

scenario('jumps', () => {
  for (const hold of [0.3, 0.5, 0.7, 0.9, 1.2]) jumpTest(hold);
});

scenario('transition (carve through downwind)', () => {
  const env = makeEnv();
  const rig = new Rig(size);
  const pilot = new KitePilot();
  rig.events.crash = (_r, why) => console.log('  -> crash', why);
  rig.events.sink = () => console.log('  -> sink');
  rig.spawn(0, 0, 90 * DEG, env);
  run(rig, pilot, env, 12);
  console.log(`  before ${fmt(rig)}`);
  // Carve right (toward downwind/south) until heading west.
  let t = 0;
  while (t < 6) {
    run(rig, pilot, env, 0.05, { carve: 1 }, { bearAway: rig.kiteSide > 0 });
    t += 0.05;
    if (rig.heading < -80 * DEG && rig.heading > -100 * DEG) break;
  }
  console.log(`  mid ${fmt(rig)} phase=${pilot.phase} t=${t.toFixed(1)}`);
  run(rig, pilot, env, 8, {}, {}, (tt) => console.log(`  t=${tt.toFixed(1)} ${fmt(rig)} phase=${pilot.phase}`));
});
