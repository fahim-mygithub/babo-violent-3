// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// jsdom resolves import.meta.url to a non-file: URL, so read via __dirname like
// the other shell tests do (keeps the @vitest-environment jsdom directive).
const css = readFileSync(resolve(__dirname, '../../src/ui/styles.css'), 'utf8');
const src = readFileSync(resolve(__dirname, '../../src/ui/screens.ts'), 'utf8');

describe('S6.5 inline tooltips', () => {
  it('renders an inline tooltip element for class role and gun identity', () => {
    expect(src).toMatch(/class="[^"]*tooltip-inline/);
  });
  it('escapes the tooltip text (role + identity go through esc())', () => {
    expect(src).toMatch(/tooltip-inline">\$\{esc\(c\.role\)\}/);
    expect(src).toMatch(/tooltip-inline">\$\{esc\(g\.identity\)\}/);
  });
  it('hides inline tooltips on desktop ≥761px', () => {
    expect(css).toMatch(/@media\s*\(min-width:\s*761px\)[^}]*\.tooltip-inline[^}]*display:\s*none/s);
  });
});
