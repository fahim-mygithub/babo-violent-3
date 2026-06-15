// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { setTierOverride, QUALITY } from '../../src/render/quality';
import { scaledBurstCount } from '../../src/render/effects';

afterEach(() => setTierOverride('high'));

describe('S3.7 particle tiering', () => {
  it('scales a burst count by particleScale but never below 1', () => {
    setTierOverride('low'); // particleScale 0.4
    expect(scaledBurstCount(10)).toBe(Math.max(1, Math.round(10 * QUALITY.particleScale)));
    expect(scaledBurstCount(1)).toBeGreaterThanOrEqual(1);
  });
  it('high keeps the literal count', () => {
    setTierOverride('high'); // particleScale 1
    expect(scaledBurstCount(16)).toBe(16);
  });
  it('mid scales between (particleScale 0.65)', () => {
    setTierOverride('mid');
    expect(scaledBurstCount(16)).toBe(Math.round(16 * 0.65));
  });
});

describe('S3.6 quality knobs', () => {
  it('high keeps todays literals (2048 splat / 600 cap / 7 fire / 6 smoke)', () => {
    setTierOverride('high');
    expect(QUALITY.splatRtSize).toBe(2048);
    expect(QUALITY.particleCap).toBe(600);
    expect(QUALITY.fireSprites).toBe(7);
    expect(QUALITY.smokeSprites).toBe(6);
  });
  it('mobile shrinks the splat RT to 1024 and trims fire/smoke', () => {
    setTierOverride('low');
    expect(QUALITY.splatRtSize).toBe(1024);
    expect(QUALITY.fireSprites).toBe(3);
    expect(QUALITY.smokeSprites).toBe(3);
    setTierOverride('mid');
    expect(QUALITY.splatRtSize).toBe(1024);
    expect(QUALITY.fireSprites).toBe(5);
    expect(QUALITY.smokeSprites).toBe(4);
  });
});
