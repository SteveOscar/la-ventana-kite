import type { CreatureMesh } from './creatures.ts';
import { newPose, type Pose } from './creatures.ts';
import { FOAM } from './waterFx.ts';
import {
  approach,
  approachAngle,
  arrival,
  distXZ,
  encounterPoint,
  fwdX,
  fwdZ,
  headingTo,
  keyframe,
  localToWorld,
  pickOne,
  rand,
  randInt,
  readable,
  wrap,
  type Ctx,
  type Species,
} from './common.ts';

/** Readability boost for animals at the surface: scale about the waterline. */
function boost(ctx: Ctx, p: Pose, sea: number, gain: number) {
  const k = readable(ctx, p.x, sea, p.z, gain);
  p.scale *= k;
  p.y = sea + (p.y - sea) * k;
}

const G = 9.81;
const TAU = Math.PI * 2;
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const tmp = { x: 0, y: 0, z: 0 };

/** Steers away from water shallower than `minDepth` (or from the coast) `look` metres ahead. */
function avoidShallows(ctx: Ctx, x: number, z: number, heading: number, look: number, minDepth: number, maxSdf = -30) {
  const ok = (h: number) => {
    const px = x + fwdX(h) * look, pz = z + fwdZ(h) * look;
    return ctx.data.depth(px, pz) >= minDepth && ctx.data.sdf(px, pz) < maxSdf;
  };
  if (ok(heading)) return 0;
  for (const d of [0.6, 1.2, 1.9, 2.6]) {
    if (ok(heading + d)) return 1;
    if (ok(heading - d)) return -1;
  }
  return 1;
}

// ---------------------------------------------------------------- dolphins

interface Dolphin {
  side: number;
  back: number;
  phase: number;
  period: number;
  cycle: number;
  leap: boolean;
  spin: number;
  peak: number;
  arc: number;
  above: boolean;
  variant: number;
  scale: number;
  weave: number;
}

interface Pod {
  x: number;
  z: number;
  heading: number;
  speed: number;
  turn: number;
  turnTarget: number;
  mode: 'approach' | 'cross' | 'escort' | 'leave';
  t: number;
  dur: number;
  side: number;
  gap: number;
  ahead: number;
  /** Signed lateral distance at which an approaching pod aims to pass the rider. */
  pass: number;
  members: Dolphin[];
  age: number;
  eager: boolean;
}

/** Pods of common (and some bottlenose) dolphins surfacing in arcs; some come to ride with you. */
export class Dolphins implements Species {
  readonly name = 'dolphin';
  private pods: Pod[] = [];
  private timer = rand(25, 60);
  private pose: Pose = newPose();
  private mesh: CreatureMesh;

  constructor(mesh: CreatureMesh) {
    this.mesh = mesh;
  }

  get active() {
    return this.pods.reduce((n, p) => n + p.members.length, 0);
  }

  clear() {
    this.pods.length = 0;
    this.timer = rand(25, 60);
  }

  spawnAt(ctx: Ctx, x: number, z: number, action?: string) {
    const h = headingTo(ctx.focus.x - x, ctx.focus.z - z);
    const pod = this.newPod(x, z, h);
    if (action === 'escort') {
      pod.mode = 'escort';
      pod.dur = 40;
    }
    this.pods.push(pod);
  }

  private newPod(x: number, z: number, heading: number): Pod {
    const bottle = Math.random() < 0.3;
    const n = bottle ? randInt(3, 7) : randInt(5, 12);
    const members: Dolphin[] = [];
    for (let i = 0; i < n; i++) {
      members.push({
        side: rand(-9, 9),
        back: rand(-6, 10),
        phase: rand(0, 10),
        period: rand(2.6, 4.6),
        cycle: -1,
        leap: false,
        spin: 0,
        peak: 0.1,
        arc: 1.1,
        above: false,
        variant: bottle ? 1 : 0,
        scale: (bottle ? 1.22 : 1) * rand(0.85, 1.05) * (i > 0 && Math.random() < 0.12 ? 0.6 : 1),
        weave: rand(0, TAU),
      });
    }
    return {
      x,
      z,
      heading,
      speed: rand(3.2, 5),
      turn: 0,
      turnTarget: 0,
      mode: 'approach',
      t: 0,
      dur: rand(50, 90),
      side: Math.random() < 0.5 ? 1 : -1,
      gap: rand(14, 30),
      ahead: rand(24, 44),
      pass: (Math.random() < 0.5 ? 1 : -1) * rand(25, 100),
      members,
      age: 0,
      eager: Math.random() < 0.6,
    };
  }

  update(ctx: Ctx, dt: number) {
    this.timer -= dt;
    const offshore = ctx.data.sdf(ctx.focus.x, ctx.focus.z) < -900;
    if (this.timer <= 0) {
      this.timer = arrival(70);
      if (this.pods.filter((p) => p.mode !== 'leave').length < (offshore ? 2 : 1)) {
        const p = encounterPoint(ctx, { minR: 280, maxR: 800, minDepth: 6, maxSdf: -60 }, 0.75);
        if (p) this.pods.push(this.newPod(p.x, p.z, headingTo(ctx.focus.x - p.x, ctx.focus.z - p.z) + rand(-0.7, 0.7)));
      }
    }
    this.mesh.begin();
    for (let i = this.pods.length - 1; i >= 0; i--) {
      if (!this.updatePod(ctx, this.pods[i], dt)) this.pods.splice(i, 1);
    }
    this.mesh.end();
  }

