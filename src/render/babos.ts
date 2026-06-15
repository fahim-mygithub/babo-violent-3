import { CanvasTexture, CircleGeometry, ConeGeometry, CylinderGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial, Object3D, PlaneGeometry, Quaternion, SRGBColorSpace, Scene, ShaderMaterial, SphereGeometry, Sprite, SpriteMaterial, Vector3 } from 'three';
import { C } from '../data/constants';
import { CLASSES } from '../data/classes';
import type { GunId } from '../data/weapons';
import type { PlayerState } from '../sim/types';
import { makeBaboMaterial } from './baboShader';
import { buildGunModel, disposeGunModel } from './gunModels';
import { buildClassVisual, disposeClassVisual, type ClassVisual } from './baboShapes';

/**
 * Diegetic-health Babo: the sphere visibly fills with blood as it takes
 * damage, with a green→red rim glow. Body rolls with velocity; the aim mount
 * stays upright and tracks aim, holding the gun's 3D model. Each chassis carries
 * class-distinctive accessories (baboShapes.ts). Shader lives in baboShader.ts
 * (shared with the lobby preview).
 */
interface BaboVisual {
  group: Group;
  body: Mesh;
  mat: ShaderMaterial;
  mount: Group;        // upright; yaws to aim, holds the gun model
  gun: Group;
  gunId: GunId;              // current held gun (rebuild the model on scavenge swap)
  visual: ClassVisual;       // class-distinctive accessories
  phased: boolean;           // last-applied Phantom phase fade state
  shadow: Mesh;
  marker: Mesh;      // bounty leader crown
  flagPole: Group;   // CTF carry indicator
  nameTag: Sprite;
}

/** BV2-style floating name tag (canvas-rendered, white with dark outline). */
function makeNameSprite(name: string): Sprite {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 48;
  const g = c.getContext('2d')!;
  g.font = 'bold 24px monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 5;
  g.strokeStyle = 'rgba(0,0,0,0.85)';
  g.strokeText(name, 128, 24);
  g.fillStyle = 'rgba(235,240,245,0.95)';
  g.fillText(name, 128, 24);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  const sprite = new Sprite(new SpriteMaterial({
    map: tex, transparent: true, depthWrite: false,
  }));
  sprite.scale.set(2.2, 0.41, 1);
  sprite.position.y = 1.05;
  return sprite;
}

/** Set transparent+opacity on every (opaque) material under an object — Phantom
 *  phase fade for the held gun, restored cleanly when phase ends. */
function setGroupOpacity(obj: Object3D, opacity: number): void {
  obj.traverse((o) => {
    const m = (o as Mesh).material;
    const mats = Array.isArray(m) ? m : m ? [m] : [];
    for (const mm of mats) {
      mm.transparent = opacity < 1;
      mm.opacity = opacity;
    }
  });
}

/** Recursively dispose geometries, materials and any material textures. */
function disposeObject3D(obj: Object3D): void {
  obj.traverse((o) => {
    const mesh = o as Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const m = mesh.material;
    const mats = Array.isArray(m) ? m : m ? [m] : [];
    for (const mm of mats) {
      const tex = (mm as MeshBasicMaterial).map ?? (mm as SpriteMaterial).map;
      if (tex) tex.dispose();
      mm.dispose();
    }
  });
}

