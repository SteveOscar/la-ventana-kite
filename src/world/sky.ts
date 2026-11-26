import * as THREE from 'three';
import { DEG, clamp, lerp, smoothstep } from '../core/math.ts';

/** Solar elevation/azimuth (radians; azimuth clockwise from north) via the NOAA approximation. */
export function solarPosition(lat: number, lon: number, dayOfYear: number, localHours: number, utcOffset: number) {
  const gamma = ((2 * Math.PI) / 365) * (dayOfYear - 1 + (localHours - 12) / 24);
  const eqtime =
    229.18 *
    (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma) - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
  const decl =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);
  const timeOffset = eqtime + 4 * lon - 60 * utcOffset;
  const tst = localHours * 60 + timeOffset;
  const ha = (tst / 4 - 180) * DEG;
  const phi = lat * DEG;
  const cosZen = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha);
  const zen = Math.acos(clamp(cosZen, -1, 1));
  const az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)) + Math.PI;
  return { elevation: Math.PI / 2 - zen, azimuth: az };
}

export interface SkyState {
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  sunIntensity: number;
  zenith: THREE.Color;
  horizon: THREE.Color;
  ambientSky: THREE.Color;
  ambientGround: THREE.Color;
  fog: THREE.Color;
  fogDensity: number;
  /** 0 at noon .. 1 at sunset glow, for warm tints elsewhere. */
  golden: number;
}

const c = (hex: number) => new THREE.Color(hex);
const KEYS = [
  // elevation (deg), sun color, zenith, horizon, sky ambient
  { el: -6, sun: c(0xff5a2a), zen: c(0x1a2550), hor: c(0x8a5560), amb: c(0x2a2d48) },
  { el: 0, sun: c(0xff7a36), zen: c(0x2c4785), hor: c(0xffa565), amb: c(0x5c5a7c) },
  { el: 6, sun: c(0xffa25c), zen: c(0x3563ad), hor: c(0xffc890), amb: c(0x7a88b0) },
  { el: 15, sun: c(0xffd9a8), zen: c(0x2f6fc9), hor: c(0xc9e2f2), amb: c(0x8fb0d8) },
  { el: 35, sun: c(0xfff1dc), zen: c(0x2a6ad0), hor: c(0xbfe0f5), amb: c(0x9ec0e6) },
  { el: 70, sun: c(0xfff8ee), zen: c(0x2563c9), hor: c(0xc4e4f7), amb: c(0xa3c6ea) },
];

export function skyStateFor(elevation: number, out?: SkyState): SkyState {
  const el = elevation / DEG;
  let i = 0;
  while (i < KEYS.length - 2 && el > KEYS[i + 1].el) i++;
  const a = KEYS[i], b = KEYS[i + 1];
  const t = clamp((el - a.el) / (b.el - a.el), 0, 1);
  const s: SkyState = out ?? {
    sunDir: new THREE.Vector3(),
    sunColor: new THREE.Color(),
    sunIntensity: 3,
    zenith: new THREE.Color(),
    horizon: new THREE.Color(),
    ambientSky: new THREE.Color(),
    ambientGround: new THREE.Color(),
    fog: new THREE.Color(),
    fogDensity: 2.4e-5,
    golden: 0,
  };
  s.sunColor.copy(a.sun).lerp(b.sun, t);
  s.zenith.copy(a.zen).lerp(b.zen, t);
  s.horizon.copy(a.hor).lerp(b.hor, t);
  s.ambientSky.copy(a.amb).lerp(b.amb, t);
  s.ambientGround.set(0xb89a72).multiplyScalar(lerp(0.25, 1, smoothstep(-4, 20, el)));
  s.sunIntensity = 3.3 * smoothstep(-3, 10, el) * lerp(0.75, 1, smoothstep(10, 40, el));
  s.golden = 1 - smoothstep(4, 22, el);
  s.fog.copy(s.horizon).lerp(new THREE.Color(0xd9ecf5), 0.25 * (1 - s.golden));
  return s;
}

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uGolden;
uniform float uTime;
uniform float uCloudCover;
varying vec3 vDir;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += vnoise(p) * a; p = p * 2.03 + 7.1; a *= 0.5; }
  return s;
}

