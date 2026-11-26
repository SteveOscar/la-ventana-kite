// Headless (real GPU) smoke run: loads the game, plays a scripted session,
// collects console errors and screenshots.
//
//   node tools/smoke.mjs [--url http://127.0.0.1:5188/] [--query play=free] [--script basic] [--out .qa/smoke]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
    return acc;
  }, []),
);
const base = args.url ?? 'http://127.0.0.1:5188/';
const query = args.query ?? 'play=free';
const out = args.out ?? '.qa/smoke';
const script = args.script ?? 'basic';
const headed = !!args.headed;
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome',
  headless: !headed,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
const logs = [];
page.on('console', (m) => {
  const t = `[${m.type()}] ${m.text()}`;
  logs.push(t);
  if (m.type() === 'error' || m.type() === 'warning') errors.push(t);
});
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}\n${e.stack}`));
// Keep Vite's hot reload from restarting the page while files change.
await page.routeWebSocket(/.*/, () => {});

const t0 = Date.now();
await page.goto(`${base}?${query}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__game.time > 1, null, { timeout: 60000 });
console.log(`loaded in ${Date.now() - t0} ms`);

const shot = async (name) => {
  const file = path.join(out, `${name}.png`);
  await page.screenshot({ path: file });
  const state = await page.evaluate(() => {
    const g = window.__game;
    const r = g.rig;
    return {
      fps: Math.round(g.fps),
      cpuMs: +g.frameMs.toFixed(2),
      mode: r.mode,
      kite: r.kite.mode,
      speedKn: +(r.speed / 0.5144).toFixed(1),
      pos: [Math.round(r.pos.x), +r.pos.y.toFixed(2), Math.round(r.pos.z)],
      elev: Math.round((r.kite.elevation * 180) / Math.PI),
      tension: Math.round(r.kite.tension),
      score: Math.round(g.scoring.score),
      hours: +g.world.hours.toFixed(2),
      calls: g.renderer.info.render.calls,
      tris: g.renderer.info.render.triangles,
    };
  });
  console.log(name, JSON.stringify(state));
  return state;
};
const hold = async (key, ms) => {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
};

if (script === 'title') {
  await page.waitForTimeout(2500);
  await shot('title');
} else {
  await page.waitForTimeout(1500);
  await shot('00-start');
  await page.waitForTimeout(3500);
  await shot('01-up');
  await page.waitForTimeout(5000);
  await shot('02-riding');
  await hold('KeyC', 80);
  await page.waitForTimeout(1500);
  await shot('03-boatcam');
  await hold('KeyC', 80);
  await page.waitForTimeout(1500);
  await shot('04-kitecam');
  await hold('KeyC', 80);
  await page.waitForTimeout(1500);
  await shot('05-drone');
  await hold('KeyC', 80);
  await page.waitForTimeout(800);
  await hold('Space', 700);
  await page.waitForTimeout(900);
  await shot('06-air');
  await page.waitForTimeout(3500);
  await shot('07-after-jump');
  await hold('KeyD', 2500);
  await page.waitForTimeout(3000);
  await shot('08-after-transition');
}

const fps = await page.evaluate(() => window.__game.fps);
console.log(`fps ~${Math.round(fps)}`);
fs.writeFileSync(path.join(out, 'console.log'), logs.join('\n'));
if (errors.length) {
  console.log(`--- ${errors.length} console errors/warnings:`);
  for (const e of errors.slice(0, 20)) console.log(e.slice(0, 600));
}
await browser.close();
