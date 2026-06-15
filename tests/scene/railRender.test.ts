// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { deadReckon } from '../../src/render/effects';

describe('rail dead-reckoning', () => {
  it('extrapolates along vx,vy clamped to 50ms', () => {
    const p = deadReckon({ x: 0, y: 0, vx: 110, vy: 0 }, 0.03); // 30ms
    expect(p.x).toBeCloseTo(110 * 0.03, 6);
    expect(p.y).toBeCloseTo(0, 6);
    const clamped = deadReckon({ x: 0, y: 0, vx: 110, vy: 0 }, 0.2); // >50ms → clamp
    expect(clamped.x).toBeCloseTo(110 * 0.05, 6);
  });

  it('extrapolates on both axes from the last snapshot position', () => {
    const p = deadReckon({ x: 5, y: -2, vx: 0, vy: 80 }, 0.04); // 40ms, < clamp
    expect(p.x).toBeCloseTo(5, 6);
    expect(p.y).toBeCloseTo(-2 + 80 * 0.04, 6);
  });
});
