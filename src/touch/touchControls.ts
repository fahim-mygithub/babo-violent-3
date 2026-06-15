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

// ---- Visual-only constants (NEVER feed the emitted PlayerInput) ----
/** Active-ring radius (px). The drawn ring is 2x this. */
const RING_R = 60;
/** Max px the knob disc travels from the active-ring center at full deflection. */
const KNOB_TRAVEL = 30;
/** Bottom home-indicator swipe strip (px) reserved from stick activation. */
const HOME_STRIP = 34;
/** Max px the grenade drag-knob travels in the screen affordance (visual only). */
const GREN_VIS_R = 84;

/**
 * On-screen control glyphs as inline SVG (S2). SVG only — crisp at any DPI,
 * stroke/halo controllable, consistent across mobile OSes (no emoji, no icon
 * font). `currentColor` lets each control's accent token drive the tint.
 */
const ICON = {
  move:
    '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M16 4 L16 28 M5 16 L27 16 M16 4 L12.5 8 M16 4 L19.5 8 M16 28 L12.5 24 M16 28 L19.5 24 M5 16 L9 12.5 M5 16 L9 19.5 M27 16 L23 12.5 M27 16 L23 19.5"/>' +
    '<circle cx="16" cy="16" r="2.2" fill="currentColor" stroke="none"/></svg>',
  crosshair:
    '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" aria-hidden="true">' +
    '<circle cx="16" cy="16" r="8.5"/>' +
    '<path d="M16 2.5 L16 8 M16 24 L16 29.5 M2.5 16 L8 16 M24 16 L29.5 16"/>' +
    '<circle cx="16" cy="16" r="1.7" fill="currentColor" stroke="none"/></svg>',
  muzzle:
    '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" aria-hidden="true">' +
    '<path d="M16 16 L16 3 M16 16 L26 6 M16 16 L29 16 M16 16 L26 26 M16 16 L16 29 M16 16 L6 26 M16 16 L3 16 M16 16 L6 6"/>' +
    '<circle cx="16" cy="16" r="2.6" fill="currentColor" stroke="none"/></svg>',
  skill:
    '<svg viewBox="0 0 32 32" aria-hidden="true">' +
    '<path d="M16 2 L18.6 12.4 L29 15 L18.6 17.6 L16 28 L13.4 17.6 L3 15 L13.4 12.4 Z" fill="currentColor"/></svg>',
  reload:
    '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M25.5 16 A9.5 9.5 0 1 1 22 8.4"/>' +
    '<path d="M22.5 3 L22.5 9 L16.5 9"/></svg>',
  nade:
    '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="15" cy="19.5" r="7.7"/>' +
    '<path d="M15 11.8 L15 7.5 L20 4.5 M12.4 9 L10.2 6.8 M18 8.6 L20.6 6"/></svg>',
  pickup:
    '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M16 4 L16 18 M9.5 12.5 L16 19 L22.5 12.5 M6 25 L26 25"/></svg>',
  score:
    '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">' +
    '<path d="M8 9 L24 9 M8 16 L24 16 M8 23 L19 23"/></svg>',
  leave:
    '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M13 6 L6 6 L6 26 L13 26 M12 16 L26 16 M20.5 10.5 L26 16 L20.5 21.5"/></svg>',
} as const;

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
/**
 * Touch-effective detection (S1.12). An explicit `bv3-touch` localStorage value
 * (`on`/`off`) wins; otherwise auto-detect a coarse, hover-less pointer (phone /
 * tablet). On desktop (no coarse pointer) this is false, so the App keeps the
 * kbm source and never builds the touch layer.
 */
export function shouldUseTouch(): boolean {
  const pref = localStorage.getItem('bv3-touch') ?? 'auto';
  if (pref === 'on') return true;
  if (pref === 'off') return false;
  const coarse = typeof matchMedia === 'function'
    && matchMedia('(pointer: coarse)').matches && matchMedia('(hover: none)').matches;
  return !!coarse;
}

export class TouchControls implements InputSource {
  enabled = true;
  showScores = false;

