import * as THREE from 'three';
import type { TerrainData } from './terrainData.ts';

/** El Sargento and La Ventana: houses, chapel, palapas, pangas, campground, beach life. */
export class Village {
  readonly group = new THREE.Group();

  constructor(data: TerrainData) {
    void data;
    this.group.name = 'village';
  }

  update(dt: number, time: number, camera: THREE.Camera, windX: number, windZ: number) {
    void dt;
    void time;
    void camera;
    void windX;
    void windZ;
  }
}
