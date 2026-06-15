import { BackSide, CircleGeometry, ConeGeometry, CylinderGeometry, DirectionalLight, DoubleSide, Group, HemisphereLight, Material, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, PerspectiveCamera, RingGeometry, Scene, ShaderMaterial, SphereGeometry, TorusGeometry, Vector3, WebGLRenderer } from 'three';
import { C } from '../data/constants';
import { CLASSES, type ClassId } from '../data/classes';
import { type GunId } from '../data/weapons';
import { makeBaboMaterial, type BaboUniforms } from './baboShader';
import { buildGunModel, disposeGunModel } from './gunModels';
import { buildClassVisual, disposeClassVisual, type ClassVisual } from './baboShapes';

/**
 * Self-contained animated hero shot of the selected Babo for the lobby. Owns a
 * tiny Three.js scene/camera/renderer drawn into a provided canvas: a turntable
 * marble holding its gun on a lit pedestal, sweeping its aim, and periodically
 * demonstrating its class ability with bespoke VFX. Runs its own rAF loop and
 * pauses when the tab is hidden. start()/stop()/dispose().
 */

const R = C.BABO_RADIUS;                 // body radius (0.5)
const IDLE_DUR = 2.4;                    // seconds of idle before an ability demo
const DEMO_DUR = 1.5;                    // seconds the ability demo plays
const CYCLE = IDLE_DUR + DEMO_DUR;

interface Demo {
  label: string;
  meshes: Object3D[];
  /** k in [0,1] over the demo window; also receives absolute time. */
  update: (k: number, t: number) => void;
}

export class LobbyPreview {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera: PerspectiveCamera;

  private baboRoot = new Group();   // bobs / dashes
  private body: Mesh;
  private mat: ShaderMaterial;
  private mount = new Group();       // upright; holds gun + sweeps aim
  private gun: Group | null = null;
  private visual: ClassVisual | null = null;
  private uprightHolder: Group | null = null;  // bodyScale wrapper for upright bits
  private contact: Mesh;

  private classId: ClassId = 'spider';
  private gunId: GunId = 'stinger';
  private demo: Demo | null = null;

  private raf = 0;
  private running = false;
  private time = 0;
  private last = 0;
  private ro: ResizeObserver | null = null;

