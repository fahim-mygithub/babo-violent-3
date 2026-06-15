import { TAU, angleDiff, angleTo, clamp, dist, norm } from '../../core/math';
import { ABILITY } from '../../data/classes';
import { C, FLAGS } from '../../data/constants';
import { GUNS, type GunId } from '../../data/weapons';
import { LANCE_SPEED } from './weapons';
import { BTN, type PlayerState } from '../types';
import type { GameSim } from '../sim';

/** Sweet-spot engagement distance per gun (approach beyond it, back off inside). */
const PREFERRED_RANGE: Record<GunId, number> = {
  maw: 4, pyre: 4, stinger: 9, ion: 9, workhorse: 11, hurricane: 11, thumper: 13, lance: 13,
};

/** Scavenging priority; bots tap PICKUP only for a strict upgrade. */
const GUN_RANK: Record<GunId, number> = {
  stinger: 0, pyre: 1, maw: 2, ion: 3, workhorse: 4, hurricane: 5, lance: 6, thumper: 7,
};

const HUNT_MEMORY = 2.0;   // seconds we chase a last-seen position
const FEELER_LEN = 1.8;    // wall-avoidance ray length
const FEELER_ANGLE = 0.52; // ±30° of move dir
const AIM_LAMBDA = 12;     // exponential aim smoothing rate (1/s)
const FIRE_CONE = 0.25;    // |angleDiff| under which we pull the trigger

interface BotMind {
  thinkT: number;        // countdown to next (cheap) decision pass
  targetId: number;      // current enemy, -1 none
  lastSeenX: number;
  lastSeenY: number;
  huntT: number;         // memory of last-seen position
  aimNoise: number;      // angular error, re-rolled each think
  strafeDir: number;     // 1 | -1 orbit direction
  strafeT: number;       // countdown to orbit flip
  throwHold: number;     // >0 while winding a grenade throw
  throwX: number;
  throwY: number;
  throwDist: number;
  grenadeCD: number;     // min spacing between throws
  abilityHold: number;   // >0 while holding ABILITY (one tick for press-casts)
  pickupTap: boolean;    // tap PICKUP this tick
  pickupCD: number;
  healthGoal: boolean;   // low-HP loot run target valid
  healthX: number;
  healthY: number;
  wanderX: number;
  wanderY: number;
  wanderT: number;       // countdown to wander re-roll
  stuckT: number;        // time spent trying to move at ~zero velocity
  unstuckT: number;      // random-walk override remaining
  unstuckX: number;
  unstuckY: number;
  lastMoveX: number;     // previous tick's move dir (grapple feeler)
  lastMoveY: number;
}

// Per-sim bot memory (tests create many sims; WeakMap lets them collect).
const minds = new WeakMap<GameSim, Map<number, BotMind>>();

function newMind(sim: GameSim): BotMind {
  return {
    thinkT: 0,
    targetId: -1,
    lastSeenX: 0, lastSeenY: 0, huntT: 0,
    aimNoise: 0,
    strafeDir: sim.rng.next() < 0.5 ? -1 : 1,
    strafeT: sim.rng.range(1, 2.5),
    throwHold: 0, throwX: 0, throwY: 0, throwDist: 0,
    grenadeCD: sim.rng.range(1.5, 3),
    abilityHold: 0,
    pickupTap: false, pickupCD: 0,
    healthGoal: false, healthX: 0, healthY: 0,
    wanderX: 0, wanderY: 0, wanderT: 0,
    stuckT: 0, unstuckT: 0, unstuckX: 0, unstuckY: 0,
    lastMoveX: 0, lastMoveY: 0,
  };
}

function isEnemy(p: PlayerState, q: PlayerState): boolean {
  return p.team === -1 || q.team === -1 || q.team !== p.team;
}

/**
 * Bot AI: writes PlayerInput for every p.bot each tick.
 * Utility-driven: target nearest visible enemy (sim.hasLOS), keep gun's
 * preferred range, strafe-orbit, aim with error + a bit of lead, fire on LOS,
 * reload-aware, seek health when low, seek gun/equip pickups when convenient,
 * use ability situationally, throw grenades at clumps, follow wounded trails.
 * Avoid walls via short feeler raycasts. Personality jitter from sim.rng.
 */
export function botSystem(sim: GameSim, dt: number): void {
  let mem = minds.get(sim);
  if (!mem) { mem = new Map(); minds.set(sim, mem); }

  for (const p of sim.players.values()) {
    if (!p.bot) continue;
    if (!p.alive) {
      p.input.mx = 0; p.input.my = 0; p.input.buttons = 0; p.input.seq = 0;
      continue;
    }
    let m = mem.get(p.id);
    if (!m) { m = newMind(sim); mem.set(p.id, m); }

    // Owned timers (BotMind only — no PlayerState timers ticked here)
    m.huntT -= dt; m.grenadeCD -= dt; m.pickupCD -= dt;
    m.wanderT -= dt; m.unstuckT -= dt; m.thinkT -= dt;
    m.strafeT -= dt;
    if (m.strafeT <= 0) { m.strafeDir *= -1; m.strafeT = sim.rng.range(1, 2.5); }

    if (m.thinkT <= 0) {
      m.thinkT = sim.rng.range(0.08, 0.13);
      think(sim, p, m);
    }
    act(sim, p, m, dt);
  }
}