  private updatePod(ctx: Ctx, pod: Pod, dt: number) {
    pod.t += dt;
    pod.age += dt;
    const f = ctx.focus;
    const riderSpeed = Math.hypot(ctx.vx, ctx.vz);
    const dFocus = distXZ(pod.x, pod.z, f.x, f.z);
    if (pod.mode === 'approach' || pod.mode === 'cross') {
      if (pod.mode === 'approach' && dFocus < 230) {
        // Close enough: some pods come to ride with you, others cross your bow and carry on.
        pod.mode = pod.eager && riderSpeed > 3 ? 'escort' : 'cross';
        pod.t = 0;
        pod.dur = pod.mode === 'escort' ? rand(25, 45) : rand(30, 50);
      } else if (pod.t > pod.dur) {
        pod.mode = 'leave';
        pod.t = 0;
      }
      if (Math.random() < dt / 5) pod.turnTarget = rand(-0.06, 0.06);
      let want = pod.heading + pod.turnTarget;
      if (pod.mode === 'approach') {
        // Aim to pass beside where the rider will be.
        const lead = Math.min(30, dFocus / 5);
        const px = f.x + ctx.vx * lead, pz = f.z + ctx.vz * lead;
        const h = headingTo(px - pod.x, pz - pod.z);
        want = h + Math.atan2(pod.pass, Math.max(60, distXZ(pod.x, pod.z, px, pz)));
      }
      const avoid = avoidShallows(ctx, pod.x, pod.z, pod.heading, 90, 6);
      const prev = pod.heading;
      pod.heading = avoid ? wrap(pod.heading + avoid * 0.4 * dt) : approachAngle(pod.heading, want, 0.35, dt);
      pod.turn = wrap(pod.heading - prev) / Math.max(dt, 1e-4);
      pod.speed = approach(pod.speed, pod.mode === 'approach' ? 5.2 : 4.4, 0.3, dt);
    } else if (pod.mode === 'escort') {
      // Ride with the rider: off the bow, ahead and to one side, where the chase camera looks.
      const vl = riderSpeed > 0.5 ? riderSpeed : 1;
      const dx = riderSpeed > 0.5 ? ctx.vx / vl : fwdX(pod.heading), dz = riderSpeed > 0.5 ? ctx.vz / vl : fwdZ(pod.heading);
      const drift = Math.sin(pod.t * 0.21) * 10;
      const tx = f.x + -dz * pod.side * (pod.gap + drift) + dx * pod.ahead, tz = f.z + dx * pod.side * (pod.gap + drift) + dz * pod.ahead;
      const d = distXZ(pod.x, pod.z, tx, tz);
      const want = d > 12 ? headingTo(tx - pod.x, tz - pod.z) : headingTo(dx, dz);
      const prev = pod.heading;
      pod.heading = approachAngle(pod.heading, want, 0.9, dt);
      pod.turn = wrap(pod.heading - prev) / Math.max(dt, 1e-4);
      pod.speed = approach(pod.speed, Math.min(11.5, Math.max(2.5, riderSpeed * 0.95 + d * 0.12)), 0.8, dt);
      if (pod.t > pod.dur || ctx.data.depth(pod.x, pod.z) < 3.5) {
        pod.mode = 'leave';
        pod.t = 0;
        pod.heading = headingTo(pod.x - f.x, pod.z - f.z);
      }
    } else {
      const avoid = avoidShallows(ctx, pod.x, pod.z, pod.heading, 90, 6);
      pod.turn = approach(pod.turn, avoid * 0.4, 1, dt);
      pod.heading = wrap(pod.heading + pod.turn * dt);
      pod.speed = approach(pod.speed, 5.5, 0.4, dt);
    }
    pod.x += fwdX(pod.heading) * pod.speed * dt;
    pod.z += fwdZ(pod.heading) * pod.speed * dt;
    if (dFocus > (pod.mode === 'leave' ? 1100 : 1600)) return false;

    const hx = fwdX(pod.heading), hz = fwdZ(pod.heading), rx = -hz, rz = hx;
    const excited = pod.mode === 'escort' ? 1 : 0;
    const leapChance = Math.min(0.85, Math.max(0.05, (pod.speed - 3.5) / 5) + excited * 0.35);
    const camX = ctx.camX, camZ = ctx.camZ;
    const p = this.pose;
    for (const m of pod.members) {
      const c = (ctx.time + m.phase) / (m.period * (pod.mode === 'escort' ? 0.75 : 1));
      const k = Math.floor(c);
      const span = m.period * (pod.mode === 'escort' ? 0.75 : 1);
      const s = (c - k) * span;
      if (k !== m.cycle) {
        m.cycle = k;
        m.leap = Math.random() < leapChance;
        m.peak = m.leap ? rand(0.9, 1.7) : rand(0.0, 0.15);
        m.arc = m.leap ? rand(1.25, 1.45) : rand(1.0, 1.25);
        m.spin = m.leap && excited && Math.random() < 0.08 ? (Math.random() < 0.5 ? 1 : -1) : 0;
      }
      const weave = Math.sin(ctx.time * 0.35 + m.weave);
      const side = m.side * (pod.mode === 'escort' ? 0.7 : 1) + weave * 1.8;
      const x = pod.x + rx * side - hx * m.back, z = pod.z + rz * side - hz * m.back;
      const sea = ctx.surface(x, z);
      let h = -1.25, pitch = 0, roll = 0;
      if (s < m.arc) {
        const u = s / m.arc;
        const amp = m.peak + 1.25;
        h = -1.25 + amp * Math.sin(Math.PI * u);
        const dh = ((amp * Math.PI) / m.arc) * Math.cos(Math.PI * u);
        pitch = Math.atan2(dh, Math.max(pod.speed, 2.5)) * 0.95;
        if (m.spin) roll = m.spin * TAU * 2 * smooth(0.25, 0.85, u);
      }
      const above = h > -0.2;
      if (above !== m.above) {
        m.above = above;
        const d = distXZ(x, z, camX, camZ);
        if (d < 700) {
          if (above) {
            ctx.fx.splash(x + hx * 0.6, z + hz * 0.6, { power: m.leap ? 2.6 : 1.5, count: m.leap ? 8 : 4, size: 0.12 });
            ctx.fx.blow(x + hx * 0.3, sea + 0.25, z + hz * 0.3, { height: 0.9, width: 0.22, count: 4 });
          } else {
            ctx.fx.splash(x, z, { power: m.leap ? 3.2 : 1.6, count: m.leap ? 14 : 5, size: m.leap ? 0.16 : 0.12, foam: m.leap ? 0.9 : 0.5, dirX: hx * 0.3, dirZ: hz * 0.3 });
            if (m.leap && d < 200) ctx.emit({ kind: 'splash', species: 'dolphin', x, y: sea, z, strength: 0.25 });
          }
        }
      }
      if (h > -1.2) {
        p.x = x;
        p.y = sea + h * m.scale;
        p.z = z;
        p.heading = pod.heading + weave * 0.08;
        p.pitch = pitch;
        p.roll = roll + Math.sin(ctx.time * 0.7 + m.weave) * 0.08 - pod.turn * 1.5;
        p.scale = m.scale;
        p.flap = -0.05 + Math.sin(ctx.time * 2 + m.weave) * 0.05;
        p.hand = 0;
        p.flex = Math.sin(ctx.time * (2 + pod.speed * 0.5) + m.weave) * 0.18 - pitch * 0.25;
        p.variant = m.variant;
        boost(ctx, p, sea, 0.6);
        this.mesh.push(p);
        if (h > -0.4) ctx.sight('dolphin', x, sea + 0.3, z, 200);
      } else {
        const d = distXZ(x, z, camX, camZ);
        if (d < 110) ctx.fx.shadow(x, z, pod.heading, 2.2 * m.scale, 0.62 * m.scale, 0.45 * (1 - d / 110));
      }
    }
    return true;
  }
}

