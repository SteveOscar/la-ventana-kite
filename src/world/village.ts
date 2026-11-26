import * as THREE from 'three';
import type { TerrainData } from './terrainData.ts';
import { mulberry32 } from '../core/math.ts';
import { buildAtlas } from './village/atlas.ts';
import { LineBuilder, MeshBuilder } from './village/builder.ts';
import { ChunkSet } from './village/chunks.ts';
import { makeAnimatedMaterial, makeLineMaterial, makePalmMaterial, makeStaticMaterial, makeUniforms } from './village/materials.ts';
import { Site } from './village/site.ts';
import { HouseFactory } from './village/houses.ts';
import { buildChapel, findChapelSite } from './village/chapel.ts';
import { BeachLife } from './village/beach.ts';
import { Campground } from './village/camp.ts';
import { PowerLines } from './village/power.ts';
import { Palms } from './village/palms.ts';
import { furnishStreets } from './village/streets.ts';

const FINE = 1100;
const COARSE = 3600;
/** Beyond this distance from a chunk's bounds its houses switch to box stand-ins. */
const LOD_DISTANCE = 650;

/** El Sargento and La Ventana: houses, chapel, palapas, pangas, campground, beach life. */
export class Village {
  readonly group = new THREE.Group();
  /** Constructor time in ms (for profiling). */
  readonly buildMs: number;
  readonly stats: Record<string, number> = {};
  /** Where the chapel ended up (front facade centre), for cameras and missions. */
  readonly chapel: { x: number; z: number; yaw: number } | null;
  private readonly uniforms = makeUniforms();
  private readonly lodChunks: { full: THREE.Mesh; lod: THREE.Mesh; center: THREE.Vector3; radius: number }[] = [];

  constructor(data: TerrainData) {
    const t0 = performance.now();
    this.group.name = 'village';
    const atlas = buildAtlas();
    const site = new Site(data);

    // Fine chunks where buildings are dense; everything else folds into coarse ones.
    const counts = new Map<number, number>();
    for (const [x, z] of data.world.buildings) {
      const k = ChunkSet.fineKey(x, z, FINE);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const dense = new Set<number>();
    for (const [k, n] of counts) if (n >= 25) dense.add(k);
    const chunks = new ChunkSet(atlas.plain, dense, FINE, COARSE);
    const anim = new MeshBuilder(true, atlas.plain, 32768);
    const lines = new LineBuilder();

    // Chapel near El Sargento's centre, on a free lot facing the highway.
    const chapelSite = findChapelSite(site, -380, -3330);
    this.chapel = chapelSite;
    if (chapelSite) {
      buildChapel(chunks.at(chapelSite.x, chapelSite.z), atlas, site, chapelSite);
      const c = Math.cos(chapelSite.yaw), s = Math.sin(chapelSite.yaw);
      for (let lx = -15; lx <= 6.5; lx += 3) for (let lz = -7; lz <= 6; lz += 3) site.occupy(chapelSite.x + c * lx - s * lz, chapelSite.z + s * lx + c * lz, 2);
    }

    const houses = new HouseFactory(site, atlas, chunks, lines);
    chunks.beginHouses();
    houses.buildAll();
    chunks.endHouses();
    const beach = new BeachLife(site, atlas, chunks, anim);
    beach.build();
    const camp = new Campground(site, atlas, chunks, houses, beach, anim);
    camp.build();
    const power = new PowerLines(site, chunks, lines, houses.houses);
    power.build();

    // Palms, parked pickups, neighbours and dogs between the houses.
    const rnd = mulberry32(5150);
    const palms = new Palms(site);
    const cars = furnishStreets({
      data,
      site,
      chunks,
      houses: houses.houses,
      beach,
      palms,
      palmSpots: [...beach.palms, ...camp.palms],
      chapel: chapelSite,
      rnd,
    });

    // Meshes.
    const staticMat = makeStaticMaterial(atlas.texture);
    for (const ch of chunks.build(staticMat, 'village-static')) {
      this.group.add(ch.full);
      if (ch.lod) {
        this.group.add(ch.lod);
        this.lodChunks.push({ full: ch.full, lod: ch.lod, center: ch.center, radius: ch.radius });
      }
    }
    if (anim.ni > 0) {
      const { geometry, center } = anim.build();
      const mesh = new THREE.Mesh(geometry, makeAnimatedMaterial(atlas.texture, this.uniforms));
      mesh.position.copy(center);
      mesh.name = 'village-life';
      // Vertex animation moves cloth and boats a few metres at most.
      geometry.boundingSphere!.radius += 6;
      mesh.castShadow = false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.group.add(mesh);
    }
    const wires = lines.build();
    const lineMesh = new THREE.LineSegments(wires.geometry, makeLineMaterial());
    lineMesh.position.copy(wires.center);
    lineMesh.name = 'village-wires';
    lineMesh.matrixAutoUpdate = false;
    lineMesh.updateMatrix();
    this.group.add(lineMesh);
    for (const m of palms.build(makePalmMaterial(this.uniforms), rnd)) this.group.add(m);

    Object.assign(this.stats, houses.stats, {
      meshes: this.group.children.length,
      staticTris: chunks.triangles,
      lodHouseTris: chunks.lodTriangles,
      animTris: anim.triangles,
      lineSegs: lines.pos.length / 6,
      poles: power.poles,
      cars,
      fanPalms: palms.count[0],
      datePalms: palms.count[1],
      chapel: chapelSite ? 1 : 0,
      ...prefix('beach', beach.stats),
      ...prefix('camp', camp.stats),
    });
    this.buildMs = performance.now() - t0;
  }

  update(dt: number, time: number, camera: THREE.Camera, windX: number, windZ: number) {
    void dt;
    this.uniforms.uTime.value = time;
    this.uniforms.uWind.value.set(windX, windZ);
    const cam = camera.position;
    for (const ch of this.lodChunks) {
      const near = cam.distanceTo(ch.center) - ch.radius < LOD_DISTANCE;
      ch.full.visible = near;
      ch.lod.visible = !near;
    }
  }
}

function prefix(p: string, o: Record<string, number>) {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(o)) out[`${p}.${k}`] = v;
  return out;
}
