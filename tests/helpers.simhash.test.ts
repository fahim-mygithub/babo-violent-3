import { describe, it, expect } from 'vitest';
import { makeSim, run, simHash } from './helpers';

async function twinSim(seed: number) {
  const sim = await makeSim({ mode: 'tdm', seed });
  const classes = ['spider', 'juggernaut', 'bastion', 'phantom'] as const;
  for (let i = 0; i < 4; i++) sim.addPlayer(`Bot${i}`, classes[i], (i % 2) as 0 | 1, true);
  return sim;
}

describe('simHash', () => {
  it('returns a stable hex string', async () => {
    const sim = await twinSim(23);
    run(sim, 100);
    expect(simHash(sim)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is identical for two same-seed instances at the same tick', async () => {
    const a = await twinSim(23);
    const b = await twinSim(23);
    for (let i = 0; i < 600; i++) {
      a.step(); b.step();
      a.events.length = 0; b.events.length = 0;
    }
    expect(simHash(a)).toBe(simHash(b));
  }, 60_000);

  it('changes when a single player float is perturbed', async () => {
    const sim = await twinSim(23);
    run(sim, 50);
    const before = simHash(sim);
    sim.players.get(0)!.x += 1e-6;
    expect(simHash(sim)).not.toBe(before);
  });

  it('covers smoke zones (LOS-affecting, so determinism-relevant)', async () => {
    const sim = await twinSim(23);
    run(sim, 50);
    const before = simHash(sim);
    // Smoke blocks GameSim.hasLOS → bot targeting → determinism.
    sim.smokes.push({ id: sim.newId(), x: 1, y: 2, r: 2.8, ttl: 8 });
    expect(simHash(sim)).not.toBe(before);
  });

  it('covers pickups (respawn/loot timing affects behavior)', async () => {
    const sim = await twinSim(23);
    run(sim, 50);
    const before = simHash(sim);
    // Pickups exist from map node init; perturbing a numeric field must shift the hash.
    // (node pickups have ttl=Infinity, so perturb a finite field instead.)
    sim.pickups[0]!.x += 1e-6;
    expect(simHash(sim)).not.toBe(before);
  });

  it('covers the CTF flag state discriminant', async () => {
    const sim = await makeSim({ mode: 'ctf', seed: 7 });
    const classes = ['spider', 'juggernaut', 'bastion', 'phantom'] as const;
    for (let i = 0; i < 4; i++) sim.addPlayer(`Bot${i}`, classes[i], (i % 2) as 0 | 1, true);
    run(sim, 50);
    const before = simHash(sim);
    // state ('base'|'carried'|'dropped') is gameplay-affecting but not otherwise numeric.
    sim.mode.flags[0]!.state = sim.mode.flags[0]!.state === 'base' ? 'carried' : 'base';
    expect(simHash(sim)).not.toBe(before);
  });
});
