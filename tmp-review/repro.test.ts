/**
 * Adversarial review repros (throwaway — tmp-review/).
 * Run: npx vitest run tmp-review/repro.test.ts
 */
import { describe, expect, it } from 'vitest';
import { GameSim, initPhysics } from '../src/sim/sim';
import { emptyInput, type PlayerInput } from '../src/sim/types';
import { C } from '../src/data/constants';
import type { ClassId } from '../src/data/classes';

async function makeSim(mode: 'tdm' | 'bounty' | 'ctf' = 'tdm'): Promise<GameSim> {
  await initPhysics();
  return new GameSim({ mapId: 'grinder', mode, seed: 42 });
}

function input(partial: Partial<PlayerInput>): PlayerInput {
  return { ...emptyInput(), ...partial };
}

describe('A: unvalidated net input poisons the authoritative sim', () => {
  it('NaN mx in PlayerInput turns player position into NaN', async () => {
    const sim = await makeSim();
    const p = sim.addPlayer('victim', 'spider', 0, false);
    sim.step(); // respawn (respawnT 0.01)
    expect(p.alive).toBe(true);

    // host.ts onMsg('input') performs no field validation before buffering;
    // applyInputs() passes the raw object into sim.setInput().
    sim.setInput(p.id, input({ mx: NaN, my: 0, seq: 1 }));
    for (let i = 0; i < 3; i++) sim.step();

    // If this holds, every subsequent snapshot broadcast is poisoned.
    expect(Number.isNaN(p.x)).toBe(true);
  });

