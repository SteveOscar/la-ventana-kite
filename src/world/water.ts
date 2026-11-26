import * as THREE from 'three';
import type { TerrainData, Grid } from './terrainData.ts';
import { WAVE_COUNT, type Waves } from './waves.ts';
import type { Wind } from './wind.ts';
import { GUST_SCALE } from './wind.ts';
import { TERRAIN_GLSL_NOISE } from './terrain.ts';
import { mulberry32 } from '../core/math.ts';

const TERRAIN_HEIGHT_GLSL = /* glsl */ `
float sampleGrid(sampler2D tex, vec4 rect, vec2 p, out float border) {
  vec2 size = vec2(textureSize(tex, 0));
  vec2 g = (p - rect.xy) / rect.z;
  border = min(min(g.x, size.x - 1.0 - g.x), min(g.y, size.y - 1.0 - g.y)) * rect.z;
  return texture2D(tex, (g + 0.5) / size).r;
}
float terrainHeight(vec2 p) {
  float bw;
  float hw = sampleGrid(uHeightWide, uWideRect, p, bw);
  float bn;
  float hn = sampleGrid(uHeightNear, uNearRect, p, bn);
  return mix(hw, hn, smoothstep(0.0, 400.0, bn));
}`;

const VERT = /* glsl */ `
uniform vec3 uCenter;
uniform float uTime;
uniform vec4 uWaveA[${WAVE_COUNT}];
uniform vec4 uWaveB[${WAVE_COUNT}];
uniform sampler2D uHeightNear;
uniform sampler2D uHeightWide;
uniform vec4 uNearRect;
uniform vec4 uWideRect;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vCrest;
varying float vDist;
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>

${TERRAIN_HEIGHT_GLSL}

void main() {
  vec3 wp = vec3(position.x + uCenter.x, 0.0, position.z + uCenter.z);
  float dist = length(wp.xz - cameraPosition.xz);
  float depth = -terrainHeight(wp.xz);
  float atten = smoothstep(0.15, 3.5, depth) * (1.0 - smoothstep(700.0, 2600.0, dist));
  vec3 disp = vec3(0.0);
  vec3 nrm = vec3(0.0, 1.0, 0.0);
  float crest = 0.0;
  for (int i = 0; i < ${WAVE_COUNT}; i++) {
    vec4 a = uWaveA[i];
    vec4 b = uWaveB[i];
    float A = a.w * atten;
    float th = a.z * dot(a.xy, wp.xz) - b.x * uTime + b.y;
    float s = sin(th), c = cos(th);
    disp.x += b.z * A * a.x * c;
    disp.z += b.z * A * a.y * c;
    disp.y += A * s;
    float WA = a.z * A;
    nrm.x -= a.x * WA * c;
    nrm.z -= a.y * WA * c;
    nrm.y -= b.z * WA * s;
    crest += b.z * WA * s;
  }
  wp += disp;
  vWorld = wp;
  vNormal = normalize(nrm);
  vCrest = crest;
  vDist = dist;
  vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}`;

const FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uAmbient;
uniform sampler2D uRipples;
uniform sampler2D uGust;
uniform vec4 uGustXform;
uniform vec2 uWindDir;
uniform float uWindFoam;
uniform sampler2D uHeightNear;
uniform sampler2D uHeightWide;
uniform vec4 uNearRect;
uniform vec4 uWideRect;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vCrest;
varying float vDist;
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
${TERRAIN_GLSL_NOISE}

${TERRAIN_HEIGHT_GLSL}
vec3 skyColor(vec3 d) {
  float up = max(d.y, 0.0);
  return mix(uHorizon, uZenith, pow(up, 0.42));
}
vec3 ripple(vec2 uv) {
  vec3 n = texture2D(uRipples, uv).xyz * 2.0 - 1.0;
  return vec3(n.x, 0.0, n.y);
}

