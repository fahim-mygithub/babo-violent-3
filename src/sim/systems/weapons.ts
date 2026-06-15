import { segCircle } from '../../core/math';
import { C, FLAGS } from '../../data/constants';
import { GUNS, type GunConfig } from '../../data/weapons';
import { BTN, type PlayerState, type ProjectileKind } from '../types';
import type { GameSim } from '../sim';

/** Distance from babo center to the muzzle along aim. */
const MUZZLE_OFFSET = 0.65;
/**
 * Lance rail muzzle speed (units/s) when routed through fireProjectiles
 * (FLAGS.PROJECTILE_LANCE). At 60 Hz a rail advances ~1.83 u/tick, so a
 * point-blank victim (≤1.83 u) is still hit the same tick it fires. Kept here
 * (not in the static gun data) so the flag-OFF path — including bot lead at
 * bots.ts — sees the legacy projectileSpeed:0 and stays byte-identical.
 */
export const LANCE_SPEED = 110;
/** Accumulated spread fully decays in this many seconds (rate = spreadMax / this). */
const SPREAD_DECAY_TIME = 0.8;
/** Released lance charge bleeds off this many times faster than it builds. */
const CHARGE_DECAY_MULT = 3;

/** Count a timer down, absorbing float drift so exact-multiple periods hit 0. */
function tickTimer(t: number, dt: number): number {
  t -= dt;
  return t < 1e-9 ? 0 : t;
}

/**
 * Fire control + sustain for all 8 guns (data/weapons.ts).
 * - BTN.FIRE held → fire at fireRate, spawning projectiles (sim.projectiles)
 *   with per-gun spread (base + spreadAcc, decaying).
 * - Recoil: impulse opposite aim of gun.recoil magnitude (sim.applyImpulse —
 *   rapier divides by mass; fortify negates).
 * - Reload guns: mag decrements; auto-reload when a shot empties the mag (or
 *   FIRE pressed on empty). reloadT counts down; emit reloadStart/reloadDone.
 * - Heat guns: heat += heatPerShot; at >=1 overheat (overheatT = lockout, emit).
 *   Cool at coolRate when not firing (lockout always cools).
 * - Hurricane: spin-up before firing (p.spin 0..1), emits 'spinup'.
 * - Lance: hold to charge (p.charge), fires hitscan ray on full charge,
 *   emits 'rail' event with endpoints; damages first babo on the line.
 * - Pyre: short-range 'flame' projectiles in a cone.
 * Emit 'shot' events for audio/VFX.
 */
export function weaponSystem(sim: GameSim, dt: number): void {
  for (const p of sim.players.values()) {
    // Cooldown-style timers tick even while dead (so lockouts don't freeze).
    p.fireCD = tickTimer(p.fireCD, dt);
    p.overheatT = tickTimer(p.overheatT, dt);

    if (!p.alive) {
      p.spin = 0;
      p.charge = 0;
      continue;
    }

    const gun = GUNS[p.gun];
    const fireHeld = (p.input.buttons & BTN.FIRE) !== 0;
    const firePressed = fireHeld && !(p.prevButtons & BTN.FIRE);

    // Reload progress
    if (p.reloadT > 0) {
      p.reloadT = tickTimer(p.reloadT, dt);
      if (p.reloadT === 0) {
        p.mag = gun.magSize ?? 0;
        sim.emit({ t: 'reloadDone', player: p.id });
      }
    }

    // Hurricane spin-up
    if (gun.spinUp) {
      if (fireHeld) {
        if (p.spin < 1) {
          p.spin = Math.min(1, p.spin + dt / gun.spinUp);
          if (p.spin >= 1) sim.emit({ t: 'spinup', player: p.id, on: true });
        }
      } else if (p.spin > 0) {
        if (p.spin >= 1) sim.emit({ t: 'spinup', player: p.id, on: false });
        p.spin = Math.max(0, p.spin - dt / (gun.spinUp * 1.5));
      }
    }

    const canFire =
      p.fireCD === 0 && p.overheatT === 0 && p.reloadT === 0 &&
      (!gun.spinUp || p.spin >= 1);

    let discharged = false;

    if (gun.chargeTime) {
      // Lance: charge builds only while the trigger is held and firing is legal.
      if (fireHeld && canFire) {
        p.charge = Math.min(1, p.charge + dt / gun.chargeTime);
        if (p.charge >= 1) {
          sim.emit({ t: 'chargeReady', player: p.id });
          // Flag-ON routes the Lance through fireProjectiles (a rail slug + its
          // unconditional sim.rng.spread(0) draw → a DISTINCT RNG stream). Flag-OFF
          // keeps the exact legacy hitscan. discharge() runs in BOTH paths, so
          // heat/recoil/lockout/fireCD are byte-identical either way.
          if (FLAGS.PROJECTILE_LANCE) fireProjectiles(sim, p, gun);
          else fireLance(sim, p, gun);
          p.charge = 0;
          discharged = true;
        }
      } else if (!fireHeld && p.charge > 0) {
        p.charge = Math.max(0, p.charge - (CHARGE_DECAY_MULT * dt) / gun.chargeTime);
      }
    } else if (fireHeld && canFire && (gun.sustain !== 'reload' || p.mag > 0)) {
      fireProjectiles(sim, p, gun);
      discharged = true;
    }

    // Auto-reload: the shot that empties the mag, or FIRE pressed on empty.
    if (
      gun.sustain === 'reload' && gun.reloadTime !== undefined &&
      p.mag <= 0 && p.reloadT === 0 && (discharged || firePressed)
    ) {
      p.reloadT = gun.reloadTime;
      sim.emit({ t: 'reloadStart', player: p.id, gun: p.gun });
    }

    // Manual reload (edge-triggered). Inert for heat guns, full mags, mid-reload,
    // and the same tick a shot already discharged (avoids double-trigger).
    const reloadPressed = (p.input.buttons & BTN.RELOAD) && !(p.prevButtons & BTN.RELOAD);
    if (
      gun.sustain === 'reload' && reloadPressed &&
      p.reloadT === 0 && p.mag < (gun.magSize ?? 0) && !discharged
    ) {
      p.reloadT = gun.reloadTime!;
      sim.emit({ t: 'reloadStart', player: p.id, gun: p.gun });
    }

    // Heat dissipates while not firing; an overheat lockout always cools.
    if (gun.sustain === 'heat' && !discharged && (!fireHeld || p.overheatT > 0)) {
      p.heat = Math.max(0, p.heat - (gun.coolRate ?? 0) * dt);
    }

    // Bloom decay between discharges
    if (!discharged && p.spreadAcc > 0) {
      p.spreadAcc = Math.max(0, p.spreadAcc - (gun.spreadMax / SPREAD_DECAY_TIME) * dt);
    }
  }
}

