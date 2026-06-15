import { describe, it, expect } from 'vitest';
import config from '../../vite.config';

// vite.config exports the result of defineConfig (a plain object here).
describe('vite build config — bundle deferral', () => {
  it('never re-inlines the WASM and splits three/peerjs/rapier into manual chunks', () => {
    const c = config as any;
    expect(c.build.assetsInlineLimit).toBe(0);
    const mc = c.build.rollupOptions.output.manualChunks;
    expect(mc.three).toEqual(['three']);
    expect(mc.peerjs).toEqual(['peerjs']);
    expect(mc.rapier).toEqual(['@dimforge/rapier2d']);
  });
});
