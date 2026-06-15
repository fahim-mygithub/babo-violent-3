// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import * as THREE from 'three';
import { setTierOverride } from '../../src/render/quality';
import { surfaceMat } from '../../src/render/surfaceMat';

afterEach(() => setTierOverride('high'));

describe('surfaceMat', () => {
  it('high returns a MeshStandardMaterial preserving the map', () => {
    setTierOverride('high');
    const map = new THREE.Texture();
    const m = surfaceMat({ map, roughness: 0.9, metalness: 0.1 });
    expect(m).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect((m as THREE.MeshStandardMaterial).map).toBe(map);
  });
  it('mid returns a MeshLambertMaterial keeping map/opacity/transparent', () => {
    setTierOverride('mid');
    const map = new THREE.Texture();
    const m = surfaceMat({ map, transparent: true, opacity: 0.5 });
    expect(m).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect((m as THREE.MeshLambertMaterial).map).toBe(map);
    expect(m.transparent).toBe(true);
    expect(m.opacity).toBe(0.5);
  });
  it('low returns a MeshBasicMaterial folding emissive into color', () => {
    setTierOverride('low');
    const m = surfaceMat({ color: 0x000000, emissive: 0x40ff40 });
    expect(m).toBeInstanceOf(THREE.MeshBasicMaterial);
    // emissive folded → color is non-black (the glow color shows through)
    expect((m as THREE.MeshBasicMaterial).color.getHex()).toBeGreaterThan(0);
  });

  it('high-tier surfaceMat for a floor-like input is Standard (desktop unchanged)', () => {
    setTierOverride('high');
    const m = surfaceMat({ map: new THREE.Texture(), roughness: 0.92 });
    expect(m.type).toBe('MeshStandardMaterial');
  });
  it('low-tier surfaceMat for a pit-like input is Basic', () => {
    setTierOverride('low');
    const m = surfaceMat({ color: 0x14080a, roughness: 0.6 });
    expect(m.type).toBe('MeshBasicMaterial');
  });

  it('high drops nothing — metalness/roughness preserved on the original Standard', () => {
    setTierOverride('high');
    const m = surfaceMat({ color: 0x445566, roughness: 0.7, metalness: 0.25 }) as THREE.MeshStandardMaterial;
    expect(m.roughness).toBe(0.7);
    expect(m.metalness).toBe(0.25);
  });

  it('mid/low DROP metalness/roughness (no such props on Lambert/Basic)', () => {
    setTierOverride('mid');
    const mid = surfaceMat({ color: 0x445566, roughness: 0.7, metalness: 0.25 });
    expect((mid as unknown as { metalness?: number }).metalness).toBeUndefined();
    setTierOverride('low');
    const low = surfaceMat({ color: 0x445566, roughness: 0.7, metalness: 0.25 });
    expect((low as unknown as { metalness?: number }).metalness).toBeUndefined();
  });

  it('high-tier glow-like input (emissive) is Standard and keeps its emissive', () => {
    setTierOverride('high');
    const m = surfaceMat({ color: 0x40c0ff, emissive: 0x40c0ff, emissiveIntensity: 0.9 }) as THREE.MeshStandardMaterial;
    expect(m.type).toBe('MeshStandardMaterial');
    expect(m.emissive.getHex()).toBe(0x40c0ff);
  });

  it('low-tier glow-like input folds emissive into the base colour (no emissive on Basic)', () => {
    setTierOverride('low');
    const m = surfaceMat({ color: 0x101010, emissive: 0x40c0ff, emissiveIntensity: 0.9 }) as THREE.MeshBasicMaterial;
    expect(m.type).toBe('MeshBasicMaterial');
    // folded → the blue channel of the emissive shows through the dim base
    expect(m.color.b).toBeGreaterThan(0.3);
    expect((m as unknown as { emissive?: unknown }).emissive).toBeUndefined();
  });

  it('low dims the base colour (~0.85) so an unlit Basic surface is not flat-black', () => {
    setTierOverride('low');
    const map = new THREE.Texture();
    const m = surfaceMat({ color: 0xffffff, map, side: THREE.DoubleSide, depthWrite: false }) as THREE.MeshBasicMaterial;
    // 0xffffff * 0.85 ≈ 0.85 per channel — strictly below 1, strictly above 0.
    expect(m.color.r).toBeLessThan(1);
    expect(m.color.r).toBeGreaterThan(0.5);
    // carried props survive
    expect(m.map).toBe(map);
    expect(m.side).toBe(THREE.DoubleSide);
    expect(m.depthWrite).toBe(false);
  });
});
