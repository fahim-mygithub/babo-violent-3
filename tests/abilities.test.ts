import { describe, expect, it } from 'vitest';
import { BTN, clearEvents, eventsOf, input, makeSim, run, runUntil, teleport } from './helpers';
import { BABO_GROUPS, BABO_GROUPS_PHASED, type GameSim } from '../src/sim/sim';
import type { PlayerState } from '../src/sim/types';
import { ABILITY, CLASSES, type ClassId } from '../src/data/classes';
import type { Team } from '../src/sim/types';

/** Spawn a live player at (x, y) with no spawn protection or pending respawn. */
function place(sim: GameSim, classId: ClassId, team: Team, x: number, y: number): PlayerState {
  const p = sim.addPlayer(classId, classId, team, false);
  sim.respawn(p);
  p.respawnT = 0; // don't let modeSystem re-trigger the initial spawn
  p.invulnT = 0;
  teleport(sim, p.id, x, y);
  return p;
}

function casts(sim: GameSim, ability: string) {
  return eventsOf(sim, 'abilityCast').filter((e) => e.t === 'abilityCast' && e.ability === ability);
}

describe('grapple (spider)', () => {
  it('attaches to a wall in range, sets anchor + rope length, detaches on release', async () => {
    const sim = await makeSim();
    const p = place(sim, 'spider', 0, 20, 0);
    // East outer wall inner face is at x = 31.25 → 11.25 u away, within range 12
    sim.setInput(p.id, input({ buttons: BTN.ABILITY, aim: 0 }));
    p.aim = 0;
    sim.step();

    expect(p.grappleActive).toBe(true);
    expect(p.grappleX).toBeCloseTo(31.25, 1);
    expect(p.grappleY).toBeCloseTo(0, 1);
    expect(p.grappleLen).toBeCloseTo(11.25 * ABILITY.GRAPPLE_ROPE_SLACK, 1);
    expect(p.abilityT).toBeCloseTo(CLASSES.spider.ability.duration, 3);
    const ev = casts(sim, 'grapple');
    expect(ev.length).toBe(1);
    expect(ev[0].t === 'abilityCast' && ev[0].tx).toBeCloseTo(31.25, 1);

    // Release the button → detach + cooldown
    sim.setInput(p.id, input({ aim: 0 }));
    sim.step();
    expect(p.grappleActive).toBe(false);
    expect(p.abilityCD).toBeCloseTo(CLASSES.spider.ability.cooldown, 3);
  });

  it('does not attach when no wall is within range', async () => {
    const sim = await makeSim();
    const p = place(sim, 'spider', 0, 10, 0);
    // Nearest wall along +x is 21.25 u away, beyond range 12
    sim.setInput(p.id, input({ buttons: BTN.ABILITY, aim: 0 }));
    p.aim = 0;
    sim.step();
    expect(p.grappleActive).toBe(false);
    expect(p.abilityCD).toBe(0); // whiff costs nothing
    expect(casts(sim, 'grapple').length).toBe(0);
  });

  it('expires after its duration even while held', async () => {
    const sim = await makeSim();
    const p = place(sim, 'spider', 0, 20, 0);
    sim.setInput(p.id, input({ buttons: BTN.ABILITY, aim: 0 }));
    p.aim = 0;
    sim.step();
    expect(p.grappleActive).toBe(true);
    const ticks = runUntil(sim, () => !p.grappleActive, 400);
    expect(ticks).toBeGreaterThan(160); // ~3.0 s at 60 Hz
    expect(ticks).toBeLessThan(200);
    expect(p.abilityCD).toBeGreaterThan(0);
  });
});

