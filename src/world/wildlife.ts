import * as THREE from 'three';
import type { TerrainData } from './terrainData.ts';
import { CreatureMesh } from './wildlife/creatures.ts';
import * as models from './wildlife/models.ts';
import { WaterFx } from './wildlife/waterFx.ts';
import { Frigates, Gulls, Ospreys, Pelicans } from './wildlife/birds.ts';
import { Dolphins, Mobulas, SeaLions, Turtles, Whales } from './wildlife/marine.ts';
import { headingTo, type Ctx, type Species, type SpeciesId, type WildlifeEvent } from './wildlife/common.ts';

export type { WildlifeEvent } from './wildlife/common.ts';

export interface WildlifeOptions {
  /** Index into MONTHS in content/culture.ts (0 = Noviembre .. 5 = Abril). */
  month: number;
  /** Water surface height (waves included) at a point. */
  surface(x: number, z: number): number;
}

/** Pelicans, frigatebirds, dolphins, whales and friends around the rider. */
export class Wildlife {
  readonly group = new THREE.Group();
  /** Called the first time the player gets a good look at a species (id from SPECIES). */
  onSighting: ((speciesId: string) => void) | null = null;
  /** Optional hook for sounds: blows, breaches, splashes. */
  onEvent: ((e: WildlifeEvent) => void) | null = null;
  /** Wind the spray and spouts drift with (m/s, toward); the default is the Norte. */
  readonly wind = new THREE.Vector2(-2.2, 7.8);

  private readonly fx: WaterFx;
  private readonly species: Species[];
  private readonly meshes: CreatureMesh[];
  private readonly sighted = new Set<string>();
  private readonly ctx: Ctx;
  private month: number;
  private camera: THREE.Camera | null = null;
  private title = false;
  private viewProj = new THREE.Matrix4();
  private v4 = new THREE.Vector4();
  private lastFocus = new THREE.Vector3(Number.NaN, 0, 0);
  private sun: THREE.DirectionalLight | null = null;
  private hemi: THREE.HemisphereLight | null = null;
  private lightsSearched = false;
  private sunDir = new THREE.Vector3();
  private cpuMs = 0;

  constructor(data: TerrainData, opts: WildlifeOptions) {
    this.group.name = 'wildlife';
    this.month = opts.month;
    this.fx = new WaterFx(opts.surface);
    const make = (name: string, m: models.Model, max: number, roughness: number) => new CreatureMesh(name, m.geometry, max, m.rig, { roughness });
    const pelican = make('pelicans', models.pelican(), 48, 0.92);
    const frigate = make('frigatebirds', models.frigate(), 8, 0.85);
    const gull = make('gulls', models.gull(), 10, 0.9);
    const osprey = make('ospreys', models.osprey(), 2, 0.9);
    const dolphin = make('dolphins', models.dolphin(), 26, 0.38);
    const whale = make('humpbacks', models.humpback(), 4, 0.45);
    const seaLion = make('sealions', models.seaLion(), 6, 0.4);
    const turtle = make('turtles', models.turtle(), 4, 0.6);
    const mobula = make('mobulas', models.mobula(), 40, 0.5);
    this.meshes = [pelican, frigate, gull, osprey, dolphin, whale, seaLion, turtle, mobula];
    for (const m of this.meshes) this.group.add(m.mesh);
    this.group.add(this.fx.foam, this.fx.points);
    this.species = [
      new Pelicans(pelican),
      new Frigates(frigate),
      new Gulls(gull),
      new Ospreys(osprey),
      new Dolphins(dolphin),
      new Whales(whale),
      new SeaLions(seaLion),
      new Turtles(turtle),
      new Mobulas(mobula),
    ];
    const self = this;
    this.ctx = {
      data,
      surface: opts.surface,
      fx: this.fx,
      focus: new THREE.Vector3(),
      vx: 0,
      vz: 0,
      camX: 0,
      camY: 0,
      camZ: 0,
      fwdX: 0,
      fwdZ: -1,
      time: 0,
      month: opts.month,
      windX: this.wind.x,
      windZ: this.wind.y,
      windFrom: 0,
      sight: (id, x, y, z, range) => self.sight(id, x, y, z, range),
      inView: (x, y, z, margin = 0) => self.inView(x, y, z, margin),
      emit: (e) => self.onEvent?.(e),
    };
  }

  /** Sets the month; also starts a new sighting session. */
  setMonth(month: number) {
    this.month = month;
    this.ctx.month = month;
    this.resetSightings();
  }

  /** Every species can be reported again (call at the start of a session). */
  resetSightings() {
    this.sighted.clear();
  }

