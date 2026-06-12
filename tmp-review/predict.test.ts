import { describe, expect, it } from 'vitest';
import { makeSim, input, teleport } from '../tests/helpers';
import { CLASSES } from '../src/data/classes';
import { C } from '../src/data/constants';

const DT = 1 / C.SIM_HZ;

/** Verbatim copy of ClientSession.integrate() math (no walls in our lane). */
function clientIntegrate(
  cls: typeof CLASSES['spider'],
  p: { x: number; y: number; vx: number; vy: number },
  inp: { mx: number; my: number },
): void {
  let mx = inp.mx;
  let my = inp.my;
  const il = Math.hypot(mx, my);
  if (il > 1) { mx /= il; my /= il; }
  p.vx += ((mx * cls.moveForce) / cls.mass) * DT;
  p.vy += ((my * cls.moveForce) / cls.mass) * DT;
  const damp = 1 / (1 + cls.linearDamping * DT);
  p.vx *= damp;
  p.vy *= damp;
  const speed = Math.hypot(p.vx, p.vy);
  if (speed > cls.maxSpeed) {
    const brake = (speed - cls.maxSpeed) * 4 * DT;
    p.vx -= (p.vx / speed) * brake;
    p.vy -= (p.vy / speed) * brake;
  }
  p.x += p.vx * DT;
  p.y += p.vy * DT;
}

describe('prediction vs host movement', () => {
  it('SLICK: client integrate (full damping) diverges from host slick damping', async () => {
    const sim = await makeSim();
    const cls = CLASSES.spider;
    const p = sim.addPlayer('a', 'spider', 0, false);
    sim.respawn(p); p.invulnT = 0; p.respawnT = 0;
    teleport(sim, p.id, 0, -14);
    sim.bodies.get(p.id)!.setLinvel({ x: 12, y: 0 }, true);

    const pred = { x: 0, y: -14, vx: 12, vy: 0 };

    sim.setInput(p.id, input({ mx: 0, my: 0 }));
    // host: player stands in a blood pool → slick damping
    for (let i = 0; i < 30; i++) {
      p.inSlick = true; // movementSystem runs first; force the flag fresh each tick
      sim.step();
      clientIntegrate(cls, pred, { mx: 0, my: 0 }); // client predicts WITHOUT slick
    }
    const v = sim.bodies.get(p.id)!.linvel();
    console.log('SLICK after 30 ticks: host x=%s v=%s | pred x=%s v=%s',
      p.x.toFixed(3), v.x.toFixed(3), pred.x.toFixed(3), pred.vx.toFixed(3));
    // The host (slick) slides farther than the client predicts.
    expect(p.x).toBeGreaterThan(pred.x + 0.2);
  });

  it('CLAMP: above-max brake term differs (host damps brake & uses pre-tick v)', async () => {
    const sim = await makeSim();
    const cls = CLASSES.spider;
    const p = sim.addPlayer('a', 'spider', 0, false);
    sim.respawn(p); p.invulnT = 0; p.respawnT = 0;
    teleport(sim, p.id, 0, -14);
    sim.bodies.get(p.id)!.setLinvel({ x: 20, y: 0 }, true); // above maxSpeed 15

    const pred = { x: 0, y: -14, vx: 20, vy: 0 };
    sim.setInput(p.id, input({ mx: 0, my: 0 }));

    p.inSlick = false;
    sim.step();
    clientIntegrate(cls, pred, { mx: 0, my: 0 });

    const v = sim.bodies.get(p.id)!.linvel();
    console.log('CLAMP after 1 tick: host vx=%s | pred vx=%s | delta=%s',
      v.x.toFixed(5), pred.vx.toFixed(5), (v.x - pred.vx).toFixed(5));
    expect(Math.abs(v.x - pred.vx)).toBeGreaterThan(0); // they are NOT identical
  });
});
