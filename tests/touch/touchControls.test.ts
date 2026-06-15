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

function pe(type: string, id: number, x: number, y: number): PointerEvent {
  return new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, bubbles: true });
}

describe('TouchControls left stick → movement', () => {
  it('maps a right-down drag to mx>0,my>0 and releases to 0', () => {
    const c = mount();
    tc = new TouchControls(c, 1);
    const layer = c.querySelector('#touch-layer') as HTMLElement;
    // left zone: x in left ~45% of an 800px-wide window (jsdom innerWidth=1024 default)
    layer.dispatchEvent(pe('pointerdown', 1, 100, 600));
    layer.dispatchEvent(pe('pointermove', 1, 100 + 56, 600 + 56)); // full deflection, +x/+y
    let inp = tc.sample({ x: 0, y: 0 }, 0, 0);
    expect(inp.mx).toBeGreaterThan(0.5);
    expect(inp.my).toBeGreaterThan(0.5);
    layer.dispatchEvent(pe('pointerup', 1, 100 + 56, 600 + 56));
    inp = tc.sample({ x: 0, y: 0 }, 0, 0);
    expect(inp.mx).toBe(0);
    expect(inp.my).toBe(0);
  });

  it('applies a dead-zone: tiny deflection → 0', () => {
    const c = mount();
    tc = new TouchControls(c, 1);
    const layer = c.querySelector('#touch-layer') as HTMLElement;
    layer.dispatchEvent(pe('pointerdown', 1, 100, 600));
    layer.dispatchEvent(pe('pointermove', 1, 103, 600)); // ~3px < 0.12*56
    const inp = tc.sample({ x: 0, y: 0 }, 0, 0);
    expect(inp.mx).toBe(0);
    expect(inp.my).toBe(0);
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
