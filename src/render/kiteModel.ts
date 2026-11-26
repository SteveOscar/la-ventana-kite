import * as THREE from 'three';
import { clamp } from '../core/math.ts';
import type { Kite } from '../sim/kite.ts';

export interface KitePalette {
  canopy: number[];
  tube: number;
  strut: number;
}

export const KITE_PALETTES: KitePalette[] = [
  { canopy: [0x16c2b0, 0xffffff, 0xff6b4a, 0xffffff, 0x16c2b0], tube: 0x1d2733, strut: 0x1d2733 },
  { canopy: [0xffc928, 0xff7a1a, 0xe63946, 0xff7a1a, 0xffc928], tube: 0x222222, strut: 0x2c2c2c },
  { canopy: [0x2b59c3, 0x8ecae6, 0xffffff, 0x8ecae6, 0x2b59c3], tube: 0xf1f1f1, strut: 0xe8e8e8 },
  { canopy: [0x9b5de5, 0xf15bb5, 0xfee440, 0xf15bb5, 0x9b5de5], tube: 0x1b1b2f, strut: 0x1b1b2f },
  { canopy: [0x00bb77, 0xccff33, 0x00bb77, 0xccff33, 0x00bb77], tube: 0x103020, strut: 0x103020 },
  { canopy: [0xffffff, 0xd62828, 0xffffff, 0xd62828, 0xffffff], tube: 0x333333, strut: 0x333333 },
  { canopy: [0xff9f1c, 0xffbf69, 0xffffff, 0xcbf3f0, 0x2ec4b6], tube: 0x264653, strut: 0x264653 },
  { canopy: [0x111111, 0x444444, 0xf5d000, 0x444444, 0x111111], tube: 0xf5d000, strut: 0x222222 },
];

const SPAN_SEG = 28;
const CHORD_SEG = 6;

/**
 * Leading-edge-inflatable C/bow kite. Local frame: +Y away from the rider
 * (top of the arc), +Z along the leading edge's flying direction, X across the span.
 */
export class KiteModel {
  readonly group = new THREE.Group();
  readonly canopy: THREE.Mesh;
  readonly lines: THREE.LineSegments;
  private canopyGeo: THREE.BufferGeometry;
  private basePositions: Float32Array;
  private chordParam: Float32Array;
  private spanParam: Float32Array;
  readonly tipLeft = new THREE.Vector3();
  readonly tipRight = new THREE.Vector3();
  readonly frontLeft = new THREE.Vector3();
  readonly frontRight = new THREE.Vector3();
  private lineAttr: THREE.BufferAttribute;
  private scale: number;

