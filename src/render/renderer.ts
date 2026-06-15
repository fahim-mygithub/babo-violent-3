import { BoxGeometry, BufferGeometry, CircleGeometry, Color, DirectionalLight, DoubleSide, Float32BufferAttribute, Fog, HemisphereLight, Line, LineBasicMaterial, Mesh, MeshBasicMaterial, MeshStandardMaterial, PerspectiveCamera, Plane, PlaneGeometry, Raycaster, RingGeometry, Scene, Vector2, Vector3, WebGLRenderer } from 'three';
import { C } from '../data/constants';
import { viewportSize, onViewportChange } from '../core/viewport';
import { GUNS } from '../data/weapons';
import type { MapDef } from '../data/maps';
import type { GameEvent, ModeState, PlayerState } from '../sim/types';
import type { BloodPool, FireZone, Grenade, Pickup, Projectile, SmokeZone } from '../sim/types';
import { BaboPool } from './babos';
import { EffectsLayer } from './effects';
import { laserLength } from './aimLaser';
import { QUALITY } from './quality';
import { SplatMap } from './splatmap';
import { makeFloorTexture, makeWallTexture } from './textures';

/** What the renderer consumes each frame — satisfied by GameSim or a net-interpolated view. */
export interface WorldView {
  players: Iterable<PlayerState>;
  projectiles: Projectile[];
  grenades: Grenade[];
  pools: BloodPool[];
  fires: FireZone[];
  smokes: SmokeZone[];
  pickups: Pickup[];
  mode: ModeState;
}

const CAM_ANGLE = (65 * Math.PI) / 180; // steep top-down
const CAM_DIST = 21;

/**
 * Pure aim-lead offset (S1.5/S1.13). Slides the camera target a touch toward the
 * aim so the player sees more of where they're shooting. `aimLeadScale` damps the
 * lead on touch (0.35) so the auto-fire stick doesn't yank the camera. At
 * `aimLeadScale === 1` this is byte-identical to the original inline math, so
 * desktop is unchanged. Zero `aimDist` → zero offset (no lead, no alloc concern).
 */
export function cameraLead(aim: number, aimDist: number, aimLeadScale: number): { dx: number; dy: number } {
  const lead = 0.18 * aimLeadScale;
  return { dx: Math.cos(aim) * aimDist * lead * 0.3, dy: Math.sin(aim) * aimDist * lead * 0.3 };
}

export class GameRenderer {
  readonly canvas: HTMLCanvasElement;

  // Touch camera scalars (S1.13). Defaults reproduce the desktop camera exactly:
  // 1× distance, no vertical target bias, full aim-lead. The App raises these for
  // touch (+ portrait zoom) on enterMatch and orientation change.
  camDistScale = 1;
  camTargetYBias = 0;
  aimLeadScale = 1;

  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera: PerspectiveCamera;
  private splat: SplatMap;
  private babos: BaboPool;
  private effects: EffectsLayer;

  private camTarget = new Vector3();
  private shake = 0;
  private time = 0;
  private groundPlane = new Plane(new Vector3(0, 1, 0), 0);
  private raycaster = new Raycaster();
  private ndc = new Vector2();
  private projVec = new Vector3();
  private groundHit = new Vector3();

  // Cached viewport size (CSS px) — the unprojection denominator. groundPoint and
  // project MUST read these, not window.innerWidth/Height, so aim stays correct as
  // the iOS URL bar slides. On a stable desktop viewport these equal innerWidth/Height.
  private vw = 0;
  private vh = 0;
  private offViewport: (() => void) | null = null;

  // Touch aim laser (S1.10) — cosmetic, local-only. One reused Line + reticle,
  // built lazily on first activation so desktop never pays for it. setAimState
  // (called each frame from the touch read-state) toggles + aims it.
  private laser: Line | null = null;
  private laserPos: Float32BufferAttribute | null = null;
  private reticle: Mesh | null = null;
  private aimActive = false;
  private aimAngle = 0;

  constructor(container: HTMLElement, private map: MapDef) {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'game-canvas';
    container.appendChild(this.canvas);
    this.renderer = new WebGLRenderer({ canvas: this.canvas, antialias: QUALITY.antialias, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY.maxPixelRatio));

    this.scene.background = new Color(0x0b0c10);
    this.scene.fog = new Fog(0x0b0c10, 55, 95);

    const { w: vw0, h: vh0 } = viewportSize();
    this.camera = new PerspectiveCamera(46, vw0 / vh0, 0.5, 200);
    this.applyViewport();
    this.offViewport = onViewportChange(this.applyViewport);

    this.scene.add(new HemisphereLight(0xcdd6e8, 0x3a3430, 1.5));
    const key = new DirectionalLight(0xfff2e0, 2.4);
    key.position.set(18, 30, 12);
    this.scene.add(key);
    const fill = new DirectionalLight(0x7a88c0, 0.8);
    fill.position.set(-20, 22, -16);
    this.scene.add(fill);

    this.splat = new SplatMap(map.size.w, map.size.h);
    this.buildArena();
    this.babos = new BaboPool(this.scene);
    this.effects = new EffectsLayer(this.scene);
    this.splat.stainPit(map);
  }

