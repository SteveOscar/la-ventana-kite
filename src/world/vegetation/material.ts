import * as THREE from 'three';

/**
 * Per-instance data, 12 floats: x, y, z, yaw | width, height, tiltX, tiltZ | tint r, g, b, reach.
 * Width/height are metres (geometries are normalised to a unit reference size); reach (0..1)
 * scales the group's maximum view distance so small plants drop out sooner than big ones.
 */
export const INSTANCE_FLOATS = 12;

const PARS = /* glsl */ `
attribute vec4 aI0;
attribute vec4 aI1;
attribute vec4 aI2;
uniform vec4 uLod;
uniform vec4 uShape;
uniform vec2 uMinPx;
uniform vec4 uMotion;
uniform float uPixel;
mat3 vegR;
vec3 vegS;
vec3 vegS0;
float vegVis;
`;

// uLod: x = LOD start, y = LOD end (both jittered per instance so switches don't form rings),
//       z = group max distance (times reach), w = fade fraction at the max distance.
// uShape: x = far exaggeration, y = sway (m per m of height), z = 1 for camera-facing cards,
//         w = how much a card's normal tilts up (low for cactus strokes, higher for round bushes).
// uMinPx: smallest on-screen width/height in pixels (distant plants stay visible as specks).
const SETUP = /* glsl */ `
{
  vec3 ip = aI0.xyz;
  float d = distance(cameraPosition, ip);
  float j = 0.88 + 0.24 * fract(sin(ip.x * 0.0173 + ip.z * 0.0311) * 4375.85);
  float vis = step(uLod.x * j, d) * (1.0 - step(uLod.y * j, d));
  float lim = uLod.z * aI2.w;
  vis *= 1.0 - smoothstep(lim * (1.0 - uLod.w), lim, d);
  vegVis = vis;
  vegS0 = vec3(aI1.x, aI1.y, aI1.x);
  vec3 s = vegS0 * (1.0 + uShape.x * smoothstep(500.0, 4500.0, d));
  float px = uPixel * d;
  s = max(s, vec3(px * uMinPx.x, px * uMinPx.y, px * uMinPx.x));
  vegS = s * vis;
  float cy = cos(aI0.w), sy = sin(aI0.w);
  float cx = cos(aI1.z), sx = sin(aI1.z);
  float cz = cos(aI1.w), sz = sin(aI1.w);
  if (uShape.z > 0.5) {
    vec2 tc = normalize(cameraPosition.xz - ip.xz + vec2(1e-3, 0.0));
    cy = tc.y;
    sy = tc.x;
    cx = 1.0; sx = 0.0; cz = 1.0; sz = 0.0;
  }
  vegR = mat3(cy, 0.0, -sy, 0.0, 1.0, 0.0, sy, 0.0, cy)
    * mat3(cz, sz, 0.0, -sz, cz, 0.0, 0.0, 0.0, 1.0)
    * mat3(1.0, 0.0, 0.0, 0.0, cx, sx, 0.0, -sx, cx);
}
`;

const NORMAL = /* glsl */ `
vec3 objectNormal = uShape.z > 0.5
  ? vegR * normalize(vec3(position.x * 0.9, uShape.w, 0.6))
  : vegR * (normal / vegS0);
`;

const BEGIN = /* glsl */ `
vec3 transformed = vegR * (position * vegS) + aI0.xyz;
if (uShape.y > 0.0) {
  float flex = clamp(position.y, 0.0, 1.0);
  flex *= flex;
  float ph = uMotion.x * 1.7 + aI0.x * 0.31 + aI0.z * 0.23;
  float osc = 0.55 + 0.35 * sin(ph) + 0.15 * sin(ph * 2.9 + 1.3);
  transformed.xz += uMotion.yz * (uShape.y * flex * osc * aI1.y * vegVis);
}
`;

const motion = { value: new THREE.Vector4(0, -0.28, 0.96, 0) };
const pixel = { value: 0.0012 };

/** Shared clock and wind direction for plant sway. */
export function setPlantMotion(time: number, windX: number, windZ: number) {
  motion.value.set(time, windX, windZ, 0);
}

const bufferSize = new THREE.Vector2();

/** Keeps the shared pixel-angle uniform in step with the camera and drawing buffer. */
export function updatePixelAngle(renderer: THREE.WebGLRenderer, camera: THREE.Camera) {
  renderer.getDrawingBufferSize(bufferSize);
  const p = camera.projectionMatrix.elements[5];
  if (p > 0 && bufferSize.y > 0) pixel.value = 2 / (p * bufferSize.y);
}

export interface PlantMaterialOptions {
  lodStart: number;
  lodEnd: number;
  maxDistance: number;
  fade: number;
  grow: number;
  sway: number;
  card: boolean;
  cardUp: number;
  minPx: [number, number];
}

export function plantMaterial(o: PlantMaterialOptions) {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const lod = { value: new THREE.Vector4(o.lodStart, o.lodEnd, o.maxDistance, o.fade) };
  const shape = { value: new THREE.Vector4(o.grow, o.sway, o.card ? 1 : 0, o.cardUp) };
  const minPx = { value: new THREE.Vector2(o.minPx[0], o.minPx[1]) };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uLod = lod;
    shader.uniforms.uShape = shape;
    shader.uniforms.uMinPx = minPx;
    shader.uniforms.uMotion = motion;
    shader.uniforms.uPixel = pixel;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${PARS}`)
      .replace('void main() {', `void main() {\n${SETUP}`)
      .replace('#include <beginnormal_vertex>', NORMAL)
      .replace('#include <begin_vertex>', BEGIN)
      .replace('#include <color_vertex>', '#include <color_vertex>\nvColor.rgb *= aI2.rgb;');
  };
  return mat;
}
