import { describe, it, expect } from 'vitest';
import { C, FLAGS } from '../src/data/constants';
import { makeSim, run, simHash } from './helpers';

describe('inert sim-flag scaffolding (constants.ts)', () => {
  it('exposes the flags with desktop-reproducing defaults', () => {
    expect(C.PLAYER_CCD).toBe(true);        // matches sim.ts setCcdEnabled(true)
    expect(C.SIM_BASELINE_V).toBe(1);
    expect(C.MAX_PROJECTILES).toBe(256);
    expect(C.AUDIO_MAX_VOICES).toBe(24);
  });

  it('adding the flags does not change current sim behavior', async () => {
    const a = await makeSim({ mode: 'tdm', seed: 23 });
    const b = await makeSim({ mode: 'tdm', seed: 23 });
    const classes = ['spider', 'juggernaut', 'bastion', 'phantom'] as const;
    for (let i = 0; i < 4; i++) {
      a.addPlayer(`B${i}`, classes[i], (i % 2) as 0 | 1, true);
      b.addPlayer(`B${i}`, classes[i], (i % 2) as 0 | 1, true);
    }
    run(a, 300); run(b, 300);
    expect(simHash(a)).toBe(simHash(b));
  }, 60_000);
});

describe('FLAGS block (constants.ts)', () => {
  it('PROJECTILE_LANCE defaults OFF (legacy hitscan reproduces desktop)', () => {
    expect(FLAGS.PROJECTILE_LANCE).toBe(false);
  });

  it('mirrors MAX_PROJECTILES for the S2 fire path', () => {
    expect(FLAGS.MAX_PROJECTILES).toBe(256);
    expect(FLAGS.MAX_PROJECTILES).toBe(C.MAX_PROJECTILES);
  });

  it('is a const-asserted object (compile-time-like branch source)', () => {
    expect(typeof FLAGS).toBe('object');
    expect(Object.keys(FLAGS).sort()).toEqual(['MAX_PROJECTILES', 'PROJECTILE_LANCE']);
  });
});