  private buildArena(): void {
    const { w, h } = this.map.size;
    const floorTex = makeFloorTexture();
    floorTex.repeat.set(w / 16, h / 16);
    const floor = new Mesh(
      new PlaneGeometry(w, h),
      new MeshStandardMaterial({ map: floorTex, roughness: 0.92 }),
    );
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);

    // Persistent gore layer draped over the floor
    const splatPlane = new Mesh(
      new PlaneGeometry(w, h),
      new MeshBasicMaterial({ map: this.splat.texture, transparent: true, depthWrite: false }),
    );
    splatPlane.rotation.x = -Math.PI / 2;
    // Splat-map stamp space has +y up; the floor plane after rotation maps
    // texture v along -z, so flip to align sim coords.
    splatPlane.scale.y = -1;
    splatPlane.position.y = 0.012;
    this.scene.add(splatPlane);

    // Blood pit: darkened depression ring
    if (this.map.bloodPit) {
      const pit = this.map.bloodPit;
      const pitMesh = new Mesh(
        new CircleGeometry(pit.r, 40),
        new MeshStandardMaterial({ color: 0x14080a, roughness: 0.6 }),
      );
      pitMesh.rotation.x = -Math.PI / 2;
      pitMesh.position.set(pit.x, 0.008, pit.y);
      this.scene.add(pitMesh);
      const rim = new Mesh(
        new RingGeometry(pit.r, pit.r + 0.35, 40),
        new MeshBasicMaterial({ color: 0x3a2a20, side: DoubleSide }),
      );
      rim.rotation.x = -Math.PI / 2;
      rim.position.set(pit.x, 0.01, pit.y);
      this.scene.add(rim);
    }

    // Walls
    const wallTex = makeWallTexture();
    const wallMat = new MeshStandardMaterial({ map: wallTex, roughness: 0.7, metalness: 0.25 });
    const topMat = new MeshStandardMaterial({ color: 0x2c3138, roughness: 0.8 });
    for (const wall of this.map.walls) {
      const geo = new BoxGeometry(wall.w, wall.height, wall.h);
      const mats = [wallMat, wallMat, topMat, topMat, wallMat, wallMat];
      const mesh = new Mesh(geo, mats);
      mesh.position.set(wall.x, wall.height / 2, wall.y);
      this.scene.add(mesh);
    }