  constructor(size: number, palette: KitePalette, lineColor = 0x2a2a2a) {
    this.scale = Math.sqrt(size / 9);
    const s = this.scale;
    const arcHalf = 1.25; // radians from centre to tip along the leading edge
    const radius = 4.0 * s;
    const chordMax = 2.65 * s;

    const positions: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    const chordP: number[] = [];
    const spanP: number[] = [];
    const col = new THREE.Color();
    const arcPoint = (t: number) => {
      const phi = t * arcHalf;
      return { x: Math.sin(phi) * radius, y: (Math.cos(phi) - 1) * radius };
    };
    for (let i = 0; i <= SPAN_SEG; i++) {
      const t = (i / SPAN_SEG) * 2 - 1;
      const a = arcPoint(t);
      const taper = Math.sqrt(Math.max(0.04, 1 - Math.pow(Math.abs(t), 2.6)));
      const chord = chordMax * taper;
      const band = Math.min(palette.canopy.length - 1, Math.floor(((t + 1) / 2) * palette.canopy.length));
      col.setHex(palette.canopy[band]);
      for (let j = 0; j <= CHORD_SEG; j++) {
        const c = j / CHORD_SEG;
        // Leading edge sweeps slightly forward at the centre; camber bulges the canopy outward.
        const z = -c * chord + 0.25 * s * (1 - t * t);
        const camber = Math.sin(Math.PI * Math.min(1, c * 1.1)) * 0.11 * chord;
        // Canopy surface normal in the arc plane points away from the arc centre.
        const nx = Math.sin(t * arcHalf), ny = Math.cos(t * arcHalf);
        positions.push(a.x + nx * camber, a.y + ny * camber, z);
        colors.push(col.r, col.g, col.b);
        chordP.push(c);
        spanP.push(t);
      }
    }
    for (let i = 0; i < SPAN_SEG; i++) {
      for (let j = 0; j < CHORD_SEG; j++) {
        const a = i * (CHORD_SEG + 1) + j, b = a + 1, c = a + CHORD_SEG + 1, d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
    this.canopyGeo = new THREE.BufferGeometry();
    this.canopyGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    this.canopyGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this.canopyGeo.setIndex(indices);
    this.canopyGeo.computeVertexNormals();
    this.basePositions = new Float32Array(positions);
    this.chordParam = new Float32Array(chordP);
    this.spanParam = new Float32Array(spanP);
    const canopyMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      roughness: 0.55,
      metalness: 0,
    });
    this.canopy = new THREE.Mesh(this.canopyGeo, canopyMat);
    this.canopy.castShadow = true;
    this.group.add(this.canopy);

    // Leading-edge tube and struts.
    const lePts: THREE.Vector3[] = [];
    for (let i = 0; i <= 32; i++) {
      const t = (i / 32) * 2 - 1;
      const a = arcPoint(t);
      lePts.push(new THREE.Vector3(a.x, a.y, 0.25 * s * (1 - t * t) + 0.02));
    }
    const tubeMat = new THREE.MeshStandardMaterial({ color: palette.tube, roughness: 0.45 });
    const le = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(lePts), 48, 0.13 * s, 8, false), tubeMat);
    le.castShadow = true;
    this.group.add(le);
    const strutMat = new THREE.MeshStandardMaterial({ color: palette.strut, roughness: 0.5 });
    for (const t of [-0.62, -0.3, 0, 0.3, 0.62]) {
      const a = arcPoint(t);
      const chord = chordMax * Math.sqrt(Math.max(0.04, 1 - Math.pow(Math.abs(t), 2.6)));
      const nx = Math.sin(t * arcHalf), ny = Math.cos(t * arcHalf);
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k <= 6; k++) {
        const c = (k / 6) * 0.72;
        const camber = Math.sin(Math.PI * Math.min(1, c * 1.1)) * 0.11 * chord + 0.04;
        pts.push(new THREE.Vector3(a.x + nx * camber, a.y + ny * camber, -c * chord + 0.25 * s * (1 - t * t)));
      }
      const strut = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 8, 0.06 * s, 6, false), strutMat);
      this.group.add(strut);
    }

    // Attachment points in the kite's local frame.
    const tipA = arcPoint(1);
    this.tipRight.set(tipA.x * 0.98, tipA.y, -chordMax * 0.12);
    this.tipLeft.set(-tipA.x * 0.98, tipA.y, -chordMax * 0.12);
    const fr = arcPoint(0.42);
    this.frontRight.set(fr.x, fr.y - 1.2 * s, 0.1);
    this.frontLeft.set(-fr.x, fr.y - 1.2 * s, 0.1);

    // Four flying lines in world space (updated every frame).
    const lineGeo = new THREE.BufferGeometry();
    this.lineAttr = new THREE.BufferAttribute(new Float32Array(8 * 3), 3);
    this.lineAttr.setUsage(THREE.DynamicDrawUsage);
    lineGeo.setAttribute('position', this.lineAttr);
    this.lines = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: lineColor, transparent: true, opacity: 0.75 }));
    this.lines.frustumCulled = false;
  }

  private tmpM = new THREE.Matrix4();
  private tmpX = new THREE.Vector3();
  private tmpY = new THREE.Vector3();
  private tmpZ = new THREE.Vector3();
  private tmpV = new THREE.Vector3();
  private flutterT = 0;

  /** Positions and orients the kite from the simulation, and strings the lines from the bar. */
  update(dt: number, kite: Kite, barLeft: THREE.Vector3, barRight: THREE.Vector3, barCenter: THREE.Vector3) {
    const y = this.tmpY;
    const z = this.tmpZ;
    this.group.position.copy(kite.position);
    if (kite.mode === 'down') {
      // Floating on the water: arc standing up, wingtips in the water, leading edge toward the rider.
      y.set(0, 1, 0);
      z.set(-kite.u.x, 0, -kite.u.z);
      if (z.lengthSq() < 1e-4) z.set(1, 0, 0);
      z.normalize();
      this.group.position.y += 1.9 * this.scale;
    } else {
      y.copy(kite.u);
      z.copy(kite.h);
      // Tilt the chord for the angle of attack.
      const aoa = 0.2 + 0.15 * (1 - kite.sheet);
      z.applyAxisAngle(this.tmpX.crossVectors(y, z).normalize(), -aoa);
    }
    const x = this.tmpX.crossVectors(y, z).normalize();
    const yy = this.tmpV.crossVectors(z, x).normalize();
    this.tmpM.makeBasis(x, yy, z);
    this.group.quaternion.setFromRotationMatrix(this.tmpM);
    if (kite.mode !== 'down') this.group.rotateZ(-kite.bank * 0.28);

    // Flutter the trailing edge when the kite luffs or is depowered.
    this.flutterT += dt;
    const luff = clamp(kite.luff + (1 - kite.sheet) * 0.25, 0, 1);
    const pos = this.canopyGeo.getAttribute('position') as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const base = this.basePositions;
    for (let i = 0; i < this.chordParam.length; i++) {
      const c = this.chordParam[i];
      const amp = luff * c * c * 0.35 * this.scale;
      const w = Math.sin(this.flutterT * 22 + this.spanParam[i] * 9 + c * 4) * amp;
      arr[i * 3] = base[i * 3];
      arr[i * 3 + 1] = base[i * 3 + 1] + w;
      arr[i * 3 + 2] = base[i * 3 + 2];
    }
    pos.needsUpdate = true;

    this.group.updateMatrixWorld(true);
    const la = this.lineAttr.array as Float32Array;
    const put = (k: number, a: THREE.Vector3, b: THREE.Vector3) => {
      la[k * 6] = a.x;
      la[k * 6 + 1] = a.y;
      la[k * 6 + 2] = a.z;
      la[k * 6 + 3] = b.x;
      la[k * 6 + 4] = b.y;
      la[k * 6 + 5] = b.z;
    };
    const w = this.group.matrixWorld;
    put(0, barLeft, this.tmpV.copy(this.tipLeft).applyMatrix4(w));
    put(1, barRight, this.tmpV.copy(this.tipRight).applyMatrix4(w));
    put(2, barCenter, this.tmpV.copy(this.frontLeft).applyMatrix4(w));
    put(3, barCenter, this.tmpV.copy(this.frontRight).applyMatrix4(w));
    this.lineAttr.needsUpdate = true;
  }
}
