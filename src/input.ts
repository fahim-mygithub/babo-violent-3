import { BTN, type PlayerInput } from './sim/types';

/**
 * Keyboard + mouse → PlayerInput. Aim is resolved against the ground plane via
 * the renderer's unprojection, supplied per-sample.
 */
export class InputManager {
  private keys = new Set<string>();
  mouseX = window.innerWidth / 2;
  mouseY = window.innerHeight / 2;
  private mouseButtons = 0;
  private seq = 1;
  /** Hold-to-show scoreboard. */
  showScores = false;
  enabled = true;

  constructor() {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('blur', this.onBlur);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    this.keys.add(e.code);
    if (e.code === 'Tab') {
      this.showScores = true;
      e.preventDefault();
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
    if (e.code === 'Tab') this.showScores = false;
  };

  private onMouseMove = (e: MouseEvent): void => {
    this.mouseX = e.clientX;
    this.mouseY = e.clientY;
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (!this.enabled) return;
    this.mouseButtons |= 1 << e.button;
    if (e.button === 2) e.preventDefault();
  };

  private onMouseUp = (e: MouseEvent): void => {
    this.mouseButtons &= ~(1 << e.button);
  };

  private onContextMenu = (e: Event): void => {
    e.preventDefault();
  };

  private onBlur = (): void => {
    this.keys.clear();
    this.mouseButtons = 0;
    this.showScores = false;
  };

  /** Sample the current input. ground = mouse position in sim coords; px,py = local babo. */
  sample(ground: { x: number; y: number }, px: number, py: number): PlayerInput {
    let mx = 0;
    let my = 0;
    if (this.enabled) {
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) my -= 1;
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) my += 1;
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) mx -= 1;
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) mx += 1;
    }
    let buttons = 0;
    if (this.enabled) {
      if (this.mouseButtons & 1) buttons |= BTN.FIRE;
      if (this.mouseButtons & 4) buttons |= BTN.THROW;
      if (this.keys.has('Space')) buttons |= BTN.ABILITY;
      if (this.keys.has('KeyE')) buttons |= BTN.PICKUP;
      if (this.keys.has('KeyR')) buttons |= BTN.RELOAD;
    }
    return {
      mx, my,
      aim: Math.atan2(ground.y - py, ground.x - px),
      aimDist: Math.hypot(ground.x - px, ground.y - py),
      buttons,
      seq: this.seq++,
    };
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('blur', this.onBlur);
  }
}
