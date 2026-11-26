import * as THREE from 'three';
import type { TerrainData } from './terrainData.ts';
import { fbm2, lerp, mulberry32, noise2, smoothstep } from '../core/math.ts';
import { Habitat, type Env, type Rect } from './vegetation/habitat.ts';
import { INSTANCE_FLOATS as F, plantMaterial, setPlantMotion, updatePixelAngle } from './vegetation/material.ts';
import * as S from './vegetation/species.ts';

/** Instances of one species/variant bucketed into its generator's grid cells. */
interface Cell {
  /** F floats per instance, sorted by reach (descending) so far LODs can take a prefix. */
  data: Float32Array;
  count: number;
}

interface PlantSet {
  name: string;
  model: S.PlantModel;
  gen: Generator;
  cells: (Cell | null)[];
  total: number;
}

interface SpeciesSpec {
  /** Plants per hectare. */
  density: (e: Env, x: number, z: number) => number;
  /** Metres kept clear of roads, buildings and yards. */
  clear: number;
  /** Largest sand-overlay value tolerated at the spot (arroyo beds and beach). */
  sand: number;
  maxSlope: number;
  /** Size range as multiples of the model's reference size; skew > 1 favours small plants. */
  scale: [number, number];
  skew: number;
  tilt: number;
  /** Metres sunk below the mesh surface (slope adds more). */
  sink: number;
  /** Radius of the plant's base as a fraction of its crown width (for slope sinking). */
  footprint: number;
  tintVar: number;
  /** Fraction of FAR_MAX this plant stays visible to, from its height and a uniform u in (0, 1]. */
  reach: (height: number, u: number) => number;
}

interface Species extends SpeciesSpec {
  set: PlantSet;
}

interface Generator {
  name: string;
  region: Rect;
  cell: number;
  /** Sampling step on the detailed near grid and on the outer hills. */
  sub: number;
  subOuter: number;
  seed: number;
  streamed: boolean;
  /** Horizontal AABB padding for crowns that overhang the cell. */
  pad: number;
  species: Species[];
  sets: PlantSet[];
  nx: number;
  nz: number;
  done: Uint8Array;
  live: number[];
  y0: Float32Array;
  y1: Float32Array;
  /** Culling range; for streamed generators also the generation radius. */
  range: number;
  visIdx: Int32Array;
  visMin: Float32Array;
  visMax: Float32Array;
  visN: number;
}

interface Kind {
  name: string;
  base: THREE.BufferGeometry;
  mesh: THREE.Mesh;
  geo: THREE.InstancedBufferGeometry;
  buffer: THREE.InstancedInterleavedBuffer;
  capacity: number;
  sets: PlantSet[];
  start: number;
  end: number;
  max: number;
  /** Short-range LOD: filter straddling cells per instance instead of copying them whole. */
  fine: boolean;
  sig: number;
  count: number;
}

interface KindSpec {
  name: string;
  geometry: THREE.BufferGeometry;
  sets: PlantSet[];
  start: number;
  end?: number;
  max?: number;
  sway?: number;
  card?: boolean;
  cardUp?: number;
  minPx?: [number, number];
}

/** Vacant lots between houses keep a thin desert cover; buildings, yards and roads are excluded per spot. */
const notTown = (e: Env) => 1 - 0.7 * smoothstep(0.06, 0.35, e.town);
const landRamp = (e: Env) => smoothstep(45, 110, e.sdf);
const slopeFall = (e: Env, a: number, b: number) => 1 - smoothstep(a, b, e.slope);

/** Plants seen from the water: the near grid plus the hills behind it on the wide terrain mesh. */
const OUTER: Rect = { x0: -11200, z0: -14200, x1: 8000, z1: 8000 };
/** Share of the density generated on the outer hills; their reach grows to keep the same look from afar. */
const OUTER_DENSITY = 0.35;
/** Farthest any plant is drawn (m); per-instance reach scales it down. */
const FAR_MAX = 11000;
/** Dense ground cover is generated within this radius of the camera (bigger bushes are static). */
const SHRUB_RADIUS = 560;
const GRASS_MAX = 170;
/** Camera-facing cards take over from 3D models beyond these distances. */
const CARDON_CARD = 1400;
const CARD = 1400;

/**
 * Visibility reach that thins a population as 1/d^2 beyond `d0` metres, so distant hills keep a
 * constant speckle density on screen (cards never get smaller than a pixel).
 */
const thinned = (d0: number, size: number, u: number) => Math.min(1, ((d0 / FAR_MAX) * size) / Math.sqrt(u));
/** The same thinning for streamed ground cover, capped below the streaming radius. */
const groundReach = (d0: number, cap: number) => (h: number, u: number) => Math.min(cap, (d0 * lerp(0.7, 1.25, smoothstep(0.4, 2, h))) / Math.sqrt(u)) / FAR_MAX;

/** Desert plants on the hills and coastal plain: cardón, pitaya, cholla, palo verde, mesquite, torote, scrub. */
export class Vegetation {
  readonly group = new THREE.Group();
  /** Constructor time in ms (static placement + geometry). */
  readonly buildMs: number;
  private readonly hab: Habitat;
  private readonly gens: Generator[] = [];
  private readonly kinds: Kind[] = [];
  private readonly frustum = new THREE.Frustum();
  private readonly proj = new THREE.Matrix4();
  private readonly box = new THREE.Box3();
  private readonly env: Env = { h: 0, sdf: 0, slope: 0, north: 0, valley: 0, wash: 0, town: 0 };
  private readonly lastStream = new THREE.Vector2(Infinity, Infinity);
  private streamMs = 0;

