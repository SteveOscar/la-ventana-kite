import type { CreatureMesh } from './creatures.ts';
import { newPose, type Pose } from './creatures.ts';
import {
  approach,
  approachAngle,
  arrival,
  distXZ,
  encounterPoint,
  fwdX,
  fwdZ,
  headingTo,
  pickOne,
  rand,
  randInt,
  readable,
  seaPoint,
  wrap,
  type Ctx,
  type Species,
} from './common.ts';

const BIRD_GAIN = 0.8;

const G = 9.81;
const TAU = Math.PI * 2;
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Bank angle for a coordinated turn. */
const bankFor = (speed: number, turnRate: number) => Math.atan((speed * turnRate) / G);

/** Turns toward open water when the coast is ahead; returns a turn-rate bias. */
function avoidShore(ctx: Ctx, x: number, z: number, heading: number, look: number, margin: number) {
  const ahead = ctx.data.sdf(x + fwdX(heading) * look, z + fwdZ(heading) * look);
  if (ahead < -margin) return 0;
  const l = ctx.data.sdf(x + fwdX(heading - 0.7) * look, z + fwdZ(heading - 0.7) * look);
  const r = ctx.data.sdf(x + fwdX(heading + 0.7) * look, z + fwdZ(heading + 0.7) * look);
  return r < l ? 0.35 : -0.35;
}

// ---------------------------------------------------------------- pelicans

interface FlockBird {
  delay: number;
  side: number;
  back: number;
  dy: number;
  sea: number;
  variant: number;
  scale: number;
  wob: number;
}

interface Flock {
  x: number;
  z: number;
  heading: number;
  speed: number;
  turn: number;
  turnTarget: number;
  turnTimer: number;
  alt: number;
  birds: FlockBird[];
  /** Recent flap bouts as [start, end] pairs (end lands on a whole number of beats). */
  bouts: number[];
  nextBout: number;
  age: number;
  /** Signed lateral distance the flock aims to pass the rider at; 0 once it has passed. */
  pass: number;
}

type DiverState = 'circle' | 'dive' | 'under' | 'sit' | 'run' | 'fly';

interface Diver {
  state: DiverState;
  t: number;
  x: number;
  y: number;
  z: number;
  heading: number;
  speed: number;
  vy: number;
  turn: number;
  cx: number;
  cz: number;
  r: number;
  dir: number;
  dur: number;
  roll: number;
  twist: number;
  fold: number;
  pitch: number;
  head: number;
  variant: number;
  scale: number;
  sea: number;
  patter: number;
  flapT: number;
  age: number;
}

const PELICAN_HZ = 1.45;

/** Brown pelicans: low lines over the chop with a ripple of wingbeats; plunge-divers and loafers. */
export class Pelicans implements Species {
  readonly name = 'pelican';
  private flocks: Flock[] = [];
  private divers: Diver[] = [];
  private flockTimer = 0;
  private diverTimer = 4;
  private pose: Pose = newPose();
  private mesh: CreatureMesh;

  constructor(mesh: CreatureMesh) {
    this.mesh = mesh;
  }

  get active() {
    return this.flocks.reduce((n, f) => n + f.birds.length, 0) + this.divers.length;
  }

  clear() {
    this.flocks.length = 0;
    this.divers.length = 0;
    this.flockTimer = 0;
    this.diverTimer = 3;
  }

  spawnAt(ctx: Ctx, x: number, z: number, action?: string) {
    if (action === 'dive' || action === 'sit') {
      this.divers.push(this.newDiver(ctx, x, z, action === 'sit' ? 'sit' : 'circle'));
      return;
    }
    // A flock that crosses the view through the point.
    const h = headingTo(ctx.fwdZ, -ctx.fwdX) + (Math.random() < 0.5 ? 0 : Math.PI) + rand(-0.3, 0.3);
    this.flocks.push(this.newFlock(x - fwdX(h) * 90, z - fwdZ(h) * 90, h));
  }

  private newFlock(x: number, z: number, heading: number): Flock {
    const n = pickOne([3, 4, 4, 5, 5, 6, 6, 7, 8, 9]);
    const form = Math.random();
    const birds: FlockBird[] = [];
    for (let i = 0; i < n; i++) {
      let side = 0, back = 0;
      if (form < 0.5) {
        // Single file with a slight stagger.
        back = i * rand(2.0, 2.6);
        side = (i % 2 ? 1 : -1) * rand(0, 0.5);
      } else if (form < 0.8) {
        const k = Math.ceil(i / 2), s = i % 2 ? 1 : -1;
        back = k * rand(1.7, 2.1);
        side = s * k * rand(1.5, 1.9);
      } else {
        back = i * rand(1.6, 2.0);
        side = i * rand(1.4, 1.8);
      }
      birds.push({
        delay: i * rand(0.26, 0.36),
        side,
        back,
        dy: rand(-0.4, 0.4) + i * 0.05,
        sea: 0,
        variant: Math.random() < 0.45 ? 1 : 0,
        scale: rand(0.92, 1.08),
        wob: rand(0, TAU),
      });
    }
    return {
      x,
      z,
      heading,
      speed: rand(10, 12.5),
      turn: 0,
      turnTarget: 0,
      turnTimer: rand(2, 5),
      alt: Math.random() < 0.8 ? rand(1.3, 3.2) : rand(6, 12),
      birds,
      bouts: [],
      nextBout: rand(0.5, 3),
      age: 0,
      pass: 0,
    };
  }

