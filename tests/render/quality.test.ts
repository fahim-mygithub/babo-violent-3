// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { QUALITY, detectQuality, setTierOverride } from '../../src/render/quality';

describe('quality tier detection', () => {
  it('defaults to high in jsdom (no matchMedia/WebGL)', () => {
    expect(detectQuality().tier).toBe('high');
    expect(QUALITY.antialias).toBe(true);
    expect(QUALITY.maxPixelRatio).toBe(2);
  });
  it('classifies a coarse-pointer 8-core device as mid', () => {
    expect(detectQuality({ coarse: true, maxTouchPoints: 5, cores: 8 }).tier).toBe('mid');
  });
  it('classifies a coarse-pointer 4-core device as low', () => {
    expect(detectQuality({ coarse: true, maxTouchPoints: 5, cores: 4 }).tier).toBe('low');
  });
  it('setTierOverride mutates the live singleton in place', () => {
    setTierOverride('low');
    expect(QUALITY.tier).toBe('low');
    expect(QUALITY.antialias).toBe(false);
    setTierOverride('high'); // reset for other tests
  });
});