  constructor(data: TerrainData) {
    const t0 = performance.now();
    this.group.name = 'vegetation';
    const hab = (this.hab = new Habitat(data, OUTER));

    const cardonA = S.cardonModel({ seed: 11, height: 12, radius: 0.5, arms: 9, branch: [1.0, 3.2], tops: [0.7, 0.98] });
    const cardonB = S.cardonModel({ seed: 23, height: 9.5, radius: 0.42, arms: 6, branch: [0.8, 2.8], tops: [0.6, 0.94] });
    const cardonC = S.cardonModel({ seed: 37, height: 5, radius: 0.32, arms: 0, branch: [2, 3], tops: [0.6, 0.8] });
    const pitaya = S.pitayaModel(41);
    const paloVerde = S.paloVerdeModel(53);
    const mesquite = S.mesquiteModel(67);
    const torote = S.toroteModel(71);
    const paloAdan = S.paloAdanModel(101);
    const lomboy = S.lomboyModel(103);
    const twigBush = S.twigBushModel(107);
    const agria = S.agriaModel(83);
    const cholla = S.chollaModel(97);
    const brittlebush = S.brittlebushModel(113);
    const creosote = S.creosoteModel(127);
    const bursage = S.bursageModel(131);
    const grass = S.grassModel(139);

    // ---- cardón: the skyline plant, static over the near grid and the hills behind it
    const gCardon = this.generator('cardon', OUTER, 500, 20, 50, 1001, false, 4);
    const cardonDensity = (e: Env, x: number, z: number) => {
      const patch = smoothstep(0.34, 0.74, fbm2(x / 380, z / 380, 2, 101));
      const fine = 0.45 + 1.1 * noise2(x / 70, z / 70, 102);
      const terrain = (0.8 + 0.6 * smoothstep(0.03, 0.2, e.slope)) * slopeFall(e, 0.55, 1.0);
      const coast = 0.35 + 0.65 * smoothstep(80, 450, e.sdf);
      const wash = 1 - 0.6 * smoothstep(0.25, 0.7, e.wash);
      const high = 1 - 0.5 * smoothstep(450, 800, e.h);
      return 5.5 * (0.07 + patch) * fine * terrain * coast * wash * high * notTown(e) * landRamp(e);
    };
    const cardonCommon = {
      clear: 5, sand: 0.12, maxSlope: 1.0, tilt: 0.04, sink: 0.25, footprint: 0.12, tintVar: 0.1,
      reach: (h: number, u: number) => thinned(2000, lerp(0.55, 1.1, smoothstep(3, 12, h)), u),
    };
    const sA = this.species(gCardon, 'cardonA', cardonA, { ...cardonCommon, density: (e, x, z) => 0.3 * cardonDensity(e, x, z), scale: [0.75, 1.15], skew: 1.2 });
    const sB = this.species(gCardon, 'cardonB', cardonB, { ...cardonCommon, density: (e, x, z) => 0.4 * cardonDensity(e, x, z), scale: [0.7, 1.2], skew: 1 });
    const sC = this.species(gCardon, 'cardonC', cardonC, { ...cardonCommon, density: (e, x, z) => 0.3 * cardonDensity(e, x, z), scale: [0.5, 1.25], skew: 1.3 });

    // ---- pitaya dulce and trees: static
    const gTrees = this.generator('trees', OUTER, 500, 20, 50, 2002, false, 5);
    const treeReach = (h: number, u: number) => thinned(2200, lerp(0.7, 1.1, smoothstep(2.5, 6, h)), u);
    const sPitaya = this.species(gTrees, 'pitaya', pitaya, {
      density: (e, x, z) => {
        const patch = smoothstep(0.35, 0.7, fbm2(x / 260, z / 260, 2, 201));
        const rocky = 0.6 + 0.8 * smoothstep(0.08, 0.35, e.slope);
        return 4 * (0.1 + patch) * rocky * slopeFall(e, 0.6, 1.0) * (1 - 0.5 * smoothstep(0.3, 0.8, e.wash)) * notTown(e) * landRamp(e);
      },
      clear: 4, sand: 0.12, maxSlope: 0.95, scale: [0.6, 1.3], skew: 1, tilt: 0.06, sink: 0.15, footprint: 0.25, tintVar: 0.1,
      reach: (h, u) => thinned(1800, lerp(0.7, 1, smoothstep(2.5, 5.5, h)), u),
    });
    const sPaloVerde = this.species(gTrees, 'paloVerde', paloVerde, {
      density: (e, x, z) => {
        const patch = 0.35 + 0.9 * fbm2(x / 200, z / 200, 2, 301);
        const water = 1 + 1.8 * smoothstep(0.1, 0.6, e.wash) + 0.6 * smoothstep(1, 5, e.valley);
        const aspect = 1 + 0.45 * Math.max(0, e.north) - 0.2 * Math.max(0, -e.north);
        return 2.6 * patch * water * aspect * slopeFall(e, 0.45, 0.75) * notTown(e) * landRamp(e);
      },
      clear: 5, sand: 0.15, maxSlope: 0.75, scale: [0.6, 1.2], skew: 1, tilt: 0.08, sink: 0.1, footprint: 0.05, tintVar: 0.12, reach: treeReach,
    });
    const sMesquite = this.species(gTrees, 'mesquite', mesquite, {
      density: (e, x, z) => {
        const water = 0.15 + 3.5 * smoothstep(0.15, 0.7, e.wash) + 1.2 * smoothstep(1.5, 6, e.valley);
        const flat = 1 - smoothstep(0.12, 0.35, e.slope);
        return 1.6 * water * flat * (0.5 + noise2(x / 150, z / 150, 302)) * notTown(e) * landRamp(e);
      },
      clear: 6, sand: 0.2, maxSlope: 0.5, scale: [0.55, 1.15], skew: 1, tilt: 0.1, sink: 0.1, footprint: 0.05, tintVar: 0.1, reach: treeReach,
    });
    const sTorote = this.species(gTrees, 'torote', torote, {
      density: (e, x, z) => {
        const rocky = smoothstep(0.08, 0.4, e.slope) + 0.6 * smoothstep(1, 6, -e.valley);
        const patch = 0.3 + fbm2(x / 240, z / 240, 2, 303);
        return 2.6 * (0.15 + rocky) * patch * slopeFall(e, 0.6, 0.95) * (1 - 0.4 * Math.max(0, e.north)) * notTown(e) * landRamp(e);
      },
      clear: 4, sand: 0.1, maxSlope: 0.95, scale: [0.6, 1.3], skew: 1.1, tilt: 0.08, sink: 0.12, footprint: 0.12, tintVar: 0.1, reach: treeReach,
    });

    // ---- the bigger thornscrub: static so it can speckle the far hills
    const gBush = this.generator('bushes', OUTER, 500, 25, 50, 2502, false, 3);
    const bushReach = (h: number, u: number) => thinned(2200, lerp(0.75, 1.1, smoothstep(1.2, 3, h)), u);
    const sLomboyBig = this.species(gBush, 'lomboyBig', lomboy, {
      density: (e, x, z) => {
        const patch = 0.3 + 1.2 * smoothstep(0.25, 0.7, fbm2(x / 160, z / 160, 2, 251));
        const aspect = 1 + 0.5 * Math.max(0, e.north);
        const water = 1 + 0.8 * smoothstep(0.1, 0.5, e.wash) + 0.3 * smoothstep(1, 5, e.valley);
        return 6 * patch * aspect * water * slopeFall(e, 0.7, 1.0) * notTown(e) * landRamp(e);
      },
      clear: 2.5, sand: 0.2, maxSlope: 1.0, scale: [0.8, 1.5], skew: 1, tilt: 0.06, sink: 0.08, footprint: 0.35, tintVar: 0.14, reach: bushReach,
    });
    const sTwigBig = this.species(gBush, 'twigBig', twigBush, {
      density: (e, x, z) => {
        const patch = 0.3 + 1.1 * fbm2(x / 130, z / 130, 2, 252);
        const rocky = 0.6 + smoothstep(0.1, 0.4, e.slope);
        return 5 * patch * rocky * slopeFall(e, 0.75, 1.0) * notTown(e) * landRamp(e);
      },
      clear: 2.5, sand: 0.2, maxSlope: 1.0, scale: [0.8, 1.5], skew: 1, tilt: 0.06, sink: 0.08, footprint: 0.3, tintVar: 0.12, reach: bushReach,
    });
    const sPaloAdan = this.species(gBush, 'paloAdan', paloAdan, {
      density: (e, x, z) => {
        const sl = smoothstep(0.06, 0.3, e.slope);
        const patch = 0.3 + fbm2(x / 220, z / 220, 2, 501);
        return 3 * (0.2 + sl) * patch * slopeFall(e, 0.7, 1.0) * notTown(e) * landRamp(e);
      },
      clear: 3, sand: 0.2, maxSlope: 0.9, scale: [0.6, 1.3], skew: 1, tilt: 0.08, sink: 0.05, footprint: 0.05, tintVar: 0.1, reach: bushReach,
    });

    // ---- ground cover: streamed around the camera on the near grid
    const coverReach = groundReach(150, SHRUB_RADIUS - 80);
    const gShrub = this.generator('shrubs', hab.near, 125, 8, 8, 4004, true, 3);
    gShrub.range = SHRUB_RADIUS;
    const sAgria = this.species(gShrub, 'agria', agria, {
      density: (e, x, z) => {
        const coastal = 0.6 + 1.2 * (1 - smoothstep(150, 900, e.sdf));
        const flat = 1 - smoothstep(0.2, 0.5, e.slope);
        const patch = smoothstep(0.35, 0.75, fbm2(x / 150, z / 150, 2, 401));
        return 5 * (0.15 + patch) * coastal * flat * notTown(e) * landRamp(e);
      },
      clear: 3, sand: 0.3, maxSlope: 0.6, scale: [0.5, 1.2], skew: 1, tilt: 0.04, sink: 0.08, footprint: 0.3, tintVar: 0.1,
      reach: coverReach,
    });
    const sCholla = this.species(gShrub, 'cholla', cholla, {
      density: (e, x, z) => {
        const patch = smoothstep(0.45, 0.8, fbm2(x / 180, z / 180, 2, 402));
        const flat = 1 - smoothstep(0.15, 0.45, e.slope);
        return (14 * patch * patch * flat * (1 - 0.7 * smoothstep(0.2, 0.6, e.wash)) + 0.3) * notTown(e) * landRamp(e);
      },
      clear: 3, sand: 0.2, maxSlope: 0.55, scale: [0.6, 1.4], skew: 1, tilt: 0.1, sink: 0.05, footprint: 0.08, tintVar: 0.08,
      reach: coverReach,
    });
    const sLomboy = this.species(gShrub, 'lomboy', lomboy, {
      density: (e, x, z) => {
        const patch = 0.2 + 1.3 * smoothstep(0.25, 0.7, fbm2(x / 90, z / 90, 2, 451));
        const aspect = 1 + 0.6 * Math.max(0, e.north);
        const water = 1 + 0.8 * smoothstep(0.1, 0.5, e.wash) + 0.4 * smoothstep(1, 4, e.valley);
        return 70 * patch * aspect * water * slopeFall(e, 0.75, 1.0) * notTown(e) * landRamp(e);
      },
      clear: 1.8, sand: 0.35, maxSlope: 1.0, scale: [0.45, 1.2], skew: 1.2, tilt: 0.06, sink: 0.06, footprint: 0.35, tintVar: 0.14,
      reach: coverReach,
    });
    const sTwig = this.species(gShrub, 'twigBush', twigBush, {
      density: (e, x, z) => {
        const patch = 0.25 + 1.2 * fbm2(x / 70, z / 70, 2, 452);
        return 55 * patch * (0.6 + smoothstep(0.05, 0.3, e.slope)) * slopeFall(e, 0.8, 1.0) * notTown(e) * landRamp(e);
      },
      clear: 1.8, sand: 0.35, maxSlope: 1.0, scale: [0.45, 1.2], skew: 1.2, tilt: 0.06, sink: 0.06, footprint: 0.3, tintVar: 0.12,
      reach: coverReach,
    });
    const sBrittle = this.species(gShrub, 'brittlebush', brittlebush, {
      density: (e, x, z) => {
        const rocky = 0.4 + smoothstep(0.05, 0.3, e.slope);
        const patch = 0.15 + 1.3 * smoothstep(0.3, 0.7, fbm2(x / 90, z / 90, 2, 502));
        const aspect = 1 + 0.5 * Math.max(0, -e.north);
        return 60 * rocky * patch * aspect * slopeFall(e, 0.7, 0.95) * notTown(e) * landRamp(e);
      },
      clear: 1.5, sand: 0.45, maxSlope: 0.95, scale: [0.55, 1.3], skew: 1, tilt: 0.06, sink: 0.05, footprint: 0.4, tintVar: 0.08,
      reach: coverReach,
    });
    const sCreosote = this.species(gShrub, 'creosote', creosote, {
      density: (e, x, z) => {
        const flat = 1 - smoothstep(0.08, 0.3, e.slope);
        const patch = 0.3 + 1.2 * smoothstep(0.3, 0.7, fbm2(x / 120, z / 120, 2, 503));
        return 25 * flat * patch * (1 - 0.6 * smoothstep(0.3, 0.8, e.wash)) * notTown(e) * landRamp(e);
      },
      clear: 2, sand: 0.3, maxSlope: 0.6, scale: [0.6, 1.3], skew: 1, tilt: 0.06, sink: 0.05, footprint: 0.15, tintVar: 0.1,
      reach: coverReach,
    });
    const sBursage = this.species(gShrub, 'bursage', bursage, {
      density: (e, x, z) => {
        const patch = 0.35 + 1.1 * fbm2(x / 60, z / 60, 2, 504);
        const water = 1 + 0.6 * smoothstep(0.1, 0.5, e.wash);
        return 110 * patch * water * slopeFall(e, 0.7, 1.0) * (0.35 + 0.65 * notTown(e)) * landRamp(e);
      },
      clear: 1.2, sand: 0.5, maxSlope: 1.0, scale: [0.5, 1.4], skew: 1.2, tilt: 0.08, sink: 0.04, footprint: 0.4, tintVar: 0.12,
      reach: groundReach(100, 300),
    });

    const gGrass = this.generator('grass', hab.near, 40, 4, 4, 5005, true, 0.5);
    gGrass.range = GRASS_MAX * 1.12;
    const sGrass = this.species(gGrass, 'grass', grass, {
      density: (e, x, z) => {
        const patch = smoothstep(0.3, 0.75, fbm2(x / 45, z / 45, 2, 601));
        return 320 * patch * slopeFall(e, 0.5, 0.8) * (0.35 + 0.65 * notTown(e)) * landRamp(e);
      },
      clear: 0.8, sand: 0.35, maxSlope: 0.8, scale: [0.6, 1.4], skew: 1, tilt: 0.1, sink: 0.04, footprint: 0.2, tintVar: 0.12,
      reach: () => 1,
    });

    for (const g of this.gens) if (!g.streamed) this.generateAll(g);

    // ---- draw kinds: one instanced draw each, near to far
    const cardonSets = [sA.set, sB.set, sC.set];
    for (const [name, set, model] of [
      ['cardonA', sA.set, cardonA],
      ['cardonB', sB.set, cardonB],
      ['cardonC', sC.set, cardonC],
    ] as const) {
      this.kind({ name: `${name}-near`, geometry: model.lods[0], sets: [set], start: 0, end: 100 });
      this.kind({ name: `${name}-mid`, geometry: model.lods[1], sets: [set], start: 100, end: 600 });
    }
    this.kind({ name: 'cardon-far', geometry: cardonB.lods[2], sets: cardonSets, start: 600, end: CARDON_CARD });
    this.kind({ name: 'cardon-card', geometry: S.cardGeometry(0.8, 0), sets: cardonSets, start: CARDON_CARD, card: true, cardUp: 0.2, minPx: [1, 2] });

    this.kind({ name: 'pitaya-near', geometry: pitaya.lods[0], sets: [sPitaya.set], start: 0, end: 200 });
    this.kind({ name: 'pitaya-mid', geometry: pitaya.lods[1], sets: [sPitaya.set], start: 200, end: 600 });
    this.kind({ name: 'pitaya-far', geometry: pitaya.lods[2], sets: [sPitaya.set], start: 600, end: CARD });
    const treeSets = [sPaloVerde.set, sMesquite.set, sTorote.set];
    this.kind({ name: 'paloVerde', geometry: paloVerde.lods[0], sets: [sPaloVerde.set], start: 0, end: 240, sway: 0.012 });
    this.kind({ name: 'mesquite', geometry: mesquite.lods[0], sets: [sMesquite.set], start: 0, end: 240, sway: 0.012 });
    this.kind({ name: 'torote', geometry: torote.lods[0], sets: [sTorote.set], start: 0, end: 240, sway: 0.008 });
    this.kind({ name: 'tree-mid', geometry: S.treeMidGeometry(5), sets: treeSets, start: 240, end: 700, sway: 0.01 });
    this.kind({ name: 'tree-far', geometry: S.treeFarGeometry(7), sets: treeSets, start: 700, end: CARD });

    const NEAR_SHRUB = 55;
    this.kind({ name: 'paloAdan', geometry: paloAdan.lods[0], sets: [sPaloAdan.set], start: 0, end: 250, sway: 0.02 });
    this.kind({ name: 'lomboy', geometry: lomboy.lods[0], sets: [sLomboyBig.set, sLomboy.set], start: 0, end: NEAR_SHRUB, sway: 0.025 });
    this.kind({ name: 'twigBush', geometry: twigBush.lods[0], sets: [sTwigBig.set, sTwig.set], start: 0, end: NEAR_SHRUB, sway: 0.025 });
    this.kind({ name: 'brittlebush', geometry: brittlebush.lods[0], sets: [sBrittle.set], start: 0, end: NEAR_SHRUB, sway: 0.03 });
    this.kind({ name: 'creosote', geometry: creosote.lods[0], sets: [sCreosote.set], start: 0, end: NEAR_SHRUB, sway: 0.03 });
    this.kind({ name: 'bursage', geometry: bursage.lods[0], sets: [sBursage.set], start: 0, end: NEAR_SHRUB, sway: 0.02 });
    this.kind({ name: 'agria', geometry: agria.lods[0], sets: [sAgria.set], start: 0, end: NEAR_SHRUB });
    this.kind({ name: 'cholla', geometry: cholla.lods[0], sets: [sCholla.set], start: 0, end: NEAR_SHRUB });
    const midShrubSets = [sLomboyBig.set, sTwigBig.set, sLomboy.set, sTwig.set, sBrittle.set, sCreosote.set, sBursage.set, sAgria.set, sCholla.set];
    this.kind({ name: 'bush-mid', geometry: S.bushMidGeometry(9), sets: midShrubSets, start: NEAR_SHRUB, end: 200, sway: 0.02 });
    this.kind({ name: 'bush-far', geometry: S.shrubFarGeometry(), sets: [...midShrubSets, sPaloAdan.set], start: 200, end: CARD });
    this.kind({
      name: 'stipple',
      geometry: S.cardGeometry(0.7, -0.05, 0.55, 0.8),
      sets: [sPitaya.set, ...treeSets, sLomboyBig.set, sTwigBig.set, sPaloAdan.set],
      start: CARD,
      card: true,
      cardUp: 0.45,
      minPx: [2.2, 1.8],
    });
    this.kind({ name: 'grass', geometry: grass.lods[0], sets: [sGrass.set], start: 0, max: GRASS_MAX, sway: 0.06 });

    for (const k of this.kinds) {
      for (const s of k.sets) if (!s.gen.streamed) s.gen.range = Math.max(s.gen.range, k.max * 1.12);
    }
    this.buildMs = performance.now() - t0;
  }

