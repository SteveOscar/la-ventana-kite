import type * as THREE from 'three';
import { GeoBuilder, BODY, mix, rgb, rigGroup, solid, type Paint, type RGB, type Rig, type Station, type WingStation } from './builder.ts';
import type { CreatureRig } from './creatures.ts';

// Local frame for every model: +z forward (nose), +y up, +x the animal's left. Metres.

export interface Model {
  geometry: THREE.BufferGeometry;
  rig: CreatureRig;
}

const pair = (a: RGB, b: RGB): [RGB, RGB] => [a, b];
const headRig = (from: number) => (z: number): Rig => (z >= from ? rigGroup(5) : BODY);

function eyes(b: GeoBuilder, x: number, y: number, z: number, r: number, color: RGB, rig: Rig = BODY) {
  for (const s of [1, -1]) b.blob(x * s, y, z, r, r, r, solid(color), rig, 6);
}

function wings(b: GeoBuilder, stations: WingStation[], wrist: number, thick: number, top: Paint, bottom: Paint, chords?: number[]) {
  b.wing(1, stations, wrist, thick, top, bottom, chords);
  b.wing(-1, stations, wrist, thick, top, bottom, chords);
}

/** Brown pelican: silver-grey back, dark belly, white or chestnut neck, long bill and pouch. */
export function pelican(): Model {
  const b = new GeoBuilder();
  const back = rgb(0x8d8780), belly = rgb(0x4f4740), white = rgb(0xf4ecd6), yellow = rgb(0xf0d27a), chestnut = rgb(0x5b3522);
  const body: Paint = (_x, _y, z, up) => {
    if (z > 0.36) return pair(white, up > 0.45 ? yellow : white);
    if (z > 0.2) return pair(mix(white, back, up < -0.3 ? 0.4 : 0), up > -0.2 ? chestnut : mix(white, back, 0.3));
    const c = up > -0.15 ? back : belly;
    return pair(c, c);
  };
  const stations: Station[] = [
    { z: -0.52, w: 0, top: 0, y: 0.03 },
    { z: -0.46, w: 0.09, top: 0.012, y: 0.03 },
    { z: -0.34, w: 0.1, top: 0.04, bot: 0.03, y: 0.03 },
    { z: -0.22, w: 0.135, top: 0.09, y: 0.01 },
    { z: -0.02, w: 0.16, top: 0.12 },
    { z: 0.14, w: 0.145, top: 0.115, bot: 0.11, y: 0.01 },
    { z: 0.25, w: 0.105, top: 0.1, bot: 0.09, y: 0.04 },
    { z: 0.33, w: 0.085, top: 0.08, bot: 0.075, y: 0.09 },
    { z: 0.4, w: 0.07, top: 0.065, bot: 0.06, y: 0.12 },
    { z: 0.47, w: 0.05, top: 0.045, bot: 0.04, y: 0.12 },
    { z: 0.5, w: 0, top: 0, y: 0.115 },
  ];
  b.loft(stations, 10, body, headRig(0.3));
  const billC = rgb(0xb09878), billTip = rgb(0xc8784a), pouch = rgb(0x4e4438);
  b.loft(
    [
      { z: 0.44, w: 0.04, top: 0.024, bot: 0.034, y: 0.11 },
      { z: 0.56, w: 0.038, top: 0.016, bot: 0.06, y: 0.09 },
      { z: 0.7, w: 0.034, top: 0.013, bot: 0.045, y: 0.065 },
      { z: 0.8, w: 0.028, top: 0.012, bot: 0.018, y: 0.045 },
      { z: 0.85, w: 0, top: 0, y: 0.028 },
    ],
    6,
    (_x, _y, z, up) => (up > -0.1 ? (z > 0.76 ? pair(billTip, billTip) : pair(billC, billC)) : pair(pouch, pouch)),
    rigGroup(5),
  );
  eyes(b, 0.055, 0.135, 0.43, 0.012, rgb(0x1a1a1a), rigGroup(5));
  const coverts = rgb(0xaaa499), secondaries = rgb(0x3a342f), primaries = rgb(0x26221f), under = rgb(0x6a635b);
  wings(
    b,
    [
      { x: 0.09, y: 0.05, le: 0.17, te: -0.15 },
      { x: 0.3, y: 0.055, le: 0.19, te: -0.18 },
      { x: 0.52, y: 0.055, le: 0.18, te: -0.18 },
      { x: 0.75, y: 0.05, le: 0.12, te: -0.15 },
      { x: 0.95, y: 0.045, le: 0.04, te: -0.12 },
      { x: 1.06, y: 0.04, le: -0.04, te: -0.09 },
    ],
    2,
    0.03,
    (span, chord) => {
      const c = span > 0.5 ? (chord < 0.3 && span < 0.7 ? mix(coverts, primaries, 0.5) : primaries) : chord < 0.52 ? coverts : secondaries;
      return pair(c, c);
    },
    (span, chord) => {
      const c = span > 0.5 || chord > 0.52 ? primaries : under;
      return pair(c, c);
    },
    [0, 0.3, 0.5, 0.56, 1],
  );
  return {
    geometry: b.build(),
    rig: { shoulder: [0.09, 0.05, 0.02], wrist: [0.52, 0.055, 0.0], fold: [1.25, 2.3], headPivot: [0, 0.07, 0.24] },
  };
}

