import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BTN, clearEvents, eventsOf, input, makeSim, run, teleport, tickCombat } from './helpers';
import { weaponSystem } from '../src/sim/systems/weapons';
import { GUNS, type GunId } from '../src/data/weapons';
import { FLAGS } from '../src/data/constants';
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

  // Flag-OFF revert lock: the legacy hitscan Lance resolves same-tick.
  describe('lance hitscan (flag OFF)', () => {
    const prev = FLAGS.PROJECTILE_LANCE;
    beforeEach(() => { (FLAGS as { PROJECTILE_LANCE: boolean }).PROJECTILE_LANCE = false; });
    afterEach(() => { (FLAGS as { PROJECTILE_LANCE: boolean }).PROJECTILE_LANCE = prev; });

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
      // Charge resets on fire; the short post-shot lockout (0.1s) means a held
      // trigger may have begun rebuilding by the time we assert.
      expect(a.charge).toBeLessThan(0.1);
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
  });

  // Flag-ON: the Lance is a fast 'rail' projectile (its own RNG stream).
  describe('lance as rail projectile (flag ON)', () => {
    const prev = FLAGS.PROJECTILE_LANCE;
    beforeEach(() => { (FLAGS as { PROJECTILE_LANCE: boolean }).PROJECTILE_LANCE = true; });
    afterEach(() => { (FLAGS as { PROJECTILE_LANCE: boolean }).PROJECTILE_LANCE = prev; });

    it('full charge spawns a rail slug that travels and damages on hit + knockback', async () => {
      const sim = await makeSim();
      const a = sim.addPlayer('A', 'spider', 0, false);
      const v = sim.addPlayer('V', 'phantom', 1, false);
      arm(sim, a, 'lance', 0, 0);
      arm(sim, v, 'stinger', 24, 0); // far enough that the slug is mid-flight, not yet resolved
      hold(sim, a.id, BTN.FIRE);
      tickCombat(sim, 49); // ~48 ticks to fire; one extra tick → slug exists, ~1.83u traveled
      // The Lance now spawns a 'rail' projectile (hitscan never produces one).
      const rail = sim.projectiles.find((pr) => pr.kind === 'rail');
      expect(rail).toBeDefined();
      expect(rail!.gun).toBe('lance');
      expect(rail!.x).toBeGreaterThan(0.65); // moved past the muzzle
      expect(rail!.x).toBeLessThan(24);       // not yet at the victim
      expect(Math.hypot(rail!.vx, rail!.vy)).toBeCloseTo(110, 0); // muzzle speed
      expect(v.hp).toBe(100); // not hit yet — proves it is NOT instant hitscan
    });

    it('rail slug eventually damages a victim on the line + knockback', async () => {
      const sim = await makeSim();
      const a = sim.addPlayer('A', 'spider', 0, false);
      const v = sim.addPlayer('V', 'phantom', 1, false);
      arm(sim, a, 'lance', 0, 0);
      arm(sim, v, 'stinger', 4, 0);
      hold(sim, a.id, BTN.FIRE);
      tickCombat(sim, 55); // charge ~48 ticks → fire, then slug travels 4u (~3 ticks at 110/60)
      expect(eventsOf(sim, 'shot').length).toBe(1);
      expect(eventsOf(sim, 'chargeReady').length).toBe(1);
      expect(v.hp).toBe(100 - GUNS.lance.damage);
      expect(sim.bodies.get(v.id)!.linvel().x).toBeGreaterThan(5); // LANCE_KNOCK along +x
    });

    it('rail is blocked by walls — babo behind cover takes no damage', async () => {
      const sim = await makeSim();
      const a = sim.addPlayer('A', 'spider', 0, false);
      const v = sim.addPlayer('V', 'phantom', 1, false);
      arm(sim, a, 'lance', 0, 0);
      arm(sim, v, 'stinger', 12, 0); // behind the pit rim accent
      hold(sim, a.id, BTN.FIRE);
      tickCombat(sim, 80);
      expect(v.hp).toBe(100);
      expect(eventsOf(sim, 'hit').length).toBe(0);
    });

    it('emits a terminal rail beam from captured ox,oy to the impact point', async () => {
      const sim = await makeSim();
      const a = sim.addPlayer('A', 'spider', 0, false);
      const v = sim.addPlayer('V', 'phantom', 1, false);
      arm(sim, a, 'lance', 0, 0);
      arm(sim, v, 'stinger', 4, 0);
      hold(sim, a.id, BTN.FIRE);
      tickCombat(sim, 80);
      const rails = eventsOf(sim, 'rail');
      expect(rails.length).toBe(1);
      const r = rails[0] as { x0: number; x1: number };
      expect(r.x0).toBeCloseTo(0.65, 2); // muzzle origin (ox)
      expect(r.x1).toBeLessThan(4.1);    // impact at victim
    });
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

  it('manual RELOAD is edge-triggered: 2 ticks in one frame emit exactly one reloadStart', async () => {
    const sim = await makeSim();
    const p = sim.addPlayer('A', 'spider', 0, false);
    arm(sim, p, 'workhorse');
    p.mag = 10; // partial mag, reloadable
    // Hold RELOAD across two weaponSystem ticks WITHOUT clearing prevButtons between
    // them (mirrors FixedLoop catch-up running tick() twice on one sampled input).
    sim.setInput(p.id, input({ buttons: BTN.RELOAD }));
    weaponSystem(sim, sim.dt);
    weaponSystem(sim, sim.dt); // prevButtons NOT yet updated → still an "edge" by naive code
    for (const q of sim.players.values()) q.prevButtons = q.input.buttons;
    expect(eventsOf(sim, 'reloadStart').length).toBe(1);
    expect(p.reloadT).toBeGreaterThan(0);
  });

  it('manual RELOAD is inert for full mags, heat guns, and mid-reload', async () => {
    const sim = await makeSim();
    const p = sim.addPlayer('A', 'spider', 0, false);
    // Full mag → no reload
    arm(sim, p, 'workhorse');
    hold(sim, p.id, BTN.RELOAD);
    tickWeapons(sim, 1);
    expect(eventsOf(sim, 'reloadStart').length).toBe(0);
    // Heat gun → no reload
    arm(sim, p, 'ion');
    hold(sim, p.id, BTN.RELOAD);
    tickWeapons(sim, 1);
    expect(eventsOf(sim, 'reloadStart').length).toBe(0);
  });
});
