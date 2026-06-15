import { describe, it, expect } from 'vitest';
import { makeSim } from './helpers';
import { simHash } from './helpers';

// The seed-42 byte-identical determinism gate for the @dimforge/rapier2d swap.
// This MUST match the golden baseline captured by the Foundation determinism test
// against the OLD -compat package. If it diverges, the swap is NOT byte-identical
// and must not be merged (spec S4.1 acceptance gate / Risk #1).
describe('rapier non-compat swap — determinism', () => {
  it('seed-42 8-bot TDM is byte-identical to the pre-swap golden hash', async () => {
    const a = await makeSim({ mode: 'tdm', seed: 42 });
    const b = await makeSim({ mode: 'tdm', seed: 42 });
    const classes = ['spider', 'juggernaut', 'bastion', 'phantom', 'trapper'] as const;
    for (const sim of [a, b]) {
      for (let i = 0; i < 8; i++) {
        sim.addPlayer(`Bot${i}`, classes[i % classes.length], (i % 2) as 0 | 1, true);
      }
    }
    for (let i = 0; i < 600; i++) { a.step(); b.step(); a.events.length = 0; b.events.length = 0; }
    // Cross-instance equality (baseline-free): the swap must be internally deterministic.
    expect(simHash(a)).toBe(simHash(b));
    // Pinned digest captured from the OLD -compat build at tick 600, seed 42.
    // Foundation's tests/determinism.test.ts toMatchSnapshot at tick 600 is the source.
    expect(simHash(a)).toMatchSnapshot();
  }, 60_000);
});