  private generator(name: string, region: Rect, cell: number, sub: number, subOuter: number, seed: number, streamed: boolean, pad: number): Generator {
    const nx = Math.ceil((region.x1 - region.x0) / cell);
    const nz = Math.ceil((region.z1 - region.z0) / cell);
    const g: Generator = {
      name, region, cell, sub, subOuter, seed, streamed, pad,
      species: [], sets: [], nx, nz,
      done: new Uint8Array(nx * nz),
      live: [],
      y0: new Float32Array(nx * nz).fill(NaN),
      y1: new Float32Array(nx * nz).fill(NaN),
      range: 0,
      visIdx: new Int32Array(nx * nz),
      visMin: new Float32Array(nx * nz),
      visMax: new Float32Array(nx * nz),
      visN: 0,
    };
    this.gens.push(g);
    return g;
  }

  private species(g: Generator, name: string, model: S.PlantModel, spec: SpeciesSpec): Species {
    const set: PlantSet = { name, model, gen: g, cells: new Array(g.nx * g.nz).fill(null), total: 0 };
    const sp: Species = { ...spec, set };
    g.species.push(sp);
    g.sets.push(set);
    return sp;
  }

  private kind(k: KindSpec) {
    const capacity = Math.max(64, k.sets.reduce((n, s) => n + (s.gen.streamed ? 2048 : s.total), 0));
    const end = k.end ?? 1e9;
    const max = k.max ?? FAR_MAX;
    const material = plantMaterial({
      lodStart: k.start,
      lodEnd: end,
      maxDistance: max,
      fade: 0.15,
      grow: 0,
      sway: k.sway ?? 0,
      card: k.card ?? false,
      cardUp: k.cardUp ?? 0.7,
      minPx: k.minPx ?? [0, 0],
    });
    const { geo, buffer } = instancedGeometry(k.geometry, capacity);
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = `veg-${k.name}`;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.visible = false;
    mesh.onBeforeRender = (renderer, _scene, camera) => updatePixelAngle(renderer, camera);
    this.group.add(mesh);
    const fine = Math.min(end, max) <= 1000;
    this.kinds.push({ name: k.name, base: k.geometry, mesh, geo, buffer, capacity, sets: k.sets, start: k.start, end, max, fine, sig: 0, count: 0 });
  }