/** Shared per-discharge bookkeeping: ammo/heat, cooldown, bloom, recoil. */
function discharge(sim: GameSim, p: PlayerState, gun: GunConfig): void {
  // Attacking forfeits spawn protection (you can't deal damage while protected)
  if (p.spawnProt) {
    p.spawnProt = false;
    p.invulnT = 0;
  }
  if (gun.sustain === 'reload') {
    p.mag = Math.max(0, p.mag - 1);
  } else {
    p.heat += gun.heatPerShot ?? 0;
    if (p.heat >= 1) {
      p.heat = 1;
      p.overheatT = gun.overheatLockout ?? 0;
      sim.emit({ t: 'overheat', player: p.id });
    }
  }
  // Charge guns are paced by their charge time, not the fire-rate lockout
  p.fireCD = gun.chargeTime ? 0.1 : 1 / gun.fireRate;
  p.spreadAcc = Math.min(p.spreadAcc + gun.spreadGrowth, Math.max(0, gun.spreadMax - gun.spread));
  sim.applyImpulse(p, -Math.cos(p.aim) * gun.recoil, -Math.sin(p.aim) * gun.recoil);
}

/** Spawn this gun's pellets from the muzzle, then apply discharge effects. */
function fireProjectiles(sim: GameSim, p: PlayerState, gun: GunConfig): void {
  const aim = p.aim;
  const mx = p.x + Math.cos(aim) * MUZZLE_OFFSET;
  const my = p.y + Math.sin(aim) * MUZZLE_OFFSET;
  const kind: ProjectileKind =
    gun.id === 'thumper' ? 'rocket'
    : gun.id === 'pyre' ? 'flame'
    : gun.id === 'lance' ? 'rail'
    : 'bullet';
  // The Lance carries no static projectileSpeed (legacy hitscan); use LANCE_SPEED.
  const speed = gun.id === 'lance' ? LANCE_SPEED : gun.projectileSpeed;
  for (let i = 0; i < gun.pellets; i++) {
    const ang = aim + sim.rng.spread(gun.spread + p.spreadAcc);
    sim.projectiles.push({
      id: sim.newId(), kind, gun: gun.id, owner: p.id, team: p.team,
      x: mx, y: my, ox: mx, oy: my,
      vx: Math.cos(ang) * speed,
      vy: Math.sin(ang) * speed,
      damage: gun.damage, dist: 0, maxDist: gun.range,
    });
  }
  discharge(sim, p, gun);
  sim.emit({ t: 'shot', player: p.id, gun: gun.id, x: mx, y: my, aim });
}

/** Lance rail: instant ray, stopped by the first wall or hostile babo. */
function fireLance(sim: GameSim, p: PlayerState, gun: GunConfig): void {
  const aim = p.aim;
  const dx = Math.cos(aim);
  const dy = Math.sin(aim);
  const x0 = p.x + dx * MUZZLE_OFFSET;
  const y0 = p.y + dy * MUZZLE_OFFSET;
  const ex = x0 + dx * gun.range;
  const ey = y0 + dy * gun.range;

  let bestT = 1;
  const wallT = sim.raycastWalls(x0, y0, ex, ey);
  if (wallT >= 0) bestT = wallT;

  let victim: PlayerState | undefined;
  for (const q of sim.players.values()) {
    if (!q.alive || q.id === p.id || q.phaseActive) continue;
    if (p.team !== -1 && q.team === p.team) continue;
    const t = segCircle(x0, y0, ex, ey, q.x, q.y, C.BABO_RADIUS);
    if (t >= 0 && t < bestT) { bestT = t; victim = q; }
  }

  // Discharge first: it clears spawn protection, which would otherwise block
  // this very ray's damage (hitscan resolves within the same call).
  discharge(sim, p, gun);
  if (victim) {
    sim.damage(victim, p.id, gun.damage, gun.id);
    sim.applyImpulse(victim, dx * C.LANCE_KNOCK, dy * C.LANCE_KNOCK);
  }
  sim.emit({ t: 'rail', x0, y0, x1: x0 + (ex - x0) * bestT, y1: y0 + (ey - y0) * bestT, owner: p.id });
  sim.emit({ t: 'shot', player: p.id, gun: gun.id, x: x0, y: y0, aim });
}
