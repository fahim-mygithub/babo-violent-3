// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FixedLoop } from '../../src/core/loop';

// jsdom backs requestAnimationFrame with its own setInterval(cb, 16.67); stub rAF
// to a no-op so the setInterval spy observes ONLY the loop's keep-alive interval.
const origRaf = window.requestAnimationFrame;
beforeEach(() => { window.requestAnimationFrame = (_cb: FrameRequestCallback): number => 0; });
afterEach(() => { window.requestAnimationFrame = origRaf; });

describe('FixedLoop background interval gating', () => {
  it('installs no hidden-tab interval when keepAliveWhenHidden is false (default)', () => {
    const spy = vi.spyOn(window, 'setInterval');
    const loop = new FixedLoop(60, () => {}, () => {});
    loop.start();
    expect(spy).not.toHaveBeenCalled();
    loop.stop(); spy.mockRestore();
  });
  it('installs the interval only when keepAliveWhenHidden is true', () => {
    const spy = vi.spyOn(window, 'setInterval');
    const loop = new FixedLoop(60, () => {}, () => {}, 5, true);
    loop.start();
    expect(spy).toHaveBeenCalled();
    loop.stop(); spy.mockRestore();
  });
});
