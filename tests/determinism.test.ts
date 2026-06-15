import { afterEach, describe, it, expect } from 'vitest';
import type { GameSim } from '../src/sim/sim';
import { makeSim, simHash } from './helpers';
import { FLAGS } from '../src/data/constants';

function seedBots(sim: GameSim, n: number, ffa: boolean): void {
  const classes = ['spider', 'juggernaut', 'bastion', 'phantom', 'trapper'] as const;
  for (let i = 0; i < n; i++) {
    sim.addPlayer(`Bot${i}`, classes[i % classes.length], ffa ? -1 : ((i % 2) as 0 | 1), true);
  }
}

/** Seed an all-Lance FFA so FLAGS.PROJECTILE_LANCE actually changes behavior. */
function seedLanceBots(sim: GameSim, n: number): void {
  const classes = ['spider', 'juggernaut', 'bastion', 'phantom', 'trapper'] as const;
  for (let i = 0; i < n; i++) {
    sim.addPlayer(`Bot${i}`, classes[i % classes.length], -1, true, 'lance');
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

// S2.8: flag-ON is a DISTINCT RNG stream — it gets its OWN golden hash. We NEVER
// assert any relationship between flag-ON and flag-OFF hashes; flag-OFF must equal
// its pre-change baseline, flag-ON must be internally (cross-instance) deterministic.
describe('lance projectile determinism (S2.8)', () => {
  const prev = FLAGS.PROJECTILE_LANCE;
  afterEach(() => { (FLAGS as { PROJECTILE_LANCE: boolean }).PROJECTILE_LANCE = prev; });

  it('flag-OFF all-Lance run matches its own frozen baseline (legacy hitscan)', async () => {
    (FLAGS as { PROJECTILE_LANCE: boolean }).PROJECTILE_LANCE = false;
    const sim = await makeSim({ mode: 'bounty', seed: 17 });
    seedLanceBots(sim, 8);
    expect(hashesAt(sim, MARKS)).toMatchSnapshot('lance-flag-off');
  }, 60_000);

  it('flag-ON all-Lance run is cross-instance deterministic + has its OWN golden hash', async () => {
    (FLAGS as { PROJECTILE_LANCE: boolean }).PROJECTILE_LANCE = true;
    const a = await makeSim({ mode: 'bounty', seed: 17 });
    const b = await makeSim({ mode: 'bounty', seed: 17 });
    seedLanceBots(a, 8);
    seedLanceBots(b, 8);
    const ha = hashesAt(a, MARKS);
    const hb = hashesAt(b, MARKS);
    expect(ha).toEqual(hb); // baseline-free per-seed determinism
    expect(ha).toMatchSnapshot('lance-flag-on'); // its own golden baseline
  }, 60_000);
});
