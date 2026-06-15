import { angleDiff } from '../core/math';
import { viewportSize } from '../core/viewport';
import type { PlayerInput, PlayerState } from '../sim/types';
import { BTN } from '../sim/types';
import type { InputSource } from '../input';

const STICK_R = 56;
const AIM_STICK_R = 56;
const AIM_DEADZONE = 0.25;
const MOVE_DEADZONE = 0.12;
const AIM_MIN_DIST = 3;
const AIM_MAX_DIST = 16;

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

  private leftId = -1;
  private leftOX = 0;
  private leftOY = 0;

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
    if (this.leftId === -1 && inLeft) {
      this.leftId = e.pointerId;
      this.leftOX = e.clientX;
      this.leftOY = e.clientY;
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
    }
  };

  private onUp = (e: PointerEvent): void => {
    if (e.pointerId === this.leftId) {
      this.leftId = -1;
      this.moveX = 0;
      this.moveY = 0;
    }
  };

  sample(_ground: { x: number; y: number }, _px: number, _py: number): PlayerInput {
    return {
      mx: this.moveX, my: this.moveY,
      aim: this.aimAngle, aimDist: AIM_MIN_DIST,
      buttons: 0, seq: this.seq++,
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
