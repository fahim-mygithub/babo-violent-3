import { AdditiveBlending, Blending, BoxGeometry, CircleGeometry, ConeGeometry, CylinderGeometry, DoubleSide, Group, Material, Mesh, MeshBasicMaterial, NormalBlending, Object3D, PlaneGeometry, RingGeometry, Scene, SphereGeometry, Sprite, SpriteMaterial } from 'three';
import { C } from '../data/constants';
import { GUNS } from '../data/weapons';
import { EQUIPMENT } from '../data/equipment';
import { QUALITY } from './quality';
import { surfaceMat } from './surfaceMat';

/**
 * Scale a transient particle-burst count by the live quality tier, never below 1
 * so gameplay-readable bursts (hit / hitWall) always show at least one particle.
 * High → particleScale 1 → today's literal count. Render-side `Math.random()` and
 * these counts never touch the sim, so determinism is unaffected.
 */
export const scaledBurstCount = (n: number): number =>
  Math.max(1, Math.round(n * QUALITY.particleScale));

/** Max render-side dead-reckon horizon (50ms) — caps overshoot on a stale snapshot. */
const DEAD_RECKON_MAX = 0.05;

/**
 * Pure render-side constant-velocity extrapolation. Advances a projectile's
 * last-known position along (vx,vy) by dt, clamped to {@link DEAD_RECKON_MAX}.
 * NEVER feeds the sim — smooths the fast rail slug between snapshots only.
 */
export function deadReckon(
  pr: { x: number; y: number; vx: number; vy: number },
  dt: number,
): { x: number; y: number } {
  const t = Math.min(dt, DEAD_RECKON_MAX);
  return { x: pr.x + pr.vx * t, y: pr.y + pr.vy * t };
}
import type {
  BloodPool, FireZone, GameEvent, Grenade, Pickup, PlayerState, Projectile, SmokeZone,
} from '../sim/types';
import type { ModeState } from '../sim/types';
import { makeGlowTexture } from './textures';

const BH = C.BABO_RADIUS; // babo height / default fx height

interface Particle {
  obj: Sprite | Mesh;
  vx: number; vy: number; vz: number; // sim x, height, sim y
  life: number;
  maxLife: number;
  gravity: number;
  scaleRate: number;
  baseScale: number;
  bounce: boolean;
}

/** Everything visible in the world that isn't a Babo or the floor/walls. */
export class EffectsLayer {
  private glowTex = makeGlowTexture();

  private projMeshes = new Map<number, Object3D>();
  private grenMeshes = new Map<number, Object3D>();
  private poolMeshes = new Map<number, Mesh>();
  private fireGroups = new Map<number, Group>();
  private smokeGroups = new Map<number, Group>();
  private pickupGroups = new Map<number, Group>();
  private flagGroups: Group[] = [];
  private grappleLines = new Map<number, Mesh>();
  private wellRings: { obj: Group; ttl: number }[] = [];
  private beams: { obj: Mesh; ttl: number; maxTtl: number }[] = [];
  private particles: Particle[] = [];
  private spritePool: Sprite[] = [];
  // Free-list of dead Particle records, recycled by makeParticle() so heavy bursts
  // allocate zero new Particle objects in steady state (the sprite is already pooled
  // via spritePool). Bounded by the largest concurrent burst, not total events.
  private particlePool: Particle[] = [];

  private arcDots: Mesh[] = [];
  private arcLanding: Mesh;

  /** Last update() dt — feeds render-side rail dead-reckoning (never the sim). */
  private lastFrameDt = 1 / 60;

  private poolGeo = new CircleGeometry(1, 26);
  private bulletGeo = new SphereGeometry(0.09, 8, 6);
  private rocketGeo = new ConeGeometry(0.16, 0.5, 8);
  private grenadeGeo = new SphereGeometry(0.16, 10, 8);
  private railGeo = new BoxGeometry(0.4, 0.12, 0.12); // stretched ×3.5 along travel

