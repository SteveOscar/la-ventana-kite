import * as THREE from 'three';
import { smoothstep } from '../../core/math.ts';

const MAX_P = 1600;
const PATCHES = 48;
const TRANSIENT = 20;
const SEG = 12;
const RINGS = 2;
const PV = 1 + SEG * RINGS;

/** Patch looks, matched in the foam shader. */
export const FOAM = { ring: 0, splash: 1, slick: 2, shadow: 3, rayShadow: 4 } as const;

const P_VERT = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute float aSoft;
uniform float uScale;
varying float vAlpha;
varying float vSoft;
#include <fog_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  float px = aSize * uScale / max(0.5, -mvPosition.z);
  // Sprites below two pixels shimmer; keep them two pixels wide and fade them instead.
  vAlpha = aAlpha * clamp(px * 0.5, 0.0, 1.0);
  vSoft = aSoft;
  gl_PointSize = aAlpha > 0.0 ? clamp(px, 2.0, 400.0) : 0.0;
  #include <fog_vertex>
}`;

const P_FRAG = /* glsl */ `
uniform vec3 uTint;
varying float vAlpha;
varying float vSoft;
#include <fog_pars_fragment>
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r = length(c);
  if (r > 1.0) discard;
  float hard = smoothstep(1.0, 0.45, r);
  float soft = (1.0 - r * r) * (1.0 - r * r);
  float a = vAlpha * mix(hard, soft, vSoft);
  if (a < 0.004) discard;
  // Mist is a little darker underneath so the column has some volume.
  float shade = mix(1.0, mix(1.04, 0.78, gl_PointCoord.y), vSoft);
  gl_FragColor = vec4(uTint * shade, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

const F_VERT = /* glsl */ `
attribute vec4 aFoam;
varying vec2 vUv;
varying vec4 vFoam;
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vFoam = aFoam;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const F_FRAG = /* glsl */ `
uniform vec3 uTint;
varying vec2 vUv;
varying vec4 vFoam;
#include <fog_pars_fragment>
float fh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float fn(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(fh(i), fh(i + vec2(1.0, 0.0)), u.x), mix(fh(i + vec2(0.0, 1.0)), fh(i + vec2(1.0, 1.0)), u.x), u.y);
}
void main() {
  float kind = vFoam.x, age = vFoam.y, seed = vFoam.z, alpha = vFoam.w;
  float r = length(vUv);
  vec2 q = vUv * 3.2 + seed * 17.0;
  float n = fn(q) * 0.6 + fn(q * 2.3 + 5.0) * 0.4;
  vec3 col = uTint;
  float a = 0.0;
  if (kind < 0.5) {
    // Expanding ripple ring, breaking up as it spreads.
    float band = smoothstep(0.62, 0.84, r) * (1.0 - smoothstep(0.86, 1.0, r));
    a = band * smoothstep(0.25, 0.6, n + 0.25 - age * 0.3) * pow(1.0 - age, 1.4);
  } else if (kind < 1.5) {
    // Churned white water: dense at first, then a fading network of lace.
    float body = 1.0 - smoothstep(0.4, 1.0, r + (n - 0.5) * 0.4);
    float ridge = 1.0 - abs(fn(vUv * 6.5 + seed * 31.0) - 0.5) * 2.0;
    float lace = pow(ridge, 2.5 + age * 5.0);
    float dense = smoothstep(0.25, 0.65, n + (1.0 - r) * 0.3) * (1.0 - smoothstep(0.0, 0.55, age));
    a = body * max(dense, lace * 0.85) * (1.0 - age * age);
  } else if (kind < 2.5) {
    // Glassy slick left where a whale went down.
    col = mix(uTint, vec3(0.55, 0.8, 0.9) * uTint, 0.5);
    a = (1.0 - smoothstep(0.5, 1.0, r)) * 0.22 * (1.0 - age);
  } else {
    // Dark shape just under the surface.
    float d = kind < 3.5 ? r : abs(vUv.x) * 0.9 + abs(vUv.y) * 1.1;
    col = uTint * vec3(0.02, 0.07, 0.11);
    a = (1.0 - smoothstep(0.45, 1.0, d)) * 0.55;
  }
  a *= alpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

interface Patch {
  active: boolean;
  x: number;
  z: number;
  heading: number;
  /** Radii along and across the heading, at birth and at death. */
  ru: number;
  rv: number;
  grow: number;
  age: number;
  life: number;
  kind: number;
  alpha: number;
  seed: number;
}

export interface SplashOptions {
  /** Launch speed of the droplets (m/s). */
  power: number;
  count: number;
  /** Droplet size (m). */
  size?: number;
  /** Radius of the white-water patch left behind (0 = none). */
  foam?: number;
  /** Extra soft mist puffs. */
  mist?: number;
  /** Height of the burst (defaults to the water surface). */
  y?: number;
  /** Horizontal throw direction and spread (for directional sheets of spray). */
  dirX?: number;
  dirZ?: number;
}

export interface BlowOptions {
  height: number;
  width?: number;
  count?: number;
}

type Surface = (x: number, z: number) => number;

/** Splashes, spouts and foam on the water for all the animals: one Points and one Mesh. */
export class WaterFx {
  readonly points: THREE.Points;
  readonly foam: THREE.Mesh;
  /** Lighting tint (linear RGB), updated from the scene lights. */
  readonly tint = new THREE.Color(1, 1, 1);
  windX = -2.2;
  windZ = 7.8;

  private pos = new Float32Array(MAX_P * 3);
  private vel = new Float32Array(MAX_P * 3);
  private life = new Float32Array(MAX_P);
  private maxLife = new Float32Array(MAX_P);
  private size0 = new Float32Array(MAX_P);
  private size1 = new Float32Array(MAX_P);
  private alpha0 = new Float32Array(MAX_P);
  private drag = new Float32Array(MAX_P);
  private grav = new Float32Array(MAX_P);
  private floor = new Float32Array(MAX_P);
  private size = new Float32Array(MAX_P);
  private alpha = new Float32Array(MAX_P);
  private soft = new Float32Array(MAX_P);
  private next = 0;
  private high = 0;
  private pGeo: THREE.BufferGeometry;
  private pMat: THREE.ShaderMaterial;

  private patches: Patch[] = [];
  private transient = 0;
  private camX = 0;
  private camZ = 0;
  private fGeo: THREE.BufferGeometry;
  private fMat: THREE.ShaderMaterial;
  private fPos: Float32Array;
  private fAttr: Float32Array;
  private surface: Surface;

  constructor(surface: Surface) {
    this.surface = surface;
    this.pGeo = new THREE.BufferGeometry();
    const dyn = (a: Float32Array, n: number) => new THREE.BufferAttribute(a, n).setUsage(THREE.DynamicDrawUsage);
    this.pGeo.setAttribute('position', dyn(this.pos, 3));
    this.pGeo.setAttribute('aSize', dyn(this.size, 1));
    this.pGeo.setAttribute('aAlpha', dyn(this.alpha, 1));
    this.pGeo.setAttribute('aSoft', dyn(this.soft, 1));
    this.pGeo.setDrawRange(0, 0);
    this.pMat = new THREE.ShaderMaterial({
      vertexShader: P_VERT,
      fragmentShader: P_FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uScale: { value: 800 }, uTint: { value: new THREE.Color(1, 1, 1) } }]),
    });
    this.points = new THREE.Points(this.pGeo, this.pMat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    this.points.name = 'wildlife-spray';
    const buf = new THREE.Vector2();
    this.points.onBeforeRender = (renderer, _scene, camera) => {
      renderer.getDrawingBufferSize(buf);
      this.pMat.uniforms.uScale.value = buf.y * 0.5 * camera.projectionMatrix.elements[5];
    };

    for (let i = 0; i < PATCHES + TRANSIENT; i++)
      this.patches.push({ active: false, x: 0, z: 0, heading: 0, ru: 1, rv: 1, grow: 1, age: 0, life: 1, kind: 0, alpha: 1, seed: 0 });
    const total = (PATCHES + TRANSIENT) * PV;
    this.fPos = new Float32Array(total * 3);
    this.fAttr = new Float32Array(total * 4);
    const uv = new Float32Array(total * 2);
    const idx: number[] = [];
    for (let p = 0; p < PATCHES + TRANSIENT; p++) {
      const o = p * PV;
      for (let r = 1; r <= RINGS; r++) {
        for (let s = 0; s < SEG; s++) {
          const a = (s / SEG) * Math.PI * 2, k = o + 1 + (r - 1) * SEG + s;
          uv[k * 2] = (Math.cos(a) * r) / RINGS;
          uv[k * 2 + 1] = (Math.sin(a) * r) / RINGS;
        }
      }
      for (let s = 0; s < SEG; s++) idx.push(o, o + 1 + ((s + 1) % SEG), o + 1 + s);
      for (let r = 1; r < RINGS; r++) {
        const a0 = o + 1 + (r - 1) * SEG, b0 = o + 1 + r * SEG;
        for (let s = 0; s < SEG; s++) {
          const s1 = (s + 1) % SEG;
          idx.push(a0 + s, a0 + s1, b0 + s, a0 + s1, b0 + s1, b0 + s);
        }
      }
    }
    this.fGeo = new THREE.BufferGeometry();
    this.fGeo.setAttribute('position', dyn(this.fPos, 3));
    this.fGeo.setAttribute('aFoam', dyn(this.fAttr, 4));
    this.fGeo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.fGeo.setIndex(idx);
    this.fMat = new THREE.ShaderMaterial({
      vertexShader: F_VERT,
      fragmentShader: F_FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTint: { value: new THREE.Color(1, 1, 1) } }]),
    });
    this.foam = new THREE.Mesh(this.fGeo, this.fMat);
    this.foam.frustumCulled = false;
    this.foam.renderOrder = 1;
    this.foam.name = 'wildlife-foam';
  }

  get liveParticles() {
    let n = 0;
    for (let i = 0; i < this.high; i++) if (this.life[i] > 0) n++;
    return n;
  }

  get livePatches() {
    return this.patches.filter((p) => p.active).length;
  }

  private spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, s0: number, s1: number, life: number, alpha: number, drag: number, grav: number, soft: number, floor: number) {
    const i = this.next;
    this.next = (this.next + 1) % MAX_P;
    if (i + 1 > this.high) this.high = i + 1;
    const o = i * 3;
    this.pos[o] = x;
    this.pos[o + 1] = y;
    this.pos[o + 2] = z;
    this.vel[o] = vx;
    this.vel[o + 1] = vy;
    this.vel[o + 2] = vz;
    this.life[i] = this.maxLife[i] = life;
    this.size0[i] = s0;
    this.size1[i] = s1;
    this.alpha0[i] = alpha;
    this.drag[i] = drag;
    this.grav[i] = grav;
    this.soft[i] = soft;
    this.floor[i] = floor;
  }

  /** Distant bursts are drawn larger, matching the animals' readability boost. */
  private boost(x: number, z: number) {
    const t = Math.min(1, Math.max(0, (Math.hypot(x - this.camX, z - this.camZ) - 60) / 440));
    return 1 + 0.6 * t * (2 - t);
  }

  /** A burst of droplets (and optionally mist and white water) at the surface. */
  splash(x: number, z: number, o: SplashOptions) {
    const sea = this.surface(x, z);
    const y = o.y ?? sea;
    const size = (o.size ?? 0.3) * this.boost(x, z);
    const dx = o.dirX ?? 0, dz = o.dirZ ?? 0;
    for (let k = 0; k < o.count; k++) {
      const a = Math.random() * Math.PI * 2;
      // A crown: most water is thrown outward as well as up.
      const h = o.power * (0.12 + Math.random() * 0.5);
      const up = o.power * (0.35 + Math.random() * 0.8);
      const r = Math.sqrt(Math.random()) * size * 2;
      this.spawn(
        x + Math.cos(a) * r,
        y + Math.random() * size,
        z + Math.sin(a) * r,
        Math.cos(a) * h + dx * o.power * 0.6,
        up,
        Math.sin(a) * h + dz * o.power * 0.6,
        size * (0.5 + Math.random() * 0.9),
        size * (0.9 + Math.random()),
        0.7 + Math.random() * 0.9,
        0.92,
        0.35,
        9.81,
        size > 0.3 ? 0.45 : 0.2,
        sea - 0.25,
      );
    }
    const mist = o.mist ?? 0;
    for (let k = 0; k < mist; k++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * size * 4;
      this.spawn(x + Math.cos(a) * r, y + Math.random() * o.power * 0.25, z + Math.sin(a) * r, Math.cos(a) * 0.6, o.power * (0.15 + Math.random() * 0.35), Math.sin(a) * 0.6, size * 3, size * 8, 1.4 + Math.random() * 1.2, 0.38, 1.6, 0.6, 1, sea - 2);
    }
    if (o.foam) {
      this.patch({ x, z, radius: o.foam, kind: FOAM.splash, life: 3 + o.foam * 0.9, grow: 1.5 });
      this.patch({ x, z, radius: o.foam * 0.8, kind: FOAM.ring, life: 2 + o.foam * 0.35, grow: 2.6 });
    }
  }

  /** A whale (or dolphin) exhalation: a bushy column of mist that drifts downwind. */
  blow(x: number, y: number, z: number, o: BlowOptions) {
    const w = (o.width ?? 1) * this.boost(x, z);
    const n = o.count ?? 40;
    for (let k = 0; k < n; k++) {
      const t = Math.random();
      const a = Math.random() * Math.PI * 2;
      const spread = (0.25 + t * 0.9) * w;
      this.spawn(
        x + (Math.random() - 0.5) * 0.3 * w,
        y,
        z + (Math.random() - 0.5) * 0.3 * w,
        Math.cos(a) * spread,
        o.height * (0.9 + t * 1.9),
        Math.sin(a) * spread,
        0.35 * w + t * 0.3 * w,
        (1.4 + t * 1.6) * w,
        2.2 + Math.random() * 1.8,
        0.5,
        2.0,
        0.35,
        1,
        y - 6,
      );
    }
  }

  /** Water running off a fluke or a wing. */
  drips(x: number, y: number, z: number, count: number, spread: number, vx = 0, vz = 0) {
    const sea = this.surface(x, z);
    for (let k = 0; k < count; k++) {
      this.spawn(x + (Math.random() - 0.5) * spread, y - Math.random() * 0.3, z + (Math.random() - 0.5) * spread, vx + (Math.random() - 0.5) * 0.6, -Math.random() * 1.2, vz + (Math.random() - 0.5) * 0.6, 0.12 + Math.random() * 0.12, 0.2, 1.6, 0.9, 0.2, 9.81, 0.1, sea - 0.2);
    }
  }

  /** A foam or ripple patch on the surface that ages and spreads. */
  patch(o: { x: number; z: number; radius: number; kind: number; life: number; grow?: number; heading?: number; width?: number; alpha?: number }) {
    let best = -1, oldest = -1;
    for (let i = 0; i < PATCHES; i++) {
      const p = this.patches[i];
      if (!p.active) {
        best = i;
        break;
      }
      if (oldest < 0 || p.age / p.life > this.patches[oldest].age / this.patches[oldest].life) oldest = i;
    }
    const p = this.patches[best >= 0 ? best : oldest];
    p.active = true;
    p.x = o.x;
    p.z = o.z;
    p.heading = o.heading ?? Math.random() * Math.PI * 2;
    p.ru = o.radius;
    p.rv = o.width ?? o.radius;
    p.grow = o.grow ?? 1;
    p.age = 0;
    p.life = o.life;
    p.kind = o.kind;
    p.alpha = o.alpha ?? 1;
    p.seed = Math.random();
  }

  /** A dark silhouette under the surface for this frame only. */
  shadow(x: number, z: number, heading: number, length: number, width: number, alpha: number, kind: number = FOAM.shadow) {
    if (this.transient >= TRANSIENT) return;
    const p = this.patches[PATCHES + this.transient++];
    p.active = true;
    p.x = x;
    p.z = z;
    p.heading = heading;
    p.ru = length / 2;
    p.rv = width / 2;
    p.grow = 1;
    p.age = 0;
    p.life = 1;
    p.kind = kind;
    p.alpha = alpha;
    p.seed = 0;
  }

  update(dt: number, camX: number, camZ: number) {
    this.camX = camX;
    this.camZ = camZ;
    this.pMat.uniforms.uTint.value.copy(this.tint);
    this.fMat.uniforms.uTint.value.copy(this.tint);
    this.updateParticles(dt);
    this.updatePatches(dt, camX, camZ);
  }

  private updateParticles(dt: number) {
    const wx = this.windX, wz = this.windZ;
    let high = 0;
    for (let i = 0; i < this.high; i++) {
      if (this.life[i] <= 0) {
        this.alpha[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const o = i * 3;
      const k = Math.min(1, this.drag[i] * dt);
      // Light particles are carried by the wind; heavy droplets mostly keep their throw.
      this.vel[o] += (wx * 0.75 - this.vel[o]) * k;
      this.vel[o + 2] += (wz * 0.75 - this.vel[o + 2]) * k;
      this.vel[o + 1] += -this.grav[i] * dt - this.vel[o + 1] * k * 0.8;
      this.pos[o] += this.vel[o] * dt;
      this.pos[o + 1] += this.vel[o + 1] * dt;
      this.pos[o + 2] += this.vel[o + 2] * dt;
      if (this.pos[o + 1] < this.floor[i]) this.life[i] = 0;
      if (this.life[i] <= 0) {
        this.alpha[i] = 0;
        continue;
      }
      const t = 1 - this.life[i] / this.maxLife[i];
      this.size[i] = this.size0[i] + (this.size1[i] - this.size0[i]) * t;
      const fadeIn = this.soft[i] > 0.5 ? smoothstep(0, 0.08, t) : 1;
      this.alpha[i] = this.alpha0[i] * fadeIn * (1 - smoothstep(this.soft[i] > 0.5 ? 0.3 : 0.65, 1, t));
      high = i + 1;
    }
    this.high = high;
    this.pGeo.setDrawRange(0, high);
    if (high > 0) {
      for (const name of ['position', 'aSize', 'aAlpha', 'aSoft']) {
        const attr = this.pGeo.getAttribute(name) as THREE.BufferAttribute;
        attr.clearUpdateRanges();
        attr.addUpdateRange(0, high * attr.itemSize);
        attr.needsUpdate = true;
      }
    }
  }

  private updatePatches(dt: number, camX: number, camZ: number) {
    const fp = this.fPos, fa = this.fAttr;
    let used = 0;
    for (let i = 0; i < this.patches.length; i++) {
      const p = this.patches[i];
      if (!p.active) continue;
      p.age += dt;
      const transient = i >= PATCHES;
      if (!transient && p.age >= p.life) {
        p.active = false;
        continue;
      }
      const t = transient ? 0 : p.age / p.life;
      const g = 1 + (p.grow - 1) * (1 - (1 - t) * (1 - t));
      const ru = p.ru * g, rv = p.rv * g;
      // Fit a quadratic to the waves under the patch from five samples.
      const fx = Math.sin(p.heading), fz = -Math.cos(p.heading);
      const sx = -fz, sz = fx;
      const a = Math.max(0.5, Math.max(ru, rv) * 0.6);
      const S = this.surface;
      const h0 = S(p.x, p.z);
      const hu1 = S(p.x + fx * a, p.z + fz * a), hu0 = S(p.x - fx * a, p.z - fz * a);
      const hv1 = S(p.x + sx * a, p.z + sz * a), hv0 = S(p.x - sx * a, p.z - sz * a);
      const gu = (hu1 - hu0) / (2 * a), cu = (hu1 + hu0 - 2 * h0) / (2 * a * a);
      const gv = (hv1 - hv0) / (2 * a), cv = (hv1 + hv0 - 2 * h0) / (2 * a * a);
      const dCam = Math.hypot(p.x - camX, p.z - camZ);
      // The water mesh flattens the chop in the distance and is coarser there.
      const atten = 1 - smoothstep(700, 2600, dCam);
      const lift = 0.05 + dCam * 0.0007 + (p.kind >= FOAM.shadow ? 0.02 : 0);
      const o = used * PV;
      for (let v = 0; v < PV; v++) {
        const ring = v === 0 ? 0 : Math.floor((v - 1) / SEG) + 1;
        const ang = v === 0 ? 0 : (((v - 1) % SEG) / SEG) * Math.PI * 2;
        const lu = (Math.cos(ang) * ring * ru) / RINGS, lv = (Math.sin(ang) * ring * rv) / RINGS;
        let h = h0 + gu * lu + gv * lv + cu * lu * lu + cv * lv * lv;
        if (h > h0 + 1) h = h0 + 1;
        else if (h < h0 - 1) h = h0 - 1;
        const k = (o + v) * 3;
        fp[k] = p.x + fx * lu + sx * lv;
        fp[k + 1] = h * atten + lift;
        fp[k + 2] = p.z + fz * lu + sz * lv;
        const m = (o + v) * 4;
        fa[m] = p.kind;
        fa[m + 1] = t;
        fa[m + 2] = p.seed;
        fa[m + 3] = p.alpha;
      }
      // Slots are packed so the draw range covers only live patches.
      used++;
      if (transient) p.active = false;
    }
    this.transient = 0;
    this.fGeo.setDrawRange(0, used * SEG * (1 + 2 * (RINGS - 1)) * 3);
    this.foam.visible = used > 0;
    if (used > 0) {
      for (const name of ['position', 'aFoam']) {
        const attr = this.fGeo.getAttribute(name) as THREE.BufferAttribute;
        attr.clearUpdateRanges();
        attr.addUpdateRange(0, used * PV * attr.itemSize);
        attr.needsUpdate = true;
      }
    }
  }
}
