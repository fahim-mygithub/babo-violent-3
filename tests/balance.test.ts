import { describe, it, expect } from 'vitest';
import { makeSim } from './helpers';
import { FLAGS } from '../src/data/constants';
import { ALL_CLASS_IDS } from '../src/data/classes';
import type { GunId } from '../src/data/weapons';

// Balance probe — a decision aid, NOT a phase gate (S8.3). Gated behind BALANCE=1
// so it never runs in the normal suite / CI (npm test). projectileLance default-on
// is an out-of-band balance decision; this probe just prints a per-gun kill table.
const RUN = process.env.BALANCE === '1';
const d = RUN ? describe : describe.skip;

const GUNS_UNDER_TEST: GunId[] = [
  'stinger', 'workhorse', 'maw', 'hurricane', 'thumper', 'ion', 'lance', 'pyre',
];

d('Lance balance probe (BALANCE=1)', () => {
  it('flag-ON: no gun wildly dominates kill-share over 16 seeds', async () => {
    const prev = FLAGS.PROJECTILE_LANCE;
    (FLAGS as { PROJECTILE_LANCE: boolean }).PROJECTILE_LANCE = true;
    try {
      const kills: Record<string, number> = {};
      for (const g of GUNS_UNDER_TEST) kills[g] = 0; // ensure every gun is keyed
      for (let seed = 1; seed <= 16; seed++) {
        const sim = await makeSim({ mode: 'bounty', seed });
        // 8 bots, one per gun, forced via addPlayer's gun param (persists across respawn).
        GUNS_UNDER_TEST.forEach((g, i) =>
          sim.addPlayer(`B${i}`, ALL_CLASS_IDS[i % ALL_CLASS_IDS.length], -1, true, g));
        for (let t = 0; t < 3600; t++) {
          sim.step();
          for (const e of sim.events) {
            if (e.t === 'death' && e.gun !== 'world') kills[e.gun] = (kills[e.gun] ?? 0) + 1;
          }
          sim.events.length = 0;
        }
      }
      const vals = Object.values(kills);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      for (const [g, v] of Object.entries(kills)) {
        // eslint-disable-next-line no-console
        console.log(`gun ${g}: ${v} kills`); // human decision aid
        expect(v).toBeLessThanOrEqual(mean * 2.5); // loose band — not a phase gate
      }
    } finally {
      (FLAGS as { PROJECTILE_LANCE: boolean }).PROJECTILE_LANCE = prev;
    }
  }, 120_000);
});