  private generateAll(g: Generator) {
    for (let iz = 0; iz < g.nz; iz++) for (let ix = 0; ix < g.nx; ix++) this.generateCell(g, ix, iz);
  }

  private generateCell(g: Generator, ix: number, iz: number) {
    const hab = this.hab;
    const k = iz * g.nx + ix;
    g.done[k] = 1;
    if (g.streamed) g.live.push(k);
    const x0 = g.region.x0 + ix * g.cell, z0 = g.region.z0 + iz * g.cell;
    // Whole cell well out at sea: nothing to place.
    if (hab.sdf(x0 + g.cell / 2, z0 + g.cell / 2) < 30 - g.cell * 0.75) return;
    const n0 = hab.near;
    const touchesNear = x0 + g.cell > n0.x0 && x0 < n0.x1 && z0 + g.cell > n0.z0 && z0 < n0.z1;
    const sub = touchesNear ? g.sub : g.subOuter;
    const rng = mulberry32(cellSeed(g.seed, ix, iz));
    const ns = Math.round(g.cell / sub);
    const sp = g.species;
    const out: number[][] = sp.map(() => []);
    const dens = new Float64Array(sp.length);
    const env = this.env;
    const area = (sub * sub) / 10000;
    for (let sj = 0; sj < ns; sj++) {
      for (let si = 0; si < ns; si++) {
        const sx = x0 + (si + 0.5) * sub, sz = z0 + (sj + 0.5) * sub;
        if (hab.sdf(sx, sz) < 40 - sub) continue;
        const outer = !hab.isNear(sx, sz);
        if (outer && hab.onIsland(sx, sz)) continue;
        hab.env(sx, sz, env);
        let total = 0;
        for (let q = 0; q < sp.length; q++) {
          const d = Math.max(0, sp[q].density(env, sx, sz));
          dens[q] = d;
          total += d;
        }
        if (total <= 0) continue;
        const expected = total * area * (outer ? OUTER_DENSITY : 1);
        let n = Math.floor(expected);
        if (rng() < expected - n) n++;
        for (let t = 0; t < n; t++) {
          const px = x0 + (si + rng()) * sub, pz = z0 + (sj + rng()) * sub;
          let r = rng() * total, q = 0;
          while (q < sp.length - 1 && r >= dens[q]) {
            r -= dens[q];
            q++;
          }
          const s = sp[q];
          if (hab.sdf(px, pz) < 45) continue;
          const slope = hab.slope(px, pz);
          if (slope > s.maxSlope) continue;
          if (hab.overlay(px, pz, 1) > s.sand) continue;
          if (!hab.clearOfTown(px, pz, s.clear)) continue;
          if (hab.inArea(px, pz)) continue;
          this.place(s, rng, px, pz, slope, outer ? OUTER_DENSITY : 1, out[q]);
        }
      }
    }
    let y0 = Infinity, y1 = -Infinity;
    for (let q = 0; q < sp.length; q++) {
      const arr = out[q];
      const count = arr.length / F;
      if (count === 0) continue;
      const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => arr[b * F + 11] - arr[a * F + 11]);
      const data = new Float32Array(count * F);
      for (let i = 0; i < count; i++) {
        const src = order[i] * F;
        for (let f = 0; f < F; f++) data[i * F + f] = arr[src + f];
        y0 = Math.min(y0, data[i * F + 1] - 1);
        y1 = Math.max(y1, data[i * F + 1] + data[i * F + 5] + 1);
      }
      sp[q].set.cells[k] = { data, count };
      sp[q].set.total += count;
    }
    if (y1 > y0) {
      g.y0[k] = y0;
      g.y1[k] = y1;
    }
  }

  /** `kept` is the share of the full density generated here; reach grows to compensate. */
  private place(s: Species, rng: () => number, x: number, z: number, slope: number, kept: number, out: number[]) {
    const m = s.set.model;
    const u = Math.pow(rng(), s.skew);
    const k = lerp(s.scale[0], s.scale[1], u);
    const height = m.height * k * (0.93 + 0.14 * rng());
    const width = m.width * k * (0.88 + 0.24 * rng());
    const y = this.hab.ground(x, z) - s.sink * Math.min(2, k) - Math.min(1.5, slope * width * s.footprint);
    const b = 1 + (rng() * 2 - 1) * s.tintVar;
    const hue = (rng() * 2 - 1) * s.tintVar * 0.5;
    const reach = s.reach(height, (1 - rng()) * kept);
    out.push(
      x, y, z, rng() * Math.PI * 2,
      width, height, (rng() * 2 - 1) * s.tilt, (rng() * 2 - 1) * s.tilt,
      m.base[0] * b * (1 + hue), m.base[1] * b, m.base[2] * b * (1 - hue), reach,
    );
  }

  /** Generates streamed cells near the camera (nearest first, time-boxed) and frees far ones. */
  private stream(cx: number, cz: number) {
    const jumped = Math.hypot(cx - this.lastStream.x, cz - this.lastStream.y) > 400;
    this.lastStream.set(cx, cz);
    const budget = jumped ? 60 : 3;
    const t0 = performance.now();
    const todo: { g: Generator; ix: number; iz: number; d: number }[] = [];
    for (const g of this.gens) {
      if (!g.streamed) continue;
      const R = g.range;
      const { x0, z0 } = g.region;
      const keep: number[] = [];
      for (const k of g.live) {
        const ix = k % g.nx, iz = (k - ix) / g.nx;
        if (rectDistance(cx, cz, x0 + ix * g.cell, z0 + iz * g.cell, g.cell) > R * 1.5) {
          g.done[k] = 0;
          g.y0[k] = g.y1[k] = NaN;
          for (const s of g.sets) {
            const c = s.cells[k];
            if (c) s.total -= c.count;
            s.cells[k] = null;
          }
        } else keep.push(k);
      }
      g.live = keep;
      const i0 = Math.max(0, Math.floor((cx - R - x0) / g.cell)), i1 = Math.min(g.nx - 1, Math.floor((cx + R - x0) / g.cell));
      const j0 = Math.max(0, Math.floor((cz - R - z0) / g.cell)), j1 = Math.min(g.nz - 1, Math.floor((cz + R - z0) / g.cell));
      for (let iz = j0; iz <= j1; iz++) {
        for (let ix = i0; ix <= i1; ix++) {
          if (g.done[iz * g.nx + ix]) continue;
          const d = rectDistance(cx, cz, x0 + ix * g.cell, z0 + iz * g.cell, g.cell);
          if (d < R) todo.push({ g, ix, iz, d: d / R });
        }
      }
    }
    if (!todo.length) return;
    todo.sort((a, b) => a.d - b.d);
    for (const t of todo) {
      this.generateCell(t.g, t.ix, t.iz);
      if (performance.now() - t0 > budget) break;
    }
    this.streamMs += performance.now() - t0;
  }

  private cull(g: Generator, cx: number, cy: number, cz: number) {
    const R = g.range;
    const { x0, z0 } = g.region;
    const i0 = Math.max(0, Math.floor((cx - R - x0) / g.cell)), i1 = Math.min(g.nx - 1, Math.floor((cx + R - x0) / g.cell));
    const j0 = Math.max(0, Math.floor((cz - R - z0) / g.cell)), j1 = Math.min(g.nz - 1, Math.floor((cz + R - z0) / g.cell));
    let n = 0;
    const box = this.box;
    for (let iz = j0; iz <= j1; iz++) {
      for (let ix = i0; ix <= i1; ix++) {
        const k = iz * g.nx + ix;
        const y0 = g.y0[k];
        if (!(y0 === y0)) continue;
        const y1 = g.y1[k];
        const bx0 = x0 + ix * g.cell - g.pad, bx1 = bx0 + g.cell + 2 * g.pad;
        const bz0 = z0 + iz * g.cell - g.pad, bz1 = bz0 + g.cell + 2 * g.pad;
        const dx = Math.max(bx0 - cx, 0, cx - bx1), dy = Math.max(y0 - cy, 0, cy - y1), dz = Math.max(bz0 - cz, 0, cz - bz1);
        const dmin = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dmin > R) continue;
        box.min.set(bx0, y0, bz0);
        box.max.set(bx1, y1, bz1);
        if (!this.frustum.intersectsBox(box)) continue;
        const fx = Math.max(Math.abs(cx - bx0), Math.abs(cx - bx1)), fy = Math.max(Math.abs(cy - y0), Math.abs(cy - y1)), fz = Math.max(Math.abs(cz - bz0), Math.abs(cz - bz1));
        g.visIdx[n] = k;
        g.visMin[n] = dmin;
        g.visMax[n] = Math.sqrt(fx * fx + fy * fy + fz * fz);
        n++;
      }
    }
    g.visN = n;
  }

  /** Copies the instances of visible cells into the kind's buffer when the visible set changed. */
  private pack(kind: Kind, cx: number, cy: number, cz: number) {
    let sig = 2166136261, total = 0;
    const lo = kind.start * 0.87, hi = kind.end * 1.13;
    // First pass: an upper bound on the count and, for bulk kinds, the exact signature.
    let bound = 0;
    for (let si = 0; si < kind.sets.length; si++) {
      const set = kind.sets[si];
      const g = set.gen;
      for (let v = 0; v < g.visN; v++) {
        const dmin = g.visMin[v];
        if (g.visMax[v] < lo || dmin > hi) continue;
        const c = set.cells[g.visIdx[v]];
        if (!c) continue;
        const n = reachCount(c, dmin / kind.max);
        if (n === 0) continue;
        bound += n;
        if (!kind.fine) {
          sig = Math.imul(sig ^ (si * 1000003 + g.visIdx[v]), 16777619);
          sig = Math.imul(sig ^ n, 16777619);
        }
      }
    }
    if (!kind.fine && sig === kind.sig && bound === kind.count) return;
    if (bound > kind.capacity) this.grow(kind, bound);
    const arr = kind.buffer.array as Float32Array;
    let o = 0;
    for (let si = 0; si < kind.sets.length; si++) {
      const set = kind.sets[si];
      const g = set.gen;
      for (let v = 0; v < g.visN; v++) {
        const dmin = g.visMin[v], dmax = g.visMax[v];
        if (dmax < lo || dmin > hi) continue;
        const k = g.visIdx[v];
        const c = set.cells[k];
        if (!c) continue;
        const n = reachCount(c, dmin / kind.max);
        if (n === 0) continue;
        const d = c.data;
        if (!kind.fine || (dmin >= lo && dmax <= hi)) {
          arr.set(n === c.count ? d : d.subarray(0, n * F), o);
          o += n * F;
          total += n;
          if (kind.fine) {
            sig = Math.imul(sig ^ (si * 1000003 + k), 16777619);
            sig = Math.imul(sig ^ n, 16777619);
          }
          continue;
        }
        // Cell straddles this LOD's range: keep only the instances that can show in it.
        for (let i = 0; i < n; i++) {
          const b = i * F;
          const dx = d[b] - cx, dy = d[b + 1] - cy, dz = d[b + 2] - cz;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (dist < lo || dist > hi || dist > kind.max * d[b + 11]) continue;
          for (let f = 0; f < F; f++) arr[o + f] = d[b + f];
          o += F;
          total++;
          sig = Math.imul(sig ^ (si * 1000003 + k * 8191 + i), 16777619);
        }
      }
    }
    if (sig === kind.sig && total === kind.count) return;
    kind.sig = sig;
    kind.count = total;
    kind.buffer.clearUpdateRanges();
    if (o > 0) {
      kind.buffer.addUpdateRange(0, o);
      kind.buffer.needsUpdate = true;
    }
    kind.geo.instanceCount = total;
    kind.mesh.visible = total > 0;
  }

  private grow(kind: Kind, need: number) {
    const capacity = Math.max(need, Math.ceil(kind.capacity * 1.6));
    const old = kind.geo;
    const { geo, buffer } = instancedGeometry(kind.base, capacity);
    kind.geo = geo;
    kind.buffer = buffer;
    kind.capacity = capacity;
    kind.mesh.geometry = geo;
    // Detach the shared base attributes so disposing frees only the old instance buffer.
    for (const name of ['position', 'normal', 'color']) old.deleteAttribute(name);
    old.setIndex(null);
    old.dispose();
  }

  update(camera: THREE.Camera) {
    camera.updateMatrixWorld();
    this.proj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.proj, THREE.WebGLCoordinateSystem, camera.reversedDepth);
    const e = camera.matrixWorld.elements;
    const cx = e[12], cy = e[13], cz = e[14];
    setPlantMotion((performance.now() / 1000) % 10000, -0.28, 0.96);
    this.stream(cx, cz);
    for (const g of this.gens) this.cull(g, cx, cy, cz);
    for (const k of this.kinds) this.pack(k, cx, cy, cz);
  }

  /** Debug/QA summary: instance totals, visible instances and triangles per kind. */
  stats() {
    const sets: Record<string, number> = {};
    for (const g of this.gens) for (const s of g.sets) sets[s.name] = s.total;
    let calls = 0, tris = 0;
    const kinds: Record<string, [number, number]> = {};
    for (const k of this.kinds) {
      if (!k.mesh.visible) continue;
      const t = (k.base.index!.count / 3) * k.count;
      kinds[k.name] = [k.count, t];
      calls++;
      tris += t;
    }
    return { buildMs: Math.round(this.buildMs), streamMs: Math.round(this.streamMs), sets, calls, tris, kinds };
  }
}

