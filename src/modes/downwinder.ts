import type { Game, Mode } from '../game/game.ts';
import { DOWNWINDER_INTRO } from '../content/culture.ts';
import { Buoy, Panga } from '../render/markers.ts';
import { damp, dampAngle, headingOf } from '../core/math.ts';
import { formatTime } from '../ui/menu.ts';

interface Gate {
  name: string;
  buoy: Buoy;
  passed: boolean;
  missed: boolean;
}

/** From the Hot Springs to La Ventana with Don Chuy's panga as safety boat. */
export class Downwinder implements Mode {
  readonly id = 'downwinder' as const;
  private gates: Gate[] = [];
  private next = 0;
  private time = 0;
  private started = false;
  private finished = false;
  private panga = new Panga(0x1f7fc4);
  private pangaPos = { x: 0, z: 0, heading: Math.PI, speed: 0 };
  private warnTimer = 0;

  start(game: Game) {
    const d = game.world.data;
    const lm = d.world.landmarks;
    const startZ = lm.hotSprings.z - 150;
    game.spawnPlayer((d.coastX(startZ) ?? 0) + 160, startZ, -1);
    const route: [string, number, number][] = [
      ['El Sargento norte', -4700, 240],
      ['Las pangas', -3450, 260],
      ['El Sargento sur', -2300, 240],
      ['El campamento', -900, 220],
      ['Meta · La Ventana', lm.mainBeach.z, 170],
    ];
    this.gates = route.map(([name, z, off], i) => {
      const buoy = new Buoy((d.coastX(z) ?? 0) + off, z, i === route.length - 1 ? 0xffd166 : 0xff7a1a, i === route.length - 1 ? 'META' : String(i + 1));
      game.world.scene.add(buoy.group);
      return { name, buoy, passed: false, missed: false };
    });
    this.pangaPos = { x: game.rig.pos.x + 40, z: game.rig.pos.z - 30, heading: Math.PI, speed: 0 };
    game.world.scene.add(this.panga.group);
    game.hud.say(DOWNWINDER_INTRO);
    this.render(game);
  }

  update(game: Game, dt: number) {
    const rig = game.rig;
    const w = game.world;
    for (const g of this.gates) g.buoy.update(game.time, (x, z) => w.surface(x, z), w.wind.downwindX, w.wind.downwindZ);
    if (!this.started && rig.mode === 'riding') this.started = true;
    if (this.started && !this.finished) this.time += dt;

    // Gates must be taken in order; sailing well past one counts as a miss (+30 s).
    const gate = this.gates[this.next];
    if (gate && !this.finished) {
      const d = Math.hypot(rig.pos.x - gate.buoy.x, rig.pos.z - gate.buoy.z);
      if (d < 70) {
        gate.passed = true;
        this.advance(game, `✓ ${gate.name}`);
      } else if (rig.pos.z > gate.buoy.z + 260) {
        gate.missed = true;
        this.time += 30;
        this.advance(game, `✗ Missed ${gate.name} (+30 s)`);
      }
    }

    // Don Chuy holds station upwind and a little behind, like a good safety boat.
    const p = this.pangaPos;
    const tx = rig.pos.x + 45 - w.wind.downwindX * 35, tz = rig.pos.z - w.wind.downwindZ * 35;
    const dx = tx - p.x, dz = tz - p.z;
    const dist = Math.hypot(dx, dz);
    const want = Math.min(11, dist * 0.35);
    p.speed = damp(p.speed, want, 0.8, dt);
    if (dist > 1) p.heading = dampAngle(p.heading, headingOf(dx, dz), 1.2, dt);
    p.x += Math.sin(p.heading) * p.speed * dt;
    p.z += -Math.cos(p.heading) * p.speed * dt;
    this.panga.place(p.x, w.surface(p.x, p.z) - 0.15, p.z, p.heading, p.speed, game.time);

    const off = rig.pos.x - (w.data.coastX(rig.pos.z) ?? 0);
    this.warnTimer -= dt;
    if (off > 2200 && this.warnTimer <= 0) {
      this.warnTimer = 20;
      game.hud.say([{ who: 'chuy', es: '¡Oye! No te vayas tan lejos.', en: 'Hey! Don\'t go out so far: the channel gets rough and I want my lunch.' }]);
    }
    if (Math.floor(this.time * 2) !== Math.floor((this.time - dt) * 2)) this.render(game);
  }

  private advance(game: Game, msg: string) {
    game.hud.showToast(msg, 2.5);
    game.audio.event('checkpoint');
    this.next++;
    if (this.next >= this.gates.length) {
      this.finished = true;
      const missed = this.gates.filter((g) => g.missed).length;
      const best = game.logbook.data.downwinderBest;
      const isBest = best === null || this.time < best;
      if (isBest) {
        game.logbook.data.downwinderBest = this.time;
        game.logbook.save();
      }
      game.logbook.addLandmark('hotSprings');
      game.audio.event('cheer');
      game.hud.say([{ who: 'chuy', es: '¡Llegamos! Buen downwinder.', en: `We made it! ${formatTime(this.time)}${isBest ? ', your best yet' : ''}. Lupe has the tacos ready.` }]);
      setTimeout(() => {
        if (game.mode === this)
          game.endSession('finished', {
            title: '¡Downwinder completo!',
            lines: [
              { label: 'Tiempo · Time', value: formatTime(this.time) },
              { label: 'Puertas · Gates', value: `${this.gates.length - missed}/${this.gates.length}` },
              { label: 'Mejor · Best', value: formatTime(game.logbook.data.downwinderBest ?? this.time) },
              { label: 'Puntos · Score', value: Math.round(game.scoring.score).toLocaleString() },
              { label: 'Salto · Best jump', value: `${game.scoring.best.height.toFixed(1)} m` },
              { label: 'Distancia', value: `${(game.stats.distance / 1000).toFixed(1)} km` },
            ],
            note: 'Six miles of beach from El Sargento to La Ventana: the classic Norte downwinder.',
          });
      }, 4500);
    }
    this.render(game);
  }

  private render(game: Game) {
    const rows = this.gates
      .map((g, i) => `<div class="${g.passed ? 'done' : ''}">${g.passed ? '✓' : g.missed ? '✗' : i === this.next ? '➜' : '○'} ${g.name}</div>`)
      .join('');
    game.hud.setObjective(`<h3>Downwinder · ${formatTime(this.time)}</h3>${rows}${this.started ? '' : '<br>Get up and ride south (downwind).'}`);
  }

  waypoint() {
    const g = this.gates[this.next];
    return g ? { x: g.buoy.x, z: g.buoy.z, label: g.name } : null;
  }

  markers() {
    return this.gates
      .map((g, i) => ({ x: g.buoy.x, z: g.buoy.z, color: i === this.next ? '#ffd166' : g.passed ? 'rgba(255,255,255,0.4)' : '#ff7a1a', label: i === this.next ? String(i + 1) : undefined }))
      .concat([{ x: this.pangaPos.x, z: this.pangaPos.z, color: '#1f7fc4', label: undefined }]);
  }

  dispose(game: Game) {
    for (const g of this.gates) game.world.scene.remove(g.buoy.group);
    game.world.scene.remove(this.panga.group);
  }
}
