// ---------------------------------------------------------------------------
// S3.3 — non-hero surface material factory (Standard → Lambert → Basic).
//
// One central downgrade so every floor/pit/wall/accessory/gun/grenade/pickup
// surface tiers identically. The babo marble SHADER is NEVER routed through
// here. On `high` the EXACT original `MeshStandardMaterial` is returned with
// the same params → desktop pixels are unchanged.
//
// Lives in its OWN module (not quality.ts) so the eager tier-detection path
// (QUALITY/shouldMountPreview, imported by app.ts) carries NO static `three`
// import — keeping three off the entry chunk. surfaceMat is only reachable from
// the render chunks (renderer/baboShapes/effects/gunModels), which are already
// dynamically imported, so three's material classes stay in the lazy three chunk.
// ---------------------------------------------------------------------------
import { Color, MeshBasicMaterial, MeshLambertMaterial, MeshStandardMaterial } from 'three';
import type { ColorRepresentation, Material, Side, Texture } from 'three';
import { QUALITY } from './quality';

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
