import type { ClassId } from '../data/classes';
import type { EquipKind } from '../data/equipment';
import type { GunId } from '../data/weapons';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export const BTN = {
  FIRE: 1,
  THROW: 2,
  ABILITY: 4,
  PICKUP: 8,
  RELOAD: 16,
} as const;

export interface PlayerInput {
  /** Movement intent, each in [-1, 1]; normalized by the sim if needed. */
  mx: number;
  my: number;
  /** Aim angle in radians (world space, atan2 convention). */
  aim: number;
  /** Distance from player to the crosshair ground point (world units). */
  aimDist: number;
  /** Bitfield of BTN. */
  buttons: number;
  /** Client sequence number (used by netcode prediction). */
  seq: number;
}

export function emptyInput(): PlayerInput {
  return { mx: 0, my: 0, aim: 0, aimDist: 0, buttons: 0, seq: 0 };
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

export type Team = 0 | 1 | -1; // -1 = FFA (no team)

export interface PlayerState {
  id: number;
  name: string;
  classId: ClassId;
  team: Team;
  bot: boolean;

  // Kinematics (mirrored from the physics body each tick)
  x: number;
  y: number;
  vx: number;
  vy: number;
  aim: number;

  // Vital state
  hp: number;
  alive: boolean;
  respawnT: number;
  invulnT: number;
  /** Spawn protection: while true you also can't DEAL damage; any attack breaks it. */
  spawnProt: boolean;

  // Weapon state
  gun: GunId;
  /** Lobby-picked weapon — restored on every respawn (scavenged guns are lost on death). */
  chosenGun: GunId;
  mag: number;          // reload guns: rounds left
  reloadT: number;      // >0 while reloading
  heat: number;         // heat guns: 0..1
  overheatT: number;    // >0 while locked out
  spin: number;         // hurricane spin-up progress 0..1
  charge: number;       // lance charge progress 0..1
  fireCD: number;       // time until next shot allowed
  spreadAcc: number;    // accumulated extra spread

  // Equipment
  grenades: number;     // frag count
  equip: EquipKind | null; // secondary picked from map nodes
  equipCount: number;
  throwT: number;       // >0 while RMB held (arc aiming); scales range
  throwing: boolean;

  // Ability
  abilityCD: number;
  abilityT: number;     // active time remaining (dash/fortify/phase/well-channel)
  grappleActive: boolean;
  grappleX: number;
  grappleY: number;
  grappleLen: number;
  fortifyActive: boolean;
  phaseActive: boolean;
  dashActive: boolean;

  // Status
  burnT: number;        // burning DoT remaining
  burnTick: number;
  dripT: number;        // wounded-trail drip timer
  inSlick: boolean;     // overlapping a slick pool this tick

  // Score
  kills: number;
  deaths: number;
  score: number;
  bounty: number;       // High Bounty heat
  carryingFlag: -1 | 0 | 1; // which team's flag this player carries

  input: PlayerInput;
  prevButtons: number;  // for edge detection
  lastAckSeq: number;   // last input seq applied (net)
}

// ---------------------------------------------------------------------------
// World entities
// ---------------------------------------------------------------------------

export type ProjectileKind = 'bullet' | 'rocket' | 'flame' | 'rail';

export interface Projectile {
  id: number;
  kind: ProjectileKind;
  gun: GunId;
  owner: number;        // player id
  team: Team;
  x: number;
  y: number;
  /** Spawn origin (muzzle) — captured so the terminal rail beam draws from the muzzle. */
  ox: number;
  oy: number;
  vx: number;
  vy: number;
  damage: number;
  dist: number;         // traveled
  maxDist: number;
}

export interface Grenade {
  id: number;
  kind: EquipKind;
  owner: number;
  team: Team;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Cosmetic height + vertical velocity; airborne (z>0) clears walls. */
  z: number;
  vz: number;
  landed: boolean;
  fuse: number;
}

export interface BloodPool {
  id: number;
  x: number;
  y: number;
  r: number;
  age: number;
  maxAge: number;
}

export interface FireZone {
  id: number;
  x: number;
  y: number;
  r: number;
  ttl: number;
}

export interface SmokeZone {
  id: number;
  x: number;
  y: number;
  r: number;
  ttl: number;
}

export type PickupKind = 'gun' | 'health' | 'equip';

export interface Pickup {
  id: number;
  kind: PickupKind;
  gun?: GunId;
  equip?: EquipKind;
  x: number;
  y: number;
  /** Index into map equipmentNodes/healthNodes for respawning node pickups; -1 for drops. */
  nodeIdx: number;
  nodeKind?: 'equip' | 'health';
  ttl: number; // drops expire; node pickups have ttl=Infinity
}

export interface FlagState {
  team: 0 | 1;
  x: number;
  y: number;
  /** 'base' | 'carried' | 'dropped' */
  state: 'base' | 'carried' | 'dropped';
  carrier: number; // player id when carried
  returnT: number; // auto-return countdown when dropped
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

export type ModeId = 'tdm' | 'bounty' | 'ctf';

export interface ModeState {
  mode: ModeId;
  timeLeft: number;
  scoreLimit: number;
  teamScores: [number, number]; // tdm frags / ctf caps
  leaderId: number;             // bounty: current marked leader (-1 none)
  flags: FlagState[];           // ctf only
  ended: boolean;
  /** Winner: team index for team modes, player id for bounty, -1 for draw. */
  winner: number;
}

// ---------------------------------------------------------------------------
// Events (sim → render/audio/net). Drained each tick.
// ---------------------------------------------------------------------------

export type GameEvent =
  | { t: 'shot'; player: number; gun: GunId; x: number; y: number; aim: number }
  | { t: 'hit'; target: number; attacker: number; damage: number; x: number; y: number }
  | { t: 'hitWall'; x: number; y: number; gun: GunId }
  | { t: 'death'; victim: number; killer: number; x: number; y: number; gun: GunId | 'world' }
  | { t: 'respawn'; player: number; x: number; y: number }
  | { t: 'reloadStart'; player: number; gun: GunId }
  | { t: 'reloadDone'; player: number }
  | { t: 'overheat'; player: number }
  | { t: 'spinup'; player: number; on: boolean }
  | { t: 'chargeReady'; player: number }
  | { t: 'rail'; x0: number; y0: number; x1: number; y1: number; owner: number }
  | { t: 'grenadeThrow'; player: number; kind: EquipKind; x: number; y: number }
  | { t: 'grenadeBounce'; x: number; y: number }
  | { t: 'explosion'; x: number; y: number; r: number; kind: 'frag' | 'rocket' }
  | { t: 'fireIgnite'; x: number; y: number; r: number }
  | { t: 'smokePop'; x: number; y: number; r: number }
  | { t: 'splat'; x: number; y: number; size: number; dirX: number; dirY: number }
  | { t: 'poolSpawn'; id: number; x: number; y: number; r: number }
  | { t: 'poolGone'; id: number }
  | { t: 'pop'; player: number; x: number; y: number } // death gore burst
  | { t: 'pickup'; player: number; kind: PickupKind; gun?: GunId; equip?: EquipKind }
  | { t: 'gunDrop'; x: number; y: number; gun: GunId }
  | { t: 'abilityCast'; player: number; ability: string; x: number; y: number; tx?: number; ty?: number }
  | { t: 'dashImpact'; attacker: number; target: number; x: number; y: number }
  | { t: 'burn'; player: number }
  | { t: 'flagTaken'; team: 0 | 1; by: number }
  | { t: 'flagDropped'; team: 0 | 1; x: number; y: number }
  | { t: 'flagReturned'; team: 0 | 1 }
  | { t: 'flagCapped'; team: 0 | 1; by: number }
  | { t: 'leaderChange'; player: number }
  | { t: 'leaderKilled'; killer: number; victim: number }
  | { t: 'matchEnd'; winner: number };

// ---------------------------------------------------------------------------
// Snapshot (host → clients)
// ---------------------------------------------------------------------------

export interface Snapshot {
  tick: number;
  players: PlayerState[];
  projectiles: Projectile[];
  grenades: Grenade[];
  pools: BloodPool[];
  fires: FireZone[];
  smokes: SmokeZone[];
  pickups: Pickup[];
  mode: ModeState;
}

export interface SimOptions {
  mapId: string;
  mode: ModeId;
  seed: number;
  scoreLimit?: number;
  timeLimit?: number;
}
