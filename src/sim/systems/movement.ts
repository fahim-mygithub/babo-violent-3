import { dist, len, norm } from '../../core/math';
import { ABILITY, CLASSES } from '../../data/classes';
import { C } from '../../data/constants';
import type { GameSim } from '../sim';

/**
 * Force-based movement with class chassis feel.
 * - Apply moveForce toward normalized input dir (never set velocity directly).
 * - Linear damping comes from the class; multiply by C.SLICK_DAMPING_MULT while
 *   the player overlaps any blood pool (set p.inSlick; bloodSystem reads it too).
 * - Clamp speed softly to class maxSpeed (only damp the excess, so recoil and
 *   abilities can exceed it briefly).
 * - Grapple: while p.grappleActive, pull toward (grappleX, grappleY) when the
 *   rope is taut (distance > grappleLen), spring force ABILITY.GRAPPLE_PULL.
 * - Tick down generic timers: invulnT.
 */
export function movementSystem(sim: GameSim, dt: number): void {
  for (const p of sim.players.values()) {
    const body = sim.bodies.get(p.id);
    if (!body) continue;

    if (!p.alive) {
      body.resetForces(true);
      continue;
    }

    const cls = CLASSES[p.classId];

    // Timers owned by this system
    p.invulnT = Math.max(0, p.invulnT - dt);

    // Input direction — normalize only when diagonals exceed unit length
    let mx = p.input.mx;
    let my = p.input.my;
    const il = len(mx, my);
    if (il > 1) { mx /= il; my /= il; }

    body.resetForces(true);
    if (!p.dashActive) {
      const f = cls.moveForce * C.MOVE_FORCE_SCALE;
      body.addForce({ x: mx * f, y: my * f }, true);
    }

    // Damping: slick blood cuts grip, fortify digs in
    body.setLinearDamping(
      cls.linearDamping * (p.inSlick ? C.SLICK_DAMPING_MULT : 1) * (p.fortifyActive ? 2 : 1),
    );

    // Soft speed clamp — brake only the excess so recoil/abilities can spike past max
    const v = body.linvel();
    const speed = len(v.x, v.y);
    if (speed > cls.maxSpeed && !p.dashActive && !p.grappleActive) {
      const brake = (speed - cls.maxSpeed) * cls.mass * 4;
      body.addForce({ x: (-v.x / speed) * brake, y: (-v.y / speed) * brake }, true);
    }

    // Grapple swing — spring toward the anchor while the rope is taut
    if (p.grappleActive) {
      const tr = body.translation();
      const d = dist(tr.x, tr.y, p.grappleX, p.grappleY);
      if (d > p.grappleLen) {
        const [nx, ny] = norm(p.grappleX - tr.x, p.grappleY - tr.y);
        const pull = ABILITY.GRAPPLE_PULL * cls.mass * Math.min(d - p.grappleLen, 2);
        body.addForce({ x: nx * pull, y: ny * pull }, true);
      }
    }
  }
}
