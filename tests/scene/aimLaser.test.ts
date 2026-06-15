// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { laserLength } from '../../src/render/aimLaser';

const walls = [{ x: 5, y: 0, w: 1, h: 4 }]; // wall face at x≈4.5

describe('laserLength', () => {
  it('clamps to the first wall along aim', () => {
    // from (0,0) aim +x, max 40 → wall at ~4.5
    const len = laserLength(0, 0, 0, 40, walls);
    expect(len).toBeGreaterThan(4);
    expect(len).toBeLessThan(5);
  });
  it('returns full length when no wall is hit', () => {
    const len = laserLength(0, 0, Math.PI, 40, walls); // aim -x, no wall
    expect(len).toBeCloseTo(40, 6);
  });
});
