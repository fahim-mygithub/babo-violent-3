// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { phaseTransition } from '../../src/render/babos';
import { makeBaboMaterial } from '../../src/render/baboShader';
import { setTierOverride } from '../../src/render/quality';

afterEach(() => setTierOverride('high'));

describe('babo body transparency gating', () => {
  it('turns transparent on at phase-in and off at phase-out', () => {
    expect(phaseTransition(true, false)).toBe(true);   // entering phase
    expect(phaseTransition(false, true)).toBe(false);  // leaving phase
  });
  it('returns null (no change) when phase state is unchanged', () => {
    expect(phaseTransition(true, true)).toBeNull();
    expect(phaseTransition(false, false)).toBeNull();
  });
});

// Desktop byte-identity (finding 8): main built the babo body material
// transparent:true. Keep that on high so the desktop render-pass ordering is
// unchanged; only the mobile tiers go opaque-by-default (the perf win).
describe('babo body material transparent default is tier-gated', () => {
  it('high tier builds the body transparent (parity with main)', () => {
    setTierOverride('high');
    expect(makeBaboMaterial(0x808080).transparent).toBe(true);
  });
  it('mid + low tiers build the body opaque by default (phase gating flips it)', () => {
    setTierOverride('mid');
    expect(makeBaboMaterial(0x808080).transparent).toBe(false);
    setTierOverride('low');
    expect(makeBaboMaterial(0x808080).transparent).toBe(false);
  });
});
