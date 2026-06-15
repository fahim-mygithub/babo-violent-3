import { dist, norm, segCircle } from '../../core/math';
import { C } from '../../data/constants';
import { GUNS } from '../../data/weapons';
import type { GameSim } from '../sim';
import type { PlayerState, Projectile } from '../types';

/** Terminal rail beam: muzzle (captured ox,oy) → real impact/expiry point. */
function emitRail(sim: GameSim, pr: Projectile, x1: number, y1: number): void {
  sim.emit({ t: 'rail', x0: pr.ox, y0: pr.oy, x1, y1, owner: pr.owner });
}

/**
 * Kinematic projectile motion + collision (no rapier bodies).
 * - Sweep each projectile by v*dt; wall hit via sim.raycastWalls (emit hitWall,
 *   despawn; rockets explode).
 * - Babo hit via segCircle vs alive players (skip owner, skip phased, skip
 *   teammates; sim.damage handles the rest).
 * - Rockets: sim.explode on any impact, and at end of range.
 * - Flames: short ttl via maxDist; ignite pools they touch (bloodSystem
 *   handles fire zones; here just call sim.spawnFire when a flame crosses a pool).
 * - Despawn past maxDist.
 */
export function projectileSystem(sim: GameSim, dt: number): void {
  // In-place compaction: survivors slide to the front, no per-tick allocation
  const arr = sim.projectiles;
  let w = 0;
  for (let i = 0; i < arr.length; i++) {
    if (stepProjectile(sim, arr[i], dt)) arr[w++] = arr[i];
  }
  arr.length = w;
}

/** Advance one projectile by dt. Returns true to keep it, false to despawn. */
function stepProjectile(sim: GameSim, pr: Projectile, dt: number): boolean {
  const tx = pr.x + pr.vx * dt;
  const ty = pr.y + pr.vy * dt;

  // 1. Wall sweep
  const tWall = sim.raycastWalls(pr.x, pr.y, tx, ty);

  // 2. Babo sweep — earliest valid target along the segment
  let tBabo = -1;
  let target: PlayerState | null = null;
  for (const p of sim.players.values()) {
    if (!p.alive || p.id === pr.owner || p.phaseActive) continue;
    if (pr.team !== -1 && p.team === pr.team) continue; // pass through teammates
    const t = segCircle(pr.x, pr.y, tx, ty, p.x, p.y, C.BABO_RADIUS);
    if (t >= 0 && (tBabo < 0 || t < tBabo)) { tBabo = t; target = p; }
  }

  // 3. Earliest event wins
  const baboFirst = tBabo >= 0 && (tWall < 0 || tBabo <= tWall);
  const tHit = baboFirst ? tBabo : tWall;
  if (tHit >= 0) {
    const hx = pr.x + (tx - pr.x) * tHit;
    const hy = pr.y + (ty - pr.y) * tHit;
    if (pr.kind === 'rocket') {
      // Back the blast off the surface a hair so the wall can't shield it
      const [nx, ny] = norm(pr.vx, pr.vy);
      detonate(sim, pr, hx - nx * 0.01, hy - ny * 0.01);
    } else if (baboFirst && target) {
      // The round is spent even if damage() returns 0 (invuln)
      sim.damage(target, pr.owner, pr.damage, pr.gun);
      if (pr.kind === 'bullet') {
        const [nx, ny] = norm(pr.vx, pr.vy);
        sim.applyImpulse(target, nx * pr.damage * 0.06, ny * pr.damage * 0.06);
      } else if (pr.kind === 'rail') {
        // Rail: heavy fixed knockback along travel, terminal beam to the impact.
        const [nx, ny] = norm(pr.vx, pr.vy);
        sim.applyImpulse(target, nx * C.LANCE_KNOCK, ny * C.LANCE_KNOCK);
        emitRail(sim, pr, hx, hy);
      }
    } else if (pr.kind === 'bullet') {
      sim.emit({ t: 'hitWall', x: hx, y: hy, gun: pr.gun });
    } else if (pr.kind === 'rail') {
      // Wall-stopped: terminal beam clamps to the wall face.
      emitRail(sim, pr, hx, hy);
    }
    // (flames despawn quietly on walls — no event)
    return false;
  }

  // 5. No hit: advance
  pr.x = tx;
  pr.y = ty;
  pr.dist += Math.hypot(pr.vx, pr.vy) * dt;

  // 4. Flame × blood: ignite the first pool we overlap
  if (pr.kind === 'flame') {
    for (let i = 0; i < sim.pools.length; i++) {
      const pool = sim.pools[i];
      if (dist(pr.x, pr.y, pool.x, pool.y) < pool.r) {
        sim.spawnFire(pool.x, pool.y, pool.r);
        sim.pools.splice(i, 1);
        sim.emit({ t: 'poolGone', id: pool.id });
        return false;
      }
    }
  }

  // Range end: rockets detonate, rails flash their full-length beam, rest vanish
  if (pr.dist >= pr.maxDist) {
    if (pr.kind === 'rocket') detonate(sim, pr, pr.x, pr.y);
    else if (pr.kind === 'rail') emitRail(sim, pr, pr.x, pr.y);
    return false;
  }
  return true;
}

/** Rocket payloads read the thumper config (the only rocket gun in v1). */
function detonate(sim: GameSim, pr: Projectile, x: number, y: number): void {
  const cfg = GUNS.thumper;
  sim.explode(x, y, cfg.splashRadius!, cfg.splashDamage!, cfg.splashImpulse!, pr.owner, 'rocket', 'thumper');
}