function instancedGeometry(base: THREE.BufferGeometry, capacity: number) {
  const buffer = new THREE.InstancedInterleavedBuffer(new Float32Array(capacity * F), F, 1);
  buffer.setUsage(THREE.DynamicDrawUsage);
  const geo = new THREE.InstancedBufferGeometry();
  geo.setIndex(base.index);
  for (const name of ['position', 'normal', 'color']) geo.setAttribute(name, base.getAttribute(name));
  geo.setAttribute('aI0', new THREE.InterleavedBufferAttribute(buffer, 4, 0));
  geo.setAttribute('aI1', new THREE.InterleavedBufferAttribute(buffer, 4, 4));
  geo.setAttribute('aI2', new THREE.InterleavedBufferAttribute(buffer, 4, 8));
  geo.instanceCount = 0;
  return { geo, buffer };
}

/** Number of leading instances whose reach still covers `minReach` (data is sorted by reach). */
function reachCount(c: Cell, minReach: number) {
  const d = c.data;
  if (d[11] <= minReach) return 0;
  if (d[(c.count - 1) * F + 11] > minReach) return c.count;
  let lo = 0, hi = c.count - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (d[mid * F + 11] > minReach) lo = mid;
    else hi = mid;
  }
  return hi;
}

function rectDistance(x: number, z: number, x0: number, z0: number, size: number) {
  const dx = Math.max(x0 - x, 0, x - (x0 + size));
  const dz = Math.max(z0 - z, 0, z - (z0 + size));
  return Math.hypot(dx, dz);
}

function cellSeed(seed: number, ix: number, iz: number) {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(ix + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(iz + 0x27d4eb2f, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}
