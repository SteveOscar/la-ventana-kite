// Captures a set of presentation screenshots into .qa/beauty/.
//   node tools/beauty.mjs
import fs from 'node:fs';
import { chromium } from 'playwright';

const OUT = '.qa/beauty';
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const errors = [];

async function open(query, viewport = { width: 1600, height: 1000 }) {
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (e) => errors.push(`${query}: ${e.message}`));
  await page.routeWebSocket(/.*/, () => {});
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${query}: ${m.text()}`);
  });
  await page.goto(`http://127.0.0.1:5188/?${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__game.time > 1.5, null, { timeout: 60000 });
  return page;
}

// Title screen over the live bay.
{
  const page = await open('');
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${OUT}/01-title.png` });
  await page.close();
}

// Riding, chase cam, HUD hidden for a clean shot; then a jump.
{
  const page = await open('play=free&wind=classic&hours=15.3');
  await page.waitForFunction(() => window.__game.rig.mode === 'riding' && window.__game.rig.modeTime > 4, null, { timeout: 60000 });
  await page.evaluate(() => {
    const g = window.__game;
    g.hud.root.classList.add('off');
    g.cam.zoom = 0.75;
  });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/02-riding.png` });
  await page.evaluate(() => window.__game.hud.root.classList.remove('off'));
  await page.keyboard.down('Space');
  await page.waitForTimeout(650);
  await page.keyboard.up('Space');
  await page.waitForTimeout(1300);
  await page.screenshot({ path: `${OUT}/03-jump-hud.png` });
  await page.close();
}

// The villages and hills from the water.
for (const [name, view] of [
  ['04-el-sargento', '420,7,-3250,-250,10,-3480'],
  ['05-la-ventana-beach', '330,5,-300,40,5,-420'],
  ['06-hills-cardon', '500,30,-4300,-1600,90,-5000'],
  ['07-bay-aerial', '1400,160,-2400,-200,0,-1400'],
]) {
  const page = await open(`view=${view}&hours=15.8`);
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  await page.close();
}

// Golden hour toward Cerralvo and into the sunset.
{
  const page = await open('view=700,12,-1400,6000,250,-14000&hours=17.5');
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${OUT}/08-cerralvo-dusk.png` });
  await page.close();
}
{
  const page = await open('play=free&hours=17.35');
  await page.waitForFunction(() => window.__game.rig.mode === 'riding' && window.__game.rig.modeTime > 3, null, { timeout: 60000 });
  await page.evaluate(() => {
    const g = window.__game;
    g.hud.root.classList.add('off');
    g.cam.mode = 'side';
    g.cam.zoom = 0.6;
  });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${OUT}/09-sunset-ride.png` });
  await page.close();
}

console.log(errors.length ? `errors:\n${errors.join('\n')}` : 'no errors');
await browser.close();
