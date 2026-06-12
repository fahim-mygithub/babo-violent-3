export type ClassId = 'spider' | 'juggernaut' | 'bastion' | 'phantom' | 'trapper';
export type AbilityId = 'grapple' | 'dash' | 'fortify' | 'phase' | 'gravityWell';

export interface ClassConfig {
  id: ClassId;
  name: string;
  role: string;
  mass: number;
  linearDamping: number;
  maxSpeed: number;
  /** Force applied toward input direction (scaled by mass so accel feel is per-class). */
  moveForce: number;
  ability: {
    id: AbilityId;
    name: string;
    description: string;
    cooldown: number;
    /** Active duration where applicable. */
    duration: number;
  };
  color: number;
}

export const CLASSES: Record<ClassId, ClassConfig> = {
  spider: {
    id: 'spider', name: 'Spider', role: 'Flanker — high mobility',
    mass: 1.0, linearDamping: 1.0, maxSpeed: 15, moveForce: 26,
    ability: {
      id: 'grapple', name: 'Grappling Hook',
      description: 'Hold Space: tether to a wall and swing. Release to let go.',
      cooldown: 0.8, duration: 3.0,
    },
    color: 0x46d05a,
  },
  juggernaut: {
    id: 'juggernaut', name: 'Juggernaut', role: 'Initiator — burst',
    mass: 5.0, linearDamping: 3.0, maxSpeed: 8, moveForce: 95,
    ability: {
      id: 'dash', name: 'Pinball Dash',
      description: 'Bounce forward at high speed with i-frames; damages on impact.',
      cooldown: 5.0, duration: 0.55,
    },
    color: 0xc8742c,
  },
  bastion: {
    id: 'bastion', name: 'Bastion', role: 'Area control — defense',
    mass: 3.0, linearDamping: 2.5, maxSpeed: 10, moveForce: 62,
    ability: {
      id: 'fortify', name: 'Fortify',
      description: 'Mass ×5 and immune to knockback, recoil and pulls for a moment.',
      cooldown: 6.0, duration: 2.2,
    },
    color: 0x4a78c8,
  },
  phantom: {
    id: 'phantom', name: 'Phantom', role: 'Assassin — escape',
    mass: 0.8, linearDamping: 0.8, maxSpeed: 18, moveForce: 23,
    ability: {
      id: 'phase', name: 'Phase Shift',
      description: 'Briefly ethereal: pass through Babos and projectiles.',
      cooldown: 3.0, duration: 0.9,
    },
    color: 0xb39ddb,
  },
  trapper: {
    id: 'trapper', name: 'Trapper', role: 'Zoner — disruptor',
    mass: 1.5, linearDamping: 1.5, maxSpeed: 12, moveForce: 34,
    ability: {
      id: 'gravityWell', name: 'Gravity Well',
      description: 'Cast a well at the crosshair that drags nearby Babos toward it.',
      cooldown: 4.0, duration: 1.1,
    },
    color: 0xd4b13e,
  },
};

export const ALL_CLASS_IDS = Object.keys(CLASSES) as ClassId[];

// Ability tuning (v1)
export const ABILITY = {
  GRAPPLE_RANGE: 12,
  GRAPPLE_PULL: 28,        // spring force toward anchor when taut
  GRAPPLE_ROPE_SLACK: 0.95, // rope length = hit distance * slack
  /** Dash applies impulse = dir * DASH_SPEED * mass (i.e. Δv = DASH_SPEED). */
  DASH_SPEED: 17,
  DASH_IMPACT_DAMAGE: 30,
  DASH_IMPACT_IMPULSE: 14,
  FORTIFY_MASS_MULT: 5,
  WELL_RANGE: 10,          // max cast distance
  WELL_RADIUS: 4.5,
  WELL_FORCE: 40,          // pull force at edge→center falloff
} as const;