/** Heavy decisions every ~0.1s: targeting, loot, abilities, grenades, wander. */
function think(sim: GameSim, p: PlayerState, m: BotMind): void {
  m.aimNoise = sim.rng.spread(0.1);

  // TARGET: nearest alive enemy with line of sight
  let best: PlayerState | null = null;
  let bestD = Infinity;
  for (const q of sim.players.values()) {
    if (q.id === p.id || !q.alive || !isEnemy(p, q)) continue;
    const d = dist(p.x, p.y, q.x, q.y);
    if (d < bestD && sim.hasLOS(p.x, p.y, q.x, q.y)) { best = q; bestD = d; }
  }
  if (best) {
    m.targetId = best.id;
    m.lastSeenX = best.x; m.lastSeenY = best.y;
    m.huntT = HUNT_MEMORY;
  } else if (m.huntT <= 0) {
    m.targetId = -1;
  }

  // LOOT: health run when hurting
  m.healthGoal = false;
  if (p.hp < 50) {
    let hd = 12;
    for (const pk of sim.pickups) {
      if (pk.kind !== 'health') continue;
      const d = dist(p.x, p.y, pk.x, pk.y);
      if (d < hd) { hd = d; m.healthGoal = true; m.healthX = pk.x; m.healthY = pk.y; }
    }
  }
  // LOOT: gun upgrade underfoot → tap PICKUP for one tick
  if (m.pickupCD <= 0) {
    for (const pk of sim.pickups) {
      if (pk.kind === 'gun' && pk.gun && GUN_RANK[pk.gun] > GUN_RANK[p.gun]
        && dist(p.x, p.y, pk.x, pk.y) <= C.GUN_PICKUP_RADIUS) {
        m.pickupTap = true;
        m.pickupCD = 0.6;
        break;
      }
    }
  }

  // GRENADE: wind up a throw at a visible target in the lob band
  if (best && m.throwHold <= 0 && m.grenadeCD <= 0 && p.grenades > 0
    && bestD >= 5 && bestD <= 11) {
    m.throwHold = sim.rng.range(0.3, 0.7);
    m.throwX = best.x; m.throwY = best.y; m.throwDist = bestD;
    m.grenadeCD = sim.rng.range(5.5, 7.5);
  }

  // ABILITY: per-class situational casts
  if (p.abilityCD <= 0 && p.abilityT <= 0 && !p.grappleActive) {
    switch (p.classId) {
      case 'juggernaut':
        if (best && bestD >= 4 && bestD <= 9) m.abilityHold = sim.dt;
        break;
      case 'trapper':
        if (best && bestD >= 4 && bestD <= 9) m.abilityHold = sim.dt;
        break;
      case 'phantom': {
        let nd = Infinity;
        for (const q of sim.players.values()) {
          if (q.alive && q.id !== p.id && isEnemy(p, q)) nd = Math.min(nd, dist(p.x, p.y, q.x, q.y));
        }
        if (p.hp < 40 && nd < 5) m.abilityHold = sim.dt;
        break;
      }
      case 'bastion': {
        let near = 0;
        for (const q of sim.players.values()) {
          if (q.alive && q.id !== p.id && isEnemy(p, q) && dist(p.x, p.y, q.x, q.y) < 8) near++;
        }
        if (near >= 2) m.abilityHold = sim.dt;
        break;
      }
      case 'spider': {
        // Occasional swing: only if a wall sits roughly along our travel dir
        if (sim.rng.next() < 0.06) {
          const [mx, my] = norm(m.lastMoveX, m.lastMoveY);
          if ((mx !== 0 || my !== 0)
            && sim.raycastWalls(p.x, p.y, p.x + mx * ABILITY.GRAPPLE_RANGE, p.y + my * ABILITY.GRAPPLE_RANGE) >= 0) {
            m.abilityHold = sim.rng.range(0.4, 0.9);
          }
        }
        break;
      }
    }
  }

  // WANDER: re-roll the idle destination every few seconds or on arrival
  if (m.wanderT <= 0 || dist(p.x, p.y, m.wanderX, m.wanderY) < 2) {
    m.wanderT = sim.rng.range(2.5, 5);
    const bx = m.huntT > 0 ? m.lastSeenX : 0;
    const by = m.huntT > 0 ? m.lastSeenY : 0;
    m.wanderX = clamp(bx + sim.rng.spread(sim.map.size.w * 0.25), -sim.map.size.w / 2 + 3, sim.map.size.w / 2 - 3);
    m.wanderY = clamp(by + sim.rng.spread(sim.map.size.h * 0.25), -sim.map.size.h / 2 + 3, sim.map.size.h / 2 - 3);
  }
}

