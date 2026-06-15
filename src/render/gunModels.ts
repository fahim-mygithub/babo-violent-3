import { BoxGeometry, ConeGeometry, CylinderGeometry, DoubleSide, Group, Material, Mesh, Object3D, SphereGeometry, TorusGeometry } from 'three';
import type { GunId } from '../data/weapons';
import { GUNS } from '../data/weapons';
import { QUALITY, surfaceMat } from './quality';

/**
 * Low-poly held-weapon models + lobby selector icons, built entirely from
 * primitives (no image assets, matching the rest of the render layer).
 *
 * Conventions, shared with babos.ts:
 *  - A model is a Group whose origin sits at the grip/mount so the caller
 *    can parent it directly to the babo aim mount near (0.45, 0.05, 0).
 *  - The barrel / muzzle points along +X. Overall barrel reach is ~0.7..1.1
 *    world units (babo radius is 0.5, diameter 1.0) so the gun reads from the
 *    steep top-down match camera AND in a lobby close-up.
 *  - Guns are distinguished by SHAPE / mass distribution first, colour second.
 *    Bodies stay matte gunmetal; the tint from GUNS[id].color is applied where
 *    natural (accents, mags, energy cores). Energy guns (ion/lance/pyre) carry
 *    an emissive accent so they self-identify.
 */

// Shared neutral gunmetal tones for the bodies/receivers.
const GUNMETAL = 0x44494f;
const GUNMETAL_DARK = 0x2b2f34;
const GUNMETAL_LIGHT = 0x6b7178;
const POLY_BLACK = 0x1a1c1f;

/** Game-standard metal look: roughness 0.4 / metalness 0.6 (see babos.ts). */
function metal(color: number, roughness = 0.4, metalness = 0.6): Material {
  return surfaceMat({ color, roughness, metalness });
}

/** A matte-er plastic/polymer look for grips, stocks, fore-grips. */
function poly(color: number): Material {
  return surfaceMat({ color, roughness: 0.75, metalness: 0.1 });
}

/** Emissive accent for energy weapons (cores, coils, rails, pilot flames). On low this
 *  folds the glow colour into the unlit base so energy guns still self-identify. */
function glow(color: number, intensity = 0.9): Material {
  return surfaceMat({
    color,
    emissive: color,
    emissiveIntensity: intensity,
    roughness: 0.3,
    metalness: 0.2,
  });
}

