import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const src = readFileSync(resolve(__dirname, '../../src/app.ts'), 'utf8');

describe('App touch camera wiring (source assertion)', () => {
  it('sets camDistScale to 1.25 in portrait touch and aimLeadScale to 0.35', () => {
    expect(src).toMatch(/aimLeadScale\s*=\s*this\.useTouch\s*\?\s*0\.35\s*:\s*1/);
    expect(src).toMatch(/camDistScale\s*=\s*\(this\.useTouch && [^)]*[Pp]ortrait[^)]*\)\s*\?\s*1\.25\s*:\s*1/);
    expect(src).toMatch(/onViewportChange/);
  });
});
