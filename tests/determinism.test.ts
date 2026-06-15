import { describe, it, expect } from 'vitest';
import type { GameSim } from '../src/sim/sim';
import { makeSim, simHash } from './helpers';

function seedBots(sim: GameSim, n: number, ffa: boolean): void {
  const classes = ['spider', 'juggernaut', 'bastion', 'phantom', 'trapper'] as const;
  for (let i = 0; i < n; i++) {
    sim.addPlayer(`Bot${i}`, classes[i % classes.length], ffa ? -1 : ((i % 2) as 0 | 1), true);
  }
}

function hashesAt(sim: GameSim, marks: number[]): Record<number, string> {
  const out: Record<number, string> = {};
  const want = new Set(marks);
  const max = Math.max(...marks);
  for (let t = 1; t <= max; t++) {
    sim.step();
    sim.events.length = 0;
    if (want.has(t)) out[t] = simHash(sim);
  }
  return out;
}

const MARKS = [300, 600, 1200];
const CASES = [
  { mode: 'tdm' as const, seed: 23, bots: 6, ffa: false },
  { mode: 'bounty' as const, seed: 11, bots: 6, ffa: true },
  { mode: 'ctf' as const, seed: 7, bots: 6, ffa: false },
];

describe('determinism golden guard', () => {
  it.each(CASES)('same seed → identical simHash across instances ($mode/$seed)', async (c) => {
    const a = await makeSim({ mode: c.mode, seed: c.seed });
    const b = await makeSim({ mode: c.mode, seed: c.seed });
    seedBots(a, c.bots, c.ffa);
    seedBots(b, c.bots, c.ffa);
    expect(hashesAt(a, MARKS)).toEqual(hashesAt(b, MARKS));
  }, 60_000);

  it.each(CASES)('frozen golden hashes at ticks 300/600/1200 ($mode/$seed)', async (c) => {
    const sim = await makeSim({ mode: c.mode, seed: c.seed });
    seedBots(sim, c.bots, c.ffa);
    expect(hashesAt(sim, MARKS)).toMatchSnapshot();
  }, 60_000);
});
