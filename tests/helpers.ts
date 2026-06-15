import { GameSim, initPhysics } from '../src/sim/sim';
import type { SimOptions, PlayerInput, FlagState } from '../src/sim/types';
import { BTN, emptyInput } from '../src/sim/types';

export { BTN, emptyInput };

/** Create a sim (awaits rapier init once). */
export async function makeSim(opts?: Partial<SimOptions>): Promise<GameSim> {
  await initPhysics();
  return new GameSim({ mapId: 'grinder', mode: 'tdm', seed: 42, ...opts });
}

/** Run n fixed steps. */
export function run(sim: GameSim, n: number): void {
  for (let i = 0; i < n; i++) sim.step();
}

/** Convenience: run until predicate or maxTicks. Returns ticks elapsed or -1. */
export function runUntil(sim: GameSim, pred: () => boolean, maxTicks = 3600): number {
  for (let i = 0; i < maxTicks; i++) {
    sim.step();
    if (pred()) return i;
  }
  return -1;
}

export function input(partial: Partial<PlayerInput>): PlayerInput {
  return { ...emptyInput(), ...partial };
}

/** Place a player at a position directly (teleport, zero velocity). */
export function teleport(sim: GameSim, id: number, x: number, y: number): void {
  const p = sim.players.get(id)!;
  p.x = x; p.y = y; p.vx = 0; p.vy = 0;
  const body = sim.bodies.get(id)!;
  body.setTranslation({ x, y }, true);
  body.setLinvel({ x: 0, y: 0 }, true);
}

/** Drain and return events matching a type. */
export function eventsOf<T extends string>(sim: GameSim, t: T) {
  return sim.events.filter((e) => e.t === t);
}

export function clearEvents(sim: GameSim): void {
  sim.events.length = 0;
}

// --- Determinism golden digest (spec S8.1) --------------------------------
// Order-stable FNV-1a over the full sim state, folding each Float64 by its raw
// 8 bytes so the hash is bit-exact (not decimal-rounded). Players are sorted by
// id; all arrays are consumed in their stored order (already deterministic).
const _f64 = new Float64Array(1);
const _u8 = new Uint8Array(_f64.buffer);

function fnv(state: { h: number }, n: number): void {
  _f64[0] = n;
  for (let i = 0; i < 8; i++) {
    state.h ^= _u8[i];
    state.h = Math.imul(state.h, 0x01000193) >>> 0;
  }
}

export function simHash(sim: GameSim): string {
  const s = { h: 0x811c9dc5 };
  fnv(s, sim.tick);
  const ids = [...sim.players.keys()].sort((a, b) => a - b);
  for (const id of ids) {
    const p = sim.players.get(id)!;
    fnv(s, p.id); fnv(s, p.x); fnv(s, p.y); fnv(s, p.vx); fnv(s, p.vy);
    fnv(s, p.aim); fnv(s, p.hp); fnv(s, p.kills); fnv(s, p.deaths);
    fnv(s, p.heat); fnv(s, p.mag);
  }
  for (const pr of sim.projectiles) { fnv(s, pr.id); fnv(s, pr.x); fnv(s, pr.y); fnv(s, pr.vx); fnv(s, pr.vy); }
  for (const g of sim.grenades) { fnv(s, g.id); fnv(s, g.x); fnv(s, g.y); fnv(s, g.z); fnv(s, g.fuse); }
  for (const pool of sim.pools) { fnv(s, pool.id); fnv(s, pool.x); fnv(s, pool.y); fnv(s, pool.r); fnv(s, pool.age); }
  for (const f of sim.fires) { fnv(s, f.id); fnv(s, f.x); fnv(s, f.y); fnv(s, f.r); fnv(s, f.ttl); }
  // Smoke zones block hasLOS() → bot targeting → determinism, so they must be hashed.
  for (const sm of sim.smokes) { fnv(s, sm.id); fnv(s, sm.x); fnv(s, sm.y); fnv(s, sm.r); fnv(s, sm.ttl); }
  // Pickups: respawn/loot timing (ttl, node index) affects behavior.
  for (const pk of sim.pickups) { fnv(s, pk.id); fnv(s, pk.x); fnv(s, pk.y); fnv(s, pk.nodeIdx); fnv(s, pk.ttl); }
  fnv(s, sim.mode.teamScores[0]); fnv(s, sim.mode.teamScores[1]);
  // FlagState.state is a string discriminant; encode it numerically (base/carried/dropped).
  const FLAG_STATE: Record<FlagState['state'], number> = { base: 0, carried: 1, dropped: 2 };
  for (const flag of sim.mode.flags) { fnv(s, flag.team); fnv(s, flag.x); fnv(s, flag.y); fnv(s, FLAG_STATE[flag.state]); fnv(s, flag.carrier); fnv(s, flag.returnT); }
  return (s.h >>> 0).toString(16).padStart(8, '0') + (sim.tick >>> 0).toString(16).padStart(8, '0');
}
