/**
 * Render quality tier detection (Spec S3.1).
 *
 * DETECTION + DPR/AA clamp + the per-tier render knobs the S3 work reads live
 * (splat RT size, particle/fire/smoke counts, lobby preview, …). The per-tier
 * non-hero material factory `surfaceMat` lives in its own module (render/surfaceMat.ts)
 * so THIS module imports no `three` — app.ts imports it eagerly for tier detection,
 * and keeping it three-free keeps three off the entry chunk.
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
  /** Downgrade non-hero surface materials (Standard→Lambert→Basic). OFF on high. */
  downgradeMaterials: boolean;
  /** Merge/cache walls + gun/class templates (low/mid only). OFF on high (desktop byte-identical). */
  mergeStatics: boolean;
  /** Persistent splat render-target edge (px). High keeps today's 2048. */
  splatRtSize: number;
  /** Multiplier on transient particle-burst counts (high = 1, today's literals). */
  particleScale: number;
  /** Hard cap on live pooled particles (high = today's 600). */
  particleCap: number;
  /** Sprites per fire zone (high = today's 7). */
  fireSprites: number;
  /** Sprites per smoke zone (high = today's 6). */
  smokeSprites: number;
  /** Mount the live animated lobby preview (false on low → static icon fallback). */
  lobbyPreview: boolean;
  /** Construct the babo body material transparent. TRUE on high (desktop
   *  render-pass byte-identity with main); FALSE on mobile tiers (opaque-by-default
   *  is the perf win — phase gating still flips it transparent while a phase is active). */
  baboBodyTransparent: boolean;
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
  high: {
    maxPixelRatio: 2, antialias: true,
    downgradeMaterials: false, mergeStatics: false, splatRtSize: 2048,
    particleScale: 1, particleCap: 600, fireSprites: 7, smokeSprites: 6,
    lobbyPreview: true, baboBodyTransparent: true,
  },
  mid: {
    maxPixelRatio: 1.25, antialias: false,
    downgradeMaterials: true, mergeStatics: true, splatRtSize: 1024,
    particleScale: 0.65, particleCap: 350, fireSprites: 5, smokeSprites: 4,
    lobbyPreview: true, baboBodyTransparent: false,
  },
  low: {
    maxPixelRatio: 1, antialias: false,
    downgradeMaterials: true, mergeStatics: true, splatRtSize: 1024,
    particleScale: 0.4, particleCap: 200, fireSprites: 3, smokeSprites: 3,
    lobbyPreview: false, baboBodyTransparent: false,
  },
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

/**
 * Device-pixel-ratio backing-store scale for the 2D overlay canvases (HUD,
 * screen-fx). 1x on desktop (high) so HiDPI desktops render byte-identically to
 * main; min(devicePixelRatio, 2) on the mobile tiers, where the crisp scaled
 * backing store is the win and the cost is acceptable.
 */
export function canvasBackingScale(): number {
  if (!QUALITY.isMobile) return 1;
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  return Math.min(dpr, 2);
}

/** Whether to mount the live animated lobby preview (false on low → static icon). */
export const shouldMountPreview = (): boolean => QUALITY.lobbyPreview;

/** Throttle settings for the live lobby preview renderer (S3.8). */
export interface PreviewQuality {
  antialias: boolean;
  /** Device-pixel-ratio ceiling for the preview canvas. */
  maxDpr: number;
  /** Frame cap; 0 = uncapped (high). */
  maxFps: number;
}

/**
 * Lobby-preview render throttle per tier. High runs full (AA on, DPR≤2, uncapped);
 * mid throttles (AA off, DPR≤1, ~30fps). Low never mounts the live preview, so its
 * values are only a defensive fallback.
 */
export function previewQuality(): PreviewQuality {
  if (QUALITY.tier === 'high') return { antialias: true, maxDpr: 2, maxFps: 0 };
  return { antialias: false, maxDpr: 1, maxFps: 30 };
}

// The non-hero surface material factory (S3.3) lives in ./surfaceMat so this
// (eager, three-free) module never drags three into the entry chunk. Render-path
// consumers import surfaceMat directly from ./surfaceMat.
