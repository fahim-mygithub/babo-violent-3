import * as THREE from 'three';
import type { ClassId } from '../data/classes';
import { CLASSES } from '../data/classes';

/**
 * Per-class visual identity ACCESSORIES for the faceless Babo marble.
 *
 * The gameplay hitbox (a SphereGeometry(0.5) body, see babos.ts) is owned by
 * the caller and never changes — these add-ons only break up the silhouette so
 * each of the 5 chassis reads instantly from the steep top-down camera. BV2 is
 * faithful here: the babo has no face, so identity comes from add-ons around
 * the orb (legs, armor belt, shield band, wisps, orbiting ring) and from a
 * purely cosmetic `bodyScale` (phantom smallest → juggernaut largest).
 *
 * Accessories split into two parenting buckets:
 *   - `roll`    : parented to the rolling body mesh (tumbles with velocity).
 *   - `upright` : parented to the world-upright aim mount (stays level).
 * Keep poly counts LOW — up to 8 babos spawn at once in a match.
 */
export interface ClassVisual {
  /** Visual-only body scale, clamped 0.82..1.18 (phantom small, juggernaut big). */
  bodyScale: number;
  /** Accessories that ROLL with the body (caller parents to the rolling body mesh). */
  roll: THREE.Object3D[];
  /** Accessories that stay world-upright (caller parents to the group). */
  upright: THREE.Object3D[];
  /** Optional per-frame anim for upright bits (t = seconds). */
  animate?: (upright: THREE.Object3D[], t: number) => void;
}

// Marble-matched surface response for accessories (glossy, lightly metallic),
// so add-ons sit in the same material family as the babo shell.
const ACCESSORY_METALNESS = 0.55;
const ACCESSORY_ROUGHNESS = 0.38;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** A class-tinted standard material; `shade` lightens (>1) or darkens (<1) the base hue. */
function accessoryMaterial(
  baseColor: number,
  shade = 1,
  opts: { metalness?: number; roughness?: number; emissive?: number; emissiveIntensity?: number } = {},
): THREE.MeshStandardMaterial {
  const col = new THREE.Color(baseColor).multiplyScalar(shade);
  return new THREE.MeshStandardMaterial({
    color: col,
    metalness: opts.metalness ?? ACCESSORY_METALNESS,
    roughness: opts.roughness ?? ACCESSORY_ROUGHNESS,
    emissive: new THREE.Color(opts.emissive ?? 0x000000),
    emissiveIntensity: opts.emissiveIntensity ?? 1,
  });
}

/** A translucent class-tinted material for ethereal / halo bits. */
function ghostMaterial(baseColor: number, shade: number, opacity: number): THREE.MeshStandardMaterial {
  const m = accessoryMaterial(baseColor, shade, { metalness: 0.1, roughness: 0.7 });
  m.transparent = true;
  m.opacity = opacity;
  m.depthWrite = false;
  return m;
}

// --- Per-class builders ----------------------------------------------------

/**
 * Spider (green flanker, grappling hook): sleek; thin angular fins/legs splayed
 * around the lower equator (roll) + a small grapple-claw nub on top (upright).
 */
function buildSpider(color: number, r: number): ClassVisual {
  const upright: THREE.Object3D[] = [];

  // Six chunky legs arcing out and down to the pedestal like a standing spider —
  // a wide insectile stance that unmistakably breaks the circle from any angle.
  // Kept UPRIGHT (world-aligned) so the silhouette stays stable as the ball
  // rolls under it. A bright glossy green (lighter than the shell, strong
  // specular) reads against BOTH the bright body and the dark stage.
  const legMat = accessoryMaterial(color, 1.25, { metalness: 0.5, roughness: 0.3 });
  const footMat = accessoryMaterial(color, 0.7, { metalness: 0.6, roughness: 0.35 });
  const thighGeo = new THREE.BoxGeometry(r * 0.12, r * 0.12, r * 0.72); // long axis = local +Z
  const footGeo = new THREE.BoxGeometry(r * 0.11, r * 0.34, r * 0.11);
  const legCount = 6;
  for (let i = 0; i < legCount; i++) {
    const leg = new THREE.Group();
    const a = (i / legCount) * Math.PI * 2;
    const thigh = new THREE.Mesh(thighGeo, legMat);
    thigh.position.z = r * 0.34;          // reach outward (local +Z is radial)
    thigh.rotation.x = 0.5;               // tilt the limb down toward the floor
    const foot = new THREE.Mesh(footGeo, footMat);
    foot.position.set(0, -r * 0.34, r * 0.62); // a shin dropping to the pedestal
    leg.add(thigh, foot);
    leg.position.set(Math.cos(a) * r * 0.46, r * 0.12, Math.sin(a) * r * 0.46);
    leg.rotation.y = Math.PI / 2 - a;     // orient local +Z radially outward
    upright.push(leg);
  }

  // Forward-angled grapple-claw boom on top (points along aim +X).
  const clawMat = accessoryMaterial(color, 1.35, { metalness: 0.75, roughness: 0.3 });
  const claw = new THREE.Mesh(new THREE.ConeGeometry(r * 0.17, r * 0.44, 6), clawMat);
  claw.position.set(r * 0.34, r * 0.82, 0);
  claw.rotation.z = -Math.PI / 2.2; // tilt the hook-boom forward
  upright.push(claw);

  return { bodyScale: 0.95, roll: [], upright };
}

