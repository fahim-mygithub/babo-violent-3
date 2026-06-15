import { describe, it, expect } from 'vitest';
import { C } from '../../src/data/constants';

describe('SIM_BASELINE_V D-SHIFT bundle flags', () => {
  it('exposes the baseline version + CCD flags for replay reproducibility', () => {
    expect(typeof C.SIM_BASELINE_V).toBe('number');
    expect(typeof C.PLAYER_CCD).toBe('boolean');
    expect(C.PLAYER_CCD).toBe(false); // CCD dropped behind the flag for the mobile floor
  });
});
