export type GunId =
  | 'stinger' | 'workhorse' | 'maw' | 'hurricane'
  | 'thumper' | 'ion' | 'lance' | 'pyre';

export interface GunConfig {
  id: GunId;
  name: string;
  identity: string;
  sustain: 'reload' | 'heat';
  /** Damage per hit (per pellet for maw, per flame tick for pyre). */
  damage: number;
  pellets: number;
  /** Shots per second. */
  fireRate: number;
  // Reload guns
  magSize?: number;
  reloadTime?: number;
  // Heat guns (heat is 0..1; overheat at 1)
  heatPerShot?: number;
  /** Heat drained per second while not firing. */
  coolRate?: number;
  /** Lockout seconds after overheating. */
  overheatLockout?: number;
  /** Seconds of spin-up before firing starts (hurricane). */
  spinUp?: number;
  /** Seconds of hold-to-charge per shot (lance). */
  chargeTime?: number;
  /** Recoil impulse applied opposite aim, divided by class mass. */
  recoil: number;
  projectileSpeed: number;
  hitscan?: boolean;
  /** Base spread half-angle, radians. */
  spread: number;
  /** Added spread per shot (decays at spreadDecay/s). */
  spreadGrowth: number;
  spreadMax: number;
  range: number;
  splashRadius?: number;
  splashDamage?: number;
  splashImpulse?: number;
  /** Pyre: cone half-angle; flames are short-range projectiles. */
  ignitesBlood?: boolean;
  /** Tint used by renderer + HUD. */
  color: number;
}

export const GUNS: Record<GunId, GunConfig> = {
  stinger: {
    id: 'stinger', name: 'Stinger', identity: 'Reliable spawn SMG',
    sustain: 'reload', damage: 8, pellets: 1, fireRate: 10,
    magSize: 30, reloadTime: 1.4,
    recoil: 1, projectileSpeed: 34, spread: 0.035, spreadGrowth: 0.004, spreadMax: 0.10,
    range: 26, color: 0xb8c4cc,
  },
  workhorse: {
    id: 'workhorse', name: 'Workhorse', identity: 'All-rounder AR',
    sustain: 'reload', damage: 15, pellets: 1, fireRate: 6,
    magSize: 25, reloadTime: 1.7,
    recoil: 3, projectileSpeed: 38, spread: 0.025, spreadGrowth: 0.006, spreadMax: 0.09,
    range: 32, color: 0xc9a86a,
  },
  maw: {
    id: 'maw', name: 'Maw', identity: 'Close-range shotgun; recoil = retreat tool',
    sustain: 'reload', damage: 8, pellets: 8, fireRate: 1.4,
    magSize: 6, reloadTime: 2.2,
    recoil: 14, projectileSpeed: 30, spread: 0.16, spreadGrowth: 0, spreadMax: 0.16,
    range: 11, color: 0xd96a3a,
  },
  hurricane: {
    id: 'hurricane', name: 'Hurricane', identity: 'Minigun; recoil = thruster',
    sustain: 'reload', damage: 10, pellets: 1, fireRate: 16,
    magSize: 120, reloadTime: 3.2, spinUp: 0.6,
    recoil: 5, projectileSpeed: 36, spread: 0.06, spreadGrowth: 0.002, spreadMax: 0.12,
    range: 28, color: 0x8aa0b8,
  },
  thumper: {
    id: 'thumper', name: 'Thumper', identity: 'Rocket launcher; self-launch tech',
    sustain: 'reload', damage: 70, pellets: 1, fireRate: 0.5,
    magSize: 1, reloadTime: 2.4,
    recoil: 40, projectileSpeed: 18, spread: 0.01, spreadGrowth: 0, spreadMax: 0.01,
    range: 36, splashRadius: 2.6, splashDamage: 70, splashImpulse: 22, color: 0xc24545,
  },
  ion: {
    id: 'ion', name: 'Ion', identity: 'Plasma repeater; overheats',
    sustain: 'heat', damage: 12, pellets: 1, fireRate: 8,
    heatPerShot: 0.055, coolRate: 0.45, overheatLockout: 1.6,
    recoil: 4, projectileSpeed: 32, spread: 0.03, spreadGrowth: 0.004, spreadMax: 0.10,
    range: 30, color: 0x57c8e8,
  },
  lance: {
    id: 'lance', name: 'Lance', identity: 'Charged railgun; huge single kick',
    sustain: 'heat', damage: 60, pellets: 1, fireRate: 1,
    heatPerShot: 0.34, coolRate: 0.30, overheatLockout: 2.0, chargeTime: 0.8,
    recoil: 22, projectileSpeed: 0, hitscan: true, spread: 0, spreadGrowth: 0, spreadMax: 0,
    range: 40, color: 0xb070ff,
  },
  pyre: {
    id: 'pyre', name: 'Pyre', identity: 'Flamethrower; ignites blood pools',
    sustain: 'heat', damage: 6, pellets: 1, fireRate: 14,
    heatPerShot: 0.022, coolRate: 0.5, overheatLockout: 1.8,
    recoil: 2, projectileSpeed: 12, spread: 0.12, spreadGrowth: 0, spreadMax: 0.12,
    range: 6.5, ignitesBlood: true, color: 0xff9030,
  },
};

/** Guns available as lobby starting picks (everything; scavenging covers the rest). */
export const STARTER_GUN: GunId = 'stinger';
export const ALL_GUN_IDS = Object.keys(GUNS) as GunId[];
