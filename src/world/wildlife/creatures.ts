import * as THREE from 'three';

/** Joint layout for one species, in the left-wing frame (+x out along the wing). */
export interface CreatureRig {
  shoulder?: [number, number, number];
  wrist?: [number, number, number];
  /** Sweep of the arm and the hand when fully folded (radians). */
  fold?: [number, number];
  flexPivot?: [number, number, number];
  limbPivot?: [number, number, number];
  tailPivot?: [number, number, number];
  headPivot?: [number, number, number];
}

/** One pose per instance; filled in place by the behaviour code and pushed each frame. */
export interface Pose {
  x: number;
  y: number;
  z: number;
  /** Compass heading (0 = north/-z, PI/2 = east/+x). */
  heading: number;
  /** Nose up, radians. */
  pitch: number;
  /** Bank: positive lowers the right wing (turning right). */
  roll: number;
  scale: number;
  /** Wing (or flipper) angle at the shoulder, up positive. */
  flap: number;
  /** Extra angle of the outer wing at the wrist. */
  hand: number;
  /** 0 spread .. 1 folded back. */
  fold: number;
  /** 0..1 mix toward the alternative colouring. */
  variant: number;
  /** Vertical body bend, tail up positive. */
  flex: number;
  /** Limb swing about the x axis (legs, talons). */
  limb: number;
  /** Tail fork spread. */
  tail: number;
  /** Carried item visibility (0/1). */
  carry: number;
  /** Head / neck pitch, nose down positive. */
  head: number;
}

export const newPose = (): Pose => ({
  x: 0,
  y: 0,
  z: 0,
  heading: 0,
  pitch: 0,
  roll: 0,
  scale: 1,
  flap: 0,
  hand: 0,
  fold: 0,
  variant: 0,
  flex: 0,
  limb: 0,
  tail: 0,
  carry: 0,
  head: 0,
});

const DEFORM_PARS = /* glsl */ `
attribute vec4 aRig;
attribute vec3 color2;
attribute vec4 aAnimA;
attribute vec4 aAnimB;
attribute float aHead;
uniform vec3 uShoulder;
uniform vec3 uWrist;
uniform vec2 uFold;
uniform vec3 uFlexPivot;
uniform vec3 uLimbPivot;
uniform vec3 uTailPivot;
uniform vec3 uHeadPivot;
vec3 wlRotX(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(v.x, c * v.y - s * v.z, s * v.y + c * v.z); }
vec3 wlRotY(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(c * v.x + s * v.z, v.y, -s * v.x + c * v.z); }
vec3 wlRotZ(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(c * v.x - s * v.y, s * v.x + c * v.y, v.z); }
void wlDeform(inout vec3 p, inout vec3 n) {
  float side = aRig.x;
  if (abs(side) > 0.5) {
    p.x *= side; n.x *= side;
    if (aRig.y > 0.5) {
      p -= uWrist;
      float hs = aAnimA.z * uFold.y;
      p = wlRotY(p, hs); n = wlRotY(n, hs);
      p = wlRotZ(p, aAnimA.y); n = wlRotZ(n, aAnimA.y);
      p += uWrist;
    }
    p -= uShoulder;
    float as = aAnimA.z * uFold.x;
    p = wlRotY(p, as); n = wlRotY(n, as);
    p = wlRotZ(p, aAnimA.x); n = wlRotZ(n, aAnimA.x);
    p += uShoulder;
    p.x *= side; n.x *= side;
  }
  float g = aRig.w;
  if (g > 0.5 && g < 1.5) {
    p -= uLimbPivot; p = wlRotX(p, aAnimB.y); n = wlRotX(n, aAnimB.y); p += uLimbPivot;
  } else if (g > 1.5 && g < 3.5) {
    float s = g < 2.5 ? 1.0 : -1.0;
    p -= uTailPivot; p = wlRotY(p, -s * aAnimB.z); n = wlRotY(n, -s * aAnimB.z); p += uTailPivot;
  } else if (g > 3.5 && g < 4.5) {
    p -= uLimbPivot; p = wlRotX(p, aAnimB.y); n = wlRotX(n, aAnimB.y); p *= step(0.5, aAnimB.w); p += uLimbPivot;
  } else if (g > 4.5) {
    p -= uHeadPivot; p = wlRotX(p, aHead); n = wlRotX(n, aHead); p += uHeadPivot;
  }
  if (aRig.z > 0.0) {
    float a = aAnimB.x * aRig.z;
    p -= uFlexPivot; p = wlRotX(p, a); n = wlRotX(n, a); p += uFlexPivot;
  }
}
`;

