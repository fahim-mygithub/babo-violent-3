import * as THREE from 'three';
import { C } from '../data/constants';
import type { MapDef } from '../data/maps';
import type { GameEvent, ModeState, PlayerState } from '../sim/types';
import type { BloodPool, FireZone, Grenade, Pickup, Projectile, SmokeZone } from '../sim/types';
import { BaboPool } from './babos';
import { EffectsLayer } from './effects';
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

export class GameRenderer {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private splat: SplatMap;
  private babos: BaboPool;
  private effects: EffectsLayer;

  private camTarget = new THREE.Vector3();
  private shake = 0;
  private time = 0;
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private projVec = new THREE.Vector3();

  constructor(container: HTMLElement, private map: MapDef) {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'game-canvas';
    container.appendChild(this.canvas);
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    window.addEventListener('resize', this.onResize);

    this.scene.background = new THREE.Color(0x0b0c10);
    this.scene.fog = new THREE.Fog(0x0b0c10, 55, 95);

    this.camera = new THREE.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 0.5, 200);

    this.scene.add(new THREE.HemisphereLight(0xcdd6e8, 0x3a3430, 1.5));
    const key = new THREE.DirectionalLight(0xfff2e0, 2.4);
    key.position.set(18, 30, 12);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x7a88c0, 0.8);
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
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.92 }),
    );
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);

    // Persistent gore layer draped over the floor
    const splatPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ map: this.splat.texture, transparent: true, depthWrite: false }),
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
      const pitMesh = new THREE.Mesh(
        new THREE.CircleGeometry(pit.r, 40),
        new THREE.MeshStandardMaterial({ color: 0x14080a, roughness: 0.6 }),
      );
      pitMesh.rotation.x = -Math.PI / 2;
      pitMesh.position.set(pit.x, 0.008, pit.y);
      this.scene.add(pitMesh);
      const rim = new THREE.Mesh(
        new THREE.RingGeometry(pit.r, pit.r + 0.35, 40),
        new THREE.MeshBasicMaterial({ color: 0x3a2a20, side: THREE.DoubleSide }),
      );
      rim.rotation.x = -Math.PI / 2;
      rim.position.set(pit.x, 0.01, pit.y);
      this.scene.add(rim);
    }

    // Walls
    const wallTex = makeWallTexture();
    const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.7, metalness: 0.25 });
    const topMat = new THREE.MeshStandardMaterial({ color: 0x2c3138, roughness: 0.8 });
    for (const wall of this.map.walls) {
      const geo = new THREE.BoxGeometry(wall.w, wall.height, wall.h);
      const mats = [wallMat, wallMat, topMat, topMat, wallMat, wallMat];
      const mesh = new THREE.Mesh(geo, mats);
      mesh.position.set(wall.x, wall.height / 2, wall.y);
      this.scene.add(mesh);
    }

    // Equipment node pads
    for (const node of this.map.equipmentNodes) {
      const pad = new THREE.Mesh(
        new THREE.RingGeometry(0.6, 0.78, 26),
        new THREE.MeshBasicMaterial({ color: 0x4a90c8, transparent: true, opacity: 0.4, side: THREE.DoubleSide }),
      );
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(node.x, 0.015, node.y);
      this.scene.add(pad);
    }
    for (const node of this.map.healthNodes) {
      const pad = new THREE.Mesh(
        new THREE.RingGeometry(0.6, 0.78, 26),
        new THREE.MeshBasicMaterial({ color: 0xc84a4a, transparent: true, opacity: 0.4, side: THREE.DoubleSide }),
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

  render(view: WorldView, localId: number, dt: number): void {
    this.time += dt;
    this.shake = Math.max(0, this.shake - dt * 1.8);

    // Camera follows the local babo (dead → keep last position)
    let local: PlayerState | undefined;
    for (const p of view.players) if (p.id === localId) { local = p; break; }
    if (local && local.alive) {
      const lead = 0.18; // slight aim lead
      const tx = local.x + Math.cos(local.aim) * local.input.aimDist * lead * 0.3;
      const ty = local.y + Math.sin(local.aim) * local.input.aimDist * lead * 0.3;
      this.camTarget.x += (tx - this.camTarget.x) * Math.min(1, dt * 7);
      this.camTarget.z += (ty - this.camTarget.z) * Math.min(1, dt * 7);
    }
    const sx = (Math.random() - 0.5) * this.shake * 0.7;
    const sy = (Math.random() - 0.5) * this.shake * 0.7;
    this.camera.position.set(
      this.camTarget.x + sx,
      Math.sin(CAM_ANGLE) * CAM_DIST,
      this.camTarget.z + Math.cos(CAM_ANGLE) * CAM_DIST + sy,
    );
    this.camera.lookAt(this.camTarget.x + sx, 0, this.camTarget.z + sy);

    this.babos.update(view.players, dt, this.time, view.mode.leaderId);
    this.effects.sync(
      view.players, view.projectiles, view.grenades, view.pools,
      view.fires, view.smokes, view.pickups, view.mode, localId, this.time,
    );
    this.effects.update(dt);

    this.splat.flush(this.renderer);
    this.renderer.render(this.scene, this.camera);
  }

  /** Mouse position → sim ground coordinates. */
  groundPoint(clientX: number, clientY: number): { x: number; y: number } {
    this.ndc.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hit = new THREE.Vector3();
    this.raycaster.ray.intersectPlane(this.groundPlane, hit);
    return { x: hit.x, y: hit.z };
  }

  /** Sim world point → screen pixels (for HUD anchors). */
  project(x: number, y: number, height = 0): { x: number; y: number; visible: boolean } {
    this.projVec.set(x, height, y).project(this.camera);
    return {
      x: (this.projVec.x * 0.5 + 0.5) * window.innerWidth,
      y: (-this.projVec.y * 0.5 + 0.5) * window.innerHeight,
      visible: this.projVec.z < 1,
    };
  }

  private onResize = (): void => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  };

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    this.splat.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}
