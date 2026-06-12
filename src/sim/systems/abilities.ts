import { dist, norm } from '../../core/math';
import { C } from '../../data/constants';
import { ABILITY, CLASSES, type AbilityId, type ClassConfig } from '../../data/classes';
import { BABO_GROUPS, BABO_GROUPS_PHASED, type GameSim } from '../sim';
import { BTN, type PlayerState } from '../types';

type AbilityCfg = ClassConfig['ability'];

interface Well {
  x: number;
  y: number;
  ttl: number;
  owner: number;
}

/** Per-sim bookkeeping (tests create many sims, so no bare module state). */
interface AbilityBook {
  /** Player ids whose duration/hold ability is currently engaged. */
  engaged: Set<number>;
  /** Dash: targets already bonked during the current dash (once per dash). */
  dashHits: Map<number, Set<number>>;
  wells: Well[];
}

const BOOKS = new WeakMap<GameSim, AbilityBook>();

function book(sim: GameSim): AbilityBook {
  let b = BOOKS.get(sim);
  if (!b) {
    b = { engaged: new Set(), dashHits: new Map(), wells: [] };
    BOOKS.set(sim, b);
  }
  return b;
}

/**
 * Class abilities (Space = BTN.ABILITY). See data/classes.ts ABILITY tuning.
 * - spider/grapple: hold to tether to wall along aim (raycastWalls), release to detach.
 * - juggernaut/dash: impulse along move dir (or aim if no move input), i-frames
 *   (invulnT) during, impact damage to enemies touched while dashing.
 * - bastion/fortify: fortifyActive for duration; applyImpulse already no-ops on it.
 * - phantom/phase: phaseActive for duration; collider groups → BABO_GROUPS_PHASED.
 * - trapper/gravityWell: spawn a well at aim point (clamped to WELL_RANGE) pulling
 *   babos within WELL_RADIUS toward it for `duration`.
 * Owns p.abilityCD / p.abilityT; emits 'abilityCast' events.
 */
export function abilitySystem(sim: GameSim, dt: number): void {
  const b = book(sim);

  for (const p of sim.players.values()) {
    if (p.abilityCD > 0) p.abilityCD = Math.max(0, p.abilityCD - dt);
    const ab = CLASSES[p.classId].ability;

    if (b.engaged.has(p.id)) {
      // Killed mid-ability: sim.kill cleared the flag — finish cleanup + cooldown
      // here (restores collision groups / restitution swapped at cast).
      if (!activeFlag(p, ab.id)) {
        endAbility(sim, b, p, ab);
        continue;
      }
      p.abilityT = Math.max(0, p.abilityT - dt);
      const held = (p.input.buttons & BTN.ABILITY) !== 0;
      if (p.abilityT <= 0 || (ab.id === 'grapple' && !held)) {
        endAbility(sim, b, p, ab);
        continue;
      }
      if (ab.id === 'dash') dashContacts(sim, b, p);
      continue;
    }

    // Idle: drain any leftover channel timer (gravity well HUD display).
    if (p.abilityT > 0) p.abilityT = Math.max(0, p.abilityT - dt);

    if (!p.alive || p.abilityCD > 0) continue;
    const pressed = (p.input.buttons & BTN.ABILITY) !== 0 && (p.prevButtons & BTN.ABILITY) === 0;
    if (pressed) cast(sim, b, p, ab);
  }

  tickWells(sim, b, dt);
}

// ---------------------------------------------------------------------------
// Cast / end
// ---------------------------------------------------------------------------