  private newDiver(ctx: Ctx, x: number, z: number, state: DiverState): Diver {
    const sea = ctx.surface(x, z);
    return {
      state,
      t: 0,
      x,
      y: state === 'sit' ? sea : sea + rand(9, 14),
      z,
      heading: rand(0, TAU),
      speed: state === 'sit' ? 0 : rand(7.5, 9),
      vy: 0,
      turn: 0,
      cx: x,
      cz: z,
      r: rand(12, 22),
      dir: Math.random() < 0.5 ? 1 : -1,
      dur: state === 'sit' ? rand(25, 70) : rand(3, 8),
      roll: 0,
      twist: (Math.random() < 0.5 ? 1 : -1) * rand(1.2, 2.2),
      fold: state === 'sit' ? 1 : 0,
      pitch: 0,
      head: 0,
      variant: Math.random() < 0.45 ? 1 : 0,
      scale: rand(0.92, 1.08),
      sea,
      patter: 0,
      flapT: 0,
      age: 0,
    };
  }

  private spawnFlock(ctx: Ctx) {
    for (let attempt = 0; attempt < 8; attempt++) {
      // Mostly along the coast (north-south), sometimes any direction.
      const along = Math.random() < 0.7;
      const h = along ? (Math.random() < 0.5 ? 0 : Math.PI) + rand(-0.4, 0.4) : rand(0, TAU);
      const lateral = (Math.random() < 0.5 ? 1 : -1) * rand(20, 170);
      const behind = rand(380, 620);
      // Meet the rider where they will be, not where they are.
      const lead = Math.min(35, behind / 11);
      const rx = -fwdZ(h), rz = fwdX(h);
      const mx = ctx.focus.x + ctx.vx * lead + rx * lateral, mz = ctx.focus.z + ctx.vz * lead + rz * lateral;
      const sx = mx - fwdX(h) * behind, sz = mz - fwdZ(h) * behind;
      if (ctx.data.sdf(mx, mz) > -25 || ctx.data.sdf(sx, sz) > -25) continue;
      const f = this.newFlock(sx, sz, h);
      f.pass = Math.random() < 0.75 ? lateral : 0;
      this.flocks.push(f);
      return true;
    }
    return false;
  }

  update(ctx: Ctx, dt: number) {
    const fx = ctx.focus.x, fz = ctx.focus.z;
    const nearShore = ctx.data.sdf(fx, fz) > -700;
    const target = nearShore ? 3 : 2;
    this.flockTimer -= dt;
    if (this.flocks.length < target && this.flockTimer <= 0) {
      this.flockTimer = this.spawnFlock(ctx) ? rand(6, 22) : 4;
    }
    this.diverTimer -= dt;
    if (this.diverTimer <= 0) {
      this.diverTimer = arrival(26);
      if (this.divers.length < 3) {
        const resting = nearShore && Math.random() < 0.35;
        const p = resting
          ? encounterPoint(ctx, { minR: 120, maxR: 420, maxSdf: -35, minSdf: -320, minDepth: 1.5 })
          : encounterPoint(ctx, { minR: 90, maxR: 380, maxSdf: -15, minDepth: 1.5 });
        if (p) {
          this.divers.push(this.newDiver(ctx, p.x, p.z, resting ? 'sit' : 'circle'));
          if (resting) {
            for (let k = randInt(0, 2); k > 0; k--) this.divers.push(this.newDiver(ctx, p.x + rand(-6, 6), p.z + rand(-6, 6), 'sit'));
          }
        }
      }
    }

    this.mesh.begin();
    for (let i = this.flocks.length - 1; i >= 0; i--) {
      const f = this.flocks[i];
      if (!this.updateFlock(ctx, f, dt)) this.flocks.splice(i, 1);
    }
    for (let i = this.divers.length - 1; i >= 0; i--) {
      const d = this.divers[i];
      if (!this.updateDiver(ctx, d, dt)) this.divers.splice(i, 1);
    }
    this.mesh.end();
  }

  private flapEnvelope(f: Flock, t: number): { env: number; phase: number } {
    let env = 0, phase = 0;
    for (let k = 0; k < f.bouts.length; k += 2) {
      const s = f.bouts[k], e = f.bouts[k + 1];
      if (t < s - 0.01 || t > e + 0.35) continue;
      const v = smooth(s - 0.01, s + 0.2, t) * (1 - smooth(e - 0.05, e + 0.35, t));
      if (v > env) {
        env = v;
        phase = (t - s) * PELICAN_HZ * TAU;
      }
    }
    return { env, phase };
  }