// ---------------------------------------------------------------- humpback whales

type MoveKind = 'under' | 'breath' | 'fluke' | 'breach';

/** Keyframes: [time s, centre depth (m, scaled), pitch, roll, flex, flipper]. */
const MOVES: Record<Exclude<MoveKind, 'under'>, { keys: number[][]; speed: number }> = {
  breath: {
    speed: 2.2,
    keys: [
      [0, -3.2, 0.16, 0, 0, -0.1],
      [1.0, -1.35, 0.12, 0, -0.03, -0.1],
      [3.0, -0.9, -0.01, 0, -0.06, -0.08],
      [4.8, -1.12, -0.13, 0, 0.0, -0.1],
      [6.5, -3.2, -0.22, 0, 0.05, -0.1],
    ],
  },
  fluke: {
    speed: 1.8,
    keys: [
      [0, -3.2, 0.16, 0, 0, -0.1],
      [1.0, -1.35, 0.12, 0, -0.03, -0.1],
      [2.7, -0.65, -0.06, 0, -0.16, -0.1],
      [4.0, -1.5, -0.62, 0, 0.12, -0.15],
      [5.0, -2.6, -1.12, 0, 0.36, -0.2],
      [5.9, -3.7, -1.38, 0, 0.44, -0.2],
      [7.0, -6.2, -1.45, 0, 0.32, -0.2],
      [8.5, -10, -1.5, 0, 0.2, -0.2],
    ],
  },
  breach: {
    speed: 3,
    keys: [
      [0, -14, 1.25, 0, 0, 0.1],
      [1.4, -5.5, 1.3, 0, 0, 0.2],
      [2.2, -0.8, 1.28, 0.2, 0, 0.5],
      [3.0, 2.4, 1.0, 0.9, -0.05, 0.9],
      [3.55, 1.6, 0.6, 1.6, -0.1, 1.0],
      [3.95, -0.6, 0.12, 2.3, 0.0, 0.8],
      [4.6, -2.9, -0.15, 2.8, 0.1, 0.3],
      [6.0, -6, -0.3, 3.1, 0.1, 0],
      [7.5, -9, -0.3, 3.14, 0.0, 0],
    ],
  },
};
const moveLength = (kind: Exclude<MoveKind, 'under'>) => MOVES[kind].keys[MOVES[kind].keys.length - 1][0];

interface Move {
  kind: MoveKind;
  dur: number;
}

interface Whale {
  x: number;
  z: number;
  heading: number;
  turn: number;
  sea: number;
  plan: Move[];
  move: number;
  t: number;
  events: number;
  scale: number;
  variant: number;
  rollDir: number;
  bouts: number;
  calfOf: Whale | null;
  calfSide: number;
  /** Current pose (for sightings and effects). */
  y: number;
  pitch: number;
  roll: number;
  flex: number;
  flipper: number;
  visible: boolean;
}

/** Humpbacks in the channel (December to April): blows, rolling backs, flukes and breaches. */
export class Whales implements Species {
  readonly name = 'humpback';
  private whales: Whale[] = [];
  private timer = 15;
  private pose: Pose = newPose();
  private mesh: CreatureMesh;

  constructor(mesh: CreatureMesh) {
    this.mesh = mesh;
  }

  get active() {
    return this.whales.length;
  }

  clear() {
    this.whales.length = 0;
    this.timer = rand(10, 25);
  }

  spawnAt(ctx: Ctx, x: number, z: number, action?: string) {
    this.whales.length = 0;
    const first: Move[] = action === 'breach' ? [{ kind: 'under', dur: 0.5 }, { kind: 'breach', dur: moveLength('breach') }] : action === 'fluke' ? [{ kind: 'under', dur: 0.5 }, { kind: 'fluke', dur: moveLength('fluke') }] : [];
    this.spawnGroup(ctx, x, z, first, action === 'calf');
  }