/** Magnificent frigatebird: long crooked black wings, deeply forked tail; females have a white breast. */
export function frigate(): Model {
  const b = new GeoBuilder();
  const black = rgb(0x171515), brown = rgb(0x4a3a30), white = rgb(0xf2f0ea), red = rgb(0xb3241e), grey = rgb(0x8a8a88);
  const body: Paint = (_x, _y, z, up) => {
    if (up < -0.2 && z > -0.1 && z < 0.2) return pair(z > 0.13 ? red : black, white);
    return pair(black, black);
  };
  b.loft(
    [
      { z: -0.3, w: 0, top: 0 },
      { z: -0.26, w: 0.05, top: 0.035, bot: 0.03 },
      { z: -0.12, w: 0.075, top: 0.065, bot: 0.07 },
      { z: 0.05, w: 0.085, top: 0.075, bot: 0.085 },
      { z: 0.17, w: 0.06, top: 0.06, y: 0.01 },
      { z: 0.24, w: 0.045, top: 0.045, bot: 0.04, y: 0.02 },
      { z: 0.29, w: 0.03, top: 0.03, y: 0.02 },
      { z: 0.31, w: 0, top: 0, y: 0.02 },
    ],
    8,
    body,
  );
  b.loft(
    [
      { z: 0.28, w: 0.013, top: 0.012, y: 0.02 },
      { z: 0.42, w: 0.008, top: 0.008, y: 0.012 },
      { z: 0.46, w: 0, top: 0, y: -0.005 },
    ],
    5,
    solid(grey),
  );
  const prong = (s: 1 | -1): [number, number, number][] => [
    [0, 0.0, -0.22],
    [0.04 * s, 0.0, -0.27],
    [0.05 * s, 0.0, -0.74],
    [0.022 * s, 0.0, -0.66],
  ];
  b.plate(prong(1), [0, 1, 0], 0.012, solid(black), rigGroup(2));
  b.plate(prong(-1), [0, 1, 0], 0.012, solid(black), rigGroup(3));
  wings(
    b,
    [
      { x: 0.06, y: 0.04, le: 0.11, te: -0.12 },
      { x: 0.3, y: 0.05, le: 0.13, te: -0.12 },
      { x: 0.5, y: 0.05, le: 0.11, te: -0.1 },
      { x: 0.78, y: 0.04, le: -0.02, te: -0.17 },
      { x: 1.02, y: 0.03, le: -0.16, te: -0.25 },
      { x: 1.14, y: 0.02, le: -0.25, te: -0.29 },
    ],
    2,
    0.02,
    (span, chord) => {
      const c = span < 0.45 && chord > 0.3 && chord < 0.7 ? brown : black;
      return pair(c, c);
    },
    solid(black),
  );
  return {
    geometry: b.build(),
    rig: { shoulder: [0.06, 0.04, 0.0], wrist: [0.5, 0.05, 0.0], fold: [1.1, 2.0], tailPivot: [0, 0, -0.24] },
  };
}

