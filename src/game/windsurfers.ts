import * as THREE from 'three';
import { DEG, damp, dampAngle, mulberry32, wrapAngle } from '../core/math.ts';
import type { Game } from './game.ts';

const SAILS = [
  [0xff3d3d, 0xffd23f, 0xffffff],
  [0x2b59c3, 0x8ecae6, 0xffffff],
  [0x00b388, 0xc6f432, 0x1d1d1d],
  [0xff7a1a, 0xffffff, 0x3a3a3a],
  [0x9b5de5, 0xf15bb5, 0xffffff],
];

interface Surfer {
  group: THREE.Group;
  sail: THREE.Group;
  mastBase: THREE.Group;
  rider: THREE.Group;
  x: number;
  z: number;
  heading: number;
  speed: number;
  /** +1 travelling east (offshore), -1 back toward the beach. */
  tack: 1 | -1;
  near: number;
  far: number;
  homeZ: number;
  jibe: number;
  phase: number;
}

function makeSurfer(colors: number[]) {
  const group = new THREE.Group();
  const board = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.12, 0.62), new THREE.MeshStandardMaterial({ color: 0xf7f7f2, roughness: 0.5 }));
  board.position.y = 0.06;
  board.scale.set(1, 1, 1);
  group.add(board);
  const sail = new THREE.Group();
  // Triangular-ish sail panel from a mast at the luff to the clew at the boom end.
  const shape = new THREE.Shape();
  shape.moveTo(0, 0.6);
  shape.lineTo(0, 4.8);
  shape.quadraticCurveTo(1.0, 3.2, 2.0, 1.3);
  shape.lineTo(1.9, 0.9);
  shape.lineTo(0, 0.6);
  const geo = new THREE.ShapeGeometry(shape, 8);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const cols: number[] = [];
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    c.setHex(colors[y > 3.4 ? 0 : y > 2.0 ? 1 : 2]);
    cols.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  const sailMesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.6, transparent: true, opacity: 0.94 }));
  sailMesh.castShadow = true;
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 4.6, 6), new THREE.MeshStandardMaterial({ color: 0x222222 }));
  mast.position.y = 2.6;
  const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 2.1, 6), new THREE.MeshStandardMaterial({ color: 0x777777 }));
  boom.rotation.z = Math.PI / 2;
  boom.position.set(1.0, 1.55, 0);
  sail.add(sailMesh, mast, boom);
  // `mastBase` tilts the whole rig to windward; `sail` swings the boom out to leeward.
  const mastBase = new THREE.Group();
  mastBase.position.set(0.35, 0.1, 0);
  mastBase.add(sail);
  group.add(mastBase);
  const rider = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: 0xc68a5e, roughness: 0.7 });
  const suit = new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.7 });
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.5, 4, 8), suit);
  torso.position.y = 1.25;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), skin);
  head.position.y = 1.78;
  const legs = new THREE.Mesh(new THREE.CapsuleGeometry(0.1, 0.7, 4, 8), suit);
  legs.position.y = 0.55;
  rider.add(torso, head, legs);
  rider.position.set(-0.45, 0.1, 0);
  group.add(rider);
  return { group, sail, mastBase, rider };
}

/** A handful of windsurfers planing back and forth: La Ventana is a windsurf spot too. */
export class Windsurfers {
  private surfers: Surfer[] = [];
  private rand = mulberry32(77);

  constructor(game: Game, count: number) {
    const lm = game.world.data.world.landmarks;
    const homes = [lm.campNorth.z, lm.elSargento.z + 400, lm.mainBeach.z - 300, lm.campNorth.z - 1400, lm.elSargento.z - 900];
    for (let i = 0; i < count; i++) {
      const r = this.rand;
      const { group, sail, mastBase, rider } = makeSurfer(SAILS[i % SAILS.length]);
      game.world.scene.add(group);
      const homeZ = homes[i % homes.length] + (r() - 0.5) * 500;
      const coast = game.world.data.coastX(homeZ) ?? 100;
      this.surfers.push({
        group,
        sail,
        mastBase,
        rider,
        x: coast + 200 + r() * 700,
        z: homeZ,
        heading: 0,
        speed: 9,
        tack: r() < 0.5 ? 1 : -1,
        near: 120 + r() * 100,
        far: 700 + r() * 900,
        homeZ,
        jibe: 0,
        phase: r() * 10,
      });
    }
  }

  update(dt: number, game: Game) {
    const w = game.world;
    const down = w.downwindHeading;
    const cam = game.cam.camera.position;
    for (const s of this.surfers) {
      const coast = w.data.coastX(s.z) ?? 0;
      const off = s.x - coast;
      if (s.jibe <= 0) {
        if ((s.tack === 1 && off > s.far) || (s.tack === -1 && off < s.near)) {
          s.tack = s.tack === 1 ? -1 : 1;
          s.jibe = 3.2;
        }
      } else s.jibe -= dt;
      // Reach across the wind, pointing up a little to hold station against the downwind drift.
      const drift = s.z - s.homeZ;
      const point = Math.max(-10, Math.min(25, 8 + drift * 0.04)) * DEG;
      const target = down - s.tack * (Math.PI / 2 + point);
      s.heading = dampAngle(s.heading, target, s.jibe > 0 ? 0.9 : 2, dt);
      const planing = s.jibe > 0 ? 4 : 10 + Math.sin(game.time * 0.3 + s.phase) * 1.5;
      s.speed = damp(s.speed, planing * Math.min(1.2, w.wind.base / 8), 0.6, dt);
      s.x += Math.sin(s.heading) * s.speed * dt;
      s.z -= Math.cos(s.heading) * s.speed * dt;
      const dist = Math.hypot(s.x - cam.x, s.z - cam.z);
      s.group.visible = dist < 3500;
      if (!s.group.visible) continue;
      const y = w.surface(s.x, s.z);
      s.group.position.set(s.x, y, s.z);
      // Board points along the heading (local +x is the nose).
      s.group.rotation.set(0, Math.PI / 2 - s.heading, 0);
      // windSide +1: the wind comes over the port side, so leeward is local +z (starboard).
      // The boom points aft, sheeted ~25 degrees to leeward; rig and rider lean to windward.
      const windSide = Math.sign(wrapAngle(down - s.heading)) || 1;
      s.sail.rotation.set(0, Math.PI + windSide * 25 * DEG, 0);
      s.mastBase.rotation.set(-windSide * 0.22, 0, 0);
      s.rider.position.z = -windSide * 0.3;
      s.rider.rotation.x = -windSide * 0.45;
      s.group.rotateZ(Math.sin(game.time * 2 + s.phase) * 0.03);
    }
  }
}