  // Shared transient-VFX geometry — one instance reused (and per-mesh scaled) for
  // every explosion/dash/ability ring and every rail beam, instead of allocating
  // (and disposing) a fresh geometry per event. Unit dims + per-mesh scale ⇒ pixel-
  // identical to the old per-event geometry. Materials stay per-mesh (they fade
  // independently and are disposed on expiry); only the geometry is pooled.
  private ringGeo = new RingGeometry(0.8, 1, 32);
  private beamGeo = new BoxGeometry(1, 0.08, 0.08);

  constructor(private scene: Scene) {
    const landGeo = new RingGeometry(0.3, 0.42, 24);
    this.arcLanding = new Mesh(
      landGeo,
      new MeshBasicMaterial({ color: 0xffd060, transparent: true, opacity: 0.85, side: DoubleSide }),
    );
    this.arcLanding.rotation.x = -Math.PI / 2;
    this.arcLanding.visible = false;
    this.arcLanding.position.y = 0.04;
    scene.add(this.arcLanding);
    for (let i = 0; i < 12; i++) {
      const dot = new Mesh(
        new SphereGeometry(0.06, 6, 4),
        new MeshBasicMaterial({ color: 0xffd060, transparent: true, opacity: 0.8 }),
      );
      dot.visible = false;
      scene.add(dot);
      this.arcDots.push(dot);
    }
  }

  // -------------------------------------------------------------------------
  // Per-frame world sync
  // -------------------------------------------------------------------------

  sync(
    players: Iterable<PlayerState>,
    projectiles: Projectile[], grenades: Grenade[], pools: BloodPool[],
    fires: FireZone[], smokes: SmokeZone[], pickups: Pickup[], mode: ModeState,
    localId: number, time: number,
  ): void {
    this.syncProjectiles(projectiles);
    this.syncGrenades(grenades, time);
    this.syncPools(pools);
    this.syncFires(fires, time);
    this.syncSmokes(smokes, time);
    this.syncPickups(pickups, time);
    this.syncFlags(mode, time);
    this.syncGrapples(players);
    this.syncThrowArc(players, localId);
  }

  private syncSet<T extends { id: number }>(
    items: T[], map: Map<number, Object3D>,
    create: (item: T) => Object3D, update: (item: T, obj: Object3D) => void,
  ): void {
    const seen = new Set<number>();
    for (const item of items) {
      seen.add(item.id);
      let obj = map.get(item.id);
      if (!obj) {
        obj = create(item);
        this.scene.add(obj);
        map.set(item.id, obj);
      }
      update(item, obj);
    }
    for (const [id, obj] of map) {
      if (!seen.has(id)) {
        this.scene.remove(obj);
        map.delete(id);
      }
    }
  }

  private syncProjectiles(projectiles: Projectile[]): void {
    this.syncSet(projectiles, this.projMeshes,
      (pr) => {
        const color = GUNS[pr.gun].color;
        if (pr.kind === 'rocket') {
          const g = new Group();
          const m = new Mesh(this.rocketGeo, new MeshBasicMaterial({ color: 0xd8d0c8 }));
          m.rotation.x = Math.PI / 2;
          const glow = this.makeSprite(0xffa040, 0.8, AdditiveBlending);
          glow.position.z = -0.3;
          g.add(m, glow);
          return g;
        }
        if (pr.kind === 'flame') {
          return this.makeSprite(0xff8020, 0.55, AdditiveBlending);
        }
        if (pr.kind === 'rail') {
          // Bright additive slug, stretched along travel.
          const mesh = new Mesh(this.railGeo, new MeshBasicMaterial({
            color: GUNS.lance.color, blending: AdditiveBlending, transparent: true,
          }));
          mesh.scale.set(3.5, 1, 1);
          return mesh;
        }
        const mesh = new Mesh(this.bulletGeo, new MeshBasicMaterial({ color }));
        mesh.scale.set(2.2, 1, 1); // tracer stretch along travel
        return mesh;
      },
      (pr, obj) => {
        const ang = Math.atan2(pr.vy, pr.vx);
        obj.rotation.y = -ang;
        if (pr.kind === 'rail') {
          // Dead-reckon the fast slug forward, but never past its own range from
          // the captured muzzle origin (the terminal 'rail' beam stays authoritative).
          const dr = deadReckon(pr, this.lastFrameDt);
          const traveled = Math.hypot(dr.x - pr.ox, dr.y - pr.oy);
          if (traveled > pr.maxDist) {
            const k = pr.maxDist / (traveled || 1);
            dr.x = pr.ox + (dr.x - pr.ox) * k;
            dr.y = pr.oy + (dr.y - pr.oy) * k;
          }
          obj.position.set(dr.x, BH, dr.y);
          obj.scale.set(3.5, 1, 1);
          return;
        }
        obj.position.set(pr.x, BH, pr.y);
        if (pr.kind === 'flame') {
          const t = pr.dist / pr.maxDist;
          const s = 0.35 + t * 1.5;
          obj.scale.set(s, s, s);
          ((obj as Sprite).material).opacity = 0.85 * (1 - t * 0.75);
        }
      });
  }