  private updateFlock(ctx: Ctx, f: Flock, dt: number) {
    f.age += dt;
    const time = ctx.time;
    f.nextBout -= dt;
    if (f.nextBout <= 0) {
      const beats = randInt(3, 6);
      f.bouts.push(time, time + beats / PELICAN_HZ);
      if (f.bouts.length > 8) f.bouts.splice(0, 2);
      f.nextBout = beats / PELICAN_HZ + rand(3, 8);
    }
    f.turnTimer -= dt;
    if (f.turnTimer <= 0) {
      f.turnTimer = rand(3, 7);
      f.turnTarget = rand(-0.045, 0.045);
    }
    const avoid = avoidShore(ctx, f.x, f.z, f.heading, 140, 45);
    let want = f.turnTarget;
    const dRider = distXZ(f.x, f.z, ctx.focus.x, ctx.focus.z);
    if (f.pass !== 0) {
      // Bend the line gently so it passes beside the rider, then fly on straight.
      if (dRider < 150) f.pass = 0;
      else {
        const lead = Math.min(30, dRider / f.speed);
        const px = ctx.focus.x + ctx.vx * lead, pz = ctx.focus.z + ctx.vz * lead;
        const aim = headingTo(px - f.x, pz - f.z) + Math.atan2(f.pass, Math.max(80, distXZ(f.x, f.z, px, pz)));
        want = Math.max(-0.09, Math.min(0.09, wrap(aim - f.heading) * 0.3));
      }
    }
    f.turn = approach(f.turn, avoid !== 0 ? avoid * 0.5 : want, 1.2, dt);
    f.heading = wrap(f.heading + f.turn * dt);
    f.x += fwdX(f.heading) * f.speed * dt;
    f.z += fwdZ(f.heading) * f.speed * dt;
    const d = distXZ(f.x, f.z, ctx.focus.x, ctx.focus.z);
    if (d > 1150 && f.age > 8) return false;

    const hx = fwdX(f.heading), hz = fwdZ(f.heading), rx = -hz, rz = hx;
    const bank = bankFor(f.speed, f.turn);
    const p = this.pose;
    for (const b of f.birds) {
      const x = f.x + rx * b.side - hx * b.back, z = f.z + rz * b.side - hz * b.back;
      const sea = ctx.surface(x, z);
      if (f.age < 0.05) b.sea = sea;
      b.sea = approach(b.sea, sea, 1.8, dt);
      const { env, phase } = this.flapEnvelope(f, time - b.delay);
      const wob = Math.sin(time * 0.9 + b.wob);
      p.x = x;
      p.y = b.sea + f.alt + b.dy + wob * 0.18 + env * 0.15;
      p.z = z;
      p.heading = f.heading + Math.sin(time * 0.37 + b.wob) * 0.03;
      p.pitch = 0.05 - env * 0.04 + Math.cos(time * 0.9 + b.wob) * 0.03;
      p.roll = bank + Math.sin(time * 1.3 + b.wob * 2) * 0.05;
      p.scale = b.scale * readable(ctx, x, p.y, z, BIRD_GAIN);
      p.flap = 0.03 + env * (0.1 + 0.58 * Math.sin(phase));
      p.hand = -0.12 - env * 0.32 * Math.sin(phase - 0.7) + (1 - env) * Math.sin(time * 2.1 + b.wob) * 0.03;
      p.fold = 0;
      p.variant = b.variant;
      p.head = 0;
      this.mesh.push(p);
      ctx.sight('pelican', x, p.y, z, 150);
    }
    return true;
  }

