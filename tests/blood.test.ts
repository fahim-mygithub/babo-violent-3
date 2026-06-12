import { describe, expect, it } from 'vitest';
import { C } from '../src/data/constants';
import type { GameEvent } from '../src/sim/types';
import { clearEvents, makeSim, run, teleport } from './helpers';

describe('blood system', () => {
  it('pool ages, shrinks only in the final 30%, and expires with poolGone', async () => {
    const sim = await makeSim();
    sim.spawnPool(0, 0, 1.2);
    expect(sim.pools.length).toBe(1);
    const pool = sim.pools[0];
    const id = pool.id;
    const r0 = pool.r;

    // No shrink during the first 70% of life
    run(sim, 30);
    expect(pool.r).toBe(r0);

    // Shrinks monotonically once inside the final 30%
    pool.age = pool.maxAge * 0.7;
    let prev = pool.r;
    for (let i = 0; i < 60; i++) {
      sim.step();
      expect(sim.pools[0].r).toBeLessThan(prev);
      prev = sim.pools[0].r;
    }
    expect(sim.pools.length).toBe(1);

    // Removed at maxAge with a poolGone event
    pool.age = pool.maxAge - sim.dt * 2;
    clearEvents(sim);
    run(sim, 5);
    expect(sim.pools.length).toBe(0);
    expect(sim.events.some((e) => e.t === 'poolGone' && e.id === id)).toBe(true);
  });

  it('sets inSlick while overlapping a pool and clears it after stepping out', async () => {
    const sim = await makeSim();
    const p = sim.addPlayer('A', 'spider', 0, false);
    run(sim, 1);
    sim.respawn(p);
    sim.spawnPool(0, 0, 1.2);

    teleport(sim, p.id, 0, 0);
    sim.step();
    expect(p.inSlick).toBe(true);

    teleport(sim, p.id, 0, -10);
    sim.step();
    expect(p.inSlick).toBe(false);
  });

  it('wounded players drip splats on a cadence; healthy players do not', async () => {
    const sim = await makeSim();
    const wounded = sim.addPlayer('W', 'spider', 0, false);
    const healthy = sim.addPlayer('H', 'spider', 1, false);
    run(sim, 1);
    sim.respawn(wounded);
    sim.respawn(healthy);
    teleport(sim, wounded.id, -5, 0);
    teleport(sim, healthy.id, 5, 0);
    wounded.hp = 20; // below C.WOUNDED_TRAIL_HP * C.MAX_HP = 35

    clearEvents(sim);
    run(sim, 60); // 1s → drips at t≈0, 0.45, 0.9
    const drips = sim.events.filter(
      (e): e is Extract<GameEvent, { t: 'splat' }> => e.t === 'splat' && e.size === 0.18,
    );
    expect(drips.length).toBeGreaterThanOrEqual(2);
    expect(drips.length).toBeLessThanOrEqual(4);
    // Every drip comes from the wounded player's side of the map
    for (const d of drips) expect(d.x).toBeLessThan(0);
  });

  it('fire zone burns players inside (~DPS) but not players outside', async () => {
    const sim = await makeSim();
    const inside = sim.addPlayer('I', 'spider', 0, false);
    const outside = sim.addPlayer('O', 'spider', 1, false);
    run(sim, 1);
    sim.respawn(inside);
    sim.respawn(outside);
    inside.invulnT = 0;
    outside.invulnT = 0;
    sim.spawnFire(0, 0, 2);
    teleport(sim, inside.id, 0, 0);
    teleport(sim, outside.id, 20, 0);

    clearEvents(sim);
    run(sim, 120); // 2s in the fire
    const dealt = C.MAX_HP - inside.hp;
    const expected = C.FIRE_ZONE_DPS * 2;
    expect(dealt).toBeGreaterThan(expected * 0.8);
    expect(dealt).toBeLessThan(expected * 1.2);
    expect(inside.burnT).toBeGreaterThan(0); // after-burn render flag
    expect(outside.hp).toBe(C.MAX_HP);
    expect(sim.events.some((e) => e.t === 'burn' && e.player === inside.id)).toBe(true);
    expect(sim.events.some((e) => e.t === 'burn' && e.player === outside.id)).toBe(false);
  });

  it('fire ignites an overlapping pool, converting it to a fire zone', async () => {
    const sim = await makeSim();
    sim.spawnPool(3, 0, 1.2);
    const poolId = sim.pools[0].id;
    sim.spawnFire(0, 0, 2); // dist 3 < 2 + 1.2 → overlap
    clearEvents(sim);
    sim.step();

    expect(sim.pools.length).toBe(0);
    expect(sim.fires.length).toBe(2);
    expect(sim.events.some((e) => e.t === 'poolGone' && e.id === poolId)).toBe(true);
    expect(sim.events.some((e) => e.t === 'fireIgnite' && e.x === 3)).toBe(true);
    const newFire = sim.fires.find((f) => f.x === 3 && f.y === 0);
    expect(newFire?.r).toBeCloseTo(1.2);
  });

  it('ignition chains across different pools within one tick', async () => {
    const sim = await makeSim();
    sim.spawnPool(3, 0, 1.2);
    sim.spawnPool(5, 0, 1.2); // overlaps the first pool's fire, not the original
    sim.spawnFire(0, 0, 2);
    sim.step();

    expect(sim.pools.length).toBe(0);
    expect(sim.fires.length).toBe(3);
  });

  it('smoke zones expire when ttl runs out', async () => {
    const sim = await makeSim();
    sim.smokes.push({ id: sim.newId(), x: 0, y: 0, r: C.SMOKE_RADIUS, ttl: 0.5 });
    run(sim, 15); // 0.25s — still alive
    expect(sim.smokes.length).toBe(1);
    run(sim, 25); // past 0.5s total
    expect(sim.smokes.length).toBe(0);
  });
});
