// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as THREE from 'three';
import { EffectsLayer } from '../../src/render/effects';

// jsdom ships no 2D canvas, so makeGlowTexture()'s createRadialGradient would
// throw on a null context. Stub getContext('2d') with a minimal no-op surface so
// EffectsLayer constructs against a real THREE.Scene and we can assert that the
// pooled ring/beam geometry is reused (one shared geometry across many events).
// document.hidden is already `false` in jsdom, so handleEvent() never early-returns.
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

describe('effects pooled geometry', () => {
  it('reuses one shared ring geometry across many explosion rings', () => {
    const scene = new THREE.Scene();
    const fx = new EffectsLayer(scene);
    const geos = new Set<THREE.BufferGeometry>();
    // 30 explosions → 30 ring()s; all must share ONE geometry instance.
    for (let i = 0; i < 30; i++) {
      fx.handleEvent({ t: 'explosion', x: i, y: 0, r: 2, kind: 'rocket' } as never);
    }
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      // The ctor's arcLanding is also a RingGeometry; isolate the explosion rings
      // (inner radius 0.8) so the assertion is about the pooled VFX ring only.
      const g = m.geometry as THREE.RingGeometry | undefined;
      if (m.isMesh && g?.type === 'RingGeometry' && g.parameters.innerRadius === 0.8) geos.add(g);
    });
    expect(geos.size).toBe(1);
  });

  it('reuses one shared beam geometry across many rail events', () => {
    const scene = new THREE.Scene();
    const fx = new EffectsLayer(scene);
    const geos = new Set<THREE.BufferGeometry>();
    for (let i = 0; i < 20; i++) {
      fx.handleEvent({ t: 'rail', x0: 0, y0: 0, x1: i + 1, y1: 0, owner: 0 } as never);
    }
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry?.type === 'BoxGeometry') geos.add(m.geometry);
    });
    expect(geos.size).toBe(1);
  });
});
