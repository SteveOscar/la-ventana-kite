// Scripted playtest in real Chrome: exercises jumps, tricks, transitions, crashes and relaunches.
//   node tools/playtest.mjs [query]
import { chromium } from 'playwright';
const query = process.argv[2] ?? 'play=free&wind=classic';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
// Keep Vite's hot reload from restarting the page while files change.
await page.routeWebSocket(/.*/, () => {});
await page.goto(`http://127.0.0.1:5188/?${query}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__game.time > 1, null, { timeout: 60000 });
await page.evaluate(() => {
  const g = window.__game;
  window.__log = [];
  g.listeners.land.push((j) => window.__log.push(`LAND ${j.quality} h=${j.height.toFixed(1)} t=${j.airtime.toFixed(1)} flips=${j.flips * j.flipDir} spins=${j.spins} grab=${j.grabs.join('')} loop=${j.kiteloop} ${j.reason ?? ''}`));
  g.listeners.crash.push((r) => window.__log.push(`CRASH ${r}`));
});
const hold = async (keys, ms) => { for (const k of keys) await page.keyboard.down(k); await page.waitForTimeout(ms); for (const k of keys.reverse()) await page.keyboard.up(k); };
const state = () => page.evaluate(() => { const g = window.__game, r = g.rig; return `${r.mode} ${(r.speed / 0.5144).toFixed(1)}kn kite=${r.kite.mode} elev=${(r.kite.elevation * 57.3).toFixed(0)} score=${Math.round(g.scoring.score)} fps=${Math.round(g.fps)}`; });
const waitRiding = async () => { await page.waitForFunction(() => window.__game.rig.mode === 'riding' && window.__game.rig.modeTime > 2.5, null, { timeout: 30000 }).catch(() => {}); };
await waitRiding();
console.log('riding:', await state());
// Plain jump
await hold(['Space'], 650); await page.waitForTimeout(4500); console.log('after jump:', await state());
await waitRiding();
// Back roll: send, then hold S in the air
await hold(['Space'], 650); await hold(['KeyS'], 1100); await page.waitForTimeout(3500); console.log('after back roll:', await state());
await waitRiding();
// Grab
await hold(['Space'], 650); await page.waitForTimeout(300); await hold(['ShiftLeft'], 1200); await page.waitForTimeout(3000);
await waitRiding();
// Kiteloop
await hold(['Space'], 600); await page.waitForTimeout(250); await hold(['KeyK'], 100); await page.waitForTimeout(5000); console.log('after kiteloop:', await state());
await waitRiding();
// Transition (carve toward the kite / downwind)
const side = await page.evaluate(() => window.__game.rig.kiteSide);
await hold([side > 0 ? 'KeyD' : 'KeyA'], 3500); await page.waitForTimeout(4000); console.log('after transition:', await state());
// Upwind
await hold([side > 0 ? 'KeyD' : 'KeyA'], 300);
await page.waitForTimeout(3000);
// Over-rotate to force a crash
await waitRiding();
await hold(['Space'], 650); await hold(['KeyW'], 600); await page.waitForTimeout(4000); console.log('after forced crash:', await state());
await page.waitForTimeout(8000); console.log('recovered?', await state());
console.log((await page.evaluate(() => window.__log)).join('\n'));
await page.screenshot({ path: '.qa/playtest-end.png' });
console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no console errors');
await browser.close();
