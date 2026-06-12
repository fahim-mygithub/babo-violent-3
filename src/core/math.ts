export interface Vec2 {
  x: number;
  y: number;
}

export const TAU = Math.PI * 2;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Frame-rate independent exponential approach (for damped smoothing). */
export function damp(a: number, b: number, lambda: number, dt: number): number {
  return lerp(a, b, 1 - Math.exp(-lambda * dt));
}

export function len(x: number, y: number): number {
  return Math.hypot(x, y);
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay);
}

export function distSq(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

/** Normalize in place semantics: returns [nx, ny] or [0,0] for zero vector. */
export function norm(x: number, y: number): [number, number] {
  const l = Math.hypot(x, y);
  if (l < 1e-9) return [0, 0];
  return [x / l, y / l];
}

export function angleTo(ax: number, ay: number, bx: number, by: number): number {
  return Math.atan2(by - ay, bx - ax);
}

/** Shortest signed angular difference a→b in (-PI, PI]. */
export function angleDiff(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}

/**
 * Segment vs circle intersection. Returns t in [0,1] along the segment of the
 * first intersection, or -1 if none.
 */
export function segCircle(
  x0: number, y0: number, x1: number, y1: number,
  cx: number, cy: number, r: number,
): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const fx = x0 - cx;
  const fy = y0 - cy;
  const a = dx * dx + dy * dy;
  if (a < 1e-12) return fx * fx + fy * fy <= r * r ? 0 : -1;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  let disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  disc = Math.sqrt(disc);
  const t1 = (-b - disc) / (2 * a);
  const t2 = (-b + disc) / (2 * a);
  if (t1 >= 0 && t1 <= 1) return t1;
  if (t2 >= 0 && t2 <= 1) return t2; // started inside the circle
  return -1;
}

/**
 * Segment vs axis-aligned box (center cx,cy, full size w,h). Returns t in
 * [0,1] of first intersection or -1. Uses the slab method.
 */
export function segAABB(
  x0: number, y0: number, x1: number, y1: number,
  cx: number, cy: number, w: number, h: number,
): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const minX = cx - w / 2, maxX = cx + w / 2;
  const minY = cy - h / 2, maxY = cy + h / 2;
  let tmin = 0;
  let tmax = 1;
  for (const [p, d, lo, hi] of [
    [x0, dx, minX, maxX],
    [y0, dy, minY, maxY],
  ] as const) {
    if (Math.abs(d) < 1e-12) {
      if (p < lo || p > hi) return -1;
    } else {
      let t1 = (lo - p) / d;
      let t2 = (hi - p) / d;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return -1;
    }
  }
  return tmin;
}

/** Closest point on AABB (center/full-size) to a point. */
export function closestOnAABB(
  px: number, py: number, cx: number, cy: number, w: number, h: number,
): [number, number] {
  return [clamp(px, cx - w / 2, cx + w / 2), clamp(py, cy - h / 2, cy + h / 2)];
}
