import * as THREE from 'three';

/** Shared per-frame uniforms for every animated village material. */
export interface VillageUniforms {
  uTime: { value: number };
  /** Downwind vector scaled by wind speed (m/s), xz. */
  uWind: { value: THREE.Vector2 };
}

export function makeUniforms(): VillageUniforms {
  return { uTime: { value: 0 }, uWind: { value: new THREE.Vector2(-2, 8) } };
}

// Atlas alpha decides whether the vertex colour tints the texel (stucco, thatch)
// or the texel is used as painted (glass, doors, signs).
const TINT_FRAGMENT = /* glsl */ `
#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
  diffuseColor.rgb *= mix( vec3( 1.0 ), vColor.rgb, sampledDiffuseColor.a );
  diffuseColor.a = opacity;
#endif
`;

// Walls facing away from the sun get only hemisphere light; in a sandy village
// the ground bounces a lot more, so shaded faces get extra fill.
const BOUNCE_FRAGMENT = /* glsl */ `
#include <lights_fragment_end>
  reflectedLight.indirectDiffuse *= 1.55;
`;

const ROT_GLSL = /* glsl */ `
vec2 vRot( vec2 v, float a ) { float c = cos( a ), s = sin( a ); return vec2( c * v.x - s * v.y, s * v.x + c * v.y ); }
`;

export function makeStaticMaterial(map: THREE.Texture) {
  const m = new THREE.MeshLambertMaterial({ map, vertexColors: true });
  m.onBeforeCompile = (s) => {
    s.fragmentShader = s.fragmentShader.replace('#include <color_fragment>', TINT_FRAGMENT).replace('#include <lights_fragment_end>', BOUNCE_FRAGMENT);
  };
  m.customProgramCacheKey = () => 'village-static-v2';
  return m;
}

/**
 * Vertex-animated props. Attributes: aPivot (world pivot) and aAnim =
 * (kind, phase, a, b). Kinds: 1 person idle (a = 1 for the head), 2 dog part
 * (a: 0 body, 1 head, 2 tail; b = tail energy), 3 cloth built along +x from the
 * pole (a = 0..1 along the cloth, b = cloth length), 4 boat at anchor (bow
 * along +x), 5 kite canopy on the sand (a = flutter weight).
 */