/**
 * Juggernaut (orange heavy, pinball dash): big; a riveted armor band + chunky
 * bumper studs around the equator (roll). An armored wrecking ball.
 */
function buildJuggernaut(color: number, r: number): ClassVisual {
  const roll: THREE.Object3D[] = [];

  // Riveted armor belt around the equator.
  const beltMat = accessoryMaterial(color, 0.65, { metalness: 0.75, roughness: 0.45 });
  const beltGeo = new THREE.TorusGeometry(r * 1.0, r * 0.12, 6, 20);
  const belt = new THREE.Mesh(beltGeo, beltMat);
  belt.rotation.x = Math.PI / 2; // lay the ring around the equator
  roll.push(belt);

  // Chunky bumper studs riveted around the belt.
  const studMat = accessoryMaterial(color, 1.15, { metalness: 0.8, roughness: 0.35 });
  const studGeo = new THREE.CylinderGeometry(r * 0.13, r * 0.16, r * 0.14, 6);
  const studCount = 8;
  for (let i = 0; i < studCount; i++) {
    const stud = new THREE.Mesh(studGeo, studMat);
    const a = (i / studCount) * Math.PI * 2;
    stud.position.set(Math.cos(a) * r * 1.04, 0, Math.sin(a) * r * 1.04);
    stud.rotation.z = Math.PI / 2;
    stud.rotation.y = -a; // point each bumper radially outward
    roll.push(stud);
  }

  return { bodyScale: 1.18, roll, upright: [] };
}

/**
 * Bastion (blue tanky, fortify): sturdy; an upright hexagonal/segmented shield
 * ring band that slowly orbits (upright + animate). Bunker look.
 */
function buildBastion(color: number, r: number): ClassVisual {
  const upright: THREE.Object3D[] = [];

  // A band of flat shield plates arranged as a segmented ring around the orb.
  const ring = new THREE.Group();
  const plateMat = accessoryMaterial(color, 0.85, { metalness: 0.6, roughness: 0.4 });
  const plateGeo = new THREE.BoxGeometry(r * 0.5, r * 0.62, r * 0.07);
  const segments = 6;
  for (let i = 0; i < segments; i++) {
    const plate = new THREE.Mesh(plateGeo, plateMat);
    const a = (i / segments) * Math.PI * 2;
    plate.position.set(Math.cos(a) * r * 1.18, 0, Math.sin(a) * r * 1.18);
    plate.rotation.y = -a + Math.PI / 2; // face each plate tangent to the ring
    ring.add(plate);
  }
  // Trim torus tying the segmented plates into one shield band.
  const trimMat = accessoryMaterial(color, 1.2, { metalness: 0.7, roughness: 0.3 });
  const trim = new THREE.Mesh(new THREE.TorusGeometry(r * 1.18, r * 0.04, 5, 18), trimMat);
  trim.rotation.x = Math.PI / 2;
  ring.add(trim);
  upright.push(ring);

  const animate = (parts: THREE.Object3D[], t: number): void => {
    const band = parts[0];
    if (band) band.rotation.y = t * 0.6; // slow defensive orbit
  };

  return { bodyScale: 1.1, roll: [], upright, animate };
}

/**
 * Phantom (purple featherweight, phase): ethereal; a faint translucent halo
 * ring + wispy trailing vapor fins (upright, gentle bob via animate).
 */