/** Heermann's gull (default) and yellow-footed gull (variant). */
export function gull(): Model {
  const b = new GeoBuilder();
  const hGrey = rgb(0x44484d), hPale = rgb(0x6a6e73), white = rgb(0xf3f3f0), slate = rgb(0x262a2f), black = rgb(0x18191b);
  const body: Paint = (_x, _y, z, up) => {
    if (z > 0.14) return pair(z > 0.17 ? white : mix(white, hGrey, 0.4), white);
    if (z < -0.17) return pair(up > -0.5 ? black : hGrey, white);
    return pair(up > -0.3 ? hGrey : hPale, up > 0.3 ? slate : white);
  };
  b.loft(
    [
      { z: -0.24, w: 0, top: 0, y: 0.02 },
      { z: -0.2, w: 0.05, top: 0.012, y: 0.02 },
      { z: -0.12, w: 0.055, top: 0.035, bot: 0.03, y: 0.015 },
      { z: -0.02, w: 0.07, top: 0.06, bot: 0.065 },
      { z: 0.09, w: 0.065, top: 0.06 },
      { z: 0.15, w: 0.045, top: 0.045, bot: 0.04, y: 0.03 },
      { z: 0.2, w: 0.042, top: 0.042, bot: 0.04, y: 0.05 },
      { z: 0.245, w: 0.025, top: 0.025, bot: 0.02, y: 0.05 },
      { z: 0.26, w: 0, top: 0, y: 0.048 },
    ],
    8,
    body,
  );
  const red = rgb(0xd8352b), yellow = rgb(0xe8c22c);
  b.loft(
    [
      { z: 0.24, w: 0.011, top: 0.009, bot: 0.012, y: 0.045 },
      { z: 0.3, w: 0.007, top: 0.006, bot: 0.009, y: 0.04 },
      { z: 0.32, w: 0, top: 0, y: 0.036 },
    ],
    5,
    (_x, _y, z) => (z > 0.29 ? pair(black, red) : pair(red, yellow)),
  );
  eyes(b, 0.034, 0.06, 0.215, 0.007, black);
  wings(
    b,
    [
      { x: 0.045, y: 0.03, le: 0.07, te: -0.08 },
      { x: 0.17, y: 0.035, le: 0.08, te: -0.08 },
      { x: 0.3, y: 0.035, le: 0.07, te: -0.07 },
      { x: 0.47, y: 0.03, le: 0.02, te: -0.08 },
      { x: 0.62, y: 0.025, le: -0.06, te: -0.09 },
    ],
    2,
    0.016,
    (span, chord) => {
      if (span > 0.6) return pair(black, black);
      if (chord > 0.86) return pair(white, white);
      return pair(hGrey, slate);
    },
    (span, chord) => (span > 0.6 ? pair(black, mix(black, white, 0.3)) : pair(hPale, chord > 0.6 ? rgb(0xb8bcc0) : white)),
    [0, 0.45, 0.82, 0.88, 1],
  );
  return { geometry: b.build(), rig: { shoulder: [0.045, 0.03, 0.0], wrist: [0.3, 0.035, 0.0], fold: [1.2, 2.2] } };
}

