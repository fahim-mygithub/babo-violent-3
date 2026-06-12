import { describe, expect, it } from 'vitest';
import { C } from '../src/data/constants';
import { GRINDER } from '../src/data/maps';
import type { GameSim } from '../src/sim/sim';
import type { GameEvent } from '../src/sim/types';
import { makeSim, run, runUntil, teleport } from './helpers';

function addBots(sim: GameSim, count: number, ffa: boolean): void {
  const classes = ['spider', 'juggernaut', 'bastion', 'phantom', 'trapper'] as const;
  for (let i = 0; i < count; i++) {
    sim.addPlayer(`Bot${i}`, classes[i % classes.length], ffa ? -1 : ((i % 2) as 0 | 1), true);
  }
}

function checkInvariants(sim: GameSim): void {
  const halfW = GRINDER.size.w / 2 + 1;
  const halfH = GRINDER.size.h / 2 + 1;
  for (const p of sim.players.values()) {
    expect(p.hp).toBeGreaterThanOrEqual(0);
    expect(p.hp).toBeLessThanOrEqual(C.MAX_HP);
    if (p.alive) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      expect(Number.isFinite(p.vx) && Number.isFinite(p.vy)).toBe(true);
      expect(Math.abs(p.x)).toBeLessThanOrEqual(halfW);
      expect(Math.abs(p.y)).toBeLessThanOrEqual(halfH);
    }
    expect(p.mag).toBeGreaterThanOrEqual(0);
    expect(p.heat).toBeGreaterThanOrEqual(0);
    expect(p.heat).toBeLessThanOrEqual(1.001);
    expect(p.grenades).toBeGreaterThanOrEqual(0);
    expect(p.grenades).toBeLessThanOrEqual(C.GRENADE_CAP);
  }
  expect(sim.pools.length).toBeLessThanOrEqual(C.SLICK_ZONE_CAP);
  for (const pool of sim.pools) expect(pool.r).toBeGreaterThan(0);
  for (const pr of sim.projectiles) {
    expect(Number.isFinite(pr.x) && Number.isFinite(pr.y)).toBe(true);
    expect(Math.abs(pr.x)).toBeLessThanOrEqual(halfW + 2);
    expect(Math.abs(pr.y)).toBeLessThanOrEqual(halfH + 2);
  }
}

