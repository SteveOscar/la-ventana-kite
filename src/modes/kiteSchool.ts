import type { Game, Mode } from '../game/game.ts';
import type { JumpResult } from '../sim/rig.ts';
import { TUTORIAL } from '../content/culture.ts';
import { Buoy } from '../render/markers.ts';

/** Memo's lesson: wind window, waterstart, riding, staying upwind, transitions, a first jump. */
export class KiteSchool implements Mode {
  readonly id = 'school' as const;
  private step = 0;
  private stepTime = 0;
  private distance = 0;
  private sawPower = false;
  private buoy: Buoy | null = null;
  private startSide = 0;
  private onNewTack = 0;
  private done = false;

  start(game: Game) {
    const lm = game.world.data.world.landmarks;
    // The school beach in front of the northern campground.
    game.spawnPlayer(lm.campNorth.x + 140, lm.campNorth.z, -1);
    game.player.autoStart = false;
    this.step = -1;
    this.next(game);
  }

  private next(game: Game) {
    this.step++;
    this.stepTime = 0;
    const s = TUTORIAL[this.step];
    if (!s) {
      this.finish(game);
      return;
    }
    game.hud.clearDialog();
    game.hud.say(s.lines);
    game.hud.setObjective(`<h3>Lección ${this.step + 1}/${TUTORIAL.length}</h3><b>${s.title}</b><br>${s.hint}`);
    game.audio.event('checkpoint');
    if (s.id === 'upwind') {
      const r = game.rig.pos;
      const coast = game.world.data.coastX(r.z - 260) ?? 0;
      this.buoy = new Buoy(Math.max(coast + 180, r.x), r.z - 260, 0xff7a1a);
      game.world.scene.add(this.buoy.group);
    }
    if (s.id === 'transition') this.startSide = game.rig.kiteSide;
    if (s.id === 'ride') this.distance = 0;
  }

  update(game: Game, dt: number) {
    const rig = game.rig;
    this.stepTime += dt;
    const w = game.world;
    this.buoy?.update(game.time, (x, z) => w.surface(x, z), w.wind.downwindX, w.wind.downwindZ);
    if (this.done) return;
    const id = TUTORIAL[this.step]?.id;
    switch (id) {
      case 'window':
        // Lesson 1 is about seeing the window: dive the kite and feel the power zone.
        if (rig.kite.depth > 0.12 || rig.kite.tension > rig.mass * 9.81 * 0.55 || rig.mode === 'riding') this.sawPower = true;
        if (this.sawPower && this.stepTime > 2.5) this.next(game);
        break;
      case 'waterstart':
        if (rig.mode === 'riding' && rig.modeTime > 1.5) this.next(game);
        break;
      case 'ride':
        if (rig.mode === 'riding') this.distance += rig.speed * dt;
        game.hud.setObjective(`<h3>Lección 3/${TUTORIAL.length}</h3><b>${TUTORIAL[2].title}</b><br>${TUTORIAL[2].hint}<br><br>${Math.min(300, this.distance).toFixed(0)} / 300 m`);
        if (this.distance >= 300) this.next(game);
        break;
      case 'upwind': {
        if (!this.buoy) break;
        const d = Math.hypot(rig.pos.x - this.buoy.x, rig.pos.z - this.buoy.z);
        game.hud.setObjective(`<h3>Lección 4/${TUTORIAL.length}</h3><b>${TUTORIAL[3].title}</b><br>${TUTORIAL[3].hint}<br><br>Buoy: ${d.toFixed(0)} m`);
        if (d < 40) {
          game.world.scene.remove(this.buoy.group);
          this.buoy = null;
          this.next(game);
        }
        break;
      }
      case 'transition':
        if (rig.mode === 'riding' && rig.kiteSide !== this.startSide && rig.kite.u.y < 0.8) this.onNewTack += dt;
        else this.onNewTack = 0;
        if (rig.mode !== 'riding') this.startSide = this.startSide || rig.kiteSide;
        if (this.onNewTack > 3) this.next(game);
        break;
    }
  }

  onLand(game: Game, j: JumpResult) {
    if (TUTORIAL[this.step]?.id === 'jump' && j.quality !== 'crash' && j.height >= 1.5) this.next(game);
  }

  private finish(game: Game) {
    this.done = true;
    game.hud.setObjective(`<h3>¡Felicidades!</h3>You passed Memo's kite school. Keep riding, or end the session from the pause menu.`);
    game.hud.say([
      { who: 'memo', es: '¡Ya eres kiter! Bienvenido a La Ventana.', en: 'You\'re a kiter now! Welcome to La Ventana. Go explore: try the downwinder with Don Chuy.' },
    ]);
    game.logbook.data.schoolDone = true;
    game.logbook.save();
    game.audio.event('cheer');
  }

  dispose(game: Game) {
    if (this.buoy) game.world.scene.remove(this.buoy.group);
    game.player.autoStart = true;
  }

  markers() {
    return this.buoy ? [{ x: this.buoy.x, z: this.buoy.z, color: '#ff7a1a', label: 'Boya' }] : [];
  }
}