  private updateDiver(ctx: Ctx, d: Diver, dt: number) {
    d.t += dt;
    d.age += dt;
    const p = this.pose;
    const sea = ctx.surface(d.x, d.z);
    let flap = 0.03, hand = -0.12, visible = true;
    switch (d.state) {
      case 'circle': {
        // Soaring a slow circle, looking down, a few lazy beats now and then.
        const w = (d.speed / d.r) * d.dir;
        d.heading = wrap(d.heading + w * dt);
        d.turn = w;
        d.x += fwdX(d.heading) * d.speed * dt;
        d.z += fwdZ(d.heading) * d.speed * dt;
        d.flapT -= dt;
        if (d.flapT < -rand(2.5, 4)) d.flapT = 3 / PELICAN_HZ;
        const env = d.flapT > 0 ? smooth(0, 0.2, d.flapT) : 0;
        flap = 0.05 + env * (0.1 + 0.5 * Math.sin(d.t * PELICAN_HZ * TAU));
        hand = -0.1 - env * 0.3 * Math.sin(d.t * PELICAN_HZ * TAU - 0.7);
        d.pitch = 0.04;
        d.roll = bankFor(d.speed, w) * 1.3;
        if (d.t > d.dur) {
          d.state = 'dive';
          d.t = 0;
          d.vy = 0;
        }
        break;
      }
      case 'dive': {
        // Tip over, fold back, twist just before the water.
        d.speed = approach(d.speed, 3, 1.2, dt);
        d.vy -= G * 1.15 * dt;
        d.x += fwdX(d.heading) * d.speed * dt;
        d.z += fwdZ(d.heading) * d.speed * dt;
        d.y += d.vy * dt;
        d.pitch = approach(d.pitch, -1.25, 5, dt);
        d.fold = approach(d.fold, 0.82, 6, dt);
        const low = smooth(3.5, 0.8, d.y - sea);
        d.roll = approach(d.roll, d.twist * low, 6, dt);
        flap = 0.25 * (1 - d.fold);
        hand = -0.3;
        if (d.y <= sea + 0.2) {
          ctx.fx.splash(d.x, d.z, { power: 4.8, count: 28, size: 0.2, foam: 1.5, mist: 3 });
          ctx.emit({ kind: 'splash', species: 'pelican', x: d.x, y: sea, z: d.z, strength: 0.35 });
          d.state = 'under';
          d.t = 0;
        }
        break;
      }
      case 'under':
        visible = false;
        if (d.t > 0.9) {
          d.state = 'sit';
          d.t = 0;
          d.dur = rand(4, 9);
          d.roll = 0;
          d.pitch = -0.35;
          d.head = 1.1;
          ctx.fx.patch({ x: d.x, z: d.z, radius: 1.2, kind: 1, life: 3, grow: 1.6 });
        }
        break;
      case 'sit': {
        // Bobbing on the chop; bill down to drain the pouch, then up to swallow.
        d.fold = 1;
        d.speed = 0;
        d.heading = approachAngle(d.heading, ctx.windFrom, 0.15, dt);
        d.x += ctx.windX * 0.03 * dt;
        d.z += ctx.windZ * 0.03 * dt;
        d.y = sea - 0.04;
        d.pitch = approach(d.pitch, 0.06 + Math.sin(d.age * 1.7) * 0.05, 2, dt);
        d.roll = Math.sin(d.age * 1.3 + d.scale * 9) * 0.06;
        const swallow = d.t < 3 ? (d.t < 1.4 ? 1.1 : d.t < 2.2 ? -0.7 : 0) : Math.sin(d.age * 0.6) * 0.15;
        d.head = approach(d.head, swallow, 3, dt);
        flap = 0;
        hand = 0;
        if (d.t > d.dur) {
          d.state = 'run';
          d.t = 0;
          d.heading = ctx.windFrom + rand(-0.4, 0.4);
        }
        break;
      }
      case 'run': {
        // Running take-off into the wind, feet slapping the water.
        d.fold = approach(d.fold, 0, 6, dt);
        d.speed = Math.min(9.5, d.speed + 5.5 * dt);
        d.x += fwdX(d.heading) * d.speed * dt;
        d.z += fwdZ(d.heading) * d.speed * dt;
        d.y = sea + smooth(0.6, 1.9, d.t) * 1.2 + 0.05;
        d.pitch = 0.18;
        d.head = approach(d.head, 0, 3, dt);
        const ph = d.t * 2.2 * TAU;
        flap = 0.15 + 0.72 * Math.sin(ph);
        hand = -0.35 * Math.sin(ph - 0.7);
        d.patter -= dt;
        if (d.patter <= 0 && d.t < 1.8) {
          d.patter = 0.16;
          ctx.fx.splash(d.x, d.z, { power: 1.6, count: 4, size: 0.1 });
        }
        if (d.t > 2.2) {
          d.state = 'fly';
          d.t = 0;
          d.turn = rand(-0.06, 0.06);
          d.flapT = 4 / PELICAN_HZ;
        }
        break;
      }
      case 'fly': {
        d.speed = approach(d.speed, 10.5, 0.6, dt);
        d.turn = approach(d.turn, avoidShore(ctx, d.x, d.z, d.heading, 120, 40) * 0.5, 0.8, dt);
        d.heading = wrap(d.heading + d.turn * dt);
        d.x += fwdX(d.heading) * d.speed * dt;
        d.z += fwdZ(d.heading) * d.speed * dt;
        d.sea = approach(d.sea, sea, 1.5, dt);
        d.y = approach(d.y, d.sea + 2.4, 0.8, dt);
        d.pitch = 0.04;
        d.roll = bankFor(d.speed, d.turn);
        d.flapT -= dt;
        if (d.flapT < -rand(3, 7)) d.flapT = randInt(3, 5) / PELICAN_HZ;
        const env = d.flapT > 0 ? smooth(0, 0.2, d.flapT) : 0;
        flap = 0.03 + env * (0.1 + 0.58 * Math.sin(d.t * PELICAN_HZ * TAU));
        hand = -0.12 - env * 0.32 * Math.sin(d.t * PELICAN_HZ * TAU - 0.7);
        if (distXZ(d.x, d.z, ctx.focus.x, ctx.focus.z) > 950) return false;
        break;
      }
    }
    if (d.state === 'circle' || d.state === 'dive') d.sea = sea;
    if (distXZ(d.x, d.z, ctx.focus.x, ctx.focus.z) > 1400) return false;
    if (!visible) return true;
    p.x = d.x;
    p.y = d.y;
    p.z = d.z;
    p.heading = d.heading;
    p.pitch = d.pitch;
    p.roll = d.roll;
    p.scale = d.scale * readable(ctx, d.x, d.y, d.z, BIRD_GAIN);
    p.flap = flap;
    p.hand = hand;
    p.fold = d.fold;
    p.variant = d.variant;
    p.head = d.head;
    this.mesh.push(p);
    ctx.sight('pelican', d.x, d.y, d.z, 150);
    return true;
  }
}

// ---------------------------------------------------------------- frigatebirds

interface Frigate {
  mode: 'soar' | 'glide' | 'swoop';
  t: number;
  dur: number;
  cx: number;
  cz: number;
  r: number;
  ang: number;
  dir: number;
  speed: number;
  x: number;
  y: number;
  z: number;
  heading: number;
  turn: number;
  alt: number;
  altTarget: number;
  variant: number;
  scale: number;
  flapT: number;
  phase: number;
  tx: number;
  tz: number;
}

/** Magnificent frigatebirds hanging high on the wind, circling and drifting downwind. */
export class Frigates implements Species {
  readonly name = 'frigate';
  private birds: Frigate[] = [];
  private timer = 0;
  private pose: Pose = newPose();
  private mesh: CreatureMesh;

  constructor(mesh: CreatureMesh) {
    this.mesh = mesh;
  }

  get active() {
    return this.birds.length;
  }

  clear() {
    this.birds.length = 0;
    this.timer = 0;
  }

  spawnAt(ctx: Ctx, x: number, z: number, action?: string) {
    const b = this.newBird(ctx, x, z);
    if (action === 'low') {
      b.alt = b.altTarget = 35;
    }
    this.birds.push(b);
  }

  private newBird(ctx: Ctx, x: number, z: number): Frigate {
    const r = rand(28, 70);
    const ang = rand(0, TAU);
    const alt = Math.random() < 0.35 ? rand(40, 65) : rand(60, 140);
    return {
      mode: 'soar',
      t: 0,
      dur: rand(18, 40),
      cx: x - Math.cos(ang) * r,
      cz: z - Math.sin(ang) * r,
      r,
      ang,
      dir: Math.random() < 0.5 ? 1 : -1,
      speed: rand(8, 10.5),
      x,
      y: ctx.surface(x, z) + alt,
      z,
      heading: 0,
      turn: 0,
      alt,
      altTarget: alt,
      variant: Math.random() < 0.5 ? 1 : 0,
      scale: rand(0.95, 1.08),
      flapT: -rand(5, 30),
      phase: rand(0, TAU),
      tx: x,
      tz: z,
    };
  }

