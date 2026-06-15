import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const src = readFileSync(resolve(__dirname, '../../src/app.ts'), 'utf8');

describe('lobby prefetch warms the match chunks', () => {
  it('has a prefetchMatchChunks that imports rapier + render', () => {
    expect(src).toMatch(/prefetchMatchChunks/);
    expect(src).toMatch(/import\(['"]@dimforge\/rapier2d-compat['"]\)/);
    expect(src).toMatch(/import\(['"]\.\/render\/renderer['"]\)/);
    expect(src).toMatch(/import\(['"]\.\/render\/hud['"]\)/);
    expect(src).toMatch(/import\(['"]\.\/render\/screenfx['"]\)/);
  });
});
