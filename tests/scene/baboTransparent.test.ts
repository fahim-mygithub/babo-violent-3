// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { phaseTransition } from '../../src/render/babos';

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
