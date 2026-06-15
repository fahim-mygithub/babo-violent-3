import { angleDiff } from '../core/math';
import { viewportSize } from '../core/viewport';
import { C } from '../data/constants';
import type { PlayerInput, PlayerState } from '../sim/types';
import { BTN } from '../sim/types';
import type { InputSource } from '../input';

const STICK_R = 56;
const AIM_STICK_R = 56;
const AIM_DEADZONE = 0.25;
const MOVE_DEADZONE = 0.12;
const AIM_MIN_DIST = 3;
const AIM_MAX_DIST = 16;
/** Pixels of drag for a full-range grenade throw (mirrors desktop RMB hold-time). */
const ARC_DRAG_PX = 140;

/**
 * Aim-assist (S1.6). Soft angular magnetism only — STRENGTH is capped at 0.30 so
 * the producer can never snap onto a target, only nudge toward it. Lead is
 * intentionally NOT applied (rotate-to-target only); the Lance is additionally
 * lead-exempt by contract (S2.5) so it stays correct by construction if lead
 * ever lands.
 */
const ASSIST = { CONE: 0.30, STRENGTH: 0.30, RANGE: 22 } as const;

/**
 * Touch input producer (mobile). Implements the same {@link InputSource} surface
 * as the desktop {@link InputManager} so the game loop can swap producers without
 * any sim change. A constructed-but-idle TouchControls emits a neutral input.
 *
 * Left half (bottom) is a floating-origin movement stick → mx/my.
 */
export class TouchControls implements InputSource {
  enabled = true;
  showScores = false;

  // Read-state for renderer/HUD
  aimActive = false;
  aimAngle = 0;
  aimMag = 0;
  firing = false;
  grenadeArc = { active: false, aim: 0, dist: 0 };

  private layer: HTMLDivElement;
  private seq = 1;
  private moveX = 0;
  private moveY = 0;

  /** Latest world view for aim-assist. Null until setWorld is called. */
  private view: { players: PlayerState[] } | null = null;

  private leftId = -1;
  private leftOX = 0;
  private leftOY = 0;

  private rightId = -1;
  private rightOX = 0;
  private rightOY = 0;

  private grenOX = 0;
  private grenOY = 0;

  constructor(private container: HTMLElement, private localId: number) {
    this.layer = document.createElement('div');
    this.layer.id = 'touch-layer';
    this.layer.style.touchAction = 'none';
    this.container.appendChild(this.layer);
    this.layer.addEventListener('pointerdown', this.onDown);
    this.layer.addEventListener('pointermove', this.onMove);
    this.layer.addEventListener('pointerup', this.onUp);
    this.layer.addEventListener('pointercancel', this.onUp);
  }

  private onDown = (e: PointerEvent): void => {
    e.preventDefault();
    const { w, h } = viewportSize();
    const inLeft = e.clientX < w * 0.45 && e.clientY > h * 0.5;
    const inRight = e.clientX > w * 0.45 && e.clientY > h * 0.6;
    if (this.leftId === -1 && inLeft) {
      this.leftId = e.pointerId;
      this.leftOX = e.clientX;
      this.leftOY = e.clientY;
      this.layer.setPointerCapture?.(e.pointerId);
    } else if (this.rightId === -1 && inRight) {
      this.rightId = e.pointerId;
      this.rightOX = e.clientX;
      this.rightOY = e.clientY;
      this.aimActive = true;
      this.layer.setPointerCapture?.(e.pointerId);
    }
  };

  private onMove = (e: PointerEvent): void => {
    if (e.pointerId === this.leftId) {
      const dx = e.clientX - this.leftOX;
      const dy = e.clientY - this.leftOY;
      const mag = Math.hypot(dx, dy);
      const m = Math.min(1, mag / STICK_R);
      if (m < MOVE_DEADZONE || mag < 1e-6) {
        this.moveX = 0;
        this.moveY = 0;
      } else {
        this.moveX = (dx / mag) * m;
        this.moveY = (dy / mag) * m;
      }
    } else if (e.pointerId === this.rightId) {
      const dx = e.clientX - this.rightOX;
      const dy = e.clientY - this.rightOY;
      const mag = Math.hypot(dx, dy);
      this.aimMag = Math.min(1, mag / AIM_STICK_R);
      if (mag > 1e-6) this.aimAngle = Math.atan2(dy, dx);
      // Autofire while deflected past the dead-zone. Gating by reload/heat/ammo
      // is delegated to the sim weaponSystem; the touch layer only OR-s FIRE.
      this.firing = this.aimMag > AIM_DEADZONE;
    }
  };

