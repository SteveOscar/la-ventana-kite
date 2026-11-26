import type { Game, Mode } from '../game/game.ts';
import { RACE_INTRO } from '../content/culture.ts';
import { Buoy, Panga } from '../render/markers.ts';
import { Kiter } from '../game/kiter.ts';
import { RIDER_LOOKS } from '../render/riderModel.ts';
import { KITE_PALETTES } from '../render/kiteModel.ts';
import { RiderEffects } from '../render/effects.ts';
import { assistCarve } from '../sim/autopilot.ts';
import { DEG, carveToward, clamp, headingOf, wrapAngle } from '../core/math.ts';
import { NO_INPUT, type Rig } from '../sim/rig.ts';
import { formatTime, recommendedKite } from '../ui/menu.ts';

interface Racer {
  name: string;
  kiter: Kiter | null;
  fx: RiderEffects | null;
  leg: number;
  tack: 1 | -1;
  finishTime: number | null;
  skill: number;
  turn: { dir: number };
}

const NAMES = ['Jesús "Chuy Jr."', 'Valeria', 'Ana (Vancouver)', 'Mateo', 'Big Dave (Hood River)'];

/** La Ventana Classic: two laps, upwind and downwind marks, five other racers. */
export class Race implements Mode {
  readonly id = 'race' as const;
  private marks: Buoy[] = [];
  /** Course: indices into marks; the last entry is the finish (start line). */
  private course: number[] = [];
  private racers: Racer[] = [];
  private countdown = 12;
  private time = 0;
  private done = false;
  private startLine = { x: 0, z: 0 };
  /** Committee boat anchored at the outer end of the start line. */
  private committee = new Panga(0xc1121f);

  start(game: Game) {
    const d = game.world.data;
    const z0 = -420;
    const c0 = d.coastX(z0) ?? 100;
    this.startLine = { x: c0 + 330, z: z0 };
    const upZ = z0 - 430, downZ = z0 + 300;
    const up = new Buoy((d.coastX(upZ) ?? c0) + 420, upZ, 0xffd166, 'A');
    const down = new Buoy((d.coastX(downZ) ?? c0) + 380, downZ, 0xff7a1a, 'B');
    const line = new Buoy(this.startLine.x, this.startLine.z, 0x2ec4b6, '★');
    this.marks = [up, down, line];
    for (const m of this.marks) game.world.scene.add(m.group);
    game.world.scene.add(this.committee.group);
    this.course = [0, 1, 0, 2];
    game.spawnPlayer(this.startLine.x - 25, this.startLine.z + 15, -1);
    game.player.autoStart = false;
    const size = recommendedKite(game.world.wind.settings.knots);
    this.racers = [{ name: 'Tú · You', kiter: null, fx: null, leg: 0, tack: 1, finishTime: null, skill: 1, turn: { dir: 0 } }];
    NAMES.forEach((name, i) => {
      const k = new Kiter(size, RIDER_LOOKS[(i + 2) % RIDER_LOOKS.length], KITE_PALETTES[(i + 3) % KITE_PALETTES.length], 0x333333);
      const fx = new RiderEffects();
      game.world.scene.add(k.group, fx.wake.mesh);
      const x = this.startLine.x - 60 + i * 28, z = this.startLine.z + 20 + (i % 2) * 18;
      k.rig.spawn(x, z, headingOf(-game.world.wind.downwindZ, game.world.wind.downwindX), game.world.env);
      this.racers.push({ name, kiter: k, fx, leg: 0, tack: 1, finishTime: null, skill: 0.55 + i * 0.09, turn: { dir: 0 } });
    });
    game.hud.say(RACE_INTRO);
  }

  private rigOf(game: Game, r: Racer): Rig {
    return r.kiter ? r.kiter.rig : game.rig;
  }

