import { DEG, KNOT, clamp, formatClock, headingOf, wrapAngle } from '../core/math.ts';
import { CHARACTERS, POINT_OF_SAIL, type Line } from '../content/culture.ts';
import type { Rig } from '../sim/rig.ts';
import type { TerrainData } from '../world/terrainData.ts';
import { EDGE_ANGLE } from '../sim/kite.ts';

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compassName = (rad: number) => COMPASS[Math.round(((((rad / DEG) % 360) + 360) % 360) / 22.5) % 16];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement, html?: string) {
  const e = document.createElement(tag);
  e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  parent?.appendChild(e);
  return e;
}

export interface HudFrame {
  rig: Rig;
  windKnots: number;
  gustKnots: number;
  windFrom: number;
  cameraYaw: number;
  hours: number;
  monthLabel: string;
  score: number;
  combo: number;
  assisted: boolean;
  pilotTarget?: { az: number; el: number } | null;
  /** Other kiters for the minimap. */
  others: { x: number; z: number }[];
  markers: { x: number; z: number; color: string; label?: string }[];
}

export class Hud {
  readonly root: HTMLElement;
  private windVal: HTMLElement;
  private windSub: HTMLElement;
  private windArrow: HTMLElement;
  private clock: HTMLElement;
  private speedVal: HTMLElement;
  private sail: HTMLElement;
  private powerFill: HTMLElement;
  private powerLabel: HTMLElement;
  private scoreVal: HTMLElement;
  private comboVal: HTMLElement;
  private objective: HTMLElement;
  private trick: HTMLElement;
  private trickTimer = 0;
  private toast: HTMLElement;
  private toastTimer = 0;
  private dialog: HTMLElement;
  private dialogQueue: Line[] = [];
  private dialogTimer = 0;
  private gauge: HTMLCanvasElement;
  private map: HTMLCanvasElement;
  private mapBase: HTMLCanvasElement;
  private help: HTMLElement;
  private stateBadge: HTMLElement;
  private relaunchBar: HTMLElement;
  private relaunchFill: HTMLElement;
  private textTimer = 0;
  private data: TerrainData;
  bigMap = false;

  constructor(parent: HTMLElement, data: TerrainData) {
    this.data = data;
    this.root = el('div', 'hud', parent);
    const wind = el('div', 'panel wind', this.root);
    el('div', 'label', wind, 'Viento · Wind');
    const row = el('div', 'wind-row', wind);
    this.windArrow = el('div', 'wind-arrow', row, '<svg viewBox="0 0 40 40"><path d="M20 4 L28 26 L20 21 L12 26 Z" fill="currentColor"/></svg>');
    this.windVal = el('div', 'big', row, '--');
    this.windSub = el('div', 'sub', wind, '');
    this.clock = el('div', 'sub clock', wind, '');

    const score = el('div', 'panel score', this.root);
    el('div', 'label', score, 'Puntos · Score');
    this.scoreVal = el('div', 'big', score, '0');
    this.comboVal = el('div', 'sub', score, '');
    this.objective = el('div', 'panel objective', this.root);
    this.objective.style.display = 'none';

    const gaugeWrap = el('div', 'panel gauge', this.root);
    el('div', 'label', gaugeWrap, 'Ventana de viento');
    this.gauge = el('canvas', '', gaugeWrap) as HTMLCanvasElement;
    this.gauge.width = 220 * 2;
    this.gauge.height = 128 * 2;
    this.stateBadge = el('div', 'sub state', gaugeWrap, '');

    const speed = el('div', 'panel speed', this.root);
    this.speedVal = el('div', 'huge', speed, '0.0');
    el('div', 'unit', speed, 'kn');
    this.sail = el('div', 'sub', speed, '');
    const power = el('div', 'power', speed);
    this.powerFill = el('div', 'power-fill', power);
    this.powerLabel = el('div', 'sub', speed, '');

    const mapWrap = el('div', 'panel map', this.root);
    this.map = el('canvas', '', mapWrap) as HTMLCanvasElement;
    this.map.width = 200 * 2;
    this.map.height = 200 * 2;
    this.mapBase = document.createElement('canvas');
    this.buildMapBase();

    this.trick = el('div', 'trick', this.root);
    this.toast = el('div', 'toast', this.root);
    this.dialog = el('div', 'dialog', this.root);
    this.relaunchBar = el('div', 'relaunch', this.root);
    el('div', 'label', this.relaunchBar, 'Relanzando la cometa · Relaunching');
    const rb = el('div', 'power', this.relaunchBar);
    this.relaunchFill = el('div', 'power-fill', rb);
    this.help = el('div', 'panel help', this.root);
    this.setHelp(true);
  }

