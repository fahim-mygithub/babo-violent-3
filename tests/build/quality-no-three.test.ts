import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// S8.7 exit-gate fix — keep `three` off the ENTRY chunk.
//
// app.ts eagerly imports the tier-detection helpers (QUALITY/shouldMountPreview)
// from render/quality.ts. If that module statically imports `three`, Rollup hoists
// three's material-class constructors into the entry chunk (index-*.js) — breaking
// the "entry has no static three" bundle-deferral gate. The surfaceMat factory is
// the only thing in the quality module that needs three, and it is ONLY reachable
// from the (already-dynamic) render chunks, so it lives in its own module.
const read = (p: string): string => readFileSync(resolve(__dirname, '../../', p), 'utf8');

describe('quality.ts stays off the three (entry) path', () => {
  it('render/quality.ts imports no three (so the eager entry path is three-free)', () => {
    const src = read('src/render/quality.ts');
    expect(src).not.toMatch(/from ['"]three['"]/);
  });

  it('the surfaceMat factory lives in its own render/surfaceMat.ts module', () => {
    const src = read('src/render/surfaceMat.ts');
    expect(src).toMatch(/export function surfaceMat/);
    expect(src).toMatch(/from ['"]three['"]/); // three is allowed HERE (render-chunk only)
  });

  it('the render-path consumers import surfaceMat from the new module, not quality', () => {
    for (const f of ['baboShapes.ts', 'effects.ts', 'gunModels.ts', 'renderer.ts']) {
      const src = read(`src/render/${f}`);
      // surfaceMat is imported (from anywhere) and NOT bundled with QUALITY from ./quality
      expect(src).toMatch(/surfaceMat/);
      expect(src).not.toMatch(/import \{[^}]*surfaceMat[^}]*\} from ['"]\.\/quality['"]/);
    }
  });
});