  update(game: Game, dt: number) {
    const w = game.world;
    for (const m of this.marks) m.update(game.time, (x, z) => w.surface(x, z), w.wind.downwindX, w.wind.downwindZ);
    // Anchored boats swing to face the wind.
    const cx = this.startLine.x + 45, cz = this.startLine.z - 8;
    this.committee.place(cx, w.surface(cx, cz) - 0.15, cz, w.downwindHeading + Math.PI, 0, game.time);
    if (this.countdown > 0) {
      const before = Math.ceil(this.countdown);
      this.countdown -= dt;
      const now = Math.ceil(this.countdown);
      if (now !== before && now <= 5 && now > 0) {
        game.hud.showToast(`${now}…`, 0.9);
        game.audio.event('ui');
      }
      if (this.countdown <= 0) {
        game.hud.showToast('¡Arranca! GO!', 2);
        game.audio.event('checkpoint');
        game.player.autoStart = true;
      }
    } else if (!this.done) this.time += dt;

    for (const r of this.racers) {
      const rig = this.rigOf(game, r);
      if (r.kiter) this.driveAi(game, r, dt);
      if (this.countdown > 0 || r.finishTime !== null) continue;
      const mark = this.marks[this.course[r.leg]];
      const d = Math.hypot(rig.pos.x - mark.x, rig.pos.z - mark.z);
      if (d < (r.leg === this.course.length - 1 ? 55 : 38)) {
        r.leg++;
        if (!r.kiter) game.audio.event('checkpoint');
        if (r.leg >= this.course.length) {
          r.finishTime = this.time;
          if (!r.kiter) this.finish(game);
        } else if (!r.kiter) game.hud.showToast(`✓ Mark ${r.leg}/${this.course.length - 1}`, 2);
      }
    }
    this.render(game);
  }

  /** Simple racing brain: head for the mark, tacking upwind when it's in the no-go zone. */
  private driveAi(game: Game, r: Racer, dt: number) {
    const k = r.kiter!;
    const rig = k.rig;
    const w = game.world;
    const down = w.downwindHeading;
    let carve = 0;
    let bearAway = false;
    if (this.countdown <= 0 && r.finishTime === null) {
      const mark = this.marks[this.course[Math.min(r.leg, this.course.length - 1)]];
      const toMark = headingOf(mark.x - rig.pos.x, mark.z - rig.pos.z);
      const fromWind = wrapAngle(toMark - (down + Math.PI));
      const limit = (44 + (1 - r.skill) * 12) * DEG;
      let desired: number;
      if (Math.abs(fromWind) < limit) {
        // Beating: hold a close-hauled course on the current tack; tack on the layline.
        if (Math.abs(fromWind) < limit * 0.35) {
          // keep tack
        } else if (Math.sign(fromWind) !== r.tack) r.tack = Math.sign(fromWind) as 1 | -1;
        desired = down + Math.PI + r.tack * limit;
      } else desired = toMark;
      // Nobody waterstarts pointing upwind: get going on a beam reach first.
      if (rig.mode !== 'riding' || (rig.speed < 6 && rig.modeTime < 8)) desired = down + Math.PI + r.tack * 95 * DEG;
      carve = rig.mode === 'riding' ? carveToward(rig.heading, desired, down, r.turn, 1.7) : clamp(wrapAngle(desired - rig.heading) * 1.7, -1, 1);
      bearAway = carve * rig.kiteSide > 0.3;
      carve = assistCarve(rig, carve);
    }
    const intent = {
      power: rig.speed < 6 ? 1 : 0,
      send: false,
      loop: false,
      relaunch: rig.kite.downTime > 2,
      go: this.countdown <= 1.2,
      bearAway,
    };
    k.simulate(dt, { ...NO_INPUT, carve: rig.mode === 'air' ? 0 : carve }, intent, w.env);
    k.updateVisuals(dt);
    const cam = game.cam.camera.position;
    if (Math.hypot(rig.pos.x - cam.x, rig.pos.z - cam.z) < 500) r.fx!.update(dt, rig, w.env, game.spray);
  }

  private progress(game: Game, r: Racer) {
    if (r.finishTime !== null) return 1000 - r.finishTime / 1000;
    const rig = this.rigOf(game, r);
    const mark = this.marks[this.course[r.leg]];
    return r.leg - Math.hypot(rig.pos.x - mark.x, rig.pos.z - mark.z) / 3000;
  }

