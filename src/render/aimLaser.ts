import { segAABB } from '../core/math';

/** Axis-aligned wall box (center x,y; full size w,h). Structurally a MapWall. */
export interface Wall { x: number; y: number; w: number; h: number; }

/**
 * Length of the laser from (x0,y0) along `aim`, clamped to the first wall it hits
 * (honest occlusion — the beam stops at geometry, it never shines through). With
 * no wall in the path it returns the full `maxLen`. Pure + zero-alloc.
 */
export function laserLength(x0: number, y0: number, aim: number, maxLen: number, walls: Wall[]): number {
  const x1 = x0 + Math.cos(aim) * maxLen;
  const y1 = y0 + Math.sin(aim) * maxLen;
  let bestT = 1;
  for (const w of walls) {
    const t = segAABB(x0, y0, x1, y1, w.x, w.y, w.w, w.h);
    if (t >= 0 && t < bestT) bestT = t;
  }
  return maxLen * bestT;
}
