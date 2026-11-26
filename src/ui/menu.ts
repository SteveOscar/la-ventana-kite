import { CHARACTERS, DONE_LINES, FUN_FACTS, LANDMARKS, MONTHS, SPECIES, pick } from '../content/culture.ts';
import type { Game, ModeId, SessionConfig, Mode } from '../game/game.ts';
import type { Logbook } from '../game/logbook.ts';
import { WIND_PRESETS } from '../world/wind.ts';
import { formatClock } from '../core/math.ts';
import { KITE_PALETTES } from '../render/kiteModel.ts';

export interface ModeInfo {
  id: ModeId;
  title: string;
  es: string;
  blurb: string;
  create(): Mode;
  /** Fixed options for this mode (others are chosen by the player). */
  fixed?: Partial<SessionConfig>;
}

export interface SessionSummary {
  title: string;
  lines: { label: string; value: string }[];
  note?: string;
}

const TIMES = [
  { label: 'Mañana', sub: '11:30', hours: 11.5 },
  { label: 'Tarde', sub: '13:30', hours: 13.5 },
  { label: 'Atardecer', sub: '16:40', hours: 16.67 },
];
const WIND_KEYS = ['light', 'classic', 'strong'] as const;
const SIZES = [7, 9, 12];

function el(html: string) {
  const d = document.createElement('div');
  d.innerHTML = html.trim();
  return d.firstElementChild as HTMLElement;
}

export function recommendedKite(knots: number) {
  return knots >= 23 ? 7 : knots >= 16.5 ? 9 : 12;
}

/** Title, setup, pause, summary, logbook and settings screens. */
export class Menus {
  private game: Game;
  private logbook: Logbook;
  private modes: ModeInfo[];
  private screen: HTMLElement;
  private factTimer = 0;
  private config: SessionConfig;
  private current: ModeInfo | null = null;
  private unlocked = false;