  private standings(game: Game) {
    return [...this.racers].sort((a, b) => this.progress(game, b) - this.progress(game, a));
  }

  private renderTimer = 0;
  private render(game: Game) {
    this.renderTimer -= 1;
    if (this.renderTimer > 0) return;
    this.renderTimer = 15;
    const st = this.standings(game);
    const rows = st
      .map((r, i) => `<div class="${r.kiter ? '' : 'done'}">${i + 1}. ${r.name}${r.finishTime !== null ? ` · ${formatTime(r.finishTime)}` : ` · ${Math.min(r.leg, this.course.length - 1)}/${this.course.length - 1}`}</div>`)
      .join('');
    const you = this.racers[0];
    const nextLabel = you.leg < this.course.length - 1 ? `Next: mark ${['A', 'B', 'A'][you.leg] ?? ''}` : 'Next: finish ★';
    game.hud.setObjective(
      `<h3>La Ventana Classic · ${this.countdown > 0 ? `start in ${Math.ceil(this.countdown)}` : formatTime(this.time)}</h3>${nextLabel}<br><br>${rows}`,
    );
  }

  private finish(game: Game) {
    this.done = true;
    const place = this.standings(game).indexOf(this.racers[0]) + 1;
    const best = game.logbook.data.raceBest;
    if (best === null || place < best) {
      game.logbook.data.raceBest = place;
      game.logbook.save();
    }
    game.audio.event('cheer');
    const raised = Math.round(2500 + (7 - place) * 900 + game.scoring.score * 0.1);
    game.hud.say([
      {
        who: 'rafa',
        es: place === 1 ? '¡Campeón del Classic!' : `¡Lugar ${place}! Bien hecho.`,
        en: `${place === 1 ? 'Champion of the Classic!' : `Place ${place}. Nicely sailed.`} Your heat helped raise ${raised.toLocaleString()} pesos for the village schools.`,
      },
    ]);
    setTimeout(() => {
      if (game.mode !== this) return;
      game.endSession('finished', {
        title: place === 1 ? '¡Ganaste el Classic!' : `Lugar ${place} · La Ventana Classic`,
        lines: [
          { label: 'Lugar · Place', value: `${place} / ${this.racers.length}` },
          { label: 'Tiempo · Time', value: formatTime(this.time) },
          { label: 'Mejor · Best place', value: String(game.logbook.data.raceBest ?? place) },
          { label: 'Para las escuelas', value: `$${raised.toLocaleString()} MXN` },
          { label: 'Distancia', value: `${(game.stats.distance / 1000).toFixed(1)} km` },
          { label: 'Vel. máx · Top speed', value: `${(game.stats.topSpeed / 0.5144).toFixed(1)} kn` },
        ],
        note: 'The real La Ventana Classic has raised money for the schools of La Ventana and El Sargento for years. Upwind legs win races: point high, keep your speed.',
      });
    }, 5000);
  }

  waypoint() {
    const you = this.racers[0];
    if (you.finishTime !== null) return null;
    const i = this.course[Math.min(you.leg, this.course.length - 1)];
    const m = this.marks[i];
    return { x: m.x, z: m.z, label: i === 2 ? 'Meta ★' : `Boya ${['A', 'B'][i]}` };
  }

  markers() {
    const you = this.racers[0];
    return this.marks.map((m, i) => ({
      x: m.x,
      z: m.z,
      color: this.course[Math.min(you.leg, this.course.length - 1)] === i ? '#ffd166' : '#ff7a1a',
      label: ['A', 'B', '★'][i],
    }));
  }

  dispose(game: Game) {
    for (const m of this.marks) game.world.scene.remove(m.group);
    game.world.scene.remove(this.committee.group);
    for (const r of this.racers) {
      if (r.kiter) game.world.scene.remove(r.kiter.group);
      if (r.fx) game.world.scene.remove(r.fx.wake.mesh);
    }
    game.player.autoStart = true;
  }
}
