# Dev notes

Working log for the La Ventana kite game. See `ARCHITECTURE.md` for coordinates, data API and conventions.

## Checks

- `npm run typecheck`, `npm test` (physics regression), `node tools/simcheck.ts 19 9`, `node tools/transition-check.ts 19 9`.
- `node tools/smoke.mjs` (screenshots + fps/cpu/draw calls), `node tools/playtest.mjs` (jumps, rolls, grabs, kiteloop, transition, crash, recovery).
- `npm run build` must succeed.

## Physics calibration (19 kn, 9 m, 78 kg, assisted)

- Waterstart about 1.2 s after the dive; beam reach about 16–17 kn; upwind limit about 45° off the wind (induced drag of the edge, `rig.ts`).
- Jumps: about 2.5–6 m and 3–4.5 s at 19 kn; 7–13 m at 25 kn; 1–2 m at 14 kn.
- Transitions: the autopilot lifts the kite to 12 while `assistCarve` slows the carve, then dives it on the new tack. The board "coasts" (lower drag) mid-transition.
- The anti-loft rule in `autopilot.ts` sheets out hard when the kite's vertical pull nears body weight (assisted mode only; Pro mode has no safety net).

## Gotchas found along the way

- The autopilot's U-turn logic dithered at 12 o'clock and pinned the kite there; it now commits to a turn direction, but only when the kite is slow (< 9 m/s). A fast kite with lead prediction looped through the power zone.
- AI riders can't waterstart pointing upwind; they reach first, then point up once planing. Big turns go through downwind (`carveToward`), never through the wind.
- Hidden menu buttons kept keyboard focus, so Space "clicked" them again; `Menus.hide()` blurs and clears.
- Vite reloads the page whenever a source file changes, so long browser tests restart if files are being edited.
- `vColor` in MeshStandardMaterial fragment shaders is a vec4 when vertex alpha is possible: use `vColor.rgb`.