/** Osprey: brown above, white below, dark eye stripe, crooked wings, talons and (sometimes) a fish. */
export function osprey(): Model {
  const b = new GeoBuilder();
  const brown = rgb(0x4b3626), white = rgb(0xf1ede5), dark = rgb(0x261c14), stripe = rgb(0x2e241c);
  const body: Paint = (_x, _y, z, up) => {
    if (z > 0.16) return up > 0.55 || up < -0.4 ? pair(white, white) : pair(stripe, stripe);
    if (z < -0.2) return pair(up > 0 ? brown : rgb(0xc8c0b4), up > 0 ? brown : rgb(0xc8c0b4));
    return up > 0.1 ? pair(brown, brown) : pair(white, white);
  };
  b.loft(
    [
      { z: -0.34, w: 0, top: 0, y: 0.01 },
      { z: -0.3, w: 0.06, top: 0.012, y: 0.01 },
      { z: -0.18, w: 0.06, top: 0.035, bot: 0.03, y: 0.01 },
      { z: -0.05, w: 0.085, top: 0.07, bot: 0.08 },
      { z: 0.08, w: 0.08, top: 0.07, bot: 0.075 },
      { z: 0.16, w: 0.055, top: 0.055, bot: 0.05, y: 0.02 },
      { z: 0.22, w: 0.05, top: 0.05, bot: 0.045, y: 0.035 },
      { z: 0.27, w: 0.03, top: 0.03, bot: 0.025, y: 0.03 },
      { z: 0.29, w: 0, top: 0, y: 0.025 },
    ],
    8,
    body,
  );
  b.loft(
    [
      { z: 0.26, w: 0.014, top: 0.014, bot: 0.012, y: 0.03 },
      { z: 0.31, w: 0.008, top: 0.008, y: 0.02 },
      { z: 0.325, w: 0, top: 0, y: 0.0 },
    ],
    5,
    solid(rgb(0x222222)),
  );
  eyes(b, 0.038, 0.05, 0.235, 0.008, rgb(0xe8c040));
  // Legs, tucked back under the tail at rest; the limb channel swings them forward.
  const leg = rgb(0xc9c2a8), talon = rgb(0x1a1a1a);
  for (const s of [1, -1]) {
    b.loft(
      [
        { z: -0.21, w: 0, top: 0, x: 0.03 * s, y: -0.07 },
        { z: -0.19, w: 0.016, top: 0.016, x: 0.03 * s, y: -0.07 },
        { z: -0.03, w: 0.018, top: 0.018, x: 0.032 * s, y: -0.06 },
        { z: -0.01, w: 0, top: 0, x: 0.032 * s, y: -0.06 },
      ],
      5,
      solid(leg),
      rigGroup(1),
    );
    b.blob(0.03 * s, -0.075, -0.22, 0.03, 0.012, 0.03, solid(talon), rigGroup(1), 5);
  }
  const silver = rgb(0xb8c4cc), fishBack = rgb(0x4a6070);
  b.loft(
    [
      { z: -0.36, w: 0, top: 0, y: -0.1 },
      { z: -0.33, w: 0.008, top: 0.04, y: -0.1 },
      { z: -0.29, w: 0.012, top: 0.012, y: -0.1 },
      { z: -0.2, w: 0.025, top: 0.04, y: -0.1 },
      { z: -0.1, w: 0.012, top: 0.02, y: -0.1 },
      { z: -0.07, w: 0, top: 0, y: -0.1 },
    ],
    6,
    (_x, _y, _z, up) => (up > 0.3 ? pair(fishBack, fishBack) : pair(silver, silver)),
    rigGroup(4),
  );
  wings(
    b,
    [
      { x: 0.055, y: 0.04, le: 0.09, te: -0.11 },
      { x: 0.2, y: 0.05, le: 0.1, te: -0.11 },
      { x: 0.34, y: 0.05, le: 0.1, te: -0.09 },
      { x: 0.55, y: 0.04, le: 0.03, te: -0.12 },
      { x: 0.74, y: 0.03, le: -0.05, te: -0.13 },
      { x: 0.8, y: 0.025, le: -0.09, te: -0.12 },
    ],
    2,
    0.018,
    (span) => (span > 0.6 ? pair(dark, dark) : pair(brown, brown)),
    (span, chord) => {
      if (span > 0.78) return pair(dark, dark);
      if (span > 0.36 && span < 0.52 && chord < 0.4) return pair(dark, dark);
      return chord > 0.6 ? pair(rgb(0xa8a298), rgb(0xa8a298)) : pair(white, white);
    },
    [0, 0.38, 0.42, 0.58, 0.62, 1],
  );
  return {
    geometry: b.build(),
    rig: { shoulder: [0.055, 0.04, 0.0], wrist: [0.34, 0.05, 0.0], fold: [1.15, 2.1], limbPivot: [0, -0.06, -0.02] },
  };
}

