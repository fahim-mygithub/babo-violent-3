import { describe, expect, it } from 'vitest';
import { C } from '../src/data/constants';
import type { GameSim } from '../src/sim/sim';
import { projectileSystem } from '../src/sim/systems/projectiles';
import type { PlayerState, Projectile, Team } from '../src/sim/types';
import { makeSim, teleport } from './helpers';

// These tests drive projectileSystem directly (not sim.step()) so they depend
// only on this system plus sim.ts helpers — sibling systems are in flux.

/** Spawn + position a live babo directly (no dependence on other systems). */
function addBabo(sim: GameSim, name: string, team: Team, x: number, y: number): PlayerState {
  const p = sim.addPlayer(name, 'spider', team, false);
  sim.respawn(p);
  p.invulnT = 0;
  teleport(sim, p.id, x, y);
  return p;
}

/** Push a projectile straight into the sim (no weapon system involved). */
function push(sim: GameSim, partial: Partial<Projectile>): Projectile {
  const pr: Projectile = {
    id: sim.newId(), kind: 'bullet', gun: 'stinger', owner: -999, team: -1,
    x: 0, y: 0, vx: 0, vy: 0, damage: 10, dist: 0, maxDist: C.PROJECTILE_MAX_DIST,
    ...partial,
  };
  sim.projectiles.push(pr);
  return pr;
}

/** Run only the projectile system for n ticks. */
function tick(sim: GameSim, n: number): void {
  for (let i = 0; i < n; i++) projectileSystem(sim, sim.dt);
}

// Map notes (grinder): the lane y=-4 is wall-free for |x| < 31; the pit-rim
// accent at (8, 0) is a 1.8×1.8 box whose west face sits at x = 7.1.

