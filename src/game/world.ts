import * as THREE from 'three';
import type { TerrainData } from '../world/terrainData.ts';
import { Terrain } from '../world/terrain.ts';
import { Water } from '../world/water.ts';
import { Sky, type SkyState } from '../world/sky.ts';
import { Wind, type WindSettings } from '../world/wind.ts';
import { Waves } from '../world/waves.ts';
import type { RigEnv } from '../sim/rig.ts';
import { Vegetation } from '../world/vegetation.ts';
import { Village } from '../world/village.ts';
import { Wildlife } from '../world/wildlife.ts';
import { headingOf } from '../core/math.ts';

/** Everything static or global about the bay: terrain, sea, sky, wind and waves. */
export class World {
  readonly scene = new THREE.Scene();
  readonly fog = new THREE.FogExp2(0xcfe6f3, 2.4e-5);
  readonly data: TerrainData;
  readonly terrain: Terrain;
  readonly water: Water;
  readonly sky: Sky;
  readonly wind: Wind;
  readonly waves = new Waves();
  readonly env: RigEnv;
  readonly vegetation: Vegetation;
  readonly village: Village;
  readonly wildlife: Wildlife;
  skyState: SkyState;
  hours = 13;
  dayOfYear = 15;

  constructor(data: TerrainData, windSettings: WindSettings) {
    this.data = data;
    this.scene.fog = this.fog;
    this.wind = new Wind(windSettings);
    this.sky = new Sky(this.scene);
    this.skyState = this.sky.state;
    this.terrain = new Terrain(data);
    this.scene.add(this.terrain.group);
    this.water = new Water(data, this.wind);
    this.scene.add(this.water.mesh);
    const waves = this.waves;
    this.env = {
      wind: this.wind,
      waves,
      sdf: (x, z) => data.sdf(x, z),
      depth: (x, z) => data.depth(x, z),
      surface: (x, z) => waves.height(x, z, Waves.depthFactor(data.depth(x, z))),
    };
    this.wind.update(0, this.hours);
    this.waves.update(0, this.wind.base, this.downwindHeading);
    this.vegetation = new Vegetation(data);
    this.scene.add(this.vegetation.group);
    this.village = new Village(data);
    this.scene.add(this.village.group);
    this.wildlife = new Wildlife(data, { month: 2, surface: (x, z) => this.env.surface(x, z) });
    this.scene.add(this.wildlife.group);
  }

  get downwindHeading() {
    return headingOf(this.wind.downwindX, this.wind.downwindZ);
  }

  setWind(settings: WindSettings) {
    this.wind.settings = { ...settings };
    this.wind.update(0, this.hours);
    this.waves.amplitude = 0;
    this.waves.update(0, this.wind.base, this.downwindHeading);
  }

  /** Advances wind and waves (simulation time). */
  step(dt: number) {
    this.wind.update(dt, this.hours);
    this.waves.update(dt, this.wind.base, this.downwindHeading);
  }

  /** Lighting, sky and water uniforms for the current clock and camera. */
  updateVisuals(dt: number, time: number, camera: THREE.Camera, focus: THREE.Vector3) {
    this.vegetation.update(camera);
    this.village.update(dt, time, camera, this.wind.downwindX * this.wind.base, this.wind.downwindZ * this.wind.base);
    this.wildlife.update(dt, time, focus, camera);
    this.sky.dayOfYear = this.dayOfYear;
    const s = this.sky.update(this.hours, time, camera, focus, this.fog);
    this.skyState = s;
    const amb = this.sky.hemi.intensity;
    this.terrain.setLighting(s.sunDir, s.sunColor, s.sunIntensity, s.ambientSky, s.ambientGround, amb);
    this.water.update(camera, this.waves, this.wind, s, amb);
  }

  surface(x: number, z: number) {
    return this.env.surface(x, z);
  }

  groundOrWater(x: number, z: number) {
    return Math.max(this.data.height(x, z), 0);
  }
}
