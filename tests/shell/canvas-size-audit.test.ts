import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

for (const f of ['hud', 'screenfx']) {
  const src = readFileSync(resolve(__dirname, `../../src/render/${f}.ts`), 'utf8');
  describe(`${f}.ts canvas-size audit`, () => {
    it('reads cached cssW/cssH, never raw this.canvas.width/height in draw code', () => {
      // Backing-store dims (this.canvas.width/height) are DPR-scaled; CSS-px draw
      // code must use cssW/cssH. The only allowed canvas.width/height writes are in resize().
      const draws = src.replace(/private resize[\s\S]*?\n  }/m, ''); // strip the resize method
      expect(draws).not.toMatch(/this\.canvas\.width/);
      expect(draws).not.toMatch(/this\.canvas\.height/);
    });
    it('subscribes to the viewport bus', () => {
      expect(src).toMatch(/onViewportChange/);
    });
  });
}
