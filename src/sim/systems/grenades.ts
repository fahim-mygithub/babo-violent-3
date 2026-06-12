import { clamp, segAABB } from '../../core/math';
import { C } from '../../data/constants';
import type { EquipKind } from '../../data/equipment';
import type { MapWall } from '../../data/maps';
import type { GameSim } from '../sim';
import { BTN, type PlayerState } from '../types';

/** Vertical gravity for the cosmetic z parabola (world units / s²). */
const GRAV = 16;
/** Grenades leave the hand at this height. */
const THROW_Z = 0.6;
/** Velocity retained after a wall bounce. */
const BOUNCE_DAMP = 0.45;
/** Fraction of the thrower's velocity inherited by the grenade. */
const INHERIT = 0.3;

/**
 * Equipment throwing + grenade ballistics.
 * - BTN.THROW held: p.throwT grows (range aim). On release: spawn Grenade with
 *   2D velocity toward aim scaled by throwT (GRENADE_MIN/MAX_RANGE over
 *   GRENADE_AIM_TIME) + cosmetic z parabola sized to clear C.WALL_HEIGHT.
 *   RMB throws the selected equipment: p.equip if equipCount > 0 (the
 *   scavenged special takes priority), frags otherwise.
 * - Airborne (z>0): clears walls lower than the arc; low approaches bounce.
 *   Landed: slight friction slide, fuse ticks.
 * - Frag: explode (C.FRAG_*). Molotov: fire zone on landing (ignites pools via
 *   bloodSystem). Smoke: smoke zone (C.SMOKE_*).
 * - Emit grenadeThrow/grenadeBounce events.
 */
export function grenadeSystem(sim: GameSim, dt: number): void {
  // Throw input: hold to charge the arc, release to throw
  for (const p of sim.players.values()) {
    if (!p.alive) {
      p.throwT = 0;
      p.throwing = false;
      continue;
    }
    const held = (p.input.buttons & BTN.THROW) !== 0;
    const wasHeld = (p.prevButtons & BTN.THROW) !== 0;
    if (held) {
      p.throwing = true;
      p.throwT = Math.min(p.throwT + dt, C.GRENADE_AIM_TIME);
    } else if (wasHeld) {
      releaseThrow(sim, p);
    }
  }

  // Ballistics (iterate backwards: grenades despawn mid-loop)
  for (let i = sim.grenades.length - 1; i >= 0; i--) {
    const g = sim.grenades[i];

    if (!g.landed) {
      // Capture start-of-step vertical state: the wall sweep below must
      // evaluate the arc height from where the step BEGAN, not its end.
      const z0 = g.z;
      const vz0 = g.vz;
      g.z += vz0 * dt;
      g.vz -= GRAV * dt;

      // Sweep 2D against walls; a high enough arc passes over low cover
      const nx = g.x + g.vx * dt;
      const ny = g.y + g.vy * dt;
      let hitT = -1;
      let hitWall: MapWall | null = null;
      for (const w of sim.map.walls) {
        const t = segAABB(g.x, g.y, nx, ny, w.x, w.y, w.w, w.h);
        if (t < 0) continue;
        const ft = t * dt;
        const zAtHit = z0 + vz0 * ft - (GRAV / 2) * ft * ft;
        if (zAtHit > w.height) continue; // sails over the wall
        if (hitT < 0 || t < hitT) { hitT = t; hitWall = w; }
      }
      if (hitWall) {
        // Stop just shy of the wall, reflect the dominant approach axis
        g.x += g.vx * dt * hitT * 0.98;
        g.y += g.vy * dt * hitT * 0.98;
        const px = Math.abs(g.x - hitWall.x) / (hitWall.w / 2);
        const py = Math.abs(g.y - hitWall.y) / (hitWall.h / 2);
        if (px > py) g.vx = -g.vx; else g.vy = -g.vy;
        g.vx *= BOUNCE_DAMP;
        g.vy *= BOUNCE_DAMP;
        sim.emit({ t: 'grenadeBounce', x: g.x, y: g.y });
      } else {
        g.x = nx;
        g.y = ny;
      }

      // Touchdown
      if (g.z <= 0 && g.vz < 0) {
        g.z = 0;
        g.vz = 0;
        g.landed = true;
        if (g.kind === 'molotov') {
          sim.spawnFire(g.x, g.y, C.MOLOTOV_RADIUS);
          sim.grenades.splice(i, 1);
          continue;
        }
        if (g.kind === 'smoke') {
          sim.smokes.push({ id: sim.newId(), x: g.x, y: g.y, r: C.SMOKE_RADIUS, ttl: C.SMOKE_LIFETIME });
          sim.emit({ t: 'smokePop', x: g.x, y: g.y, r: C.SMOKE_RADIUS });
          sim.grenades.splice(i, 1);
          continue;
        }
        g.fuse = C.GRENADE_FUSE;
      }
      continue;
    }

    // Landed frag: friction slide + fuse countdown
    const friction = Math.max(0, 1 - 8 * dt);
    g.vx *= friction;
    g.vy *= friction;
    g.x += g.vx * dt;
    g.y += g.vy * dt;
    g.fuse -= dt;
    if (g.fuse <= 0) {
      // Owner gets the credit; 'world' as the gun label (frags aren't guns)
      sim.explode(g.x, g.y, C.FRAG_RADIUS, C.FRAG_DAMAGE, C.FRAG_IMPULSE, g.owner, 'frag', 'world');
      sim.grenades.splice(i, 1);
    }
  }
}

/** Resolve a THROW release: pick the equipment kind, spend it, lob it. */
function releaseThrow(sim: GameSim, p: PlayerState): void {
  let kind: EquipKind | null = null;
  if (p.equip && p.equipCount > 0) {
    kind = p.equip;
    p.equipCount--;
    if (p.equipCount <= 0) p.equip = null;
  } else if (p.grenades > 0) {
    kind = 'frag';
    p.grenades--;
  }
  const throwT = p.throwT;
  p.throwT = 0;
  p.throwing = false;
  if (!kind) return; // pockets empty

  // Attacking forfeits spawn protection
  if (p.spawnProt) {
    p.spawnProt = false;
    p.invulnT = 0;
  }

  // The arc grows toward the crosshair, capped by hold time
  const chargeMax = C.GRENADE_MIN_RANGE
    + (C.GRENADE_MAX_RANGE - C.GRENADE_MIN_RANGE) * Math.min(throwT / C.GRENADE_AIM_TIME, 1);
  const range = clamp(p.input.aimDist, C.GRENADE_MIN_RANGE, chargeMax);
  const T = 0.55 + 0.045 * range; // flight time scales with distance
  const speed = range / T;
  sim.grenades.push({
    id: sim.newId(), kind, owner: p.id, team: p.team,
    x: p.x, y: p.y,
    vx: Math.cos(p.input.aim) * speed + p.vx * INHERIT,
    vy: Math.sin(p.input.aim) * speed + p.vy * INHERIT,
    z: THROW_Z, vz: (GRAV * T) / 2,
    landed: false, fuse: 0,
  });
  sim.emit({ t: 'grenadeThrow', player: p.id, kind, x: p.x, y: p.y });
}