  /** App callback for the LEAVE button (returns to the menu). */
  onLeave?: () => void;

  // Read-state for renderer/HUD
  aimActive = false;
  aimAngle = 0;
  aimMag = 0;
  firing = false;
  grenadeArc = { active: false, aim: 0, dist: 0 };
  /** One-shot: the release tick still emits the final arc aim/dist (THROW already
   *  dropped) so the sim's falling-edge throw reads the full charged range. */
  private grenadeReleasing = false;

  private layer: HTMLDivElement;
  private seq = 1;
  private moveX = 0;
  private moveY = 0;

  /** Latest world view for aim-assist. Null until setWorld is called. assist()
   *  only iterates players, so we hold the iterable reference (no per-tick copy). */
  private view: { players: Iterable<PlayerState> } | null = null;

  private leftId = -1;
  private leftOX = 0;
  private leftOY = 0;

  private rightId = -1;
  private rightOX = 0;
  private rightOY = 0;

  private grenOX = 0;
  private grenOY = 0;

  // Consume-on-first-sample latches: a tap sets the bit; sample() emits it once
  // then clears it, so each tap fires at most one bit regardless of ticks/frame.
  private reloadLatch = false;
  private pickupLatch = false;

  /** SKILL button hold → BTN.ABILITY (supports hold-to-channel abilities). */
  private abilityHeld = false;
  /** Captured pointer id for the SKILL hold (-1 when not held). */
  private skillPointerId = -1;

  /** Edge buttons (SKILL/RELOAD/EQUIP/PICKUP/scoreboard/leave). Disposed with the layer. */
  private buttons: HTMLButtonElement[] = [];
  private grenBtnId = -1;

  // ---- Visible stick GUI (S1/S2). All visual; never feeds PlayerInput. ----
  // Per side: root (carries the .firing state), the floating active ring+knob,
  // and the knob disc. The fixed "home" ghost ring is positioned via CSS.
  private stickL!: HTMLDivElement;
  private stickR!: HTMLDivElement;
  private activeL!: HTMLDivElement;
  private activeR!: HTMLDivElement;
  private knobL!: HTMLDivElement;
  private knobR!: HTMLDivElement;
  // Screen-space grenade drag affordance (the "drag-arc stick" shown on EQUIP-hold).
  private grenEl!: HTMLDivElement;
  private grenKnob!: HTMLDivElement;

  constructor(private container: HTMLElement, private localId: number) {
    this.layer = document.createElement('div');
    this.layer.id = 'touch-layer';
    this.layer.style.touchAction = 'none';
    this.container.appendChild(this.layer);
    this.layer.addEventListener('pointerdown', this.onDown);
    this.layer.addEventListener('pointermove', this.onMove);
    this.layer.addEventListener('pointerup', this.onUp);
    this.layer.addEventListener('pointercancel', this.resetNeutral);
    window.addEventListener('blur', this.resetNeutral);
    // Global fallback: if the SKILL hold's pointer is released anywhere off the
    // button (slide-off, lost capture), drop BTN.ABILITY so it can't stick on.
    window.addEventListener('pointerup', this.onGlobalPointerUp);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.buildSticks();
    this.buildButtons();
  }

