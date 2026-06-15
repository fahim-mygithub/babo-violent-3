// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { InputManager } from '../../src/input';
import { BTN } from '../../src/sim/types';

let mgr: InputManager;
afterEach(() => mgr?.dispose());

describe('InputManager KeyR → BTN.RELOAD', () => {
  it('sets BTN.RELOAD while KeyR is held, clears on keyup', () => {
    mgr = new InputManager();
    mgr.enabled = true;
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR' }));
    let inp = mgr.sample({ x: 0, y: 0 }, 0, 0);
    expect(inp.buttons & BTN.RELOAD).toBe(BTN.RELOAD);
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyR' }));
    inp = mgr.sample({ x: 0, y: 0 }, 0, 0);
    expect(inp.buttons & BTN.RELOAD).toBe(0);
  });
});
