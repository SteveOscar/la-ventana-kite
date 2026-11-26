import * as THREE from 'three';
import type { TerrainData } from './terrainData.ts';

/** Desert plants on the hills and coastal plain: cardón, pitaya, palo verde, scrub, palms. */
export class Vegetation {
  readonly group = new THREE.Group();

  constructor(data: TerrainData) {
    void data;
    this.group.name = 'vegetation';
  }

  update(camera: THREE.Camera) {
    void camera;
  }
}
