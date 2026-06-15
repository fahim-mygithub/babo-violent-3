import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const css = readFileSync(new URL('../../src/ui/styles.css', import.meta.url), 'utf8');

describe('S6.5 portrait responsive', () => {
  it('has a max-width:760px media block', () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*760px\)/);
  });
  it('collapses the lobby grid to a single column in that block', () => {
    const block = css.slice(css.indexOf('@media (max-width: 760px)'));
    expect(block).toMatch(/\.lobby[^}]*grid-template-columns:\s*1fr/);
  });
  it('sets 16px form fonts (anti iOS zoom) and ≥44px tap targets', () => {
    const block = css.slice(css.indexOf('@media (max-width: 760px)'));
    expect(block).toMatch(/font-size:\s*16px/);
    expect(block).toMatch(/min-height:\s*44px/);
  });
  it('keeps the .screen a scroll container with vertical panning (never touch-action:none)', () => {
    const block = css.slice(css.indexOf('@media (max-width: 760px)'));
    // Portrait must allow the menu/lobby to scroll — pan-y, not none.
    const screenRule = block.match(/\.screen\s*\{[^}]*\}/)![0];
    expect(screenRule).toMatch(/touch-action:\s*pan-y/);
    expect(screenRule).not.toMatch(/touch-action:\s*none/);
    expect(screenRule).toMatch(/overflow-y:\s*auto/);
  });
  it('uses a fluid clamp() title and :active tap feedback', () => {
    const block = css.slice(css.indexOf('@media (max-width: 760px)'));
    expect(block).toMatch(/clamp\(/);
    expect(block).toMatch(/:active/);
  });
  it('confines all overrides to the media block — desktop cascade byte-identical', () => {
    // Everything before the first @media must be unchanged: assert the desktop
    // lobby grid (3-col template) is still present outside any media query.
    const desktopHead = css.slice(0, css.indexOf('@media'));
    expect(desktopHead).toMatch(/\.lobby\s*\{[^}]*grid-template-columns:\s*320px/);
    // And no @media query may appear before the lobby rule (no desktop override).
    expect(css.indexOf('@media')).toBeGreaterThan(css.indexOf('.lobby'));
  });
});
