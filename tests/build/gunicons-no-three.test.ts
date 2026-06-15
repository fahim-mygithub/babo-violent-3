import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('gunIcons extraction — off the Three path', () => {
  it('src/render/gunIcons.ts exists and imports no three', () => {
    const src = readFileSync(resolve(__dirname, '../../src/render/gunIcons.ts'), 'utf8');
    expect(src).not.toMatch(/from ['"]three['"]/);
    expect(src).toMatch(/export function makeGunIcon/);
  });
  it('screens.ts imports makeGunIcon from gunIcons, not gunModels', () => {
    const src = readFileSync(resolve(__dirname, '../../src/ui/screens.ts'), 'utf8');
    expect(src).toMatch(/from ['"]\.\.\/render\/gunIcons['"]/);
    expect(src).not.toMatch(/makeGunIcon.*from ['"]\.\.\/render\/gunModels['"]/);
  });
});
