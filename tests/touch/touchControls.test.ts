// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { TouchControls } from '../../src/touch/touchControls';
import { InputManager } from '../../src/input';
import { emptyInput } from '../../src/sim/types';

let tc: TouchControls;
afterEach(() => tc?.dispose());

function mount(): HTMLElement {
  const c = document.createElement('div');
  document.body.appendChild(c);
  return c;
}

describe('TouchControls scaffold', () => {
  it('appends a #touch-layer to the container and removes it on dispose', () => {
    const c = mount();
    tc = new TouchControls(c, 1);
    expect(c.querySelector('#touch-layer')).not.toBeNull();
    tc.dispose();
    expect(c.querySelector('#touch-layer')).toBeNull();
  });

  it('neutral sample matches emptyInput shape with buttons 0 and zero movement', () => {
    const c = mount();
    tc = new TouchControls(c, 1);
    const inp = tc.sample({ x: 0, y: 0 }, 5, 5);
    expect(inp.buttons).toBe(0);
    expect(inp.mx).toBe(0);
    expect(inp.my).toBe(0);
    expect(typeof inp.aim).toBe('number');
    // shape parity with emptyInput keys
    expect(Object.keys(inp).sort()).toEqual(Object.keys(emptyInput()).sort());
  });
});

describe('S8.4 desktop non-regression: dormant TouchControls does not perturb InputManager', () => {
  it('constructed TouchControls leaves InputManager.sample byte-identical', () => {
    // Capture InputManager.sample output with NO TouchControls present.
    const mgrA = new InputManager();
    mgrA.enabled = true;
    const before = mgrA.sample({ x: 3, y: -2 }, 1, 1);
    mgrA.dispose();

    // Now construct a TouchControls (it attaches DOM/window listeners) and a
    // fresh InputManager; the InputManager output must be unchanged.
    const c = mount();
    tc = new TouchControls(c, 1);
    const mgrB = new InputManager();
    mgrB.enabled = true;
    const after = mgrB.sample({ x: 3, y: -2 }, 1, 1);
    mgrB.dispose();

    // seq counters are per-instance and both start at 1 → equal.
    expect(after).toEqual(before);
  });
});
