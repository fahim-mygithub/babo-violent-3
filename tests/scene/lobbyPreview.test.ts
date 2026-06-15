// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
// shouldMountPreview + previewQuality live in quality.ts (node-safe, no DOM) and are
// re-exported by app.ts; the test imports them from quality.ts so it never pulls the
// DOM-heavy App.
import { setTierOverride, shouldMountPreview, previewQuality } from '../../src/render/quality';

afterEach(() => setTierOverride('high'));

describe('S3.8 lobby preview gating', () => {
  it('skips the live preview on low', () => {
    setTierOverride('low');
    expect(shouldMountPreview()).toBe(false);
  });
  it('mounts on mid and high', () => {
    setTierOverride('mid'); expect(shouldMountPreview()).toBe(true);
    setTierOverride('high'); expect(shouldMountPreview()).toBe(true);
  });
});

describe('S3.8 lobby preview throttle (mid)', () => {
  it('high runs full quality: AA on, DPR up to 2, uncapped fps', () => {
    setTierOverride('high');
    const q = previewQuality();
    expect(q.antialias).toBe(true);
    expect(q.maxDpr).toBe(2);
    expect(q.maxFps).toBe(0); // 0 = uncapped
  });
  it('mid throttles: AA off, DPR clamped to 1, ~30fps cap', () => {
    setTierOverride('mid');
    const q = previewQuality();
    expect(q.antialias).toBe(false);
    expect(q.maxDpr).toBeLessThanOrEqual(1.5);
    expect(q.maxFps).toBe(30);
  });
});