describe('dash (juggernaut)', () => {
  it('bursts past maxSpeed with i-frames and bouncy restitution, then restores', async () => {
    const sim = await makeSim();
    const p = place(sim, 'juggernaut', 0, 0, 10);
    const body = sim.bodies.get(p.id)!;
    sim.setInput(p.id, input({ buttons: BTN.ABILITY, mx: 1 }));
    sim.step();

    expect(p.dashActive).toBe(true);
    expect(Math.hypot(p.vx, p.vy)).toBeGreaterThan(CLASSES.juggernaut.maxSpeed);
    expect(p.invulnT).toBeGreaterThan(0.4); // i-frames for the dash duration
    expect(body.collider(0).restitution()).toBeCloseTo(0.9, 5);
    expect(casts(sim, 'dash').length).toBe(1);

    sim.setInput(p.id, input({}));
    run(sim, 40); // duration 0.55 s = 33 ticks
    expect(p.dashActive).toBe(false);
    expect(p.abilityCD).toBeGreaterThan(0);
    expect(body.collider(0).restitution()).toBeCloseTo(0.45, 5);
  });

  it('damages an adjacent enemy exactly once per dash and knocks them away', async () => {
    const sim = await makeSim();
    const p = place(sim, 'juggernaut', 0, 0, 10);
    const v = place(sim, 'spider', 1, 0.9, 10); // within 2.2 * BABO_RADIUS
    sim.setInput(p.id, input({ buttons: BTN.ABILITY, mx: 1 }));
    sim.step();

    expect(v.hp).toBe(100 - ABILITY.DASH_IMPACT_DAMAGE);
    expect(v.vx).toBeGreaterThan(3); // shoved away from the dasher
    expect(eventsOf(sim, 'dashImpact').length).toBe(1);

    run(sim, 10); // still dashing — same target must not be hit again
    expect(v.hp).toBe(100 - ABILITY.DASH_IMPACT_DAMAGE);
    expect(eventsOf(sim, 'dashImpact').length).toBe(1);
  });

  it('cooldown gates re-cast until it elapses', async () => {
    const sim = await makeSim();
    const p = place(sim, 'juggernaut', 0, 0, 10);
    sim.setInput(p.id, input({ buttons: BTN.ABILITY, mx: 1 }));
    run(sim, 40); // cast + full dash; abilityCD = 5.0 at end
    expect(p.dashActive).toBe(false);
    expect(p.abilityCD).toBeGreaterThan(4);

    // Fresh press during cooldown does nothing
    sim.setInput(p.id, input({ mx: 1 }));
    sim.step();
    sim.setInput(p.id, input({ buttons: BTN.ABILITY, mx: 1 }));
    sim.step();
    expect(p.dashActive).toBe(false);
    expect(casts(sim, 'dash').length).toBe(1);

    // Cooldown cleared → press works again
    p.abilityCD = 0;
    sim.setInput(p.id, input({ mx: 1 }));
    sim.step();
    sim.setInput(p.id, input({ buttons: BTN.ABILITY, mx: 1 }));
    sim.step();
    expect(p.dashActive).toBe(true);
    expect(casts(sim, 'dash').length).toBe(2);
  });
});

describe('fortify (bastion)', () => {
  it('ignores impulses while active, takes them again after it expires', async () => {
    const sim = await makeSim();
    const p = place(sim, 'bastion', 0, 0, 10);
    const body = sim.bodies.get(p.id)!;
    sim.setInput(p.id, input({ buttons: BTN.ABILITY }));
    sim.step();

    expect(p.fortifyActive).toBe(true);
    expect(casts(sim, 'fortify').length).toBe(1);
    sim.applyImpulse(p, 50, 0);
    expect(Math.hypot(body.linvel().x, body.linvel().y)).toBeLessThan(0.5);

    sim.setInput(p.id, input({}));
    run(sim, 140); // duration 2.2 s = 132 ticks
    expect(p.fortifyActive).toBe(false);
    expect(p.abilityCD).toBeGreaterThan(0);
    sim.applyImpulse(p, 50, 0);
    expect(body.linvel().x).toBeGreaterThan(5); // 50 / mass 3 ≈ 16.7
  });
});

