// Mirrors the game's assisted controls for a carved transition: node tools/transition-check.ts [knots] [kite]
import { Rig, NO_INPUT, type RigEnv } from '../src/sim/rig.ts';
import { KitePilot } from '../src/sim/autopilot.ts';
import { Wind } from '../src/world/wind.ts';
import { Waves } from '../src/world/waves.ts';
import { DEG, KNOT } from '../src/core/math.ts';
const knots = Number(process.argv[2] ?? 19), size = Number(process.argv[3] ?? 9);
const wind = new Wind({ knots, fromDeg: 16, gustiness: 0 });
const waves = new Waves();
wind.update(0, 14); waves.update(0, wind.base, Math.PI);
const env: RigEnv = { wind, waves, sdf: () => -2000, depth: () => 30, surface: (x, z) => waves.height(x, z, 1) };
const rig = new Rig(size), pilot = new KitePilot();
const DT = 1 / 120;
rig.events.sink = () => console.log('  SINK at', t.toFixed(2));
rig.events.crash = (_r, w) => console.log('  CRASH', w);
rig.events.takeoff = (_r, l) => console.log('  takeoff lofted=' + l, 't', t.toFixed(2));
const down = Math.atan2(wind.downwindX, -wind.downwindZ);
rig.spawn(0, 0, down - Math.PI / 2 * 0.95, env);
let t = 0;
function step(carveKey: number) {
  wind.update(DT, 14); waves.update(DT, wind.base, Math.PI);
  let carve = carveKey;
  const side = rig.kiteSide;
  const bearAway = carve * side > 0.3;
  if (rig.mode === 'riding') {
    const dw = rig.dirX * rig.windX + rig.dirZ * rig.windZ;
    if (bearAway && dw > 0.1 && rig.kite.elevation < 64 * DEG) carve *= 0.22;
    if (carve === 0 && dw > 0.8 && rig.sinceLanding < 4) carve = -side * 0.6;
  }
  pilot.update(DT, rig, { power: 0, send: false, loop: false, relaunch: true, go: rig.modeTime > 2.4, bearAway });
  rig.kite.steer = pilot.steer; rig.kite.sheet = pilot.sheet;
  rig.step(DT, { ...NO_INPUT, carve }, env);
  t += DT;
}
const log = () => console.log(`t=${t.toFixed(2)} ${rig.mode.padEnd(6)} v=${(rig.speed / KNOT).toFixed(1)} hdg=${(rig.heading / DEG).toFixed(0)} kiteSide=${rig.kiteSide} elev=${(rig.kite.elevation / DEG).toFixed(0)} az=${(rig.kite.azimuth / DEG).toFixed(0)} T=${rig.kite.tension.toFixed(0)} ks=${rig.kite.speed.toFixed(1)} ph=${pilot.phase} side=${pilot.side}`);
for (let i = 0; i < 12 * 120; i++) step(0);
log();
const carveDir = rig.kiteSide; // toward the kite = bear away
for (let i = 0; i < 4 * 120; i++) { step(carveDir); if (i % 24 === 0) log(); if (rig.heading * carveDir > 0 && Math.abs(((rig.heading - down + Math.PI * 3) % (Math.PI * 2)) - Math.PI) > 80 * DEG && i > 60) { console.log('  reached new tack'); break; } }
for (let i = 0; i < 6 * 120; i++) { step(0); if (i % 30 === 0) log(); }
