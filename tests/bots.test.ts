import { describe, expect, it } from 'vitest';
import { BTN, makeSim, run, teleport } from './helpers';
import { angleDiff, dist } from '../src/core/math';

describe('bot system', () => {
  it('writes movement input within a few ticks of spawning', async () => {
    const sim = await makeSim();
    const b = sim.addPlayer('Bot', 'spider', 0, true);
    sim.respawn(b);
    run(sim, 5);
    expect(Math.hypot(b.input.mx, b.input.my)).toBeGreaterThan(0.3);
  });

  it('moves from spawn within 2s', async () => {
    const sim = await makeSim();
    const b = sim.addPlayer('Bot', 'spider', 0, true);
    sim.respawn(b);
    const x0 = b.x;
    const y0 = b.y;
    run(sim, 120);
    expect(dist(x0, y0, b.x, b.y)).toBeGreaterThan(0.5);
  });

  it('aims at and holds FIRE on a clear-LOS enemy directly ahead', async () => {
    const sim = await makeSim();
    const b = sim.addPlayer('Bot', 'juggernaut', 0, true);
    const e = sim.addPlayer('Dummy', 'bastion', 1, false);
    sim.respawn(b);
    sim.respawn(e);
    let fired = false;
    for (let i = 0; i < 120; i++) {
      // pin both so the geometry stays controlled regardless of other systems
      teleport(sim, b.id, -4, 0);
      teleport(sim, e.id, 3, 0);
      sim.step();
      if (b.input.buttons & BTN.FIRE) { fired = true; break; }
    }
    expect(fired).toBe(true);
    // aimed roughly at the enemy (angle 0), aimDist ≈ distance (7)
    expect(Math.abs(angleDiff(b.input.aim, 0))).toBeLessThan(0.3);
    expect(Math.abs(b.input.aimDist - 7)).toBeLessThan(1.5);
  });

  it('produces shot events within 2s when an enemy is in clear LOS', async () => {
    const sim = await makeSim();
    const b = sim.addPlayer('Bot', 'juggernaut', 0, true);
    const e = sim.addPlayer('Dummy', 'bastion', 1, false);
    sim.respawn(b);
    sim.respawn(e);
    teleport(sim, b.id, -4, 0);
    teleport(sim, e.id, 3, 0);
    run(sim, 120);
    const shots = sim.events.filter((ev) => ev.t === 'shot' && ev.player === b.id);
    expect(shots.length).toBeGreaterThan(0);
  });

  it('does not fire when a wall blocks LOS', async () => {
    const sim = await makeSim();
    const b = sim.addPlayer('Bot', 'juggernaut', 0, true);
    const e = sim.addPlayer('Dummy', 'bastion', 1, false);
    sim.respawn(b);
    sim.respawn(e);
    for (let i = 0; i < 90; i++) {
      // opposite sides of the mid-field cover wall at (-12, -8)
      teleport(sim, b.id, -12, -11);
      teleport(sim, e.id, -12, -5);
      sim.step();
      expect(b.input.buttons & BTN.FIRE).toBe(0);
      expect(b.input.buttons & BTN.THROW).toBe(0);
    }
    const shots = sim.events.filter((ev) => ev.t === 'shot' && ev.player === b.id);
    expect(shots).toHaveLength(0);
  });

  it('4-bot FFA runs 15 sim-seconds without throwing and bots roam', async () => {
    const sim = await makeSim();
    const classes = ['spider', 'juggernaut', 'phantom', 'trapper'] as const;
    const bots = classes.map((c, i) => sim.addPlayer(`B${i}`, c, -1, true));
    for (const b of bots) sim.respawn(b);
    const starts = bots.map((b) => ({ x: b.x, y: b.y }));
    run(sim, 15 * 60);
    const moved = bots.map((b, i) => dist(starts[i].x, starts[i].y, b.x, b.y));
    expect(Math.max(...moved)).toBeGreaterThan(5);
  });

  it('a low-HP bot near a health pack moves toward it', async () => {
    const sim = await makeSim();
    const b = sim.addPlayer('Bot', 'bastion', 0, true);
    sim.respawn(b);
    teleport(sim, b.id, -20, 0);
    b.hp = 25;
    run(sim, 3);
    // intent points at the health node at (-26, 0)
    expect(b.input.mx).toBeLessThan(-0.5);
    const d0 = dist(b.x, b.y, -26, 0);
    let minD = d0;
    for (let i = 0; i < 90; i++) {
      sim.step();
      minD = Math.min(minD, dist(b.x, b.y, -26, 0));
    }
    expect(minD).toBeLessThan(d0 - 0.5);
  });

  it('taps PICKUP for exactly one tick when standing on a better gun', async () => {
    const sim = await makeSim();
    const b = sim.addPlayer('Bot', 'spider', 0, true);
    sim.respawn(b);
    sim.pickups.push({
      id: sim.newId(), kind: 'gun', gun: 'thumper',
      x: b.x, y: b.y, nodeIdx: -1, ttl: 30,
    });
    run(sim, 1);
    expect(b.input.buttons & BTN.PICKUP).toBe(BTN.PICKUP);
    run(sim, 1);
    expect(b.input.buttons & BTN.PICKUP).toBe(0);
  });

  it('writes empty input while dead', async () => {
    const sim = await makeSim();
    const b = sim.addPlayer('Bot', 'spider', 0, true);
    sim.respawn(b);
    run(sim, 10);
    sim.kill(b, -1, 'world');
    run(sim, 5);
    expect(b.input.buttons).toBe(0);
    expect(b.input.mx).toBe(0);
    expect(b.input.my).toBe(0);
  });
});