  constructor(game: Game, logbook: Logbook, modes: ModeInfo[]) {
    this.game = game;
    this.logbook = logbook;
    this.modes = modes;
    this.config = { ...game.config, assisted: logbook.data.settings.assisted };
    this.screen = document.createElement('div');
    this.screen.className = 'screen hidden';
    game.root.appendChild(this.screen);
    const unlock = () => {
      if (this.unlocked) return;
      this.unlocked = true;
      game.audio.unlock();
      game.audio.setVolume(logbook.data.settings.volume);
      game.audio.muted = logbook.data.settings.muted;
      game.audio.music(game.state === 'playing' ? 'session' : 'menu');
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    game.input.onKey((code) => {
      if (code === 'KeyN') {
        this.toggleMute();
        game.hud.showToast(logbook.data.settings.muted ? 'Sonido apagado · Muted' : 'Sonido · Sound on', 1.5);
      }
      if (code === 'Escape' || code === 'KeyP') {
        if (game.state === 'playing') this.pause();
        else if (game.state === 'paused') this.resume();
      }
    });
    setInterval(() => this.rotateFact(), 9000);
  }

  toggleMute() {
    const s = this.logbook.data.settings;
    s.muted = !s.muted;
    this.game.audio.muted = s.muted;
    this.logbook.save();
  }

  private click(name = 'ui') {
    this.game.audio.event(name === 'ui' ? 'ui' : 'checkpoint');
  }

  private show(content: HTMLElement) {
    this.screen.innerHTML = '';
    this.screen.appendChild(content);
    this.screen.classList.remove('hidden');
  }

  hide() {
    this.screen.classList.add('hidden');
    // A focused (now invisible) button would otherwise be "clicked" again by the Space bar.
    (document.activeElement as HTMLElement | null)?.blur();
    const node = this.screen.firstElementChild;
    setTimeout(() => {
      if (this.screen.classList.contains('hidden') && this.screen.firstElementChild === node) this.screen.innerHTML = '';
    }, 600);
  }

  private rotateFact() {
    const f = this.screen.querySelector('.fact');
    if (!f || this.game.state !== 'title') return;
    const fact = pick(FUN_FACTS);
    f.innerHTML = `<b>¿Sabías que…?</b> ${fact.en}`;
    this.factTimer++;
  }

  title() {
    this.game.quitToTitle();
    this.game.audio.music('menu');
    const fact = pick(FUN_FACTS);
    const node = el(`
      <div class="title-card">
        <div class="brand">
          <h1>La<br><em>Ventana</em></h1>
          <div class="tag">Kiteboarding the <b>Norte</b> · Baja California Sur</div>
          <div class="fact"><b>¿Sabías que…?</b> ${fact.en}</div>
        </div>
        <div class="menu">
          ${this.modes
            .map(
              (m) =>
                `<button data-mode="${m.id}">${m.es === m.title ? m.es : `${m.es} · ${m.title}`}${
                  m.id === 'school' && !this.logbook.data.schoolDone ? ' <span class="badge">start here</span>' : ''
                }<small>${m.blurb}</small></button>`,
            )
            .join('')}
          <button data-act="logbook">Bitácora · Logbook<small>Wildlife, landmarks and tricks you've collected</small></button>
          <button data-act="settings">Opciones · Settings</button>
          <button data-act="credits">Créditos · About</button>
        </div>
      </div>`);
    node.querySelectorAll<HTMLButtonElement>('button[data-mode]').forEach((b) =>
      b.addEventListener('click', () => {
        this.click();
        this.setup(this.modes.find((m) => m.id === b.dataset.mode)!);
      }),
    );
    node.querySelector('[data-act="logbook"]')!.addEventListener('click', () => {
      this.click();
      this.logbookScreen();
    });
    node.querySelector('[data-act="settings"]')!.addEventListener('click', () => {
      this.click();
      this.settings(() => this.title());
    });
    node.querySelector('[data-act="credits"]')!.addEventListener('click', () => {
      this.click();
      this.credits();
    });
    this.show(node);
  }

  private setup(mode: ModeInfo) {
    this.current = mode;
    const cfg = { ...this.config, ...mode.fixed, mode: mode.id };
    this.config = cfg;
    const chips = <T,>(name: string, items: { v: T; label: string; sub?: string }[], cur: T) =>
      `<div class="opt"><div class="label">${name}</div><div class="chips">${items
        .map((it, i) => `<button class="chip ${it.v === cur ? 'on' : ''}" data-i="${i}">${it.label}${it.sub ? `<small>${it.sub}</small>` : ''}</button>`)
        .join('')}</div></div>`;
    const render = () => {
      const knots = WIND_PRESETS[cfg.wind].knots;
      const rec = recommendedKite(knots);
      const advice =
        cfg.kiteSize === rec
          ? `<div class="advice">Good call: a ${cfg.kiteSize} m is right for ~${knots} knots.</div>`
          : cfg.kiteSize > rec
            ? `<div class="advice warn">¡Aguas! A ${cfg.kiteSize} m in ~${knots} knots will be a handful: expect to be overpowered and lofted in gusts. Memo would rig a ${rec} m.</div>`
            : `<div class="advice warn">A ${cfg.kiteSize} m in ~${knots} knots will feel underpowered: harder to stay upwind and jump. Memo would rig a ${rec} m.</div>`;
      const node = el(`
        <div class="setup">
          <h2>${mode.es}</h2>
          <p class="desc">${mode.blurb}</p>
          ${mode.fixed?.wind ? '' : `<div data-g="wind">${chips('Viento · Wind', WIND_KEYS.map((k) => ({ v: k, label: WIND_PRESETS[k].labelEs, sub: `~${WIND_PRESETS[k].knots} kn` })), cfg.wind)}</div>`}
          <div data-g="kite">${chips('Cometa · Kite', SIZES.map((s) => ({ v: s, label: `${s} m²` })), cfg.kiteSize)}</div>
          ${advice}
          ${mode.fixed?.startHours ? '' : `<div data-g="time">${chips('Hora · Time', TIMES.map((t) => ({ v: t.hours, label: t.label, sub: t.sub })), cfg.startHours)}</div>`}
          ${mode.fixed?.month !== undefined ? '' : `<div data-g="month">${chips('Mes · Month', MONTHS.map((m, i) => ({ v: i, label: m })), cfg.month)}</div>`}
          <div class="opt"><div class="label">Colores · Kite colours</div><div class="chips" data-g="palette">${KITE_PALETTES.map(
            (p, i) =>
              `<button class="chip swatch ${cfg.palette === i ? 'on' : ''}" data-i="${i}" title="Kite ${i + 1}">${p.canopy
                .slice(0, 3)
                .map((c) => `<span style="background:#${c.toString(16).padStart(6, '0')}"></span>`)
                .join('')}</button>`,
          ).join('')}</div></div>
          <div data-g="assist">${chips(
            'Control',
            [
              { v: true, label: 'Asistido', sub: 'autopilot flies the kite' },
              { v: false, label: 'Pro', sub: 'you steer the bar' },
            ],
            cfg.assisted,
          )}</div>
          <div class="row-btns"><button class="btn" data-act="back">← Volver</button><button class="btn primary" data-act="go">¡Vámonos!</button></div>
        </div>`);
      const bind = (g: string, values: unknown[], set: (v: never) => void) => {
        node.querySelectorAll<HTMLButtonElement>(`[data-g="${g}"] .chip, .chips[data-g="${g}"] > .chip`).forEach((b) =>
          b.addEventListener('click', () => {
            this.click();
            set(values[Number(b.dataset.i)] as never);
            render();
          }),
        );
      };
      bind('wind', [...WIND_KEYS], (v) => {
        cfg.wind = v;
        cfg.kiteSize = recommendedKite(WIND_PRESETS[cfg.wind].knots);
      });
      bind('kite', SIZES, (v) => (cfg.kiteSize = v));
      bind('palette', KITE_PALETTES.map((_, i) => i), (v) => (cfg.palette = v));
      bind('time', TIMES.map((t) => t.hours), (v) => (cfg.startHours = v));
      bind('month', MONTHS.map((_, i) => i), (v) => (cfg.month = v));
      bind('assist', [true, false], (v) => {
        cfg.assisted = v;
        this.logbook.data.settings.assisted = v;
        this.logbook.save();
      });
      node.querySelector('[data-act="back"]')!.addEventListener('click', () => {
        this.click();
        this.title();
      });
      node.querySelector('[data-act="go"]')!.addEventListener('click', () => {
        this.click();
        this.start();
      });
      this.show(node);
    };
    render();
  }

  start() {
    if (!this.current) return;
    this.hide();
    this.game.audio.music('session');
    this.game.startSession({ ...this.config }, this.current.create());
  }

  pause() {
    this.game.setState('paused');
    const rig = this.game.rig;
    const node = el(`
      <div class="setup">
        <h2>Pausa</h2>
        <p class="desc">${formatClock(this.game.world.hours)} · ${(this.game.world.wind.base / 0.5144).toFixed(0)} knots · score ${Math.round(this.game.scoring.score).toLocaleString()}</p>
        <div class="menu">
          <button data-act="resume">Seguir · Resume</button>
          <button data-act="restart">Reiniciar · Restart</button>
          <button data-act="end">Terminar sesión · End session<small>Tacos and a summary on the beach</small></button>
          <button data-act="settings">Opciones · Settings</button>
          <button data-act="quit">Salir al menú · Quit to title</button>
        </div>
        <p class="credits" style="margin-top:14px">${rig.kite.mode === 'down' ? 'Your kite is in the water: hold R to relaunch.' : 'Esc to resume.'}</p>
      </div>`);
    node.querySelector('[data-act="resume"]')!.addEventListener('click', () => this.resume());
    node.querySelector('[data-act="restart"]')!.addEventListener('click', () => {
      this.click();
      this.start();
    });
    node.querySelector('[data-act="end"]')!.addEventListener('click', () => {
      this.click();
      this.game.endSession('player');
    });
    node.querySelector('[data-act="settings"]')!.addEventListener('click', () => {
      this.click();
      this.settings(() => this.pause());
    });
    node.querySelector('[data-act="quit"]')!.addEventListener('click', () => {
      this.click();
      this.title();
    });
    this.show(node);
  }

  resume() {
    this.hide();
    this.game.setState('playing');
  }

  summary(s: SessionSummary) {
    const line = pick(DONE_LINES);
    const c = CHARACTERS[line.who];
    const node = el(`
      <div class="setup">
        <h2>${s.title}</h2>
        <div class="summary-grid">${s.lines.map((l) => `<div class="stat"><b>${l.value}</b><span>${l.label}</span></div>`).join('')}</div>
        ${s.note ? `<p class="desc">${s.note}</p>` : ''}
        <div class="dialog show" style="position:relative;left:auto;bottom:auto;transform:none;width:100%;margin-top:8px">
          <div class="portrait" style="background:${c.color}">${c.initial}</div>
          <div class="d-body"><div class="d-name">${c.name} <span>${c.role}</span></div><div class="d-es">${line.es}</div><div class="d-en">${line.en}</div></div>
        </div>
        <div class="row-btns"><button class="btn" data-act="title">Menú</button><button class="btn primary" data-act="again">Otra vez · Ride again</button></div>
      </div>`);
    node.querySelector('[data-act="title"]')!.addEventListener('click', () => {
      this.click();
      this.title();
    });
    node.querySelector('[data-act="again"]')!.addEventListener('click', () => {
      this.click();
      this.start();
    });
    this.show(node);
  }

  private logbookScreen() {
    const d = this.logbook.data;
    const item = (got: boolean, title: string, sub: string) => `<div class="log-item ${got ? '' : 'locked'}"><b>${got ? title : '???'}</b>${got ? sub : 'Not yet seen'}</div>`;
    const node = el(`
      <div class="setup">
        <h2>Bitácora</h2>
        <p class="desc">${d.sessions} sessions · best score ${d.bestScore.toLocaleString()} · best jump ${d.bestHeight.toFixed(1)} m · longest hang time ${d.bestAirtime.toFixed(1)} s${
          d.downwinderBest ? ` · downwinder ${formatTime(d.downwinderBest)}` : ''
        }${d.raceBest ? ` · Classic best place ${d.raceBest}` : ''}${d.schoolDone ? ' · ✓ kite school graduate' : ''}</p>
        <div class="label" style="margin:10px 0 8px">Fauna · Wildlife</div>
        <div class="logbook-list">${SPECIES.map((sp) => item(d.species.includes(sp.id), `${sp.es} · ${sp.en}`, sp.note)).join('')}</div>
        <div class="label" style="margin:16px 0 8px">Lugares · Places</div>
        <div class="logbook-list">${LANDMARKS.map((l) => item(d.landmarks.includes(l.id), `${l.es}`, l.note)).join('')}</div>
        <div class="label" style="margin:16px 0 8px">Trucos · Tricks</div>
        <p class="desc">${d.tricks.length ? d.tricks.map(trickName).join(' · ') : 'Land some jumps and tricks to fill this in.'}</p>
        <div class="row-btns"><button class="btn" data-act="back">← Volver</button></div>
      </div>`);
    node.querySelector('[data-act="back"]')!.addEventListener('click', () => {
      this.click();
      this.title();
    });
    this.show(node);
  }

  private settings(back: () => void) {
    const s = this.logbook.data.settings;
    const node = el(`
      <div class="setup">
        <h2>Opciones</h2>
        <div class="opt"><div class="label">Volumen · Volume</div><input type="range" min="0" max="1" step="0.05" value="${s.volume}" style="width:100%;pointer-events:auto">
          <div class="chips" style="margin-top:8px"><button class="chip ${s.muted ? 'on' : ''}" data-act="mute">${s.muted ? 'Sonido apagado · Muted' : 'Silenciar · Mute (N)'}</button></div></div>
        <div class="opt"><div class="label">Calidad · Quality</div><div class="chips">
          <button class="chip ${s.quality === 'high' ? 'on' : ''}" data-q="high">Alta · High</button>
          <button class="chip ${s.quality === 'medium' ? 'on' : ''}" data-q="medium">Media · Medium<small>for slower laptops</small></button>
        </div></div>
        <p class="credits">Controls: A/D carve · W/S power · Space jump · Shift grab · K kiteloop · R relaunch · C camera · M map · H help · V hide HUD · drag the mouse to look around. Gamepads work too.</p>
        <div class="row-btns"><button class="btn" data-act="back">← Volver</button></div>
      </div>`);
    const range = node.querySelector('input') as HTMLInputElement;
    range.addEventListener('input', () => {
      s.volume = Number(range.value);
      this.game.audio.setVolume(s.volume);
      this.logbook.save();
    });
    node.querySelector('[data-act="mute"]')!.addEventListener('click', () => {
      this.toggleMute();
      this.settings(back);
    });
    node.querySelectorAll<HTMLButtonElement>('[data-q]').forEach((b) =>
      b.addEventListener('click', () => {
        s.quality = b.dataset.q as 'high' | 'medium';
        this.logbook.save();
        this.game.applyQuality(s.quality);
        this.settings(back);
      }),
    );
    node.querySelector('[data-act="back"]')!.addEventListener('click', () => {
      this.click();
      back();
    });
    this.show(node);
  }

  private credits() {
    const node = el(`
      <div class="setup">
        <h2>Créditos</h2>
        <p class="desc">A love letter to the winter Norte in La Ventana and El Sargento, Baja California Sur: the pangas on the beach, the cardón on the hills, Cerralvo across the channel and a bay full of kites.</p>
        <p class="credits">
          Terrain: real elevation from Mapzen / AWS Terrain Tiles (SRTM, GMTED, ETOPO1). Coastline, roads and building footprints © OpenStreetMap contributors (ODbL).<br>
          The La Ventana Classic is a real windsports festival that raises money for the schools of La Ventana and El Sargento; the race here is an homage. Memo, Don Chuy, Doña Lupe and Rafa are fictional.<br>
          Everything you see and hear is generated in code with three.js and the Web Audio API.
        </p>
        <div class="row-btns"><button class="btn" data-act="back">← Volver</button></div>
      </div>`);
    node.querySelector('[data-act="back"]')!.addEventListener('click', () => {
      this.click();
      this.title();
    });
    this.show(node);
  }
}

export function formatTime(secs: number) {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const TRICK_LABELS: Record<string, string> = {
  jump4: 'Jump 4 m',
  jump8: 'Big air 8 m',
  jump12: 'Mega loop territory 12 m',
  backroll: 'Back roll',
  frontroll: 'Front roll',
  doubleroll: 'Double roll',
  spin: '360 spin',
  grab: 'Grab',
  kiteloop: 'Kiteloop',
  float: 'Five-second float',
};
export const trickName = (id: string) => TRICK_LABELS[id] ?? id;
