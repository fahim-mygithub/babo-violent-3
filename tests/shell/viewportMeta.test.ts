import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../src/ui/styles.css', import.meta.url), 'utf8');

describe('S6.1 viewport + gesture suppression', () => {
  it('index.html viewport includes viewport-fit=cover', () => {
    expect(html).toMatch(/viewport-fit=cover/);
  });
  it('declares apple-mobile-web-app metas + manifest link', () => {
    expect(html).toMatch(/apple-mobile-web-app-capable/);
    expect(html).toMatch(/rel="manifest"/);
  });
  it('play surfaces get touch-action:none but #game-canvas keeps its absolute reset', () => {
    expect(css).toMatch(/#game-canvas\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0[^}]*\}/);
    expect(css).toMatch(/#touch-layer[^{]*\{[^}]*touch-action:\s*none/);
  });
  it('#touch-layer is sized to fill the play surface', () => {
    // The forward-declared #touch-layer rule must size the layer so the touch
    // overlay covers the whole viewport (it is created lazily by TouchControls).
    const block = css.match(/#touch-layer\s*\{[^}]*\}/)![0];
    expect(block).toMatch(/position:\s*absolute/);
    expect(block).toMatch(/inset:\s*0/);
    expect(block).toMatch(/touch-action:\s*none/);
  });
  it('exposes device safe-area insets as --bv3-safe-* vars the HUD reads', () => {
    // src/render/hud.ts reads getPropertyValue('--bv3-safe-left'/'--bv3-safe-bottom').
    // Those vars must be defined from env(safe-area-inset-*) or the panel never insets.
    expect(css).toMatch(/--bv3-safe-left:\s*env\(safe-area-inset-left\)/);
    expect(css).toMatch(/--bv3-safe-bottom:\s*env\(safe-area-inset-bottom\)/);
  });
});
