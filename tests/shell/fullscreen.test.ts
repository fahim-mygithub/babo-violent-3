import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const src = readFileSync(resolve(__dirname, '../../src/app.ts'), 'utf8');

describe('S6.6 Android-only fullscreen', () => {
  it('feature-detects requestFullscreen + coarse pointer and swallows rejection', () => {
    expect(src).toMatch(/requestFullscreen/);
    expect(src).toMatch(/pointer:\s*coarse/);
    expect(src).toMatch(/\.catch\(/);
  });
  it('never programmatically locks orientation (portrait is a product decision)', () => {
    expect(src).not.toMatch(/orientation\.lock/);
  });
});
