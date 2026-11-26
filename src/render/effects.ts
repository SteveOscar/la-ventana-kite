import * as THREE from 'three';
import { clamp } from '../core/math.ts';
import type { Rig, RigEnv } from '../sim/rig.ts';

function softDotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const SPRAY_MAX = 900;

/** Water spray thrown off the rail, landings and wipeouts. */
export class Spray {
  readonly points: THREE.Points;
  private pos = new Float32Array(SPRAY_MAX * 3);
  private vel = new Float32Array(SPRAY_MAX * 3);
  private life = new Float32Array(SPRAY_MAX);
  private size = new Float32Array(SPRAY_MAX);
  private next = 0;
  private geo: THREE.BufferGeometry;

  constructor() {
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aLife', new THREE.BufferAttribute(this.life, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uTex: { value: softDotTexture() }, uScale: { value: 600 } },
      vertexShader: /* glsl */ `
        attribute float aLife;
        attribute float aSize;
        uniform float uScale;
        varying float vLife;
        void main() {
          vLife = aLife;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aLife > 0.0 ? aSize * uScale / max(1.0, -mv.z) : 0.0;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uTex;
        varying float vLife;
        void main() {
          float a = texture2D(uTex, gl_PointCoord).a * clamp(vLife * 1.6, 0.0, 0.85);
          if (a < 0.01) discard;
          gl_FragColor = vec4(vec3(0.94, 0.97, 1.0), a);
        }`,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, spread: number, size: number, life: number) {
    const i = this.next;
    this.next = (this.next + 1) % SPRAY_MAX;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx + (Math.random() - 0.5) * spread;
    this.vel[i * 3 + 1] = vy + Math.random() * spread * 0.8;
    this.vel[i * 3 + 2] = vz + (Math.random() - 0.5) * spread;
    this.life[i] = life * (0.6 + Math.random() * 0.6);
    this.size[i] = size * (0.6 + Math.random() * 0.8);
  }

  burst(x: number, y: number, z: number, count: number, power: number) {
    for (let k = 0; k < count; k++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * power;
      this.emit(x, y + 0.1, z, Math.cos(a) * r, power * (0.6 + Math.random()), Math.sin(a) * r, power * 0.4, 0.55, 1.1);
    }
  }

  update(dt: number, windX: number, windZ: number) {
    for (let i = 0; i < SPRAY_MAX; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const o = i * 3;
      this.vel[o] += (windX * 0.6 - this.vel[o]) * dt * 1.2;
      this.vel[o + 2] += (windZ * 0.6 - this.vel[o + 2]) * dt * 1.2;
      this.vel[o + 1] -= 9.81 * dt;
      this.pos[o] += this.vel[o] * dt;
      this.pos[o + 1] += this.vel[o + 1] * dt;
      this.pos[o + 2] += this.vel[o + 2] * dt;
      if (this.pos[o + 1] < -0.3) this.life[i] = 0;
    }
    (this.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('aLife') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true;
  }
}

const WAKE_N = 90;

/** Foam trail left by a board on the water. */
export class Wake {
  readonly mesh: THREE.Mesh;
  private xs = new Float32Array(WAKE_N);
  private zs = new Float32Array(WAKE_N);
  private ages = new Float32Array(WAKE_N).fill(99);
  private strength = new Float32Array(WAKE_N);
  private head = 0;
  private timer = 0;
  private positions: Float32Array;
  private alphas: Float32Array;
  private geo: THREE.BufferGeometry;