  update(ctx: Ctx, dt: number) {
    const target = ctx.data.sdf(ctx.focus.x, ctx.focus.z) > -1500 ? 3 : 2;
    this.timer -= dt;
    if (this.birds.length < target && this.timer <= 0) {
      this.timer = rand(8, 25);
      const p = encounterPoint(ctx, { minR: 150, maxR: 550, maxSdf: 200 }, 0.6);
      if (p) this.birds.push(this.newBird(ctx, p.x, p.z));
    }
    this.mesh.begin();
    for (let i = this.birds.length - 1; i >= 0; i--) {
      if (!this.updateBird(ctx, this.birds[i], dt)) this.birds.splice(i, 1);
    }
    this.mesh.end();
  }

  private updateBird(ctx: Ctx, b: Frigate, dt: number) {
    b.t += dt;
    const prevHeading = b.heading;
    let nx = b.x, nz = b.z;
    if (b.mode === 'soar') {
      b.cx += ctx.windX * 0.22 * dt;
      b.cz += ctx.windZ * 0.22 * dt;
      // They hang around the beach and the riders: drift over the action, a little ahead of it.
      const hx = ctx.focus.x + ctx.vx * 12, hz = ctx.focus.z + ctx.vz * 12;
      const away = distXZ(b.cx, b.cz, hx, hz);
      if (away > 140) {
        const v = Math.min(7, 1.5 + (away - 140) * 0.02 + Math.hypot(ctx.vx, ctx.vz) * 0.6);
        b.cx += ((hx - b.cx) / away) * v * dt;
        b.cz += ((hz - b.cz) / away) * v * dt;
      }
      b.ang += ((b.dir * b.speed) / b.r) * dt;
      nx = b.cx + Math.cos(b.ang) * b.r;
      nz = b.cz + Math.sin(b.ang) * b.r;
      if (b.t > b.dur) {
        const swoop = Math.random() < 0.4 && distXZ(b.x, b.z, ctx.focus.x, ctx.focus.z) < 500;
        b.mode = swoop ? 'swoop' : 'glide';
        b.t = 0;
        b.dur = swoop ? rand(14, 20) : rand(8, 16);
        const p = swoop ? encounterPoint(ctx, { minR: 40, maxR: 160 }, 0.9) : null;
        const h = b.heading + rand(-0.8, 0.8);
        b.tx = p ? p.x : b.x + fwdX(h) * 300;
        b.tz = p ? p.z : b.z + fwdZ(h) * 300;
        if (swoop) b.altTarget = rand(14, 24);
      }
    } else {
      const want = headingTo(b.tx - b.x, b.tz - b.z);
      const close = distXZ(b.x, b.z, b.tx, b.tz) < 25;
      b.heading = close ? b.heading + b.dir * 0.25 * dt : approachAngle(b.heading, want, 0.5, dt);
      nx = b.x + fwdX(b.heading) * b.speed * dt;
      nz = b.z + fwdZ(b.heading) * b.speed * dt;
      if (b.t > b.dur) {
        b.mode = 'soar';
        b.t = 0;
        b.dur = rand(18, 40);
        b.r = rand(28, 70);
        b.ang = rand(0, TAU);
        b.cx = nx - Math.cos(b.ang) * b.r;
        b.cz = nz - Math.sin(b.ang) * b.r;
        b.altTarget = rand(55, 140);
      }
    }
    const vx = (nx - b.x) / Math.max(dt, 1e-4), vz = (nz - b.z) / Math.max(dt, 1e-4);
    if (Math.hypot(vx, vz) > 0.1) b.heading = headingTo(vx, vz);
    b.turn = dt > 0 ? approach(b.turn, wrap(b.heading - prevHeading) / dt, 3, dt) : b.turn;
    b.x = nx;
    b.z = nz;
    if (Math.random() < dt / 25 && b.mode === 'soar') b.altTarget = rand(45, 145);
    b.alt = approach(b.alt, b.altTarget, b.mode === 'swoop' ? 0.35 : 0.08, dt);
    b.y = b.alt + Math.sin(ctx.time * 0.3 + b.phase) * 1.5;
    if (distXZ(b.x, b.z, ctx.focus.x, ctx.focus.z) > 1300) return false;

    // Rare slow wingbeats; otherwise wings held in the crooked "M".
    b.flapT += dt;
    if (b.flapT > 0 && b.flapT > 2.6) b.flapT = -rand(8, 30);
    const env = b.flapT > 0 ? smooth(0, 0.3, b.flapT) * (1 - smooth(2.2, 2.6, b.flapT)) : 0;
    const ph = b.flapT * 1.35 * TAU;
    const p = this.pose;
    p.x = b.x;
    p.y = b.y;
    p.z = b.z;
    p.heading = b.heading;
    p.pitch = b.mode === 'swoop' && b.alt > b.altTarget + 3 ? -0.25 : 0.06;
    p.roll = bankFor(b.speed, b.turn) * 1.5 + Math.sin(ctx.time * 0.8 + b.phase) * 0.05;
    p.scale = b.scale * readable(ctx, b.x, b.y, b.z, BIRD_GAIN);
    p.flap = 0.16 + env * 0.45 * Math.sin(ph) + Math.sin(ctx.time * 1.7 + b.phase) * 0.02;
    p.hand = -0.42 - env * 0.3 * Math.sin(ph - 0.8);
    p.fold = b.mode === 'swoop' && b.alt > b.altTarget + 3 ? 0.35 : 0.05;
    p.variant = b.variant;
    p.tail = 0.12 + 0.12 * Math.sin(ctx.time * 0.6 + b.phase) + Math.abs(b.turn) * 0.8;
    this.mesh.push(p);
    ctx.sight('frigate', b.x, b.y, b.z, 230);
    return true;
  }
}