  private syncGrenades(grenades: Grenade[], time: number): void {
    this.syncSet(grenades, this.grenMeshes,
      (gr) => new Mesh(
        this.grenadeGeo,
        surfaceMat({ color: EQUIPMENT[gr.kind].color, roughness: 0.5 }),
      ),
      (gr, obj) => {
        obj.position.set(gr.x, 0.16 + gr.z, gr.y);
        // Fuse blink for landed frags. On low (Basic) there's no emissive channel,
        // so guard the per-frame write rather than assume the Standard material.
        const m = (obj as Mesh).material as { emissive?: { setHex(h: number): void } };
        m.emissive?.setHex(gr.landed && gr.kind === 'frag' && Math.sin(time * 30) > 0 ? 0xff2020 : 0x000000);
      });
  }

  private syncPools(pools: BloodPool[]): void {
    this.syncSet(pools, this.poolMeshes as Map<number, Object3D>,
      () => {
        const mesh = new Mesh(this.poolGeo, surfaceMat({
          color: 0x4d0408, roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.92,
        }));
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.y = 0.025;
        return mesh;
      },
      (pool, obj) => {
        obj.position.set(pool.x, 0.025, pool.y);
        obj.scale.set(pool.r, pool.r, 1);
      });
  }

  private syncFires(fires: FireZone[], time: number): void {
    this.syncSet(fires, this.fireGroups as Map<number, Object3D>,
      (f) => {
        const g = new Group();
        const fc = QUALITY.fireSprites; // flicker-sprite count (tiered; high = 7)
        for (let i = 0; i < fc; i++) {
          const s = this.makeSprite(i % 2 ? 0xff6a10 : 0xffc040, 1, AdditiveBlending);
          const a = (i / fc) * Math.PI * 2;
          s.position.set(Math.cos(a) * f.r * 0.55, 0.3, Math.sin(a) * f.r * 0.55);
          g.add(s);
        }
        const base = this.makeSprite(0xff3000, f.r * 2, AdditiveBlending);
        base.position.y = 0.15;
        g.add(base);
        return g;
      },
      (f, obj) => {
        obj.position.set(f.x, 0, f.y);
        // All children but the last are flicker sprites; the final child is the base.
        const flickers = obj.children.length - 1;
        obj.children.forEach((child, i) => {
          if (i < flickers) {
            const flick = 0.7 + 0.5 * Math.sin(time * (9 + i * 1.7) + i * 2.4);
            child.scale.setScalar((0.6 + 0.5 * flick) * Math.min(1, f.ttl));
            child.position.y = 0.3 + 0.18 * Math.sin(time * 7 + i * 1.9);
          }
        });
      });
  }

