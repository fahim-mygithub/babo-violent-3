import type RAPIER_NS from '@dimforge/rapier2d-compat';
import { dist, distSq, normInto, segAABB, segCircle } from '../core/math';
import { RNG } from '../core/rng';
import { C } from '../data/constants';
import { CLASSES, type ClassId } from '../data/classes';
import { GUNS, STARTER_GUN, type GunId } from '../data/weapons';
import type { EquipKind } from '../data/equipment';
import { MAPS, type MapDef } from '../data/maps';
import {
  emptyInput,
  type BloodPool, type FireZone, type GameEvent, type Grenade, type ModeState,
  type Pickup, type PlayerInput, type PlayerState, type Projectile, type SimOptions,
  type SmokeZone, type Snapshot, type Team,
} from './types';
import { movementSystem } from './systems/movement';
import { abilitySystem } from './systems/abilities';
import { weaponSystem } from './systems/weapons';
import { projectileSystem } from './systems/projectiles';
import { grenadeSystem } from './systems/grenades';
import { bloodSystem } from './systems/blood';
import { pickupSystem } from './systems/pickups';
import { modeSystem } from './systems/modes';
import { botSystem } from './systems/bots';

// Lazily-bound runtime ref. @dimforge/rapier2d-compat inlines its WASM as base64
// and exposes an async init() that instantiates it. Because initPhysics() dynamic-
// imports the compat module, rollup keeps it (WASM and all) in a deferred chunk —
// the menu loads without Rapier. init() MUST complete before any World/Desc use.
let RAPIER: typeof RAPIER_NS;

let rapierReady = false;
let initPromise: Promise<void> | null = null;

/** Must be awaited once before constructing any GameSim. Idempotent + retryable. */
export function initPhysics(): Promise<void> {
  if (rapierReady) return Promise.resolve();
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const mod = await import('@dimforge/rapier2d-compat');
    const R = mod.default ?? mod;
    await R.init();
    RAPIER = R;
    rapierReady = true;
  })().catch((e) => { initPromise = null; throw e; });                     // reset for retry
  return initPromise;
}

// Module-scope scratch for normInto() at hot sim sites. Single-threaded sim;
// each result is consumed immediately into locals before the next normInto call.
const _n: [number, number] = [0, 0];

export const GROUP_WALL = 0x0001;
export const GROUP_BABO = 0x0002;
const groups = (memberships: number, filter: number) => (memberships << 16) | filter;
export const BABO_GROUPS = groups(GROUP_BABO, GROUP_WALL | GROUP_BABO);
export const BABO_GROUPS_PHASED = groups(GROUP_BABO, GROUP_WALL);

export interface DeathRecord {
  victim: number;
  killer: number;
  gun: GunId | 'world';
}

export class GameSim {
  readonly dt = 1 / C.SIM_HZ;
  tick = 0;

  readonly world: RAPIER_NS.World;
  readonly map: MapDef;
  readonly rng: RNG;
  readonly mode: ModeState;

  readonly players = new Map<number, PlayerState>();
  readonly bodies = new Map<number, RAPIER_NS.RigidBody>();
  projectiles: Projectile[] = [];
  grenades: Grenade[] = [];
  pools: BloodPool[] = [];
  fires: FireZone[] = [];
  smokes: SmokeZone[] = [];
  pickups: Pickup[] = [];

  /** Drained by the caller (render/audio/net) after each step. */
  events: GameEvent[] = [];
  /** Deaths this tick, consumed by modeSystem at end of step. */
  deathsThisTick: DeathRecord[] = [];

  private nextEntityId = 1;
  private nextPlayerId = 0;