  private bout(breach: boolean): Move[] {
    const plan: Move[] = [];
    if (breach) {
      plan.push({ kind: 'under', dur: rand(2, 5) }, { kind: 'breach', dur: moveLength('breach') });
      if (Math.random() < 0.45) plan.push({ kind: 'under', dur: rand(3, 6) }, { kind: 'breach', dur: moveLength('breach') });
    }
    const breaths = randInt(2, 4);
    for (let i = 0; i < breaths - 1; i++) plan.push({ kind: 'under', dur: rand(6, 11) }, { kind: 'breath', dur: moveLength('breath') });
    plan.push({ kind: 'under', dur: rand(6, 11) }, { kind: 'fluke', dur: moveLength('fluke') });
    plan.push({ kind: 'under', dur: rand(25, 45) });
    return plan;
  }

  private spawnGroup(ctx: Ctx, x: number, z: number, first: Move[] = [], forceCalf = false) {
    const near = distXZ(x, z, ctx.focus.x, ctx.focus.z) < 700;
    const plan = [{ kind: 'under' as const, dur: rand(1.5, 4) }, ...first, ...this.bout(Math.random() < (near ? 0.5 : 0.3))];
    const along = Math.random() < 0.7;
    const heading = along ? (Math.random() < 0.5 ? 0 : Math.PI) + rand(-0.5, 0.5) : rand(0, TAU);
    const mother = this.newWhale(x, z, heading, plan, 1, null);
    this.whales.push(mother);
    if (forceCalf || Math.random() < 0.35) {
      const calfPlan = plan.map((m) => (m.kind === 'breach' && Math.random() < 0.5 ? { kind: 'breath' as const, dur: moveLength('breath') } : { ...m }));
      calfPlan[0] = { kind: 'under', dur: calfPlan[0].dur + 1.3 };
      this.whales.push(this.newWhale(x, z, heading, calfPlan, 0.42, mother));
    }
  }

  private newWhale(x: number, z: number, heading: number, plan: Move[], scale: number, calfOf: Whale | null): Whale {
    return {
      x,
      z,
      heading,
      turn: 0,
      sea: 0,
      plan,
      move: 0,
      t: 0,
      events: 0,
      scale,
      variant: Math.random(),
      rollDir: Math.random() < 0.5 ? 1 : -1,
      bouts: 0,
      calfOf,
      calfSide: Math.random() < 0.5 ? 1 : -1,
      y: -10,
      pitch: 0,
      roll: 0,
      flex: 0,
      flipper: 0,
      visible: false,
    };
  }

  update(ctx: Ctx, dt: number) {
    const inSeason = ctx.month >= 1 && ctx.month <= 5;
    if (!inSeason) {
      if (this.whales.length) this.whales.length = 0;
      this.mesh.begin();
      this.mesh.end();
      return;
    }
    if (this.whales.length === 0) {
      const sdf = ctx.data.sdf(ctx.focus.x, ctx.focus.z);
      const peak = ctx.month >= 2 && ctx.month <= 4;
      this.timer -= dt * (peak ? 1 : 0.5);
      if (this.timer <= 0) {
        // Offshore riders meet whales often; from the beach they are distant blows.
        const offshore = sdf < -800, mid = sdf < -250;
        this.timer = arrival(offshore ? 25 : mid ? 70 : 160);
        const q = offshore ? { minR: 170, maxR: 700 } : { minR: 800, maxR: 1900 };
        const p = encounterPoint(ctx, { ...q, minDepth: 15, maxSdf: -1000 }, 0.8);
        if (p) this.spawnGroup(ctx, p.x, p.z);
      }
    }
    this.mesh.begin();
    for (let i = this.whales.length - 1; i >= 0; i--) {
      if (!this.updateWhale(ctx, this.whales[i], dt)) this.whales.splice(i, 1);
    }
    // Calves leave with their mothers.
    for (let i = this.whales.length - 1; i >= 0; i--) {
      const c = this.whales[i].calfOf;
      if (c && !this.whales.includes(c)) this.whales.splice(i, 1);
    }
    this.mesh.end();
  }

  private updateWhale(ctx: Ctx, w: Whale, dt: number) {
    w.t += dt;
    let move = w.plan[w.move];
    while (w.t >= move.dur) {
      w.t -= move.dur;
      w.move++;
      w.events = 0;
      if (w.move >= w.plan.length) {
        w.bouts++;
        if (!w.calfOf && (w.bouts >= 3 || distXZ(w.x, w.z, ctx.focus.x, ctx.focus.z) > 2200)) return false;
        const near = distXZ(w.x, w.z, ctx.focus.x, ctx.focus.z) < 700;
        w.plan = w.calfOf ? w.calfOf.plan.map((m) => ({ ...m })) : this.bout(Math.random() < (near ? 0.5 : 0.3));
        w.move = 0;
      }
      move = w.plan[w.move];
    }
    const s = w.scale;
    if (w.calfOf) {
      const m = w.calfOf;
      const rx = -fwdZ(m.heading), rz = fwdX(m.heading);
      w.x = m.x + rx * w.calfSide * 7 - fwdX(m.heading) * 3;
      w.z = m.z + rz * w.calfSide * 7 - fwdZ(m.heading) * 3;
      w.heading = m.heading;
    } else {
      if (Math.random() < dt / 8) w.turn = rand(-0.03, 0.03);
      const avoid = avoidShallows(ctx, w.x, w.z, w.heading, 220, 16, -950);
      w.heading = wrap(w.heading + (avoid ? avoid * 0.12 : w.turn) * dt);
      const speed = move.kind === 'under' ? 2.0 : MOVES[move.kind].speed;
      w.x += fwdX(w.heading) * speed * dt;
      w.z += fwdZ(w.heading) * speed * dt;
    }
    const sea = ctx.surface(w.x, w.z);
    w.sea = approach(w.sea, sea, 0.6, dt);
    if (move.kind === 'under') {
      w.y = w.sea - 10;
      w.visible = false;
      return true;
    }
    const keys = MOVES[move.kind].keys;
    const t = w.t;
    w.y = w.sea + keyframe(keys, t, 1) * s;
    w.pitch = keyframe(keys, t, 2);
    w.roll = keyframe(keys, t, 3) * w.rollDir;
    w.flex = keyframe(keys, t, 4) + Math.sin(ctx.time * 0.6) * 0.03;
    w.flipper = keyframe(keys, t, 5);
    const p = this.pose;
    p.x = w.x;
    p.y = w.y;
    p.z = w.z;
    p.heading = w.heading;
    p.pitch = w.pitch;
    p.roll = w.roll;
    p.scale = s;
    p.flap = w.flipper;
    p.hand = w.flipper * 0.3;
    p.flex = w.flex;
    p.variant = w.variant;
    this.effects(ctx, w, move.kind, t);
    // Steeply pitched whales (flukes up, breaching) reach far above their centre.
    w.visible = w.y + (1.6 + 7 * Math.abs(Math.sin(w.pitch))) * s > w.sea - 0.5;
    if (w.visible) {
      boost(ctx, p, w.sea, 0.3);
      this.mesh.push(p);
      localToWorld(tmp, p, 0, 1, 3.4);
      ctx.sight('humpback', tmp.x, Math.max(tmp.y, sea + 1), tmp.z, 600);
    }
    return true;
  }