function buildPhantom(color: number, r: number): ClassVisual {
  const upright: THREE.Object3D[] = [];

  // Faint translucent halo ring hovering around the orb.
  const halo = new THREE.Mesh(
    new THREE.TorusGeometry(r * 1.1, r * 0.03, 4, 20),
    ghostMaterial(color, 1.4, 0.35),
  );
  halo.rotation.x = Math.PI / 2;
  upright.push(halo);

  // Wispy trailing vapor fins (thin tapered daggers behind the babo, -X).
  const finMat = ghostMaterial(color, 1.15, 0.28);
  const finGeo = new THREE.ConeGeometry(r * 0.12, r * 0.7, 4);
  const finCount = 3;
  for (let i = 0; i < finCount; i++) {
    const fin = new THREE.Mesh(finGeo, finMat);
    const spread = (i - (finCount - 1) / 2) * 0.4;
    fin.position.set(-r * 0.7, r * 0.1, spread * r);
    fin.rotation.z = Math.PI / 2; // taper the wisp tip backward
    upright.push(fin);
  }

  const animate = (parts: THREE.Object3D[], t: number): void => {
    const halo0 = parts[0];
    if (halo0) {
      halo0.rotation.z = t * 0.3;
      halo0.position.y = Math.sin(t * 1.5) * r * 0.08; // gentle hover
    }
    for (let i = 1; i < parts.length; i++) {
      const fin = parts[i];
      fin.position.y = r * 0.1 + Math.sin(t * 2.2 + i) * r * 0.07; // bob the wisps
    }
  };

  return { bodyScale: 0.85, roll: [], upright, animate };
}

/**
 * Trapper (gold medium, gravity well): tech motif; 2 satellite nodes on an
 * upright ring orbiting the babo (upright + animate orbit) + a short antenna prong.
 */
function buildTrapper(color: number, r: number): ClassVisual {
  const upright: THREE.Object3D[] = [];

  // Orbit ring carrying the satellite nodes; tilted for a ring-around-ball read.
  const orbit = new THREE.Group();
  orbit.rotation.x = 0.5;

  const ringMat = accessoryMaterial(color, 0.8, { metalness: 0.7, roughness: 0.4 });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 1.15, r * 0.025, 4, 24), ringMat);
  ring.rotation.x = Math.PI / 2;
  orbit.add(ring);

  const nodeMat = accessoryMaterial(color, 1.3, {
    metalness: 0.4,
    roughness: 0.3,
    emissive: color,
    emissiveIntensity: 0.35,
  });
  const nodeGeo = new THREE.OctahedronGeometry(r * 0.13, 0);
  const nodeCount = 2;
  for (let i = 0; i < nodeCount; i++) {
    const node = new THREE.Mesh(nodeGeo, nodeMat);
    const a = (i / nodeCount) * Math.PI * 2;
    node.position.set(Math.cos(a) * r * 1.15, 0, Math.sin(a) * r * 1.15);
    orbit.add(node);
  }
  upright.push(orbit);

  // Short antenna prong on top with a tiny emitter tip.
  const antenna = new THREE.Group();
  const stalkMat = accessoryMaterial(color, 0.7, { metalness: 0.8, roughness: 0.4 });
  const stalk = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.03, r * 0.04, r * 0.5, 5), stalkMat);
  stalk.position.y = r * 0.95;
  const tip = new THREE.Mesh(
    new THREE.SphereGeometry(r * 0.08, 6, 5),
    accessoryMaterial(color, 1.4, { emissive: color, emissiveIntensity: 0.5 }),
  );
  tip.position.y = r * 1.2;
  antenna.add(stalk, tip);
  upright.push(antenna);

  const animate = (parts: THREE.Object3D[], t: number): void => {
    const orbit0 = parts[0];
    if (orbit0) orbit0.rotation.y = t * 1.2; // satellites circle the gravity well
  };

  return { bodyScale: 1.0, roll: [], upright, animate };
}

// --- Public API ------------------------------------------------------------

/**
 * Build the per-class accessory set for a Babo. The body sphere itself (radius
 * `radius`, default 0.5) is owned by the caller and untouched; `bodyScale` is a
 * cosmetic-only hint the caller may apply to the visual mesh.
 */
export function buildClassVisual(classId: ClassId, radius = 0.5): ClassVisual {
  const color = CLASSES[classId].color;
  let v: ClassVisual;
  switch (classId) {
    case 'spider':
      v = buildSpider(color, radius);
      break;
    case 'juggernaut':
      v = buildJuggernaut(color, radius);
      break;
    case 'bastion':
      v = buildBastion(color, radius);
      break;
    case 'phantom':
      v = buildPhantom(color, radius);
      break;
    case 'trapper':
      v = buildTrapper(color, radius);
      break;
  }
  // Enforce the documented cosmetic-scale clamp regardless of builder values.
  v.bodyScale = clamp(v.bodyScale, 0.82, 1.18);
  return v;
}

/** Recursively dispose every geometry + material under an accessory object. */
function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    const mesh = child as Partial<THREE.Mesh>;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material;
    if (mat) {
      if (Array.isArray(mat)) {
        for (const m of mat) m.dispose();
      } else {
        mat.dispose();
      }
    }
  });
}

/** Dispose all accessory geometry + materials held by a ClassVisual. */
export function disposeClassVisual(v: ClassVisual): void {
  for (const o of v.roll) disposeObject(o);
  for (const o of v.upright) disposeObject(o);
  v.roll.length = 0;
  v.upright.length = 0;
}
