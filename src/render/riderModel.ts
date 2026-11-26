import * as THREE from 'three';
import { clamp, damp, dampAngle } from '../core/math.ts';
import type { Rig } from '../sim/rig.ts';

export interface RiderLook {
  skin: number;
  top: number;
  topAccent: number;
  shorts: number;
  hair: number;
  cap: number;
  board: number;
  boardAccent: number;
}

export const RIDER_LOOKS: RiderLook[] = [
  { skin: 0xc68a5e, top: 0x14a3a8, topAccent: 0xffffff, shorts: 0xff6b4a, hair: 0x2a1b12, cap: 0xf4f1e8, board: 0xfafafa, boardAccent: 0x14a3a8 },
  { skin: 0xf1c7a4, top: 0x222831, topAccent: 0xffc928, shorts: 0x3a86ff, hair: 0xd8b25a, cap: 0x222831, board: 0x111111, boardAccent: 0xffc928 },
  { skin: 0x8d5a3b, top: 0xe63946, topAccent: 0xffffff, shorts: 0x1d3557, hair: 0x120c08, cap: 0xe63946, board: 0xffffff, boardAccent: 0xe63946 },
  { skin: 0xe0a982, top: 0xfee440, topAccent: 0x222222, shorts: 0x222222, hair: 0x5a3a22, cap: 0xffffff, board: 0x2b59c3, boardAccent: 0xfee440 },
  { skin: 0xb07650, top: 0x2a9d8f, topAccent: 0xe9c46a, shorts: 0x264653, hair: 0x1a120c, cap: 0xe9c46a, board: 0xe9c46a, boardAccent: 0x264653 },
  { skin: 0xf3d2b8, top: 0x9b5de5, topAccent: 0xf15bb5, shorts: 0x00bbf9, hair: 0xa0522d, cap: 0x00bbf9, board: 0xffffff, boardAccent: 0x9b5de5 },
];

const UP = new THREE.Vector3(0, 1, 0);
const LEN = { thigh: 0.44, shin: 0.45, upperArm: 0.3, foreArm: 0.29, torso: 0.52 };

function limb(radius: number, length: number, mat: THREE.Material) {
  const geo = new THREE.CapsuleGeometry(radius, Math.max(0.01, length - radius * 2), 4, 8);
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  return m;
}

/** Places a Y-aligned limb so it spans from a to b. */
function placeLimb(mesh: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3) {
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  const dir = tmpDir.copy(b).sub(a);
  const len = dir.length();
  if (len > 1e-5) mesh.quaternion.setFromUnitVectors(UP, dir.divideScalar(len));
}
const tmpDir = new THREE.Vector3();

/** Two-bone IK: returns the middle joint, bending toward `pole`. */
function solveJoint(root: THREE.Vector3, end: THREE.Vector3, l1: number, l2: number, pole: THREE.Vector3, out: THREE.Vector3) {
  const d = tmpA.copy(end).sub(root);
  let dist = d.length();
  const maxD = (l1 + l2) * 0.999;
  if (dist > maxD) {
    d.multiplyScalar(maxD / dist);
    dist = maxD;
  }
  dist = Math.max(dist, Math.abs(l1 - l2) + 1e-3);
  const dir = d.clone().normalize();
  const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const bend = tmpB.copy(pole).addScaledVector(dir, -pole.dot(dir));
  if (bend.lengthSq() < 1e-6) bend.set(0, 0, 1);
  bend.normalize();
  return out.copy(root).addScaledVector(dir, a).addScaledVector(bend, h);
}
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();

export class RiderModel {
  readonly root = new THREE.Group();
  /** Rotates around the centre of mass for tricks and tumbles. */
  private trick = new THREE.Group();
  private skel = new THREE.Group();
  private board: THREE.Group;
  /** Floating copy shown when the board is lost; the owner adds it to the scene. */
  readonly lostBoard: THREE.Group;
  private parts: Record<string, THREE.Mesh> = {};
  private bar: THREE.Mesh;
  readonly barLeft = new THREE.Vector3();
  readonly barRight = new THREE.Vector3();
  readonly barCenter = new THREE.Vector3();
  private faceYaw = 0;
  private crouch = 0.3;
  private leanS = 0;
  private boardEdge = 0;
  private sink = 0;
  private tumble = new THREE.Euler();
  private initialized = false;
  private j: Record<string, THREE.Vector3> = {};

