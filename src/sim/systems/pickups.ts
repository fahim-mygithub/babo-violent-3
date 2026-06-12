import { dist } from '../../core/math';
import { C } from '../../data/constants';
import { GUNS } from '../../data/weapons';
import type { GameSim } from '../sim';
import { BTN, type Pickup, type PlayerState } from '../types';

/**
 * Loot loop.
 * - Health/equipment: auto-pickup on contact (C.PICKUP_RADIUS). Health heals
 *   C.HEALTH_PACK_HEAL (no overheal, skip if full). Equipment: frag → grenades++,
 *   molotov/smoke → p.equip/equipCount (replaces if different kind).
 * - Guns: require BTN.PICKUP edge within C.GUN_PICKUP_RADIUS; swap — drop
 *   current gun as a new pickup, take new with full mag / zero heat.
 * - Node pickups (nodeIdx >= 0): on taken, schedule respawn after
 *   C.EQUIPMENT_RESPAWN (tracked per sim, keyed '<nodeKind>:<nodeIdx>').
 * - Drops expire by ttl.
 * - Emit 'pickup' events.
 */

/** Node respawn countdowns per sim, keyed '<nodeKind>:<nodeIdx>'. */
const nodeTimers = new WeakMap<GameSim, Map<string, number>>();

function timersFor(sim: GameSim): Map<string, number> {
  let timers = nodeTimers.get(sim);
  if (!timers) {
    timers = new Map();
    nodeTimers.set(sim, timers);
  }
  return timers;
}

/** If the pickup came from a map node, start its respawn countdown. */
function scheduleRespawn(timers: Map<string, number>, pk: Pickup): void {
  if (pk.nodeIdx < 0 || !pk.nodeKind) return;
  timers.set(`${pk.nodeKind}:${pk.nodeIdx}`, C.EQUIPMENT_RESPAWN);
}

/** Recreate a node pickup from the map definition (ttl Infinity). */
function respawnNode(sim: GameSim, key: string): void {
  const sep = key.indexOf(':');
  const nodeKind = key.slice(0, sep) as 'equip' | 'health';
  const nodeIdx = Number(key.slice(sep + 1));
  if (nodeKind === 'equip') {
    const node = sim.map.equipmentNodes[nodeIdx];
    if (!node) return;
    sim.pickups.push({
      id: sim.newId(), kind: 'equip', equip: node.kind,
      x: node.x, y: node.y, nodeIdx, nodeKind, ttl: Infinity,
    });
  } else {
    const node = sim.map.healthNodes[nodeIdx];
    if (!node) return;
    sim.pickups.push({
      id: sim.newId(), kind: 'health',
      x: node.x, y: node.y, nodeIdx, nodeKind, ttl: Infinity,
    });
  }
}

/** Contact pickup (health/equipment). Returns true if consumed. */
function autoTake(sim: GameSim, p: PlayerState, pk: Pickup): boolean {
  if (pk.kind === 'health') {
    if (p.hp >= C.MAX_HP) return false; // no overheal — leave it on the ground
    p.hp = Math.min(C.MAX_HP, p.hp + C.HEALTH_PACK_HEAL);
    sim.emit({ t: 'pickup', player: p.id, kind: 'health' });
    return true;
  }
  const kind = pk.equip;
  if (!kind) return false;
  if (kind === 'frag') {
    if (p.grenades >= C.GRENADE_CAP) return false;
    p.grenades++;
  } else if (p.equip === kind) {
    if (p.equipCount >= C.EQUIP_CAP) return false;
    p.equipCount++;
  } else if (p.equipCount > 0) {
    return false; // never silently discard a held special — leave it on the pad
  } else {
    p.equip = kind;
    p.equipCount = 1;
  }
  sim.emit({ t: 'pickup', player: p.id, kind: 'equip', equip: kind });
  return true;
}

export function pickupSystem(sim: GameSim, dt: number): void {
  const timers = timersFor(sim);

  // Drop expiry (node pickups carry ttl=Infinity and never expire)
  for (let i = sim.pickups.length - 1; i >= 0; i--) {
    const pk = sim.pickups[i];
    if (!Number.isFinite(pk.ttl)) continue;
    pk.ttl -= dt;
    if (pk.ttl <= 0) sim.pickups.splice(i, 1);
  }

  // Node respawns
  for (const [key, t] of timers) {
    const left = t - dt;
    if (left > 0) {
      timers.set(key, left);
      continue;
    }
    timers.delete(key);
    respawnNode(sim, key);
  }

  for (const p of sim.players.values()) {
    if (!p.alive) continue;

    // Auto-pickup on contact: health + equipment
    for (let i = sim.pickups.length - 1; i >= 0; i--) {
      const pk = sim.pickups[i];
      if (pk.kind === 'gun') continue;
      if (dist(p.x, p.y, pk.x, pk.y) >= C.PICKUP_RADIUS) continue;
      if (!autoTake(sim, p, pk)) continue;
      scheduleRespawn(timers, pk);
      sim.pickups.splice(i, 1);
    }

    // Gun swap: nearest gun in reach on a PICKUP press edge
    const pressed = (p.input.buttons & BTN.PICKUP) !== 0 && (p.prevButtons & BTN.PICKUP) === 0;
    if (!pressed) continue;
    let best = -1;
    let bestD: number = C.GUN_PICKUP_RADIUS;
    for (let i = 0; i < sim.pickups.length; i++) {
      const pk = sim.pickups[i];
      if (pk.kind !== 'gun' || !pk.gun) continue;
      const d = dist(p.x, p.y, pk.x, pk.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best < 0) continue;
    const pk = sim.pickups[best];
    sim.dropPickup('gun', p.x, p.y, p.gun); // old gun stays scavengeable
    p.gun = pk.gun!;
    p.mag = GUNS[p.gun].magSize ?? 0; // heat guns carry no mag
    p.heat = 0;
    p.reloadT = 0;
    p.overheatT = 0;
    p.spin = 0;
    p.charge = 0;
    p.spreadAcc = 0;
    scheduleRespawn(timers, pk); // guns never node-spawn today; future-proof
    sim.pickups.splice(best, 1);
    sim.emit({ t: 'pickup', player: p.id, kind: 'gun', gun: p.gun });
  }
}