/** Long-beaked common dolphin (default) and bottlenose (variant). */
export function dolphin(): Model {
  const b = new GeoBuilder();
  const back = rgb(0x2a3038), tan = rgb(0xc9b07c), grey = rgb(0x8d939a), white = rgb(0xeceeec);
  const bnBack = rgb(0x5f6873), bnSide = rgb(0x8c95a0), bnBelly = rgb(0xd5dadd);
  const body: Paint = (_x, _y, z, up) => {
    let c: RGB;
    if (up > 0.35) c = back;
    else if (up < -0.45) c = white;
    else if (z > 0.0 && z < 0.78) c = up > 0.05 && z > 0.1 && z < 0.4 ? back : tan;
    else c = z >= 0.78 ? back : grey;
    const c2 = up > 0.3 ? bnBack : up < -0.4 ? bnBelly : bnSide;
    return pair(c, c2);
  };
  b.loft(
    [
      { z: -0.9, w: 0, top: 0, y: 0.02 },
      { z: -0.85, w: 0.035, top: 0.06, y: 0.02 },
      { z: -0.7, w: 0.06, top: 0.11, y: 0.02 },
      { z: -0.45, w: 0.12, top: 0.17, y: 0.01 },
      { z: -0.15, w: 0.19, top: 0.22 },
      { z: 0.15, w: 0.22, top: 0.24 },
      { z: 0.45, w: 0.2, top: 0.21, y: 0.01 },
      { z: 0.68, w: 0.15, top: 0.16, y: 0.02 },
      { z: 0.8, w: 0.09, top: 0.1, y: 0.02 },
      { z: 0.88, w: 0.05, top: 0.05, y: -0.01 },
      { z: 1.0, w: 0.03, top: 0.03, y: -0.02 },
      { z: 1.1, w: 0, top: 0, y: -0.02 },
    ],
    10,
    body,
  );
  eyes(b, 0.125, 0.03, 0.72, 0.014, rgb(0x101214));
  b.plate(
    [
      [0, 0.2, 0.24],
      [0, 0.4, 0.05],
      [0, 0.5, -0.15],
      [0, 0.33, -0.06],
      [0, 0.2, -0.14],
    ],
    [1, 0, 0],
    0.03,
    solid(back, bnBack),
  );
  for (const s of [1, -1] as const) {
    b.plate(
      [
        [0, 0.02, -0.8],
        [0.3 * s, 0.02, -0.99],
        [0.23 * s, 0.02, -1.06],
        [0, 0.02, -0.97],
      ],
      [0, 1, 0],
      0.025,
      solid(back, bnBack),
    );
  }
  wings(
    b,
    [
      { x: 0.13, y: -0.1, le: 0.5, te: 0.36 },
      { x: 0.26, y: -0.15, le: 0.42, te: 0.3 },
      { x: 0.38, y: -0.2, le: 0.3, te: 0.23 },
    ],
    1,
    0.025,
    solid(back, bnBack),
    solid(grey, bnSide),
  );
  b.setFlex((_x, _y, z) => Math.pow(Math.min(1.2, Math.max(0, (0.05 - z) / 1.0)), 1.3));
  return { geometry: b.build(), rig: { shoulder: [0.13, -0.1, 0.45], wrist: [0.26, -0.15, 0.4], flexPivot: [0, 0, 0.05] } };
}