void main() {
  #include <logdepthbuf_fragment>
  vec2 p = vWorld.xz;
  float depth = max(-terrainHeight(p), 0.0);
  vec3 V = normalize(cameraPosition - vWorld);
  float g = texture2D(uGust, (p - uGustXform.xy) * uGustXform.z).r * 2.0 - 1.0;

  // Small ripples riding on the chop, scrolling downwind; gust patches are rougher.
  vec2 wd = uWindDir;
  vec2 side = vec2(-wd.y, wd.x);
  vec2 q = vec2(dot(p, side), dot(p, wd));
  // Layers at unrelated scales and angles so the tile never lines up; slow large-scale
  // modulation breaks up any remaining repetition.
  vec3 r1 = ripple(q * vec2(0.083, 0.071) - vec2(0.0, uTime * 0.11));
  vec3 r2 = ripple(q * 0.197 * mat2(0.8, 0.6, -0.6, 0.8) - vec2(0.03, uTime * 0.19));
  vec3 r3 = ripple(q * 0.037 * mat2(0.94, -0.34, 0.34, 0.94) + vec2(uTime * 0.012, -uTime * 0.05));
  vec3 r4 = ripple(q * 0.43 * mat2(0.5, -0.87, 0.87, 0.5) - vec2(uTime * 0.05, uTime * 0.3));
  float far = smoothstep(80.0, 1400.0, vDist);
  float patchy = 0.65 + 0.7 * tNoise(p * 0.0035 + 13.0);
  float rough = (0.5 + 0.4 * uWindFoam + 0.35 * max(g, 0.0)) * patchy * (1.0 - far * 0.85);
  // Fine layers fade out first so they never shimmer into a grid in the middle distance.
  float fineFade = 1.0 - smoothstep(15.0, 140.0, vDist);
  float midFade = 1.0 - smoothstep(50.0, 450.0, vDist);
  vec3 dn = (r1 * 0.34 + r2 * 0.26 * midFade + r3 * 0.26 + r4 * 0.18 * fineFade) * rough;
  vec3 N = normalize(vNormal + dn * smoothstep(0.05, 1.2, depth));

  float ndv = max(dot(N, V), 0.0);
  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  vec3 R = reflect(-V, N);
  R.y = abs(R.y);
  vec3 refl = skyColor(R);
  float sdr = max(dot(R, uSunDir), 0.0);
  float spec = pow(sdr, 1400.0) * 90.0 + pow(sdr, 160.0) * 2.0 * (1.0 - far * 0.5);

  vec3 deep = srgb(vec3(0.02, 0.17, 0.34));
  vec3 mid = srgb(vec3(0.03, 0.37, 0.52));
  vec3 shallow = srgb(vec3(0.16, 0.76, 0.73));
  vec3 sand = srgb(vec3(0.92, 0.86, 0.70));
  vec3 body = mix(mid, shallow, exp(-depth / 3.2));
  body = mix(deep, body, exp(-depth / 26.0));
  body = mix(body, sand, exp(-depth / 0.7) * 0.65);
  body *= 1.0 - 0.13 * max(g, 0.0);
  float sunUp = max(uSunDir.y, 0.0);
  vec3 bodyLit = body * (uSunColor * (0.35 + 0.65 * sunUp) + uAmbient) / 3.14159;
  // Light scattering through steep wave crests (that turquoise glow in the chop).
  bodyLit += shallow * uSunColor * max(vCrest, 0.0) * 0.06 * (1.0 - far);

  vec3 col = mix(bodyLit, refl, fres * 0.92);
  col += uSunColor * spec * 0.02;

  float fn = tFbm(p * 0.28 + vec2(uTime * 0.05, -uTime * 0.11));
  float swash = sin(uTime * 0.9 - depth * 9.0 + fn * 4.0) * 0.5 + 0.5;
  float shore = (1.0 - smoothstep(0.02, 0.55, depth)) * smoothstep(0.3, 0.75, fn * 0.7 + swash * 0.5);
  shore += (1.0 - smoothstep(0.0, 0.12, depth)) * 0.6;
  // Whitecaps: only on the steepest crests, broken up into small wind-aligned streaks.
  float crestN = clamp(vCrest * 2.4 + g * 0.15, 0.0, 1.2);
  float capNoise = tNoise(vec2(dot(p, side) * 0.55, dot(p, wd) * 0.22 - uTime * 0.9)) * 0.6 + tNoise(p * 1.7 + uTime * 0.4) * 0.4;
  float caps = smoothstep(0.42, 0.75, crestN) * smoothstep(0.58, 0.8, capNoise) * uWindFoam * (1.0 - far);
  float foam = clamp(shore + caps, 0.0, 1.0);
  vec3 foamCol = vec3(0.95, 0.97, 0.98) * (uSunColor * (0.4 + 0.6 * sunUp) + uAmbient) / 3.14159;
  col = mix(col, foamCol, foam * 0.9);

  float alpha = smoothstep(0.0, 0.18, depth);
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

function heightTexture(grid: Grid) {
  const { nx, nz } = grid.meta;
  const half = new Uint16Array(nx * nz);
  for (let i = 0; i < half.length; i++) half[i] = THREE.DataUtils.toHalfFloat(grid.data[i]);
  const tex = new THREE.DataTexture(half, nx, nz, THREE.RedFormat, THREE.HalfFloatType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** Tileable ripple normal map built from waves with integer frequencies on a torus. */
function rippleTexture(size = 256) {
  const rand = mulberry32(42);
  const waves: { kx: number; kz: number; a: number; ph: number }[] = [];
  for (let i = 0; i < 90; i++) {
    const f = 3 + Math.floor(rand() * 28);
    const ang = (rand() - 0.5) * Math.PI * 1.1;
    const kx = Math.round(Math.sin(ang) * f), kz = Math.round(Math.cos(ang) * f);
    if (kx === 0 && kz === 0) continue;
    waves.push({ kx, kz, a: 1 / Math.pow(Math.hypot(kx, kz), 1.25), ph: rand() * Math.PI * 2 });
  }
  const data = new Uint8Array(size * size * 4);
  let maxSlope = 0;
  const slopes = new Float32Array(size * size * 2);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let dx = 0, dz = 0;
      const u = (i / size) * Math.PI * 2, v = (j / size) * Math.PI * 2;
      for (const w of waves) {
        const c = Math.cos(w.kx * u + w.kz * v + w.ph) * w.a;
        dx += c * w.kx;
        dz += c * w.kz;
      }
      slopes[(j * size + i) * 2] = dx;
      slopes[(j * size + i) * 2 + 1] = dz;
      maxSlope = Math.max(maxSlope, Math.abs(dx), Math.abs(dz));
    }
  }
  for (let k = 0; k < size * size; k++) {
    data[k * 4] = Math.round((-slopes[k * 2] / maxSlope) * 0.5 * 255 + 127.5);
    data[k * 4 + 1] = Math.round((-slopes[k * 2 + 1] / maxSlope) * 0.5 * 255 + 127.5);
    data[k * 4 + 2] = 255;
    data[k * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

function gustTexture(wind: Wind) {
  const n = wind.gustSize;
  const data = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) data[i] = Math.round((wind.gustField[i] * 0.5 + 0.5) * 255);
  const tex = new THREE.DataTexture(data, n, n, THREE.RedFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Radial grid around the camera: dense near the rider, sparse to the horizon. */
function radialGeometry(rings: number, segments: number, rMin: number, rMax: number) {
  const positions: number[] = [0, 0, 0];
  const k = Math.log(rMax / rMin + 1) / rings;
  for (let r = 1; r <= rings; r++) {
    const radius = rMin * (Math.exp(k * r) - 1);
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      positions.push(Math.cos(a) * radius, 0, Math.sin(a) * radius);
    }
  }
  const idx: number[] = [];
  for (let s = 0; s < segments; s++) idx.push(0, 1 + ((s + 1) % segments), 1 + s);
  for (let r = 1; r < rings; r++) {
    const a0 = 1 + (r - 1) * segments, b0 = 1 + r * segments;
    for (let s = 0; s < segments; s++) {
      const s1 = (s + 1) % segments;
      idx.push(a0 + s, a0 + s1, b0 + s, a0 + s1, b0 + s1, b0 + s);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(idx);
  return geo;
}

export class Water {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private snap = 4;

  constructor(data: TerrainData, wind: Wind) {
    const near = data.heightNear.meta, wide = data.heightWide.meta;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      fog: true,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uCenter: { value: new THREE.Vector3() },
          uTime: { value: 0 },
          uWaveA: { value: Array.from({ length: WAVE_COUNT }, () => new THREE.Vector4()) },
          uWaveB: { value: Array.from({ length: WAVE_COUNT }, () => new THREE.Vector4()) },
          uHeightNear: { value: null },
          uHeightWide: { value: null },
          uNearRect: { value: new THREE.Vector4(near.x0, near.z0, near.step, 0) },
          uWideRect: { value: new THREE.Vector4(wide.x0, wide.z0, wide.step, 0) },
          uSunDir: { value: new THREE.Vector3(0, 1, 0) },
          uSunColor: { value: new THREE.Color() },
          uZenith: { value: new THREE.Color() },
          uHorizon: { value: new THREE.Color() },
          uAmbient: { value: new THREE.Color() },
          uRipples: { value: null },
          uGust: { value: null },
          uGustXform: { value: new THREE.Vector4(0, 0, 1 / (GUST_SCALE * wind.gustSize), 0) },
          uWindDir: { value: new THREE.Vector2(0, 1) },
          uWindFoam: { value: 0.5 },
        },
      ]),
    });
    const u = this.material.uniforms;
    u.uHeightNear.value = heightTexture(data.heightNear);
    u.uHeightWide.value = heightTexture(data.heightWide);
    u.uRipples.value = rippleTexture();
    u.uGust.value = gustTexture(wind);

    this.mesh = new THREE.Mesh(radialGeometry(150, 200, 0.6, 45000), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
    this.mesh.name = 'water';
  }

  update(camera: THREE.Camera, waves: Waves, wind: Wind, sky: { sunDir: THREE.Vector3; sunColor: THREE.Color; sunIntensity: number; zenith: THREE.Color; horizon: THREE.Color; ambientSky: THREE.Color }, ambIntensity: number) {
    const u = this.material.uniforms;
    const cx = Math.round(camera.position.x / this.snap) * this.snap;
    const cz = Math.round(camera.position.z / this.snap) * this.snap;
    u.uCenter.value.set(cx, 0, cz);
    u.uTime.value = waves.time;
    for (let i = 0; i < WAVE_COUNT; i++) {
      u.uWaveA.value[i].fromArray(waves.uniformA, i * 4);
      u.uWaveB.value[i].fromArray(waves.uniformB, i * 4);
    }
    u.uSunDir.value.copy(sky.sunDir);
    u.uSunColor.value.copy(sky.sunColor).multiplyScalar(sky.sunIntensity);
    u.uZenith.value.copy(sky.zenith);
    u.uHorizon.value.copy(sky.horizon);
    u.uAmbient.value.copy(sky.ambientSky).multiplyScalar(ambIntensity);
    u.uGustXform.value.x = wind.gustOffset.x;
    u.uGustXform.value.y = wind.gustOffset.z;
    u.uWindDir.value.set(wind.downwindX, wind.downwindZ);
    u.uWindFoam.value = Math.min(1, Math.max(0, (wind.base - 5.5) / 7.5));
  }
}
