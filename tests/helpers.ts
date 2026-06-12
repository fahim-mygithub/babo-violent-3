import { GameSim, initPhysics } from '../src/sim/sim';
import type { SimOptions, PlayerInput } from '../src/sim/types';
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
