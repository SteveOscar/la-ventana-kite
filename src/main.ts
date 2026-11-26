import './ui/styles.css';
import * as THREE from 'three';
import { loadTerrainData } from './world/terrainData.ts';
import { Game, DEFAULT_CONFIG } from './game/game.ts';
import { FreeRide } from './modes/freeRide.ts';
import { FUN_FACTS, pick } from './content/culture.ts';

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
  bar.style.width = '100%';

  const params = new URLSearchParams(location.search);
  const view = params.get('view');
  if (view) {
    const v = view.split(',').map(Number);
    game.debugView = [new THREE.Vector3(v[0], v[1], v[2]), new THREE.Vector3(v[3], v[4], v[5])];
  }
  if (params.get('hours')) game.world.hours = Number(params.get('hours'));
  const play = params.get('play');
  if (play) {
    const config = { ...DEFAULT_CONFIG };
    if (params.get('wind')) config.wind = params.get('wind') as typeof config.wind;
    if (params.get('kite')) config.kiteSize = Number(params.get('kite'));
    if (params.get('hours')) config.startHours = Number(params.get('hours'));
    if (params.get('pro')) config.assisted = false;
    game.startSession(config, new FreeRide());
    const spawn = params.get('spawn');
    if (spawn) {
      const [x, z] = spawn.split(',').map(Number);
      game.spawnPlayer(x, z, -1);
    }
  }
  game.start();
  setTimeout(() => loading.classList.add('hidden'), 150);
}

boot().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<pre style="color:#fff;padding:20px">Failed to start: ${String(err?.stack ?? err)}</pre>`;
});
