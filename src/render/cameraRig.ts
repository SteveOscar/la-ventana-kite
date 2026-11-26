import * as THREE from 'three';
import { clamp, damp, dampAngle, headingOf, lerp, noise1 } from '../core/math.ts';
import type { Rig } from '../sim/rig.ts';

export type CameraMode = 'chase' | 'side' | 'kite' | 'drone';
export const CAMERA_MODES: CameraMode[] = ['chase', 'side', 'kite', 'drone'];
export const CAMERA_LABELS: Record<CameraMode, string> = {
  chase: 'Chase cam',
  side: 'Boat cam',
  kite: 'Kite cam',
  drone: 'Drone cam',
};

export interface GroundProbe {
  height(x: number, z: number): number;
}

/** Third-person cameras that keep both the rider and the kite in frame. */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'chase';
  private yaw = 0;
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private initialized = false;
  private shakeT = 0;
  private shakeAmp = 0;
  /** Mouse orbit offsets (radians), decaying back to zero when released. */
  orbitYaw = 0;
  orbitPitch = 0;
  dragging = false;
  zoom = 1;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(58, aspect, 0.3, 120000);
  }

  shake(amount: number) {
    this.shakeAmp = Math.max(this.shakeAmp, amount);
  }

  cycle() {
    const i = CAMERA_MODES.indexOf(this.mode);
    this.mode = CAMERA_MODES[(i + 1) % CAMERA_MODES.length];
  }

  snap() {
    this.initialized = false;
  }

  attachMouse(el: HTMLElement) {
    let lastX = 0, lastY = 0;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.button !== 2) return;
      this.dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.orbitYaw -= (e.clientX - lastX) * 0.006;
      this.orbitPitch = clamp(this.orbitPitch + (e.clientY - lastY) * 0.004, -0.5, 1.0);
      lastX = e.clientX;
      lastY = e.clientY;
    });
    const end = () => (this.dragging = false);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('wheel', (e) => {
      this.zoom = clamp(this.zoom * Math.exp(e.deltaY * 0.001), 0.45, 2.6);
    }, { passive: true });
  }

  update(dt: number, rig: Rig, ground: GroundProbe) {
    const kite = rig.kite.position;
    const rider = rig.pos;
    const travelYaw = rig.speed > 1.5 ? headingOf(rig.vel.x, rig.vel.z) : rig.heading;
    if (!this.initialized) this.yaw = travelYaw;
    // Swing behind the direction of travel, slowly enough to survive transitions.
    this.yaw = dampAngle(this.yaw, travelYaw, rig.mode === 'air' ? 0.8 : 1.6, dt);
    if (!this.dragging) {
      this.orbitYaw = damp(this.orbitYaw, 0, 0.6, dt);
      this.orbitPitch = damp(this.orbitPitch, 0, 0.6, dt);
    }
    const yaw = this.yaw + this.orbitYaw;
    const fx = Math.sin(yaw), fz = -Math.cos(yaw);
    // Upwind is away from the kite, horizontally.
    let ux = rider.x - kite.x, uz = rider.z - kite.z;
    const ul = Math.hypot(ux, uz) || 1;
    ux /= ul;
    uz /= ul;

    const desired = new THREE.Vector3();
    const look = new THREE.Vector3();
    const air = rig.mode === 'air' ? 1 : 0;
    const z = this.zoom;
    switch (this.mode) {
      case 'chase': {
        const dist = (10.5 + air * 5) * z;
        const h = (3.6 + air * 2.5 + this.orbitPitch * 8) * z;
        desired.set(rider.x - fx * dist + ux * 3.5 * z, rider.y + h, rider.z - fz * dist + uz * 3.5 * z);
        look.copy(rider).lerp(kite, 0.3);
        look.y = lerp(rider.y + 1.2, look.y, 0.5);
        break;
      }
      case 'side': {
        // A photographer's boat holding station upwind and slightly ahead.
        const dist = 20 * z;
        desired.set(rider.x + ux * dist + fx * 6, rider.y + 2.2 + this.orbitPitch * 10, rider.z + uz * dist + fz * 6);
        desired.x += Math.cos(yaw + Math.PI / 2) * this.orbitYaw * 10;
        look.copy(rider).lerp(kite, 0.35);
        break;
      }
      case 'kite': {
        // Behind the rider on the line axis, looking up at the kite.
        const back = (6 + air * 2) * z;
        desired.set(rider.x + ux * back, rider.y + 2.4, rider.z + uz * back);
        desired.x += Math.sin(this.orbitYaw) * 6;
        look.copy(kite);
        break;
      }
      case 'drone': {
        const r = 34 * z;
        const a = yaw + Math.PI * 0.75;
        desired.set(rider.x + Math.sin(a) * r, rider.y + (26 + this.orbitPitch * 20) * z, rider.z - Math.cos(a) * r);
        look.copy(rider).lerp(kite, 0.4);
        break;
      }
    }

    const floor = Math.max(0, ground.height(desired.x, desired.z)) + 1.2;
    if (desired.y < floor) desired.y = floor;
    if (!this.initialized) {
      this.pos.copy(desired);
      this.look.copy(look);
      this.initialized = true;
    }
    const rate = this.mode === 'side' ? 2.2 : 4.5;
    this.pos.x = damp(this.pos.x, desired.x, rate, dt);
    this.pos.y = damp(this.pos.y, desired.y, rate * 0.8, dt);
    this.pos.z = damp(this.pos.z, desired.z, rate, dt);
    this.look.x = damp(this.look.x, look.x, 6, dt);
    this.look.y = damp(this.look.y, look.y, 6, dt);
    this.look.z = damp(this.look.z, look.z, 6, dt);

    this.shakeAmp = damp(this.shakeAmp, 0, 3, dt);
    this.shakeT += dt;
    const sx = noise1(this.shakeT * 9, 1) * this.shakeAmp, sy = noise1(this.shakeT * 9, 2) * this.shakeAmp;
    this.camera.position.set(this.pos.x + sx, this.pos.y + sy, this.pos.z);
    this.camera.lookAt(this.look);
    const fov = 56 + clamp(rig.speed - 6, 0, 10) * 0.6 + air * 4;
    this.camera.fov = damp(this.camera.fov, fov, 2, dt);
    this.camera.updateProjectionMatrix();
  }

  /** Slow aerial orbit for menus and intros. */
  cinematic(t: number, center: THREE.Vector3, ground: GroundProbe) {
    const a = t * 0.035 + 2.2;
    const r = 260;
    const x = center.x + Math.sin(a) * r, z = center.z - Math.cos(a) * r;
    const y = Math.max(ground.height(x, z) + 30, 70 + Math.sin(t * 0.07) * 18);
    this.camera.position.set(x, y, z);
    this.camera.lookAt(center.x - 120, 25, center.z - 160);
    this.camera.fov = 52;
    this.camera.updateProjectionMatrix();
    this.initialized = false;
  }
}
