import type { Vec2 } from '../core/math';
import type { EquipKind } from './equipment';

/** Axis-aligned wall box: center position, full width/height, visual height. */
export interface MapWall {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Visual/grenade-blocking height in world units. */
  height: number;
}

export interface EquipNode {
  x: number;
  y: number;
  kind: EquipKind;
}

export interface MapDef {
  id: string;
  name: string;
  /** Full playfield size; walls enclose [-w/2, w/2] × [-h/2, h/2]. */
  size: { w: number; h: number };
  walls: MapWall[];
  spawns: { team0: Vec2[]; team1: Vec2[]; ffa: Vec2[] };
  equipmentNodes: EquipNode[];
  healthNodes: Vec2[];
  flags?: { team0: Vec2; team1: Vec2 };
  /** Cosmetic depression where gore pools fastest. */
  bloodPit?: { x: number; y: number; r: number };
}

const W = 64;
const H = 64;
const T = 1.5; // wall thickness
const OUTER_HEIGHT = 2.6; // outer walls clear only on skill lobs
const COVER_HEIGHT = 1.4; // inner cover is lobbable

/**
 * "The Grinder" — symmetric N/S arena, ~64×64 u.
 * Center blood-pit flanked by cover clusters; mid-lane equipment nodes.
 * Mirror-symmetric across y=0 for team fairness.
 */
export const GRINDER: MapDef = {
  id: 'grinder',
  name: 'The Grinder',
  size: { w: W, h: H },
  walls: [
    // Outer boundary
    { x: 0, y: -H / 2, w: W + T, h: T, height: OUTER_HEIGHT },
    { x: 0, y: H / 2, w: W + T, h: T, height: OUTER_HEIGHT },
    { x: -W / 2, y: 0, w: T, h: H + T, height: OUTER_HEIGHT },
    { x: W / 2, y: 0, w: T, h: H + T, height: OUTER_HEIGHT },

    // Spawn platform shields (N team0 / S team1) — opening toward center
    { x: -7, y: -22, w: 8, h: 1.2, height: COVER_HEIGHT },
    { x: 7, y: -22, w: 8, h: 1.2, height: COVER_HEIGHT },
    { x: -7, y: 22, w: 8, h: 1.2, height: COVER_HEIGHT },
    { x: 7, y: 22, w: 8, h: 1.2, height: COVER_HEIGHT },

    // Mid-field cover clusters flanking the pit (lane breakers)
    { x: -12, y: -8, w: 5, h: 1.2, height: COVER_HEIGHT },
    { x: 12, y: -8, w: 5, h: 1.2, height: COVER_HEIGHT },
    { x: -12, y: 8, w: 5, h: 1.2, height: COVER_HEIGHT },
    { x: 12, y: 8, w: 5, h: 1.2, height: COVER_HEIGHT },

    // Side-lane pillars (crates)
    { x: -22, y: -12, w: 2.4, h: 2.4, height: COVER_HEIGHT },
    { x: 22, y: -12, w: 2.4, h: 2.4, height: COVER_HEIGHT },
    { x: -22, y: 12, w: 2.4, h: 2.4, height: COVER_HEIGHT },
    { x: 22, y: 12, w: 2.4, h: 2.4, height: COVER_HEIGHT },

    // Center pit rim accents (small, do not seal the pit)
    { x: -8, y: 0, w: 1.8, h: 1.8, height: COVER_HEIGHT },
    { x: 8, y: 0, w: 1.8, h: 1.8, height: COVER_HEIGHT },
  ],
  spawns: {
    team0: [
      { x: -8, y: -27 }, { x: 0, y: -28 }, { x: 8, y: -27 }, { x: -4, y: -25 }, { x: 4, y: -25 },
    ],
    team1: [
      { x: -8, y: 27 }, { x: 0, y: 28 }, { x: 8, y: 27 }, { x: -4, y: 25 }, { x: 4, y: 25 },
    ],
    ffa: [
      { x: -26, y: -26 }, { x: 26, y: -26 }, { x: -26, y: 26 }, { x: 26, y: 26 },
      { x: 0, y: -28 }, { x: 0, y: 28 }, { x: -28, y: 0 }, { x: 28, y: 0 },
    ],
  },
  equipmentNodes: [
    { x: -16, y: 0, kind: 'frag' },   // contested mid-lane
    { x: 16, y: 0, kind: 'frag' },
    { x: 0, y: -18, kind: 'molotov' }, // near N spawn
    { x: 0, y: 18, kind: 'smoke' },    // near S spawn (asymmetric kinds, mirrored value)
  ],
  healthNodes: [
    { x: -26, y: 0 }, { x: 26, y: 0 },
  ],
  flags: { team0: { x: 0, y: -26 }, team1: { x: 0, y: 26 } },
  bloodPit: { x: 0, y: 0, r: 5 },
};

export const MAPS: Record<string, MapDef> = { grinder: GRINDER };
export const DEFAULT_MAP = 'grinder';