  /** Shows the controls card for a while at the start of a session. */
  showHelpFor(secs: number) {
    this.help.classList.remove('hidden');
    this.helpTimer = secs;
  }

  private helpTimer = 0;

  setHelp(assisted: boolean) {
    this.help.innerHTML = assisted
      ? `<b>Controls</b> (H to hide)<br>
      <kbd>A</kbd><kbd>D</kbd> carve · <kbd>W</kbd> more power / waterstart · <kbd>S</kbd> depower<br>
      <kbd>Space</kbd> hold to load, release to jump<br>
      In the air: <kbd>W</kbd><kbd>S</kbd> front/back roll · <kbd>A</kbd><kbd>D</kbd> spin · <kbd>Shift</kbd> grab · <kbd>K</kbd> kiteloop<br>
      <kbd>R</kbd> relaunch kite · <kbd>C</kbd> camera · <kbd>M</kbd> map · <kbd>Esc</kbd> pause · drag to look`
      : `<b>Pro controls</b> (H to hide)<br>
      <kbd>←</kbd><kbd>→</kbd> steer kite · <kbd>↑</kbd><kbd>↓</kbd> sheet in/out<br>
      <kbd>A</kbd><kbd>D</kbd> carve · <kbd>Space</kbd> load edge, release to pop<br>
      Air: <kbd>W</kbd><kbd>S</kbd> rolls · <kbd>A</kbd><kbd>D</kbd> spin · <kbd>Shift</kbd> grab<br>
      <kbd>R</kbd> relaunch · <kbd>C</kbd> camera · <kbd>M</kbd> map · <kbd>Esc</kbd> pause`;
  }

  toggleHelp() {
    this.helpTimer = 0;
    this.help.classList.toggle('hidden');
  }

  setObjective(html: string | null) {
    if (!html) {
      this.objective.style.display = 'none';
      return;
    }
    this.objective.style.display = '';
    this.objective.innerHTML = html;
  }

  showTrick(title: string, detail: string, points: number, cheer: string, good = true) {
    this.trick.innerHTML = `<div class="cheer ${good ? '' : 'bad'}">${cheer}</div><div class="t-title">${title}</div><div class="t-detail">${detail}</div>${
      points > 0 ? `<div class="t-points">+${points.toLocaleString()}</div>` : ''
    }`;
    this.trick.classList.remove('show');
    void this.trick.offsetWidth;
    this.trick.classList.add('show');
    this.trickTimer = 3.2;
  }

  showToast(html: string, secs = 3) {
    this.toast.innerHTML = html;
    this.toast.classList.add('show');
    this.toastTimer = secs;
  }

  say(lines: Line[]) {
    this.dialogQueue.push(...lines);
    if (this.dialogTimer <= 0) this.nextDialog();
  }

  clearDialog() {
    this.dialogQueue = [];
    this.dialogTimer = 0;
    this.dialog.classList.remove('show');
  }

  get talking() {
    return this.dialogTimer > 0 || this.dialogQueue.length > 0;
  }

  skipDialog() {
    if (this.dialogTimer > 0) this.dialogTimer = 0.01;
  }

  private nextDialog() {
    const line = this.dialogQueue.shift();
    if (!line) {
      this.dialog.classList.remove('show');
      return;
    }
    const c = CHARACTERS[line.who];
    this.dialog.innerHTML = `<div class="portrait" style="background:${c.color}">${c.initial}</div>
      <div class="d-body"><div class="d-name">${c.name} <span>${c.role}</span></div>
      <div class="d-es">${line.es}</div><div class="d-en">${line.en}</div></div>`;
    this.dialog.classList.add('show');
    this.dialogTimer = 3.2 + line.en.length * 0.045;
  }

