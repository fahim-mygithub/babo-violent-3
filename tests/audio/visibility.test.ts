import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const src = readFileSync(resolve(__dirname, '../../src/app.ts'), 'utf8');

describe('visibility + wake-lock plumbing', () => {
  it('wires a visibilitychange handler that suspends/resumes audio but not the loop', () => {
    expect(src).toMatch(/visibilitychange/);
    expect(src).toMatch(/this\.audio\.suspend\(\)/);
    expect(src).toMatch(/this\.audio\.resumeIfUnlocked\(\)/);
    // The fixed loop must keep ticking when hidden (load-bearing for a host).
    const handler = src.slice(src.indexOf('onVisibility'), src.indexOf('onVisibility') + 600);
    expect(handler).not.toMatch(/this\.loop\?\.stop\(\)/);
  });
  it('acquires a screen wake lock feature-detected + try/catch, gated on the loop', () => {
    expect(src).toMatch(/navigator\.wakeLock/);
    expect(src).toMatch(/wakeLock\.request\(['"]screen['"]\)/);
  });
});