  /** Time-triggered blows, splashes and drips for the current move. */
  private effects(ctx: Ctx, w: Whale, kind: MoveKind, t: number) {
    const s = w.scale;
    const p = this.pose;
    const once = (bit: number, at: number) => {
      if (t < at || w.events & bit) return false;
      w.events |= bit;
      return true;
    };
    if ((kind === 'breath' || kind === 'fluke') && once(1, 1.0)) {
      localToWorld(tmp, p, 0, 1.0, 3.4);
      ctx.fx.blow(tmp.x, Math.max(tmp.y, w.sea), tmp.z, { height: 4.2 * Math.pow(s, 0.7), width: 1.5 * Math.pow(s, 0.7), count: s < 1 ? 26 : 46 });
      ctx.fx.patch({ x: tmp.x, z: tmp.z, radius: 2.2 * s, kind: FOAM.ring, life: 3, grow: 2 });
      ctx.emit({ kind: 'blow', species: 'humpback', x: tmp.x, y: tmp.y, z: tmp.z, strength: s });
    }
    if (kind === 'fluke') {
      if (t > 4.4 && t < 7.4) {
        // Water streaming off the trailing edge as the flukes lift and slide away.
        for (let k = 0; k < 2; k++) {
          if (Math.random() > 0.7) continue;
          localToWorld(tmp, p, (Math.random() * 2 - 1) * 2.1, 0.1, -6.0 - Math.random() * 0.3);
          if (tmp.y > w.sea + 0.2) ctx.fx.drips(tmp.x, tmp.y, tmp.z, 1, 0.3 * s);
        }
      }
      if (once(2, 6.6)) {
        localToWorld(tmp, p, 0, 0, -5.5);
        ctx.fx.patch({ x: tmp.x, z: tmp.z, radius: 4.5 * s, kind: FOAM.slick, life: 16, grow: 1.6 });
        ctx.fx.splash(tmp.x, tmp.z, { power: 1.8, count: 10, size: 0.25 * s, foam: 1.6 * s });
        ctx.emit({ kind: 'dive', species: 'humpback', x: tmp.x, y: w.sea, z: tmp.z, strength: 0.4 * s });
      }
    }
    if (kind === 'breach') {
      if (once(4, 2.05)) {
        ctx.fx.splash(w.x + fwdX(w.heading) * 2 * s, w.z + fwdZ(w.heading) * 2 * s, { power: 6.5 * s, count: Math.round(70 * s), size: 0.45 * s, foam: 5 * s, mist: Math.round(10 * s) });
      }
      if (once(8, 3.82)) {
        // The slam: white water along the whole body.
        for (const lz of [-3, 0, 3, 5.5]) {
          localToWorld(tmp, p, 0, 0, lz);
          ctx.fx.splash(tmp.x, tmp.z, { power: 8.5 * s, count: Math.round(55 * s), size: 0.6 * s, foam: (lz === 0 ? 9 : 5) * s, mist: Math.round(14 * s) });
        }
        ctx.emit({ kind: 'breach', species: 'humpback', x: w.x, y: w.sea, z: w.z, strength: s });
      }
    }
  }
}

// ---------------------------------------------------------------- sea lions

type LionMode = 'float' | 'jug' | 'swim' | 'porpoise';

interface SeaLion {
  mode: LionMode;
  t: number;
  dur: number;
  x: number;
  z: number;
  heading: number;
  base: number;
  speed: number;
  sea: number;
  variant: number;
  scale: number;
  phase: number;
  above: boolean;
  left: number;
}

/** California sea lions: heads up looking around, a flipper in the air, porpoising runs. */
export class SeaLions implements Species {
  readonly name = 'sealion';
  private lions: SeaLion[] = [];
  private timer = rand(30, 90);
  private pose: Pose = newPose();
  private mesh: CreatureMesh;

  constructor(mesh: CreatureMesh) {
    this.mesh = mesh;
  }

  get active() {
    return this.lions.length;
  }

  clear() {
    this.lions.length = 0;
    this.timer = rand(30, 90);
  }

  spawnAt(ctx: Ctx, x: number, z: number, action?: string) {
    const l = this.newLion(x, z);
    if (action === 'jug' || action === 'porpoise' || action === 'float') this.setMode(ctx, l, action);
    this.lions.push(l);
  }

