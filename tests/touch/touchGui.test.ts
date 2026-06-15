// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { TouchControls } from '../../src/touch/touchControls';
import { BTN } from '../../src/sim/types';

let tc: TouchControls;
afterEach(() => tc?.dispose());

function mount(): HTMLElement {
  const c = document.createElement('div');
  document.body.appendChild(c);
  return c;
}

function pe(type: string, id: number, x: number, y: number): PointerEvent {
  return new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, bubbles: true });
}

// jsdom viewport is 1024x768 (no coarse pointer → viewportSize uses innerW/H).
// Left zone: x < 0.45*1024=460.8 && y > 0.5*768=384.  Right zone: x > 460.8 && y > 0.6*768=460.8.

describe('Visible stick GUI — persistent home rings + glyphs (fixes "guessing where to put thumbs")', () => {
  it('builds a fixed home ring + center glyph for BOTH sticks, always present at idle', () => {
    const c = mount();
    tc = new TouchControls(c, 1);
    const homeL = c.querySelector('.tc-stick-home.left');
    const homeR = c.querySelector('.tc-stick-home.right');
    expect(homeL).not.toBeNull();
    expect(homeR).not.toBeNull();
    // each home carries a self-documenting center glyph
    expect(homeL!.querySelector('.tc-stick-glyph')).not.toBeNull();
    expect(homeR!.querySelector('.tc-stick-glyph')).not.toBeNull();
  });

  it('disposes the stick GUI with the layer', () => {
    const c = mount();
    tc = new TouchControls(c, 1);
    expect(c.querySelector('.tc-stick-home.left')).not.toBeNull();
    tc.dispose();
    expect(c.querySelector('.tc-stick-home.left')).toBeNull();
  });
});

describe('Active ring + knob track the thumb (visual only — input unchanged)', () => {
  it('left stick: active ring blooms on touch, knob offsets on drag, both reset on release', () => {
    const c = mount();
    tc = new TouchControls(c, 1);
    const layer = c.querySelector('#touch-layer') as HTMLElement;
    const active = c.querySelector('.tc-stick-active.left') as HTMLElement;
    const knob = active.querySelector('.tc-stick-knob') as HTMLElement;
    expect(active.classList.contains('active')).toBe(false);

    layer.dispatchEvent(pe('pointerdown', 1, 100, 600));
    expect(active.classList.contains('active')).toBe(true);

    layer.dispatchEvent(pe('pointermove', 1, 156, 656)); // +x/+y full deflection
    // knob is offset away from center (non-zero translate)
    expect(knob.style.transform).toMatch(/translate/);
    expect(knob.style.transform).not.toBe('translate(0px, 0px)');

    layer.dispatchEvent(pe('pointerup', 1, 156, 656));
    expect(active.classList.contains('active')).toBe(false);
    expect(knob.style.transform).toBe('translate(0px, 0px)');
  });

  it('right stick gains a .firing state past the autofire deadzone, clears on release', () => {
    const c = mount();
    tc = new TouchControls(c, 1);
    const layer = c.querySelector('#touch-layer') as HTMLElement;
    const stick = c.querySelector('.tc-stick.right') as HTMLElement;

    layer.dispatchEvent(pe('pointerdown', 2, 800, 600));
    layer.dispatchEvent(pe('pointermove', 2, 840, 600)); // 40/56 = 0.71 > 0.25
    expect(stick.classList.contains('firing')).toBe(true);

    layer.dispatchEvent(pe('pointerup', 2, 840, 600));
    expect(stick.classList.contains('firing')).toBe(false);
  });

  it('right stick stays un-fired (no .firing) below the autofire deadzone', () => {
    const c = mount();
    tc = new TouchControls(c, 1);
    const layer = c.querySelector('#touch-layer') as HTMLElement;
    const stick = c.querySelector('.tc-stick.right') as HTMLElement;
    layer.dispatchEvent(pe('pointerdown', 2, 800, 600));
    layer.dispatchEvent(pe('pointermove', 2, 805, 600)); // 5/56 ≈ 0.09 < 0.25
    expect(stick.classList.contains('firing')).toBe(false);
  });

  it('drops the .firing visual while a grenade arc is modal (FIRE is suppressed there)', () => {
    const c = mount();
    tc = new TouchControls(c, 1);
    const layer = c.querySelector('#touch-layer') as HTMLElement;
    const stick = c.querySelector('.tc-stick.right') as HTMLElement;
    layer.dispatchEvent(pe('pointerdown', 2, 800, 600));
    layer.dispatchEvent(pe('pointermove', 2, 840, 600)); // firing
    expect(stick.classList.contains('firing')).toBe(true);
    tc.beginGrenade(840, 600); // arc becomes modal → FIRE suppressed
    layer.dispatchEvent(pe('pointermove', 2, 845, 600)); // a further aim sample
    expect(stick.classList.contains('firing')).toBe(false);
  });

  it('a pointerup delivered OFF the layer still clears a stuck stick (capture fallback)', () => {
    const c = mount();
    tc = new TouchControls(c, 1);
    const layer = c.querySelector('#touch-layer') as HTMLElement;
    const activeL = c.querySelector('.tc-stick-active.left') as HTMLElement;
    layer.dispatchEvent(pe('pointerdown', 7, 100, 600));
    layer.dispatchEvent(pe('pointermove', 7, 156, 656));
    expect(activeL.classList.contains('active')).toBe(true);
    // Release lands on the window (e.g. capture lost / slid onto a chip) — not the layer.
    window.dispatchEvent(pe('pointerup', 7, 156, 656));
    const inp = tc.sample({ x: 0, y: 0 }, 0, 0);
    expect(inp.mx).toBe(0);
    expect(inp.my).toBe(0);
    expect(activeL.classList.contains('active')).toBe(false);
  });

  it('blur clears the active ring, knob, and firing state', () => {
    const c = mount();
    tc = new TouchControls(c, 1);
    const layer = c.querySelector('#touch-layer') as HTMLElement;
    const activeL = c.querySelector('.tc-stick-active.left') as HTMLElement;
    const stickR = c.querySelector('.tc-stick.right') as HTMLElement;
    layer.dispatchEvent(pe('pointerdown', 1, 100, 600));
    layer.dispatchEvent(pe('pointermove', 1, 156, 656));
    layer.dispatchEvent(pe('pointerdown', 2, 800, 600));
    layer.dispatchEvent(pe('pointermove', 2, 840, 600));
    window.dispatchEvent(new Event('blur'));
    expect(activeL.classList.contains('active')).toBe(false);
    expect(stickR.classList.contains('firing')).toBe(false);
  });
});

