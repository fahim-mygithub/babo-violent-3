import { describe, expect, it } from 'vitest';
import { BTN, clearEvents, eventsOf, input, makeSim, run, teleport } from './helpers';
import { weaponSystem } from '../src/sim/systems/weapons';
import { GUNS, type GunId } from '../src/data/weapons';
import type { GameSim } from '../src/sim/sim';
import type { PlayerState } from '../src/sim/types';

// These tests drive weaponSystem directly (not sim.step) so they only exercise
// this system; prevButtons bookkeeping is replicated from sim.step.
function tickWeapons(sim: GameSim, n = 1): void {
  for (let i = 0; i < n; i++) {
    weaponSystem(sim, sim.dt);
    for (const p of sim.players.values()) p.prevButtons = p.input.buttons;
  }
}

/** Respawn at a fixed spot with a given gun, no invuln, events cleared. */
function arm(sim: GameSim, p: PlayerState, gun: GunId, x = 0, y = 0): void {
  sim.respawn(p);
  teleport(sim, p.id, x, y);
  p.gun = gun;
  p.mag = GUNS[gun].magSize ?? 0;
  p.invulnT = 0;
  p.respawnT = 0;
  p.aim = 0; // +x
  clearEvents(sim);
}

function hold(sim: GameSim, id: number, buttons: number, aim = 0): void {
  sim.setInput(id, input({ buttons, aim }));
}