  private newLion(x: number, z: number): SeaLion {
    return {
      mode: 'float',
      t: 0,
      dur: rand(5, 11),
      x,
      z,
      heading: rand(0, TAU),
      base: rand(0, TAU),
      speed: 0,
      sea: 0,
      variant: Math.random() < 0.3 ? 1 : 0,
      scale: rand(0.9, 1.1),
      phase: rand(0, TAU),
      above: false,
      left: randInt(3, 6),
    };
  }

  private setMode(ctx: Ctx, l: SeaLion, mode: LionMode) {
    l.mode = mode;
    l.t = 0;
    l.dur = mode === 'float' ? rand(5, 11) : mode === 'jug' ? rand(9, 18) : mode === 'swim' ? rand(5, 10) : rand(6, 11);
    l.base = l.heading;
    if (mode === 'float' || mode === 'jug') ctx.fx.patch({ x: l.x, z: l.z, radius: 0.9, kind: FOAM.ring, life: 2.5, grow: 2.2 });
  }

  update(ctx: Ctx, dt: number) {
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = arrival(90);
      if (this.lions.length < 2) {
        const p = encounterPoint(ctx, { minR: 60, maxR: 320, minDepth: 3, maxSdf: -30 }, 0.85);
        if (p) for (let k = pickOne([1, 1, 1, 2, 2, 3]); k > 0; k--) this.lions.push(this.newLion(p.x + rand(-5, 5), p.z + rand(-5, 5)));
      }
    }
    this.mesh.begin();
    for (let i = this.lions.length - 1; i >= 0; i--) {
      if (!this.updateLion(ctx, this.lions[i], dt)) this.lions.splice(i, 1);
    }
    this.mesh.end();
  }

  private updateLion(ctx: Ctx, l: SeaLion, dt: number) {
    l.t += dt;
    if (l.t > l.dur) {
      l.left--;
      if (l.left <= 0 && !ctx.inView(l.x, l.sea, l.z)) return false;
      const next: LionMode = l.mode === 'swim' ? pickOne(['float', 'float', 'jug', 'porpoise'] as const) : l.mode === 'porpoise' ? 'float' : 'swim';
      this.setMode(ctx, l, next);
    }
    if (distXZ(l.x, l.z, ctx.focus.x, ctx.focus.z) > 1300) return false;
    const sea = ctx.surface(l.x, l.z);
    l.sea = approach(l.sea, sea, 3, dt);
    const p = this.pose;
    p.scale = l.scale;
    p.variant = l.variant;
    p.flap = 0;
    p.hand = 0;
    p.flex = 0;
    p.head = 0;
    p.roll = 0;
    let visible = true;
    switch (l.mode) {
      case 'float':
        // Periscoping: upright, head out, looking around.
        l.speed = 0;
        l.heading = l.base + Math.sin(l.t * 0.55 + l.phase) * 0.7;
        p.y = l.sea - 0.45 * l.scale + Math.sin(l.t * 2.2) * 0.05;
        p.pitch = 1.15;
        p.head = 0.45 + Math.sin(l.t * 0.8 + l.phase) * 0.2;
        p.flap = -0.3 + Math.sin(l.t * 1.3) * 0.15;
        break;
      case 'jug':
        // Lying on its side with a fore flipper held up out of the water.
        l.speed = 0.15;
        p.y = l.sea - 0.1 * l.scale;
        p.pitch = 0.05;
        p.roll = 1.3;
        p.flap = 0.55 + Math.sin(l.t * 0.7) * 0.08;
        p.hand = 0.4;
        p.flex = 0.25;
        p.head = -0.2;
        break;
      case 'swim':
        l.speed = 2.6;
        visible = false;
        if (Math.random() < dt / 3) l.heading = wrap(l.heading + rand(-0.6, 0.6));
        l.heading = wrap(l.heading + avoidShallows(ctx, l.x, l.z, l.heading, 40, 3) * dt);
        break;
      case 'porpoise': {
        l.speed = 6;
        l.heading = wrap(l.heading + avoidShallows(ctx, l.x, l.z, l.heading, 60, 3) * 0.5 * dt);
        const period = 1.7, arc = 0.85;
        const s = (l.t + l.phase) % period;
        if (s < arc) {
          const u = s / arc;
          const amp = 0.4 + 0.9;
          const h = -0.9 + amp * Math.sin(Math.PI * u);
          p.y = l.sea + h;
          p.pitch = Math.atan2(((amp * Math.PI) / arc) * Math.cos(Math.PI * u), l.speed);
          p.flap = -0.6;
          p.flex = Math.sin(l.t * 9) * 0.1;
          const above = h > -0.2;
          if (above !== l.above) {
            l.above = above;
            ctx.fx.splash(l.x, l.z, { power: above ? 1.6 : 2.4, count: above ? 4 : 9, size: 0.12, foam: above ? 0 : 0.6 });
          }
        } else visible = false;
        break;
      }
    }
    l.x += fwdX(l.heading) * l.speed * dt;
    l.z += fwdZ(l.heading) * l.speed * dt;
    if (!visible) {
      const d = distXZ(l.x, l.z, ctx.camX, ctx.camZ);
      if (d < 90) ctx.fx.shadow(l.x, l.z, l.heading, 1.9 * l.scale, 0.5 * l.scale, 0.4 * (1 - d / 90));
      return true;
    }
    p.x = l.x;
    p.z = l.z;
    p.heading = l.heading;
    boost(ctx, p, l.sea, 0.6);
    this.mesh.push(p);
    ctx.sight('sealion', l.x, l.sea + 0.3, l.z, 120);
    return true;
  }
}

// ---------------------------------------------------------------- sea turtles

interface Turtle {
  mode: 'up' | 'dive' | 'under';
  t: number;
  dur: number;
  x: number;
  z: number;
  heading: number;
  sea: number;
  breaths: number;
  variant: number;
  scale: number;
  pitch: number;
  head: number;
  depth: number;
}