  /**
   * Build the visible twin-stick GUI (S1/S2): a fixed faint "home" ghost ring +
   * center glyph per side (so the thumb always has a target and each stick
   * self-documents), plus a floating active ring + knob that bloom at the touch
   * point. Purely cosmetic — driven from already-computed input values, it never
   * changes the emitted PlayerInput. Appended BEFORE the buttons so the action
   * chips paint above the sticks.
   */
  private buildSticks(): void {
    const div = (cls: string): HTMLDivElement => {
      const d = document.createElement('div');
      d.className = cls;
      return d;
    };
    const make = (side: 'left' | 'right', glyph: string): { root: HTMLDivElement; active: HTMLDivElement; knob: HTMLDivElement } => {
      const root = div(`tc-stick ${side}`);
      const home = div(`tc-stick-home ${side}`);
      home.innerHTML = glyph;
      const active = div(`tc-stick-active ${side}`);
      const ring = div('tc-stick-ring');
      const knob = div('tc-stick-knob');
      active.append(ring, knob);
      root.append(home, active);
      this.layer.appendChild(root);
      return { root, active, knob };
    };
    const l = make('left', `<span class="tc-stick-glyph">${ICON.move}</span>`);
    this.stickL = l.root; this.activeL = l.active; this.knobL = l.knob;
    // Right home carries BOTH glyphs; the .firing state swaps crosshair → muzzle.
    const r = make('right',
      `<span class="tc-stick-glyph gx-aim">${ICON.crosshair}</span>` +
      `<span class="tc-stick-glyph gx-fire">${ICON.muzzle}</span>`);
    this.stickR = r.root; this.activeR = r.active; this.knobR = r.knob;

    // Screen-space grenade drag affordance (the "drag-arc stick").
    this.grenEl = div('tc-gren');
    const grenRing = div('tc-gren-ring');
    this.grenKnob = div('tc-gren-knob');
    this.grenEl.append(grenRing, this.grenKnob);
    this.layer.appendChild(this.grenEl);
  }

  /** Position + reveal a floating active ring at a clamped on-screen point. */
  private showActive(side: 'L' | 'R', x: number, y: number, w: number, h: number): void {
    const vx = Math.max(RING_R, Math.min(w - RING_R, x));
    const vy = Math.max(RING_R, Math.min(h - 100, y)); // keep clear of the bottom strip
    const active = side === 'L' ? this.activeL : this.activeR;
    const knob = side === 'L' ? this.knobL : this.knobR;
    active.style.transform = `translate(${vx}px, ${vy}px)`;
    knob.style.transform = 'translate(0px, 0px)';
    active.classList.add('active');
  }

  /** Fade the floating active ring and recenter its knob (visual reset). */
  private hideActive(side: 'L' | 'R'): void {
    const active = side === 'L' ? this.activeL : this.activeR;
    const knob = side === 'L' ? this.knobL : this.knobR;
    if (!active) return; // guard: reset may run before buildSticks in edge cases
    active.classList.remove('active');
    knob.style.transform = 'translate(0px, 0px)';
  }

  /** Offset a knob disc along the raw deflection (visual; tracks the thumb even
   *  inside the dead-zone so the stick feels alive). */
  private setKnob(knob: HTMLDivElement, dx: number, dy: number, mag: number): void {
    if (mag < 1e-6) { knob.style.transform = 'translate(0px, 0px)'; return; }
    const off = (Math.min(mag, STICK_R) / STICK_R) * KNOB_TRAVEL;
    knob.style.transform = `translate(${(dx / mag) * off}px, ${(dy / mag) * off}px)`;
  }

  /** True if (x,y) lands on a visible action chip's (padded) hit rect — used to
   *  carve the chips out of the right aim-stick activation zone so a thumb-down
   *  on a button never starts a phantom aim stick. Inert in jsdom (zero rects). */
  private pointInChip(x: number, y: number): boolean {
    const PAD = 8;
    for (const b of this.buttons) {
      if (b.style.display === 'none') continue;
      const r = b.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (x >= r.left - PAD && x <= r.right + PAD && y >= r.top - PAD && y <= r.bottom + PAD) return true;
    }
    return false;
  }

  /** Clear the SKILL hold (button release, lost capture, or global fallback). */
  private releaseSkill(): void {
    this.abilityHeld = false;
    this.skillPointerId = -1;
  }

  /** Window-level safety net: a pointerup delivered off the layer (lost capture,
   *  slide-off) still clears the SKILL hold AND either stick, so nothing can
   *  stick on if `setPointerCapture` ever failed. The layer's own onUp fires
   *  first when capture works, leaving these as cheap idempotent no-ops. */
  private onGlobalPointerUp = (e: PointerEvent): void => {
    if (this.skillPointerId !== -1 && e.pointerId === this.skillPointerId) this.releaseSkill();
    if (e.pointerId === this.leftId || e.pointerId === this.rightId) this.onUp(e);
  };

