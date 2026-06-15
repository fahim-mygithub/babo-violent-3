import { describe, it, expect } from 'vitest';
import { norm, normInto } from '../../src/core/math';

describe('normInto — zero-alloc sibling of norm', () => {
  it('matches norm() bit-for-bit across vectors', () => {
    for (const [x, y] of [[3, 4], [-7, 0], [0, 0], [1e-12, 1e-12], [-0.3, 0.91]]) {
      const out: [number, number] = [NaN, NaN];
      normInto(x, y, out);
      expect(out).toEqual(norm(x, y));
    }
  });
  it('returns the SAME array instance (no per-call alloc)', () => {
    const out: [number, number] = [0, 0];
    const r = normInto(5, 12, out);
    expect(r).toBe(out);
  });
});