/** Sea turtles that pop up for a breath and slip back under. */
export class Turtles implements Species {
  readonly name = 'turtle';
  private turtles: Turtle[] = [];
  private timer = rand(40, 100);
  private pose: Pose = newPose();
  private mesh: CreatureMesh;

  constructor(mesh: CreatureMesh) {
    this.mesh = mesh;
  }

  get active() {
    return this.turtles.length;
  }

  clear() {
    this.turtles.length = 0;
    this.timer = rand(40, 100);
  }

  spawnAt(ctx: Ctx, x: number, z: number) {
    const t = this.newTurtle(x, z);
    this.surface(ctx, t);
    this.turtles.push(t);
  }

  private newTurtle(x: number, z: number): Turtle {
    return {
      mode: 'under',
      t: 0,
      dur: rand(1, 3),
      x,
      z,
      heading: rand(0, TAU),
      sea: 0,
      breaths: randInt(2, 3),
      variant: Math.random() < 0.35 ? 1 : 0,
      scale: rand(0.85, 1.1),
      pitch: 0,
      head: 0,
      depth: -1.4,
    };
  }

  private surface(ctx: Ctx, t: Turtle) {
    t.mode = 'up';
    t.t = 0;
    t.dur = rand(3.5, 6);
    t.depth = -0.6;
    t.pitch = 0.3;
    ctx.fx.patch({ x: t.x, z: t.z, radius: 0.8, kind: FOAM.ring, life: 2.4, grow: 2.4 });
  }

  update(ctx: Ctx, dt: number) {
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = arrival(80);
      if (this.turtles.length < 2) {
        const p = encounterPoint(ctx, { minR: 45, maxR: 230, minDepth: 2.5, maxSdf: -25 }, 0.85);
        if (p) this.turtles.push(this.newTurtle(p.x, p.z));
      }
    }
    this.mesh.begin();
    for (let i = this.turtles.length - 1; i >= 0; i--) {
      if (!this.updateTurtle(ctx, this.turtles[i], dt)) this.turtles.splice(i, 1);
    }
    this.mesh.end();
  }

  private updateTurtle(ctx: Ctx, t: Turtle, dt: number) {
    t.t += dt;
    if (distXZ(t.x, t.z, ctx.focus.x, ctx.focus.z) > 900) return false;
    const sea = ctx.surface(t.x, t.z);
    t.sea = approach(t.sea, sea, 3, dt);
    let speed = 0.25, flap = 0;
    if (t.mode === 'up') {
      // Breathing: shell awash, head raised clear of the chop.
      t.depth = approach(t.depth, -0.24, 3, dt);
      t.pitch = approach(t.pitch, 0.24 + Math.sin(t.t * 1.7) * 0.04, 2, dt);
      t.head = approach(t.head, -0.8 + Math.sin(t.t * 0.9) * 0.12, 3, dt);
      flap = Math.sin(t.t * 0.9) * 0.15;
      if (t.t > t.dur) {
        t.mode = 'dive';
        t.t = 0;
        t.breaths--;
        ctx.fx.patch({ x: t.x, z: t.z, radius: 0.7, kind: FOAM.ring, life: 2, grow: 2 });
      }
    } else if (t.mode === 'dive') {
      t.depth = approach(t.depth, -1.6, 1.6, dt);
      t.pitch = approach(t.pitch, -0.6, 2.5, dt);
      t.head = approach(t.head, 0.25, 3, dt);
      flap = Math.sin(t.t * 4.5) * 0.55;
      speed = 0.9;
      if (t.t > 1.6) {
        t.mode = 'under';
        t.t = 0;
        t.dur = rand(7, 14);
        if (t.breaths <= 0 && !ctx.inView(t.x, sea, t.z)) return false;
      }
    } else {
      speed = 0.8;
      if (Math.random() < dt / 4) t.heading = wrap(t.heading + rand(-0.8, 0.8));
      t.heading = wrap(t.heading + avoidShallows(ctx, t.x, t.z, t.heading, 25, 2) * dt);
      const d = distXZ(t.x, t.z, ctx.camX, ctx.camZ);
      if (d < 80) ctx.fx.shadow(t.x, t.z, t.heading, 1.0 * t.scale, 0.85 * t.scale, 0.42 * (1 - d / 80));
      if (t.t > t.dur) {
        if (t.breaths <= 0) return false;
        this.surface(ctx, t);
      }
    }
    t.x += fwdX(t.heading) * speed * dt;
    t.z += fwdZ(t.heading) * speed * dt;
    if (t.mode === 'under') return true;
    const p = this.pose;
    p.x = t.x;
    p.y = t.sea + t.depth * t.scale;
    p.z = t.z;
    p.heading = t.heading;
    p.pitch = t.pitch;
    p.roll = Math.sin(t.t * 1.3) * 0.05;
    p.scale = t.scale;
    p.flap = flap;
    p.hand = flap * 0.4;
    p.head = t.head;
    p.variant = t.variant;
    boost(ctx, p, t.sea, 0.6);
    this.mesh.push(p);
    if (t.mode === 'up') ctx.sight('turtle', t.x, t.sea + 0.15, t.z, 120);
    return true;
  }
}

// ---------------------------------------------------------------- mobula rays

interface Ray {
  ox: number;
  oz: number;
  air: boolean;
  t: number;
  next: number;
  x: number;
  z: number;
  y0: number;
  vy: number;
  vh: number;
  heading: number;
  flip: number;
  scale: number;
  phase: number;
}

interface School {
  x: number;
  z: number;
  heading: number;
  radius: number;
  rays: Ray[];
  age: number;
  life: number;
}

