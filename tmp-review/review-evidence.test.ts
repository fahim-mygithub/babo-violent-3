/**
 * REVIEWER throwaway evidence tests — not part of the shipped suite.
 * Verifies rubric claims the shipped tests cover only indirectly:
 *  - C10: recoil Δv = recoil_impulse / class mass (phantom vs juggernaut, thumper)
 *  - C11: slick-zone cap enforced at 24 when overflowed
 *  - C7:  death pop applies a radial impulse to nearby babos
 *  - C2:  does the shipped 60s integration invariant actually exercise the cap?
 */
import { describe, expect, it } from 'vitest';
import { GameSim, initPhysics } from '../src/sim/sim';
import { weaponSystem } from '../src/sim/systems/weapons';
import { C } from '../src/data/constants';
import { GUNS } from '../src/data/weapons';
import { BTN, emptyInput } from '../src/sim/types';
import type { PlayerInput } from '../src/sim/types';
import type { ClassId } from '../src/data/classes';
import { CLASSES } from '../src/data/classes';

async function makeSim(opts: Record<string, unknown> = {}): Promise<GameSim> {
  await initPhysics();
  return new GameSim({ mapId: 'grinder', mode: 'tdm', seed: 42, ...opts } as never);
}

function input(partial: Partial<PlayerInput>): PlayerInput {
  return { ...emptyInput(), ...partial };
}

function teleport(sim: GameSim, id: number, x: number, y: number): void {
  const p = sim.players.get(id)!;
  p.x = x; p.y = y; p.vx = 0; p.vy = 0;
  const body = sim.bodies.get(id)!;
  body.setTranslation({ x, y }, true);
  body.setLinvel({ x: 0, y: 0 }, true);
}

function thumperRecoilDeltaV(sim: GameSim, classId: ClassId, x: number, y: number): number {
  const p = sim.addPlayer(classId, classId, -1, false);
  sim.respawn(p);
  teleport(sim, p.id, x, y);
  p.gun = 'thumper';
  p.mag = GUNS.thumper.magSize!;
  p.invulnT = 0;
  p.aim = 0; // +x; recoil pushes -x
  sim.setInput(p.id, input({ buttons: BTN.FIRE, aim: 0 }));
  weaponSystem(sim, sim.dt); // single discharge tick, no other systems
  const v = sim.bodies.get(p.id)!.linvel();
  return Math.hypot(v.x, v.y);
}

describe('reviewer evidence', () => {
  it('C10: thumper recoil delta-v = recoil/mass (phantom launches, juggernaut barely moves)', async () => {
    const sim = await makeSim();
    const phantomDv = thumperRecoilDeltaV(sim, 'phantom', -20, -14);
    const juggDv = thumperRecoilDeltaV(sim, 'juggernaut', 20, -14);
    const expectedPhantom = GUNS.thumper.recoil / CLASSES.phantom.mass; // 40 / 0.8 = 50
    const expectedJugg = GUNS.thumper.recoil / CLASSES.juggernaut.mass; // 40 / 5 = 8
    console.log(`phantom dv=${phantomDv.toFixed(2)} (expect ${expectedPhantom}), jugg dv=${juggDv.toFixed(2)} (expect ${expectedJugg})`);
    expect(phantomDv).toBeCloseTo(expectedPhantom, 1);
    expect(juggDv).toBeCloseTo(expectedJugg, 1);
    expect(phantomDv / juggDv).toBeCloseTo(CLASSES.juggernaut.mass / CLASSES.phantom.mass, 1);
  });

  it('C11: spawning 30 spaced pools enforces the 24 cap and demotes the oldest', async () => {
    const sim = await makeSim();
    let spawned = 0;
    for (let gx = 0; gx < 6; gx++) {
      for (let gy = 0; gy < 5; gy++) {
        sim.spawnPool(-25 + gx * 6, -24 + gy * 8, 1.2); // spacing >> merge radius (0.84)
        spawned++;
      }
    }
    expect(spawned).toBe(30);
    expect(sim.pools.length).toBe(C.SLICK_ZONE_CAP); // 24
    const gone = sim.events.filter((e) => e.t === 'poolGone').length;
    expect(gone).toBe(30 - C.SLICK_ZONE_CAP);
  });

  it('C7: death pop shoves a nearby babo radially outward', async () => {
    const sim = await makeSim();
    const victim = sim.addPlayer('V', 'spider', -1, false);
    const near = sim.addPlayer('N', 'spider', -1, false);
    sim.respawn(victim);
    sim.respawn(near);
    victim.invulnT = 0;
    near.invulnT = 0;
    teleport(sim, victim.id, 0, -4);
    teleport(sim, near.id, 1.5, -4); // inside DEATH_POP_RADIUS 2.5
    sim.kill(victim, near.id, 'stinger');
    const v = sim.bodies.get(near.id)!.linvel();
    // falloff (1 - 1.5/2.5) = 0.4; impulse 6*0.4 = 2.4 on mass 1 → vx ≈ 2.4 outward
    console.log(`pop shove vx=${v.x.toFixed(2)}`);
    expect(v.x).toBeGreaterThan(1.5);
    expect(Math.abs(v.y)).toBeLessThan(0.2);
  });

  it('C2 probe: does a 60s 8-bot TDM actually reach the pool cap?', async () => {
    const sim = await makeSim({ mode: 'tdm', seed: 17 });
    const classes = ['spider', 'juggernaut', 'bastion', 'phantom', 'trapper'] as const;
    for (let i = 0; i < 8; i++) sim.addPlayer(`Bot${i}`, classes[i % 5], (i % 2) as 0 | 1, true);
    let maxPools = 0;
    for (let i = 0; i < 60 * C.SIM_HZ; i++) {
      sim.step();
      sim.events.length = 0;
      maxPools = Math.max(maxPools, sim.pools.length);
    }
    console.log(`max concurrent pools over 60s: ${maxPools} (cap ${C.SLICK_ZONE_CAP})`);
    expect(maxPools).toBeGreaterThan(0); // informational
  }, 60_000);
});