  /** `focus` is the player position; spawn things around it. */
  update(dt: number, time: number, focus: THREE.Vector3, camera: THREE.Camera) {
    const t0 = performance.now();
    const ctx = this.ctx;
    camera.updateMatrixWorld();
    this.camera = camera;
    // On the title screen the game passes the camera position itself as the focus.
    this.title = focus === camera.position;
    this.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const e = camera.matrixWorld.elements;
    const fl = Math.hypot(e[8], e[10]) || 1;
    ctx.fwdX = -e[8] / fl;
    ctx.fwdZ = -e[10] / fl;
    ctx.camX = e[12];
    ctx.camY = e[13];
    ctx.camZ = e[14];

    // Teleports (new session, respawn) restart the populations around the new spot.
    const jumped = !Number.isFinite(this.lastFocus.x) || this.lastFocus.distanceTo(focus) > 250;
    if (jumped) {
      for (const s of this.species) s.clear();
      ctx.vx = ctx.vz = 0;
    } else if (dt > 0) {
      const k = 1 - Math.exp(-2 * dt);
      ctx.vx += ((focus.x - this.lastFocus.x) / dt - ctx.vx) * k;
      ctx.vz += ((focus.z - this.lastFocus.z) / dt - ctx.vz) * k;
    }
    this.lastFocus.copy(focus);
    ctx.focus.copy(focus);
    ctx.time = time;
    ctx.month = this.month;
    ctx.windX = this.fx.windX = this.wind.x;
    ctx.windZ = this.fx.windZ = this.wind.y;
    ctx.windFrom = headingTo(-this.wind.x, -this.wind.y);

    this.updateTint();
    for (const s of this.species) s.update(ctx, dt);
    this.fx.update(dt, ctx.camX, ctx.camZ);
    this.cpuMs += (performance.now() - t0 - this.cpuMs) * 0.05;
  }

  private inView(x: number, y: number, z: number, margin: number) {
    if (!this.camera) return false;
    const v = this.v4.set(x, y, z, 1).applyMatrix4(this.viewProj);
    if (v.w <= 0) return false;
    const lim = 1 + margin;
    return Math.abs(v.x / v.w) < lim && Math.abs(v.y / v.w) < lim;
  }

  private sight(id: SpeciesId, x: number, y: number, z: number, range: number) {
    if (this.title || this.sighted.has(id)) return;
    const f = this.ctx.focus;
    const dx = x - f.x, dy = y - f.y, dz = z - f.z;
    if (dx * dx + dy * dy + dz * dz > range * range) return;
    if (!this.inView(x, y, z, -0.06)) return;
    this.sighted.add(id);
    this.onSighting?.(id);
  }

  /** Spray and foam take their brightness from the scene's sun and sky light. */
  private updateTint() {
    if (!this.lightsSearched) {
      const scene = this.group.parent;
      if (!scene) return;
      this.lightsSearched = true;
      scene.traverse((o) => {
        if (!this.sun && (o as THREE.DirectionalLight).isDirectionalLight) this.sun = o as THREE.DirectionalLight;
        if (!this.hemi && (o as THREE.HemisphereLight).isHemisphereLight) this.hemi = o as THREE.HemisphereLight;
      });
    }
    const tint = this.fx.tint;
    if (!this.sun || !this.hemi) {
      tint.setRGB(1, 1, 1);
      return;
    }
    this.sunDir.copy(this.sun.position).sub(this.sun.target.position).normalize();
    const up = Math.max(this.sunDir.y, 0);
    const s = this.sun.intensity * (0.4 + 0.6 * up);
    tint.setRGB(
      (this.sun.color.r * s + this.hemi.color.r * this.hemi.intensity) / Math.PI,
      (this.sun.color.g * s + this.hemi.color.g * this.hemi.intensity) / Math.PI,
      (this.sun.color.b * s + this.hemi.color.b * this.hemi.intensity) / Math.PI,
    );
  }

  /** QA hook: force an encounter `dist` metres ahead of the camera (or at x/z). */
  debugSpawn(kind: string, o: { dist?: number; x?: number; z?: number; side?: number; action?: string } = {}) {
    const s = this.species.find((sp) => sp.name === kind);
    if (!s) return `unknown species ${kind}; one of ${this.species.map((sp) => sp.name).join(', ')}`;
    const ctx = this.ctx;
    const d = o.dist ?? 120;
    const side = o.side ?? 0;
    const x = o.x ?? ctx.focus.x + ctx.fwdX * d - ctx.fwdZ * side;
    const z = o.z ?? ctx.focus.z + ctx.fwdZ * d + ctx.fwdX * side;
    s.spawnAt(ctx, x, z, o.action);
    return `${kind} at ${Math.round(x)},${Math.round(z)}`;
  }

  /** QA hook: live counts, sightings and cost. */
  get stats() {
    const counts: Record<string, number> = {};
    for (const s of this.species) counts[s.name] = s.active;
    let tris = 0, calls = 0;
    for (const m of this.meshes) {
      if (m.count > 0) {
        tris += m.count * m.triangles;
        calls++;
      }
    }
    if (this.fx.points.geometry.drawRange.count > 0) calls++;
    if (this.fx.foam.visible) calls++;
    return { counts, sighted: [...this.sighted], tris, calls, particles: this.fx.liveParticles, patches: this.fx.livePatches, cpuMs: +this.cpuMs.toFixed(3) };
  }
}
