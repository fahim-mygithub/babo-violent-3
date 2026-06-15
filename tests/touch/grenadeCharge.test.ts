// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { TouchControls } from '../../src/touch/touchControls';
import { C } from '../../src/data/constants';
import { makeSim, teleport, clearEvents } from '../helpers';

// The grenade drag-arc sets aimDist to max INSTANTLY, but the sim caps throw range
// to chargeMax, which is derived from throwT — and throwT only accrues on ticks
// where BTN.THROW is held. The arc must therefore hold THROW the whole time it is
// active so a held-then-released full-length drag actually reaches GRENADE_MAX_RANGE.
describe('grenade drag-arc charges throwT to full range', () => {
  it('an arc held for the full aim time then released throws near GRENADE_MAX_RANGE', async () => {
    const c = document.createElement('div');
    document.body.appendChild(c);
    const tc = new TouchControls(c, 1);

    const sim = await makeSim();
    const p = sim.addPlayer('Lobber', 'spider', 0, false);
    sim.respawn(p);
    teleport(sim, p.id, -25, -27); // clear west lane, aim +x along the lane
    p.equip = 'smoke'; // smoke pops a locatable zone where it lands
    p.equipCount = 1;
    clearEvents(sim);

    // Begin the arc and drag it to full length, aiming +x (angle 0).
    tc.beginGrenade(840, 300);
    tc.moveGrenade(840 + 400, 300); // well past ARC_DRAG_PX → max aimDist, aim 0

    // Hold the arc across MORE than the full charge time, feeding the touch sample
    // (which holds BTN.THROW while the arc is active) as the player's input.
    const chargeTicks = Math.ceil(C.GRENADE_AIM_TIME * C.SIM_HZ) + 5;
    for (let i = 0; i < chargeTicks; i++) {
      sim.setInput(p.id, tc.sample({ x: 0, y: 0 }, 0, 0));
      sim.step();
    }
    expect(p.throwT).toBeCloseTo(C.GRENADE_AIM_TIME, 2); // fully charged from the held arc

    // Release: the falling edge of BTN.THROW fires releaseThrow on the next step.
    tc.endGrenade();
    sim.setInput(p.id, tc.sample({ x: 0, y: 0 }, 0, 0));
    sim.step();

    // Let the smoke land and read its distance from the thrower's start.
    let pop: { x: number; y: number } | undefined;
    for (let i = 0; i < 300 && !pop; i++) {
      sim.step();
      const e = sim.events.find((ev) => ev.t === 'smokePop');
      if (e && e.t === 'smokePop') pop = { x: e.x, y: e.y };
    }
    expect(pop).toBeDefined();
    const dist = Math.hypot(pop!.x - (-25), pop!.y - (-27));
    // A fully-charged, full-length drag must reach near the max range, NOT be
    // capped to the min by an uncharged throwT.
    expect(dist).toBeGreaterThan(C.GRENADE_MAX_RANGE - 2);

    tc.dispose();
  });
});