  private buildMapBase() {
    const d = this.data;
    const c = this.mapBase;
    // Map covers x -6..10 km, z -14..6 km.
    const X0 = -6000, X1 = 10000, Z0 = -14000, Z1 = 6000;
    const W = 512, H = Math.round((W * (Z1 - Z0)) / (X1 - X0));
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(W, H);
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const x = X0 + ((i + 0.5) / W) * (X1 - X0), z = Z0 + ((j + 0.5) / H) * (Z1 - Z0);
        const h = d.height(x, z);
        let r: number, g: number, b: number;
        if (h < 0) {
          const t = clamp(-h / 25, 0, 1);
          r = 60 - 45 * t;
          g = 190 - 110 * t;
          b = 200 - 60 * t;
        } else {
          const t = clamp(h / 400, 0, 1);
          r = 222 - 70 * t;
          g = 200 - 85 * t;
          b = 160 - 75 * t;
        }
        const o = (j * W + i) * 4;
        img.data[o] = r;
        img.data[o + 1] = g;
        img.data[o + 2] = b;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    ctx.fillStyle = 'rgba(120,40,30,0.55)';
    for (const b of d.world.buildings) {
      ctx.fillRect(((b[0] - X0) / (X1 - X0)) * W - 0.5, ((b[1] - Z0) / (Z1 - Z0)) * H - 0.5, 1, 1);
    }
    ctx.font = 'bold 13px "Avenir Next", system-ui, sans-serif';
    ctx.fillStyle = 'rgba(40,25,10,0.85)';
    const lm = d.world.landmarks;
    const label = (t: string, x: number, z: number) => ctx.fillText(t, ((x - X0) / (X1 - X0)) * W, ((z - Z0) / (Z1 - Z0)) * H);
    label('El Sargento', lm.elSargento.x - 1900, lm.elSargento.z);
    label('La Ventana', lm.mainBeach.x - 1800, lm.mainBeach.z + 500);
    label('Aguas termales', lm.hotSprings.x - 2400, lm.hotSprings.z);
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    label('Canal de Cerralvo', 3000, -6000);
    (this.mapBase as unknown as { bounds: number[] }).bounds = [X0, X1, Z0, Z1];
  }

