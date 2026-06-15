import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const mf = JSON.parse(
  readFileSync(resolve(__dirname, '../../public/manifest.webmanifest'), 'utf8'),
);

describe('S6.6 manifest', () => {
  it('is standalone, portrait-hint, relative-scoped', () => {
    expect(mf.display).toBe('standalone');
    expect(mf.orientation).toBe('portrait');
    expect(mf.start_url).toBe('./');
    expect(mf.scope).toBe('./');
  });
  it('declares 192 and 512 PNG icons', () => {
    const sizes = mf.icons.map((i: { sizes: string }) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
  });
});