/** Humpback whale: dark and knobbly with long white flippers and a serrated fluke. */
export function humpback(): Model {
  const b = new GeoBuilder();
  const top = rgb(0x262b32), side = rgb(0x3e454e), belly = rgb(0x8a9096), white = rgb(0xdfe3e3);
  const body: Paint = (_x, _y, z, up) => {
    if (up > 0.25) return pair(top, top);
    if (up > -0.3) return pair(side, side);
    if (z > 0.8 && z < 5.6) return pair(up < -0.7 ? white : belly, white);
    return pair(belly, z > -2 ? white : belly);
  };
  b.loft(
    [
      { z: -5.75, w: 0, top: 0, y: 0.1 },
      { z: -5.4, w: 0.15, top: 0.25, y: 0.1 },
      { z: -4.8, w: 0.25, top: 0.45, y: 0.1 },
      { z: -3.6, w: 0.5, top: 0.75, y: 0.1 },
      { z: -2.2, w: 0.95, top: 1.0, y: 0.05 },
      { z: -0.6, w: 1.35, top: 1.2 },
      { z: 1.2, w: 1.5, top: 1.22, bot: 1.3, y: -0.1 },
      { z: 3.0, w: 1.45, top: 1.08, bot: 1.25, y: -0.15 },
      { z: 4.5, w: 1.25, top: 0.8, bot: 0.95, y: -0.12 },
      { z: 5.5, w: 0.95, top: 0.5, bot: 0.62, y: -0.06 },
      { z: 6.3, w: 0.5, top: 0.25, bot: 0.3, y: -0.06 },
      { z: 6.6, w: 0, top: 0, y: -0.1 },
    ],
    14,
    body,
  );
  // Knobs (tubercles) on the rostrum and the splash guard in front of the blowholes.
  const knob = rgb(0x1d2126);
  for (const [x, z] of [
    [0, 5.95],
    [0, 5.45],
    [0, 4.9],
    [0.38, 5.55],
    [-0.38, 5.55],
    [0.5, 4.9],
    [-0.5, 4.9],
  ])
    b.blob(x, 0.31 + (5.95 - z) * 0.27 - Math.abs(x) * 0.15, z, 0.12, 0.08, 0.12, solid(knob), BODY, 5);
  b.blob(0, 0.86, 3.55, 0.32, 0.12, 0.3, solid(knob), BODY, 6);
  eyes(b, 1.27, -0.25, 4.15, 0.07, rgb(0x0c0e10));
  b.plate(
    [
      [0, 0.98, -1.4],
      [0, 1.32, -1.95],
      [0, 1.48, -2.35],
      [0, 1.02, -2.7],
    ],
    [1, 0, 0],
    0.18,
    solid(top),
  );
  for (const s of [1, -1] as const) {
    const pts: [number, number, number][] = [
      [0, 0.12, -5.2],
      [1.0 * s, 0.12, -5.55],
      [1.9 * s, 0.12, -5.95],
      [2.25 * s, 0.12, -6.2],
      [1.8 * s, 0.12, -6.22],
      [1.5 * s, 0.12, -6.32],
      [1.1 * s, 0.12, -6.28],
      [0.7 * s, 0.12, -6.38],
      [0.3 * s, 0.12, -6.3],
      [0, 0.12, -6.15],
    ];
    // Upper side dark; the underside is the white pattern used to identify individuals.
    b.plate(pts, [0, 1, 0], 0.12, solid(top), BODY, (x, _y, z) => {
      const edge = z < -6.18 || Math.abs(x) > 2.0;
      return pair(edge ? top : white, edge || Math.abs(x) < 0.5 ? top : white);
    });
  }
  wings(
    b,
    [
      { x: 1.2, y: -0.55, le: 3.75, te: 2.85 },
      { x: 2.4, y: -0.95, le: 3.15, te: 2.45 },
      { x: 3.6, y: -1.3, le: 2.45, te: 1.95 },
      { x: 4.5, y: -1.5, le: 1.85, te: 1.6 },
    ],
    1,
    0.16,
    (span, chord) => (chord < 0.25 && span < 0.6 ? pair(side, mix(white, side, 0.3)) : pair(mix(white, side, 0.15), white)),
    solid(white),
    [0, 0.22, 0.3, 1],
  );
  b.setFlex((_x, _y, z) => Math.pow(Math.min(1.1, Math.max(0, (-0.5 - z) / 5.5)), 1.25));
  return {
    geometry: b.build(),
    rig: { shoulder: [1.2, -0.55, 3.3], wrist: [2.4, -0.95, 2.8], flexPivot: [0, 0, -0.5] },
  };
}

