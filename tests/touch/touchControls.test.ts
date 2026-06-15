// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { TouchControls } from '../../src/touch/touchControls';
import { InputManager } from '../../src/input';
import { BTN, emptyInput } from '../../src/sim/types';
import { angleDiff } from '../../src/core/math';

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

describe('TouchControls right stick → aim + autofire', () => {
  it('sets aim=atan2(dy,dx) and BTN.FIRE while deflected, clears FIRE on release', () => {
    const c = mount();
    tc = new TouchControls(c, 1);
    const layer = c.querySelector('#touch-layer') as HTMLElement;
    // right zone: x in right ~55%, bottom 40%. jsdom innerWidth=1024, innerHeight=768
    layer.dispatchEvent(pe('pointerdown', 2, 800, 600));
    layer.dispatchEvent(pe('pointermove', 2, 800 + 40, 600)); // +x deflection
    let inp = tc.sample({ x: 0, y: 0 }, 0, 0);
    expect(inp.aim).toBeCloseTo(0, 3);           // atan2(0, +dx)
    expect(inp.buttons & BTN.FIRE).toBe(BTN.FIRE);
    expect(tc.aimActive).toBe(true);
    layer.dispatchEvent(pe('pointerup', 2, 840, 600));
    inp = tc.sample({ x: 0, y: 0 }, 0, 0);
    expect(inp.buttons & BTN.FIRE).toBe(0);
    expect(tc.aimActive).toBe(false);
  });

  it('does NOT fire below AIM_DEADZONE deflection', () => {
    const c = mount();
    tc = new TouchControls(c, 1);
    const layer = c.querySelector('#touch-layer') as HTMLElement;
    layer.dispatchEvent(pe('pointerdown', 2, 800, 600));
    layer.dispatchEvent(pe('pointermove', 2, 805, 600)); // 5px / 56 ≈ 0.09 < 0.25
    const inp = tc.sample({ x: 0, y: 0 }, 0, 0);
    expect(inp.buttons & BTN.FIRE).toBe(0);
  });
});

function worldWith(targets: { id: number; x: number; y: number; team?: number }[]) {
  return {
    players: [
      { id: 1, x: 0, y: 0, team: -1, alive: true },
      ...targets.map((t) => ({ id: t.id, x: t.x, y: t.y, team: t.team ?? -1, alive: true })),
    ],
  } as any;
}

describe('TouchControls aim-assist', () => {
  it('nudges aim toward a target inside the cone but never past it (capped strength)', () => {
    const c = mount();
    tc = new TouchControls(c, 1);
    tc.setWorld(worldWith([{ id: 2, x: 10, y: 0 }]), 1); // target dead +x (ang 0)
    const layer = c.querySelector('#touch-layer') as HTMLElement;
    layer.dispatchEvent(pe('pointerdown', 2, 800, 600));
    // raw aim ~0.1 rad off the target (within 0.30 cone)
    layer.dispatchEvent(pe('pointermove', 2, 800 + 40 * Math.cos(0.1), 600 + 40 * Math.sin(0.1)));
    const inp = tc.sample({ x: 0, y: 0 }, 0, 0);
    // assisted aim is between raw (0.1) and target (0): nudged toward 0, not snapped
    expect(inp.aim).toBeGreaterThan(0);
    expect(inp.aim).toBeLessThan(0.1);
  });

  it('does not assist outside the cone or onto teammates', () => {
    const c = mount();
    tc = new TouchControls(c, 1);
    tc.setWorld(worldWith([{ id: 2, x: 0, y: 10, team: -1 }]), 1); // target at +y (ang PI/2)
    const layer = c.querySelector('#touch-layer') as HTMLElement;
    layer.dispatchEvent(pe('pointerdown', 2, 800, 600));
    layer.dispatchEvent(pe('pointermove', 2, 840, 600)); // raw aim ~0, target far outside cone
    const inp = tc.sample({ x: 0, y: 0 }, 0, 0);
    expect(Math.abs(inp.aim)).toBeLessThan(0.05); // unchanged
  });

  it('tolerates an unset/null world (no players) without throwing', () => {
    const c = mount();
    tc = new TouchControls(c, 1);
    tc.setWorld(null, 1);
    const layer = c.querySelector('#touch-layer') as HTMLElement;
    layer.dispatchEvent(pe('pointerdown', 2, 800, 600));
    layer.dispatchEvent(pe('pointermove', 2, 840, 600));
    expect(() => tc.sample({ x: 0, y: 0 }, 0, 0)).not.toThrow();
  });
});

describe('TouchControls grenade drag-arc', () => {
  it('EQUIP-hold ORs BTN.THROW and overrides aim/aimDist from the drag, clears on release', () => {
    const c = mount();
    tc = new TouchControls(c, 1);
    // EQUIPMENT button lives at a known id; simulate via the equip pointer entry point.
    tc.beginGrenade(840, 300); // origin
    tc.moveGrenade(840 + 140, 300); // full ARC_DRAG_PX → max range, aim +x
    let inp = tc.sample({ x: 0, y: 0 }, 0, 0);
    expect(inp.buttons & BTN.THROW).toBe(BTN.THROW);
    expect(inp.aim).toBeCloseTo(0, 3);
    expect(inp.aimDist).toBeGreaterThan(13); // near GRENADE_MAX_RANGE (14)
    expect(tc.grenadeArc.active).toBe(true);
    tc.endGrenade();
    inp = tc.sample({ x: 0, y: 0 }, 0, 0);
    expect(inp.buttons & BTN.THROW).toBe(0);
    expect(tc.grenadeArc.active).toBe(false);
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
