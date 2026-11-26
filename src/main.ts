import './ui/styles.css';
import * as THREE from 'three';
import { loadTerrainData } from './world/terrainData.ts';
import { Game, DEFAULT_CONFIG, type ModeId } from './game/game.ts';
import { FreeRide } from './modes/freeRide.ts';
import { KiteSchool } from './modes/kiteSchool.ts';
import { Downwinder } from './modes/downwinder.ts';
import { Race } from './modes/race.ts';
import { Menus, type ModeInfo } from './ui/menu.ts';
import { FUN_FACTS, pick } from './content/culture.ts';

const MODES: ModeInfo[] = [
  {
    id: 'free',
    title: 'Free ride',
    es: 'Sesión libre',
    blurb: 'Ride the bay as the Norte builds. Challenges, big air and whatever swims by.',
    create: () => new FreeRide(),
  },
  {
    id: 'school',
    title: 'Kite school',
    es: 'Escuela',
    blurb: 'Memo teaches you the wind window, waterstarts, riding upwind, transitions and your first jump.',
    create: () => new KiteSchool(),
    fixed: { wind: 'classic', startHours: 12.5 },
  },
  {
    id: 'downwinder',
    title: 'Downwinder',
    es: 'Downwinder',
    blurb: 'From the Hot Springs past El Sargento to La Ventana, with Don Chuy in the panga.',
    create: () => new Downwinder(),
  },
  {
    id: 'race',
    title: 'La Ventana Classic',
    es: 'La Ventana Classic',
    blurb: 'Two laps around the buoys against the local fleet, for the village schools.',
    create: () => new Race(),
    fixed: { startHours: 14 },
  },
];

async function boot() {
  const app = document.getElementById('app')!;
  const loading = document.createElement('div');
  loading.className = 'loading';
  const fact = pick(FUN_FACTS);
  loading.innerHTML = `<div class="inner"><h1>La Ventana</h1><div class="bar"><div></div></div>
    <p><b>¿Sabías que…?</b> ${fact.en}</p></div>`;
  app.appendChild(loading);
  const bar = loading.querySelector('.bar div') as HTMLElement;

  const data = await loadTerrainData(`${import.meta.env.BASE_URL}data/`, (p) => (bar.style.width = `${Math.round(p * 70)}%`));
  bar.style.width = '80%';
  await new Promise((r) => setTimeout(r, 30));
  const game = new Game(app, data);
  (window as unknown as { __game: Game }).__game = game;
  game.applyQuality(game.logbook.data.settings.quality);
  bar.style.width = '100%';

  const menus = new Menus(game, game.logbook, MODES);
  game.onSessionEnd = (s) => menus.summary(s);

  const params = new URLSearchParams(location.search);
  const view = params.get('view');
  if (view) {
    const v = view.split(',').map(Number);
    game.debugView = [new THREE.Vector3(v[0], v[1], v[2]), new THREE.Vector3(v[3], v[4], v[5])];
  }
  if (params.get('hours')) game.world.hours = Number(params.get('hours'));
  const play = params.get('play') as ModeId | null;
  if (play) {
    // Direct start for testing: ?play=free|school|downwinder|race&wind=&kite=&hours=&pro=1&spawn=x,z
    const info = MODES.find((m) => m.id === play) ?? MODES[0];
    const config = { ...DEFAULT_CONFIG, ...info.fixed, mode: info.id };
    if (params.get('wind')) config.wind = params.get('wind') as typeof config.wind;
    if (params.get('kite')) config.kiteSize = Number(params.get('kite'));
    if (params.get('hours')) config.startHours = Number(params.get('hours'));
    if (params.get('month')) config.month = Number(params.get('month'));
    if (params.get('pro')) config.assisted = false;
    game.startSession(config, info.create());
    const spawn = params.get('spawn');
    if (spawn) {
      const [x, z] = spawn.split(',').map(Number);
      game.spawnPlayer(x, z, -1);
    }
  } else if (!view) {
    menus.title();
  }
  game.start();
  setTimeout(() => loading.classList.add('hidden'), 150);
}

boot().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<pre style="color:#fff;padding:20px">Failed to start: ${String(err?.stack ?? err)}</pre>`;
});