export function makeAnimatedMaterial(map: THREE.Texture, u: VillageUniforms) {
  const m = new THREE.MeshLambertMaterial({ map, vertexColors: true, side: THREE.DoubleSide });
  m.onBeforeCompile = (s) => {
    s.uniforms.uTime = u.uTime;
    s.uniforms.uWind = u.uWind;
    s.vertexShader = s.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec3 aPivot;
attribute vec4 aAnim;
uniform float uTime;
uniform vec2 uWind;
${ROT_GLSL}`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        /* glsl */ `
vec3 objectNormal = vec3( normal );
vec3 animPos = position;
{
  float kind = aAnim.x;
  float ph = aAnim.y;
  float spd = length( uWind );
  vec2 wdir = spd > 0.01 ? uWind / spd : vec2( 0.0, 1.0 );
  float wk = clamp( spd / 8.0, 0.0, 1.5 );
  vec3 rel = position - aPivot;
  if ( kind > 0.5 && kind < 1.5 ) {
    float yaw = 0.2 * sin( uTime * 0.31 + ph ) + 0.06 * sin( uTime * 0.83 + ph * 1.7 );
    if ( aAnim.z > 0.5 ) yaw += 0.4 * sin( uTime * 0.47 + ph * 2.3 );
    rel.xz = vRot( rel.xz, yaw );
    objectNormal.xz = vRot( objectNormal.xz, yaw );
    rel.x += rel.y * 0.015 * sin( uTime * 0.7 + ph );
    rel.y *= 1.0 + 0.008 * sin( uTime * 1.7 + ph );
    animPos = aPivot + rel;
  } else if ( kind > 1.5 && kind < 2.5 ) {
    if ( aAnim.z > 1.5 ) {
      float a = aAnim.w * 0.55 * sin( uTime * 10.0 + ph );
      rel.xz = vRot( rel.xz, a );
      objectNormal.xz = vRot( objectNormal.xz, a );
    } else if ( aAnim.z > 0.5 ) {
      float a = 0.5 * sin( uTime * 0.37 + ph ) + 0.15 * sin( uTime * 1.3 + ph );
      rel.xz = vRot( rel.xz, a );
      objectNormal.xz = vRot( objectNormal.xz, a );
      rel.y += 0.012 * sin( uTime * 2.1 + ph );
    } else {
      rel.y *= 1.0 + 0.025 * sin( uTime * 2.6 + ph );
    }
    animPos = aPivot + rel;
  } else if ( kind > 2.5 && kind < 3.5 ) {
    float u = aAnim.z;
    float L = aAnim.w;
    float om = 6.0 + 5.0 * wk;
    float arg = u * 5.5 - uTime * om + ph;
    float A = 0.05 + 0.09 * wk;
    rel.z += u * A * sin( arg ) * L;
    rel.y -= ( 1.0 - clamp( wk, 0.0, 1.0 ) ) * u * L * 0.55;
    float slope = A * ( sin( arg ) + 5.5 * u * cos( arg ) );
    objectNormal.x -= slope * objectNormal.z;
    objectNormal = normalize( objectNormal );
    float ang = atan( wdir.y, wdir.x );
    rel.xz = vRot( rel.xz, ang );
    objectNormal.xz = vRot( objectNormal.xz, ang );
    animPos = aPivot + rel;
  } else if ( kind > 3.5 && kind < 4.5 ) {
    float yaw = atan( -wdir.y, -wdir.x ) + 0.3 * sin( uTime * 0.11 + ph );
    float pitch = 0.035 * sin( uTime * 1.25 + ph );
    float roll = 0.06 * sin( uTime * 0.93 + ph * 1.3 );
    rel.zy = vRot( rel.zy, roll );
    objectNormal.zy = vRot( objectNormal.zy, roll );
    rel.xy = vRot( rel.xy, pitch );
    objectNormal.xy = vRot( objectNormal.xy, pitch );
    rel.xz = vRot( rel.xz, yaw );
    objectNormal.xz = vRot( objectNormal.xz, yaw );
    rel.y += 0.09 * sin( uTime * 1.1 + ph );
    animPos = aPivot + rel;
  } else if ( kind > 4.5 && kind < 5.5 ) {
    animPos += normal * aAnim.z * ( 0.04 + 0.05 * wk ) * sin( uTime * 7.5 + ph + aAnim.z * 4.0 );
  }
}`,
      )
      .replace('#include <begin_vertex>', 'vec3 transformed = animPos;');
    s.fragmentShader = s.fragmentShader.replace('#include <color_fragment>', TINT_FRAGMENT).replace('#include <lights_fragment_end>', BOUNCE_FRAGMENT);
  };
  m.customProgramCacheKey = () => 'village-animated-v2';
  return m;
}

/**
 * Instanced palms swaying with the wind. Geometry has a unit-height trunk
 * (uv.y = 0) and a crown in metres above y = 1 (uv.y = 1); uv.x is a frond
 * weight for leaf flutter. Per instance, aPalm = (trunk height m, lean x, lean z).
 */
export function makePalmMaterial(u: VillageUniforms) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  m.onBeforeCompile = (s) => {
    s.uniforms.uTime = u.uTime;
    s.uniforms.uWind = u.uWind;
    s.vertexShader = s.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec3 aPalm;
uniform float uTime;
uniform vec2 uWind;`,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `
float crown = step( 0.5, uv.y );
vec3 transformed = vec3( position );
transformed.y = mix( position.y * aPalm.x, position.y + aPalm.x - 1.0, crown );
float hN = mix( clamp( position.y, 0.0, 1.0 ), 1.0, crown );`,
      )
      .replace(
        '#include <project_vertex>',
        /* glsl */ `
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
  mvPosition.xz += aPalm.yz * hN * hN;
  {
    float sc = length( instanceMatrix[1].xyz );
    float h = max( transformed.y, 0.0 ) * sc;
    float spd = length( uWind );
    vec2 wd = spd > 0.01 ? uWind / spd : vec2( 0.0, 1.0 );
    float ph = dot( instanceMatrix[3].xz, vec2( 0.131, 0.173 ) );
    float gust = 0.65 + 0.25 * sin( uTime * 0.8 + ph ) + 0.1 * sin( uTime * 2.3 + ph * 1.7 );
    float bend = spd / 9.0 * gust * 0.45 * ( h / 10.0 ) * ( h / 10.0 );
    mvPosition.xz += wd * bend;
    float leaf = uv.x;
    mvPosition.y += leaf * ( 0.05 + 0.04 * spd / 9.0 ) * sin( uTime * 5.5 + ph * 3.0 + transformed.x * 2.0 + transformed.z * 1.7 );
    mvPosition.xz += wd * leaf * 0.12 * ( 0.5 + 0.5 * sin( uTime * 4.1 + ph + transformed.z * 2.3 ) );
  }
#endif
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;`,
      );
    s.fragmentShader = s.fragmentShader.replace('#include <lights_fragment_end>', BOUNCE_FRAGMENT);
  };
  m.customProgramCacheKey = () => 'village-palm-v2';
  return m;
}

/**
 * Wires and rebar: 1 px lines would read as heavy black strokes at range, so
 * alpha follows the real coverage of a ~1.5 cm wire (about 22 / distance) and
 * is gone by ~320 m.
 */
export function makeLineMaterial() {
  const m = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false });
  m.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vLineFade;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
  float lineDist = length( mvPosition.xyz );
  vLineFade = min( 1.0, 22.0 / max( lineDist, 1.0 ) ) * ( 1.0 - smoothstep( 170.0, 320.0, lineDist ) );`,
      );
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vLineFade;')
      .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.a *= vLineFade;');
  };
  m.customProgramCacheKey = () => 'village-lines-v1';
  return m;
}