  private syncSmokes(smokes: SmokeZone[], time: number): void {
    this.syncSet(smokes, this.smokeGroups as Map<number, Object3D>,
      (s) => {
        const g = new Group();
        const sc = QUALITY.smokeSprites; // puff count (tiered; high = 6)
        for (let i = 0; i < sc; i++) {
          const sp = this.makeSprite(0x8a929a, s.r * 1.3, NormalBlending, 0.85);
          const a = (i / sc) * Math.PI * 2;
          sp.position.set(Math.cos(a) * s.r * 0.45, 0.5 + (i % 3) * 0.35, Math.sin(a) * s.r * 0.45);
          g.add(sp);
        }
        return g;
      },
      (s, obj) => {
        obj.position.set(s.x, 0, s.y);
        obj.rotation.y = time * 0.15;
        const fade = Math.min(1, s.ttl / 1.5);
        obj.children.forEach((child) => {
          ((child as Sprite).material).opacity = 0.85 * fade;
        });
      });
  }

  private syncPickups(pickups: Pickup[], time: number): void {
    this.syncSet(pickups, this.pickupGroups as Map<number, Object3D>,
      (pk) => {
        const g = new Group();
        let item: Object3D;
        let ringColor = 0xffffff;
        if (pk.kind === 'gun') {
          ringColor = GUNS[pk.gun!].color;
          item = new Mesh(
            new BoxGeometry(0.62, 0.16, 0.16),
            surfaceMat({ color: ringColor, roughness: 0.35, metalness: 0.5, emissive: ringColor, emissiveIntensity: 0.25 }),
          );
        } else if (pk.kind === 'health') {
          ringColor = 0xff5050;
          item = new Group();
          const box = new Mesh(
            new BoxGeometry(0.4, 0.22, 0.4),
            surfaceMat({ color: 0xf2f2f2, roughness: 0.4 }),
          );
          const crossMat = new MeshBasicMaterial({ color: 0xe03030 });
          const c1 = new Mesh(new BoxGeometry(0.3, 0.04, 0.1), crossMat);
          const c2 = new Mesh(new BoxGeometry(0.1, 0.04, 0.3), crossMat);
          c1.position.y = c2.position.y = 0.12;
          (item as Group).add(box, c1, c2);
        } else {
          ringColor = EQUIPMENT[pk.equip!].color;
          item = new Mesh(
            new SphereGeometry(0.2, 12, 8),
            surfaceMat({ color: ringColor, roughness: 0.4, emissive: ringColor, emissiveIntensity: 0.3 }),
          );
        }
        item.name = 'item';
        const ring = new Mesh(
          new RingGeometry(0.42, 0.52, 22),
          new MeshBasicMaterial({ color: ringColor, transparent: true, opacity: 0.5, side: DoubleSide }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.03;
        ring.name = 'ring';
        g.add(item, ring);
        return g;
      },
      (pk, obj) => {
        obj.position.set(pk.x, 0, pk.y);
        const item = obj.getObjectByName('item');
        if (item) {
          item.position.y = 0.3 + Math.sin(time * 2.4 + pk.id) * 0.08;
          item.rotation.y = time * 1.4;
        }
        const ring = obj.getObjectByName('ring') as Mesh | null;
        if (ring) {
          const pulse = 0.85 + 0.2 * Math.sin(time * 3 + pk.id);
          ring.scale.set(pulse, pulse, 1);
        }
      });
  }

  private syncFlags(mode: ModeState, time: number): void {
    if (mode.flags.length === 0) return;
    while (this.flagGroups.length < mode.flags.length) {
      const team = this.flagGroups.length;
      const g = new Group();
      const pole = new Mesh(
        new CylinderGeometry(0.05, 0.05, 1.6),
        surfaceMat({ color: 0xb0b8c0, metalness: 0.6, roughness: 0.3 }),
      );
      pole.position.y = 0.8;
      const cloth = new Mesh(
        new PlaneGeometry(0.8, 0.5),
        new MeshBasicMaterial({ color: team === 0 ? 0x4a8cff : 0xff4a4a, side: DoubleSide }),
      );
      cloth.position.set(0.42, 1.3, 0);
      g.add(pole, cloth);
      this.scene.add(g);
      this.flagGroups.push(g);
    }
    mode.flags.forEach((f, i) => {
      const g = this.flagGroups[i];
      g.visible = f.state !== 'carried';
      g.position.set(f.x, 0, f.y);
      g.rotation.y = time * 0.8;
    });
  }

  private syncGrapples(players: Iterable<PlayerState>): void {
    const seen = new Set<number>();
    for (const p of players) {
      if (!p.alive || !p.grappleActive) continue;
      seen.add(p.id);
      let line = this.grappleLines.get(p.id);
      if (!line) {
        line = new Mesh(
          new BoxGeometry(1, 0.05, 0.05),
          new MeshBasicMaterial({ color: 0xcccccc }),
        );
        this.scene.add(line);
        this.grappleLines.set(p.id, line);
      }
      const dx = p.grappleX - p.x;
      const dy = p.grappleY - p.y;
      const len = Math.hypot(dx, dy);
      line.position.set(p.x + dx / 2, BH, p.y + dy / 2);
      line.scale.x = Math.max(0.01, len);
      line.rotation.y = -Math.atan2(dy, dx);
    }
    for (const [id, line] of this.grappleLines) {
      if (!seen.has(id)) {
        this.scene.remove(line);
        this.grappleLines.delete(id);
      }
    }
  }

  /** Grenade throw arc + landing ring for the local player. */
  private syncThrowArc(players: Iterable<PlayerState>, localId: number): void {
    let local: PlayerState | undefined;
    for (const p of players) if (p.id === localId) { local = p; break; }
    const show = !!local && local.alive && local.throwing &&
      (local.grenades > 0 || local.equipCount > 0);
    this.arcLanding.visible = show;
    for (const d of this.arcDots) d.visible = show;
    if (!show || !local) return;

    const chargeMax = C.GRENADE_MIN_RANGE +
      (C.GRENADE_MAX_RANGE - C.GRENADE_MIN_RANGE) * Math.min(local.throwT / C.GRENADE_AIM_TIME, 1);
    const range = Math.min(Math.max(local.input.aimDist, C.GRENADE_MIN_RANGE), chargeMax);
    const T = 0.55 + 0.045 * range;
    const g = 16;
    const vz = (g * T) / 2;
    const dirX = Math.cos(local.aim);
    const dirY = Math.sin(local.aim);
    for (let i = 0; i < this.arcDots.length; i++) {
      const t = ((i + 1) / (this.arcDots.length + 1)) * T;
      const d = (range / T) * t;
      const z = 0.6 + vz * t - 0.5 * g * t * t;
      this.arcDots[i].position.set(local.x + dirX * d, Math.max(0.1, z), local.y + dirY * d);
    }
    this.arcLanding.position.set(local.x + dirX * range, 0.04, local.y + dirY * range);
  }

  // -------------------------------------------------------------------------
  // Event-driven transient VFX
  // -------------------------------------------------------------------------

  handleEvent(ev: GameEvent): void {
    // Hidden tab: sim keeps running but transient VFX would pile up unseen
    // and un-decayed (update() is render-driven) — skip them entirely.
    if (document.hidden) return;
    switch (ev.t) {
      case 'shot': {
        const gun = GUNS[ev.gun];
        const mx = ev.x + Math.cos(ev.aim) * 0.75;
        const my = ev.y + Math.sin(ev.aim) * 0.75;
        this.flash(mx, my, gun.id === 'thumper' ? 0.9 : 0.45, 0xffd080, 0.05);
        break;
      }
      case 'rail': {
        const beam = new Mesh(
          this.beamGeo,
          new MeshBasicMaterial({ color: 0xc090ff, transparent: true, opacity: 1, blending: AdditiveBlending }),
        );
        const dx = ev.x1 - ev.x0;
        const dy = ev.y1 - ev.y0;
        beam.position.set(ev.x0 + dx / 2, BH, ev.y0 + dy / 2);
        beam.scale.x = Math.max(0.01, Math.hypot(dx, dy));
        beam.rotation.y = -Math.atan2(dy, dx);
        this.scene.add(beam);
        this.beams.push({ obj: beam, ttl: 0.3, maxTtl: 0.3 });
        break;
      }
      case 'explosion': {
        this.flash(ev.x, ev.y, ev.r * 1.6, 0xffc060, 0.16);
        this.ring(ev.x, ev.y, ev.r, 0xffa040);
        this.burst(ev.x, ev.y, BH, 16, 8, 0xff9030, 0.5, true);
        this.burst(ev.x, ev.y, BH, 8, 3, 0x555555, 1.1, false);
        break;
      }
      case 'pop': {
        this.burst(ev.x, ev.y, BH, 26, 7, 0x8a0508, 0.8, true);
        this.burst(ev.x, ev.y, BH, 8, 4, 0x5a0306, 1.2, true, 0.16);
        this.flash(ev.x, ev.y, 1.1, 0xc01818, 0.12);
        break;
      }
      case 'hit':
        this.burst(ev.x, ev.y, BH, 5, 4, 0xa00a10, 0.35, true);
        break;
      case 'hitWall':
        this.burst(ev.x, ev.y, BH, 4, 3, 0xc8c0a8, 0.22, false);
        break;
      case 'fireIgnite':
        this.flash(ev.x, ev.y, ev.r * 1.4, 0xff7010, 0.2);
        break;
      case 'smokePop':
        this.burst(ev.x, ev.y, 0.6, 8, 2, 0x9aa2aa, 1.3, false, 0.9);
        break;
      case 'dashImpact':
        this.flash(ev.x, ev.y, 0.9, 0xffffff, 0.1);
        this.ring(ev.x, ev.y, 1.2, 0xffe0a0);
        break;
      case 'abilityCast':
        if (ev.ability === 'gravityWell' && ev.tx !== undefined && ev.ty !== undefined) {
          const g = new Group();
          for (let i = 0; i < 3; i++) {
            const ring = new Mesh(
              new RingGeometry(1.2 + i * 1.1, 1.35 + i * 1.1, 32),
              new MeshBasicMaterial({ color: 0xd4b13e, transparent: true, opacity: 0.7 - i * 0.18, side: DoubleSide }),
            );
            ring.rotation.x = -Math.PI / 2;
            ring.position.y = 0.06 + i * 0.02;
            g.add(ring);
          }
          g.position.set(ev.tx, 0, ev.ty);
          this.scene.add(g);
          this.wellRings.push({ obj: g, ttl: 1.1 });
        } else if (ev.ability === 'dash') {
          this.ring(ev.x, ev.y, 0.9, 0xffb060);
        } else if (ev.ability === 'phase') {
          this.flash(ev.x, ev.y, 0.9, 0xb39ddb, 0.15);
        } else if (ev.ability === 'fortify') {
          this.ring(ev.x, ev.y, 1.0, 0x4a78c8);
        }
        break;
      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Particle helpers
  // -------------------------------------------------------------------------

  private makeSprite(color: number, scale: number, blending: Blending, opacity = 1): Sprite {
    const mat = new SpriteMaterial({
      map: this.glowTex, color, transparent: true, opacity, blending, depthWrite: false,
    });
    const s = new Sprite(mat);
    s.scale.setScalar(scale);
    return s;
  }

  private getPooledSprite(color: number, scale: number, additive: boolean, opacity: number): Sprite | null {
    if (this.particles.length > QUALITY.particleCap) return null; // tier hard cap — drop excess juice
    const s = this.spritePool.pop() ?? new Sprite(new SpriteMaterial({
      map: this.glowTex, transparent: true, depthWrite: false,
    }));
    const m = s.material;
    m.color.setHex(color);
    m.opacity = opacity;
    m.blending = additive ? AdditiveBlending : NormalBlending;
    s.scale.setScalar(scale);
    this.scene.add(s);
    return s;
  }

  /** Radial particle burst at sim pos. */
  private burst(
    x: number, y: number, h: number, count: number, speed: number,
    color: number, life: number, gravity: boolean, baseScale = 0.3,
  ): void {
    const n = scaledBurstCount(count); // tier-scaled, ≥1
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = speed * (0.4 + Math.random() * 0.8);
      const obj = this.getPooledSprite(color, baseScale, gravity, 0.95);
      if (!obj) return;
      obj.position.set(x, h, y);
      this.particles.push(this.makeParticle(obj, {
        vx: Math.cos(a) * sp,
        vz: Math.sin(a) * sp,
        vy: gravity ? 2 + Math.random() * 4 : 0.4,
        life, maxLife: life,
        gravity: gravity ? 13 : 0.4,
        scaleRate: gravity ? -0.1 : 1.2,
        baseScale,
        bounce: gravity,
      }));
    }
  }

  /**
   * Draw a recycled Particle record from the free-list (or allocate one if empty)
   * and populate it. Reusing the record object means a steady-state burst storm
   * allocates zero Particle records — render-only, no behavioural change.
   */
  private makeParticle(obj: Sprite | Mesh, init: Omit<Particle, 'obj'>): Particle {
    const p = this.particlePool.pop();
    if (p) { p.obj = obj; Object.assign(p, init); return p; }
    return { obj, ...init };
  }

  private flash(x: number, y: number, scale: number, color: number, life: number): void {
    const obj = this.getPooledSprite(color, scale * 2, true, 1);
    if (!obj) return;
    obj.position.set(x, BH, y);
    this.particles.push(this.makeParticle(obj, {
      vx: 0, vy: 0, vz: 0, life, maxLife: life, gravity: 0, scaleRate: 6, baseScale: scale * 2, bounce: false,
    }));
  }

  private ring(x: number, y: number, r: number, color: number): void {
    const mesh = new Mesh(
      this.ringGeo,
      new MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: DoubleSide }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 0.08, y);
    mesh.scale.setScalar(r * 0.4);
    this.scene.add(mesh);
    this.beams.push({ obj: mesh, ttl: 0.35, maxTtl: 0.35 });
  }

  update(dt: number): void {
    this.lastFrameDt = dt; // captured for next frame's rail dead-reckoning
    // Particles
    let w = 0;
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.scene.remove(p.obj);
        if (p.obj instanceof Sprite) this.spritePool.push(p.obj);
        this.particlePool.push(p); // recycle the record for the next burst
        continue;
      }
      p.vy -= p.gravity * dt;
      p.obj.position.x += p.vx * dt;
      p.obj.position.y += p.vy * dt;
      p.obj.position.z += p.vz * dt;
      if (p.bounce && p.obj.position.y < 0.06) {
        p.obj.position.y = 0.06;
        p.vy *= -0.4;
        p.vx *= 0.7;
        p.vz *= 0.7;
      }
      const frac = p.life / p.maxLife;
      const scale = Math.max(0.01, p.baseScale * (1 + (1 - frac) * p.scaleRate));
      p.obj.scale.setScalar(scale);
      if (p.obj instanceof Sprite) p.obj.material.opacity = Math.min(1, frac * 1.6);
      this.particles[w++] = p;
    }
    this.particles.length = w;

    // Beams / rings (fade + grow)
    w = 0;
    for (let i = 0; i < this.beams.length; i++) {
      const b = this.beams[i];
      b.ttl -= dt;
      if (b.ttl <= 0) {
        this.scene.remove(b.obj);
        (b.obj.material as Material).dispose();
        continue;
      }
      const frac = b.ttl / b.maxTtl;
      (b.obj.material as MeshBasicMaterial).opacity = frac;
      if ((b.obj.geometry as RingGeometry).type === 'RingGeometry') {
        b.obj.scale.multiplyScalar(1 + dt * 2.2);
      }
      this.beams[w++] = b;
    }
    this.beams.length = w;

    // Gravity-well rings (spin + shrink inward)
    w = 0;
    for (const ring of this.wellRings) {
      ring.ttl -= dt;
      if (ring.ttl <= 0) {
        this.scene.remove(ring.obj);
        continue;
      }
      ring.obj.rotation.y += dt * 5;
      ring.obj.scale.multiplyScalar(Math.max(0.2, 1 - dt * 0.8));
      this.wellRings[w++] = ring;
    }
    this.wellRings.length = w;
  }
}
