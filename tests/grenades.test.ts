import { describe, expect, it } from 'vitest';
import { C } from '../src/data/constants';
import type { GameSim } from '../src/sim/sim';
import type { PlayerState } from '../src/sim/types';
import { BTN, clearEvents, input, makeSim, run, runUntil, teleport } from './helpers';

/** Lone live player parked in the clear west lane (y = -27 is wall-free). */
async function setup(): Promise<{ sim: GameSim; p: PlayerState }> {
  const sim = await makeSim();
  const p = sim.addPlayer('Lobber', 'spider', 0, false);
  sim.respawn(p);
  teleport(sim, p.id, -25, -27);
  return { sim, p };
}

/**
 * Hold THROW for one step, optionally force throwT / velocity, then release.
 * The release edge fires inside the second step.
 */
function throwGrenade(
  sim: GameSim, p: PlayerState,
  opts: { aim: number; aimDist: number; throwT?: number; vx?: number; vy?: number },
): void {
  sim.setInput(p.id, input({ aim: opts.aim, aimDist: opts.aimDist, buttons: BTN.THROW }));
  sim.step();
  if (opts.throwT !== undefined) p.throwT = opts.throwT;
  if (opts.vx !== undefined || opts.vy !== undefined) {
    p.vx = opts.vx ?? 0;
    p.vy = opts.vy ?? 0;
    sim.bodies.get(p.id)!.setLinvel({ x: p.vx, y: p.vy }, true);
  }
  sim.setInput(p.id, input({ aim: opts.aim, aimDist: opts.aimDist, buttons: 0 }));
  sim.step();
}

/** First smokePop event since the last clearEvents (throws if absent). */
function firstPop(sim: GameSim): { x: number; y: number; r: number } {
  const pop = sim.events.find((e) => e.t === 'smokePop');
  if (!pop || pop.t !== 'smokePop') throw new Error('no smokePop event');
  return pop;
}

