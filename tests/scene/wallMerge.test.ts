// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { BoxGeometry } from 'three';
import { mergeWalls } from '../../src/render/renderer';

describe('mergeWalls (low/mid static wall merge)', () => {
  it('returns null for no walls', () => {
    expect(mergeWalls([])).toBeNull();
  });

  it('merges N boxes into one geometry with a 2-material (side/cap) group layout', () => {
    const a = new BoxGeometry(1, 2, 1); a.translate(0, 1, 0);
    const b = new BoxGeometry(1, 2, 1); b.translate(5, 1, 0);
    const merged = mergeWalls([a, b])!;
    expect(merged).not.toBeNull();
    // Only material indices 0 (sides) and 1 (caps) are used.
    const idxs = new Set(merged.groups.map((g) => g.materialIndex));
    expect([...idxs].sort()).toEqual([0, 1]);
  });

  it('assigns 2/3 of each box face area to sides and 1/3 to caps', () => {
    const a = new BoxGeometry(1, 2, 1); a.translate(0, 1, 0);
    const merged = mergeWalls([a])!;
    let sideIdx = 0;
    let capIdx = 0;
    for (const g of merged.groups) {
      if (g.materialIndex === 0) sideIdx += g.count;
      else if (g.materialIndex === 1) capIdx += g.count;
    }
    // 4 side face-pairs vs 2 cap face-pairs → 24 vs 12 indices.
    expect(sideIdx).toBe(24);
    expect(capIdx).toBe(12);
    // Every index in the box is covered exactly once (36 per box).
    expect(sideIdx + capIdx).toBe(36);
  });

  it('covers every index of every box contiguously (no gaps/overlaps)', () => {
    const a = new BoxGeometry(1, 2, 1);
    const b = new BoxGeometry(2, 1, 2);
    const merged = mergeWalls([a, b])!;
    const covered = new Array(72).fill(0); // 2 boxes * 36 indices
    for (const g of merged.groups) {
      for (let i = g.start; i < g.start + g.count; i++) covered[i]++;
    }
    expect(covered.every((c) => c === 1)).toBe(true);
  });
});