/** California sea lion: tan female (default) or dark brown bull (variant). */
export function seaLion(): Model {
  const b = new GeoBuilder();
  const tan = rgb(0x7b5a3c), tanBelly = rgb(0x9a7752), bull = rgb(0x35271d), bullBelly = rgb(0x4a3828);
  const body: Paint = (_x, _y, _z, up) => (up > -0.3 ? pair(tan, bull) : pair(tanBelly, bullBelly));
  b.loft(
    [
      { z: -0.78, w: 0, top: 0 },
      { z: -0.7, w: 0.06, top: 0.05 },
      { z: -0.5, w: 0.12, top: 0.1 },
      { z: -0.2, w: 0.19, top: 0.17 },
      { z: 0.1, w: 0.22, top: 0.2, bot: 0.21 },
      { z: 0.32, w: 0.17, top: 0.16, y: 0.02 },
      { z: 0.48, w: 0.105, top: 0.105, bot: 0.1, y: 0.04 },
      { z: 0.6, w: 0.1, top: 0.105, bot: 0.09, y: 0.06 },
      { z: 0.72, w: 0.085, top: 0.085, bot: 0.07, y: 0.06 },
      { z: 0.82, w: 0.05, top: 0.05, bot: 0.045, y: 0.045 },
      { z: 0.9, w: 0.03, top: 0.03, y: 0.04 },
      { z: 0.93, w: 0, top: 0, y: 0.04 },
    ],
    10,
    body,
    headRig(0.55),
  );
  const black = rgb(0x0c0c0c);
  eyes(b, 0.068, 0.1, 0.74, 0.018, black, rigGroup(5));
  for (const s of [1, -1]) b.blob(0.085 * s, 0.13, 0.64, 0.012, 0.02, 0.012, solid(bull, black), rigGroup(5), 4);
  b.blob(0, 0.05, 0.925, 0.018, 0.014, 0.012, solid(black), rigGroup(5), 4);
  const flipper = rgb(0x2e2218);
  wings(
    b,
    [
      { x: 0.15, y: -0.1, le: 0.3, te: 0.12 },
      { x: 0.36, y: -0.14, le: 0.2, te: 0.05 },
      { x: 0.56, y: -0.16, le: 0.06, te: -0.04 },
    ],
    1,
    0.03,
    solid(flipper),
    solid(flipper),
  );
  for (const s of [1, -1] as const) {
    b.plate(
      [
        [0.02 * s, -0.03, -0.66],
        [0.15 * s, -0.03, -0.95],
        [0.09 * s, -0.03, -1.03],
        [0.01 * s, -0.03, -0.93],
      ],
      [0, 1, 0],
      0.025,
      solid(flipper),
    );
  }
  b.setFlex((_x, _y, z) => Math.min(1, Math.max(0, (-0.1 - z) / 0.9)));
  return {
    geometry: b.build(),
    rig: { shoulder: [0.15, -0.1, 0.2], wrist: [0.36, -0.14, 0.12], headPivot: [0, 0.04, 0.48], flexPivot: [0, 0, -0.1] },
  };
}