export class BaboPool {
  private visuals = new Map<number, BaboVisual>();
  private sphereGeo = new SphereGeometry(C.BABO_RADIUS, 28, 20);
  private shadowGeo = new CircleGeometry(C.BABO_RADIUS * 1.1, 20);
  private shadowMat = new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 });
  private tmpAxis = new Vector3();
  private tmpQuat = new Quaternion();

  constructor(private scene: Scene) {}

  private create(p: PlayerState): BaboVisual {
    const cls = CLASSES[p.classId];
    const group = new Group();

    // Class-distinctive accessories + cosmetic body scale (baboShapes.ts).
    const visual = buildClassVisual(p.classId, C.BABO_RADIUS);
    const mat = makeBaboMaterial(cls.color, C.BABO_RADIUS, C.BABO_RADIUS * visual.bodyScale);
    const body = new Mesh(this.sphereGeo, mat);
    body.scale.setScalar(visual.bodyScale);
    group.add(body);
    for (const o of visual.roll) body.add(o);     // tumble with the ball (inherits bodyScale)
    // Upright bits ride a bodyScale wrapper so they track the scaled shell too.
    const uprightHolder = new Group();
    uprightHolder.scale.setScalar(visual.bodyScale);
    for (const o of visual.upright) uprightHolder.add(o);
    group.add(uprightHolder);

    // Aim mount: upright group that yaws to aim while the ball rolls under it.
    // True to BV2, the babo has no face — the held gun is the only oriented part.
    const mount = new Group();
    group.add(mount);

    // Held gun: a distinct 3D model per weapon, muzzle along aim (+X).
    const gun = buildGunModel(p.gun);
    gun.position.set(0.45, 0.06, 0);
    mount.add(gun);

    const shadow = new Mesh(this.shadowGeo, this.shadowMat);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = -C.BABO_RADIUS + 0.02;
    group.add(shadow);

    // Bounty leader crown: visible through walls
    const marker = new Mesh(
      new ConeGeometry(0.28, 0.42, 4),
      new MeshBasicMaterial({ color: 0xffc83a, depthTest: false, transparent: true, opacity: 0.95 }),
    );
    marker.position.y = 1.6; // above the name tag
    marker.rotation.x = Math.PI;
    marker.renderOrder = 999;
    marker.visible = false;
    group.add(marker);

    // CTF flag indicator
    const flagPole = new Group();
    const pole = new Mesh(
      new CylinderGeometry(0.03, 0.03, 0.9),
      new MeshBasicMaterial({ color: 0xcccccc }),
    );
    pole.position.y = 1.1;
    const cloth = new Mesh(
      new PlaneGeometry(0.45, 0.3),
      new MeshBasicMaterial({ color: 0xff3333, side: DoubleSide }),
    );
    cloth.position.set(0.24, 1.4, 0);
    flagPole.add(pole, cloth);
    flagPole.visible = false;
    group.add(flagPole);

    const nameTag = makeNameSprite(p.name);
    group.add(nameTag);

    this.scene.add(group);
    const vis: BaboVisual = {
      group, body, mat, mount, gun, gunId: p.gun, visual, phased: false,
      shadow, marker, flagPole, nameTag,
    };
    this.visuals.set(p.id, vis);
    return vis;
  }

  update(players: Iterable<PlayerState>, dt: number, time: number, leaderId: number): void {
    const seen = new Set<number>();
    for (const p of players) {
      seen.add(p.id);
      const vis = this.visuals.get(p.id) ?? this.create(p);
      vis.group.visible = p.alive;
      if (!p.alive) continue;

      vis.group.position.set(p.x, C.BABO_RADIUS, p.y);

      // Roll the body by velocity (axis ⟂ velocity on the ground plane)
      const speed = Math.hypot(p.vx, p.vy);
      if (speed > 0.05) {
        this.tmpAxis.set(p.vy, 0, -p.vx).normalize().negate();
        this.tmpQuat.setFromAxisAngle(this.tmpAxis, (speed * dt) / C.BABO_RADIUS);
        vis.body.quaternion.premultiply(this.tmpQuat);
      }

      // Aim mount + gun face aim (sim aim angle → XZ yaw)
      vis.mount.rotation.y = -p.aim;

      // Scavenge swap: rebuild the held model when the carried gun changes.
      if (p.gun !== vis.gunId) {
        vis.mount.remove(vis.gun);
        disposeGunModel(vis.gun);
        vis.gun = buildGunModel(p.gun);
        vis.gun.position.set(0.45, 0.06, 0);
        vis.mount.add(vis.gun);
        vis.gunId = p.gun;
        if (vis.phased) setGroupOpacity(vis.gun, 0.32); // keep a mid-phase swap ghostly
      }

      // Class accessory animation (orbiting rings, hovering wisps, …)
      vis.visual.animate?.(vis.visual.upright, time);

      const u = vis.mat.uniforms;
      u.uHp.value = Math.max(0, p.hp) / C.MAX_HP;
      u.uCenterY.value = C.BABO_RADIUS;
      u.uTime.value = time;
      u.uBlink.value = p.invulnT > 0 ? (Math.sin(time * 22) > 0 ? 0.55 : 0) : 0;
      u.uBurn.value = p.burnT > 0 ? 1 : 0;
      u.uFortify.value = p.fortifyActive ? 1 : 0;
      u.uOpacity.value = p.phaseActive ? 0.32 : 1;

      // Phase Shift fades the body shader; fade the held gun to match so it
      // doesn't float opaque beside a ghost body. Toggle only on transition.
      if (p.phaseActive !== vis.phased) {
        vis.phased = p.phaseActive;
        setGroupOpacity(vis.gun, p.phaseActive ? 0.32 : 1);
      }

      vis.marker.visible = p.id === leaderId;
      if (vis.marker.visible) vis.marker.rotation.y = time * 2;
      vis.flagPole.visible = p.carryingFlag !== -1;
      if (p.carryingFlag !== -1) {
        (vis.flagPole.children[1] as Mesh<PlaneGeometry, MeshBasicMaterial>)
          .material.color.setHex(p.carryingFlag === 0 ? 0x4a8cff : 0xff4a4a);
      }
    }
    // Remove visuals for departed players
    for (const [id, vis] of this.visuals) {
      if (!seen.has(id)) {
        this.scene.remove(vis.group);
        this.disposeVisual(vis);
        this.visuals.delete(id);
      }
    }
  }

  /** Dispose one babo's per-instance geometries/materials (not pool-shared ones). */
  private disposeVisual(vis: BaboVisual): void {
    vis.mat.dispose();
    disposeGunModel(vis.gun);
    disposeClassVisual(vis.visual);
    disposeObject3D(vis.marker);
    disposeObject3D(vis.flagPole);
    disposeObject3D(vis.nameTag);
  }

  /** Tear down every babo + the pool-shared geometries/material. */
  dispose(): void {
    for (const vis of this.visuals.values()) {
      this.scene.remove(vis.group);
      this.disposeVisual(vis);
    }
    this.visuals.clear();
    this.sphereGeo.dispose();
    this.shadowGeo.dispose();
    this.shadowMat.dispose();
  }
}