describe('grenade system', () => {
  it('hold charges throwT; release spawns a frag and decrements the count', async () => {
    const { sim, p } = await setup();
    expect(p.grenades).toBe(C.START_GRENADES);
    sim.setInput(p.id, input({ aim: 0, aimDist: 5, buttons: BTN.THROW }));
    run(sim, 10);
    expect(p.throwing).toBe(true);
    expect(p.throwT).toBeCloseTo(10 / 60, 5);
    expect(sim.grenades.length).toBe(0); // nothing leaves the hand while held
    sim.setInput(p.id, input({ aim: 0, aimDist: 5, buttons: 0 }));
    sim.step();
    expect(sim.grenades.length).toBe(1);
    expect(sim.grenades[0].kind).toBe('frag');
    expect(p.grenades).toBe(C.START_GRENADES - 1);
    expect(p.throwT).toBe(0);
    expect(p.throwing).toBe(false);
    expect(sim.events.some((e) => e.t === 'grenadeThrow' && e.player === p.id)).toBe(true);
  });

  it('throwT caps at GRENADE_AIM_TIME while held', async () => {
    const { sim, p } = await setup();
    sim.setInput(p.id, input({ aim: 0, aimDist: 5, buttons: BTN.THROW }));
    run(sim, Math.ceil(C.GRENADE_AIM_TIME * C.SIM_HZ) + 30);
    expect(p.throwT).toBeCloseTo(C.GRENADE_AIM_TIME, 5);
    expect(p.throwing).toBe(true);
  });

  it('release with empty pockets throws nothing and resets state', async () => {
    const { sim, p } = await setup();
    p.grenades = 0;
    p.equip = null;
    p.equipCount = 0;
    clearEvents(sim);
    throwGrenade(sim, p, { aim: 0, aimDist: 8 });
    expect(sim.grenades.length).toBe(0);
    expect(sim.events.some((e) => e.t === 'grenadeThrow')).toBe(false);
    expect(p.throwT).toBe(0);
    expect(p.throwing).toBe(false);
  });

  it('scavenged equipment is thrown before frags and is consumed', async () => {
    const { sim, p } = await setup();
    p.equip = 'smoke';
    p.equipCount = 1;
    throwGrenade(sim, p, { aim: 0, aimDist: 8 });
    expect(sim.grenades.length).toBe(1);
    expect(sim.grenades[0].kind).toBe('smoke');
    expect(p.equip).toBe(null);
    expect(p.equipCount).toBe(0);
    expect(p.grenades).toBe(C.START_GRENADES); // frags untouched
  });

  it('frag explodes after landing + fuse and damages a nearby enemy', async () => {
    const sim = await makeSim();
    const a = sim.addPlayer('A', 'spider', 0, false);
    const v = sim.addPlayer('V', 'bastion', 1, false);
    sim.respawn(a);
    sim.respawn(v);
    teleport(sim, a.id, 0, -2);
    teleport(sim, v.id, 0, 2);
    v.invulnT = 0;
    clearEvents(sim);
    throwGrenade(sim, a, { aim: Math.PI / 2, aimDist: 4, throwT: C.GRENADE_AIM_TIME });
    expect(sim.grenades.length).toBe(1);
    const ticks = runUntil(sim, () => v.hp < C.MAX_HP, 600);
    expect(ticks).toBeGreaterThan(60); // landed first, then the fuse burned
    expect(sim.grenades.length).toBe(0); // spent by the explosion
    expect(sim.events.some((e) => e.t === 'explosion' && e.kind === 'frag')).toBe(true);
  });

  it('molotov ignites a fire zone where it lands', async () => {
    const { sim, p } = await setup();
    p.equip = 'molotov';
    p.equipCount = 1;
    throwGrenade(sim, p, { aim: 0, aimDist: 6, throwT: C.GRENADE_AIM_TIME });
    expect(runUntil(sim, () => sim.fires.length > 0, 300)).toBeGreaterThanOrEqual(0);
    const fire = sim.fires[0];
    expect(fire.r).toBeCloseTo(C.MOLOTOV_RADIUS, 5);
    expect(fire.x).toBeGreaterThan(-25 + 4); // landed downrange, not at the feet
    expect(sim.grenades.length).toBe(0); // molotov is spent on impact
  });

  it('smoke pops a zone that blocks line of sight', async () => {
    const { sim, p } = await setup();
    expect(sim.hasLOS(-25, -27, -15, -27)).toBe(true);
    p.equip = 'smoke';
    p.equipCount = 1;
    clearEvents(sim);
    throwGrenade(sim, p, { aim: 0, aimDist: 6, throwT: C.GRENADE_AIM_TIME });
    expect(runUntil(sim, () => sim.smokes.length > 0, 300)).toBeGreaterThanOrEqual(0);
    const s = sim.smokes[0];
    expect(s.r).toBeCloseTo(C.SMOKE_RADIUS, 5);
    expect(s.ttl).toBeGreaterThan(C.SMOKE_LIFETIME - 0.1);
    expect(sim.events.some((e) => e.t === 'smokePop')).toBe(true);
    expect(sim.hasLOS(-25, -27, -15, -27)).toBe(false); // sight line crosses the zone
  });

  it('max-charge lob clears low cover; a flat throw bounces back off it', async () => {
    const { sim, p } = await setup();
    // Side-lane pillar at (22, 12): 2.4×2.4 footprint, lobbable height 1.4.
    // Thrower stands 2.5 u south of its near face (y = 13.2), aiming -y across it.
    teleport(sim, p.id, 22, 15.7);
    p.equip = 'smoke';
    p.equipCount = 1;
    clearEvents(sim);
    throwGrenade(sim, p, { aim: -Math.PI / 2, aimDist: 12, throwT: C.GRENADE_AIM_TIME });
    expect(runUntil(sim, () => sim.events.some((e) => e.t === 'smokePop'), 300)).toBeGreaterThanOrEqual(0);
    expect(sim.events.some((e) => e.t === 'grenadeBounce')).toBe(false);
    expect(firstPop(sim).y).toBeLessThan(10.8); // landed beyond the pillar's far face

    clearEvents(sim);
    teleport(sim, p.id, 22, 15.7);
    p.equip = 'smoke';
    p.equipCount = 1;
    throwGrenade(sim, p, { aim: -Math.PI / 2, aimDist: 0, throwT: 0 }); // min-range flat throw
    expect(runUntil(sim, () => sim.events.some((e) => e.t === 'smokePop'), 300)).toBeGreaterThanOrEqual(0);
    expect(sim.events.some((e) => e.t === 'grenadeBounce')).toBe(true);
    expect(firstPop(sim).y).toBeGreaterThan(13.2); // came to rest on the thrower's side
  });

  it('thrown grenades inherit part of the thrower velocity', async () => {
    const { sim, p } = await setup();
    p.equip = 'smoke';
    p.equipCount = 1;
    clearEvents(sim);
    throwGrenade(sim, p, { aim: 0, aimDist: 12, throwT: C.GRENADE_AIM_TIME });
    expect(runUntil(sim, () => sim.events.some((e) => e.t === 'smokePop'), 300)).toBeGreaterThanOrEqual(0);
    const still = firstPop(sim);

    clearEvents(sim);
    teleport(sim, p.id, -25, -27);
    p.equip = 'smoke';
    p.equipCount = 1;
    throwGrenade(sim, p, { aim: 0, aimDist: 12, throwT: C.GRENADE_AIM_TIME, vx: 8, vy: 0 });
    expect(runUntil(sim, () => sim.events.some((e) => e.t === 'smokePop'), 300)).toBeGreaterThanOrEqual(0);
    const moving = firstPop(sim);
    expect(moving.x).toBeGreaterThan(still.x + 1); // momentum carried it farther
  });
});