  constructor(opts: SimOptions) {
    if (!rapierReady) throw new Error('initPhysics() must be awaited before constructing GameSim');
    this.map = MAPS[opts.mapId] ?? MAPS.grinder;
    this.rng = new RNG(opts.seed);
    this.world = new RAPIER.World({ x: 0, y: 0 });
    this.world.timestep = this.dt;

    for (const w of this.map.walls) {
      const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(w.x, w.y));
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(w.w / 2, w.h / 2)
          .setCollisionGroups(groups(GROUP_WALL, 0xffff))
          .setRestitution(0.3),
        body,
      );
    }

    this.mode = {
      mode: opts.mode,
      timeLeft: opts.timeLimit ?? (opts.mode === 'tdm' ? C.TDM_TIME_LIMIT : opts.mode === 'ctf' ? C.CTF_TIME_LIMIT : C.BOUNTY_TIME_LIMIT),
      scoreLimit: opts.scoreLimit ?? (opts.mode === 'tdm' ? C.TDM_FRAG_LIMIT : opts.mode === 'ctf' ? C.CTF_CAP_LIMIT : C.BOUNTY_WIN_SCORE),
      teamScores: [0, 0],
      leaderId: -1,
      flags: opts.mode === 'ctf' && this.map.flags
        ? ([0, 1] as const).map((team) => ({
            team,
            x: team === 0 ? this.map.flags!.team0.x : this.map.flags!.team1.x,
            y: team === 0 ? this.map.flags!.team0.y : this.map.flags!.team1.y,
            state: 'base' as const,
            carrier: -1,
            returnT: 0,
          }))
        : [],
      ended: false,
      winner: -1,
    };

    this.initNodePickups();
  }

  // -------------------------------------------------------------------------
  // Player management
  // -------------------------------------------------------------------------

  addPlayer(name: string, classId: ClassId, team: Team, bot: boolean, gun: GunId = STARTER_GUN): PlayerState {
    const id = this.nextPlayerId++;
    const cls = CLASSES[classId];
    const p: PlayerState = {
      id, name, classId, team, bot,
      x: 0, y: 0, vx: 0, vy: 0, aim: 0,
      hp: C.MAX_HP, alive: false, respawnT: 0.01, invulnT: 0, spawnProt: false,
      gun, chosenGun: gun, mag: GUNS[gun].magSize ?? 0, reloadT: 0, heat: 0, overheatT: 0,
      spin: 0, charge: 0, fireCD: 0, spreadAcc: 0,
      grenades: C.START_GRENADES, equip: null, equipCount: 0, throwT: 0, throwing: false,
      abilityCD: 0, abilityT: 0,
      grappleActive: false, grappleX: 0, grappleY: 0, grappleLen: 0,
      fortifyActive: false, phaseActive: false, dashActive: false,
      burnT: 0, burnTick: 0, dripT: 0, inSlick: false,
      kills: 0, deaths: 0, score: 0, bounty: 0, carryingFlag: -1,
      input: emptyInput(), prevButtons: 0, lastAckSeq: 0,
    };
    this.players.set(id, p);

    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(0, 0)
        .setLinearDamping(cls.linearDamping)
        .setCcdEnabled(C.PLAYER_CCD),
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.ball(C.BABO_RADIUS)
        .setMass(cls.mass)
        .setRestitution(0.45)
        .setFriction(0.2)
        .setCollisionGroups(BABO_GROUPS),
      body,
    );
    body.setEnabled(false);
    this.bodies.set(id, body);
    return p;
  }

  removePlayer(id: number): void {
    const body = this.bodies.get(id);
    if (body) this.world.removeRigidBody(body);
    this.bodies.delete(id);
    const p = this.players.get(id);
    if (p && p.carryingFlag !== -1) this.dropFlag(p);
    this.players.delete(id);
  }

  setInput(id: number, input: PlayerInput): void {
    const p = this.players.get(id);
    if (p) p.input = input;
  }

  // -------------------------------------------------------------------------
  // Step pipeline
  // -------------------------------------------------------------------------

  step(): void {
    if (this.mode.ended) return;
    const dt = this.dt;
    this.tick++;

    botSystem(this, dt);
    movementSystem(this, dt);
    abilitySystem(this, dt);
    weaponSystem(this, dt);
    projectileSystem(this, dt);
    grenadeSystem(this, dt);
    bloodSystem(this, dt);
    pickupSystem(this, dt);

    this.world.step();

    // Mirror physics → state
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const body = this.bodies.get(p.id)!;
      const tr = body.translation();
      const v = body.linvel();
      p.x = tr.x; p.y = tr.y; p.vx = v.x; p.vy = v.y;
      p.aim = p.input.aim;
    }

    modeSystem(this, dt);
    this.deathsThisTick.length = 0;

    // Edge-detection bookkeeping (after all systems have seen this tick's input)
    for (const p of this.players.values()) p.prevButtons = p.input.buttons;
  }

  // -------------------------------------------------------------------------
  // Combat helpers (used by systems)
  // -------------------------------------------------------------------------

  emit(ev: GameEvent): void {
    this.events.push(ev);
  }

  /**
   * Ray vs map walls. Returns t in [0,1] along (x0,y0)→(x1,y1), or -1 if clear.
   */
  raycastWalls(x0: number, y0: number, x1: number, y1: number): number {
    let best = -1;
    for (const w of this.map.walls) {
      const t = segAABB(x0, y0, x1, y1, w.x, w.y, w.w, w.h);
      if (t >= 0 && (best < 0 || t < best)) best = t;
    }
    return best;
  }

  /** Line of sight: blocked by walls and smoke zones. */
  hasLOS(ax: number, ay: number, bx: number, by: number): boolean {
    if (this.raycastWalls(ax, ay, bx, by) >= 0) return false;
    for (const s of this.smokes) {
      if (segCircle(ax, ay, bx, by, s.x, s.y, s.r) >= 0) return false;
    }
    return true;
  }

  /** Impulse respecting Fortify (immune) and class mass (rapier handles mass). */
  applyImpulse(p: PlayerState, ix: number, iy: number): void {
    if (!p.alive || p.fortifyActive) return;
    const body = this.bodies.get(p.id);
    if (body) body.applyImpulse({ x: ix, y: iy }, true);
  }

  /**
   * Deal damage. Returns actual damage dealt (0 if immune).
   * attacker -1 = world (fire, etc).
   */
  damage(target: PlayerState, attacker: number, amount: number, gun: GunId | 'world'): number {
    if (!target.alive || target.invulnT > 0 || target.phaseActive) return 0;
    const atk = attacker >= 0 ? this.players.get(attacker) : undefined;
    if (atk && atk.spawnProt) return 0; // spawn-protected babos can't deal damage either
    if (atk && atk.id !== target.id && atk.team !== -1 && atk.team === target.team) return 0; // no friendly fire
    let dmg = amount;
    if (atk && atk.id === target.id) dmg *= 0.35; // self-damage discount enables rocket-jump tech
    target.hp -= dmg;
    if (atk && atk.id !== target.id) {
      this.emit({ t: 'hit', target: target.id, attacker, damage: dmg, x: target.x, y: target.y });
    }
    // Damage splatter scales with the hit
    let dx = 0, dy = 0;
    if (atk) { normInto(target.x - atk.x, target.y - atk.y, _n); dx = _n[0]; dy = _n[1]; }
    this.emit({ t: 'splat', x: target.x, y: target.y, size: 0.25 + dmg * 0.012, dirX: dx, dirY: dy });
    if (target.hp <= 0) this.kill(target, attacker, gun);
    return dmg;
  }

  kill(victim: PlayerState, killer: number, gun: GunId | 'world'): void {
    if (!victim.alive) return;
    victim.alive = false;
    victim.hp = 0;
    victim.deaths++;
    victim.respawnT = C.RESPAWN_DELAY;
    victim.grappleActive = false;
    victim.fortifyActive = false;
    victim.phaseActive = false;
    victim.dashActive = false;
    victim.abilityT = 0;
    victim.burnT = 0;
    const body = this.bodies.get(victim.id)!;
    body.setEnabled(false);

    if (victim.carryingFlag !== -1) this.dropFlag(victim);

    // Death pop: impulse + gore + loot
    this.emit({ t: 'death', victim: victim.id, killer, x: victim.x, y: victim.y, gun });
    this.emit({ t: 'pop', player: victim.id, x: victim.x, y: victim.y });
    this.emit({ t: 'splat', x: victim.x, y: victim.y, size: 1.6, dirX: 0, dirY: 0 });
    for (const other of this.players.values()) {
      if (!other.alive || other.id === victim.id) continue;
      const d = dist(victim.x, victim.y, other.x, other.y);
      if (d < C.DEATH_POP_RADIUS) {
        normInto(other.x - victim.x, other.y - victim.y, _n);
        const nx = _n[0], ny = _n[1];
        const falloff = 1 - d / C.DEATH_POP_RADIUS;
        this.applyImpulse(other, nx * C.DEATH_POP_IMPULSE * falloff, ny * C.DEATH_POP_IMPULSE * falloff);
      }
    }
    this.spawnPool(victim.x, victim.y, C.DEATH_POOL_RADIUS);
    this.dropPickup('gun', victim.x - 0.5, victim.y, victim.gun);
    this.dropPickup('health', victim.x + 0.5, victim.y);
    this.deathsThisTick.push({ victim: victim.id, killer, gun });
  }

  respawn(p: PlayerState): void {
    const spawn = this.findSpawnPoint(p.team);
    p.alive = true;
    p.hp = C.MAX_HP;
    p.respawnT = 0;
    p.invulnT = C.SPAWN_INVULN;
    p.spawnProt = true;
    p.x = spawn.x; p.y = spawn.y; p.vx = 0; p.vy = 0;
    p.gun = p.chosenGun; // lobby loadout returns; scavenged guns are lost on death
    p.mag = GUNS[p.gun].magSize ?? 0;
    p.reloadT = 0; p.heat = 0; p.overheatT = 0; p.spin = 0; p.charge = 0;
    p.fireCD = 0; p.spreadAcc = 0;
    p.grenades = C.START_GRENADES;
    p.burnT = 0;
    const body = this.bodies.get(p.id)!;
    body.setEnabled(true);
    body.setTranslation({ x: spawn.x, y: spawn.y }, true);
    body.setLinvel({ x: 0, y: 0 }, true);
    this.emit({ t: 'respawn', player: p.id, x: spawn.x, y: spawn.y });
  }

  /** Spawn point farthest from living enemies, with slight jitter. */
  findSpawnPoint(team: Team): { x: number; y: number } {
    const list = team === 0 ? this.map.spawns.team0 : team === 1 ? this.map.spawns.team1 : this.map.spawns.ffa;
    let best = list[0];
    let bestScore = -1;
    for (const s of list) {
      let minD = 999;
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        if (team !== -1 && p.team === team) continue;
        minD = Math.min(minD, dist(s.x, s.y, p.x, p.y));
      }
      const score = minD + this.rng.next() * 2;
      if (score > bestScore) { bestScore = score; best = s; }
    }
    return { x: best.x + this.rng.spread(0.5), y: best.y + this.rng.spread(0.5) };
  }

  /** Radial explosion: damage + knockback with falloff, blocked by walls. */
  explode(x: number, y: number, radius: number, dmg: number, impulse: number, owner: number, kind: 'frag' | 'rocket', gun: GunId | 'world'): void {
    this.emit({ t: 'explosion', x, y, r: radius, kind });
    this.emit({ t: 'splat', x, y, size: radius * 0.5, dirX: 0, dirY: 0 });
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const d = dist(x, y, p.x, p.y);
      if (d > radius + C.BABO_RADIUS) continue;
      if (this.raycastWalls(x, y, p.x, p.y) >= 0) continue; // wall shields
      const falloff = Math.max(0.25, 1 - d / radius);
      normInto(p.x - x, p.y - y, _n);
      const nx = _n[0], ny = _n[1];
      this.applyImpulse(p, nx * impulse * falloff, ny * impulse * falloff);
      this.damage(p, owner, dmg * falloff, gun);
    }
  }

  // -------------------------------------------------------------------------
  // Entities
  // -------------------------------------------------------------------------

  newId(): number {
    return this.nextEntityId++;
  }

  spawnPool(x: number, y: number, r: number): void {
    if (r < C.MIN_PHYSICAL_POOL_RADIUS) return; // visual-only splat, no physics
    // Merge into an overlapping existing pool instead of stacking
    for (const pool of this.pools) {
      if (dist(x, y, pool.x, pool.y) < pool.r * 0.7) {
        pool.r = Math.min(2.6, Math.max(pool.r, r) + 0.25);
        pool.age = 0;
        return;
      }
    }
    const pool: BloodPool = { id: this.newId(), x, y, r, age: 0, maxAge: C.POOL_LIFETIME };
    this.pools.push(pool);
    // Enforce cap: demote oldest to visual-only
    if (this.pools.length > C.SLICK_ZONE_CAP) {
      this.pools.sort((a, b) => a.age - b.age);
      const removed = this.pools.pop()!;
      this.emit({ t: 'poolGone', id: removed.id });
    }
    this.emit({ t: 'poolSpawn', id: pool.id, x, y, r });
  }

  spawnFire(x: number, y: number, r: number): void {
    this.fires.push({ id: this.newId(), x, y, r, ttl: C.FIRE_ZONE_LIFETIME });
    this.emit({ t: 'fireIgnite', x, y, r });
  }

  dropPickup(kind: 'gun' | 'health' | 'equip', x: number, y: number, gun?: GunId, equip?: EquipKind): void {
    this.pickups.push({
      id: this.newId(), kind, gun, equip,
      x: x + this.rng.spread(0.3), y: y + this.rng.spread(0.3),
      nodeIdx: -1, ttl: C.CORPSE_DROP_TTL,
    });
    if (kind === 'gun' && gun) this.emit({ t: 'gunDrop', x, y, gun });
  }

  private initNodePickups(): void {
    this.map.equipmentNodes.forEach((node, i) => {
      this.pickups.push({
        id: this.newId(), kind: 'equip', equip: node.kind,
        x: node.x, y: node.y, nodeIdx: i, nodeKind: 'equip', ttl: Infinity,
      });
    });
    this.map.healthNodes.forEach((node, i) => {
      this.pickups.push({
        id: this.newId(), kind: 'health',
        x: node.x, y: node.y, nodeIdx: i, nodeKind: 'health', ttl: Infinity,
      });
    });
  }

  dropFlag(p: PlayerState): void {
    const flag = this.mode.flags.find((f) => f.team === p.carryingFlag);
    if (flag) {
      flag.state = 'dropped';
      flag.x = p.x; flag.y = p.y;
      flag.carrier = -1;
      flag.returnT = C.FLAG_RETURN_TIME;
      this.emit({ t: 'flagDropped', team: flag.team, x: p.x, y: p.y });
    }
    p.carryingFlag = -1;
  }

  playersInRadius(x: number, y: number, r: number): PlayerState[] {
    const out: PlayerState[] = [];
    for (const p of this.players.values()) {
      if (p.alive && distSq(x, y, p.x, p.y) <= r * r) out.push(p);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Snapshot (deep copy for netcode)
  // -------------------------------------------------------------------------

  snapshot(): Snapshot {
    return {
      tick: this.tick,
      players: [...this.players.values()].map((p) => ({ ...p, input: { ...p.input } })),
      projectiles: this.projectiles.map((e) => ({ ...e })),
      grenades: this.grenades.map((e) => ({ ...e })),
      pools: this.pools.map((e) => ({ ...e })),
      fires: this.fires.map((e) => ({ ...e })),
      smokes: this.smokes.map((e) => ({ ...e })),
      pickups: this.pickups.map((e) => ({ ...e })),
      mode: { ...this.mode, teamScores: [...this.mode.teamScores], flags: this.mode.flags.map((f) => ({ ...f })) },
    };
  }
}