  private onUp = (e: PointerEvent): void => {
    if (e.pointerId === this.leftId) {
      this.leftId = -1;
      this.moveX = 0;
      this.moveY = 0;
    } else if (e.pointerId === this.rightId) {
      this.rightId = -1;
      this.aimActive = false;
      this.firing = false;
      this.aimMag = 0;
    }
  };

  /** Feed the current world view + local player id for aim-assist. */
  setWorld(view: { players: Iterable<PlayerState> } | null, localId: number): void {
    this.view = view ? { players: [...view.players] } : null;
    this.localId = localId;
  }

  /**
   * Soft angular magnetism toward the nearest hostile inside the assist cone +
   * range. Never snaps (STRENGTH ≤ 0.30) and never leads (rotate-to-target
   * only). Pure: no allocation, tolerant of an unset/empty world.
   */
  private assist(rawAim: number): number {
    const v = this.view;
    if (!v) return rawAim;
    let me: PlayerState | undefined;
    for (const p of v.players) if (p.id === this.localId) { me = p; break; }
    if (!me) return rawAim;
    const px = me.x;
    const py = me.y;
    let bestErr: number = ASSIST.CONE;
    let bestAng = 0;
    let found = false;
    for (const e of v.players) {
      if (!e.alive || e.id === this.localId) continue;
      if (me.team !== -1 && e.team === me.team) continue; // never assist onto teammates
      const dx = e.x - px;
      const dy = e.y - py;
      if (Math.hypot(dx, dy) > ASSIST.RANGE) continue;
      const ang = Math.atan2(dy, dx);
      const err = Math.abs(angleDiff(rawAim, ang));
      if (err < bestErr) { bestErr = err; bestAng = ang; found = true; }
    }
    if (!found) return rawAim;
    // Lance lead-skip contract (S2.5): lead is NOT applied here. Lead is a no-op
    // in P2 (rotate-to-target only); when it lands the Lance stays lead-exempt
    // because its hitscan needs no lead. Kept explicit so it's correct by
    // construction.
    return rawAim + angleDiff(rawAim, bestAng) * ASSIST.STRENGTH * (1 - bestErr / ASSIST.CONE);
  }

  /** EQUIPMENT hold begins the grenade arc, suspending the aim stick. */
  beginGrenade(x: number, y: number): void {
    this.grenadeArc.active = true;
    this.grenadeArc.aim = 0;
    this.grenadeArc.dist = C.GRENADE_MIN_RANGE;
    this.grenOX = x;
    this.grenOY = y;
  }

  /** Drag distance scales throw range; direction sets the arc aim (mirrors RMB). */
  moveGrenade(x: number, y: number): void {
    if (!this.grenadeArc.active) return;
    const dx = x - this.grenOX;
    const dy = y - this.grenOY;
    this.grenadeArc.aim = Math.atan2(dy, dx);
    const m = Math.min(1, Math.hypot(dx, dy) / ARC_DRAG_PX);
    this.grenadeArc.dist = C.GRENADE_MIN_RANGE + (C.GRENADE_MAX_RANGE - C.GRENADE_MIN_RANGE) * m;
  }

  /** Release: drop BTN.THROW so the sim's falling-edge releaseThrow fires. */
  endGrenade(): void {
    this.grenadeArc.active = false;
  }

  sample(_ground: { x: number; y: number }, _px: number, _py: number): PlayerInput {
    let buttons = 0;
    if (this.firing) buttons |= BTN.FIRE;
    // Aim-assist is on by default; explicit `false` (a settings toggle, S1.6)
    // disables it. Read defensively so headless tests keep assist on.
    const assistOn = (window as { __bv3?: { touchAssist?: boolean } }).__bv3?.touchAssist !== false;
    let aim = assistOn ? this.assist(this.aimAngle) : this.aimAngle;
    let aimDist = this.aimActive
      ? AIM_MIN_DIST + (AIM_MAX_DIST - AIM_MIN_DIST) * this.aimMag
      : AIM_MIN_DIST;
    // The grenade arc takes priority over the gun aim while held: OR THROW and
    // override aim/dist from the drag (no aim-assist on the arc).
    if (this.grenadeArc.active) {
      buttons |= BTN.THROW;
      aim = this.grenadeArc.aim;
      aimDist = this.grenadeArc.dist;
    }
    return {
      mx: this.moveX, my: this.moveY,
      aim, aimDist,
      buttons, seq: this.seq++,
    };
  }

  dispose(): void {
    this.layer.removeEventListener('pointerdown', this.onDown);
    this.layer.removeEventListener('pointermove', this.onMove);
    this.layer.removeEventListener('pointerup', this.onUp);
    this.layer.removeEventListener('pointercancel', this.onUp);
    this.layer.remove();
  }
}
