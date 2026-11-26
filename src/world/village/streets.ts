import type { TerrainData } from '../terrainData.ts';
import type { ChunkSet } from './chunks.ts';
import { FACE_N, type HouseInfo } from './houses.ts';
import type { BeachLife, PalmSpot } from './beach.ts';
import { pickupTruck, smallCar } from './camp.ts';
import type { Palms } from './palms.ts';
import { type Site, rr } from './site.ts';
import type { ChapelSite } from './chapel.ts';

export interface StreetInputs {
  data: TerrainData;
  site: Site;
  chunks: ChunkSet;
  houses: HouseInfo[];
  beach: BeachLife;
  palms: Palms;
  palmSpots: PalmSpot[];
  chapel: ChapelSite | null;
  rnd: () => number;
}

const POI_PALMS = new Set(['restaurant', 'cafe', 'hotel', 'guest_house', 'hostel', 'chalet', 'camp_site', 'caravan_site', 'fast_food', 'school']);
const inVillage = (z: number) => z > -6300 && z < 1100;

/** World position of a point given in a house's local frame. */
function local(h: HouseInfo, lx: number, lz: number): [number, number] {
  const c = Math.cos(h.rot), s = Math.sin(h.rot);
  return [h.x + c * lx - s * lz, h.z + s * lx + c * lz];
}

/**
 * Everything that lives between the houses: palms in yards and by
 * restaurants, pickups parked along the fronts, neighbours at their doors and
 * dogs dozing in the shade. Returns the number of parked vehicles.
 */
export function furnishStreets(p: StreetInputs) {
  const { data, site, chunks, houses, beach, palms, rnd } = p;
  if (p.chapel) {
    const c = Math.cos(p.chapel.yaw), s = Math.sin(p.chapel.yaw);
    for (const lz of [-4.2, 4.2]) palms.add(p.chapel.x + c * 8.5 - s * lz, p.chapel.z + s * 8.5 + c * lz, 0, 0.6);
  }
  for (const [x, z, kind] of p.palmSpots) palms.add(x, z, kind);
  for (const poi of data.world.pois) {
    if (!POI_PALMS.has(poi.kind) || !data.heightNear.inside(poi.x, poi.z, 200)) continue;
    const n = 2 + Math.floor(rnd() * 4);
    for (let i = 0, placed = 0; i < n * 3 && placed < n; i++) {
      const a = rnd() * Math.PI * 2, r = rr(rnd, 7, 22);
      if (palms.add(poi.x + Math.cos(a) * r, poi.z + Math.sin(a) * r, rnd() < 0.8 ? 0 : 1)) placed++;
    }
  }
  for (const h of houses) {
    if (!inVillage(h.z) || h.sdf > 1300 || h.kind === 'shed' || rnd() > (h.sdf < 250 ? 0.3 : 0.16)) continue;
    const kind: 0 | 1 = rnd() < 0.82 ? 0 : 1;
    for (let tries = 0; tries < 4; tries++) {
      const a = rnd() < 0.5 ? -1 : 1, b = rnd() < 0.5 ? -1 : 1;
      const lx = a * (h.hw + rr(rnd, 1.4, 3)), lz = b * (h.hd + rr(rnd, -h.hd * 0.6, 2.5));
      if (palms.add(...local(h, lx, lz), kind)) {
        // Often planted in pairs along the yard wall.
        if (rnd() < 0.25) palms.add(...local(h, lx * 1.1, lz + 3.5 * b), kind);
        break;
      }
    }
  }

  let cars = 0;
  for (const h of houses) {
    if (!inVillage(h.z) || h.kind === 'shed' || rnd() > 0.1) continue;
    const [nx, nz] = FACE_N[h.front];
    const half = nx !== 0 ? h.hd : h.hw;
    const along = rr(rnd, -half * 0.6, half * 0.6);
    const [x, z] = local(h, nx * (h.hw + 2.6) + nz * along, nz * (h.hd + 2.6) - nx * along);
    if (site.hitsBuilding(x, z, 2.2) || !site.isFree(x, z, 2.6) || site.roadDistance(x, z) < 5.2 || data.sdf(x, z) < 30) continue;
    // Parked parallel to the facade.
    const c = Math.cos(h.rot), s = Math.sin(h.rot);
    const yaw = Math.atan2(s * -nz + c * nx, c * -nz - s * nx) + (rnd() < 0.5 ? Math.PI : 0);
    const b = chunks.at(x, z);
    b.frame(x, site.ground(x, z) - 0.03, z, yaw);
    if (rnd() < 0.62) pickupTruck(b, rnd);
    else smallCar(b, rnd);
    b.identity();
    site.occupy(x, z, 2.6);
    cars++;
  }

  // Neighbours at their doors, more of them along the highway shops.
  for (const h of houses) {
    if (!inVillage(h.z) || h.kind === 'shed' || h.kind === 'open') continue;
    if (rnd() > (site.roadDistance(h.x, h.z) < 30 ? 0.07 : 0.02)) continue;
    const [nx, nz] = FACE_N[h.front];
    const c = Math.cos(h.rot), s = Math.sin(h.rot);
    const n = 1 + (rnd() < 0.35 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const along = rr(rnd, -1.5, 1.5);
      const [x, z] = local(h, nx * (h.hw + rr(rnd, 0.8, 1.6)) + nz * along, nz * (h.hd + rr(rnd, 0.8, 1.6)) - nx * along);
      const face = Math.atan2(s * nx + c * nz, c * nx - s * nz) + rr(rnd, -1.2, 1.2);
      beach.personAt(rnd, x, z, face, rnd() < 0.7 ? 'local' : 'tourist', rnd() < 0.3);
    }
  }

  for (const h of houses) {
    if (!inVillage(h.z) || rnd() > 0.025) continue;
    const [nx, nz] = FACE_N[h.front];
    const [x, z] = local(h, nx * (h.hw + 1.6) + rr(rnd, -1, 1) * Math.abs(nz), nz * (h.hd + 1.6) + rr(rnd, -1, 1) * Math.abs(nx));
    beach.dogAt(rnd, x, z, rnd() * 6.28, rnd() < 0.75);
  }
  return cars;
}