    // Equipment node pads
    for (const node of this.map.equipmentNodes) {
      const pad = new Mesh(
        new RingGeometry(0.6, 0.78, 26),
        new MeshBasicMaterial({ color: 0x4a90c8, transparent: true, opacity: 0.4, side: DoubleSide }),
      );
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(node.x, 0.015, node.y);
      this.scene.add(pad);
    }
    for (const node of this.map.healthNodes) {
      const pad = new Mesh(
        new RingGeometry(0.6, 0.78, 26),
        new MeshBasicMaterial({ color: 0xc84a4a, transparent: true, opacity: 0.4, side: DoubleSide }),
      );
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(node.x, 0.015, node.y);
      this.scene.add(pad);
    }
  }

  /** Process this tick's events into VFX (splats, bursts) + camera shake. */
  handleEvents(events: GameEvent[], localId: number, view: WorldView): void {
    let local: PlayerState | undefined;
    for (const p of view.players) if (p.id === localId) { local = p; break; }
    for (const ev of events) {
      this.effects.handleEvent(ev);
      switch (ev.t) {
        case 'splat':
          this.splat.add(ev.x, ev.y, ev.size, ev.dirX, ev.dirY);
          break;
        case 'explosion':
          this.addShakeFrom(ev.x, ev.y, 0.55, local);
          break;
        case 'pop':
          this.addShakeFrom(ev.x, ev.y, 0.35, local);
          break;
        case 'hit':
          if (ev.target === localId) this.addShake(0.12);
          break;
        case 'shot':
          if (ev.player === localId && (ev.gun === 'thumper' || ev.gun === 'lance' || ev.gun === 'maw')) {
            this.addShake(0.16);
          }
          break;
        default:
          break;
      }
    }
  }

  private addShakeFrom(x: number, y: number, amount: number, local?: PlayerState): void {
    if (!local) return;
    const d = Math.hypot(x - local.x, y - local.y);
    const falloff = Math.max(0, 1 - d / 14);
    this.addShake(amount * falloff);
  }

  addShake(amount: number): void {
    this.shake = Math.min(0.8, this.shake + amount);
  }

  /**
   * Touch aim state (S1.10). The App pushes the touch read-state each frame: the
   * laser draws from the muzzle along `aimAngle` only while `active`. Building the
   * GL objects is deferred to first activation so the desktop path never allocates
   * them and the laser is never drawn there.
   */
  setAimState(aimAngle: number, active: boolean): void {
    this.aimAngle = aimAngle;
    this.aimActive = active;
    if (active && !this.laser) this.buildLaser();
  }

  private buildLaser(): void {
    const geo = new BufferGeometry();
    this.laserPos = new Float32BufferAttribute(new Float32Array(6), 3); // 2 verts
    geo.setAttribute('position', this.laserPos);
    this.laser = new Line(geo, new LineBasicMaterial({ color: 0xff3030, transparent: true, opacity: 0.7 }));
    this.laser.frustumCulled = false;
    this.laser.visible = false;
    this.scene.add(this.laser);
    this.reticle = new Mesh(
      new RingGeometry(0.22, 0.34, 20),
      new MeshBasicMaterial({ color: 0xff3030, transparent: true, opacity: 0.85, side: DoubleSide }),
    );
    this.reticle.rotation.x = -Math.PI / 2;
    this.reticle.visible = false;
    this.scene.add(this.reticle);
  }

  /** Update the reused laser/reticle from the local babo. Honest wall occlusion. */
  private updateLaser(local: PlayerState | undefined): void {
    if (!this.laser || !this.laserPos || !this.reticle) return;
    const show = this.aimActive && !!local && local.alive;
    this.laser.visible = show;
    this.reticle.visible = show;
    if (!show || !local) return;
    const dirX = Math.cos(this.aimAngle);
    const dirY = Math.sin(this.aimAngle);
    const mx = local.x + dirX * 0.65; // muzzle just ahead of the babo
    const my = local.y + dirY * 0.65;
    const maxLen = GUNS[local.gun].range;
    const len = laserLength(mx, my, this.aimAngle, maxLen, this.map.walls);
    const ex = mx + dirX * len;
    const ey = my + dirY * len;
    const arr = this.laserPos.array as Float32Array;
    arr[0] = mx; arr[1] = 0.5; arr[2] = my;
    arr[3] = ex; arr[4] = 0.5; arr[5] = ey;
    this.laserPos.needsUpdate = true;
    this.reticle.position.set(ex, 0.04, ey);
  }

  render(view: WorldView, localId: number, dt: number): void {
    this.time += dt;
    this.shake = Math.max(0, this.shake - dt * 1.8);

    // Camera follows the local babo (dead → keep last position)
    let local: PlayerState | undefined;
    for (const p of view.players) if (p.id === localId) { local = p; break; }
    if (local && local.alive) {
      const { dx, dy } = cameraLead(local.aim, local.input.aimDist, this.aimLeadScale);
      const tx = local.x + dx;
      const ty = local.y + dy;
      this.camTarget.x += (tx - this.camTarget.x) * Math.min(1, dt * 7);
      this.camTarget.z += (ty - this.camTarget.z) * Math.min(1, dt * 7);
    }
    const sx = (Math.random() - 0.5) * this.shake * 0.7;
    const sy = (Math.random() - 0.5) * this.shake * 0.7;
    const camDist = CAM_DIST * this.camDistScale;
    this.camera.position.set(
      this.camTarget.x + sx,
      Math.sin(CAM_ANGLE) * camDist,
      this.camTarget.z + Math.cos(CAM_ANGLE) * camDist + sy,
    );
    this.camera.lookAt(this.camTarget.x + sx, 0, this.camTarget.z + this.camTargetYBias + sy);

    this.babos.update(view.players, dt, this.time, view.mode.leaderId);
    this.effects.sync(
      view.players, view.projectiles, view.grenades, view.pools,
      view.fires, view.smokes, view.pickups, view.mode, localId, this.time,
    );
    this.effects.update(dt);
    this.updateLaser(local);

    this.splat.flush(this.renderer);
    this.renderer.render(this.scene, this.camera);
  }

  /** Mouse position → sim ground coordinates. */
  groundPoint(clientX: number, clientY: number): { x: number; y: number } {
    this.ndc.set((clientX / this.vw) * 2 - 1, -(clientY / this.vh) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    this.raycaster.ray.intersectPlane(this.groundPlane, this.groundHit);
    return { x: this.groundHit.x, y: this.groundHit.z };
  }

  /** Sim world point → screen pixels (for HUD anchors). */
  project(x: number, y: number, height = 0): { x: number; y: number; visible: boolean } {
    this.projVec.set(x, height, y).project(this.camera);
    return {
      x: (this.projVec.x * 0.5 + 0.5) * this.vw,
      y: (-this.projVec.y * 0.5 + 0.5) * this.vh,
      visible: this.projVec.z < 1,
    };
  }

  /** Re-cache size + resize camera/renderer from the viewport bus (one rAF-coalesced fire). */
  private applyViewport = (): void => {
    const { w, h } = viewportSize();
    this.vw = w;
    this.vh = h;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  };

  dispose(): void {
    this.offViewport?.();
    this.offViewport = null;
    if (this.laser) {
      this.laser.geometry.dispose();
      (this.laser.material as LineBasicMaterial).dispose();
    }
    if (this.reticle) {
      this.reticle.geometry.dispose();
      (this.reticle.material as MeshBasicMaterial).dispose();
    }
    this.splat.dispose();
    this.babos.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss(); // release the GL context now, don't wait for GC
    this.canvas.remove();
  }
}
