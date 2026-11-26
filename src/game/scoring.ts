import { CHEERS, pick } from '../content/culture.ts';
import type { JumpResult } from '../sim/rig.ts';

export const GRAB_NAMES: Record<number, string> = { 1: 'Indy', 2: 'Mute', 3: 'Tail', 4: 'Nose' };

const MULT = ['', 'Double ', 'Triple ', 'Quad ', 'Quint '];

export interface TrickCall {
  title: string;
  detail: string;
  points: number;
  cheer: string;
  good: boolean;
  /** Tags for challenges and the logbook. */
  tags: string[];
}

/** Names and scores jumps; keeps a combo multiplier for consecutive clean landings. */
export class Scoring {
  score = 0;
  combo = 1;
  private comboTimer = 0;
  best = { height: 0, airtime: 0, points: 0 };
  jumps = 0;
  cleanLandings = 0;
  crashes = 0;
  tricks = new Set<string>();

  update(dt: number) {
    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) this.combo = 1;
    }
  }

  breakCombo() {
    this.combo = 1;
    this.comboTimer = 0;
  }

  land(j: JumpResult): TrickCall {
    const parts: string[] = [];
    const tags: string[] = [];
    if (j.kiteloop) {
      parts.push('Kiteloop');
      tags.push('kiteloop');
    }
    if (j.flips > 0) {
      const name = `${MULT[Math.min(j.flips - 1, 4)]}${j.flipDir > 0 ? 'Front' : 'Back'} Roll`;
      parts.push(name);
      tags.push(j.flipDir > 0 ? 'frontroll' : 'backroll');
      if (j.flips > 1) tags.push('doubleroll');
    }
    if (j.spins > 0) {
      parts.push(`${j.spins * 360} Spin`);
      tags.push('spin');
    } else if (j.switchLanding) {
      parts.push('180');
    }
    const grabs = j.grabs.filter((g) => GRAB_NAMES[g]);
    if (grabs.length && j.grabTime > 0.25) {
      parts.push(grabs.map((g) => GRAB_NAMES[g]).join('-') + ' Grab');
      tags.push('grab');
    }
    const big = j.height >= 8;
    if (!parts.length) parts.push(big ? 'Big Air' : j.height > 2.5 ? 'Jump' : 'Hop');
    else if (big) parts.unshift('Big Air');
    if (j.airtime >= 5) tags.push('float');
    if (j.height >= 4) tags.push('jump4');
    if (j.height >= 8) tags.push('jump8');
    if (j.height >= 12) tags.push('jump12');

    const title = parts.join(' ');
    const detail = `${j.height.toFixed(1)} m · ${j.airtime.toFixed(1)} s · ${j.distance.toFixed(0)} m`;

    if (j.quality === 'crash') {
      this.crashes++;
      this.breakCombo();
      return { title, detail: j.reason ?? detail, points: 0, cheer: pick(CHEERS.crash), good: false, tags: ['crash'] };
    }

    let pts = j.height * 45 + j.airtime * 70 + j.distance * 1.5;
    pts += j.flips * (j.flipDir > 0 ? 380 : 320) * (j.flips > 1 ? 1.5 : 1);
    pts += j.spins * 260 + (j.switchLanding && !j.spins ? 60 : 0);
    if (grabs.length && j.grabTime > 0.25) pts += 120 * new Set(grabs).size + j.grabTime * 160;
    if (j.kiteloop) pts += 650 + j.height * 30;
    if (j.quality === 'hard') pts *= 0.5;
    pts = Math.round(pts * this.combo);

    this.jumps++;
    if (j.quality === 'clean') {
      this.cleanLandings++;
      if (j.height > 1.2) {
        this.combo = Math.min(3, this.combo + 0.25);
        this.comboTimer = 18;
      }
    } else this.breakCombo();
    this.score += pts;
    this.best.height = Math.max(this.best.height, j.height);
    this.best.airtime = Math.max(this.best.airtime, j.airtime);
    this.best.points = Math.max(this.best.points, pts);
    for (const t of tags) this.tricks.add(t);

    const cheer = j.quality === 'hard' ? pick(CHEERS.hard) : big || j.flips || j.kiteloop ? pick(CHEERS.big) : pick(CHEERS.clean);
    return { title, detail, points: pts, cheer, good: j.quality === 'clean', tags };
  }
}
