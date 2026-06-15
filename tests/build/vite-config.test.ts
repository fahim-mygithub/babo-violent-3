import { describe, it, expect } from 'vitest';
import config from '../../vite.config';

// vite.config exports the result of defineConfig (a plain object here).
describe('vite build config — bundle deferral', () => {
  it('splits three/peerjs into manual chunks and never manual-chunks Rapier', () => {
    const c = config as any;
    expect(c.build.assetsInlineLimit).toBe(0);
    const mc = c.build.rollupOptions.output.manualChunks;
    expect(mc.three).toEqual(['three']);
    expect(mc.peerjs).toEqual(['peerjs']);
    // Rapier (rapier2d-compat) is dynamic-imported by initPhysics(), so rollup
    // emits it as its own deferred async chunk. Forcing a manual chunk would risk
    // hoisting its inlined WASM toward the entry — never manual-chunk it.
    expect(mc.rapier).toBeUndefined();
  });
});