// ---------------------------------------------------------------- gulls

interface Gull {
  mode: 'fly' | 'hover' | 'sit' | 'land';
  t: number;
  dur: number;
  x: number;
  y: number;
  z: number;
  heading: number;
  speed: number;
  turn: number;
  alt: number;
  homeX: number;
  homeZ: number;
  tx: number;
  tz: number;
  flapT: number;
  phase: number;
  variant: number;
  scale: number;
}

const GULL_HZ = 2.8;

/** A few Heermann's and yellow-footed gulls loafing along the beach. */
export class Gulls implements Species {
  readonly name = 'gull';
  private birds: Gull[] = [];
  private timer = 0;
  private pose: Pose = newPose();
  private mesh: CreatureMesh;

  constructor(mesh: CreatureMesh) {
    this.mesh = mesh;
  }

  get active() {
    return this.birds.length;
  }

  clear() {
    this.birds.length = 0;
    this.timer = 0;
  }

  spawnAt(ctx: Ctx, x: number, z: number) {
    this.birds.push(this.newGull(ctx, x, z));
  }

  private newGull(ctx: Ctx, x: number, z: number): Gull {
    const alt = rand(5, 14);
    return {
      mode: 'fly',
      t: 0,
      dur: rand(4, 8),
      x,
      y: ctx.surface(x, z) + alt,
      z,
      heading: rand(0, TAU),
      speed: rand(7, 9),
      turn: 0,
      alt,
      homeX: x,
      homeZ: z,
      tx: x,
      tz: z,
      flapT: 0,
      phase: rand(0, TAU),
      variant: Math.random() < 0.3 ? 1 : 0,
      scale: rand(0.9, 1.1),
    };
  }

  update(ctx: Ctx, dt: number) {
    const near = ctx.data.sdf(ctx.focus.x, ctx.focus.z) > -650;
    this.timer -= dt;
    if (near && this.birds.length < 5 && this.timer <= 0) {
      this.timer = rand(2, 7);
      const p = seaPoint(ctx, { minR: 60, maxR: 450, maxSdf: -20, minSdf: -170 });
      if (p) {
        for (let k = randInt(1, 2); k > 0 && this.birds.length < 6; k--) this.birds.push(this.newGull(ctx, p.x + rand(-15, 15), p.z + rand(-15, 15)));
      }
    }
    this.mesh.begin();
    for (let i = this.birds.length - 1; i >= 0; i--) {
      if (!this.updateGull(ctx, this.birds[i], dt)) this.birds.splice(i, 1);
    }
    this.mesh.end();
  }

  private updateGull(ctx: Ctx, g: Gull, dt: number) {
    g.t += dt;
    const sea = ctx.surface(g.x, g.z);
    let flap = 0.05, hand = -0.1, fold = 0, pitch = 0.04;
    if (g.mode === 'fly' || g.mode === 'land') {
      if (g.t > g.dur && g.mode === 'fly') {
        g.t = 0;
        const r = Math.random();
        if (r < 0.2 && Math.abs(wrap(g.heading - ctx.windFrom)) < 1.2) {
          g.mode = 'hover';
          g.dur = rand(2, 5);
        } else if (r < 0.35) {
          g.mode = 'land';
          g.dur = 6;
        } else {
          g.dur = rand(4, 8);
          const a = rand(0, TAU), rr = rand(10, 90);
          g.tx = g.homeX + Math.cos(a) * rr;
          g.tz = g.homeZ + Math.sin(a) * rr;
          g.alt = rand(3, 15);
        }
      }
      const want = headingTo(g.tx - g.x, g.tz - g.z);
      const turn = Math.max(-1.1, Math.min(1.1, wrap(want - g.heading) * 1.2));
      g.turn = approach(g.turn, turn, 2, dt);
      g.heading = wrap(g.heading + g.turn * dt);
      g.x += fwdX(g.heading) * g.speed * dt;
      g.z += fwdZ(g.heading) * g.speed * dt;
      const alt = g.mode === 'land' ? 0.6 : g.alt;
      g.y = approach(g.y, sea + alt, g.mode === 'land' ? 0.9 : 0.5, dt);
      if (g.mode === 'land' && g.y < sea + 0.9) {
        g.mode = 'sit';
        g.t = 0;
        g.dur = rand(5, 14);
      }
      g.flapT -= dt;
      if (g.flapT < -rand(0.8, 2.5)) g.flapT = randInt(3, 7) / GULL_HZ;
      const env = g.flapT > 0 ? smooth(0, 0.12, g.flapT) : 0;
      const ph = g.flapT * GULL_HZ * TAU;
      flap = 0.06 + env * (0.12 + 0.55 * Math.sin(ph));
      hand = -0.12 - env * 0.35 * Math.sin(ph - 0.8);
    } else if (g.mode === 'hover') {
      // Hanging on the wind: nearly still over the ground, quick shallow beats.
      g.heading = approachAngle(g.heading, ctx.windFrom, 2, dt);
      g.x += fwdX(g.heading) * 0.4 * dt;
      g.z += fwdZ(g.heading) * 0.4 * dt;
      g.y = approach(g.y, sea + g.alt + Math.sin(g.t * 2.3) * 0.4, 1, dt);
      const ph = g.t * 4.2 * TAU;
      flap = 0.2 + 0.18 * Math.sin(ph);
      hand = -0.25 - 0.1 * Math.sin(ph - 0.6);
      pitch = 0.25;
      g.turn = 0;
      if (g.t > g.dur) {
        g.mode = 'fly';
        g.t = 0;
        g.dur = rand(3, 6);
      }
    } else {
      fold = 1;
      flap = 0;
      hand = 0;
      g.turn = 0;
      g.heading = approachAngle(g.heading, ctx.windFrom, 0.3, dt);
      g.y = sea + 0.02;
      g.x += ctx.windX * 0.04 * dt;
      g.z += ctx.windZ * 0.04 * dt;
      pitch = Math.sin(g.t * 1.9 + g.phase) * 0.06 + 0.05;
      if (g.t > g.dur) {
        g.mode = 'fly';
        g.t = 0;
        g.dur = rand(3, 6);
        g.alt = rand(4, 12);
        g.heading = ctx.windFrom;
      }
    }
    if (distXZ(g.x, g.z, ctx.focus.x, ctx.focus.z) > 900) return false;
    const p = this.pose;
    p.x = g.x;
    p.y = g.y;
    p.z = g.z;
    p.heading = g.heading;
    p.pitch = pitch;
    p.roll = bankFor(g.speed, g.turn) * (g.mode === 'sit' ? 0 : 1) + (g.mode === 'sit' ? Math.sin(g.t * 1.4) * 0.05 : 0);
    p.scale = g.scale * readable(ctx, g.x, g.y, g.z, BIRD_GAIN);
    p.flap = flap;
    p.hand = hand;
    p.fold = fold;
    p.variant = g.variant;
    this.mesh.push(p);
    return true;
  }
}