/** Sea turtle: olive ridley (default) or green turtle (variant). */
export function turtle(): Model {
  const b = new GeoBuilder();
  const shellA = rgb(0x5d5a34), shellB = rgb(0x413f24), greenA = rgb(0x5a4a30), greenB = rgb(0x3c3020), plastron = rgb(0xd6c690);
  const shell: Paint = (x, _y, z, up) => {
    if (up < -0.2) return pair(plastron, plastron);
    const n = Math.sin(x * 23.1 + z * 17.3) * Math.sin(x * 11.7 - z * 29.9);
    return n > 0.15 ? pair(shellB, greenB) : pair(shellA, greenA);
  };
  b.loft(
    [
      { z: -0.44, w: 0, top: 0, y: 0.02 },
      { z: -0.38, w: 0.16, top: 0.05, bot: 0.03 },
      { z: -0.22, w: 0.33, top: 0.13, bot: 0.05 },
      { z: 0.0, w: 0.38, top: 0.17, bot: 0.06 },
      { z: 0.2, w: 0.34, top: 0.14, bot: 0.055 },
      { z: 0.34, w: 0.22, top: 0.08, bot: 0.04 },
      { z: 0.4, w: 0, top: 0, y: 0.03 },
    ],
    12,
    shell,
    BODY,
    2.6,
  );
  const skin = rgb(0x6c6b56), skinPale = rgb(0xb4ae8c);
  const skinPaint: Paint = (_x, _y, _z, up) => (up > -0.2 ? pair(skin, rgb(0x5a503a)) : pair(skinPale, skinPale));
  b.loft(
    [
      { z: 0.3, w: 0.06, top: 0.05, y: 0.02 },
      { z: 0.45, w: 0.065, top: 0.055, bot: 0.05, y: 0.03 },
      { z: 0.55, w: 0.07, top: 0.06, bot: 0.05, y: 0.04 },
      { z: 0.62, w: 0.045, top: 0.04, bot: 0.035, y: 0.035 },
      { z: 0.66, w: 0, top: 0, y: 0.03 },
    ],
    8,
    skinPaint,
    rigGroup(5),
  );
  eyes(b, 0.06, 0.06, 0.58, 0.012, rgb(0x101010), rigGroup(5));
  wings(
    b,
    [
      { x: 0.24, y: 0.0, le: 0.24, te: 0.1 },
      { x: 0.5, y: -0.01, le: 0.16, te: 0.02 },
      { x: 0.78, y: -0.02, le: 0.02, te: -0.06 },
    ],
    1,
    0.03,
    skinPaint,
    solid(skinPale),
  );
  for (const s of [1, -1] as const) {
    b.plate(
      [
        [0.15 * s, -0.01, -0.3],
        [0.32 * s, -0.01, -0.42],
        [0.24 * s, -0.01, -0.52],
        [0.12 * s, -0.01, -0.42],
      ],
      [0, 1, 0],
      0.025,
      skinPaint,
    );
  }
  return { geometry: b.build(), rig: { shoulder: [0.24, 0.0, 0.18], wrist: [0.5, -0.01, 0.1], headPivot: [0, 0.02, 0.34] } };
}

/** Munk's devil ray: dark above, white below, cephalic fins and a whip tail. */
export function mobula(): Model {
  const b = new GeoBuilder();
  const dark = rgb(0x23272c), white = rgb(0xebebe6);
  const body: Paint = (_x, _y, _z, up) => (up > -0.1 ? pair(dark, dark) : pair(white, white));
  b.loft(
    [
      { z: -0.22, w: 0, top: 0 },
      { z: -0.16, w: 0.06, top: 0.025, bot: 0.02 },
      { z: 0.0, w: 0.12, top: 0.05, bot: 0.04 },
      { z: 0.16, w: 0.12, top: 0.045, bot: 0.035 },
      { z: 0.24, w: 0.1, top: 0.03, bot: 0.025 },
      { z: 0.27, w: 0, top: 0 },
    ],
    8,
    body,
  );
  b.loft(
    [
      { z: -0.78, w: 0, top: 0 },
      { z: -0.5, w: 0.006, top: 0.006 },
      { z: -0.18, w: 0.012, top: 0.012 },
      { z: -0.14, w: 0, top: 0 },
    ],
    4,
    solid(dark),
  );
  for (const s of [1, -1] as const) {
    b.plate(
      [
        [0.05 * s, 0, 0.23],
        [0.1 * s, 0, 0.22],
        [0.09 * s, -0.01, 0.36],
        [0.06 * s, -0.01, 0.34],
      ],
      [0, 1, 0],
      0.012,
      solid(dark),
      BODY,
      solid(white),
    );
  }
  wings(
    b,
    [
      { x: 0.09, y: 0, le: 0.22, te: -0.16 },
      { x: 0.28, y: 0, le: 0.11, te: -0.1 },
      { x: 0.45, y: 0, le: 0.0, te: -0.08 },
      { x: 0.56, y: 0, le: -0.08, te: -0.11 },
    ],
    1,
    0.02,
    solid(dark),
    (span, chord) => (span > 0.85 || chord < 0.1 ? pair(mix(white, dark, 0.6), mix(white, dark, 0.6)) : pair(white, white)),
  );
  return { geometry: b.build(), rig: { shoulder: [0.09, 0, 0.02], wrist: [0.28, 0, 0.0] } };
}
