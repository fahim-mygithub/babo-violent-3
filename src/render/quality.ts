/**
 * Render quality tier detection (Spec S3.1).
 *
 * DETECTION + DPR/AA clamp + the per-tier render knobs the S3 work reads live
 * (`surfaceMat`, splat RT size, particle/fire/smoke counts, lobby preview, …).
 * Resolved synchronously at import (zero await) so the singleton is available
 * before the first renderer ctor. NEVER reads `navigator.deviceMemory` (privacy
 * fingerprint + unreliable). In jsdom (no `matchMedia`) detection DEFAULTS to
 * 'high', keeping desktop + determinism/render tests on today's exact path.
 */
import { Color, MeshBasicMaterial, MeshLambertMaterial, MeshStandardMaterial } from 'three';
import type { ColorRepresentation, Material, Side, Texture } from 'three';

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
  /** Construct the babo body material transparent (all tiers — phase gating flips it). */
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
    lobbyPreview: true, baboBodyTransparent: true,
  },
  low: {
    maxPixelRatio: 1, antialias: false,
    downgradeMaterials: true, mergeStatics: true, splatRtSize: 1024,
    particleScale: 0.4, particleCap: 200, fireSprites: 3, smokeSprites: 3,
    lobbyPreview: false, baboBodyTransparent: true,
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

// ---------------------------------------------------------------------------
// S3.3 — non-hero surface material factory (Standard → Lambert → Basic).
//
// One central downgrade so every floor/pit/wall/accessory/gun/grenade/pickup
// surface tiers identically. The babo marble SHADER is NEVER routed through
// here. On `high` the EXACT original `MeshStandardMaterial` is returned with
// the same params → desktop pixels are unchanged.
// ---------------------------------------------------------------------------

export interface SurfaceParams {
  color?: ColorRepresentation;
  emissive?: ColorRepresentation;
  map?: Texture | null;
  transparent?: boolean;
  opacity?: number;
  side?: Side;
  depthWrite?: boolean;
  /** Standard-only; preserved on high, DROPPED on Lambert/Basic. */
  roughness?: number;
  /** Standard-only; preserved on high, DROPPED on Lambert/Basic. */
  metalness?: number;
  /** Standard-only emissive boost; preserved on high, DROPPED below. */
  emissiveIntensity?: number;
}

/**
 * Props that survive every downgrade tier: the look-defining surface params
 * that Lambert and Basic both understand (map/transparent/opacity/side/depthWrite).
 * `undefined` entries leave the three.js material default in place.
 */
function carry(p: SurfaceParams): {
  map?: Texture; transparent?: boolean; opacity?: number; side?: Side; depthWrite?: boolean;
} {
  const out: { map?: Texture; transparent?: boolean; opacity?: number; side?: Side; depthWrite?: boolean } = {};
  if (p.map != null) out.map = p.map;
  if (p.transparent !== undefined) out.transparent = p.transparent;
  if (p.opacity !== undefined) out.opacity = p.opacity;
  if (p.side !== undefined) out.side = p.side;
  if (p.depthWrite !== undefined) out.depthWrite = p.depthWrite;
  return out;
}

export function surfaceMat(p: SurfaceParams): Material {
  if (QUALITY.tier === 'high') {
    // Desktop / hero path: the exact original Standard material, byte-identical.
    return new MeshStandardMaterial({ ...p });
  }
  if (QUALITY.tier === 'mid') {
    // Lambertize: cheap diffuse lighting; KEEP color/emissive + carried props;
    // DROP metalness/roughness/emissiveIntensity (no PBR on Lambert). Only spread
    // color/emissive when set so three.js doesn't warn on an explicit undefined.
    const params: ConstructorParameters<typeof MeshLambertMaterial>[0] = { ...carry(p) };
    if (p.color !== undefined) params.color = p.color;
    if (p.emissive !== undefined) params.emissive = p.emissive;
    return new MeshLambertMaterial(params);
  }
  // Basicize (low): unlit. Fold emissive→color (the glow shows through with no
  // lighting), then multiply ~0.85 so an unlit base colour isn't flat-black.
  // DROP metalness/roughness/emissiveIntensity.
  const base = new Color(p.color ?? 0xffffff);
  if (p.emissive !== undefined) base.add(new Color(p.emissive));
  base.multiplyScalar(0.85);
  return new MeshBasicMaterial({ color: base, ...carry(p) });
}
