import { describe, expect, it } from 'vitest';
import { makeSim, run } from './helpers';

describe('sim skeleton', () => {
  it('boots, adds players, and steps without error', async () => {
    const sim = await makeSim();
    const a = sim.players.get(sim.addPlayer('A', 'spider', 0, false).id)!;
    const b = sim.players.get(sim.addPlayer('B', 'juggernaut', 1, true).id)!;
    run(sim, 10);
    expect(sim.tick).toBe(10);
    expect(a.id).not.toBe(b.id);
    expect(sim.map.walls.length).toBeGreaterThan(4);
  });

  it('kill drops loot, pops, and is recorded', async () => {
    const sim = await makeSim();
    const a = sim.addPlayer('A', 'spider', 0, false);
    const v = sim.addPlayer('V', 'phantom', 1, false);
    run(sim, 1);
    // both spawned via respawnT=0.01 → need a respawn pass (modeSystem not yet
    // implemented), so respawn manually for the skeleton smoke test
    sim.respawn(a);
    sim.respawn(v);
    v.invulnT = 0;
    a.spawnProt = false; // spawn protection also blocks dealing damage
    sim.damage(v, a.id, 999, 'stinger');
    expect(v.alive).toBe(false);
    expect(sim.pickups.some((p) => p.kind === 'gun')).toBe(true);
    expect(sim.pickups.some((p) => p.kind === 'health' && p.nodeIdx === -1)).toBe(true);
    expect(sim.pools.length).toBeGreaterThan(0);
    expect(sim.events.some((e) => e.t === 'pop')).toBe(true);
    expect(sim.deathsThisTick.length).toBe(1);
  });
});
