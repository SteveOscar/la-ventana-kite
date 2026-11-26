import * as THREE from 'three';
import type { TerrainData } from './terrainData.ts';

export interface WildlifeOptions {
  /** Index into MONTHS in content/culture.ts (0 = Noviembre .. 5 = Abril). */
  month: number;
  /** Water surface height (waves included) at a point. */
  surface(x: number, z: number): number;
}

/** Pelicans, frigatebirds, dolphins, whales and friends around the rider. */
export class Wildlife {
  readonly group = new THREE.Group();
  /** Called the first time the player gets a good look at a species (id from SPECIES). */
  onSighting: ((speciesId: string) => void) | null = null;

  constructor(data: TerrainData, opts: WildlifeOptions) {
    void data;
    void opts;
    this.group.name = 'wildlife';
  }

  setMonth(month: number) {
    void month;
  }

  /** `focus` is the player position; spawn things around it. */
  update(dt: number, time: number, focus: THREE.Vector3, camera: THREE.Camera) {
    void dt;
    void time;
    void focus;
    void camera;
  }
}