  constructor() {
    this.positions = new Float32Array(WAKE_N * 2 * 3);
    this.alphas = new Float32Array(WAKE_N * 2);
    const uvs = new Float32Array(WAKE_N * 2 * 2);
    const idx: number[] = [];
    for (let i = 0; i < WAKE_N - 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b, b, c, d);
    }
    for (let i = 0; i < WAKE_N; i++) {
      uvs[i * 4] = 0;
      uvs[i * 4 + 1] = i / 6;
      uvs[i * 4 + 2] = 1;
      uvs[i * 4 + 3] = i / 6;
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    this.geo.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute float aAlpha;
        varying float vAlpha;
        varying vec2 vUv;
        void main() {
          vAlpha = aAlpha;
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        varying vec2 vUv;
        float h(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        float n(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(h(i), h(i + vec2(1, 0)), u.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), u.x), u.y); }
        void main() {
          float edge = 1.0 - pow(abs(vUv.x - 0.5) * 2.0, 1.5);
          float foam = n(vUv * vec2(6.0, 3.0)) * 0.6 + n(vUv * vec2(17.0, 9.0)) * 0.4;
          float a = vAlpha * edge * smoothstep(0.25, 0.65, foam);
          if (a < 0.01) discard;
          gl_FragColor = vec4(vec3(0.96, 0.98, 1.0), a * 0.85);
        }`,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  update(dt: number, rig: Rig, env: RigEnv) {
    this.timer += dt;
    for (let i = 0; i < WAKE_N; i++) this.ages[i] += dt;
    const onWater = rig.mode === 'riding' && rig.hasBoard;
    if (this.timer > 0.06) {
      this.timer = 0;
      this.head = (this.head + 1) % WAKE_N;
      this.xs[this.head] = rig.pos.x;
      this.zs[this.head] = rig.pos.z;
      this.ages[this.head] = onWater ? 0 : 99;
      this.strength[this.head] = onWater ? clamp(rig.speed / 8, 0.25, 1) : 0;
    }
    const life = 4.5;
    for (let k = 0; k < WAKE_N; k++) {
      const i = (this.head - k + WAKE_N) % WAKE_N;
      const j = (i - 1 + WAKE_N) % WAKE_N;
      let dx = this.xs[i] - this.xs[j], dz = this.zs[i] - this.zs[j];
      const len = Math.hypot(dx, dz) || 1;
      dx /= len;
      dz /= len;
      const age = this.ages[i];
      const w = 0.35 + Math.min(age, life) * 0.55;
      const x = k === 0 ? rig.pos.x : this.xs[i], z = k === 0 ? rig.pos.z : this.zs[i];
      const y = env.surface(x, z) + 0.05;
      const o = k * 6;
      this.positions[o] = x - dz * w;
      this.positions[o + 1] = y;
      this.positions[o + 2] = z + dx * w;
      this.positions[o + 3] = x + dz * w;
      this.positions[o + 4] = y;
      this.positions[o + 5] = z - dx * w;
      const a = age > life || len > 30 ? 0 : (1 - age / life) * this.strength[i];
      this.alphas[k * 2] = a;
      this.alphas[k * 2 + 1] = a;
    }
    (this.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('aAlpha') as THREE.BufferAttribute).needsUpdate = true;
  }
}

/** Spray and wake for one rider. */
export class RiderEffects {
  readonly wake = new Wake();
  private emitAcc = 0;

  /** Pass `spray` = null to keep the wake but skip spray (riders far from the camera). */
  update(dt: number, rig: Rig, env: RigEnv, spray: Spray | null) {
    this.wake.update(dt, rig, env);
    if (!spray || rig.mode !== 'riding' || !rig.hasBoard) return;
    const v = rig.speed;
    const rate = clamp((v - 4) * 9 + rig.edge * 40, 0, 140);
    this.emitAcc += rate * dt;
    // Spray leaves the downwind rail, thrown back and away from the kite side.
    const side = rig.kiteSide;
    const nx = Math.cos(rig.heading) * side, nz = Math.sin(rig.heading) * side;
    const sy = env.surface(rig.pos.x, rig.pos.z);
    while (this.emitAcc >= 1) {
      this.emitAcc -= 1;
      const back = -0.2 - Math.random() * 0.5;
      spray.emit(
        rig.pos.x + rig.dirX * back - nx * 0.25,
        sy + 0.05,
        rig.pos.z + rig.dirZ * back - nz * 0.25,
        -nx * (1 + v * 0.18) - rig.dirX * v * 0.15,
        1.2 + v * 0.12 + rig.edge,
        -nz * (1 + v * 0.18) - rig.dirZ * v * 0.15,
        0.8,
        0.32,
        0.7,
      );
    }
  }
}
