import { angleDiff } from '../core/math';
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

  constructor(private container: HTMLElement, private localId: number) {
    this.layer = document.createElement('div');
    this.layer.id = 'touch-layer';
    this.container.appendChild(this.layer);
  }

  sample(_ground: { x: number; y: number }, _px: number, _py: number): PlayerInput {
    return {
      mx: this.moveX, my: this.moveY,
      aim: this.aimAngle, aimDist: AIM_MIN_DIST,
      buttons: 0, seq: this.seq++,
    };
  }

  dispose(): void {
    this.layer.remove();
  }
}