function cast(sim: GameSim, b: AbilityBook, p: PlayerState, ab: AbilityCfg): void {
  const cls = CLASSES[p.classId];
  switch (ab.id) {
    case 'grapple': {
      const x1 = p.x + Math.cos(p.aim) * ABILITY.GRAPPLE_RANGE;
      const y1 = p.y + Math.sin(p.aim) * ABILITY.GRAPPLE_RANGE;
      const t = sim.raycastWalls(p.x, p.y, x1, y1);
      if (t < 0) return; // no wall in range — no attach, no cooldown
      p.grappleActive = true;
      p.grappleX = p.x + (x1 - p.x) * t;
      p.grappleY = p.y + (y1 - p.y) * t;
      p.grappleLen = t * ABILITY.GRAPPLE_RANGE * ABILITY.GRAPPLE_ROPE_SLACK;
      p.abilityT = ab.duration;
      b.engaged.add(p.id);
      sim.emit({ t: 'abilityCast', player: p.id, ability: 'grapple', x: p.x, y: p.y, tx: p.grappleX, ty: p.grappleY });
      break;
    }
    case 'dash': {
      let [dx, dy] = norm(p.input.mx, p.input.my);
      if (dx === 0 && dy === 0) {
        dx = Math.cos(p.aim);
        dy = Math.sin(p.aim);
      }
      sim.applyImpulse(p, dx * ABILITY.DASH_SPEED * cls.mass, dy * ABILITY.DASH_SPEED * cls.mass);
      p.dashActive = true;
      p.abilityT = ab.duration;
      p.invulnT = Math.max(p.invulnT, ab.duration);
      setRestitution(sim, p.id, 0.9); // pinball off walls; restored at dash end
      b.engaged.add(p.id);
      b.dashHits.set(p.id, new Set());
      sim.emit({ t: 'abilityCast', player: p.id, ability: 'dash', x: p.x, y: p.y });
      dashContacts(sim, b, p); // contact damage starts on the cast tick
      break;
    }
    case 'fortify': {
      p.fortifyActive = true;
      p.abilityT = ab.duration;
      b.engaged.add(p.id);
      sim.emit({ t: 'abilityCast', player: p.id, ability: 'fortify', x: p.x, y: p.y });
      break;
    }
    case 'phase': {
      p.phaseActive = true;
      p.abilityT = ab.duration;
      setGroups(sim, p.id, BABO_GROUPS_PHASED);
      b.engaged.add(p.id);
      sim.emit({ t: 'abilityCast', player: p.id, ability: 'phase', x: p.x, y: p.y });
      break;
    }
    case 'gravityWell': {
      const reach = Math.min(p.input.aimDist, ABILITY.WELL_RANGE);
      const wx = p.x + Math.cos(p.aim) * reach;
      const wy = p.y + Math.sin(p.aim) * reach;
      b.wells.push({ x: wx, y: wy, ttl: ab.duration, owner: p.id });
      p.abilityT = ab.duration; // channel display only; the well outlives the caster
      p.abilityCD = ab.cooldown;
      sim.emit({ t: 'abilityCast', player: p.id, ability: 'gravityWell', x: p.x, y: p.y, tx: wx, ty: wy });
      break;
    }
  }
}

function endAbility(sim: GameSim, b: AbilityBook, p: PlayerState, ab: AbilityCfg): void {
  b.engaged.delete(p.id);
  p.abilityT = 0;
  p.abilityCD = ab.cooldown;
  switch (ab.id) {
    case 'grapple':
      p.grappleActive = false;
      break;
    case 'dash':
      p.dashActive = false;
      setRestitution(sim, p.id, 0.45);
      b.dashHits.delete(p.id);
      break;
    case 'fortify':
      p.fortifyActive = false;
      break;
    case 'phase':
      p.phaseActive = false;
      setGroups(sim, p.id, BABO_GROUPS);
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Per-tick effects
// ---------------------------------------------------------------------------

/** Dash impact: damage + shove each enemy at most once per dash. */
function dashContacts(sim: GameSim, b: AbilityBook, p: PlayerState): void {
  if (!p.alive) return;
  const hits = b.dashHits.get(p.id);
  if (!hits) return;
  for (const other of sim.players.values()) {
    if (other.id === p.id || !other.alive || hits.has(other.id)) continue;
    if (p.team !== -1 && other.team === p.team) continue; // no friendly bonks
    if (dist(p.x, p.y, other.x, other.y) > 2.2 * C.BABO_RADIUS) continue;
    hits.add(other.id);
    let [nx, ny] = norm(other.x - p.x, other.y - p.y);
    if (nx === 0 && ny === 0) {
      nx = Math.cos(p.aim);
      ny = Math.sin(p.aim);
    }
    sim.applyImpulse(other, nx * ABILITY.DASH_IMPACT_IMPULSE, ny * ABILITY.DASH_IMPACT_IMPULSE);
    sim.damage(other, p.id, ABILITY.DASH_IMPACT_DAMAGE, 'world');
    sim.emit({ t: 'dashImpact', attacker: p.id, target: other.id, x: other.x, y: other.y });
  }
}

/** Pull every other alive babo toward each live well (fortify is immune). */
function tickWells(sim: GameSim, b: AbilityBook, dt: number): void {
  if (b.wells.length === 0) return;
  for (const w of b.wells) {
    for (const other of sim.players.values()) {
      if (!other.alive || other.id === w.owner) continue;
      const d = dist(w.x, w.y, other.x, other.y);
      if (d >= ABILITY.WELL_RADIUS) continue;
      const [nx, ny] = norm(w.x - other.x, w.y - other.y);
      const f = ABILITY.WELL_FORCE * CLASSES[other.classId].mass * (1 - d / ABILITY.WELL_RADIUS);
      sim.applyImpulse(other, nx * f * dt, ny * f * dt); // force integrated over the tick
    }
    w.ttl -= dt;
  }
  b.wells = b.wells.filter((w) => w.ttl > 0);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function activeFlag(p: PlayerState, id: AbilityId): boolean {
  switch (id) {
    case 'grapple': return p.grappleActive;
    case 'dash': return p.dashActive;
    case 'fortify': return p.fortifyActive;
    case 'phase': return p.phaseActive;
    default: return false; // gravityWell never engages
  }
}

function setRestitution(sim: GameSim, id: number, value: number): void {
  const body = sim.bodies.get(id);
  if (body && body.numColliders() > 0) body.collider(0).setRestitution(value);
}

function setGroups(sim: GameSim, id: number, groups: number): void {
  const body = sim.bodies.get(id);
  if (body && body.numColliders() > 0) body.collider(0).setCollisionGroups(groups);
}