describe('projectileSystem', () => {
  it('bullet crosses open ground, damages a babo in its path, and knocks it back', async () => {
    const sim = await makeSim();
    const victim = addBabo(sim, 'V', -1, 5, -4);
    push(sim, { x: 0, y: -4, vx: 34, damage: 8 });
    tick(sim, 30);
    expect(victim.hp).toBe(C.MAX_HP - 8);
    expect(sim.projectiles.length).toBe(0); // round spent on impact
    // Knock impulse along the travel direction (damage * 0.06 on mass 1)
    const v = sim.bodies.get(victim.id)!.linvel();
    expect(v.x).toBeCloseTo(8 * 0.06, 3);
    expect(v.y).toBeCloseTo(0, 3);
  });

  it('bullet stops at a wall: babo behind is unharmed, hitWall emitted at the face', async () => {
    const sim = await makeSim();
    const behind = addBabo(sim, 'B', -1, 12, 0);
    push(sim, { x: 4, y: 0, vx: 34, damage: 8 });
    tick(sim, 40);
    expect(behind.hp).toBe(C.MAX_HP);
    expect(sim.projectiles.length).toBe(0);
    const hits = sim.events.flatMap((e) => (e.t === 'hitWall' ? [e] : []));
    expect(hits.length).toBe(1);
    expect(hits[0].x).toBeGreaterThan(7.0);
    expect(hits[0].x).toBeLessThanOrEqual(7.11); // accent face at x = 7.1
    expect(hits[0].gun).toBe('stinger');
  });

  it('passes through a teammate and hits the enemy beyond', async () => {
    const sim = await makeSim();
    const mate = addBabo(sim, 'M', 0, 5, -4);
    const enemy = addBabo(sim, 'E', 1, 10, -4);
    push(sim, { x: 0, y: -4, vx: 34, damage: 8, team: 0 });
    tick(sim, 40);
    expect(mate.hp).toBe(C.MAX_HP);
    expect(enemy.hp).toBe(C.MAX_HP - 8);
    expect(sim.projectiles.length).toBe(0);
  });

  it('passes through a phased babo and keeps flying', async () => {
    const sim = await makeSim();
    const ghost = addBabo(sim, 'G', -1, 5, -4);
    ghost.phaseActive = true;
    const pr = push(sim, { x: 0, y: -4, vx: 34, damage: 8 });
    tick(sim, 12); // ~6.8 u traveled — already past the babo
    expect(ghost.hp).toBe(C.MAX_HP);
    expect(sim.projectiles).toContain(pr);
    expect(pr.x).toBeGreaterThan(5.5);
  });

  it('never hits its own shooter, even when spawned inside them', async () => {
    const sim = await makeSim();
    const shooter = addBabo(sim, 'S', -1, 0, -4);
    const pr = push(sim, { x: 0, y: -4, vx: 34, damage: 8, owner: shooter.id });
    tick(sim, 3);
    expect(shooter.hp).toBe(C.MAX_HP);
    expect(sim.projectiles).toContain(pr);
  });

  it('rocket explodes on a wall: splash hits a babo near the blast but not one behind the wall', async () => {
    const sim = await makeSim();
    const near = addBabo(sim, 'N', -1, 6, 1.5);      // off the flight path, in blast radius
    const shielded = addBabo(sim, 'W', -1, 9.6, 0);  // in radius but across the wall
    push(sim, { x: 4, y: 0, vx: 18, kind: 'rocket', gun: 'thumper', damage: 70 });
    tick(sim, 30);
    expect(sim.projectiles.length).toBe(0);
    expect(near.hp).toBeLessThan(C.MAX_HP);
    expect(shielded.hp).toBe(C.MAX_HP);
    expect(sim.events.some((e) => e.t === 'explosion' && e.kind === 'rocket')).toBe(true);
    expect(sim.events.some((e) => e.t === 'hitWall')).toBe(false); // explosion, not hitWall
  });

  it('flame ignites a blood pool: fire zone appears, pool removed, flame despawns', async () => {
    const sim = await makeSim();
    sim.spawnPool(5, -4, 1.2);
    expect(sim.pools.length).toBe(1);
    const poolId = sim.pools[0].id;
    push(sim, { x: 0, y: -4, vx: 12, kind: 'flame', gun: 'pyre', damage: 6, maxDist: 6.5 });
    tick(sim, 30);
    expect(sim.pools.length).toBe(0);
    expect(sim.fires.length).toBe(1);
    expect(sim.fires[0].x).toBe(5);
    expect(sim.fires[0].r).toBe(1.2);
    expect(sim.projectiles.length).toBe(0);
    expect(sim.events.some((e) => e.t === 'poolGone' && e.id === poolId)).toBe(true);
    expect(sim.events.some((e) => e.t === 'fireIgnite')).toBe(true);
  });

  it('flame despawns quietly on a wall (no hitWall event)', async () => {
    const sim = await makeSim();
    push(sim, { x: 4, y: 0, vx: 12, kind: 'flame', gun: 'pyre', damage: 6, maxDist: 20 });
    tick(sim, 30);
    expect(sim.projectiles.length).toBe(0);
    expect(sim.events.some((e) => e.t === 'hitWall')).toBe(false);
  });

  it('bullet despawns silently past maxDist', async () => {
    const sim = await makeSim();
    const pr = push(sim, { x: 0, y: -4, vx: 34, maxDist: 3 });
    tick(sim, 10);
    expect(sim.projectiles.length).toBe(0);
    expect(pr.dist).toBeGreaterThanOrEqual(3);
    expect(sim.events.some((e) => e.t === 'hitWall')).toBe(false);
  });

  it('rocket detonates at end of range instead of vanishing', async () => {
    const sim = await makeSim();
    const babo = addBabo(sim, 'B', -1, 5.5, -4); // off the sweep, inside the range-end blast
    push(sim, { x: 0, y: -4, vx: 18, kind: 'rocket', gun: 'thumper', damage: 70, maxDist: 4 });
    tick(sim, 30);
    expect(sim.projectiles.length).toBe(0);
    expect(sim.events.some((e) => e.t === 'explosion')).toBe(true);
    expect(babo.hp).toBeLessThan(C.MAX_HP);
  });

  it('despawns even when the target was invulnerable (round is spent)', async () => {
    const sim = await makeSim();
    const victim = addBabo(sim, 'V', -1, 5, -4);
    victim.invulnT = 5;
    push(sim, { x: 0, y: -4, vx: 34, damage: 8 });
    tick(sim, 30);
    expect(victim.hp).toBe(C.MAX_HP);
    expect(sim.projectiles.length).toBe(0);
  });
});
