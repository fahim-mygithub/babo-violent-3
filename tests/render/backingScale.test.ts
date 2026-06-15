// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { setTierOverride, canvasBackingScale } from '../../src/render/quality';

afterEach(() => setTierOverride('high'));

// Desktop byte-identity (finding 7): the 2D HUD / screen-fx canvases must render
// at 1x backing store on desktop (like main) so HiDPI desktops are pixel-identical;
// only the mobile tiers get the crisp DPR-scaled backing store.
describe('canvasBackingScale (HUD / screen-fx 2D canvas DPR gate)', () => {
  it('returns 1 on desktop (high tier) regardless of devicePixelRatio', () => {
    setTierOverride('high'); // isMobile = false
    (window as any).devicePixelRatio = 3;
    expect(canvasBackingScale()).toBe(1);
  });

  it('returns min(devicePixelRatio, 2) on mobile tiers (crisp, capped at 2)', () => {
    setTierOverride('mid'); // isMobile = true
    (window as any).devicePixelRatio = 3;
    expect(canvasBackingScale()).toBe(2); // capped
    (window as any).devicePixelRatio = 1.5;
    expect(canvasBackingScale()).toBe(1.5);
    setTierOverride('low');
    (window as any).devicePixelRatio = 4;
    expect(canvasBackingScale()).toBe(2);
  });
});