  update(dt: number, f: HudFrame) {
    this.textTimer -= dt;
    const rig = f.rig;
    if (this.textTimer <= 0) {
      this.textTimer = 0.1;
      this.windVal.textContent = `${f.windKnots.toFixed(0)} kn`;
      this.windSub.textContent = `ráfagas ${f.gustKnots.toFixed(0)} · El Norte · ${compassName(f.windFrom)}`;
      this.clock.textContent = `${formatClock(f.hours)} · ${f.monthLabel}`;
      this.speedVal.textContent = (rig.speed / KNOT).toFixed(1);
      const angleFromWind = wrapAngle(rig.heading - f.windFrom) / DEG;
      const pos = POINT_OF_SAIL(angleFromWind);
      this.sail.textContent = rig.mode === 'riding' ? `${pos.es} · ${pos.en}` : MODE_LABEL[rig.mode];
      const kg = rig.kite.tension / 9.81;
      const frac = clamp(rig.kite.tension / (rig.mass * 9.81 * 2.6), 0, 1);
      this.powerFill.style.width = `${(frac * 100).toFixed(0)}%`;
      this.powerFill.style.background = frac > 0.85 ? '#ff5d5d' : frac > 0.6 ? '#ffc04d' : '#2ec4b6';
      this.powerLabel.textContent = `tirón ${kg.toFixed(0)} kg · cometa ${rig.kite.size} m²`;
      this.scoreVal.textContent = Math.round(f.score).toLocaleString();
      this.comboVal.textContent = f.combo > 1.01 ? `combo ×${f.combo.toFixed(1)}` : '';
      this.stateBadge.textContent = rig.kite.mode === 'down' ? '¡Cometa al agua! Hold R to relaunch' : f.assisted ? 'Asistido · autopilot on' : 'Pro · manual bar';
    }
    // Wind arrow relative to the camera: up on screen = camera forward.
    const rel = f.windFrom + Math.PI - f.cameraYaw;
    this.windArrow.style.transform = `rotate(${(rel / DEG).toFixed(1)}deg)`;

    this.relaunchBar.style.display = rig.kite.mode === 'down' ? 'block' : 'none';
    this.relaunchFill.style.width = `${(rig.kite.relaunch * 100).toFixed(0)}%`;

    this.drawGauge(f);
    this.drawMap(f);

    if (this.helpTimer > 0) {
      this.helpTimer -= dt;
      if (this.helpTimer <= 0) this.help.classList.add('hidden');
    }
    if (this.trickTimer > 0) {
      this.trickTimer -= dt;
      if (this.trickTimer <= 0) this.trick.classList.remove('show');
    }
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toast.classList.remove('show');
    }
    if (this.dialogTimer > 0) {
      this.dialogTimer -= dt;
      if (this.dialogTimer <= 0) this.nextDialog();
    }
  }

  private drawGauge(f: HudFrame) {
    const g = this.gauge.getContext('2d')!;
    const W = this.gauge.width, H = this.gauge.height;
    g.clearRect(0, 0, W, H);
    const cx = W / 2, cy = H - 18, R = H - 34;
    // The window seen from behind the rider looking downwind: power zone at the bottom centre,
    // the edge is the arc, 12 o'clock at the top.
    const Re = R / Math.sin(EDGE_ANGLE);
    const toXY = (az: number, elv: number) => [cx + Math.sin(az) * Math.cos(elv) * Re, cy - Math.sin(elv) * Re];
    const grad = g.createRadialGradient(cx, cy, 0, cx, cy, R);
    grad.addColorStop(0, 'rgba(255,93,93,0.75)');
    grad.addColorStop(0.45, 'rgba(255,192,77,0.55)');
    grad.addColorStop(0.85, 'rgba(46,196,182,0.35)');
    grad.addColorStop(1, 'rgba(46,196,182,0.15)');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(cx - R, cy);
    g.arc(cx, cy, R, Math.PI, 0);
    g.closePath();
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.lineWidth = 2;
    g.setLineDash([6, 8]);
    for (const e of [30, 60]) {
      const y = cy - Math.sin(e * DEG) * Re;
      const half = Math.sqrt(Math.max(0, R * R - (cy - y) * (cy - y)));
      g.beginPath();
      g.moveTo(cx - half, y);
      g.lineTo(cx + half, y);
      g.stroke();
    }
    g.setLineDash([]);
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx, cy - R);
    g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.7)';
    g.font = '600 20px "Avenir Next", system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText('12', cx, cy - R + 22);
    g.fillText('9', cx - R + 14, cy - 6);
    g.fillText('3', cx + R - 14, cy - 6);
    // Rider at the centre bottom.
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(cx, cy, 7, 0, Math.PI * 2);
    g.fill();

    const kite = f.rig.kite;
    const draw = (az: number, elv: number, color: string, r: number, ring = false) => {
      const [x, y] = toXY(az, elv);
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      if (ring) {
        g.strokeStyle = color;
        g.lineWidth = 3;
        g.stroke();
      } else {
        g.fillStyle = color;
        g.fill();
      }
    };
    if (f.pilotTarget) draw(f.pilotTarget.az, f.pilotTarget.el, 'rgba(255,255,255,0.8)', 11, true);
    draw(kite.azimuth, Math.max(0, kite.elevation), kite.mode === 'down' ? '#ff5d5d' : '#ffffff', 10);
    g.strokeStyle = 'rgba(255,255,255,0.9)';
    g.lineWidth = 2;
    const [kx, ky] = toXY(kite.azimuth, Math.max(0, kite.elevation));
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(kx, ky);
    g.stroke();
  }

  private drawMap(f: HudFrame) {
    const ctx = this.map.getContext('2d')!;
    const W = this.map.width, H = this.map.height;
    const [X0, X1, Z0, Z1] = (this.mapBase as unknown as { bounds: number[] }).bounds;
    const rig = f.rig;
    const span = this.bigMap ? 9000 : 3200;
    const s = W / span;
    ctx.save();
    ctx.clearRect(0, 0, W, H);
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, W / 2 - 2, 0, Math.PI * 2);
    ctx.clip();
    const bx = (rig.pos.x - X0) / (X1 - X0) * this.mapBase.width;
    const bz = (rig.pos.z - Z0) / (Z1 - Z0) * this.mapBase.height;
    const pxPerM = this.mapBase.width / (X1 - X0);
    const srcW = span * pxPerM;
    ctx.fillStyle = '#0b3550';
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(this.mapBase, bx - srcW / 2, bz - srcW / 2, srcW, srcW, 0, 0, W, H);
    const toMap = (x: number, z: number) => [W / 2 + (x - rig.pos.x) * s, H / 2 + (z - rig.pos.z) * s];
    for (const m of f.markers) {
      const [x, y] = toMap(m.x, m.z);
      ctx.fillStyle = m.color;
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.fill();
      if (m.label) {
        ctx.fillStyle = '#fff';
        ctx.font = '600 18px "Avenir Next", system-ui, sans-serif';
        ctx.fillText(m.label, x + 11, y + 6);
      }
    }
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    for (const o of f.others) {
      const [x, y] = toMap(o.x, o.z);
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    // Player arrow.
    const hdg = rig.speed > 1 ? headingOf(rig.vel.x, rig.vel.z) : rig.heading;
    ctx.translate(W / 2, H / 2);
    ctx.rotate(hdg);
    ctx.fillStyle = '#ff6b4a';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, -16);
    ctx.lineTo(11, 12);
    ctx.lineTo(0, 6);
    ctx.lineTo(-11, 12);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    // North marker.
    ctx.fillStyle = '#fff';
    ctx.font = '700 22px "Avenir Next", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('N', W / 2, 26);
    ctx.textAlign = 'start';
  }

  toggleMap() {
    this.bigMap = !this.bigMap;
    this.root.classList.toggle('bigmap', this.bigMap);
  }
}

const MODE_LABEL: Record<string, string> = {
  water: 'En el agua · In the water',
  riding: '',
  air: '¡En el aire!',
  crash: '¡Revolcón! · Wipeout',
  drag: 'Body drag to your board',
};
