// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { viewportSize, onViewportChange } from '../../src/core/viewport';

describe('viewport bus', () => {
  it('viewportSize falls back to innerWidth/Height when visualViewport is absent', () => {
    (window as any).visualViewport = undefined;
    (window as any).innerWidth = 412;
    (window as any).innerHeight = 915;
    expect(viewportSize()).toEqual({ w: 412, h: 915 });
  });

  it('prefers visualViewport dimensions when present', () => {
    (window as any).visualViewport = { width: 390, height: 700, addEventListener() {}, removeEventListener() {} };
    expect(viewportSize()).toEqual({ w: 390, h: 700 });
  });

  it('onViewportChange returns an unsubscribe and fires the callback on resize (rAF-coalesced)', async () => {
    (window as any).visualViewport = undefined;
    const cb = vi.fn();
    const off = onViewportChange(cb);
    window.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('resize')); // coalesced into one
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    window.dispatchEvent(new Event('resize'));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(cb).toHaveBeenCalledTimes(1); // no fire after unsubscribe
  });
});
