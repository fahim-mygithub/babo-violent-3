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
  if (spec.startsWith('@dimforge/rapier2d')) return true;       // physics engine
  if (/(^|\/)core(\/|$)/.test(spec) && spec.startsWith('.')) return true; // ../core, ./core
  if (/(^|\/)data(\/|$)/.test(spec) && spec.startsWith('.')) return true; // ../data, ./data
  // sibling sim modules: relative paths that don't escape into core/data/render/etc.
  if (spec.startsWith('.') && !/render|audio|net|input|app|ui|three|peerjs/.test(spec)) return true;
  return false;
}

const BANNED = /three|peerjs|\/render\/|\/audio\/|\/net\/|\/input|\/app|\/ui\//;

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
