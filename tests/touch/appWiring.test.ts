// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { TouchControls } from '../../src/touch/touchControls';
import { InputManager } from '../../src/input';
import type { InputSource } from '../../src/input';

// Mirrors App.sampleInput's branch: when activeSource is the touch source, it must
// call touch.sample with a zero ground arg (touch computes its own aim).
function routeSample(activeSource: InputSource, kbm: InputManager, touch: TouchControls | null,
                     ground: { x: number; y: number }, px: number, py: number) {
  if (activeSource === touch && touch) return touch.sample({ x: 0, y: 0 }, px, py);
  return kbm.sample(ground, px, py);
}

describe('App source routing', () => {
  it('routes through touch.sample (ignoring ground) when activeSource is touch', () => {
    const c = document.createElement('div'); document.body.appendChild(c);
    const kbm = new InputManager();
    const touch = new TouchControls(c, 1);
    const layer = c.querySelector('#touch-layer') as HTMLElement;
    layer.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 2, clientX: 800, clientY: 600 }));
    layer.dispatchEvent(new PointerEvent('pointermove', { pointerId: 2, clientX: 840, clientY: 600 }));
    const out = routeSample(touch, kbm, touch, { x: 999, y: 999 }, 0, 0);
    expect(out.aim).toBeCloseTo(0, 3); // from the right stick, NOT the bogus ground
    touch.dispose(); kbm.dispose();
  });

  it('routes through kbm.sample when activeSource is kbm', () => {
    const kbm = new InputManager(); kbm.enabled = true;
    const out = routeSample(kbm, kbm, null, { x: 10, y: 0 }, 0, 0);
    expect(out.aim).toBeCloseTo(0, 3); // atan2(0, +10)
    kbm.dispose();
  });
});

// Source-assertion that the App wiring lands the kbm/touch/activeSource seam and
// keeps the desktop default (kbm) — App is not headless-instantiable, so these
// grep the production source for the contract sampleInput/enterMatch/teardown
// must satisfy. The behavioural routing above mirrors the live branch.
describe('App wiring (source assertion)', () => {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { resolve } = require('node:path') as typeof import('node:path');
  const src = readFileSync(resolve(__dirname, '../../src/app.ts'), 'utf8');

  it('replaces the single input with kbm/touch/activeSource and defaults to kbm', () => {
    expect(src).toMatch(/private kbm = new InputManager\(\)/);
    expect(src).toMatch(/private touch: TouchControls \| null = null/);
    expect(src).toMatch(/private activeSource: InputSource = this\.kbm/);
    expect(src).not.toMatch(/private input = new InputManager\(\)/);
  });

  it('sampleInput routes by source and only unprojects the mouse on the kbm path', () => {
    const body = src.slice(src.indexOf('sampleInput('), src.indexOf('private tick('));
    expect(body).toMatch(/this\.activeSource === this\.touch/);
    expect(body).toMatch(/this\.touch\.sample\(\{ x: 0, y: 0 \}/);
    expect(body).toMatch(/this\.renderer\.groundPoint\(this\.kbm\.mouseX, this\.kbm\.mouseY\)/);
  });

  it('calls touch.setWorld in both tick branches (null-guarded) + toggles touch-mode', () => {
    expect(src).toMatch(/this\.touch\?\.setWorld/);
    expect(src).toMatch(/classList\.(toggle|add)\(['"]touch-mode/);
    expect(src).toMatch(/shouldUseTouch\(\)/);
  });
});

// DESKTOP non-regression (S8.4): with no coarse pointer / no override, the App
// must stay on the kbm source — touch is never built, the camera scalars stay
// 1/0/1, the HUD stays mouse-anchored, and the laser is never driven. These are
// guarded by `this.useTouch` (= shouldUseTouch()) being false on desktop. Lock the
// detection + the guard so a future edit can't silently flip the desktop path on.
describe('desktop non-regression', () => {
  it('shouldUseTouch is false on a desktop matchMedia (no coarse pointer, has hover)', async () => {
    const { shouldUseTouch } = await import('../../src/touch/touchControls');
    const orig = (globalThis as { matchMedia?: unknown }).matchMedia;
    (globalThis as { matchMedia?: unknown }).matchMedia = (q: string) => ({
      matches: false, media: q, addEventListener() {}, removeEventListener() {},
    });
    expect(shouldUseTouch()).toBe(false);
    if (orig) (globalThis as { matchMedia?: unknown }).matchMedia = orig;
    else delete (globalThis as { matchMedia?: unknown }).matchMedia;
  });

  it('every touch-only effect is gated behind useTouch / a non-null touch source', () => {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { resolve } = require('node:path') as typeof import('node:path');
    const appSrc = readFileSync(resolve(__dirname, '../../src/app.ts'), 'utf8');
    // The camera scalars are computed from useTouch only — never unconditionally raised.
    expect(appSrc).toMatch(/aimLeadScale\s*=\s*this\.useTouch\s*\?\s*0\.35\s*:\s*1/);
    expect(appSrc).toMatch(/camDistScale\s*=\s*\(this\.useTouch && [^)]*\)\s*\?\s*1\.25\s*:\s*1/);
    // The laser is only driven inside an `if (this.touch)` block (null on desktop).
    expect(appSrc).toMatch(/if \(this\.touch\) \{[\s\S]*?setAimState/);
    // hud.touchMode mirrors useTouch (false on desktop → mouse anchor).
    expect(appSrc).toMatch(/this\.hud\.touchMode\s*=\s*this\.useTouch/);
  });
});