const v3 = (a?: [number, number, number]) => new THREE.Vector3(...(a ?? [0, 0, 0]));

/**
 * All instances of one species in a single draw call. Wings, tails, limbs and the body
 * bend are animated in the vertex shader from two vec4s per instance.
 */
export class CreatureMesh {
  readonly mesh: THREE.InstancedMesh;
  readonly max: number;
  private animA: THREE.InstancedBufferAttribute;
  private animB: THREE.InstancedBufferAttribute;
  private headAttr: THREE.InstancedBufferAttribute;
  private n = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler(0, 0, 0, 'YXZ');
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();

  constructor(name: string, geometry: THREE.BufferGeometry, max: number, rig: CreatureRig, material: { roughness: number; metalness?: number }) {
    this.max = max;
    this.animA = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage) as THREE.InstancedBufferAttribute;
    this.animB = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage) as THREE.InstancedBufferAttribute;
    this.headAttr = new THREE.InstancedBufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage) as THREE.InstancedBufferAttribute;
    geometry.setAttribute('aAnimA', this.animA);
    geometry.setAttribute('aAnimB', this.animB);
    geometry.setAttribute('aHead', this.headAttr);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: material.roughness, metalness: material.metalness ?? 0 });
    const uniforms = {
      uShoulder: { value: v3(rig.shoulder) },
      uWrist: { value: v3(rig.wrist) },
      uFold: { value: new THREE.Vector2(...(rig.fold ?? [0, 0])) },
      uFlexPivot: { value: v3(rig.flexPivot) },
      uLimbPivot: { value: v3(rig.limbPivot) },
      uTailPivot: { value: v3(rig.tailPivot) },
      uHeadPivot: { value: v3(rig.headPivot) },
    };
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${DEFORM_PARS}`)
        .replace('#include <color_vertex>', 'vColor = vec4(mix(color, color2, aAnimA.w), 1.0);')
        .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = normal;\nvec3 wlPos = position;\nwlDeform(wlPos, objectNormal);')
        .replace('#include <begin_vertex>', 'vec3 transformed = wlPos;');
    };
    mat.customProgramCacheKey = () => 'wildlife-creature';
    this.mesh = new THREE.InstancedMesh(geometry, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.name = name;
  }

  get triangles() {
    const idx = this.mesh.geometry.index;
    return (idx ? idx.count : this.mesh.geometry.getAttribute('position').count) / 3;
  }

  get count() {
    return this.n;
  }

  begin() {
    this.n = 0;
  }

  push(p: Pose) {
    if (this.n >= this.max) return;
    const i = this.n++;
    this.e.set(-p.pitch, Math.PI - p.heading, p.roll, 'YXZ');
    this.q.setFromEuler(this.e);
    this.m.compose(this.p.set(p.x, p.y, p.z), this.q, this.s.setScalar(p.scale));
    this.mesh.setMatrixAt(i, this.m);
    const a = this.animA.array as Float32Array, b = this.animB.array as Float32Array;
    a[i * 4] = p.flap;
    a[i * 4 + 1] = p.hand;
    a[i * 4 + 2] = p.fold;
    a[i * 4 + 3] = p.variant;
    b[i * 4] = p.flex;
    b[i * 4 + 1] = p.limb;
    b[i * 4 + 2] = p.tail;
    b[i * 4 + 3] = p.carry;
    (this.headAttr.array as Float32Array)[i] = p.head;
  }

  end() {
    const n = this.n;
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    if (n === 0) return;
    for (const attr of [this.mesh.instanceMatrix, this.animA, this.animB, this.headAttr]) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, n * attr.itemSize);
      attr.needsUpdate = true;
    }
  }
}