// ---------------------------------------------------------------- osprey

type OspreyState = 'patrol' | 'hover' | 'stoop' | 'strike' | 'lift' | 'leave';

interface Osprey {
  state: OspreyState;
  t: number;
  dur: number;
  x: number;
  y: number;
  z: number;
  heading: number;
  speed: number;
  vy: number;
  turn: number;
  flapT: number;
  limb: number;
  carry: number;
  pitch: number;
  fold: number;
  hovers: number;
  homeX: number;
  homeZ: number;
}

/** An osprey working the shallows: patrol, hover into the wind, stoop and hit feet first. */
export class Ospreys implements Species {
  readonly name = 'osprey';
  private birds: Osprey[] = [];
  private timer = 20;
  private pose: Pose = newPose();
  private mesh: CreatureMesh;

  constructor(mesh: CreatureMesh) {
    this.mesh = mesh;
  }

  get active() {
    return this.birds.length;
  }

  clear() {
    this.birds.length = 0;
    this.timer = rand(10, 30);
  }

  spawnAt(ctx: Ctx, x: number, z: number, action?: string) {
    const o = this.newBird(ctx, x, z);
    if (action === 'hover') {
      o.state = 'hover';
      o.dur = rand(2.5, 4);
      o.hovers = 3;
    }
    this.birds.push(o);
  }

  private newBird(ctx: Ctx, x: number, z: number): Osprey {
    return {
      state: 'patrol',
      t: 0,
      dur: rand(4, 9),
      x,
      y: ctx.surface(x, z) + rand(20, 28),
      z,
      heading: Math.random() < 0.5 ? 0 : Math.PI,
      speed: 8,
      vy: 0,
      turn: 0,
      flapT: 0,
      limb: 0,
      carry: 0,
      pitch: 0,
      fold: 0,
      hovers: 0,
      homeX: x,
      homeZ: z,
    };
  }