  /** Fired with the ability name while a demo plays, null when idle. */
  onCaption: ((text: string | null) => void) | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);

    this.camera = new PerspectiveCamera(34, 1, 0.1, 50);
    this.camera.position.set(1.7, 1.55, 3.4);
    this.camera.lookAt(0, R + 0.05, 0);

    this.scene.add(new HemisphereLight(0xcdd6e8, 0x2a2622, 1.4));
    const key = new DirectionalLight(0xfff2e0, 2.2);
    key.position.set(4, 7, 5);
    this.scene.add(key);
    const fill = new DirectionalLight(0x88a0e0, 0.9);
    fill.position.set(-5, 3, -3);
    this.scene.add(fill);
    const rim = new DirectionalLight(0xff6a6a, 0.5);
    rim.position.set(-2, 2, -6);
    this.scene.add(rim);

    // Pedestal stage
    const disc = new Mesh(
      new CylinderGeometry(1.5, 1.62, 0.12, 48),
      new MeshStandardMaterial({ color: 0x14161c, roughness: 0.85, metalness: 0.2 }),
    );
    disc.position.y = -0.06;
    this.scene.add(disc);
    const ring = new Mesh(
      new RingGeometry(1.28, 1.42, 56),
      new MeshBasicMaterial({ color: 0x2a2e38, transparent: true, opacity: 0.8, side: DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.012;
    this.scene.add(ring);
    this.accentRing = new Mesh(
      new RingGeometry(1.46, 1.52, 56),
      new MeshBasicMaterial({ color: 0x46d05a, transparent: true, opacity: 0.55, side: DoubleSide }),
    );
    this.accentRing.rotation.x = -Math.PI / 2;
    this.accentRing.position.y = 0.014;
    this.scene.add(this.accentRing);

    // Contact shadow
    this.contact = new Mesh(
      new CircleGeometry(R * 1.25, 24),
      new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4 }),
    );
    this.contact.rotation.x = -Math.PI / 2;
    this.contact.position.y = 0.02;
    this.scene.add(this.contact);

    // Babo body
    this.mat = makeBaboMaterial(CLASSES[this.classId].color, R, R);
    this.body = new Mesh(new SphereGeometry(R, 32, 22), this.mat);
    this.baboRoot.add(this.body);
    this.baboRoot.add(this.mount);
    this.baboRoot.position.y = R;
    this.scene.add(this.baboRoot);

    // Build the initial chassis/gun/demo unconditionally (setLoadout's
    // class-changed guard would otherwise skip the default class).
    this.rebuildVisual();
    this.rebuildGun();
    this.rebuildDemo();

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
  }

  private accentRing: Mesh;

  // ---------------------------------------------------------------------------

  setLoadout(classId: ClassId, gunId: GunId): void {
    if (classId !== this.classId) {
      this.classId = classId;
      this.mat.uniforms.uColor.value.set(CLASSES[classId].color);
      const accent = this.accentRing.material as MeshBasicMaterial;
      accent.color.setHex(CLASSES[classId].color);
      this.rebuildVisual();
      this.rebuildDemo();
    }
    if (gunId !== this.gunId || !this.gun) {
      this.gunId = gunId;
      this.rebuildGun();
    }
    // Reset the demo cycle so a fresh pick starts from idle.
    this.time = 0;
  }

  private rebuildVisual(): void {
    if (this.visual) {
      for (const o of this.visual.roll) this.body.remove(o);
      if (this.uprightHolder) { this.baboRoot.remove(this.uprightHolder); this.uprightHolder = null; }
      disposeClassVisual(this.visual);
    }
    const v = buildClassVisual(this.classId, R);
    this.body.scale.setScalar(v.bodyScale);
    // Keep the blood-fill level correct for scaled bodies (mirrors babos.ts).
    this.mat.uniforms.uRadius.value = R * v.bodyScale;
    for (const o of v.roll) this.body.add(o);
    // Upright bits ride a bodyScale wrapper so they track the scaled shell.
    const holder = new Group();
    holder.scale.setScalar(v.bodyScale);
    for (const o of v.upright) holder.add(o);
    this.baboRoot.add(holder);
    this.uprightHolder = holder;
    this.visual = v;
  }

  private rebuildGun(): void {
    if (this.gun) {
      this.mount.remove(this.gun);
      disposeGunModel(this.gun);
    }
    const g = buildGunModel(this.gunId);
    g.position.set(0.42, 0.06, 0);
    this.mount.add(g);
    this.gun = g;
  }

  // ---------------------------------------------------------------------------
  // Per-class ability demonstrations
  // ---------------------------------------------------------------------------

  private rebuildDemo(): void {
    if (this.demo) {
      for (const m of this.demo.meshes) {
        this.scene.remove(m);
        this.baboRoot.remove(m);
        disposeObj(m);
      }
    }
    this.demo = this.buildDemo(this.classId);
  }

  private buildDemo(classId: ClassId): Demo {
    const col = CLASSES[classId].color;
    const u = this.mat.uniforms as unknown as BaboUniforms;
    switch (classId) {
      case 'spider': {
        const anchor = new Vector3(1.5, 1.5, -0.7);
        const rope = new Mesh(
          new CylinderGeometry(0.025, 0.025, 1, 6),
          new MeshBasicMaterial({ color: 0xdfe7ef }),
        );
        const claw = new Mesh(
          new ConeGeometry(0.09, 0.2, 5),
          new MeshStandardMaterial({ color: 0xbfe9c8, metalness: 0.5, roughness: 0.4 }),
        );
        rope.visible = false; claw.visible = false;
        this.scene.add(rope, claw);
        const origin = new Vector3();
        return {
          label: 'Grappling Hook', meshes: [rope, claw],
          update: (k) => {
            const out = Math.min(1, k * 2.2);           // shoot out then hold
            origin.set(this.baboRoot.position.x, R + 0.35, this.baboRoot.position.z);
            const tip = origin.clone().lerp(anchor, out);
            rope.visible = claw.visible = k < 0.92;
            const mid = origin.clone().add(tip).multiplyScalar(0.5);
            rope.position.copy(mid);
            const dir = tip.clone().sub(origin);
            const len = Math.max(0.001, dir.length());
            rope.scale.set(1, len, 1);
            rope.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), dir.clone().normalize());
            claw.position.copy(tip);
            claw.quaternion.copy(rope.quaternion);
            // a little swing pull toward the anchor at full extension
            const pull = Math.sin(Math.min(1, Math.max(0, (k - 0.45) / 0.55)) * Math.PI) * 0.22;
            this.baboRoot.position.x = pull * 0.6;
            this.baboRoot.position.z = -pull;
          },
        };
      }
      case 'juggernaut': {
        const streakMat = new MeshBasicMaterial({ color: col, transparent: true, opacity: 0 });
        const streak = new Mesh(new SphereGeometry(R * 1.1, 16, 12), streakMat);
        streak.scale.set(2.4, 1, 1);
        const sparks: Mesh[] = [];
        const sparkGeo = new ConeGeometry(0.08, 0.3, 5);
        const sparkMat = new MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0 });
        for (let i = 0; i < 6; i++) sparks.push(new Mesh(sparkGeo, sparkMat));
        this.scene.add(streak, ...sparks);
        return {
          label: 'Pinball Dash', meshes: [streak, ...sparks],
          update: (k) => {
            // lunge toward camera-left and snap back
            const e = k < 0.5 ? ease(k / 0.5) : 1 - ease((k - 0.5) / 0.5);
            const dx = -1.0 * e;
            this.baboRoot.position.x = dx;
            streak.position.set(dx + 0.5 * e, R, 0);
            streakMat.opacity = 0.4 * e;
            const burst = Math.max(0, 1 - Math.abs(k - 0.5) * 6);
            sparkMat.opacity = burst;
            sparks.forEach((s, i) => {
              const a = (i / sparks.length) * Math.PI * 2;
              const rr = 0.3 + burst * 0.5;
              s.position.set(dx - 0.6 + Math.cos(a) * rr, R + Math.sin(a) * rr, Math.sin(a) * rr * 0.4);
              s.lookAt(dx - 1.2, R, 0);
            });
          },
        };
      }
      case 'bastion': {
        const shield = new Mesh(
          new TorusGeometry(R * 1.5, 0.05, 10, 40),
          new MeshBasicMaterial({ color: 0x9ec2ff, transparent: true, opacity: 0 }),
        );
        const dome = new Mesh(
          new SphereGeometry(R * 1.7, 24, 16),
          new MeshBasicMaterial({ color: 0x6aa8ff, transparent: true, opacity: 0, side: BackSide }),
        );
        this.baboRoot.add(shield, dome);
        return {
          label: 'Fortify', meshes: [shield, dome],
          update: (k) => {
            const p = Math.sin(k * Math.PI);          // up then down
            u.uFortify.value = p;
            shield.rotation.x = Math.PI / 2;
            shield.rotation.z = this.time * 1.5;
            (shield.material as MeshBasicMaterial).opacity = 0.85 * p;
            shield.scale.setScalar(1 + 0.06 * Math.sin(this.time * 8));
            (dome.material as MeshBasicMaterial).opacity = 0.18 * p;
          },
        };
      }
      case 'phantom': {
        const ghost = new Mesh(
          new SphereGeometry(R, 24, 16),
          new MeshBasicMaterial({ color: 0xb39ddb, transparent: true, opacity: 0 }),
        );
        this.baboRoot.add(ghost);
        return {
          label: 'Phase Shift', meshes: [ghost],
          update: (k) => {
            const p = Math.sin(k * Math.PI);
            u.uOpacity.value = 1 - 0.8 * p;
            // The body shader is opaque by default (S3.4); engage blending while the
            // phantom demo fades it, mirroring the in-match phase guard.
            this.mat.transparent = p > 0;
            this.setGunOpacity(1 - 0.8 * p); // fade the held gun with the body
            const gm = ghost.material as MeshBasicMaterial;
            gm.opacity = 0.3 * p;
            ghost.scale.setScalar(1 + 0.5 * p);
          },
        };
      }
      case 'trapper': {
        const well = new Mesh(
          new RingGeometry(0.1, 1.0, 40),
          new MeshBasicMaterial({ color: 0xffd060, transparent: true, opacity: 0, side: DoubleSide }),
        );
        well.rotation.x = -Math.PI / 2;
        well.position.y = 0.03;
        const motes: Mesh[] = [];
        const moteGeo = new SphereGeometry(0.06, 8, 6);
        const moteMat = new MeshBasicMaterial({ color: 0xffe79a, transparent: true, opacity: 0 });
        for (let i = 0; i < 8; i++) motes.push(new Mesh(moteGeo, moteMat));
        this.scene.add(well, ...motes);
        return {
          label: 'Gravity Well', meshes: [well, ...motes],
          update: (k) => {
            const p = Math.sin(k * Math.PI);
            (well.material as MeshBasicMaterial).opacity = 0.7 * p;
            well.scale.setScalar(0.7 + 0.5 * Math.sin(this.time * 4));
            moteMat.opacity = p;
            motes.forEach((m, i) => {
              const a = this.time * 3 + (i / motes.length) * Math.PI * 2;
              const rad = (1 - k) * 1.3 + 0.15;        // spiral inward over the demo
              m.position.set(Math.cos(a) * rad, 0.15 + rad * 0.2, Math.sin(a) * rad);
            });
          },
        };
      }
    }
  }

  /** Reset any state a demo mutates back to its idle values. */
  private resetDemoState(): void {
    const u = this.mat.uniforms as unknown as BaboUniforms;
    u.uFortify.value = 0;
    u.uOpacity.value = 1;
    this.mat.transparent = false; // back to the opaque default once the phase demo ends
    this.setGunOpacity(1);
    if (this.demo) for (const m of this.demo.meshes) m.visible = false;
  }

  /** Fade the held gun's materials (Phase Shift demo). */
  private setGunOpacity(opacity: number): void {
    if (!this.gun) return;
    this.gun.traverse((o) => {
      const m = (o as Mesh).material;
      const mats = Array.isArray(m) ? m : m ? [m] : [];
      for (const mm of mats) { mm.transparent = opacity < 1; mm.opacity = opacity; }
    });
  }

  // ---------------------------------------------------------------------------
  // Loop
  // ---------------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.resize();
    this.last = performance.now();
    const tick = (now: number): void => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(tick);
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      if (!document.hidden) this.frame(dt);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private frame(dt: number): void {
    this.time += dt;

    // Roll the body slowly (the grid pattern advertises "this is a babo").
    this.body.rotation.y += dt * 0.6;
    this.body.rotation.x = Math.sin(this.time * 0.4) * 0.12;
    // Idle bob (unless a dash demo is driving y itself)
    const bob = Math.sin(this.time * 1.6) * 0.04;
    // Aim sweep
    this.mount.rotation.y = Math.sin(this.time * 0.5) * 0.7;

    const u = this.mat.uniforms as unknown as BaboUniforms;
    u.uTime.value = this.time;

    // Ability demo cycle
    const phase = this.time % CYCLE;
    if (this.demo && phase > IDLE_DUR) {
      const k = (phase - IDLE_DUR) / DEMO_DUR;
      for (const m of this.demo.meshes) m.visible = true;
      this.demo.update(k, this.time);
      this.onCaption?.(this.demo.label);
    } else {
      // idle: settle the babo back to center + clear demo visuals/uniforms
      this.baboRoot.position.x += (0 - this.baboRoot.position.x) * Math.min(1, dt * 8);
      this.baboRoot.position.z += (0 - this.baboRoot.position.z) * Math.min(1, dt * 8);
      this.resetDemoState();
      this.onCaption?.(null);
    }
    this.baboRoot.position.y = R + bob;

    if (this.visual?.animate) this.visual.animate(this.visual.upright, this.time);

    this.renderer.render(this.scene, this.camera);
  }

  // ---------------------------------------------------------------------------

  resize(): void {
    const w = this.canvas.clientWidth || 320;
    const h = this.canvas.clientHeight || 240;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.stop();
    this.ro?.disconnect();
    this.ro = null;
    if (this.demo) for (const m of this.demo.meshes) disposeObj(m);
    if (this.visual) disposeClassVisual(this.visual);
    if (this.gun) disposeGunModel(this.gun);
    this.scene.traverse((o) => {
      const m = o as Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = (m as Mesh).material;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else if (mat) (mat as Material).dispose();
    });
    this.renderer.dispose();
    this.renderer.forceContextLoss(); // release the GL context now, don't wait for GC
  }
}

function ease(x: number): number {
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
}

function disposeObj(o: Object3D): void {
  o.traverse((c) => {
    const m = c as Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else if (mat) (mat as Material).dispose();
  });
}