/** Mobula schools in April: rays leaping clear and belly-flopping all around. */
export class Mobulas implements Species {
  readonly name = 'mobula';
  private schools: School[] = [];
  private timer = 3;
  private pose: Pose = newPose();
  private mesh: CreatureMesh;

  constructor(mesh: CreatureMesh) {
    this.mesh = mesh;
  }

  get active() {
    return this.schools.reduce((n, s) => n + s.rays.length, 0);
  }

  clear() {
    this.schools.length = 0;
    this.timer = rand(2, 6);
  }

  spawnAt(_ctx: Ctx, x: number, z: number) {
    this.schools.push(this.newSchool(x, z));
  }

  private newSchool(x: number, z: number): School {
    const radius = rand(25, 65);
    const rays: Ray[] = [];
    for (let i = randInt(20, 34); i > 0; i--) {
      const a = rand(0, TAU), r = Math.sqrt(Math.random()) * radius;
      rays.push({ ox: Math.cos(a) * r, oz: Math.sin(a) * r, air: false, t: 0, next: rand(0.2, 9), x: 0, z: 0, y0: 0, vy: 0, vh: 0, heading: 0, flip: 0, scale: rand(0.8, 1.15), phase: rand(0, TAU) });
    }
    return { x, z, heading: rand(0, TAU), radius, rays, age: 0, life: rand(140, 260) };
  }

  update(ctx: Ctx, dt: number) {
    if (ctx.month !== 5) {
      if (this.schools.length) this.schools.length = 0;
      this.mesh.begin();
      this.mesh.end();
      return;
    }
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = rand(10, 30);
      if (this.schools.length < 2) {
        const p = encounterPoint(ctx, { minR: 70, maxR: 450, minDepth: 4, maxSdf: -40 }, 0.8);
        if (p) this.schools.push(this.newSchool(p.x, p.z));
      }
    }
    this.mesh.begin();
    let shadows = 0;
    for (let i = this.schools.length - 1; i >= 0; i--) {
      const s = this.schools[i];
      s.age += dt;
      if (Math.random() < dt / 6) s.heading = wrap(s.heading + rand(-0.7, 0.7));
      s.heading = wrap(s.heading + avoidShallows(ctx, s.x, s.z, s.heading, 60, 4) * 0.4 * dt);
      s.x += fwdX(s.heading) * 0.7 * dt;
      s.z += fwdZ(s.heading) * 0.7 * dt;
      const d = distXZ(s.x, s.z, ctx.focus.x, ctx.focus.z);
      if (d > 1500 || (s.age > s.life && !ctx.inView(s.x, 0, s.z))) {
        this.schools.splice(i, 1);
        continue;
      }
      for (const r of s.rays) {
        if (!r.air) {
          r.next -= dt;
          const rx = s.x + r.ox + Math.sin(ctx.time * 0.2 + r.phase) * 3, rz = s.z + r.oz + Math.cos(ctx.time * 0.17 + r.phase) * 3;
          if (r.next <= 0 && d < 1300) {
            r.air = true;
            r.t = 0;
            r.x = rx;
            r.z = rz;
            r.y0 = ctx.surface(rx, rz) - 0.3;
            r.vy = rand(4.2, 6.4);
            r.vh = rand(0.6, 2.2);
            r.heading = s.heading + rand(-1.2, 1.2);
            r.flip = pickOne([0, 0, 0, 0, 1, 1, 2, 3]);
            ctx.fx.splash(rx, rz, { power: 2, count: 6, size: 0.12 });
          } else {
            const dc = distXZ(rx, rz, ctx.camX, ctx.camZ);
            if (dc < 70 && shadows < 10) {
              shadows++;
              ctx.fx.shadow(rx, rz, s.heading + r.phase, 0.95 * r.scale, 1.15 * r.scale, 0.42 * (1 - dc / 70), FOAM.rayShadow);
            }
          }
          continue;
        }
        r.t += dt;
        r.x += fwdX(r.heading) * r.vh * dt;
        r.z += fwdZ(r.heading) * r.vh * dt;
        const y = r.y0 + r.vy * r.t - 0.5 * G * r.t * r.t;
        const sea = ctx.surface(r.x, r.z);
        if (r.t > 0.2 && y < sea) {
          r.air = false;
          r.next = rand(2, 12);
          // Belly flop.
          ctx.fx.splash(r.x, r.z, { power: 2.8, count: 14, size: 0.15, foam: 0.9, mist: 1 });
          if (distXZ(r.x, r.z, ctx.camX, ctx.camZ) < 250) ctx.emit({ kind: 'slap', species: 'mobula', x: r.x, y: sea, z: r.z, strength: 0.2 });
          continue;
        }
        const dur = (2 * r.vy) / G;
        const u = Math.min(1, r.t / dur);
        const p = this.pose;
        let pitch = 1.0 - 1.1 * u, roll = 0;
        if (r.flip === 1) pitch = 1.0 - (TAU + 1.0) * smooth(0.1, 0.95, u);
        else if (r.flip === 2) pitch = 1.0 + (TAU - 1.0) * smooth(0.1, 0.95, u);
        else if (r.flip === 3) {
          pitch = 0.8 - 0.8 * u;
          roll = TAU * smooth(0.1, 0.9, u);
        }
        p.x = r.x;
        p.y = y;
        p.z = r.z;
        p.heading = r.heading;
        p.pitch = pitch;
        p.roll = roll;
        p.scale = r.scale;
        p.flap = 0.1 + 0.6 * Math.sin(r.t * 5.5 * TAU + r.phase);
        p.hand = 0.3 * Math.sin(r.t * 5.5 * TAU + r.phase - 0.8);
        p.variant = 0;
        boost(ctx, p, sea, 0.7);
        this.mesh.push(p);
        ctx.sight('mobula', r.x, y, r.z, 120);
      }
    }
    this.mesh.end();
  }
}