  /**
   * Edge buttons live inside #touch-layer but `stopPropagation` so the layer's
   * stick handlers never see them. `touch-action: manipulation` kills the
   * double-tap-zoom delay without disabling the press itself.
   */
  private buildButtons(): void {
    const make = (id: string, label: string, icon: string): HTMLButtonElement => {
      const b = document.createElement('button');
      b.id = id;
      b.className = 'tc-btn';
      // Icon + caption so each control self-documents (S2/S3). Inner spans carry
      // the SVG glyph and the label; the chip itself stays the tap target.
      b.innerHTML = `<span class="tc-ico">${icon}</span><span class="tc-lbl">${label}</span>`;
      b.style.touchAction = 'manipulation';
      this.layer.appendChild(b);
      this.buttons.push(b);
      return b;
    };

    const skill = make('tc-skill', 'SKILL', ICON.skill);
    skill.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.abilityHeld = true;
      this.skillPointerId = e.pointerId;
      // Capture so the matching pointerup lands on the button even if the thumb
      // slides off; the window-level fallback below covers the (jsdom / capture
      // loss) cases where it doesn't, so BTN.ABILITY can never stick on.
      this.capture(e.pointerId, skill);
    });
    const releaseSkill = (e: PointerEvent): void => { e.stopPropagation(); this.releaseSkill(); };
    skill.addEventListener('pointerup', releaseSkill);
    skill.addEventListener('pointercancel', releaseSkill);
    skill.addEventListener('lostpointercapture', () => this.releaseSkill());

    const reload = make('tc-reload', 'RELOAD', ICON.reload);
    reload.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.tapReload(); });

    const pickup = make('tc-pickup', 'PICKUP', ICON.pickup);
    // Visible only while a pickup prompt is live (App toggles via setPickupVisible).
    pickup.style.display = 'none';
    pickup.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.tapPickup(); });

    const equip = make('tc-equip', 'NADE', ICON.nade);
    equip.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.grenBtnId = e.pointerId;
      this.beginGrenade(e.clientX, e.clientY);
      this.capture(e.pointerId, equip);
    });
    equip.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.grenBtnId) return;
      e.stopPropagation();
      this.moveGrenade(e.clientX, e.clientY);
    });
    const endGren = (e: PointerEvent): void => {
      if (e.pointerId !== this.grenBtnId) return;
      e.stopPropagation();
      this.grenBtnId = -1;
      this.endGrenade();
    };
    equip.addEventListener('pointerup', endGren);
    equip.addEventListener('pointercancel', endGren);

    const scores = make('tc-scores', 'SCORE', ICON.score);
    scores.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.showScores = !this.showScores; });

    const leave = make('tc-leave', 'LEAVE', ICON.leave);
    leave.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.onLeave?.(); });
  }

  /** Show/hide the PICKUP button — App drives this from the live HUD pickup prompt. */
  setPickupVisible(on: boolean): void {
    const pk = this.layer.querySelector<HTMLElement>('#tc-pickup');
    if (pk) pk.style.display = on ? '' : 'none';
  }

  private onDown = (e: PointerEvent): void => {
    e.preventDefault();
    const { w, h } = viewportSize();
    // Ignore grabs that start in the bottom home-indicator swipe strip — iOS can
    // intercept those before pointerdown, and we never want a stick down there.
    if (e.clientY > h - HOME_STRIP) return;
    const inLeft = e.clientX < w * 0.45 && e.clientY > h * 0.5;
    // Carve the action-chip hit rects out of the right zone so a thumb-down on a
    // button never starts a phantom aim stick (the chips otherwise stopPropagation).
    const inRight = e.clientX > w * 0.45 && e.clientY > h * 0.6
      && !this.pointInChip(e.clientX, e.clientY);
    if (this.leftId === -1 && inLeft) {
      this.leftId = e.pointerId;
      this.leftOX = e.clientX;
      this.leftOY = e.clientY;
      this.showActive('L', e.clientX, e.clientY, w, h);
      this.capture(e.pointerId);
    } else if (this.rightId === -1 && inRight) {
      this.rightId = e.pointerId;
      this.rightOX = e.clientX;
      this.rightOY = e.clientY;
      this.aimActive = true;
      this.showActive('R', e.clientX, e.clientY, w, h);
      this.capture(e.pointerId);
    }
  };

  /** setPointerCapture, but swallow the NotFoundError it throws when no real
   *  pointer matches (synthetic events, an already-released pointer) so it can
   *  never abort a handler. Capture is best-effort — the window-level pointerup
   *  fallback already covers a missed release on both sticks and the SKILL hold. */
  private capture(id: number, el: Element = this.layer): void {
    try { el.setPointerCapture?.(id); } catch { /* no active pointer */ }
  }

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
      this.setKnob(this.knobL, dx, dy, mag); // visual only
    } else if (e.pointerId === this.rightId) {
      const dx = e.clientX - this.rightOX;
      const dy = e.clientY - this.rightOY;
      const mag = Math.hypot(dx, dy);
      this.aimMag = Math.min(1, mag / AIM_STICK_R);
      if (mag > 1e-6) this.aimAngle = Math.atan2(dy, dx);
      // Autofire while deflected past the dead-zone. Gating by reload/heat/ammo
      // is delegated to the sim weaponSystem; the touch layer only OR-s FIRE.
      this.firing = this.aimMag > AIM_DEADZONE;
      this.setKnob(this.knobR, dx, dy, mag); // visual only
      // crosshair → muzzle + red, but NOT while the grenade arc is modal (sample()
      // suppresses FIRE there, so the stick must not read as "firing").
      this.stickR.classList.toggle('firing', this.firing && !this.grenadeArc.active);
    }
  };

  private onUp = (e: PointerEvent): void => {
    if (e.pointerId === this.leftId) {
      this.leftId = -1;
      this.moveX = 0;
      this.moveY = 0;
      this.hideActive('L');
    } else if (e.pointerId === this.rightId) {
      this.rightId = -1;
      this.aimActive = false;
      this.firing = false;
      this.aimMag = 0;
      this.hideActive('R');
      this.stickR.classList.remove('firing');
    }
  };

  /** Feed the current world view + local player id for aim-assist. assist() only
   *  reads players, so store the iterable reference — no fresh array per tick. */
  setWorld(view: { players: Iterable<PlayerState> } | null, localId: number): void {
    this.view = view;
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
    this.showGren(x, y); // reveal the screen-space drag-arc affordance
  }

  /** Drag distance scales throw range; direction sets the arc aim (mirrors RMB). */
  moveGrenade(x: number, y: number): void {
    if (!this.grenadeArc.active) return;
    const dx = x - this.grenOX;
    const dy = y - this.grenOY;
    this.grenadeArc.aim = Math.atan2(dy, dx);
    const m = Math.min(1, Math.hypot(dx, dy) / ARC_DRAG_PX);
    this.grenadeArc.dist = C.GRENADE_MIN_RANGE + (C.GRENADE_MAX_RANGE - C.GRENADE_MIN_RANGE) * m;
    // Visual knob: push along the aim by the same charge fraction (cosmetic).
    const off = m * GREN_VIS_R;
    this.grenKnob.style.transform =
      `translate(${Math.cos(this.grenadeArc.aim) * off}px, ${Math.sin(this.grenadeArc.aim) * off}px)`;
  }

  /**
   * Release: drop the arc but carry its final aim/dist through ONE more sample so
   * the sim's falling-edge releaseThrow (which reads input.aimDist on the release
   * tick) sees the full charged drag range, not the reset-to-min default.
   */
  endGrenade(): void {
    this.grenadeArc.active = false;
    this.grenadeReleasing = true;
    this.hideGren();
  }

  /** Position + reveal the grenade drag affordance at a clamped on-screen point. */
  private showGren(x: number, y: number): void {
    const { w, h } = viewportSize();
    const vx = Math.max(RING_R, Math.min(w - RING_R, x));
    const vy = Math.max(RING_R, Math.min(h - 100, y));
    this.grenEl.style.transform = `translate(${vx}px, ${vy}px)`;
    this.grenKnob.style.transform = 'translate(0px, 0px)';
    this.grenEl.classList.add('active');
  }

  /** Hide the grenade drag affordance the instant the throw is released. */
  private hideGren(): void {
    if (!this.grenEl) return; // guard: reset may run before buildSticks
    this.grenEl.classList.remove('active');
    this.grenKnob.style.transform = 'translate(0px, 0px)';
  }

  /** Tap RELOAD: latched, consumed on the next sample (one emit per tap). */
  tapReload(): void { this.reloadLatch = true; }
  /** Tap PICKUP: latched, consumed on the next sample (one emit per tap). */
  tapPickup(): void { this.pickupLatch = true; }

  /** Zero every input + latch — blur/pointercancel/visibility-hidden recovery. */
  private resetNeutral = (): void => {
    this.moveX = 0;
    this.moveY = 0;
    this.aimActive = false;
    this.firing = false;
    this.aimMag = 0;
    this.grenadeArc.active = false;
    this.grenadeReleasing = false;
    this.reloadLatch = false;
    this.pickupLatch = false;
    this.abilityHeld = false;
    this.skillPointerId = -1;
    this.grenBtnId = -1;
    this.leftId = -1;
    this.rightId = -1;
    // Clear all stick/grenade visuals (guarded: resetNeutral may fire pre-build).
    this.hideActive('L');
    this.hideActive('R');
    this.stickR?.classList.remove('firing');
    this.hideGren();
  };

  private onVisibility = (): void => {
    if (document.hidden) this.resetNeutral();
  };

  sample(_ground: { x: number; y: number }, _px: number, _py: number): PlayerInput {
    let buttons = 0;
    // Modal grenade arc: while aiming a throw, the gun must NOT fire along the
    // drag direction — suppress FIRE so the arc is fully modal.
    if (this.firing && !this.grenadeArc.active) buttons |= BTN.FIRE;
    if (this.abilityHeld) buttons |= BTN.ABILITY;
    // Aim-assist is on by default; explicit `false` (a settings toggle, S1.6)
    // disables it. Read defensively so headless tests keep assist on. Gate it on
    // aimActive so a RELEASED stick doesn't magnetically track enemies.
    const assistOn = (window as { __bv3?: { touchAssist?: boolean } }).__bv3?.touchAssist !== false;
    let aim = (assistOn && this.aimActive) ? this.assist(this.aimAngle) : this.aimAngle;
    let aimDist = this.aimActive
      ? AIM_MIN_DIST + (AIM_MAX_DIST - AIM_MIN_DIST) * this.aimMag
      : AIM_MIN_DIST;
    // The grenade arc takes priority over the gun aim while held: OR THROW and
    // override aim/dist from the drag (no aim-assist on the arc).
    if (this.grenadeArc.active) {
      buttons |= BTN.THROW;
      aim = this.grenadeArc.aim;
      aimDist = this.grenadeArc.dist;
    } else if (this.grenadeReleasing) {
      // Release tick: THROW already dropped (falling edge) but still hand the sim
      // the final charged drag aim/dist so the throw reaches the dragged range.
      aim = this.grenadeArc.aim;
      aimDist = this.grenadeArc.dist;
      this.grenadeReleasing = false;
    }
    // Consume-on-first-sample: emit each tapped bit at most once.
    if (this.reloadLatch) { buttons |= BTN.RELOAD; this.reloadLatch = false; }
    if (this.pickupLatch) { buttons |= BTN.PICKUP; this.pickupLatch = false; }
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
    this.layer.removeEventListener('pointercancel', this.resetNeutral);
    window.removeEventListener('blur', this.resetNeutral);
    window.removeEventListener('pointerup', this.onGlobalPointerUp);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.layer.remove();
  }
}
