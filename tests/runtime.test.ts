import { describe, it, expect, beforeEach } from 'vitest';
import { RUNTIME, resetRuntime, type Tier } from '../src/data/runtime';

describe('RUNTIME config', () => {
  beforeEach(() => resetRuntime());

  it('defaults reproduce the desktop build', () => {
    expect(RUNTIME.tier).toBe('high');
    expect(RUNTIME.touch).toBe(false);
    expect(RUNTIME.projectileLance).toBe(false);
  });

  it('is a single mutable object (live reference)', () => {
    RUNTIME.touch = true;
    RUNTIME.tier = 'low';
    expect(RUNTIME.touch).toBe(true);
    expect(RUNTIME.tier).toBe('low');
  });

  it('resetRuntime restores desktop defaults', () => {
    RUNTIME.touch = true;
    RUNTIME.tier = 'mid' as Tier;
    RUNTIME.projectileLance = true;
    resetRuntime();
    expect(RUNTIME).toEqual({ tier: 'high', touch: false, projectileLance: false });
  });
});