/** Per-tick: assemble movement, smooth aim, set buttons. */
function act(sim: GameSim, p: PlayerState, m: BotMind, dt: number): void {
  const inp = p.input;
  const gun = GUNS[p.gun];
  const t = m.targetId >= 0 ? sim.players.get(m.targetId) : undefined;
  let visible = false;
  let td = 0;
  if (t && t.alive) {
    td = dist(p.x, p.y, t.x, t.y);
    visible = sim.hasLOS(p.x, p.y, t.x, t.y);
    if (visible) { m.lastSeenX = t.x; m.lastSeenY = t.y; m.huntT = HUNT_MEMORY; }
  }

  // COMBAT MOVE / LOOT / HUNT / WANDER (priority order)
  let mx = 0;
  let my = 0;
  if (m.unstuckT > 0) {
    mx = m.unstuckX; my = m.unstuckY;
  } else if (m.healthGoal && (p.hp < 35 || !visible)) {
    [mx, my] = norm(m.healthX - p.x, m.healthY - p.y);
  } else if (visible && t) {
    // Hold preferred range, orbit perpendicular
    const radial = clamp((td - PREFERRED_RANGE[p.gun]) / 3, -1, 1);
    const [dx, dy] = norm(t.x - p.x, t.y - p.y);
    mx = dx * radial + -dy * m.strafeDir * 0.8;
    my = dy * radial + dx * m.strafeDir * 0.8;
    [mx, my] = norm(mx, my);
  } else if (m.huntT > 0) {
    [mx, my] = norm(m.lastSeenX - p.x, m.lastSeenY - p.y);
  } else {
    [mx, my] = norm(m.wanderX - p.x, m.wanderY - p.y);
  }

  // WALL AVOIDANCE: two short feelers at ±30° of move dir
  [mx, my] = avoidWalls(sim, p, m, mx, my);
  m.lastMoveX = mx; m.lastMoveY = my;

  // STUCK: trying to move but going nowhere → random walk for a moment
  if (Math.hypot(mx, my) > 0.3 && Math.hypot(p.vx, p.vy) < 0.2) m.stuckT += dt;
  else m.stuckT = 0;
  if (m.stuckT > 0.7) {
    m.stuckT = 0;
    m.unstuckT = 0.5;
    const a = sim.rng.range(0, TAU);
    m.unstuckX = Math.cos(a); m.unstuckY = Math.sin(a);
  }

  // AIM: lead the target, smooth toward desired, noisy on purpose
  let desired = inp.aim;
  let aimD = 8;
  if (m.throwHold > 0) {
    desired = angleTo(p.x, p.y, m.throwX, m.throwY);
    aimD = m.throwDist;
  } else if (visible && t) {
    // Flag-ON, the Lance is a 110u/s rail, so bots lead it; flag-OFF it stays
    // hitscan (projectileSpeed:0 → no lead), keeping the OFF path byte-identical.
    const speed = (FLAGS.PROJECTILE_LANCE && gun.id === 'lance') ? LANCE_SPEED : gun.projectileSpeed;
    const lead = speed > 0 ? (td / speed) * 0.6 : 0;
    desired = angleTo(p.x, p.y, t.x + t.vx * lead, t.y + t.vy * lead) + m.aimNoise;
    aimD = td;
  } else if (Math.hypot(mx, my) > 0.1) {
    desired = Math.atan2(my, mx);
  }
  inp.aim += angleDiff(inp.aim, desired) * (1 - Math.exp(-AIM_LAMBDA * dt));
  inp.aimDist = aimD;

  // BUTTONS
  let buttons = 0;
  if (m.throwHold > 0) {
    buttons |= BTN.THROW; // releasing the bit fires the throw (edge in grenades)
    m.throwHold -= dt;
  } else if (visible && t && td <= gun.range
    && Math.abs(angleDiff(inp.aim, angleTo(p.x, p.y, t.x, t.y))) < FIRE_CONE) {
    buttons |= BTN.FIRE;
  }
  if (m.abilityHold > 0) { buttons |= BTN.ABILITY; m.abilityHold -= dt; }
  if (m.pickupTap) { buttons |= BTN.PICKUP; m.pickupTap = false; }

  inp.mx = mx;
  inp.my = my;
  inp.buttons = buttons;
  inp.seq = 0;
}

/** Steer around walls: rotate away from whichever feeler hits. */
function avoidWalls(sim: GameSim, p: PlayerState, m: BotMind, mx: number, my: number): [number, number] {
  const [nx, ny] = norm(mx, my);
  if (nx === 0 && ny === 0) return [0, 0];
  const ang = Math.atan2(ny, nx);
  const blocked = (a: number) =>
    sim.raycastWalls(p.x, p.y, p.x + Math.cos(a) * FEELER_LEN, p.y + Math.sin(a) * FEELER_LEN) >= 0;
  const hitL = blocked(ang + FEELER_ANGLE);
  const hitR = blocked(ang - FEELER_ANGLE);
  if (!hitL && !hitR) return [nx, ny];
  const turn = hitL && hitR ? (Math.PI / 2) * m.strafeDir : hitL ? -0.7 : 0.7;
  return [Math.cos(ang + turn), Math.sin(ang + turn)];
}