describe('Adding stick visuals does NOT change emitted PlayerInput (determinism contract)', () => {
  it('left full-deflection drag still emits the same normalized mx/my', () => {
    const c = mount();
    tc = new TouchControls(c, 1);
    const layer = c.querySelector('#touch-layer') as HTMLElement;
    layer.dispatchEvent(pe('pointerdown', 1, 100, 600));
    layer.dispatchEvent(pe('pointermove', 1, 156, 656)); // dx=dy=56 → m=1, normalized 0.7071
    const inp = tc.sample({ x: 0, y: 0 }, 0, 0);
    expect(inp.mx).toBeCloseTo(Math.SQRT1_2, 4);
    expect(inp.my).toBeCloseTo(Math.SQRT1_2, 4);
  });

  it('right deflection still emits aim + BTN.FIRE unchanged', () => {
    const c = mount();
    tc = new TouchControls(c, 1);
    const layer = c.querySelector('#touch-layer') as HTMLElement;
    layer.dispatchEvent(pe('pointerdown', 2, 800, 600));
    layer.dispatchEvent(pe('pointermove', 2, 840, 600));
    const inp = tc.sample({ x: 0, y: 0 }, 0, 0);
    expect(inp.aim).toBeCloseTo(0, 3);
    expect(inp.buttons & BTN.FIRE).toBe(BTN.FIRE);
  });
});

describe('Action buttons carry an icon + a label (fixes "what does each control do")', () => {
  it.each([
    ['#tc-skill', 'SKILL'],
    ['#tc-reload', 'RELOAD'],
    ['#tc-equip', 'NADE'],
    ['#tc-pickup', 'PICKUP'],
    ['#tc-scores', 'SCORE'],
    ['#tc-leave', 'LEAVE'],
  ])('%s has an SVG icon and the label "%s"', (sel, label) => {
    const c = mount();
    tc = new TouchControls(c, 1);
    const btn = c.querySelector(sel) as HTMLElement;
    expect(btn).not.toBeNull();
    expect(btn.querySelector('.tc-ico svg')).not.toBeNull();
    expect(btn.querySelector('.tc-lbl')?.textContent).toBe(label);
  });

  it('buttons still drive their existing inputs (icon markup did not break handlers)', () => {
    const c = mount();
    tc = new TouchControls(c, 1);
    const skill = c.querySelector('#tc-skill') as HTMLElement;
    skill.dispatchEvent(pe('pointerdown', 3, 980, 400));
    expect(tc.sample({ x: 0, y: 0 }, 0, 0).buttons & BTN.ABILITY).toBe(BTN.ABILITY);
  });
});

describe('Grenade drag stick shows on EQUIP-hold and hides on release', () => {
  it('toggles a screen-space grenade arc overlay with grenadeArc.active', () => {
    const c = mount();
    tc = new TouchControls(c, 1);
    const arc = c.querySelector('.tc-gren') as HTMLElement;
    expect(arc).not.toBeNull();
    expect(arc.classList.contains('active')).toBe(false);
    tc.beginGrenade(300, 500);
    expect(arc.classList.contains('active')).toBe(true);
    tc.moveGrenade(300 + 100, 500);
    // knob is pushed out along the drag
    const knob = arc.querySelector('.tc-gren-knob') as HTMLElement;
    expect(knob.style.transform).toMatch(/translate/);
    tc.endGrenade();
    expect(arc.classList.contains('active')).toBe(false);
  });
});

describe('onDown ignores the bottom home-indicator strip (iOS swipe safety)', () => {
  it('a grab inside the bottom ~34px strip does not start a stick', () => {
    const c = mount();
    tc = new TouchControls(c, 1);
    const layer = c.querySelector('#touch-layer') as HTMLElement;
    // h=768 → strip is y > 768-34 = 734. A left-zone x but inside the strip.
    layer.dispatchEvent(pe('pointerdown', 1, 100, 750));
    layer.dispatchEvent(pe('pointermove', 1, 156, 750));
    const inp = tc.sample({ x: 0, y: 0 }, 0, 0);
    expect(inp.mx).toBe(0);
    expect(inp.my).toBe(0);
  });
});
