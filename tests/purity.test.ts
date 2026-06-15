import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SIM_DIR = join(__dirname, '..', 'src', 'sim');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const IMPORT_RE = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]\)?/g;

/** Allowed import specifiers for a file inside src/sim/**. */
function allowed(spec: string): boolean {
  // data/runtime is render/input/net/shell scope only — never readable from sim.
  // Must precede the data/* allow below so it isn't swept in.
  if (/data\/runtime/.test(spec)) return false;
  if (spec.startsWith('@dimforge/rapier2d-compat')) return true; // physics engine
  if (/(^|\/)core(\/|$)/.test(spec) && spec.startsWith('.')) return true; // ../core, ./core
  if (/(^|\/)data(\/|$)/.test(spec) && spec.startsWith('.')) return true; // ../data, ./data
  // sibling sim modules: relative paths that don't escape into core/data/render/etc.
  if (spec.startsWith('.') && !/render|audio|net|input|app|ui|three|peerjs/.test(spec)) return true;
  return false;
}

const BANNED = /three|peerjs|\/render\/|\/audio\/|\/net\/|\/input|\/app|\/ui\//;

describe('sim purity allowlist contract', () => {
  it('bans src/sim from importing the render-scoped data/runtime config', () => {
    // runtime.ts is render/input/net/shell scope only; the sim must never read it.
    expect(allowed('../data/runtime')).toBe(false);
    expect(allowed('./data/runtime')).toBe(false);
  });

  it('still allows legitimate sim data imports', () => {
    expect(allowed('../data/constants')).toBe(true);
    expect(allowed('../data/classes')).toBe(true);
    expect(allowed('../core/math')).toBe(true);
    expect(allowed('@dimforge/rapier2d-compat')).toBe(true);
    expect(allowed('./systems/movement')).toBe(true);
  });
});

describe('sim purity (static import guard)', () => {
  const files = walk(SIM_DIR);

  it('has files to check', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files.map((f) => [f.replace(SIM_DIR, 'src/sim'), f]))(
    '%s imports nothing from render/audio/net/input/three/peerjs',
    (_label, file) => {
      const src = readFileSync(file, 'utf8');
      const bad: string[] = [];
      for (const m of src.matchAll(IMPORT_RE)) {
        const spec = m[1];
        if (BANNED.test(spec) || !allowed(spec)) bad.push(spec);
      }
      expect(bad, `disallowed imports in ${file}: ${bad.join(', ')}`).toEqual([]);
    },
  );
});