describe('phase (phantom)', () => {
  it('is untouchable by damage and swaps collision groups, both reverting on expiry', async () => {
    const sim = await makeSim();
    const p = place(sim, 'phantom', 0, 0, 10);
    const atk = place(sim, 'spider', 1, 5, 10);
    const body = sim.bodies.get(p.id)!;
    sim.setInput(p.id, input({ buttons: BTN.ABILITY }));
    sim.step();

    expect(p.phaseActive).toBe(true);
    expect(body.collider(0).collisionGroups()).toBe(BABO_GROUPS_PHASED);
    p.invulnT = 0;
    expect(sim.damage(p, atk.id, 25, 'stinger')).toBe(0);
    expect(p.hp).toBe(100);
    expect(casts(sim, 'phase').length).toBe(1);

    sim.setInput(p.id, input({}));
    run(sim, 60); // duration 0.9 s = 54 ticks
    expect(p.phaseActive).toBe(false);
    expect(body.collider(0).collisionGroups()).toBe(BABO_GROUPS);
    expect(p.abilityCD).toBeGreaterThan(0);
    p.invulnT = 0;
    expect(sim.damage(p, atk.id, 25, 'stinger')).toBeGreaterThan(0);
  });

  it('restores collision groups when killed mid-phase', async () => {
    const sim = await makeSim();
    const p = place(sim, 'phantom', 0, 0, 10);
    const atk = place(sim, 'spider', 1, 5, 10);
    const body = sim.bodies.get(p.id)!;
    sim.setInput(p.id, input({ buttons: BTN.ABILITY }));
    sim.step();
    expect(body.collider(0).collisionGroups()).toBe(BABO_GROUPS_PHASED);

    sim.kill(p, atk.id, 'stinger'); // sim.kill clears phaseActive directly
    expect(p.phaseActive).toBe(false);
    sim.setInput(p.id, input({}));
    sim.step(); // ability system notices and restores the swap + cooldown
    expect(body.collider(0).collisionGroups()).toBe(BABO_GROUPS);
    expect(p.abilityCD).toBeCloseTo(CLASSES.phantom.ability.cooldown, 3);
  });
});

describe('gravity well (trapper)', () => {
  it('drags a nearby babo toward the well but never the caster, then expires', async () => {
    const sim = await makeSim();
    const p = place(sim, 'trapper', 0, 2, 10);
    const en = place(sim, 'spider', 1, 7, 10);
    clearEvents(sim);
    // Well 3 u east of the trapper → (5, 10); enemy starts 2 u from it
    sim.setInput(p.id, input({ buttons: BTN.ABILITY, aim: 0, aimDist: 3 }));
    p.aim = 0;
    sim.step();

    const ev = casts(sim, 'gravityWell');
    expect(ev.length).toBe(1);
    expect(ev[0].t === 'abilityCast' && ev[0].tx).toBeCloseTo(5, 1);
    expect(ev[0].t === 'abilityCast' && ev[0].ty).toBeCloseTo(10, 1);
    expect(p.abilityCD).toBeCloseTo(CLASSES.trapper.ability.cooldown, 3);

    const d0 = Math.hypot(en.x - 5, en.y - 10);
    sim.setInput(p.id, input({ aim: 0 }));
    run(sim, 30);
    const d1 = Math.hypot(en.x - 5, en.y - 10);
    expect(d1).toBeLessThan(d0 - 0.5); // measurably dragged in
    // Caster is inside WELL_RADIUS but owns the well — never pulled
    expect(Math.hypot(p.x - 2, p.y - 10)).toBeLessThan(0.1);

    // After the duration (1.1 s = 66 ticks) the well is gone
    run(sim, 45);
    teleport(sim, en.id, 7, 10);
    run(sim, 20);
    expect(Math.hypot(en.x - 7, en.y - 10)).toBeLessThan(0.05);
  });

  it('does not move fortified targets', async () => {
    const sim = await makeSim();
    const p = place(sim, 'trapper', 0, 2, 10);
    const bz = place(sim, 'bastion', 1, 5, 12.5); // 2.5 u from the well point
    bz.fortifyActive = true;
    sim.setInput(p.id, input({ buttons: BTN.ABILITY, aim: 0, aimDist: 3 }));
    p.aim = 0;
    run(sim, 30);
    expect(Math.hypot(bz.x - 5, bz.y - 12.5)).toBeLessThan(0.05);
  });
});