describe('full-match integration', () => {
  it('8-bot TDM runs to completion with a winner', async () => {
    const sim = await makeSim({ mode: 'tdm', scoreLimit: 5, seed: 7 });
    addBots(sim, 8, false);
    const ticks = runUntil(sim, () => sim.mode.ended, 4 * 60 * C.SIM_HZ);
    expect(ticks).toBeGreaterThanOrEqual(0);
    expect([0, 1]).toContain(sim.mode.winner);
    expect(sim.mode.teamScores[0] + sim.mode.teamScores[1]).toBeGreaterThanOrEqual(5);
  }, 60_000);

  it('6-bot High Bounty completes; leaderChange fired; winner reached the limit', async () => {
    const sim = await makeSim({ mode: 'bounty', scoreLimit: 5, seed: 11 });
    addBots(sim, 6, true);
    let sawLeaderChange = false;
    const ticks = runUntil(sim, () => {
      if (sim.events.some((e) => e.t === 'leaderChange')) sawLeaderChange = true;
      sim.events.length = 0;
      return sim.mode.ended;
    }, 4 * 60 * C.SIM_HZ);
    expect(ticks).toBeGreaterThanOrEqual(0);
    expect(sawLeaderChange).toBe(true);
    const winner = sim.players.get(sim.mode.winner);
    expect(winner).toBeDefined();
    expect(winner!.score).toBeGreaterThanOrEqual(5);
  }, 60_000);

  it('CTF holds legal flag states for 90 sim-seconds', async () => {
    // Bots don't pursue flags, so no caps are required — only legality.
    const sim = await makeSim({ mode: 'ctf', seed: 13 });
    addBots(sim, 4, false);
    for (let i = 0; i < 90 * C.SIM_HZ; i++) {
      sim.step();
      sim.events.length = 0;
      if (i % 60 !== 0) continue;
      for (const flag of sim.mode.flags) {
        expect(['base', 'carried', 'dropped']).toContain(flag.state);
        if (flag.state === 'carried') {
          const carrier = sim.players.get(flag.carrier);
          expect(carrier?.alive).toBe(true);
          expect(carrier?.carryingFlag).toBe(flag.team);
        }
      }
      expect(sim.mode.teamScores[0]).toBeLessThanOrEqual(sim.mode.scoreLimit);
      expect(sim.mode.teamScores[1]).toBeLessThanOrEqual(sim.mode.scoreLimit);
    }
  }, 60_000);

  it('invariants hold through a 60s 8-bot TDM and bots really fight', async () => {
    const sim = await makeSim({ mode: 'tdm', seed: 17 });
    addBots(sim, 8, false);
    const seen = new Set<GameEvent['t']>();
    for (let i = 0; i < 60 * C.SIM_HZ; i++) {
      sim.step();
      for (const ev of sim.events) seen.add(ev.t);
      sim.events.length = 0;
      if (i % 30 === 0) checkInvariants(sim);
    }
    for (const required of ['shot', 'hit', 'death', 'pop', 'splat', 'respawn'] as const) {
      expect(seen, `expected event '${required}' during a bot match`).toContain(required);
    }
  }, 60_000);

  it('same seed → identical simulation (determinism)', async () => {
    const a = await makeSim({ mode: 'tdm', seed: 23 });
    const b = await makeSim({ mode: 'tdm', seed: 23 });
    addBots(a, 4, false);
    addBots(b, 4, false);
    for (let i = 0; i < 600; i++) {
      a.step();
      b.step();
      a.events.length = 0;
      b.events.length = 0;
    }
    for (const [id, pa] of a.players) {
      const pb = b.players.get(id)!;
      expect(Math.abs(pa.x - pb.x)).toBeLessThan(1e-9);
      expect(Math.abs(pa.y - pb.y)).toBeLessThan(1e-9);
      expect(pa.hp).toBe(pb.hp);
      expect(pa.kills).toBe(pb.kills);
    }
  }, 60_000);

  it('steps fast enough for 8 players at 60 Hz', async () => {
    const sim = await makeSim({ mode: 'tdm', seed: 29 });
    addBots(sim, 8, false);
    run(sim, 120); // warm-up
    sim.events.length = 0;
    const t0 = performance.now();
    const N = 1800;
    for (let i = 0; i < N; i++) {
      sim.step();
      sim.events.length = 0;
    }
    const avg = (performance.now() - t0) / N;
    console.log(`avg step: ${avg.toFixed(3)} ms (budget 16.6 ms/frame)`);
    expect(avg).toBeLessThan(8);
  }, 60_000);

  it('closes the loot loop: kill → drops → scavenge → respawn', async () => {
    const sim = await makeSim({ mode: 'tdm', seed: 31 });
    const a = sim.addPlayer('A', 'spider', 0, false);
    const b = sim.addPlayer('B', 'bastion', 1, false);
    run(sim, 2); // initial auto-spawn
    expect(a.alive && b.alive).toBe(true);
    teleport(sim, a.id, -5, 0);
    teleport(sim, b.id, 5, 0);
    a.invulnT = 0;
    b.hp = 50; // so the health pack is consumable

    sim.damage(a, b.id, 999, 'workhorse');
    sim.step();
    expect(a.alive).toBe(false);
    const gunDrop = sim.pickups.find((p) => p.kind === 'gun' && p.nodeIdx === -1);
    const healthDrop = sim.pickups.find((p) => p.kind === 'health' && p.nodeIdx === -1);
    expect(gunDrop).toBeDefined();
    expect(healthDrop).toBeDefined();
    expect(Math.hypot(gunDrop!.x - -5, gunDrop!.y - 0)).toBeLessThan(2);
    expect(sim.pools.length).toBeGreaterThan(0);

    // B walks onto the health pack and auto-consumes it
    teleport(sim, b.id, healthDrop!.x, healthDrop!.y);
    run(sim, 2);
    expect(b.hp).toBe(100);
    expect(sim.pickups).not.toContain(healthDrop);

    // A respawns with full hp + spawn protection
    const ticks = runUntil(sim, () => a.alive, C.SIM_HZ * 5);
    expect(ticks).toBeGreaterThanOrEqual(0);
    expect(ticks / C.SIM_HZ).toBeLessThan(C.RESPAWN_DELAY + 0.5);
    expect(a.hp).toBe(C.MAX_HP);
    expect(a.invulnT).toBeGreaterThan(0);
  }, 30_000);
});