  update(ctx: Ctx, dt: number) {
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = arrival(75);
      if (this.birds.length === 0 && ctx.data.sdf(ctx.focus.x, ctx.focus.z) > -800) {
        const p = encounterPoint(ctx, { minR: 150, maxR: 480, maxSdf: -15, minSdf: -260 }, 0.8);
        if (p && ctx.data.depth(p.x, p.z) < 7) this.birds.push(this.newBird(ctx, p.x, p.z));
      }
    }
    this.mesh.begin();
    for (let i = this.birds.length - 1; i >= 0; i--) {
      if (!this.updateBird(ctx, this.birds[i], dt)) this.birds.splice(i, 1);
    }
    this.mesh.end();
  }

  private updateBird(ctx: Ctx, o: Osprey, dt: number) {
    o.t += dt;
    const sea = ctx.surface(o.x, o.z);
    let flap = 0.08, hand = -0.25, roll = 0;
    const beat = (hz: number, amp: number) => {
      const ph = o.t * hz * TAU;
      flap = 0.15 + amp * Math.sin(ph);
      hand = -0.2 - amp * 0.5 * Math.sin(ph - 0.7);
    };
    switch (o.state) {
      case 'patrol': {
        // Flap-flap-glide along the shallows, keeping near the home spot.
        const want = headingTo(o.homeX - o.x, o.homeZ - o.z);
        const far = distXZ(o.x, o.z, o.homeX, o.homeZ) > 90;
        o.turn = approach(o.turn, far ? Math.max(-0.5, Math.min(0.5, wrap(want - o.heading))) : 0.05, 1, dt);
        o.heading = wrap(o.heading + o.turn * dt);
        o.speed = approach(o.speed, 8.5, 1, dt);
        o.x += fwdX(o.heading) * o.speed * dt;
        o.z += fwdZ(o.heading) * o.speed * dt;
        o.y = approach(o.y, sea + 24, 0.4, dt);
        o.flapT -= dt;
        if (o.flapT < -rand(1.5, 3)) o.flapT = randInt(4, 7) / 2.4;
        if (o.flapT > 0) beat(2.4, 0.55);
        else {
          flap = 0.12;
          hand = -0.35;
        }
        o.pitch = 0.03;
        o.limb = approach(o.limb, 0, 2, dt);
        roll = bankFor(o.speed, o.turn);
        if (o.t > o.dur) {
          o.state = 'hover';
          o.t = 0;
          o.dur = rand(2.5, 5);
        }
        break;
      }
      case 'hover': {
        o.heading = approachAngle(o.heading, ctx.windFrom, 1.5, dt);
        o.speed = approach(o.speed, 0, 1.5, dt);
        o.x += fwdX(o.heading) * o.speed * dt;
        o.z += fwdZ(o.heading) * o.speed * dt;
        o.y = approach(o.y, sea + 20 + Math.sin(o.t * 1.7) * 0.6, 0.8, dt);
        beat(3.3, 0.48);
        o.pitch = approach(o.pitch, 0.45, 2, dt);
        o.limb = approach(o.limb, -0.5, 2, dt);
        if (o.t > o.dur) {
          o.hovers++;
          o.t = 0;
          if (Math.random() < 0.65 || o.hovers >= 3) {
            o.state = 'stoop';
            o.vy = 0;
            o.speed = 3;
          } else {
            o.state = 'patrol';
            o.dur = rand(3, 6);
          }
        }
        break;
      }
      case 'stoop': {
        const h = o.y - sea;
        o.vy -= G * 0.95 * dt;
        o.y += o.vy * dt;
        o.x += fwdX(o.heading) * o.speed * dt;
        o.z += fwdZ(o.heading) * o.speed * dt;
        const late = smooth(4, 1.2, h);
        // Head first, then swing the feet forward and throw the wings up at the last moment.
        o.pitch = approach(o.pitch, -1.0 + late * 1.45, 6, dt);
        o.fold = approach(o.fold, 0.55 * (1 - late), 7, dt);
        o.limb = approach(o.limb, -0.5 - late * 2.0, 8, dt);
        flap = 0.1 + late * 0.9;
        hand = -0.2 + late * 0.4;
        if (h <= 0.25) {
          ctx.fx.splash(o.x, o.z, { power: 4.2, count: 24, size: 0.18, foam: 1.2, mist: 2 });
          ctx.emit({ kind: 'splash', species: 'osprey', x: o.x, y: sea, z: o.z, strength: 0.3 });
          o.state = 'strike';
          o.t = 0;
        }
        break;
      }
      case 'strike':
        o.y = sea - 0.12;
        o.pitch = approach(o.pitch, 0.25, 4, dt);
        o.fold = approach(o.fold, 0, 6, dt);
        flap = 0.85;
        hand = 0.1;
        o.limb = -1.0;
        if (o.t > 0.9) {
          o.state = 'lift';
          o.t = 0;
          o.carry = Math.random() < 0.75 ? 1 : 0;
          o.heading = ctx.windFrom + rand(-0.5, 0.5);
          o.speed = 1.5;
        }
        break;
      case 'lift': {
        beat(2.7, 0.75);
        o.speed = approach(o.speed, 7, 0.8, dt);
        o.x += fwdX(o.heading) * o.speed * dt;
        o.z += fwdZ(o.heading) * o.speed * dt;
        o.y += (o.t < 0.4 ? 0.6 : 1.8) * dt;
        o.pitch = approach(o.pitch, 0.2, 3, dt);
        o.limb = approach(o.limb, -0.25, 2, dt);
        if (o.t < 0.8 && Math.random() < 0.5) ctx.fx.drips(o.x, o.y - 0.1, o.z, 1, 0.5);
        // The famous mid-air shake that sheds the water.
        if (o.t > 1.6 && o.t < 2.1) {
          roll = Math.sin((o.t - 1.6) * 38) * 0.45;
          if (Math.random() < 0.6) ctx.fx.drips(o.x, o.y, o.z, 2, 0.9);
        }
        if (o.t > 2.8) {
          o.state = 'leave';
          o.t = 0;
          const coast = ctx.data.coastX(o.z);
          o.heading = coast !== null && coast < o.x ? -Math.PI / 2 + rand(-0.6, 0.6) : rand(0, TAU);
        }
        break;
      }
      case 'leave': {
        o.flapT -= dt;
        if (o.flapT < -rand(1, 2)) o.flapT = randInt(4, 6) / 2.4;
        if (o.flapT > 0) beat(2.4, 0.55);
        o.speed = approach(o.speed, 9, 0.6, dt);
        o.x += fwdX(o.heading) * o.speed * dt;
        o.z += fwdZ(o.heading) * o.speed * dt;
        o.y = approach(o.y, Math.max(sea, 0) + 26, 0.3, dt);
        o.pitch = 0.06;
        if (o.t > 40 || distXZ(o.x, o.z, ctx.focus.x, ctx.focus.z) > 900) return false;
        break;
      }
    }
    if (distXZ(o.x, o.z, ctx.focus.x, ctx.focus.z) > 1300) return false;
    const p = this.pose;
    p.x = o.x;
    p.y = o.y;
    p.z = o.z;
    p.heading = o.heading;
    p.pitch = o.pitch;
    p.roll = roll;
    p.scale = readable(ctx, o.x, o.y, o.z, BIRD_GAIN);
    p.flap = flap;
    p.hand = hand;
    p.fold = o.fold;
    p.limb = o.limb;
    p.carry = o.carry;
    p.variant = 0;
    this.mesh.push(p);
    ctx.sight('osprey', o.x, o.y, o.z, 150);
    return true;
  }
}