void main() {
  vec3 d = normalize(vDir);
  float up = max(d.y, 0.0);
  vec3 col = mix(uHorizon, uZenith, pow(up, 0.42));
  // At dusk, blend from the glowing horizon to the blue through pale gold, not purple.
  vec3 pale = vec3(1.0, 0.78, 0.55);
  vec3 dusk = mix(mix(uHorizon, pale, smoothstep(0.0, 0.1, up)), uZenith, smoothstep(0.05, 0.45, up));
  col = mix(col, dusk, uGolden * 0.6);
  // Warm band low in the sky toward the sun at golden hour.
  float toward = max(dot(normalize(vec3(d.x, 0.0, d.z)), normalize(vec3(uSunDir.x, 0.0, uSunDir.z))), 0.0);
  col = mix(col, vec3(1.0, 0.62, 0.38), uGolden * pow(1.0 - up, 6.0) * (0.35 + 0.65 * toward) * 0.65);
  float sd = max(dot(d, uSunDir), 0.0);
  col += uSunColor * (pow(sd, 9.0) * 0.18 + pow(sd, 90.0) * 0.35) * (0.6 + uGolden);
  // Scattered fair-weather clouds drifting south on the Norte.
  if (d.y > 0.01) {
    vec2 uv = d.xz / (d.y + 0.08) * 1.6 + vec2(0.0, uTime * 0.004);
    float n = fbm(uv * 1.3);
    float cover = smoothstep(0.62 - uCloudCover * 0.25, 0.82, n) * smoothstep(0.01, 0.18, d.y);
    float shade = smoothstep(0.55, 0.9, fbm(uv * 1.3 + vec2(0.06, 0.03)));
    vec3 cloud = mix(vec3(1.0), uHorizon * 0.85, shade * 0.6);
    cloud = mix(cloud, vec3(1.0, 0.72, 0.55), uGolden * 0.6);
    col = mix(col, cloud, cover * 0.85);
  }
  // Sun disk.
  col += uSunColor * smoothstep(0.99985, 0.99993, sd) * 12.0;
  // Below the horizon the sea hides the sky; keep it a hazy horizon tone.
  col = mix(col, uHorizon, smoothstep(0.0, -0.04, d.y));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class Sky {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly state: SkyState;
  /** Latitude/longitude for the solar position. */
  lat = 24.05;
  lon = -109.99;
  dayOfYear = 20;
  utcOffset = -7;

  constructor(scene: THREE.Scene) {
    this.state = skyStateFor(40 * DEG);
    this.material = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uZenith: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color() },
        uGolden: { value: 0 },
        uTime: { value: 0 },
        uCloudCover: { value: 0.35 },
      },
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1000, 48, 24), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
    scene.add(this.mesh);

    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -36;
    sc.right = 36;
    sc.top = 36;
    sc.bottom = -36;
    sc.near = 1;
    sc.far = 400;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    scene.add(this.sun);
    scene.add(this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xa0c4ea, 0xb89a72, 1.1);
    scene.add(this.hemi);
  }

  /** Updates sun, lights, fog and sky for the local clock time. `focus` = where shadows are needed. */
  update(hours: number, time: number, camera: THREE.Camera, focus: THREE.Vector3, fog: THREE.FogExp2) {
    const { elevation, azimuth } = solarPosition(this.lat, this.lon, this.dayOfYear, hours, this.utcOffset);
    const s = skyStateFor(elevation, this.state);
    s.sunDir.set(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), -Math.cos(azimuth) * Math.cos(elevation)).normalize();
    // Keep a little light from a sun just below the hills.
    const lightDir = s.sunDir.clone();
    if (lightDir.y < 0.06) lightDir.y = 0.06;
    lightDir.normalize();

    const u = this.material.uniforms;
    u.uZenith.value.copy(s.zenith);
    u.uHorizon.value.copy(s.horizon);
    u.uSunDir.value.copy(s.sunDir);
    u.uSunColor.value.copy(s.sunColor);
    u.uGolden.value = s.golden;
    u.uTime.value = time;
    this.mesh.position.copy(camera.position);

    this.sun.color.copy(s.sunColor);
    this.sun.intensity = s.sunIntensity;
    this.sun.position.copy(focus).addScaledVector(lightDir, 200);
    this.sun.target.position.copy(focus);
    this.hemi.color.copy(s.ambientSky);
    this.hemi.groundColor.copy(s.ambientGround);
    this.hemi.intensity = lerp(0.35, 1.15, smoothstep(-6, 25, elevation / DEG));
    fog.color.copy(s.fog);
    fog.density = s.fogDensity;
    return s;
  }
}