  constructor(look: RiderLook) {
    const mat = (c: number, rough = 0.8) => new THREE.MeshStandardMaterial({ color: c, roughness: rough });
    const skin = mat(look.skin, 0.7);
    const top = mat(look.top, 0.6);
    const shorts = mat(look.shorts, 0.75);
    const dark = mat(0x1b1b1b, 0.6);
    this.root.add(this.trick);
    this.trick.add(this.skel);

    const p = this.parts;
    p.torso = limb(0.16, LEN.torso, top);
    p.torso.scale.set(1.12, 1, 0.82);
    p.hips = limb(0.145, 0.3, shorts);
    p.hips.rotation.z = Math.PI / 2;
    p.harness = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.165, 0.14, 12), dark);
    p.head = new THREE.Mesh(new THREE.SphereGeometry(0.115, 14, 10), skin);
    p.hair = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), mat(look.hair, 0.9));
    p.cap = new THREE.Mesh(new THREE.SphereGeometry(0.124, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.42), mat(look.cap, 0.7));
    p.brim = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.012, 12, 1, false, -Math.PI / 2, Math.PI), mat(look.cap, 0.7));
    p.shades = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.035, 0.03), mat(0x101010, 0.2));
    p.thighL = limb(0.085, LEN.thigh, shorts);
    p.thighR = limb(0.085, LEN.thigh, shorts);
    p.shinL = limb(0.065, LEN.shin, skin);
    p.shinR = limb(0.065, LEN.shin, skin);
    p.upperArmL = limb(0.055, LEN.upperArm, top);
    p.upperArmR = limb(0.055, LEN.upperArm, top);
    p.foreArmL = limb(0.045, LEN.foreArm, skin);
    p.foreArmR = limb(0.045, LEN.foreArm, skin);
    const accent = new THREE.Mesh(new THREE.BoxGeometry(0.33, 0.06, 0.26), mat(look.topAccent, 0.6));
    p.torso.add(accent);
    accent.position.y = 0.12;
    for (const k of ['torso', 'hips', 'harness', 'head', 'thighL', 'thighR', 'shinL', 'shinR', 'upperArmL', 'upperArmR', 'foreArmL', 'foreArmR'])
      this.skel.add(p[k]);
    p.head.add(p.hair, p.cap, p.shades);
    p.cap.add(p.brim);
    p.brim.position.set(0, 0.035, 0.07);
    p.brim.rotation.x = 0.12;
    p.hair.rotation.x = -0.35;
    p.cap.rotation.x = -0.15;
    p.shades.position.set(0, 0.015, 0.105);

    // Twin-tip board.
    this.board = new THREE.Group();
    const shape = new THREE.Shape();
    const L = 0.69, W = 0.21, r = 0.13;
    shape.moveTo(-L + r, -W);
    shape.lineTo(L - r, -W);
    shape.quadraticCurveTo(L, -W, L, -W + r);
    shape.lineTo(L, W - r);
    shape.quadraticCurveTo(L, W, L - r, W);
    shape.lineTo(-L + r, W);
    shape.quadraticCurveTo(-L, W, -L, W - r);
    shape.lineTo(-L, -W + r);
    shape.quadraticCurveTo(-L, -W, -L + r, -W);
    const boardGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.025, bevelEnabled: true, bevelSize: 0.008, bevelThickness: 0.006, bevelSegments: 1, curveSegments: 6 });
    boardGeo.rotateX(-Math.PI / 2);
    // Rocker: lift the tips.
    const bp = boardGeo.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < bp.count; i++) bp.setY(i, bp.getY(i) + Math.pow(bp.getX(i) / L, 2) * 0.05);
    boardGeo.computeVertexNormals();
    const boardMesh = new THREE.Mesh(boardGeo, [mat(look.board, 0.4), mat(look.boardAccent, 0.4)]);
    boardMesh.castShadow = true;
    this.board.add(boardMesh);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.004, 0.08), mat(look.boardAccent, 0.4));
    stripe.position.set(0, 0.036, 0);
    this.board.add(stripe);
    for (const x of [-0.27, 0.27]) {
      const pad = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.03, 0.15), dark);
      pad.position.set(x, 0.045, 0);
      const strap = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.016, 4, 10, Math.PI), dark);
      strap.position.set(x, 0.05, 0);
      strap.rotation.y = Math.PI / 2;
      this.board.add(pad, strap);
    }
    this.skel.add(this.board);
    this.lostBoard = this.board.clone();
    this.lostBoard.visible = false;

    this.bar = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.52, 6), mat(0x2b2b2b, 0.5));
    this.root.add(this.bar);

    for (const k of ['footF', 'footB', 'hip', 'hipF', 'hipB', 'neck', 'shL', 'shR', 'handL', 'handR', 'kneeF', 'kneeB', 'elbL', 'elbR', 'head', 'barC', 'harness'])
      this.j[k] = new THREE.Vector3();
  }

  private tmpX = new THREE.Vector3();
  private tmpZ = new THREE.Vector3();
  private tmpM = new THREE.Matrix4();
  private inv = new THREE.Matrix4();
  private uLocal = new THREE.Vector3();
  private pole = new THREE.Vector3();

  update(dt: number, rig: Rig) {
    const mode = rig.mode;
    const side = rig.kiteSide;
    const targetYaw = rig.heading + (side * Math.PI) / 2;
    if (!this.initialized) {
      this.faceYaw = targetYaw;
      this.initialized = true;
    }
    this.faceYaw = dampAngle(this.faceYaw, targetYaw, mode === 'air' ? 3 : 7, dt);

    const z = this.tmpZ.set(Math.sin(this.faceYaw), 0, -Math.cos(this.faceYaw));
    const x = this.tmpX.crossVectors(UP, z).normalize();
    this.tmpM.makeBasis(x, UP, z);
    this.root.position.copy(rig.pos);
    this.root.quaternion.setFromRotationMatrix(this.tmpM);
    // Which way along local X the rider is travelling.
    const travel = Math.sign(Math.sin(rig.heading) * x.x - Math.cos(rig.heading) * x.z) || 1;

    // Line direction in the rider's local frame.
    this.inv.copy(this.tmpM).transpose();
    this.uLocal.copy(rig.kite.u).applyMatrix4(this.inv);

    const j = this.j;
    let crouchT = 0.3;
    let lean = 0;
    let sinkT = 0;
    if (mode === 'riding') {
      crouchT = 0.25 + rig.edge * 0.35;
      // Knees soak up the landing.
      if (rig.sinceJump < 0.5) crouchT += 0.55 * (1 - rig.sinceJump / 0.5);
      lean = clamp(Math.abs(rig.lean) * 0.9 + rig.edge * 0.18, 0.05, 0.75);
    } else if (mode === 'air') {
      crouchT = rig.grab ? 0.95 : 0.5;
      lean = 0.1;
    } else if (mode === 'water' || mode === 'crash' || mode === 'drag') {
      sinkT = 1;
    }
    this.crouch = damp(this.crouch, crouchT, 8, dt);
    this.leanS = damp(this.leanS, lean, 6, dt);
    this.sink = damp(this.sink, sinkT, 5, dt);

    // Base riding pose in local space: feet on the board, hips over them, leaning away from the kite.
    const c = this.crouch;
    const feetY = mode === 'air' && rig.grab ? 0.32 : 0.06;
    j.footF.set(0.27 * travel, feetY, 0);
    j.footB.set(-0.27 * travel, feetY, 0);
    const hipH = 0.98 - 0.36 * c;
    const ls = this.leanS;
    j.hip.set(-0.04 * travel, hipH * Math.cos(ls), -hipH * Math.sin(ls));
    const torsoLean = ls * 0.55 - 0.12 * c;
    j.neck.set(j.hip.x, j.hip.y + LEN.torso * Math.cos(torsoLean) + 0.08, j.hip.z - LEN.torso * Math.sin(torsoLean) + 0.04);

    if (this.sink > 0.01) {
      // In the water: sitting back with the board on the feet, or lying out for a body drag.
      const s = this.sink;
      const drag = mode === 'drag' ? 1 : 0;
      const wHip = new THREE.Vector3(0, -0.38, -0.25 * (1 - drag));
      const wNeck = drag ? new THREE.Vector3(0, -0.12, 0.62) : new THREE.Vector3(0, 0.12, -0.42);
      const wFootF = drag ? new THREE.Vector3(0.14, -0.35, -0.9) : new THREE.Vector3(0.27 * travel, -0.12, 0.42);
      const wFootB = drag ? new THREE.Vector3(-0.14, -0.38, -0.88) : new THREE.Vector3(-0.27 * travel, -0.15, 0.4);
      j.hip.lerp(wHip, s);
      j.neck.lerp(wNeck, s);
      j.footF.lerp(wFootF, s);
      j.footB.lerp(wFootB, s);
    }

    j.hipF.copy(j.hip).add(this.tmpA2.set(0.11 * travel, -0.04, 0));
    j.hipB.copy(j.hip).add(this.tmpA2.set(-0.11 * travel, -0.04, 0));
    j.harness.copy(j.hip).add(this.tmpA2.set(0, 0.13, 0.06));

    // Bar out along the lines, about an arm's length from the harness.
    const barDist = mode === 'drag' ? 0.75 : 0.5 + 0.1 * (1 - rig.kite.sheet);
    j.barC.copy(j.harness).addScaledVector(this.uLocal, barDist);
    const barAxis = this.tmpA2.set(1, 0, 0).addScaledVector(this.uLocal, -this.uLocal.x);
    if (barAxis.lengthSq() < 1e-4) barAxis.set(1, 0, 0);
    barAxis.normalize();
    // Steering tilts the bar.
    barAxis.applyAxisAngle(this.uLocal, rig.kite.steer * 0.35 * -travel);
    this.bar.position.copy(j.barC);
    this.bar.quaternion.setFromUnitVectors(UP, barAxis);
    this.barLeft.copy(j.barC).addScaledVector(barAxis, -0.25);
    this.barRight.copy(j.barC).addScaledVector(barAxis, 0.25);
    j.handL.copy(j.barC).addScaledVector(barAxis, 0.19);
    j.handR.copy(j.barC).addScaledVector(barAxis, -0.19);

    // Grabs: one hand leaves the bar for the board rail.
    if (mode === 'air' && rig.grab) {
      const g = rig.grab;
      const hand = g === 2 || g === 4 ? 'handL' : 'handR';
      const fx = g === 3 ? -0.55 * travel : g === 4 ? 0.55 * travel : g === 1 ? -0.05 * travel : 0.12 * travel;
      const fz = g === 1 || g === 2 ? 0.13 : 0;
      j[hand].set(fx, feetY + 0.06, fz);
    }

    j.shL.copy(j.neck).add(this.tmpA2.set(0.19, -0.06, 0));
    j.shR.copy(j.neck).add(this.tmpA2.set(-0.19, -0.06, 0));
    j.head.copy(j.neck).add(this.tmpA2.set(0, 0.16, 0.02));

    // Knees forward toward the kite, elbows down and out.
    this.pole.set(0, 0.15, 1);
    solveJoint(j.hipF, j.footF, LEN.thigh, LEN.shin, this.pole, j.kneeF);
    solveJoint(j.hipB, j.footB, LEN.thigh, LEN.shin, this.pole, j.kneeB);
    this.pole.set(0.6, -1, -0.2);
    solveJoint(j.shL, j.handL, LEN.upperArm, LEN.foreArm, this.pole, j.elbL);
    this.pole.set(-0.6, -1, -0.2);
    solveJoint(j.shR, j.handR, LEN.upperArm, LEN.foreArm, this.pole, j.elbR);

    const p = this.parts;
    placeLimb(p.torso, j.hip, j.neck);
    p.hips.position.copy(j.hip);
    p.harness.position.copy(j.harness).add(this.tmpA2.set(0, -0.06, -0.02));
    p.harness.quaternion.copy(p.torso.quaternion);
    p.head.position.copy(j.head);
    p.head.quaternion.copy(p.torso.quaternion);
    placeLimb(p.thighL, j.hipF, j.kneeF);
    placeLimb(p.shinL, j.kneeF, j.footF);
    placeLimb(p.thighR, j.hipB, j.kneeB);
    placeLimb(p.shinR, j.kneeB, j.footB);
    placeLimb(p.upperArmL, j.shL, j.elbL);
    placeLimb(p.foreArmL, j.elbL, j.handL);
    placeLimb(p.upperArmR, j.shR, j.elbR);
    placeLimb(p.foreArmR, j.elbR, j.handR);

    // Board under the feet: edged against the kite, following the feet.
    const edgeT = mode === 'riding' ? 0.12 + this.leanS * 0.45 : mode === 'air' ? 0.15 : 0.05;
    this.boardEdge = damp(this.boardEdge, edgeT, 8, dt);
    this.board.position.set(0, (j.footF.y + j.footB.y) / 2 - 0.05, (j.footF.z + j.footB.z) / 2);
    this.board.rotation.set(-this.boardEdge, 0, Math.atan2(j.footF.y - j.footB.y, (j.footF.x - j.footB.x) || 1e-3) * (travel > 0 ? 1 : -1));
    this.board.visible = rig.hasBoard;
    this.lostBoard.visible = !rig.hasBoard;
    if (!rig.hasBoard) {
      this.lostBoard.position.copy(rig.boardPos);
      this.lostBoard.rotation.set(0, rig.heading, 0);
    }

    // Tricks: spin about the vertical, flips about the board axis, around the centre of mass.
    const com = this.tmpA2.set(0, 0.85, -0.1);
    this.trick.position.copy(com);
    this.skel.position.copy(com).negate();
    if (mode === 'crash') {
      this.tumble.x += dt * 5.5;
      this.tumble.z += dt * 3.2;
      this.trick.rotation.set(Math.sin(this.tumble.x) * 1.2, 0, Math.sin(this.tumble.z) * 0.9);
    } else if (mode === 'air') {
      this.trick.rotation.set(0, 0, 0);
      this.trick.rotateOnWorldAxis(UP, -rig.spin);
      this.trick.rotateX(rig.flip * travel);
    } else {
      this.tumble.set(0, 0, 0);
      this.trick.rotation.set(0, 0, 0);
    }

    // World-space bar ends for the kite lines.
    this.root.updateMatrixWorld(true);
    this.barLeft.applyMatrix4(this.root.matrixWorld);
    this.barRight.applyMatrix4(this.root.matrixWorld);
    this.barCenter.copy(j.barC).applyMatrix4(this.root.matrixWorld);
  }

  private tmpA2 = new THREE.Vector3();
}
