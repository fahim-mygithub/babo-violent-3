import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8');
const css = readFileSync(resolve(__dirname, '../../src/ui/styles.css'), 'utf8');

describe('viewport meta + gesture suppression', () => {
  it('viewport meta opts into viewport-fit=cover and keeps user-scalable=no', () => {
    const vp = html.match(/<meta name="viewport"[^>]*>/)![0];
    expect(vp).toMatch(/viewport-fit=cover/);
    expect(vp).toMatch(/user-scalable=no/);
    expect(vp).not.toMatch(/maximum-scale/);
  });
  it('declares the web-app capable + status-bar metas', () => {
    expect(html).toMatch(/name="apple-mobile-web-app-capable"/);
    expect(html).toMatch(/name="apple-mobile-web-app-status-bar-style" content="black-translucent"/);
  });
  it('scopes touch-action:none to play surfaces, never .screen', () => {
    const block = css.match(/#game-canvas,\s*#hud-canvas,\s*#fx-canvas,\s*#touch-layer\s*\{[^}]*\}/)![0];
    expect(block).toMatch(/touch-action:\s*none/);
    expect(css).toMatch(/#game-canvas\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0/); // original rule preserved
  });
});
