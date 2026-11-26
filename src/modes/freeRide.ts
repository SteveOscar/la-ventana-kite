import type { Game, Mode } from '../game/game.ts';
import { FREE_INTRO } from '../content/culture.ts';

interface Challenge {
  id: string;
  label: string;
  done: boolean;
}

/** Free session: ride where you like; a short list of challenges for structure. */
export class FreeRide implements Mode {
  readonly id = 'free' as const;
  private challenges: Challenge[] = [];
  private refresh = 0;
  private northMost = 0;
  private startZ = 0;

  start(game: Game) {
    const lm = game.world.data.world.landmarks;
    game.spawnPlayer(lm.mainBeach.x + 180, lm.mainBeach.z - 400, -1);
    this.startZ = game.rig.pos.z;
    this.northMost = this.startZ;
    this.challenges = [
      { id: 'ride', label: 'Get up and ride 500 m', done: false },
      { id: 'upwind', label: 'Work 300 m upwind (north)', done: false },
      { id: 'jump4', label: 'Jump 4 m', done: false },
      { id: 'backroll', label: 'Land a back roll', done: false },
      { id: 'grab', label: 'Land a grab', done: false },
      { id: 'jump8', label: 'Boost 8 m', done: false },
      { id: 'kiteloop', label: 'Land a kiteloop', done: false },
    ];
    game.hud.say(FREE_INTRO);
    this.render(game);
  }

  private distance = 0;

  update(game: Game, dt: number) {
    const rig = game.rig;
    if (rig.mode === 'riding') this.distance += rig.speed * dt;
    this.northMost = Math.min(this.northMost, rig.pos.z);
    this.mark(game, 'ride', this.distance > 500);
    this.mark(game, 'upwind', this.startZ - this.northMost > 300);
    for (const t of game.scoring.tricks) this.mark(game, t, true);
    this.refresh -= dt;
    if (this.refresh <= 0) {
      this.refresh = 0.5;
      this.render(game);
    }
  }

  private mark(game: Game, id: string, ok: boolean) {
    const c = this.challenges.find((x) => x.id === id);
    if (!c || c.done || !ok) return;
    c.done = true;
    game.hud.showToast(`✓ ${c.label}`, 3);
    game.scoring.score += 250;
    this.render(game);
  }

  private render(game: Game) {
    const rows = this.challenges.map((c) => `<div class="${c.done ? 'done' : ''}">${c.done ? '✓' : '○'} ${c.label}</div>`).join('');
    game.hud.setObjective(`<h3>Retos · Challenges</h3>${rows}`);
  }
}
