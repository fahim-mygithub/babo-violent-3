import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FILES = [
  'textures', 'splatmap', 'renderer', 'lobbyPreview',
  'gunModels', 'effects', 'babos', 'baboShapes', 'baboShader',
];

describe('three named imports (tree-shakeable)', () => {
  for (const f of FILES) {
    it(`${f}.ts uses named imports, not import * as THREE`, () => {
      const src = readFileSync(resolve(__dirname, `../../src/render/${f}.ts`), 'utf8');
      expect(src).not.toMatch(/import \* as THREE/);
    });
  }
});