describe('weaponSystem', () => {
  it('stinger fires ~10 shots over 1s of held fire', async () => {
    const sim = await makeSim();
    const p = sim.addPlayer('A', 'spider', 0, false);
    arm(sim, p, 'stinger');
    hold(sim, p.id, BTN.FIRE);
    tickWeapons(sim, 60);
    const shots = eventsOf(sim, 'shot').length;
    expect(shots).toBeGreaterThanOrEqual(9);
    expect(shots).toBeLessThanOrEqual(11);
    expect(p.mag).toBe(30 - shots);
  });

  it('auto-reloads on empty mag and refills after reloadTime', async () => {
    const sim = await makeSim();
    const p = sim.addPlayer('A', 'spider', 0, false);
    arm(sim, p, 'stinger');
    p.mag = 2;
    hold(sim, p.id, BTN.FIRE);
    tickWeapons(sim, 7); // shots at ticks 1 and 7 empty the mag
    expect(p.mag).toBe(0);
    expect(eventsOf(sim, 'reloadStart').length).toBe(1);
    expect(p.reloadT).toBeGreaterThan(0);
    const shotsAtReload = eventsOf(sim, 'shot').length;
    expect(shotsAtReload).toBe(2);
    tickWeapons(sim, 80); // 1.33s — still mid-reload (1.4s), no firing
    expect(eventsOf(sim, 'shot').length).toBe(shotsAtReload);
    expect(eventsOf(sim, 'reloadDone').length).toBe(0);
    tickWeapons(sim, 10); // crosses reloadTime → refilled, firing resumes
    expect(eventsOf(sim, 'reloadDone').length).toBe(1);
    expect(eventsOf(sim, 'shot').length).toBeGreaterThan(shotsAtReload);
    expect(p.mag).toBeGreaterThan(25);
  });

  it('maw blast spawns 8 pellets, one shot event, and kicks the shooter backward', async () => {
    const sim = await makeSim();
    const p = sim.addPlayer('A', 'spider', 0, false);
    arm(sim, p, 'maw');
    hold(sim, p.id, BTN.FIRE); // aim +x
    tickWeapons(sim, 1);
    expect(eventsOf(sim, 'shot').length).toBe(1);
    expect(p.mag).toBe(5);
    const pellets = sim.projectiles.filter((pr) => pr.owner === p.id);
    expect(pellets.length).toBe(8);
    for (const pr of pellets) {
      expect(pr.kind).toBe('bullet');
      expect(pr.maxDist).toBe(GUNS.maw.range);
      expect(pr.damage).toBe(GUNS.maw.damage);
      expect(Math.hypot(pr.vx, pr.vy)).toBeCloseTo(GUNS.maw.projectileSpeed, 5);
    }
    // Pellets get independent spread rolls — not all collinear
    const angles = new Set(pellets.map((pr) => Math.atan2(pr.vy, pr.vx).toFixed(6)));
    expect(angles.size).toBeGreaterThan(1);
    // Recoil opposite aim (+x → vx < 0); spider mass 1, recoil 14
    expect(sim.bodies.get(p.id)!.linvel().x).toBeLessThan(-5);
  });

  it('thumper fires rockets, pyre fires flames', async () => {
    const sim = await makeSim();
    const p = sim.addPlayer('A', 'bastion', 0, false);
    arm(sim, p, 'thumper');
    hold(sim, p.id, BTN.FIRE);
    tickWeapons(sim, 1);
    expect(sim.projectiles.some((pr) => pr.kind === 'rocket' && pr.gun === 'thumper')).toBe(true);

    sim.projectiles.length = 0;
    arm(sim, p, 'pyre');
    hold(sim, p.id, BTN.FIRE);
    tickWeapons(sim, 1);
    const flame = sim.projectiles.find((pr) => pr.kind === 'flame');
    expect(flame).toBeDefined();
    expect(flame!.maxDist).toBe(GUNS.pyre.range);
    expect(Math.hypot(flame!.vx, flame!.vy)).toBeCloseTo(GUNS.pyre.projectileSpeed, 5);
  });

  it('ion overheats under sustained fire, locks out, then recovers', async () => {
    const sim = await makeSim();
    const p = sim.addPlayer('A', 'spider', 0, false);
    arm(sim, p, 'ion');
    hold(sim, p.id, BTN.FIRE);
    tickWeapons(sim, 150); // 2.5s — 19th shot trips heat >= 1
    expect(eventsOf(sim, 'overheat').length).toBe(1);
    expect(p.overheatT).toBeGreaterThan(0);
    const lockedShots = eventsOf(sim, 'shot').length;
    expect(lockedShots).toBeGreaterThan(15);
    tickWeapons(sim, 85); // still inside the 1.6s lockout — silent, cooling
    expect(eventsOf(sim, 'shot').length).toBe(lockedShots);
    expect(p.heat).toBeLessThan(1);
    tickWeapons(sim, 30); // lockout expires → firing resumes
    expect(eventsOf(sim, 'shot').length).toBeGreaterThan(lockedShots);
    expect(eventsOf(sim, 'overheat').length).toBe(1); // no double-trip yet
  });

  it('hurricane fires nothing during spin-up, then opens fire at full spin', async () => {
    const sim = await makeSim();
    const p = sim.addPlayer('A', 'spider', 0, false);
    arm(sim, p, 'hurricane');
    hold(sim, p.id, BTN.FIRE);
    tickWeapons(sim, 30); // 0.5s of a 0.6s spin-up
    expect(eventsOf(sim, 'shot').length).toBe(0);
    expect(p.spin).toBeGreaterThan(0);
    expect(p.spin).toBeLessThan(1);
    tickWeapons(sim, 20); // crosses full spin
    expect(eventsOf(sim, 'spinup').some((e) => e.t === 'spinup' && e.on)).toBe(true);
    expect(eventsOf(sim, 'shot').length).toBeGreaterThan(0);
    // Release → spin winds down and emits the off edge
    hold(sim, p.id, 0);
    tickWeapons(sim, 5);
    expect(eventsOf(sim, 'spinup').some((e) => e.t === 'spinup' && !e.on)).toBe(true);
    expect(p.spin).toBeLessThan(1);
  });

  it('lance full charge emits rail and damages a babo on the line', async () => {
    const sim = await makeSim();
    const a = sim.addPlayer('A', 'spider', 0, false);
    const v = sim.addPlayer('V', 'phantom', 1, false);
    arm(sim, a, 'lance', 0, 0);
    arm(sim, v, 'stinger', 4, 0); // on the +x ray, in front of the pit rim wall
    hold(sim, a.id, BTN.FIRE);
    tickWeapons(sim, 55); // chargeTime 0.8s = ~48 ticks → fires once
    expect(eventsOf(sim, 'chargeReady').length).toBe(1);
    expect(eventsOf(sim, 'rail').length).toBe(1);
    expect(eventsOf(sim, 'shot').length).toBe(1);
    expect(a.charge).toBe(0);
    expect(v.hp).toBe(100 - GUNS.lance.damage);
    // Knock along the ray (+x); phantom mass 0.8 → Δv = 12.5
    expect(sim.bodies.get(v.id)!.linvel().x).toBeGreaterThan(5);
    // Rail stops at the victim, not max range
    const rail = eventsOf(sim, 'rail')[0] as { x1: number };
    expect(rail.x1).toBeLessThan(4.1);
  });

  it('lance is blocked by walls — babo behind cover takes no damage', async () => {
    const sim = await makeSim();
    const a = sim.addPlayer('A', 'spider', 0, false);
    const v = sim.addPlayer('V', 'phantom', 1, false);
    arm(sim, a, 'lance', 0, 0);
    arm(sim, v, 'stinger', 12, 0); // behind the pit rim accent at x∈[7.1, 8.9]
    hold(sim, a.id, BTN.FIRE);
    tickWeapons(sim, 55);
    expect(eventsOf(sim, 'rail').length).toBe(1);
    expect(v.hp).toBe(100);
    expect(eventsOf(sim, 'hit').length).toBe(0);
    const rail = eventsOf(sim, 'rail')[0] as { x1: number };
    expect(rail.x1).toBeLessThan(9); // endpoint clamped to the wall face
  });

  it('lance charge decays when released before full', async () => {
    const sim = await makeSim();
    const p = sim.addPlayer('A', 'spider', 0, false);
    arm(sim, p, 'lance');
    hold(sim, p.id, BTN.FIRE);
    tickWeapons(sim, 24); // ~half charge
    const half = p.charge;
    expect(half).toBeGreaterThan(0.3);
    expect(half).toBeLessThan(1);
    hold(sim, p.id, 0);
    tickWeapons(sim, 8); // decays at 3x build rate
    expect(p.charge).toBeLessThan(half);
    tickWeapons(sim, 16);
    expect(p.charge).toBe(0);
    expect(eventsOf(sim, 'shot').length).toBe(0);
  });

  it('spreadAcc grows while discharging and decays back to 0 when idle', async () => {
    const sim = await makeSim();
    const p = sim.addPlayer('A', 'spider', 0, false);
    arm(sim, p, 'stinger');
    hold(sim, p.id, BTN.FIRE);
    tickWeapons(sim, 55); // tick 55 is a discharge tick → bloom just grew
    expect(p.spreadAcc).toBeGreaterThan(0);
    expect(p.spreadAcc).toBeLessThanOrEqual(GUNS.stinger.spreadMax - GUNS.stinger.spread + 1e-9);
    hold(sim, p.id, 0);
    tickWeapons(sim, 60); // full decay takes at most spreadMax/(spreadMax/0.8) = 0.8s
    expect(p.spreadAcc).toBe(0);
  });

  it('dead players do not fire but cooldown timers still tick', async () => {
    const sim = await makeSim();
    const p = sim.addPlayer('A', 'spider', 0, false);
    arm(sim, p, 'stinger');
    p.alive = false;
    p.fireCD = 0.1;
    p.overheatT = 0.1;
    p.spin = 1;
    p.charge = 0.5;
    hold(sim, p.id, BTN.FIRE);
    tickWeapons(sim, 10);
    expect(eventsOf(sim, 'shot').length).toBe(0);
    expect(sim.projectiles.length).toBe(0);
    expect(p.fireCD).toBe(0);
    expect(p.overheatT).toBe(0);
    expect(p.spin).toBe(0);
    expect(p.charge).toBe(0);
  });

  it('fires through the full sim.step pipeline', async () => {
    const sim = await makeSim();
    const p = sim.addPlayer('A', 'spider', 0, false);
    arm(sim, p, 'stinger');
    sim.setInput(p.id, input({ buttons: BTN.FIRE, aim: Math.PI / 2 }));
    run(sim, 60);
    expect(eventsOf(sim, 'shot').length).toBeGreaterThan(5);
  });
});