/** Box helper: dims (x,y,z), centre position. */
function box(
  mat: Material,
  w: number, h: number, d: number,
  x: number, y: number, z: number,
): Mesh {
  const m = new Mesh(new BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

/**
 * Cylinder helper laid along +X (the barrel axis), length `len`, with end
 * radii rTop/rBottom (Cone is just rTop=0). Default sits the +X end forward.
 */
function tube(
  mat: Material,
  rTop: number, rBottom: number, len: number,
  x: number, y: number, z: number,
  radial = 12,
): Mesh {
  const geo = new CylinderGeometry(rTop, rBottom, len, radial);
  geo.rotateZ(-Math.PI / 2); // +Y axis -> +X axis
  const m = new Mesh(geo, mat);
  m.position.set(x, y, z);
  return m;
}

/** Cone laid along +X with its tip pointing forward (+X). */
function cone(
  mat: Material,
  radius: number, len: number,
  x: number, y: number, z: number,
  radial = 14,
): Mesh {
  const geo = new ConeGeometry(radius, len, radial);
  geo.rotateZ(-Math.PI / 2); // tip -> +X
  const m = new Mesh(geo, mat);
  m.position.set(x, y, z);
  return m;
}

// ---------------------------------------------------------------------------
// Per-gun builders. Each returns the children to add to the model group. The
// group origin is the grip; the body sits a little forward of it (+X) and a
// touch up (+Y) so it reads above the babo crown.
// ---------------------------------------------------------------------------

/** stinger — compact SMG: short body, stubby barrel, slanted stick mag, top stub. */
function buildStinger(accent: number): Object3D[] {
  const body = metal(GUNMETAL);
  const parts: Object3D[] = [
    box(body, 0.34, 0.18, 0.14, 0.18, 0.04, 0),            // receiver
    tube(metal(GUNMETAL_DARK), 0.05, 0.05, 0.26, 0.46, 0.05, 0), // short barrel
    box(metal(GUNMETAL_LIGHT), 0.1, 0.08, 0.15, 0.05, 0.13, 0),  // top stub / charging block
    box(poly(POLY_BLACK), 0.09, 0.2, 0.1, 0.05, -0.13, 0),       // grip
  ];
  // Downward-angled stick magazine (accent colour so the SMG pops)
  const mag = box(metal(accent), 0.09, 0.26, 0.11, 0.2, -0.14, 0);
  mag.rotation.z = 0.35;
  parts.push(mag);
  return parts;
}

/** workhorse — the default AR: receiver, medium barrel, banana mag, carry-handle ridge, short stock. */
function buildWorkhorse(accent: number): Object3D[] {
  const body = metal(GUNMETAL);
  const parts: Object3D[] = [
    box(body, 0.46, 0.16, 0.13, 0.22, 0.04, 0),            // receiver
    tube(metal(GUNMETAL_DARK), 0.045, 0.045, 0.5, 0.62, 0.05, 0), // medium barrel
    box(metal(GUNMETAL_LIGHT), 0.3, 0.05, 0.07, 0.2, 0.14, 0),    // low carry-handle / rail ridge
    box(metal(GUNMETAL_DARK), 0.07, 0.07, 0.09, 0.86, 0.05, 0),   // muzzle device
    box(poly(POLY_BLACK), 0.09, 0.2, 0.1, 0.04, -0.12, 0),        // grip
    box(poly(GUNMETAL_DARK), 0.2, 0.13, 0.11, -0.13, 0.04, 0),    // short stock
  ];
  // Curved banana magazine, built from two angled segments
  const magTop = box(metal(accent), 0.1, 0.14, 0.11, 0.26, -0.13, 0);
  magTop.rotation.z = 0.18;
  const magBot = box(metal(accent), 0.1, 0.16, 0.11, 0.32, -0.27, 0);
  magBot.rotation.z = 0.5;
  parts.push(magTop, magBot);
  return parts;
}

/** maw — wide twin-barrel shotgun: fat front, oversized bores, slung pump fore-grip. */
function buildMaw(accent: number): Object3D[] {
  const body = metal(GUNMETAL);
  const parts: Object3D[] = [
    box(body, 0.3, 0.22, 0.26, 0.16, 0.04, 0),             // chunky receiver
    box(poly(POLY_BLACK), 0.1, 0.2, 0.11, 0.0, -0.13, 0),  // grip
  ];
  // Twin fat barrels, side by side, ending in a fat muzzle each
  const barrelMat = metal(GUNMETAL_DARK);
  for (const z of [-0.07, 0.07]) {
    parts.push(tube(barrelMat, 0.08, 0.08, 0.46, 0.48, 0.07, z, 14));
    parts.push(tube(metal(accent), 0.1, 0.09, 0.07, 0.74, 0.07, z, 14)); // flared choke
  }
  // Thick pump fore-grip slung beneath the barrels
  const pump = box(poly(GUNMETAL_LIGHT), 0.24, 0.1, 0.24, 0.42, -0.06, 0);
  parts.push(pump);
  return parts;
}

/** hurricane — minigun: hexagonal cluster of 6 rotating barrels, bulky body, muzzle ring, ammo drum. */
function buildHurricane(accent: number): Object3D[] {
  const body = metal(GUNMETAL);
  const parts: Object3D[] = [
    tube(body, 0.16, 0.16, 0.3, 0.18, 0.05, 0, 14),        // bulky cylindrical body
    box(metal(GUNMETAL_DARK), 0.16, 0.22, 0.22, 0.02, 0.0, -0.2), // boxy ammo drum / backpack
    box(poly(POLY_BLACK), 0.1, 0.2, 0.1, 0.05, -0.14, 0),  // grip
  ];
  // Hex bundle of 6 barrels around the axis
  const barrelMat = metal(GUNMETAL_LIGHT);
  const ring = 0.075;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const by = 0.05 + Math.sin(a) * ring;
    const bz = Math.cos(a) * ring;
    parts.push(tube(barrelMat, 0.028, 0.028, 0.62, 0.62, by, bz, 8));
  }
  // Front muzzle ring (accent) tying the bundle together
  const ringGeo = new TorusGeometry(0.1, 0.022, 8, 16);
  ringGeo.rotateY(Math.PI / 2); // face down +X
  const muzzleRing = new Mesh(ringGeo, metal(accent));
  muzzleRing.position.set(0.9, 0.05, 0);
  parts.push(muzzleRing);
  return parts;
}

/** thumper — rocket launcher: fat wide-bore tube, conical warhead poking out, rear exhaust cone. */
function buildThumper(accent: number): Object3D[] {
  const body = metal(GUNMETAL);
  const parts: Object3D[] = [
    tube(body, 0.14, 0.14, 0.62, 0.3, 0.07, 0, 16),        // fat launch tube
    box(metal(GUNMETAL_DARK), 0.12, 0.07, 0.16, 0.18, 0.18, 0), // top sight block
    box(poly(POLY_BLACK), 0.1, 0.2, 0.1, 0.08, -0.12, 0),  // grip
    cone(metal(GUNMETAL_DARK), 0.13, 0.18, -0.12, 0.07, 0, 16), // rear exhaust cone (points +X but tucked back)
  ];
  // Visible warhead tip poking out the muzzle (accent / warning colour)
  parts.push(cone(metal(accent), 0.1, 0.22, 0.78, 0.07, 0, 16));
  parts.push(tube(metal(accent), 0.1, 0.1, 0.08, 0.66, 0.07, 0, 16)); // warhead collar
  return parts;
}

/** ion — plasma emitter: smooth shell, glowing core sphere + torus, flared emitter cup. No hard barrel. */
function buildIon(accent: number): Object3D[] {
  const shell = metal(GUNMETAL_LIGHT, 0.3, 0.5);
  const parts: Object3D[] = [
    tube(shell, 0.13, 0.15, 0.4, 0.22, 0.06, 0, 18),       // smooth rounded shell
    box(poly(POLY_BLACK), 0.1, 0.2, 0.1, 0.04, -0.12, 0),  // grip
  ];
  // Energy cell underslung
  parts.push(box(glow(accent, 0.7), 0.16, 0.1, 0.12, 0.2, -0.1, 0));
  // Glowing spherical core mid-body
  const core = new Mesh(new SphereGeometry(0.1, 16, 12), glow(accent, 1.1));
  core.position.set(0.24, 0.06, 0);
  parts.push(core);
  // Glowing torus ring around the core
  const ringGeo = new TorusGeometry(0.14, 0.025, 10, 20);
  ringGeo.rotateY(Math.PI / 2);
  const coil = new Mesh(ringGeo, glow(accent, 0.9));
  coil.position.set(0.24, 0.06, 0);
  parts.push(coil);
  // Flared emitter cup at the front (open cone)
  const cup = new Mesh(
    new CylinderGeometry(0.16, 0.08, 0.18, 18, 1, true),
    surfaceMat({
      color: GUNMETAL, roughness: 0.4, metalness: 0.6, side: DoubleSide,
    }),
  );
  cup.geometry.rotateZ(-Math.PI / 2);
  cup.position.set(0.58, 0.06, 0);
  parts.push(cup);
  // Inner emissive disc inside the cup
  parts.push(tube(glow(accent, 1.0), 0.07, 0.07, 0.02, 0.55, 0.06, 0, 18));
  return parts;
}

/** lance — railgun: long thin body, twin parallel rails, mid-length charge-coil/scope hump, tiny muzzle. */
function buildLance(accent: number): Object3D[] {
  const body = metal(GUNMETAL);
  const parts: Object3D[] = [
    box(body, 0.7, 0.1, 0.12, 0.4, 0.05, 0),               // long thin spine
    box(metal(GUNMETAL_DARK), 0.18, 0.12, 0.1, -0.05, 0.05, 0), // breech block
    box(poly(POLY_BLACK), 0.09, 0.2, 0.1, 0.02, -0.12, 0), // grip
    box(poly(GUNMETAL_DARK), 0.16, 0.1, 0.1, -0.16, 0.04, 0), // short stock
  ];
  // Twin parallel rails running the length (emissive accent, white-blue energy)
  const railMat = glow(accent, 0.7);
  for (const z of [-0.06, 0.06]) {
    parts.push(box(railMat, 0.78, 0.035, 0.025, 0.46, 0.11, z));
  }
  // Charge-coil / scope hump mid-length
  const coilGeo = new TorusGeometry(0.08, 0.03, 10, 18);
  coilGeo.rotateY(Math.PI / 2);
  for (const x of [0.3, 0.46]) {
    const coil = new Mesh(coilGeo, glow(accent, 0.95));
    coil.position.set(x, 0.08, 0);
    parts.push(coil);
  }
  // Tiny focused muzzle
  parts.push(tube(metal(GUNMETAL_DARK), 0.03, 0.045, 0.16, 0.83, 0.08, 0, 12));
  return parts;
}

/** pyre — flamethrower: nozzle gun, fat under-slung fuel tank, wide flared cone nozzle, pilot-flame nub. */
function buildPyre(accent: number): Object3D[] {
  const body = metal(GUNMETAL);
  const parts: Object3D[] = [
    box(body, 0.3, 0.16, 0.14, 0.16, 0.05, 0),             // receiver
    box(poly(POLY_BLACK), 0.1, 0.2, 0.1, 0.02, -0.12, 0),  // grip
  ];
  // Fat cylindrical fuel tank slung under/behind
  const tank = tube(metal(GUNMETAL_DARK), 0.13, 0.13, 0.34, 0.04, -0.12, 0, 16);
  parts.push(tank);
  parts.push(tube(metal(GUNMETAL_LIGHT), 0.135, 0.135, 0.04, -0.13, -0.12, 0, 16)); // tank cap
  // Feed pipe from tank up to receiver
  parts.push(box(metal(GUNMETAL_LIGHT), 0.06, 0.14, 0.06, 0.04, -0.03, 0.04));
  // Barrel out to the nozzle
  parts.push(tube(metal(GUNMETAL_DARK), 0.06, 0.06, 0.3, 0.46, 0.06, 0, 14));
  // Wide flared cone nozzle up front
  const nozzle = new Mesh(
    new CylinderGeometry(0.13, 0.06, 0.18, 16, 1, true),
    surfaceMat({
      color: GUNMETAL, roughness: 0.4, metalness: 0.6, side: DoubleSide,
    }),
  );
  nozzle.geometry.rotateZ(-Math.PI / 2);
  nozzle.position.set(0.74, 0.06, 0);
  parts.push(nozzle);
  // Small pilot-flame nub at the nozzle mouth (emissive accent)
  const pilot = new Mesh(new SphereGeometry(0.04, 10, 8), glow(accent, 1.2));
  pilot.position.set(0.82, 0.12, 0.05);
  parts.push(pilot);
  return parts;
}

const BUILDERS: Record<GunId, (accent: number) => Object3D[]> = {
  stinger: buildStinger,
  workhorse: buildWorkhorse,
  maw: buildMaw,
  hurricane: buildHurricane,
  thumper: buildThumper,
  ion: buildIon,
  lance: buildLance,
  pyre: buildPyre,
};

/** Assemble a fresh gun model group from the per-gun primitive builder. */
function assembleGunModel(gunId: GunId): Group {
  const group = new Group();
  group.name = `gun:${gunId}`;
  const accent = GUNS[gunId].color;
  for (const part of BUILDERS[gunId](accent)) group.add(part);
  return group;
}

// ---------------------------------------------------------------------------
// Per-GunId template cache (S3.5c) — GATED to low/mid via QUALITY.mergeStatics.
//
// On low/mid, buildGunModel returns a `template.clone()`: three.js shares the
// underlying geometry + material refs across clones, so all held models for a
// gun reuse ONE set of geos/mats. The cache-owned resources are tracked in a
// module WeakSet; per-instance disposeGunModel SKIPS anything in that set so a
// despawning babo never frees geometry another babo (or a future respawn) still
// uses. The cache itself is freed only at pool/app teardown via disposeGunCache.
// On high, mergeStatics is false → the proven per-instance path is unchanged.
// ---------------------------------------------------------------------------

const gunCache = new Map<GunId, Group>();
const cacheOwned = new WeakSet<object>();

/** Mark every geometry + material under `group` as cache-owned (disposal-guarded). */
function markCached(group: Group): void {
  group.traverse((obj) => {
    const mesh = obj as Partial<Mesh>;
    if (mesh.geometry) cacheOwned.add(mesh.geometry);
    const mat = (mesh as Mesh).material;
    if (Array.isArray(mat)) for (const m of mat) cacheOwned.add(m);
    else if (mat) cacheOwned.add(mat);
  });
}

/**
 * Build the distinctive low-poly model for a gun. Barrel points along +X; the
 * group origin is at the grip/mount, ready to parent to the babo aim mount.
 *
 * On low/mid (mergeStatics) returns a clone of a cached template that shares the
 * gun's geometry + materials; on high builds a fresh standalone model.
 */
export function buildGunModel(gunId: GunId): Group {
  if (!QUALITY.mergeStatics) return assembleGunModel(gunId);
  let template = gunCache.get(gunId);
  if (!template) {
    template = assembleGunModel(gunId);
    markCached(template);
    gunCache.set(gunId, template);
  }
  // Group.clone() shares geometry + material refs with the template (and so with
  // every sibling clone) — the cache-owned guard protects them on dispose.
  return template.clone();
}

// ---------------------------------------------------------------------------
// Disposal
// ---------------------------------------------------------------------------

/**
 * Recursively dispose a buildGunModel() group's geometry + materials, SKIPPING
 * any resource owned by the template cache (so a despawn never frees shared geo).
 */
export function disposeGunModel(group: Group): void {
  group.traverse((obj) => {
    const mesh = obj as Partial<Mesh>;
    if (mesh.geometry && !cacheOwned.has(mesh.geometry)) mesh.geometry.dispose();
    const mat = (mesh as Mesh).material;
    if (Array.isArray(mat)) {
      for (const m of mat) if (!cacheOwned.has(m)) m.dispose();
    } else if (mat && !cacheOwned.has(mat)) {
      mat.dispose();
    }
  });
}

/**
 * Free every cached gun template's geometry + materials (bypassing the per-instance
 * guard) and clear the cache. Call ONLY at pool/app teardown — never per babo.
 */
export function disposeGunCache(): void {
  for (const template of gunCache.values()) {
    template.traverse((obj) => {
      const mesh = obj as Partial<Mesh>;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = (mesh as Mesh).material;
      if (Array.isArray(mat)) for (const m of mat) m.dispose();
      else if (mat) mat.dispose();
    });
  }
  gunCache.clear();
}
