import { describe, expect, it } from 'vitest';
import type { GameSim } from '../src/sim/sim';
import type { PlayerState } from '../src/sim/types';
import type { ClassId } from '../src/data/classes';
import { CLASSES } from '../src/data/classes';
import { C } from '../src/data/constants';
import { input, makeSim, run, teleport } from './helpers';

/** Spawn a live, vulnerable player parked at (x, y) in an open lane. */
function spawnAt(sim: GameSim, classId: ClassId, team: 0 | 1, x: number, y: number): PlayerState {
  const p = sim.addPlayer(classId, classId, team, false);
  sim.respawn(p);
  p.invulnT = 0;
  p.respawnT = 0;
  teleport(sim, p.id, x, y);
  return p;
}

const speedOf = (p: PlayerState) => Math.hypot(p.vx, p.vy);

// The y=±14 rows of grinder are wall-free from x≈-30 to x≈+30 — good test lanes.

describe('movement system', () => {
  it('accelerates gradually from rest, not instantly to max', async () => {
    const sim = await makeSim();
    const p = spawnAt(sim, 'spider', 0, -28, -14);
    sim.setInput(p.id, input({ mx: 1 }));

    sim.step();
    const s1 = speedOf(p);
    expect(s1).toBeGreaterThan(0);
    expect(s1).toBeLessThan(CLASSES.spider.maxSpeed * 0.2); // far from top speed in one tick

    run(sim, 59); // 1s total under throttle
    expect(speedOf(p)).toBeGreaterThan(s1 * 2); // still building speed afterwards
  });

  it('coasts to a stop over many ticks after input release (no instant stop)', async () => {
    const sim = await makeSim();
    const p = spawnAt(sim, 'spider', 0, -28, -14);
    sim.setInput(p.id, input({ mx: 1 }));
    run(sim, 90);
    const atRelease = speedOf(p);
    expect(atRelease).toBeGreaterThan(CLASSES.spider.maxSpeed * 0.8);

    sim.setInput(p.id, input({}));
    sim.step();
    expect(speedOf(p)).toBeGreaterThan(atRelease * 0.9); // one tick barely slows it

    run(sim, 300); // ~5s of coasting bleeds it off
    expect(speedOf(p)).toBeLessThan(0.5);
  });

  it('soft clamp: approaches but never exceeds ~1.15x maxSpeed under constant input', async () => {
    const sim = await makeSim();
    const p = spawnAt(sim, 'spider', 0, -28, -14);
    sim.setInput(p.id, input({ mx: 1 }));

    let peak = 0;
    for (let i = 0; i < 180; i++) { // 3s
      sim.step();
      peak = Math.max(peak, speedOf(p));
    }
    expect(peak).toBeLessThanOrEqual(CLASSES.spider.maxSpeed * 1.16);
    expect(speedOf(p)).toBeGreaterThan(CLASSES.spider.maxSpeed); // soft, not hard: settles above nominal max
  });

  it('slick lets a babo coast farther after the same push', async () => {
    const sim = await makeSim();
    const slick = spawnAt(sim, 'spider', 0, -20, -14);
    const dry = spawnAt(sim, 'spider', 1, -20, 14);
    sim.bodies.get(slick.id)!.setLinvel({ x: 10, y: 0 }, true);
    sim.bodies.get(dry.id)!.setLinvel({ x: 10, y: 0 }, true);

    for (let i = 0; i < 360; i++) {
      // movementSystem runs before bloodSystem each step, so force the flag fresh
      slick.inSlick = true;
      dry.inSlick = false;
      sim.step();
    }
    const slickDist = slick.x - -20;
    const dryDist = dry.x - -20;
    expect(dryDist).toBeGreaterThan(1);
    expect(slickDist).toBeGreaterThan(dryDist * 1.5);
  });

  it('ticks invulnT down to 0 and floors there', async () => {
    const sim = await makeSim();
    const p = spawnAt(sim, 'spider', 0, 0, -14);
    p.invulnT = C.SPAWN_INVULN; // restore the spawn protection the helper cleared

    run(sim, 30); // 0.5s
    expect(p.invulnT).toBeCloseTo(C.SPAWN_INVULN - 0.5, 3);

    run(sim, 95); // well past expiry — must clamp at exactly 0, never negative
    expect(p.invulnT).toBe(0);
  });

  it('juggernaut accelerates to a lower top speed than spider', async () => {
    const sim = await makeSim();
    const spider = spawnAt(sim, 'spider', 0, -28, -14);
    const jugg = spawnAt(sim, 'juggernaut', 1, -28, 14);
    sim.setInput(spider.id, input({ mx: 1 }));
    sim.setInput(jugg.id, input({ mx: 1 }));

    let spiderPeak = 0;
    let juggPeak = 0;
    for (let i = 0; i < 240; i++) { // 4s — both reach cruise speed (spider may then wall-bounce)
      sim.step();
      spiderPeak = Math.max(spiderPeak, speedOf(spider));
      juggPeak = Math.max(juggPeak, speedOf(jugg));
    }
    expect(juggPeak).toBeLessThan(spiderPeak);
    expect(juggPeak).toBeLessThanOrEqual(CLASSES.juggernaut.maxSpeed * 1.16);
  });

  it('grapple pulls toward the anchor only while the rope is taut', async () => {
    const sim = await makeSim();
    const p = spawnAt(sim, 'spider', 0, 0, -14);

    // Taut: anchor 10u away, rope length 2 → spring force toward +x
    for (let i = 0; i < 10; i++) {
      p.grappleActive = true; // re-force in case abilitySystem releases it
      p.grappleX = 10; p.grappleY = -14; p.grappleLen = 2;
      sim.step();
    }
    expect(p.vx).toBeGreaterThan(3);
    expect(p.x).toBeGreaterThan(0);

    // Slack: rope longer than the distance → no pull at all
    const q = spawnAt(sim, 'spider', 1, 0, 14);
    for (let i = 0; i < 10; i++) {
      q.grappleActive = true;
      q.grappleX = 10; q.grappleY = 14; q.grappleLen = 20;
      sim.step();
    }
    expect(Math.abs(q.vx)).toBeLessThan(0.01);
    expect(Math.abs(q.vy)).toBeLessThan(0.01);
  });
});
