import * as THREE from 'three';

/** Inflatable race/teaching buoy with a little flag, bobbing on the chop. */
export class Buoy {
  readonly group = new THREE.Group();
  private flag: THREE.Mesh;
  private phase = Math.random() * 10;
  x: number;
  z: number;

  constructor(x: number, z: number, color = 0xff7a1a, label?: string) {
    this.x = x;
    this.z = z;
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.45 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.1, 2.2, 16), mat);
    body.position.y = 0.8;
    const top = new THREE.Mesh(new THREE.ConeGeometry(0.9, 1.4, 16), mat);
    top.position.y = 2.6;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.93, 0.93, 0.35, 16), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 }));
    band.position.y = 1.3;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 3, 6), new THREE.MeshStandardMaterial({ color: 0x333333 }));
    pole.position.y = 4.4;
    const flagGeo = new THREE.PlaneGeometry(1.4, 0.9, 6, 1);
    flagGeo.translate(0.7, 0, 0);
    this.flag = new THREE.Mesh(flagGeo, new THREE.MeshStandardMaterial({ color: label ? 0xffffff : color, side: THREE.DoubleSide, roughness: 0.7 }));
    this.flag.position.y = 5.4;
    for (const m of [body, top, band]) m.castShadow = true;
    this.group.add(body, top, band, pole, this.flag);
    if (label) {
      const c = document.createElement('canvas');
      c.width = 128;
      c.height = 80;
      const g = c.getContext('2d')!;
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, 128, 80);
      g.fillStyle = '#ff6b4a';
      g.font = 'bold 56px Futura, sans-serif';
      g.textAlign = 'center';
      g.fillText(label, 64, 60);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      (this.flag.material as THREE.MeshStandardMaterial).map = tex;
    }
  }

  update(time: number, surface: (x: number, z: number) => number, windX: number, windZ: number) {
    const y = surface(this.x, this.z);
    this.group.position.set(this.x, y - 0.5, this.z);
    this.group.rotation.set(Math.sin(time * 1.3 + this.phase) * 0.08, 0, Math.cos(time * 1.1 + this.phase) * 0.08);
    // Flag streams downwind and flutters.
    this.flag.rotation.y = Math.atan2(-windZ, windX) + Math.sin(time * 9 + this.phase) * 0.15;
  }
}

/** A panga with an outboard and a fisherman at the tiller. */
export class Panga {
  readonly group = new THREE.Group();
  private wake: THREE.Mesh;

  constructor(hullColor = 0x1f7fc4) {
    const shape = new THREE.Shape();
    // Plan view of the hull: pointed bow at +x, square transom at -x.
    shape.moveTo(-3.2, -0.85);
    shape.lineTo(1.2, -0.9);
    shape.quadraticCurveTo(3.1, -0.6, 3.6, 0);
    shape.quadraticCurveTo(3.1, 0.6, 1.2, 0.9);
    shape.lineTo(-3.2, 0.85);
    shape.lineTo(-3.2, -0.85);
    const hullGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.75, bevelEnabled: false, curveSegments: 8 });
    hullGeo.rotateX(-Math.PI / 2);
    // Taper the bottom into a V so it doesn't look like a box.
    const p = hullGeo.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      if (p.getY(i) < 0.01) {
        p.setZ(i, p.getZ(i) * 0.35);
        p.setY(i, -0.25);
      }
      if (p.getX(i) > 2.5 && p.getY(i) > 0.5) p.setY(i, p.getY(i) + (p.getX(i) - 2.5) * 0.35);
    }
    hullGeo.computeVertexNormals();
    const hull = new THREE.Mesh(hullGeo, [new THREE.MeshStandardMaterial({ color: 0xf4f4f0, roughness: 0.5 }), new THREE.MeshStandardMaterial({ color: hullColor, roughness: 0.5 })]);
    hull.castShadow = true;
    const motor = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.7, 0.4), new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.4 }));
    motor.position.set(-3.35, 0.75, 0);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.9, 6), new THREE.MeshStandardMaterial({ color: 0x333333 }));
    shaft.position.set(-3.4, 0.1, 0);
    const skin = new THREE.MeshStandardMaterial({ color: 0x9a6a46, roughness: 0.7 });
    const shirt = new THREE.MeshStandardMaterial({ color: 0xe9c46a, roughness: 0.8 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.5, 4, 8), shirt);
    body.position.set(-2.6, 1.15, 0);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), skin);
    head.position.set(-2.6, 1.7, 0);
    const hat = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.04, 14), new THREE.MeshStandardMaterial({ color: 0xd8c08a, roughness: 0.9 }));
    hat.position.set(-2.6, 1.8, 0);
    const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.15, 0.16, 10), hat.material);
    crown.position.set(-2.6, 1.88, 0);
    this.group.add(hull, motor, shaft, body, head, hat, crown);
    const wakeGeo = new THREE.PlaneGeometry(9, 3);
    wakeGeo.rotateX(-Math.PI / 2);
    wakeGeo.translate(-7, 0.05, 0);
    this.wake = new THREE.Mesh(wakeGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false }));
    this.group.add(this.wake);
  }

  /** Places the boat at a point with a compass heading; `speed` drives the wake. */
  place(x: number, y: number, z: number, heading: number, speed: number, time: number) {
    this.group.position.set(x, y, z);
    this.group.rotation.set(Math.sin(time * 1.7) * 0.03, Math.PI / 2 - heading, Math.sin(time * 1.3) * 0.04 + Math.min(speed, 8) * 0.012);
    (this.wake.material as THREE.MeshBasicMaterial).opacity = Math.min(0.45, speed * 0.06);
  }
}
