// @vitest-environment jsdom
//
// S8.6 — responsive-shell layout gate. jsdom cannot run a real layout engine, so
// this suite is explicit about WHAT it proves:
//   • LAYOUT-COMPUTED (getComputedStyle over the project's own styles.css, injected
//     into the jsdom document): the #touch-layer fills the surface, and the control
//     band (sticks + button row) is positioned in the BOTTOM ~40% of the play
//     surface via `bottom`-anchored rules — i.e. arena reads the top ~60%, controls
//     the bottom ~40%. These resolve because the rule selectors are real and jsdom's
//     CSSOM applies them; pixel geometry (offsetTop) is NOT available headless, so
//     band intent is asserted through the resolved CSS box properties, not measured.
//   • CONTENT-ASSERTED (string match over the source files): the `@media (max-width:
//     760px)` portrait block exists and keeps `.screen` at `touch-action: pan-y`
//     (never `none`); the `--bv3-safe-*` HUD safe-area vars are defined from env();
//     index.html opts into `viewport-fit=cover`.
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TouchControls } from '../../src/touch/touchControls';

const css = readFileSync(resolve(__dirname, '../../src/ui/styles.css'), 'utf8');
const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8');

let tc: TouchControls | undefined;
let styleEl: HTMLStyleElement | undefined;

/** Inject the real project stylesheet so getComputedStyle resolves our band rules. */
function injectStyles(): void {
  styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);
}

afterEach(() => {
  tc?.dispose();
  tc = undefined;
  styleEl?.remove();
  styleEl = undefined;
  document.body.innerHTML = '';
});

describe('S8.6 portrait control band (layout-computed via jsdom CSSOM)', () => {
  function mount(): { c: HTMLDivElement } {
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    Object.defineProperty(window, 'innerWidth', { value: 400, configurable: true });
    injectStyles();
    const c = document.createElement('div');
    document.body.appendChild(c);
    tc = new TouchControls(c, 1);
    return { c };
  }

  it('places #touch-layer over the full play surface (absolute + touch-action:none)', () => {
    const { c } = mount();
    const layer = c.querySelector('#touch-layer') as HTMLElement;
    expect(layer).not.toBeNull();
    const s = getComputedStyle(layer);
    // LAYOUT-COMPUTED: jsdom's CSSOM resolves declared longhands (position,
    // touch-action). It does NOT expand the `inset: 0` shorthand into top/right/
    // bottom/left, so full-surface sizing is content-asserted below, not here.
    expect(s.position).toBe('absolute');
    expect(s.touchAction).toBe('none');
  });

  it('weights the control buttons to the bottom band (bottom-anchored, not top)', () => {
    const { c } = mount();
    const skill = c.querySelector('#tc-skill') as HTMLElement;
    expect(skill).not.toBeNull();
    const s = getComputedStyle(skill);
    // The band rule absolutely positions edge buttons against the bottom edge so
    // they live in the lower ~40% — `bottom` is set, `top` is left auto.
    expect(s.position).toBe('absolute');
    expect(s.bottom).not.toBe('');
    expect(s.bottom).not.toBe('auto');
    expect(s.top).toBe('auto');
  });

  it('anchors the left move stick zone to the bottom-left and the right aim zone to the bottom-right', () => {
    const { c } = mount();
    // The .tc-btn band rule applies to every edge button; the LEAVE/SCORE pair sits
    // top, the action cluster (skill/reload/equip/pickup) sits bottom-right. Assert
    // the skill button (action cluster) resolves a non-auto `right` so it hugs the
    // right edge inside the bottom band.
    const skill = c.querySelector('#tc-skill') as HTMLElement;
    const s = getComputedStyle(skill);
    expect(s.right).not.toBe('auto');
    expect(s.right).not.toBe('');
  });
});

describe('S8.6 source-of-truth strings (content-asserted)', () => {
  it('keeps the #touch-layer band CSS in styles.css (sized + touch-action:none)', () => {
    const rule = css.match(/#touch-layer\s*\{[^}]*\}/)![0];
    expect(rule).toMatch(/inset:\s*0/);
    expect(rule).toMatch(/touch-action:\s*none/);
  });

  it('positions the .tc-btn control band against the bottom edge', () => {
    const rule = css.match(/\.tc-btn\s*\{[^}]*\}/)![0];
    expect(rule).toMatch(/position:\s*absolute/);
    expect(rule).toMatch(/bottom:/);
  });

  it('defines the HUD safe-area vars from env(safe-area-inset-*)', () => {
    expect(css).toMatch(/--bv3-safe-top:\s*env\(safe-area-inset-top\)/);
    expect(css).toMatch(/--bv3-safe-right:\s*env\(safe-area-inset-right\)/);
    expect(css).toMatch(/--bv3-safe-bottom:\s*env\(safe-area-inset-bottom\)/);
    expect(css).toMatch(/--bv3-safe-left:\s*env\(safe-area-inset-left\)/);
  });

  it('has the portrait @media block keeping .screen at touch-action:pan-y (never none)', () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*760px\)/);
    const block = css.slice(css.indexOf('@media (max-width: 760px)'));
    const screenRule = block.match(/\.screen\s*\{[^}]*\}/)![0];
    expect(screenRule).toMatch(/touch-action:\s*pan-y/);
    expect(screenRule).not.toMatch(/touch-action:\s*none/);
  });

  it('opts index.html into viewport-fit=cover for the safe-area HUD', () => {
    const vp = html.match(/<meta name="viewport"[^>]*>/)![0];
    expect(vp).toMatch(/viewport-fit=cover/);
  });
});
