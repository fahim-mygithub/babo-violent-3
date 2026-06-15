import { dist, distSq, normInto } from '../../core/math';
import { C } from '../../data/constants';
import type { GameSim } from '../sim';

// Module-scope scratch for normInto(); consumed immediately (single-threaded sim).
const _n: [number, number] = [0, 0];

/**
 * Blood as terrain + fire zones.
 * - Pools age; r shrinks over the last 30% of maxAge; remove at maxAge (emit poolGone).
 * - Set p.inSlick for players overlapping any pool (movementSystem uses it).
 * - Wounded trails: alive players below C.WOUNDED_TRAIL_HP drip (dripT timer):
 *   emit small 'splat' events behind them (visual only).
 * - Fire zones: ttl down; damage players inside (C.FIRE_ZONE_DPS, attacker -1
 *   or remembered owner — v1: world damage) on C.BURN_TICK cadence; set
 *   p.burnT for brief after-burn.
 * - Fire ignites overlapping pools: a burning pool converts to a fire zone of
 *   the pool's radius (once), removing the pool.
 */
export function bloodSystem(sim: GameSim, dt: number): void {
  // --- Pools: age, shrink over the final 30% of life, expire at maxAge -------
  let w = 0;
  for (let i = 0; i < sim.pools.length; i++) {
    const pool = sim.pools[i];
    pool.age += dt;
    if (pool.age >= pool.maxAge) {
      sim.emit({ t: 'poolGone', id: pool.id });
      continue;
    }
    const shrinkWindow = 0.3 * pool.maxAge;
    if (pool.age > pool.maxAge - shrinkWindow) {
      // Per-tick approximation of a linear shrink toward ~30% of spawn size.
      // Always subtracts, so r is monotonically decreasing.
      pool.r = Math.max(0, pool.r - (dt / shrinkWindow) * 0.7 * pool.r);
    }
    sim.pools[w++] = pool;
  }
  sim.pools.length = w;

  // --- Slick flag: alive players overlapping any pool ------------------------
  for (const p of sim.players.values()) {
    let slick = false;
    if (p.alive) {
      for (const pool of sim.pools) {
        if (dist(p.x, p.y, pool.x, pool.y) < pool.r + C.BABO_RADIUS * 0.5) {
          slick = true;
          break;
        }
      }
    }
    p.inSlick = slick;
  }

  // --- Wounded trails: small visual-only splats behind low-HP players --------
  // (size 0.18 < C.MIN_PHYSICAL_POOL_RADIUS, so these never become physical)
  for (const p of sim.players.values()) {
    if (!p.alive || p.hp >= C.WOUNDED_TRAIL_HP * C.MAX_HP) continue;
    p.dripT -= dt;
    if (p.dripT <= 0) {
      p.dripT = C.WOUNDED_DRIP_INTERVAL;
      normInto(-p.vx, -p.vy, _n); // trail behind movement; (0,0) if still
      const dx = _n[0], dy = _n[1];
      sim.emit({ t: 'splat', x: p.x, y: p.y, size: 0.18, dirX: dx, dirY: dy });
    }
  }

  // --- Fire zones: expire, then burn players inside on a per-player cadence --
  w = 0;
  for (let i = 0; i < sim.fires.length; i++) {
    const f = sim.fires[i];
    f.ttl -= dt;
    if (f.ttl <= 0) continue;
    sim.fires[w++] = f;
  }
  sim.fires.length = w;

  for (const p of sim.players.values()) {
    if (p.burnT > 0) p.burnT = Math.max(0, p.burnT - dt); // render after-burn flag
    if (!p.alive) {
      p.burnTick = 0;
      continue;
    }
    let inFire = false;
    for (const f of sim.fires) {
      const rr = f.r + C.BABO_RADIUS;
      if (distSq(p.x, p.y, f.x, f.y) < rr * rr) {
        inFire = true;
        break;
      }
    }
    if (!inFire) continue; // cadence timer only runs while standing in fire
    p.burnTick -= dt;
    if (p.burnTick <= 0) {
      p.burnTick = C.BURN_TICK;
      sim.damage(p, -1, C.FIRE_ZONE_DPS * C.BURN_TICK, 'world');
      p.burnT = 0.5;
      sim.emit({ t: 'burn', player: p.id });
    }
  }

  // --- Fire ignites pools. Removing the pool before spawning its fire stops
  // --- same-tick self-re-ignition; chains across DIFFERENT pools are desired
  // --- (newly spawned fires are visited too) and bounded by pool count. ------
  for (let i = 0; i < sim.fires.length; i++) {
    const f = sim.fires[i];
    for (let j = sim.pools.length - 1; j >= 0; j--) {
      const pool = sim.pools[j];
      const rr = f.r + pool.r;
      if (distSq(f.x, f.y, pool.x, pool.y) < rr * rr) {
        sim.pools.splice(j, 1);
        sim.emit({ t: 'poolGone', id: pool.id });
        sim.spawnFire(pool.x, pool.y, pool.r);
      }
    }
  }

  // --- Smokes: expire ---------------------------------------------------------
  w = 0;
  for (let i = 0; i < sim.smokes.length; i++) {
    const s = sim.smokes[i];
    s.ttl -= dt;
    if (s.ttl <= 0) continue;
    sim.smokes[w++] = s;
  }
  sim.smokes.length = w;
}
