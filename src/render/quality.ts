/**
 * Render quality tier detection (Spec S3.1).
 *
 * Phase-1 scope: DETECTION + DPR/AA clamp only — no material/instancing swaps.
 * Resolved synchronously at import (zero await) so the singleton is available
 * before the first renderer ctor. NEVER reads `navigator.deviceMemory` (privacy
 * fingerprint + unreliable). In jsdom (no `matchMedia`) detection DEFAULTS to
 * 'high', keeping desktop + determinism/render tests on today's exact path.
 */
export type Tier = 'low' | 'mid' | 'high';

export interface QualityProfile {
  tier: Tier;
  isMobile: boolean;
  maxPixelRatio: number;
  antialias: boolean;
}

interface Signals {
  coarse: boolean;
  maxTouchPoints: number;
  cores: number;
  dpr: number;
}

function signals(): Signals {
  const mm = typeof window !== 'undefined' && typeof window.matchMedia === 'function';
  return {
    coarse: mm ? window.matchMedia('(pointer:coarse)').matches : false,
    maxTouchPoints: typeof navigator !== 'undefined' ? (navigator.maxTouchPoints ?? 0) : 0,
    cores: typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency ?? 4) : 4,
    dpr: typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 3) : 1,
  };
}

const FIELDS: Record<Tier, Omit<QualityProfile, 'tier' | 'isMobile'>> = {
  high: { maxPixelRatio: 2, antialias: true },
  mid:  { maxPixelRatio: 1.25, antialias: false },
  low:  { maxPixelRatio: 1, antialias: false },
};

/** Pure classification; accepts injected signals for testability. Never reads deviceMemory. */
export function detectQuality(s: Partial<Signals> = {}): QualityProfile {
  const sig = { ...signals(), ...s };
  const isMobile = sig.coarse || sig.maxTouchPoints > 0;
  const tier: Tier = !isMobile ? 'high' : sig.cores >= 6 ? 'mid' : 'low';
  return { tier, isMobile, ...FIELDS[tier] };
}

/** Live singleton resolved at import with ZERO await (available before first renderer ctor). */
export const QUALITY: QualityProfile = detectQuality();

/** Mutate the singleton in place so live imports keep the same reference. */
export function setTierOverride(tier: Tier): void {
  Object.assign(QUALITY, { tier, isMobile: tier !== 'high', ...FIELDS[tier] });
}
