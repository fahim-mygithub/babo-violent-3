import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('startup deferral', () => {
  it('main.ts no longer awaits initPhysics before the menu', () => {
    const src = readFileSync(resolve(__dirname, '../../src/main.ts'), 'utf8');
    expect(src).not.toMatch(/await\s+initPhysics/);
    expect(src).not.toMatch(/from '\.\/sim\/sim'/); // sim/Rapier no longer reachable from the entry
  });
  it('app.ts dynamically imports the renderer + sim (not static)', () => {
    const src = readFileSync(resolve(__dirname, '../../src/app.ts'), 'utf8');
    expect(src).toMatch(/import\(['"]\.\/render\/renderer['"]\)/);
    expect(src).toMatch(/import\(['"]\.\/sim\/sim['"]\)/);
  });
});
