# La Ventana Kite — architecture notes

Personal side project (not Govly). Vite + three.js r187 + TypeScript (erasable syntax only; imports use `.ts` extensions).

## Run / check
- Dev server: `npx vite --host 127.0.0.1 --port 5188` (usually already running; check `curl -s 127.0.0.1:5188`).
- Typecheck: `npm run typecheck` (must stay clean; `noUnusedLocals/Parameters` are on).
- Physics calibration (Node): `node tools/simcheck.ts 19 9` (knots, kite m²).
- Headless real-GPU screenshots: `node tools/smoke.mjs --query "<query>" --out .qa/<name>` (uses installed Google Chrome via Playwright).
  - `?play=free` starts a free session; `&spawn=x,z` puts the rider there; `&hours=17.2` sets the clock; `&wind=light|classic|strong`; `&kite=7|9|12`.
  - `?view=x,y,z,tx,ty,tz` renders from a fixed debug camera (title state, no HUD), e.g. `?view=300,25,-3200,-300,5,-3400`.
  - For a one-off still, prefer a small Playwright script: open the URL, wait for `window.__game.time > 2`, `page.screenshot(...)`.
  - The game object is `window.__game` (see `src/game/game.ts`).

## World coordinates
- Metres. **x = east, y = up, z = south** (north is −z). Origin = main kite beach in front of La Ventana village (24.0475 N, 109.9892 W).
- Compass headings: 0 = north, π/2 = east. Helpers in `src/core/math.ts` (`headingX/Z`, `headingOf`).
- Wind (El Norte) blows from ~NNE (fromDeg 12–20) toward SSW, i.e. roughly +z and slightly −x (side-onshore).
- The west shore of the bay runs north–south at x ≈ 0..+200 from z ≈ −12 km (north) to z ≈ +300; south of La Ventana the coast turns east toward Punta Arenas (x ≈ +16.4 km). Land is west (−x).
- Key spots: `data.world.landmarks` (mainBeach ≈ (108,−250), campNorth ≈ (132,−760), campSouth ≈ (876,620), elSargento ≈ (−228,−3400), hotSprings ≈ (−336,−5600), arroyo ≈ (−468,−6650), elJalito ≈ (−936,−8100), puntaArenas ≈ (16437,327), cerralvo island bbox x 5.3–19.3 km, z −36..−9.9 km, peak 775 m at (11670,−21260)).
- Villages: El Sargento spans z ≈ −6.3..−1.5 km, La Ventana z ≈ −1.5..+1 km; the main road (BCS 286) runs ~100–250 m inland, parallel to the beach (`data.world.mainRoad`).

## Data API (`src/world/terrainData.ts`, class `TerrainData`)
- `height(x,z)` terrain/seabed height (m; negative under water). `depth(x,z)` water depth ≥ 0.
- `sdf(x,z)` signed distance to the coastline in metres: **positive on land**, negative at sea.
- `overlayAt(x,z)` → `[road, sand, settled]` in 0..1 (5 m raster over the near grid): road ≈1 paved / ≈0.55 dirt / ≈0.3 path; sand = beach & arroyo beds; settled = building footprints (1) and yards (~0.45).
- `coastX(z)` x of the west shore at a given z (null where the coast turns east).
- `slope(x,z)`.
- `world.buildings`: `[x, z, width, depth, rotationRad, levels]` oriented rectangles from ~1,970 OSM footprints (rotation: the rect's width axis is rotated by `rot` from +x toward +z).
- `world.pois`: `{kind, x, z}` (restaurant, cafe, hotel, camp_site, caravan_site, school, fuel, ...). `world.areas`: pitch / school / camp_site / caravan_site / cemetery polygons.
- Near grid: x −5200..4400, z −12800..4800 at 12 m. Wide grid: 72 × 72 km at 70 m (includes Cerralvo).

## Rendering conventions
- Renderer: ACES filmic tone mapping, sRGB output, `reversedDepthBuffer: true`, shadows (one directional sun, shadow camera ±36 m around the player only — static scenery should not cast shadows).
- Scene fog: `FogExp2` (density ~2.4e-5) set by the sky each frame; built-in materials pick it up. Custom ShaderMaterials must include the fog chunks (see `src/world/terrain.ts`).
- Lights: `DirectionalLight` sun (intensity ~3.3 at midday) + `HemisphereLight`. Built-in materials (MeshStandard/MeshLambert) light correctly; prefer `MeshLambertMaterial` or `MeshStandardMaterial` with `vertexColors` for big merged geometry.
- Performance budget: the game must stay at 60 fps on an Apple M4 at 1440×900. Current base: ~45 draw calls, ~720k triangles. Use `InstancedMesh` / merged geometry; keep any one module under ~40 draw calls and ~400k triangles in view; chunk instancing spatially so frustum culling works.
- Art direction: warm, sunny, slightly stylised low-poly realism. Baja desert palette (ochre, tan, rust, grey-green scrub), turquoise water, Mexican village colours (pastel and saturated stucco: white, cream, terracotta, pink, turquoise, mustard, lilac, lime), black rooftop water tanks (tinacos), rebar on unfinished roofs, palapa (thatched palm) roofs, colourful pangas.

## Game structure
- `src/game/game.ts` — `Game`: loop, controls, session; `world: World`, `player: Kiter`, `cam: CameraRig`, `hud: Hud`, `audio: AudioEngine`.
- `src/game/world.ts` — `World`: terrain, water, sky, wind, waves; owns `vegetation`, `village`, `wildlife` (constructed once; `update(...)` each frame).
- `src/sim/*` — physics (kite on a 22 m line sphere, rig = rider/board, autopilot). `src/render/*` — rider/kite models, camera, effects.
- `src/content/culture.ts` — characters, Spanish lines, facts, species list, landmarks.
