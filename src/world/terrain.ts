import * as THREE from 'three';
import type { TerrainData } from './terrainData.ts';

export const TERRAIN_GLSL_NOISE = /* glsl */ `
float tHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float tNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(tHash(i), tHash(i + vec2(1.0, 0.0)), u.x), mix(tHash(i + vec2(0.0, 1.0)), tHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float tFbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += tNoise(p) * a; p = p * 2.07 + 3.1; a *= 0.5; }
  return s;
}
vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }
`;

const VERT = /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormal;
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}`;

const FRAG = /* glsl */ `
uniform sampler2D uOverlay;
uniform vec4 uOverlayRect;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbSky;
uniform vec3 uAmbGround;
uniform float uWetLine;
varying vec3 vWorld;
varying vec3 vNormal;
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
${TERRAIN_GLSL_NOISE}

void main() {
  #include <logdepthbuf_fragment>
  vec3 n = normalize(vNormal);
  vec2 p = vWorld.xz;
  float h = vWorld.y;
  // Fine bump from noise so the desert does not look like plastic.
  float e = 1.5;
  float b0 = tFbm(p * 0.11);
  float bx = tFbm((p + vec2(e, 0.0)) * 0.11);
  float bz = tFbm((p + vec2(0.0, e)) * 0.11);
  n = normalize(n + vec3(b0 - bx, 0.0, b0 - bz) * 1.6);

  float slope = 1.0 - n.y;
  float n1 = tFbm(p * 0.006);
  float n2 = tNoise(p * 0.08);
  float n3 = tNoise(p * 0.55);

  vec3 soil = mix(srgb(vec3(0.80, 0.68, 0.51)), srgb(vec3(0.70, 0.55, 0.40)), n1);
  vec3 rock = mix(srgb(vec3(0.56, 0.41, 0.31)), srgb(vec3(0.43, 0.33, 0.28)), n2);
  vec3 volcanic = srgb(vec3(0.36, 0.29, 0.26));
  float rocky = smoothstep(0.16, 0.48, slope + (n1 - 0.5) * 0.3);
  vec3 col = mix(soil, rock, rocky);
  col = mix(col, volcanic, smoothstep(0.45, 0.8, slope) * 0.55);
  // Higher ground is redder; washes and low plains paler.
  col = mix(col, col * vec3(1.06, 0.92, 0.85), smoothstep(80.0, 450.0, h) * 0.6);

  // Sparse grey-green desert scrub (palo verde, torote, cholla).
  float scrub = smoothstep(0.5, 0.78, tNoise(p * 0.07) * 0.55 + n3 * 0.45);
  scrub *= (1.0 - rocky * 0.55) * smoothstep(1.5, 8.0, h);
  col = mix(col, srgb(vec3(0.42, 0.45, 0.30)), scrub * 0.6);
  // Darker vegetated arroyo floors and north faces.
  col = mix(col, srgb(vec3(0.38, 0.40, 0.27)), smoothstep(0.2, -0.6, n.z) * 0.12 * (1.0 - rocky));

  vec2 ouv = (p - uOverlayRect.xy) * uOverlayRect.zw;
  if (ouv.x > 0.0 && ouv.y > 0.0 && ouv.x < 1.0 && ouv.y < 1.0) {
    vec3 o = texture2D(uOverlay, ouv).rgb;
    col = mix(col, srgb(vec3(0.83, 0.76, 0.63)) * (0.9 + 0.2 * n3), o.b * 0.65);
    vec3 sand = mix(srgb(vec3(0.94, 0.87, 0.72)), srgb(vec3(0.98, 0.93, 0.82)), n3);
    col = mix(col, sand, smoothstep(0.05, 0.6, o.g));
    float road = o.r;
    vec3 asphalt = srgb(vec3(0.27, 0.27, 0.27));
    vec3 dirt = srgb(vec3(0.86, 0.78, 0.62));
    col = mix(col, road > 0.8 ? asphalt : dirt, smoothstep(0.12, 0.35, road) * (road > 0.8 ? 0.95 : 0.7));
  }

  // Wet sand at the swash line, then the seabed fading with depth.
  float wet = 1.0 - smoothstep(uWetLine - 0.2, uWetLine + 0.6, h);
  col = mix(col, col * vec3(0.66, 0.66, 0.68), wet);
  if (h < 0.0) {
    vec3 bed = mix(srgb(vec3(0.90, 0.83, 0.66)), srgb(vec3(0.55, 0.58, 0.50)), smoothstep(0.0, 18.0, -h));
    bed *= 0.9 + 0.2 * n3;
    col = bed;
  }

  float diff = max(dot(n, uSunDir), 0.0);
  vec3 amb = mix(uAmbGround, uAmbSky, n.y * 0.5 + 0.5);
  vec3 lit = col * (uSunColor * diff + amb) / 3.14159;
  gl_FragColor = vec4(lit, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

interface MeshRegion {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  step: number;
  /** Skip cells whose corners all lie inside this rectangle (filled by another mesh). */
  hole?: { x0: number; x1: number; z0: number; z1: number };
  /** Skip cells entirely deeper than this (opaque water hides them). */
  minDepth: number;
  skirt: boolean;
}

function buildGrid(data: TerrainData, r: MeshRegion) {
  const nx = Math.floor((r.x1 - r.x0) / r.step) + 1;
  const nz = Math.floor((r.z1 - r.z0) / r.step) + 1;
  const heights = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) heights[j * nx + i] = data.height(r.x0 + i * r.step, r.z0 + j * r.step);
  }
  const used = new Int32Array(nx * nz).fill(-1);
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const vert = (i: number, j: number) => {
    const k = j * nx + i;
    if (used[k] >= 0) return used[k];
    const x = r.x0 + i * r.step, z = r.z0 + j * r.step;
    const h = heights[k];
    const hl = heights[j * nx + Math.max(0, i - 1)], hr = heights[j * nx + Math.min(nx - 1, i + 1)];
    const hd = heights[Math.max(0, j - 1) * nx + i], hu = heights[Math.min(nz - 1, j + 1) * nx + i];
    const n = new THREE.Vector3(hl - hr, 2 * r.step, hd - hu).normalize();
    used[k] = positions.length / 3;
    positions.push(x, h, z);
    normals.push(n.x, n.y, n.z);
    return used[k];
  };
  const inHole = (x: number, z: number) => !!r.hole && x > r.hole.x0 && x < r.hole.x1 && z > r.hole.z0 && z < r.hole.z1;
  for (let j = 0; j + 1 < nz; j++) {
    for (let i = 0; i + 1 < nx; i++) {
      const h00 = heights[j * nx + i], h10 = heights[j * nx + i + 1], h01 = heights[(j + 1) * nx + i], h11 = heights[(j + 1) * nx + i + 1];
      if (Math.max(h00, h10, h01, h11) < -r.minDepth) continue;
      const x = r.x0 + i * r.step, z = r.z0 + j * r.step;
      if (inHole(x, z) && inHole(x + r.step, z) && inHole(x, z + r.step) && inHole(x + r.step, z + r.step)) continue;
      const a = vert(i, j), b = vert(i + 1, j), c = vert(i, j + 1), d = vert(i + 1, j + 1);
      // Split along the shorter diagonal for smoother ridgelines.
      if (Math.abs(h00 - h11) < Math.abs(h10 - h01)) indices.push(a, c, d, a, d, b);
      else indices.push(a, c, b, b, c, d);
    }
  }
  if (r.skirt) {
    // Vertical skirt around the border hides cracks against the coarser mesh.
    const drop = 40;
    const edge = (pts: [number, number][]) => {
      for (let k = 0; k + 1 < pts.length; k++) {
        const [i0, j0] = pts[k], [i1, j1] = pts[k + 1];
        const ha = heights[j0 * nx + i0], hb = heights[j1 * nx + i1];
        if (Math.max(ha, hb) < -r.minDepth) continue;
        const a = vert(i0, j0), b = vert(i1, j1);
        const base = positions.length / 3;
        positions.push(positions[a * 3], positions[a * 3 + 1] - drop, positions[a * 3 + 2]);
        positions.push(positions[b * 3], positions[b * 3 + 1] - drop, positions[b * 3 + 2]);
        normals.push(normals[a * 3], normals[a * 3 + 1], normals[a * 3 + 2], normals[b * 3], normals[b * 3 + 1], normals[b * 3 + 2]);
        indices.push(a, base, b, b, base, base + 1, a, b, base, b, base + 1, base);
      }
    };
    const top: [number, number][] = [], bottom: [number, number][] = [], left: [number, number][] = [], right: [number, number][] = [];
    for (let i = 0; i < nx; i++) {
      top.push([i, 0]);
      bottom.push([i, nz - 1]);
    }
    for (let j = 0; j < nz; j++) {
      left.push([0, j]);
      right.push([nx - 1, j]);
    }
    edge(top);
    edge(bottom);
    edge(left);
    edge(right);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setIndex(positions.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(indices, 1) : new THREE.Uint16BufferAttribute(indices, 1));
  geo.computeBoundingSphere();
  return geo;
}

export class Terrain {
  readonly group = new THREE.Group();
  readonly material: THREE.ShaderMaterial;
  readonly overlayTexture: THREE.Texture;

  constructor(data: TerrainData) {
    const ov = data.overlay.meta;
    this.overlayTexture = new THREE.Texture(data.overlay.image as unknown as HTMLImageElement);
    this.overlayTexture.flipY = false;
    this.overlayTexture.colorSpace = THREE.NoColorSpace;
    this.overlayTexture.minFilter = THREE.LinearMipmapLinearFilter;
    this.overlayTexture.magFilter = THREE.LinearFilter;
    this.overlayTexture.anisotropy = 4;
    this.overlayTexture.needsUpdate = true;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      fog: true,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uOverlay: { value: null },
          uOverlayRect: { value: new THREE.Vector4(ov.x0, ov.z0, 1 / (ov.nx * ov.step), 1 / (ov.nz * ov.step)) },
          uSunDir: { value: new THREE.Vector3(0, 1, 0) },
          uSunColor: { value: new THREE.Color(1, 1, 1) },
          uAmbSky: { value: new THREE.Color(0.6, 0.7, 0.9) },
          uAmbGround: { value: new THREE.Color(0.5, 0.4, 0.3) },
          uWetLine: { value: 0.35 },
        },
      ]),
    });
    this.material.uniforms.uOverlay.value = this.overlayTexture;

    const near = data.heightNear;
    const wide = data.heightWide;
    const nearRegion: MeshRegion = {
      x0: near.meta.x0,
      x1: near.x1,
      z0: near.meta.z0,
      z1: near.z1,
      step: 24,
      minDepth: 18,
      skirt: true,
    };
    const wideRegion: MeshRegion = {
      x0: wide.meta.x0,
      x1: wide.x1,
      z0: wide.meta.z0,
      z1: wide.z1,
      step: 140,
      minDepth: 25,
      skirt: false,
      hole: { x0: near.meta.x0 + 150, x1: near.x1 - 150, z0: near.meta.z0 + 150, z1: near.z1 - 150 },
    };
    const nearMesh = new THREE.Mesh(buildGrid(data, nearRegion), this.material);
    const wideMesh = new THREE.Mesh(buildGrid(data, wideRegion), this.material);
    nearMesh.name = 'terrain-near';
    wideMesh.name = 'terrain-wide';
    // Push the coarse mesh down slightly so the detailed one wins where they overlap.
    wideMesh.position.y = -0.6;
    this.group.add(nearMesh, wideMesh);
  }

  setLighting(sunDir: THREE.Vector3, sunColor: THREE.Color, sunIntensity: number, ambSky: THREE.Color, ambGround: THREE.Color, ambIntensity: number) {
    const u = this.material.uniforms;
    u.uSunDir.value.copy(sunDir);
    u.uSunColor.value.copy(sunColor).multiplyScalar(sunIntensity);
    u.uAmbSky.value.copy(ambSky).multiplyScalar(ambIntensity);
    u.uAmbGround.value.copy(ambGround).multiplyScalar(ambIntensity);
  }
}
