// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as THREE from 'three';
import { EffectsLayer } from '../../src/render/effects';

// jsdom ships no 2D canvas, so makeGlowTexture()'s createRadialGradient throws on
// a null context — stub getContext('2d'). document.hidden is already `false`, so
// handleEvent() never early-returns.
function ctx2dStub() {
  return {
    createRadialGradient: () => ({ addColorStop: () => {} }),
    fillRect: () => {}, fillStyle: '', getImageData: () => ({ data: [] }),
    save: () => {}, restore: () => {}, beginPath: () => {}, arc: () => {},
    fill: () => {}, moveTo: () => {}, lineTo: () => {}, stroke: () => {},
    closePath: () => {}, translate: () => {}, quadraticCurveTo: () => {},
    strokeRect: () => {}, globalAlpha: 1, strokeStyle: '', lineWidth: 1,
  };
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    ctx2dStub() as unknown as CanvasRenderingContext2D,
  );
});

describe('particle record pooling', () => {
  it('does not grow the particle-record pool unboundedly across burst/expire cycles', () => {
    const scene = new THREE.Scene();
    const fx = new EffectsLayer(scene);
    // Cycle: spawn a burst, then run update long enough to expire it, many times.
    for (let cycle = 0; cycle < 50; cycle++) {
      fx.handleEvent({ t: 'hit', target: 0, attacker: 1, damage: 10, x: 0, y: 0 } as never);
      for (let f = 0; f < 60; f++) fx.update(1 / 60); // 1s — well past the 0.35s life
    }
    const pool = (fx as unknown as { particlePool: unknown[] }).particlePool;
    // After steady state, recycled records are bounded by the largest single burst,
    // not 50× (each 'hit' burst is ≤5 particles).
    expect(pool.length).toBeLessThanOrEqual(40);
    expect((fx as unknown as { particles: unknown[] }).particles.length).toBe(0);
  });

  it('recycles a record on the next burst instead of allocating a fresh one', () => {
    const scene = new THREE.Scene();
    const fx = new EffectsLayer(scene);
    // Burst once, expire it → its record goes to the pool.
    fx.handleEvent({ t: 'hit', target: 0, attacker: 1, damage: 10, x: 0, y: 0 } as never);
    for (let f = 0; f < 60; f++) fx.update(1 / 60);
    const pool = (fx as unknown as { particlePool: { obj: unknown }[] }).particlePool;
    expect(pool.length).toBeGreaterThan(0);
    const before = pool.length;
    // Next burst should DRAIN the pool (reuse), not leave it untouched.
    fx.handleEvent({ t: 'hit', target: 0, attacker: 1, damage: 10, x: 0, y: 0 } as never);
    expect(pool.length).toBeLessThan(before);
  });
});
