import { describe, it, expect } from 'vitest';
import { makeSim, run, teleport } from '../helpers';
import { C } from '../../src/data/constants';

describe('CCD removal — interior wall does not tunnel under high impulse', () => {
  it('a thumper blast against a thin interior wall does not pop the victim through it', async () => {
    const sim = await makeSim({ mode: 'tdm', seed: 99 });
    const wall = { x: -12, y: -8, w: 5, h: 1.2 }; // maps.ts:63 mid-field lane breaker
    const a = sim.addPlayer('A', 'spider', 0, false, 'thumper');
    const v = sim.addPlayer('V', 'spider', 1, false);
    run(sim, 2);
    // Pin the victim just on the +y side of the wall's top face; shooter above it.
    const victimY = wall.y + wall.h / 2 + 0.5;   // touching the wall's top edge from above
    teleport(sim, v.id, wall.x, victimY);
    teleport(sim, a.id, wall.x, victimY + 1.5);
    v.invulnT = 0; a.spawnProt = false;
    // Detonate a frag-class blast right on the victim (rocket explode path applies impulse pre-step).
    sim.explode(v.x, v.y - 0.1, C.FRAG_RADIUS, C.FRAG_DAMAGE, C.FRAG_IMPULSE, a.id, 'rocket', 'thumper');
    for (let i = 0; i < 30; i++) sim.step(); // let the impulse integrate
    // The victim must stay on the +y side of the wall's top face — never tunnel to y < wall bottom.
    expect(v.y).toBeGreaterThan(wall.y - wall.h / 2 - 0.1);
  }, 30_000);
});
