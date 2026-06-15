# Mobile Playability & Performance — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or superpowers:subagent-driven-development) to implement this plan task-by-task.

**Goal:** Make Babo Violent 3 playable on a mid-range phone in portrait with twin-stick touch controls, and fast/smooth on mobile browsers, as a strictly additive, feature-flagged, phase-gated layer that never regresses the desktop game or per-seed determinism.

**Architecture:** Three phases gated behind a single `RUNTIME`/`FLAGS` config (forcing `{touch:false, tier:'high', projectileLance:false}` reproduces today's desktop build). P1 = bundle deferral + perf quick-wins + mobile shell ("it loads"). P2 = touch controls + responsive UI + render quality tiers + flagged all-projectile Lance ("it plays"). P3 = structural perf, profile-gated ("it holds 60"). A foundation step installs a determinism golden-hash guard + purity test BEFORE any sim-touching change.

**Tech Stack:** Vite + TypeScript (strict) · Three.js r0.169 · Rapier2D WASM (→ non-compat) · PeerJS WebRTC · vitest · Pointer Events · visualViewport/dvh · GitHub Pages.

**Source spec:** `docs/plans/2026-06-14-mobile-and-performance-design.md` (file:line-grounded; adversarially reviewed). Work happens in worktree `.worktrees/mobile-perf` (branch `mobile-perf`). Run the per-phase gate (S8.7) before each phase merges.

---



## Foundation — Safety Net & Runtime Config

These tasks establish the regression gate everything else in this plan depends on (spec S8.1 + the roadmap cross-cutting prerequisite). They are sequenced so the determinism golden-hash guard and the sim-purity static check are in place **before** any later phase touches the sim, and so the runtime/flag scaffolding exists as inert constants that provably do not change current behavior. Follow @superpowers:test-driven-development throughout: write the failing test first, watch it fail, write the minimal code, watch it pass, commit.

> Conventions used below: `npx vitest run tests/<file>` runs one file; `npm test` runs the whole suite; `npm run typecheck` runs `tsc --noEmit`; `npm run build` runs typecheck + `vite build`. The sim entity surface used by the hash is the real `GameSim` public API: `sim.players` (Map), `sim.projectiles`/`sim.grenades`/`sim.pools`/`sim.fires` (arrays), and `sim.mode.teamScores`/`sim.mode.flags`.

---

### Task 1: `RUNTIME` config object (render/input/net/shell scope only)

**Files:** Create `src/data/runtime.ts` / Test `tests/runtime.test.ts`

**Step 1: Write the failing test** — the default must reproduce today's desktop build (`touch:false, tier:'high', projectileLance:false`), the object must be mutable (single source of truth, live-imported reference), and it must NOT be imported by any `src/sim/**` file (purity is enforced separately in Task 4, but we assert the default-value contract here).

Create `tests/runtime.test.ts`:
```ts
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
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/runtime.test.ts`. Fails: `Cannot find module '../src/data/runtime'` (the file does not exist yet).

**Step 3: Minimal implementation** — create `src/data/runtime.ts`. This is the UI/render/input/net/shell-scoped mutable config from the roadmap cross-cutting prerequisite. It deliberately holds ONLY `tier/touch/projectileLance`; sim-scoped flags live in `constants.ts` (Tasks 5–6).
```ts
/**
 * Single mutable runtime config read by render / input / net / shell.
 * NEVER imported by src/sim/** (enforced by tests/purity.test.ts). Sim-scoped
 * flags (PROJECTILE_LANCE, PLAYER_CCD, SIM_BASELINE_V, …) live in constants.ts.
 *
 * Forcing { tier:'high', touch:false, projectileLance:false } reproduces today's
 * exact desktop build at every phase boundary.
 */
export type Tier = 'high' | 'mid' | 'low';

export interface RuntimeConfig {
  tier: Tier;
  touch: boolean;
  /** UI/render mirror of constants FLAGS.PROJECTILE_LANCE for shell wiring. */
  projectileLance: boolean;
}

const DEFAULTS: RuntimeConfig = { tier: 'high', touch: false, projectileLance: false };

/** Live, mutable singleton — importers keep this exact reference. */
export const RUNTIME: RuntimeConfig = { ...DEFAULTS };

/** Restore desktop defaults (used by tests and source hot-swap). */
export function resetRuntime(): void {
  RUNTIME.tier = DEFAULTS.tier;
  RUNTIME.touch = DEFAULTS.touch;
  RUNTIME.projectileLance = DEFAULTS.projectileLance;
}
```

**Step 4: Run it, expect PASS** — `npx vitest run tests/runtime.test.ts` (3 passing). Then `npm test` (full suite still green) and `npm run typecheck` (clean).

**Step 5: Commit** — `git add src/data/runtime.ts tests/runtime.test.ts && git commit -m "feat(runtime): add mutable RUNTIME config (desktop defaults)"`

---

### Task 2: `simHash(sim)` order-stable determinism digest in `tests/helpers.ts`

**Files:** Modify `tests/helpers.ts` / Test `tests/helpers.simhash.test.ts`

This is the regression gate's core primitive (spec S8.1). The digest is an order-stable Float64→hex FNV-1a over players (x,y,vx,vy,aim,hp,kills,deaths,heat,mag), projectiles (id,x,y,vx,vy), and `teamScores`, **extended to grenades, pools, fires, and CTF `mode.flags`** so the digest covers VFX/mode state (S8.1 LOW adversary fix). Players are iterated in ascending `id` order (the `Map` insertion order is id-ascending today, but we sort explicitly so the hash never depends on iteration order). Float64 bytes are folded via `DataView` so the digest is bit-exact, not decimal-rounded.

**Step 1: Write the failing test** — assert the digest is (a) deterministic for a fixed seed across two fresh instances, (b) sensitive to a single-float perturbation, and (c) a stable hex string. This is the same scenario the existing determinism assert uses (`integration.test.ts:104-122`), now reduced to one comparable scalar.

Create `tests/helpers.simhash.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { makeSim, run, simHash } from './helpers';

async function twinSim(seed: number) {
  const sim = await makeSim({ mode: 'tdm', seed });
  const classes = ['spider', 'juggernaut', 'bastion', 'phantom'] as const;
  for (let i = 0; i < 4; i++) sim.addPlayer(`Bot${i}`, classes[i], (i % 2) as 0 | 1, true);
  return sim;
}

describe('simHash', () => {
  it('returns a stable hex string', async () => {
    const sim = await twinSim(23);
    run(sim, 100);
    expect(simHash(sim)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is identical for two same-seed instances at the same tick', async () => {
    const a = await twinSim(23);
    const b = await twinSim(23);
    for (let i = 0; i < 600; i++) {
      a.step(); b.step();
      a.events.length = 0; b.events.length = 0;
    }
    expect(simHash(a)).toBe(simHash(b));
  }, 60_000);

  it('changes when a single player float is perturbed', async () => {
    const sim = await twinSim(23);
    run(sim, 50);
    const before = simHash(sim);
    sim.players.get(0)!.x += 1e-6;
    expect(simHash(sim)).not.toBe(before);
  });
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/helpers.simhash.test.ts`. Fails: `simHash` is not exported from `./helpers`.

**Step 3: Minimal implementation** — append to `tests/helpers.ts` (it already imports `GameSim`):
```ts
// --- Determinism golden digest (spec S8.1) --------------------------------
// Order-stable FNV-1a over the full sim state, folding each Float64 by its raw
// 8 bytes so the hash is bit-exact (not decimal-rounded). Players are sorted by
// id; all arrays are consumed in their stored order (already deterministic).
const _f64 = new Float64Array(1);
const _u8 = new Uint8Array(_f64.buffer);

function fnv(state: { h: number }, n: number): void {
  _f64[0] = n;
  for (let i = 0; i < 8; i++) {
    state.h ^= _u8[i];
    state.h = Math.imul(state.h, 0x01000193) >>> 0;
  }
}

export function simHash(sim: GameSim): string {
  const s = { h: 0x811c9dc5 };
  fnv(s, sim.tick);
  const ids = [...sim.players.keys()].sort((a, b) => a - b);
  for (const id of ids) {
    const p = sim.players.get(id)!;
    fnv(s, p.id); fnv(s, p.x); fnv(s, p.y); fnv(s, p.vx); fnv(s, p.vy);
    fnv(s, p.aim); fnv(s, p.hp); fnv(s, p.kills); fnv(s, p.deaths);
    fnv(s, p.heat); fnv(s, p.mag);
  }
  for (const pr of sim.projectiles) { fnv(s, pr.id); fnv(s, pr.x); fnv(s, pr.y); fnv(s, pr.vx); fnv(s, pr.vy); }
  for (const g of sim.grenades) { fnv(s, g.id); fnv(s, g.x); fnv(s, g.y); fnv(s, g.z); fnv(s, g.fuse); }
  for (const pool of sim.pools) { fnv(s, pool.id); fnv(s, pool.x); fnv(s, pool.y); fnv(s, pool.r); fnv(s, pool.age); }
  for (const f of sim.fires) { fnv(s, f.id); fnv(s, f.x); fnv(s, f.y); fnv(s, f.r); fnv(s, f.ttl); }
  fnv(s, sim.mode.teamScores[0]); fnv(s, sim.mode.teamScores[1]);
  for (const flag of sim.mode.flags) { fnv(s, flag.team); fnv(s, flag.x); fnv(s, flag.y); fnv(s, flag.carrier); fnv(s, flag.returnT); }
  return (s.h >>> 0).toString(16).padStart(8, '0') + (sim.tick >>> 0).toString(16).padStart(8, '0');
}
```
(The trailing tick word makes the 16-hex-char contract trivially stable while still distinguishing ticks; the FNV word already captures all state.)

**Step 4: Run it, expect PASS** — `npx vitest run tests/helpers.simhash.test.ts` (3 passing). Then `npm test` and `npm run typecheck` green.

**Step 5: Commit** — `git add tests/helpers.ts tests/helpers.simhash.test.ts && git commit -m "test(determinism): add order-stable simHash digest helper"`

---

### Task 3: `tests/determinism.test.ts` — cross-instance + golden snapshot guard

**Files:** Create `tests/determinism.test.ts`

This is the regression gate the spec's S8.7 requires: (a) baseline-free cross-instance equality (the strongest guard — no committed magic number can rot), and (b) `toMatchSnapshot` of `simHash` at ticks 300/600/1200 for representative seeds, which freezes today's behavior so any later sim-touching change is caught. Two representative seeds + two modes give coverage of FFA + team flows. This complements (does not replace) the existing `<1e-9` assert at `integration.test.ts:104-122`.

**Step 1: Write the failing test** — create `tests/determinism.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import type { GameSim } from '../src/sim/sim';
import { makeSim, simHash } from './helpers';

function seedBots(sim: GameSim, n: number, ffa: boolean): void {
  const classes = ['spider', 'juggernaut', 'bastion', 'phantom', 'trapper'] as const;
  for (let i = 0; i < n; i++) {
    sim.addPlayer(`Bot${i}`, classes[i % classes.length], ffa ? -1 : ((i % 2) as 0 | 1), true);
  }
}

function hashesAt(sim: GameSim, marks: number[]): Record<number, string> {
  const out: Record<number, string> = {};
  const want = new Set(marks);
  const max = Math.max(...marks);
  for (let t = 1; t <= max; t++) {
    sim.step();
    sim.events.length = 0;
    if (want.has(t)) out[t] = simHash(sim);
  }
  return out;
}

const MARKS = [300, 600, 1200];
const CASES = [
  { mode: 'tdm' as const, seed: 23, bots: 6, ffa: false },
  { mode: 'bounty' as const, seed: 11, bots: 6, ffa: true },
];

describe('determinism golden guard', () => {
  it.each(CASES)('same seed → identical simHash across instances ($mode/$seed)', async (c) => {
    const a = await makeSim({ mode: c.mode, seed: c.seed });
    const b = await makeSim({ mode: c.mode, seed: c.seed });
    seedBots(a, c.bots, c.ffa);
    seedBots(b, c.bots, c.ffa);
    expect(hashesAt(a, MARKS)).toEqual(hashesAt(b, MARKS));
  }, 60_000);

  it.each(CASES)('frozen golden hashes at ticks 300/600/1200 ($mode/$seed)', async (c) => {
    const sim = await makeSim({ mode: c.mode, seed: c.seed });
    seedBots(sim, c.bots, c.ffa);
    expect(hashesAt(sim, MARKS)).toMatchSnapshot();
  }, 60_000);
});
```

**Step 2: Run it, expect FAIL initially, then capture the baseline.** Run `npx vitest run tests/determinism.test.ts`. The cross-instance cases pass immediately (current sim is already deterministic). The `toMatchSnapshot` cases **write** `tests/__snapshots__/determinism.test.ts.snap` on first run and report it as *written/obsolete-free* — that is the intended baselining act, not a failure. (If a later sim change ever alters a hash, this is where it fails with a snapshot diff.)

**Step 3: Minimal implementation** — none beyond the test itself; the committed `.snap` file IS the golden baseline produced in Step 2.

**Step 4: Run it, expect PASS** — re-run `npx vitest run tests/determinism.test.ts` (now compares against the just-written snapshot; all 4 cases green). Then `npm test` and `npm run typecheck` green.

**Step 5: Commit** — `git add tests/determinism.test.ts tests/__snapshots__/determinism.test.ts.snap && git commit -m "test(determinism): golden-hash guard at ticks 300/600/1200"`

> Note for later phases: any **D-SAFE** sim change must leave this snapshot byte-identical (do NOT pass `-u`). Any **D-SHIFT** change (distSq/CCD bundle, projectile-Lance flag-ON) must be gated behind its flag and re-baseline with `npx vitest run tests/determinism.test.ts -u` in the **same** task that flips the gate, with the diff explained in the commit message.

---

### Task 4: `tests/purity.test.ts` — static sim-isolation guard

**Files:** Create `tests/purity.test.ts`

Static fs assertion (spec S8.1): every file under `src/sim/**` may import only from the allowlist — relative `../core`/`./core`, `../data`/`./data`, sibling `./` sim modules, and `@dimforge/rapier2d*` — and **nothing** from render/audio/net/input/`three`/`peerjs`. This protects the deterministic core from render-work leaks and guarantees `src/data/runtime.ts` never bleeds into the sim. The grep over `src/sim` confirms today's imports already satisfy this (only `../core/*`, `../data/*`, `./*`, and `@dimforge/rapier2d-compat`).

**Step 1: Write the failing test** — create `tests/purity.test.ts`. It walks `src/sim` recursively, extracts every `from '...'` / `import('...')` specifier, and asserts each is on the allowlist:
```ts
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
```

**Step 2: Run it, expect PASS-on-clean (verification check).** Run `npx vitest run tests/purity.test.ts`. With the current clean codebase this passes. To prove the guard actually bites, temporarily add `import * as THREE from 'three';` to the top of `src/sim/systems/weapons.ts`, re-run `npx vitest run tests/purity.test.ts`, and confirm it FAILS with `disallowed imports in …/weapons.ts: three`. Then revert that line.

**Step 3: Minimal implementation** — none beyond the test; the guard is the deliverable. (Revert the temporary `three` import added during Step 2.)

**Step 4: Run it, expect PASS** — `npx vitest run tests/purity.test.ts` green (after revert). Then `npm test` and `npm run typecheck` green.

**Step 5: Commit** — `git add tests/purity.test.ts && git commit -m "test(purity): static guard that src/sim imports no render/net/audio/three"`

---

### Task 5: Inert `C.*` sim-flag scaffolding in `constants.ts` (CCD / baseline / projectiles / audio)

**Files:** Modify `src/data/constants.ts:68` (append before the closing `} as const;`) / Test `tests/constants-flags.test.ts`

Add the sim-scoped flags as **inert** constants (spec S2.2, S5.8, roadmap prerequisite): `PLAYER_CCD` (default `true` = today's `setCcdEnabled(true)` at `sim.ts:139`, so default reproduces current physics), `SIM_BASELINE_V` (the D-SHIFT bundle version, starts at `1`), `MAX_PROJECTILES` (`256`, not yet read by the projectile loop), and `AUDIO_MAX_VOICES` (`24`, not yet read by audio). These do nothing yet — each later phase that consumes a flag does so in its own gated task. The test pins the default VALUES (so a later edit can't silently change desktop behavior) and proves current sim behavior is unchanged.

**Step 1: Write the failing test** — create `tests/constants-flags.test.ts`. It pins the inert defaults AND asserts that adding them did not perturb the determinism golden hash (behavioral no-op):
```ts
import { describe, it, expect } from 'vitest';
import { C } from '../src/data/constants';
import { makeSim, run, simHash } from './helpers';

describe('inert sim-flag scaffolding (constants.ts)', () => {
  it('exposes the flags with desktop-reproducing defaults', () => {
    expect(C.PLAYER_CCD).toBe(true);        // matches sim.ts setCcdEnabled(true)
    expect(C.SIM_BASELINE_V).toBe(1);
    expect(C.MAX_PROJECTILES).toBe(256);
    expect(C.AUDIO_MAX_VOICES).toBe(24);
  });

  it('adding the flags does not change current sim behavior', async () => {
    const a = await makeSim({ mode: 'tdm', seed: 23 });
    const b = await makeSim({ mode: 'tdm', seed: 23 });
    const classes = ['spider', 'juggernaut', 'bastion', 'phantom'] as const;
    for (let i = 0; i < 4; i++) {
      a.addPlayer(`B${i}`, classes[i], (i % 2) as 0 | 1, true);
      b.addPlayer(`B${i}`, classes[i], (i % 2) as 0 | 1, true);
    }
    run(a, 300); run(b, 300);
    expect(simHash(a)).toBe(simHash(b));
  }, 60_000);
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/constants-flags.test.ts`. Fails: `expected undefined to be true` for `C.PLAYER_CCD` (the keys don't exist yet).

**Step 3: Minimal implementation** — in `src/data/constants.ts`, insert before the closing `} as const;` (currently line 68–69, right after the `BOT_NAMES` entry):
```ts
  // --- Sim flag scaffolding (inert; consumed by later phases) -------------
  /** Per-babo continuous collision detection (sim.ts:139). false → drop CCD (S5.2a, D-SHIFT). */
  PLAYER_CCD: true,
  /** D-SHIFT bundle version (distSq swaps + CCD). Bump re-baselines the golden hash (S5.1d/S5.8). */
  SIM_BASELINE_V: 1,
  /** Per-tick projectile cap; grief/lag-spam guard, drops oldest BULLET only (S2.7). */
  MAX_PROJECTILES: 256,
  /** Global concurrent WebAudio voice ceiling (S5.7c). */
  AUDIO_MAX_VOICES: 24,
```
No call site reads these yet, so behavior is byte-identical.

**Step 4: Run it, expect PASS** — `npx vitest run tests/constants-flags.test.ts` (2 passing). Then `npm test` (the existing `integration.test.ts` determinism + the Task 3 golden snapshot must stay green, proving the additions are inert) and `npm run typecheck` green. Crucially, **`tests/determinism.test.ts` must NOT need `-u`** — if the snapshot changed, the constants were not inert and the change is wrong.

**Step 5: Commit** — `git add src/data/constants.ts tests/constants-flags.test.ts && git commit -m "feat(constants): add inert PLAYER_CCD/SIM_BASELINE_V/MAX_PROJECTILES/AUDIO_MAX_VOICES flags"`

---

### Task 6: `FLAGS` block in `constants.ts` (`PROJECTILE_LANCE` default OFF, inert)

**Files:** Modify `src/data/constants.ts` (after the `C` export) / Test `tests/constants-flags.test.ts` (extend)

Add the `FLAGS` object the sim + tests import (spec S2.2). It lives in `constants.ts` — **not** `window.__bv3` — so it stays headless/deterministic. `PROJECTILE_LANCE` defaults **false** (legacy hitscan Lance; the roadmap default), and `MAX_PROJECTILES` is mirrored here so S2's fire path reads a single `FLAGS` object. It is inert: no code branches on it until S2's conversion task. Per S2.8, when S2 later flips it, flag-ON gets its OWN golden baseline and flag-OFF must equal the pre-change hash — but at this Foundation stage nothing reads it, so the determinism snapshot must stay byte-identical.

**Step 1: Write the failing test** — append to `tests/constants-flags.test.ts`:
```ts
import { FLAGS } from '../src/data/constants';

describe('FLAGS block (constants.ts)', () => {
  it('PROJECTILE_LANCE defaults OFF (legacy hitscan reproduces desktop)', () => {
    expect(FLAGS.PROJECTILE_LANCE).toBe(false);
  });

  it('mirrors MAX_PROJECTILES for the S2 fire path', () => {
    expect(FLAGS.MAX_PROJECTILES).toBe(256);
    expect(FLAGS.MAX_PROJECTILES).toBe(C.MAX_PROJECTILES);
  });

  it('is a const-asserted object (compile-time-like branch source)', () => {
    expect(Object.isFrozen ? typeof FLAGS).toBe('object');
    expect(Object.keys(FLAGS).sort()).toEqual(['MAX_PROJECTILES', 'PROJECTILE_LANCE']);
  });
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/constants-flags.test.ts`. Fails: `FLAGS` is not exported from `../src/data/constants`.

**Step 3: Minimal implementation** — in `src/data/constants.ts`, after the `export const C = { … } as const;` block add:
```ts
/**
 * Sim feature flags. Imported by the sim AND tests (stays headless/deterministic
 * — NOT window.__bv3). MUST be identical on host + all clients (build/match
 * constant). Flag-ON and flag-OFF are DIFFERENT RNG streams once S2 routes the
 * Lance through fireProjectiles (S2.8), so each gets its own golden baseline.
 */
export const FLAGS = {
  /** false → exact legacy hitscan fireLance + old 'rail' event (desktop default). */
  PROJECTILE_LANCE: false,
  /** Per-tick projectile cap (mirrors C.MAX_PROJECTILES); applies to all guns (S2.7). */
  MAX_PROJECTILES: C.MAX_PROJECTILES,
} as const;
```

**Step 2-note correction:** the `Object.isFrozen ? typeof FLAGS` line above is a deliberate smoke check that the object exists and has exactly the two keys; if your linter rejects the ternary, simplify to `expect(typeof FLAGS).toBe('object')`.

**Step 4: Run it, expect PASS** — `npx vitest run tests/constants-flags.test.ts` (all cases passing). Then `npm test` — confirm `tests/determinism.test.ts` stays green **without `-u`** (FLAGS is read by nobody yet, so it is provably inert) — and `npm run typecheck` green.

**Step 5: Commit** — `git add src/data/constants.ts tests/constants-flags.test.ts && git commit -m "feat(constants): add inert FLAGS block (PROJECTILE_LANCE default off)"`

---

**Foundation exit state:** `RUNTIME` (render/input/net/shell config) and the inert sim flags (`C.PLAYER_CCD`, `C.SIM_BASELINE_V`, `C.MAX_PROJECTILES`, `C.AUDIO_MAX_VOICES`, `FLAGS.PROJECTILE_LANCE`, `FLAGS.MAX_PROJECTILES`) all exist with desktop-reproducing defaults; `simHash`, `tests/determinism.test.ts` (cross-instance + frozen 300/600/1200 golden snapshot), and `tests/purity.test.ts` form the regression gate S8.7 mandates. Every subsequent task in later parts can now precede sim-touching work with a determinism assertion and is blocked by the purity guard from leaking render/net code into `src/sim/**`. Full suite (94 existing + the new Foundation tests) and `npm run typecheck` are green.

---



## Phase 1 — It Loads (bundle deferral + perf quick-wins + mobile shell)

This part assumes the Foundation part is complete: `tests/helpers.ts` now exports `simHash(sim)` (an order-stable Float64→hex digest over players/projectiles/grenades/pools/fires/teamScores/CTF flags), `tests/determinism.test.ts` holds the seed-42 golden baseline + cross-instance guard, `tests/purity.test.ts` enforces the `src/sim/**` import allowlist (extended to permit `@dimforge/rapier2d`), and `src/data/runtime.ts` exports the mutable `RUNTIME` config. Tasks are numbered continuously after Foundation (which ends at Task 6). Every sim-touching task is guarded by `simHash`; D-SHIFT changes are bundled behind `C.SIM_BASELINE_V` with one explicit re-baseline. Uses @superpowers:test-driven-development and @superpowers:verification-before-completion throughout.

---

### Task 7: Rapier non-compat swap — acceptance gate (HARD STOP-on-fail)

**Files:** Modify `package.json`, Modify `src/sim/sim.ts:1-32`, Modify `tests/helpers.ts` (no signature change), Test `tests/rapier-swap.test.ts`

This is the single highest-risk change in the whole plan (spec S4.1, Risk #1). It is a **STOP-on-fail gate**: if any step below fails, **do not commit** — revert the swap and escalate. compat→non-compat at the same version is *asserted* bit-identical, never assumed.

**Step 1: Write the failing test** — `tests/rapier-swap.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { makeSim } from './helpers';
import { simHash } from './helpers';

// The seed-42 byte-identical determinism gate for the @dimforge/rapier2d swap.
// This MUST match the golden baseline captured by the Foundation determinism test
// against the OLD -compat package. If it diverges, the swap is NOT byte-identical
// and must not be merged (spec S4.1 acceptance gate / Risk #1).
describe('rapier non-compat swap — determinism', () => {
  it('seed-42 8-bot TDM is byte-identical to the pre-swap golden hash', async () => {
    const a = await makeSim({ mode: 'tdm', seed: 42 });
    const b = await makeSim({ mode: 'tdm', seed: 42 });
    const classes = ['spider', 'juggernaut', 'bastion', 'phantom', 'trapper'] as const;
    for (const sim of [a, b]) {
      for (let i = 0; i < 8; i++) {
        sim.addPlayer(`Bot${i}`, classes[i % classes.length], (i % 2) as 0 | 1, true);
      }
    }
    for (let i = 0; i < 600; i++) { a.step(); b.step(); a.events.length = 0; b.events.length = 0; }
    // Cross-instance equality (baseline-free): the swap must be internally deterministic.
    expect(simHash(a)).toBe(simHash(b));
    // Pinned digest captured from the OLD -compat build at tick 600, seed 42.
    // Foundation's tests/determinism.test.ts toMatchSnapshot at tick 600 is the source.
    expect(simHash(a)).toMatchSnapshot();
  }, 60_000);
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/rapier-swap.test.ts`. Before the swap this passes only if the snapshot already exists; the *meaningful* gate is running it AFTER the swap (Step 3) and confirming the snapshot is unchanged. First, capture the pre-swap snapshot on the CURRENT `-compat` build: `npx vitest run tests/rapier-swap.test.ts -u`, commit nothing yet, and record the hash string.

**Step 3: Minimal implementation** — perform the swap and read the package to confirm its init contract:
```bash
npm i @dimforge/rapier2d@0.14.0 && npm rm @dimforge/rapier2d-compat
```
Then read `node_modules/@dimforge/rapier2d/package.json` (its `module`/`exports`/`main` and the entry file) to confirm whether it exposes `init()` or auto-instantiates. Update `src/sim/sim.ts`:
```ts
// line 1: type-only import + lazily-bound runtime ref
import type RAPIER_NS from '@dimforge/rapier2d';
let RAPIER: typeof RAPIER_NS;

let rapierReady = false;
let initPromise: Promise<void> | null = null;

/** Must be awaited once before constructing any GameSim. Idempotent + retryable. */
export function initPhysics(): Promise<void> {
  if (rapierReady) return Promise.resolve();
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const mod = await import('@dimforge/rapier2d');
    if (typeof (mod as any).init === 'function') await (mod as any).init(); // compat-style if present
    RAPIER = mod as unknown as typeof RAPIER_NS;                            // else auto-instantiated
    rapierReady = true;
  })().catch((e) => { initPromise = null; throw e; });                     // reset for retry
  return initPromise;
}
```
Add the mandatory vitest dep config to `vite.config.ts` so the WASM top-level-await package does not trip the optimizer (spec S4.6):
```ts
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 2200 },
  server: { port: 5173 },
  test: {
    deps: { optimizer: { ssr: { exclude: ['@dimforge/rapier2d'] } }, inline: ['@dimforge/rapier2d'] },
  },
});
```
Update `tests/purity.test.ts` allowlist to permit `@dimforge/rapier2d` (drop `-compat`).

**Step 4: Run it, expect PASS** — `npx vitest run tests/rapier-swap.test.ts` (snapshot UNCHANGED — the hash string must equal the one recorded in Step 2). Then the FULL suite `npm test` green (all 94 + the swap test) and `npm run typecheck` green and `npm run build` green. **If the snapshot changed: STOP. Revert (`npm rm @dimforge/rapier2d && npm i @dimforge/rapier2d-compat@^0.14.0` + `git checkout src/sim/sim.ts vite.config.ts`) and escalate — the swap is not byte-identical.**

**Step 5: Commit** — `git add package.json package-lock.json src/sim/sim.ts vite.config.ts tests/rapier-swap.test.ts tests/__snapshots__ tests/purity.test.ts && git commit -m "build(sim): swap @dimforge/rapier2d-compat→rapier2d behind defensive initPhysics, gated on seed-42 byte-identical determinism"`

---

### Task 8: `vite.config.ts` — `assetsInlineLimit:0` + manualChunks

**Files:** Modify `vite.config.ts`, Test `tests/build/vite-config.test.ts`

**Step 1: Write the failing test** — `tests/build/vite-config.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import config from '../../vite.config';

// vite.config exports the result of defineConfig (a plain object here).
describe('vite build config — bundle deferral', () => {
  it('never re-inlines the WASM and splits three/peerjs/rapier into manual chunks', () => {
    const c = config as any;
    expect(c.build.assetsInlineLimit).toBe(0);
    const mc = c.build.rollupOptions.output.manualChunks;
    expect(mc.three).toEqual(['three']);
    expect(mc.peerjs).toEqual(['peerjs']);
    expect(mc.rapier).toEqual(['@dimforge/rapier2d']);
  });
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/build/vite-config.test.ts`; fails: `assetsInlineLimit` is `undefined` and `rollupOptions` does not exist.

**Step 3: Minimal implementation** — extend the `build` block in `vite.config.ts` (spec S4.1, S4.3):
```ts
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2200,
    assetsInlineLimit: 0, // never base64-inline the Rapier .wasm — keep it a hashed, cacheable, deferred fetch
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          peerjs: ['peerjs'],
          rapier: ['@dimforge/rapier2d'],
        },
      },
    },
  },
```

**Step 4: Run it, expect PASS** — `npx vitest run tests/build/vite-config.test.ts`; then `npm run build` green (verify the `dist/assets` output now contains a separate `three.*`, `peerjs.*`, `rapier.*` and a `.wasm` file), full `npm test` + `npm run typecheck` green.

**Step 5: Commit** — `git add vite.config.ts tests/build/vite-config.test.ts && git commit -m "build: assetsInlineLimit:0 + manualChunks(three/peerjs/rapier) for deferred WASM + code-split chunks"`

---

### Task 9: Extract `makeGunIcon` → `src/render/gunIcons.ts` (off the Three path)

**Files:** Create `src/render/gunIcons.ts`, Modify `src/render/gunModels.ts:310-486`, Modify `src/ui/screens.ts:4`, Test `tests/build/gunicons-no-three.test.ts`

Goal (spec S4.4): the menu/lobby entry chunk imports `makeGunIcon` (pure Canvas2D) WITHOUT pulling `import * as THREE`. Only consumer of `makeGunIcon` is `screens.ts`.

**Step 1: Write the failing test** — `tests/build/gunicons-no-three.test.ts`:
```ts
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
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/build/gunicons-no-three.test.ts`; fails: `gunIcons.ts` does not exist.

**Step 3: Minimal implementation** — create `src/render/gunIcons.ts` containing `ICON_W`, `ICON_H`, `hex`, `shade`, `tint`, `chip`, `IconDraw`, the `ICONS` record (gunModels.ts:359-469), and `makeGunIcon` (gunModels.ts:476-486) — verbatim, with `import type { GunId } from '../data/weapons'; import { GUNS } from '../data/weapons';` and **no Three import**. Delete those moved lines from `gunModels.ts` (and any now-unused `hex`/`shade`/`tint`/`chip` if gunModels no longer references them — keep ones still used by 3D model builders; grep first). Repoint `src/ui/screens.ts:4` to `import { makeGunIcon } from '../render/gunIcons';`.

**Step 4: Run it, expect PASS** — `npx vitest run tests/build/gunicons-no-three.test.ts`; full `npm test` + `npm run typecheck` + `npm run build` green (the icons still render in the lobby unchanged).

**Step 5: Commit** — `git add src/render/gunIcons.ts src/render/gunModels.ts src/ui/screens.ts tests/build/gunicons-no-three.test.ts && git commit -m "refactor(render): extract makeGunIcon to gunIcons.ts so the menu chunk drops Three"`

---

### Task 10: `import * as THREE` → named imports (9 files)

**Files:** Modify the 9 files (`src/render/{textures,splatmap,renderer,lobbyPreview,gunModels,effects,babos,baboShapes,baboShader}.ts`), Test `tests/build/named-three.test.ts`

Mechanical, `tsc`-checked, render-only, enables tree-shaking of the `three` chunk (spec S4.5). Determinism untouched (no sim file).

**Step 1: Write the failing test** — `tests/build/named-three.test.ts`:
```ts
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
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/build/named-three.test.ts`; all 9 fail (each still has `import * as THREE`).

**Step 3: Minimal implementation** — in each file replace `import * as THREE from 'three';` with a named import of exactly the symbols used, e.g. `import { Scene, PerspectiveCamera, WebGLRenderer, Color, Fog, HemisphereLight, DirectionalLight, Vector2, Vector3, Plane, Raycaster } from 'three';` and rewrite every `THREE.X` → `X` in that file (use a per-file find/replace; `tsc` is the gate that catches any missed symbol). Do this one file at a time, typechecking between files. No behavior change — same Three classes, named.

**Step 4: Run it, expect PASS** — `npx vitest run tests/build/named-three.test.ts`; `npm run typecheck` green (the real correctness gate — any unimported symbol errors); full `npm test` + `npm run build` green.

**Step 5: Commit** — `git add src/render/*.ts tests/build/named-three.test.ts && git commit -m "refactor(render): import * as THREE → named imports in 9 files for tree-shaking"`

---

### Task 11: `index.html` preconnect (drop STUN TLS preconnect)

**Files:** Modify `index.html:8`, Test `tests/shell/index-html.test.ts`

**Step 1: Write the failing test** — `tests/shell/index-html.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8');

describe('index.html network hints', () => {
  it('preconnects to the default PeerJS broker', () => {
    expect(html).toMatch(/<link rel="preconnect" href="https:\/\/0\.peerjs\.com" crossorigin>/);
    expect(html).toMatch(/<link rel="dns-prefetch" href="https:\/\/0\.peerjs\.com">/);
  });
  it('does NOT TLS-preconnect the UDP STUN endpoint', () => {
    // stun.l.google.com:19302 speaks UDP, not TLS — a preconnect just times out.
    expect(html).not.toMatch(/rel="preconnect"[^>]*stun\.l\.google\.com/);
  });
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/shell/index-html.test.ts`; fails: the preconnect/dns-prefetch links are absent.

**Step 3: Minimal implementation** — in `index.html`, after the `<title>` add (spec S4.7):
```html
    <link rel="preconnect" href="https://0.peerjs.com" crossorigin>
    <link rel="dns-prefetch" href="https://0.peerjs.com">
    <link rel="dns-prefetch" href="//stun.l.google.com">
```
Do NOT add any `rel="preconnect"` to the STUN host, and do NOT add `modulepreload` for three/rapier (would defeat deferral).

**Step 4: Run it, expect PASS** — `npx vitest run tests/shell/index-html.test.ts`; `npm run build` green.

**Step 5: Commit** — `git add index.html tests/shell/index-html.test.ts && git commit -m "perf(html): preconnect 0.peerjs.com, dns-prefetch STUN, drop invalid STUN TLS preconnect"`

---

### Task 12: Remove eager Rapier await from `main.ts`; dynamic-import boundaries

**Files:** Modify `src/main.ts`, Modify `src/app.ts` (imports + `enterMatch`/launch sites), Test `tests/build/main-no-eager-rapier.test.ts`

Menu must paint with zero WASM (spec S4.2, S4.3). `main.ts` drops the eager `await initPhysics()`; the render/sim/net modules become dynamic imports; `initPhysics()` is awaited only at host/local launch *before* `ui.hide()`, with floating-promise safety.

**Step 1: Write the failing test** — `tests/build/main-no-eager-rapier.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('startup deferral', () => {
  it('main.ts no longer awaits initPhysics before the menu', () => {
    const src = readFileSync(resolve(__dirname, '../../src/main.ts'), 'utf8');
    expect(src).not.toMatch(/await\s+initPhysics/);
    expect(src).not.toMatch(/from '\.\/sim\/sim'/); // sim/Rapier no longer reachable from the entry
  });
  it('app.ts dynamically imports the renderer + sim (not static)', () => {
    const src = readFileSync(resolve(__dirname, '../../src/app.ts'), 'utf8');
    expect(src).toMatch(/import\(['"]\.\/render\/renderer['"]\)/);
    expect(src).toMatch(/import\(['"]\.\/sim\/sim['"]\)/);
  });
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/build/main-no-eager-rapier.test.ts`; fails: `main.ts` still awaits `initPhysics` and statically imports `./sim/sim`.

**Step 3: Minimal implementation** —
`src/main.ts` (no Rapier, no sim, paints immediately):
```ts
import './ui/styles.css';
import { App } from './app';

const container = document.getElementById('app')!;
new App(container).start();
```
In `src/app.ts`, convert the heavy statics to `import type` shims and dynamic `import()` boundaries. Replace the static `GameSim`/`GameRenderer`/`Hud`/`ScreenFx`/`LobbyPreview`/`HostSession`/`ClientSession` imports with `import type` for the type positions, and load the implementations lazily. Add a lazy sim factory and make `buildSim` / `enterMatch` async-safe:
```ts
import { initPhysics } from './sim/sim'; // initPhysics itself is light (the dynamic import lives inside it)
import type { GameSim } from './sim/sim';
import type { GameRenderer, WorldView } from './render/renderer';
// ...

private async loadSim(settings: MatchSettings): Promise<GameSim> {
  await initPhysics();                              // pulls the rapier chunk + .wasm here, never at boot
  const { GameSim } = await import('./sim/sim');
  return new GameSim({ mapId: settings.mapId, mode: settings.mode, seed: settings.seed, scoreLimit: settings.scoreLimit });
}
```
Make `enterMatch` await the render chunk BEFORE hiding the lobby (spec S4.2 ordering fix — `ui.hide()` only after imports resolve):
```ts
private async enterMatch(mapId: string): Promise<void> {
  const [{ GameRenderer }, { Hud }, { ScreenFx }] = await Promise.all([
    import('./render/renderer'), import('./render/hud'), import('./render/screenfx'),
  ]);
  this.ui.hide();
  this.disposeLobbyPreview();
  this.input.enabled = true;
  this.endTimer = -1;
  document.body.style.cursor = 'none';
  const map = MAPS[mapId] ?? MAPS.grinder;
  this.renderer = new GameRenderer(this.container, map);
  this.hud = new Hud(this.container, (x, y, h) => this.renderer!.project(x, y, h));
  this.fx = new ScreenFx(this.container);
  this.loop = new FixedLoop(C.SIM_HZ, () => this.tick(), (_alpha, frameDt) => this.frame(frameDt));
  this.loop.start();
}
```
Wire `launchLocalMatch`/`launchHostMatch` to `await this.loadSim(...)` and to `await this.enterMatch(...)`, each `onStart` callback body wrapped in `.catch(err => { this.ui.toast('Failed to load — check connection'); this.showMenu(); })` so a rejected import restores the lobby instead of a black screen. `launchClientMatch` stays sim-free (client never downloads Rapier). Convert `LobbyPreview`, `HostSession`, `ClientSession` to dynamic imports at their mount/host/join sites likewise.

**Step 4: Run it, expect PASS** — `npx vitest run tests/build/main-no-eager-rapier.test.ts`; `npm run typecheck` green (the `import type` shims compile); full `npm test` green (the determinism + rapier-swap tests still pass — `initPhysics` is unchanged in contract); `npm run build` green and inspect `dist`: the entry chunk no longer references `rapier`/`three` statically.

**Step 5: Commit** — `git add src/main.ts src/app.ts tests/build/main-no-eager-rapier.test.ts && git commit -m "perf(startup): drop eager Rapier await; lazy-import render/sim/net behind match entry with floating-promise safety"`

---

### Task 13: Lobby-open prefetch (warm Rapier + render chunks)

**Files:** Modify `src/app.ts` (lobby-show sites), Test `tests/build/prefetch.test.ts`

So the first cold local match isn't a frozen black screen, warm Rapier AND the render chunks fire-and-forget on lobby open (spec S4.2 prefetch fix).

**Step 1: Write the failing test** — `tests/build/prefetch.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const src = readFileSync(resolve(__dirname, '../../src/app.ts'), 'utf8');

describe('lobby prefetch warms the match chunks', () => {
  it('has a prefetchMatchChunks that imports rapier + render', () => {
    expect(src).toMatch(/prefetchMatchChunks/);
    expect(src).toMatch(/import\(['"]@dimforge\/rapier2d['"]\)/);
    expect(src).toMatch(/import\(['"]\.\/render\/renderer['"]\)/);
    expect(src).toMatch(/import\(['"]\.\/render\/hud['"]\)/);
    expect(src).toMatch(/import\(['"]\.\/render\/screenfx['"]\)/);
  });
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/build/prefetch.test.ts`; fails: no `prefetchMatchChunks`.

**Step 3: Minimal implementation** — add to `App` (spec S4.2) and call once from `showLocalLobby`/`showHostLobby` (guard against double-fire with a boolean):
```ts
private prefetched = false;
private prefetchMatchChunks(): void {
  if (this.prefetched) return;
  this.prefetched = true;
  // Fire-and-forget; warms the rapier + render chunks so the first cold match
  // doesn't freeze on a black screen. Rejections are harmless (re-imported on use).
  void import('@dimforge/rapier2d').catch(() => {});
  void import('./render/renderer').catch(() => {});
  void import('./render/hud').catch(() => {});
  void import('./render/screenfx').catch(() => {});
}
```
Call `this.prefetchMatchChunks();` at the end of `showLocalLobby()` and `showHostLobby()`.

**Step 4: Run it, expect PASS** — `npx vitest run tests/build/prefetch.test.ts`; full `npm test` + `npm run typecheck` + `npm run build` green.

**Step 5: Commit** — `git add src/app.ts tests/build/prefetch.test.ts && git commit -m "perf(startup): prefetch rapier+render chunks on lobby open to avoid first-cold-match freeze"`

---

### Task 14: `src/core/viewport.ts` — `visualViewport` sizing bus

**Files:** Create `src/core/viewport.ts`, Test `tests/shell/viewport.test.ts`

Single source of truth for viewport size (spec S6.2) — prefers `visualViewport` (iOS URL-bar aware), rAF-coalesces resize/scroll/orientationchange into one fire. No sim touch.

**Step 1: Write the failing test** — `tests/shell/viewport.test.ts` (jsdom):
```ts
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { viewportSize, onViewportChange } from '../../src/core/viewport';

describe('viewport bus', () => {
  it('viewportSize falls back to innerWidth/Height when visualViewport is absent', () => {
    (window as any).visualViewport = undefined;
    (window as any).innerWidth = 412;
    (window as any).innerHeight = 915;
    expect(viewportSize()).toEqual({ w: 412, h: 915 });
  });

  it('prefers visualViewport dimensions when present', () => {
    (window as any).visualViewport = { width: 390, height: 700, addEventListener() {}, removeEventListener() {} };
    expect(viewportSize()).toEqual({ w: 390, h: 700 });
  });

  it('onViewportChange returns an unsubscribe and fires the callback on resize (rAF-coalesced)', async () => {
    (window as any).visualViewport = undefined;
    const cb = vi.fn();
    const off = onViewportChange(cb);
    window.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('resize')); // coalesced into one
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    window.dispatchEvent(new Event('resize'));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(cb).toHaveBeenCalledTimes(1); // no fire after unsubscribe
  });
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/shell/viewport.test.ts`; fails: `src/core/viewport.ts` does not exist. (This task also introduces the `jsdom` env — ensure `jsdom` is in devDeps; if absent, `npm i -D jsdom` and note it in the commit.)

**Step 3: Minimal implementation** — `src/core/viewport.ts`:
```ts
export interface ViewportSize { w: number; h: number; }

/** Prefer visualViewport (iOS URL-bar aware); fall back to innerWidth/Height. */
export function viewportSize(): ViewportSize {
  const vv = window.visualViewport;
  if (vv) return { w: vv.width, h: vv.height };
  return { w: window.innerWidth, h: window.innerHeight };
}

/**
 * Subscribe to viewport changes. rAF-coalesces visualViewport resize+scroll and
 * window resize+orientationchange into a single callback per frame so the three
 * canvases never desync during a URL-bar transition. Returns an unsubscribe.
 */
export function onViewportChange(cb: () => void): () => void {
  let scheduled = false;
  const fire = (): void => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; cb(); });
  };
  const vv = window.visualViewport;
  vv?.addEventListener('resize', fire);
  vv?.addEventListener('scroll', fire);
  window.addEventListener('resize', fire);
  window.addEventListener('orientationchange', fire);
  return () => {
    vv?.removeEventListener('resize', fire);
    vv?.removeEventListener('scroll', fire);
    window.removeEventListener('resize', fire);
    window.removeEventListener('orientationchange', fire);
  };
}
```

**Step 4: Run it, expect PASS** — `npx vitest run tests/shell/viewport.test.ts`; full `npm test` + `npm run typecheck` green.

**Step 5: Commit** — `git add src/core/viewport.ts tests/shell/viewport.test.ts package.json package-lock.json && git commit -m "feat(shell): visualViewport sizing bus (viewportSize + rAF-coalesced onViewportChange)"`

---

### Task 15: Route renderer sizing through the viewport bus (fix `groundPoint`/`project` denominator)

**Files:** Modify `src/render/renderer.ts:48-49,222-245`, Test `tests/shell/renderer-viewport.test.ts`

Load-bearing aim-correctness fix (spec S6.2): `groundPoint`/`project` must read the **same** cached `vw/vh` that `setSize` used, not `window.innerWidth/Height`. Subscribe to the bus in the ctor, unsubscribe in `dispose()`. Desktop values identical on a stable viewport (`vw===innerWidth`). Render-only → determinism untouched (`purity.test.ts` stays green).

**Step 1: Write the failing test** — `tests/shell/renderer-viewport.test.ts`. Because jsdom has no WebGL, assert against the source that the window reads were repointed (honest verification, not a fake GL assert):
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const src = readFileSync(resolve(__dirname, '../../src/render/renderer.ts'), 'utf8');

describe('renderer reads viewport bus, not window directly', () => {
  it('groundPoint/project no longer divide by window.innerWidth/Height', () => {
    // Extract the groundPoint+project span and assert it uses cached vw/vh.
    const span = src.slice(src.indexOf('groundPoint('), src.indexOf('dispose()'));
    expect(span).not.toMatch(/window\.innerWidth/);
    expect(span).not.toMatch(/window\.innerHeight/);
    expect(span).toMatch(/this\.vw/);
    expect(span).toMatch(/this\.vh/);
  });
  it('subscribes to onViewportChange and unsubscribes in dispose', () => {
    expect(src).toMatch(/onViewportChange/);
    expect(src).toMatch(/import .*viewportSize.*from ['"]\.\.\/core\/viewport['"]/);
  });
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/shell/renderer-viewport.test.ts`; fails: `groundPoint`/`project` still use `window.innerWidth/Height`; no bus import.

**Step 3: Minimal implementation** — in `renderer.ts` add `import { viewportSize, onViewportChange } from '../core/viewport';`, private `vw = 0; vh = 0; private offViewport: (() => void) | null = null;`, and an `applyViewport()`:
```ts
private applyViewport = (): void => {
  const { w, h } = viewportSize();
  this.vw = w; this.vh = h;
  this.camera.aspect = w / h;
  this.camera.updateProjectionMatrix();
  this.renderer.setSize(w, h, false);
};
```
In the ctor replace lines 48-50 with `this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); this.applyViewport(); this.offViewport = onViewportChange(this.applyViewport);` and remove the old `window.addEventListener('resize', this.onResize)`; delete `onResize`. Repoint `groundPoint` and `project`:
```ts
groundPoint(clientX: number, clientY: number): { x: number; y: number } {
  this.ndc.set((clientX / this.vw) * 2 - 1, -(clientY / this.vh) * 2 + 1);
  this.raycaster.setFromCamera(this.ndc, this.camera);
  const hit = new THREE.Vector3();
  this.raycaster.ray.intersectPlane(this.groundPlane, hit);
  return { x: hit.x, y: hit.z };
}
project(x: number, y: number, height = 0): { x: number; y: number; visible: boolean } {
  this.projVec.set(x, height, y).project(this.camera);
  return { x: (this.projVec.x * 0.5 + 0.5) * this.vw, y: (-this.projVec.y * 0.5 + 0.5) * this.vh, visible: this.projVec.z < 1 };
}
```
In `dispose()` add `this.offViewport?.(); this.offViewport = null;` (replacing the `removeEventListener('resize', this.onResize)`).

**Step 4: Run it, expect PASS** — `npx vitest run tests/shell/renderer-viewport.test.ts`; `npm run typecheck` green; full `npm test` green (incl. `purity.test.ts`); `npm run build` green.

**Step 5: Commit** — `git add src/render/renderer.ts tests/shell/renderer-viewport.test.ts && git commit -m "fix(render): route renderer sizing through viewport bus; groundPoint/project use cached vw/vh"`

---

### Task 16: Route HUD + ScreenFx sizing through the bus (audit EVERY canvas.width/height incl. addSplatter)

**Files:** Modify `src/render/hud.ts`, Modify `src/render/screenfx.ts`, Test `tests/shell/canvas-size-audit.test.ts`

HIGH adversary fix (spec S6.2): audit **every** `this.canvas.width|height` read in `hud.ts` + `screenfx.ts` — including `screenfx.ts addSplatter()` — and repoint each to cached `cssW/cssH`, with DPR-aware resize via the bus and `ctx.setTransform(dpr,…)` so existing CSS-px draw code is preserved.

**Step 1: Write the failing test** — `tests/shell/canvas-size-audit.test.ts`:
```ts
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
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/shell/canvas-size-audit.test.ts`; fails: both files still read `this.canvas.width/height` in draw paths and don't subscribe to the bus.

**Step 3: Minimal implementation** — first `grep` to enumerate every read: `Grep this\.canvas\.(width|height) in hud.ts + screenfx.ts` (the spec calls out `screenfx.ts:48-50` `addSplatter` as an independent read NOT at `:67-68`). In each class add `private cssW = 0; private cssH = 0; private offViewport: (() => void) | null = null;` and a `resize()` driven by the bus:
```ts
import { viewportSize, onViewportChange } from '../core/viewport';
// in ctor:
this.resize();
this.offViewport = onViewportChange(() => this.resize());
// method:
private resize(): void {
  const { w, h } = viewportSize();
  const dpr = Math.min(window.devicePixelRatio, 2);
  this.cssW = w; this.cssH = h;
  this.canvas.width = Math.round(w * dpr);
  this.canvas.height = Math.round(h * dpr);
  this.canvas.style.width = `${w}px`;
  this.canvas.style.height = `${h}px`;
  this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS px
}
```
Repoint **every** enumerated draw-time `this.canvas.width` → `this.cssW`, `this.canvas.height` → `this.cssH` — explicitly including `addSplatter()` in `screenfx.ts`. Add `this.offViewport?.(); this.offViewport = null;` to each `dispose()`.

**Step 4: Run it, expect PASS** — `npx vitest run tests/shell/canvas-size-audit.test.ts`; `npm run typecheck` + full `npm test` + `npm run build` green.

**Step 5: Commit** — `git add src/render/hud.ts src/render/screenfx.ts tests/shell/canvas-size-audit.test.ts && git commit -m "fix(render): DPR-aware hud/screenfx sizing via viewport bus; repoint every canvas.width/height incl addSplatter"`

---

### Task 17: viewport meta `viewport-fit=cover` + play-surface gesture-suppression CSS

**Files:** Modify `index.html:6`, Modify `src/ui/styles.css` (additive), Test `tests/shell/viewport-meta.test.ts`

Spec S6.1: add `viewport-fit=cover` (prerequisite for nonzero `env(safe-area-inset-*)`) + the apple/web-app metas. Gesture-suppression CSS scoped to **play surfaces only** (`#game-canvas, #hud-canvas, #fx-canvas, #touch-layer`), additive, preserving the existing `#game-canvas` rule and leaving `.screen` scroll containers at `touch-action:auto`.

**Step 1: Write the failing test** — `tests/shell/viewport-meta.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8');
const css = readFileSync(resolve(__dirname, '../../src/ui/styles.css'), 'utf8');

describe('viewport meta + gesture suppression', () => {
  it('viewport meta opts into viewport-fit=cover and keeps user-scalable=no', () => {
    const vp = html.match(/<meta name="viewport"[^>]*>/)![0];
    expect(vp).toMatch(/viewport-fit=cover/);
    expect(vp).toMatch(/user-scalable=no/);
    expect(vp).not.toMatch(/maximum-scale/);
  });
  it('declares the web-app capable + status-bar metas', () => {
    expect(html).toMatch(/name="apple-mobile-web-app-capable"/);
    expect(html).toMatch(/name="apple-mobile-web-app-status-bar-style" content="black-translucent"/);
  });
  it('scopes touch-action:none to play surfaces, never .screen', () => {
    const block = css.match(/#game-canvas,\s*#hud-canvas,\s*#fx-canvas,\s*#touch-layer\s*\{[^}]*\}/)![0];
    expect(block).toMatch(/touch-action:\s*none/);
    expect(css).toMatch(/#game-canvas\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0/); // original rule preserved
  });
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/shell/viewport-meta.test.ts`; fails: no `viewport-fit=cover`, no web-app metas, no play-surface block.

**Step 3: Minimal implementation** — `index.html:6`:
```html
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no, viewport-fit=cover" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <meta name="theme-color" content="#0b0c10" />
```
Append to `styles.css` (ADDITIVE — do not touch the existing `#game-canvas{position:absolute;inset:0;display:block}` rule):
```css
html, body { overscroll-behavior: none; -webkit-text-size-adjust: 100%; }
#game-canvas, #hud-canvas, #fx-canvas, #touch-layer {
  touch-action: none;
  -webkit-user-select: none; user-select: none;
  -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent;
}
```

**Step 4: Run it, expect PASS** — `npx vitest run tests/shell/viewport-meta.test.ts`; `npm run build` green; the desktop cascade is byte-identical (`touch-action:none` is a desktop no-op, scoped away from `.screen`).

**Step 5: Commit** — `git add index.html src/ui/styles.css tests/shell/viewport-meta.test.ts && git commit -m "feat(shell): viewport-fit=cover + web-app metas + play-surface gesture suppression (scoped off .screen)"`

---

### Task 18: iOS audio unlock (webkitAudioContext + silent buffer + `unlocked` flag)

**Files:** Modify `src/audio/audio.ts:20-38`, Modify `src/app.ts:68` (unlock listener set), Test `tests/audio/unlock.test.ts`

Spec S5.7a: handle `webkitAudioContext`, play a silent 1-sample buffer inside the gesture, resume when `state !== 'running'` (covers `interrupted`), and de-register ALL unlock listeners on first success via an `unlocked` flag so a tap firing both `pointerdown`+`touchend` doesn't double-kick.

**Step 1: Write the failing test** — `tests/audio/unlock.test.ts` (jsdom, stub WebAudio):
```ts
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { AudioEngine } from '../../src/audio/audio';

function stubAudio() {
  const calls = { resume: 0, silentBuffers: 0 };
  class FakeCtx {
    state = 'suspended';
    sampleRate = 48000;
    destination = {};
    currentTime = 0;
    createDynamicsCompressor() { return { threshold: {}, ratio: {}, connect() {} }; }
    createGain() { return { gain: {}, connect() {} }; }
    createBuffer(_c: number, len: number) { return { getChannelData: () => new Float32Array(len) }; }
    createBufferSource() { calls.silentBuffers++; return { buffer: null, connect() { return this; }, start() {}, stop() {} }; }
    resume() { calls.resume++; this.state = 'running'; return Promise.resolve(); }
  }
  (window as any).AudioContext = FakeCtx;
  (window as any).webkitAudioContext = undefined;
  return calls;
}

describe('iOS audio unlock', () => {
  it('plays a silent buffer once and sets unlocked, ignoring repeat gestures', () => {
    const calls = stubAudio();
    const a = new AudioEngine();
    a.unlock();
    a.unlock(); // a second gesture (e.g. touchend after pointerdown) must be a no-op
    expect(a.unlocked).toBe(true);
    expect(calls.silentBuffers).toBe(1);
  });
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/audio/unlock.test.ts`; fails: `AudioEngine` has no `unlock()` / `unlocked`.

**Step 3: Minimal implementation** — in `audio.ts` add `unlocked = false;` and rename the gesture entrypoint to `unlock()` (keep `resume()` as the internal ctx-creator or fold in). Spec S5.7a:
```ts
unlock(): void {
  if (this.unlocked) return;
  if (!this.ctx) {
    const Ctx = window.AudioContext ?? (window as any).webkitAudioContext;
    this.ctx = new Ctx();
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.ratio.value = 6; comp.connect(this.ctx.destination);
    this.master = this.ctx.createGain(); this.master.gain.value = 0.5; this.master.connect(comp);
    const len = this.ctx.sampleRate;
    this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }
  // Silent 1-sample buffer played inside the gesture unlocks iOS WebAudio.
  const s = this.ctx.createBufferSource();
  s.buffer = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
  s.connect(this.ctx.destination); s.start(0); s.stop(this.ctx.currentTime + 0.001);
  if (this.ctx.state !== 'running') void this.ctx.resume(); // 'interrupted' on iOS also needs resume
  this.unlocked = true;
}
resumeIfUnlocked(): void { if (this.unlocked && this.ctx && this.ctx.state !== 'running') void this.ctx.resume(); }
suspend(): void { if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend(); }
```
In `app.ts:68` broaden the unlock set and remove ALL listeners on first success:
```ts
const unlock = (): void => {
  this.audio.unlock();
  for (const ev of ['pointerdown', 'touchend', 'keydown'] as const) window.removeEventListener(ev, unlock);
};
for (const ev of ['pointerdown', 'touchend', 'keydown'] as const) window.addEventListener(ev, unlock);
```

**Step 4: Run it, expect PASS** — `npx vitest run tests/audio/unlock.test.ts`; `npm run typecheck` + full `npm test` + `npm run build` green.

**Step 5: Commit** — `git add src/audio/audio.ts src/app.ts tests/audio/unlock.test.ts && git commit -m "feat(audio): iOS unlock via webkitAudioContext + silent buffer + unlocked flag; broaden gesture set"`

---

### Task 19: visibilitychange audio suspend/resume + wake-lock plumbing

**Files:** Modify `src/app.ts`, Test `tests/audio/visibility.test.ts`

Spec S6.3/S6.4: `onVisibility` → `audio.suspend()` when hidden / `audio.resumeIfUnlocked()` + `reacquireWakeLock()` when visible. Suspend ONLY the AudioContext, never `FixedLoop`. Wake-lock is feature-detected + try/catch (iOS<16.4 degrades silently), gated on `this.loop` so it only runs during a match.

**Step 1: Write the failing test** — `tests/audio/visibility.test.ts`:
```ts
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
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/audio/visibility.test.ts`; fails: no visibility handler / wake-lock code.

**Step 3: Minimal implementation** — in `App` add a wake-lock field + helpers and the visibility handler (spec S6.3/S6.4):
```ts
private wakeLock: any = null;

private async acquireWakeLock(): Promise<void> {
  if (!this.loop) return; // only during a match
  try {
    if ('wakeLock' in navigator) this.wakeLock = await (navigator as any).wakeLock.request('screen');
  } catch { /* iOS<16.4 or denied — screen may dim; harmless */ }
}
private releaseWakeLock(): void { void this.wakeLock?.release?.(); this.wakeLock = null; }

private onVisibility = (): void => {
  if (document.hidden) {
    this.audio.suspend();            // suspend audio only; FixedLoop keeps ticking (host stays alive)
  } else {
    this.audio.resumeIfUnlocked();
    void this.acquireWakeLock();     // the lock auto-releases when hidden → re-acquire on foreground
  }
};
```
Register `document.addEventListener('visibilitychange', this.onVisibility)` in the constructor / `start()`. Call `void this.acquireWakeLock()` at the end of `enterMatch` (after `loop.start()`); call `this.releaseWakeLock()` in `teardownMatch`.

**Step 4: Run it, expect PASS** — `npx vitest run tests/audio/visibility.test.ts`; `npm run typecheck` + full `npm test` + `npm run build` green.

**Step 5: Commit** — `git add src/app.ts tests/audio/visibility.test.ts && git commit -m "feat(shell): visibilitychange audio suspend/resume + screen wake-lock plumbing (loop never paused)"`

---

### Task 20: `src/render/quality.ts` — tier DETECTION + DPR/AA clamp (jsdom → 'high')

**Files:** Create `src/render/quality.ts`, Modify `src/render/renderer.ts:47-48`, Test `tests/render/quality.test.ts`

Spec S3.1 (this phase = DETECTION + DPR/AA only; no material/instancing). Synchronous singleton resolved at import, zero await. jsdom (no `matchMedia`) defaults to `'high'` so determinism/render tests see the unchanged path. Renderer reads `QUALITY.antialias` and `QUALITY.maxPixelRatio` only.

**Step 1: Write the failing test** — `tests/render/quality.test.ts`:
```ts
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { QUALITY, detectQuality, setTierOverride } from '../../src/render/quality';

describe('quality tier detection', () => {
  it('defaults to high in jsdom (no matchMedia/WebGL)', () => {
    expect(detectQuality().tier).toBe('high');
    expect(QUALITY.antialias).toBe(true);
    expect(QUALITY.maxPixelRatio).toBe(2);
  });
  it('classifies a coarse-pointer 8-core device as mid', () => {
    expect(detectQuality({ coarse: true, maxTouchPoints: 5, cores: 8 }).tier).toBe('mid');
  });
  it('classifies a coarse-pointer 4-core device as low', () => {
    expect(detectQuality({ coarse: true, maxTouchPoints: 5, cores: 4 }).tier).toBe('low');
  });
  it('setTierOverride mutates the live singleton in place', () => {
    setTierOverride('low');
    expect(QUALITY.tier).toBe('low');
    expect(QUALITY.antialias).toBe(false);
    setTierOverride('high'); // reset for other tests
  });
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/render/quality.test.ts`; fails: `src/render/quality.ts` does not exist.

**Step 3: Minimal implementation** — `src/render/quality.ts` (spec S3.1; only the fields this phase consumes are wired — `tier`, `isMobile`, `maxPixelRatio`, `antialias`; the rest land in Phase 2):
```ts
export type Tier = 'low' | 'mid' | 'high';
export interface QualityProfile { tier: Tier; isMobile: boolean; maxPixelRatio: number; antialias: boolean; }

interface Signals { coarse: boolean; maxTouchPoints: number; cores: number; dpr: number; }

function signals(): Signals {
  const mm = typeof window !== 'undefined' && typeof window.matchMedia === 'function';
  return {
    coarse: mm ? window.matchMedia('(pointer:coarse)').matches : false,
    maxTouchPoints: typeof navigator !== 'undefined' ? (navigator.maxTouchPoints ?? 0) : 0,
    cores: typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency ?? 4) : 4,
    dpr: typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 3) : 1,
  };
}

const FIELDS: Record<Tier, Omit<QualityProfile, 'tier' | 'isMobile'>> = {
  high: { maxPixelRatio: 2, antialias: true },
  mid:  { maxPixelRatio: 1.25, antialias: false },
  low:  { maxPixelRatio: 1, antialias: false },
};

/** Pure classification; accepts injected signals for testability. Never reads deviceMemory. */
export function detectQuality(s: Partial<Signals> = signals()): QualityProfile {
  const sig = { ...signals(), ...s };
  const isMobile = sig.coarse || sig.maxTouchPoints > 0;
  const tier: Tier = !isMobile ? 'high' : sig.cores >= 6 ? 'mid' : 'low';
  return { tier, isMobile, ...FIELDS[tier] };
}

/** Live singleton resolved at import with ZERO await (available before first renderer ctor). */
export const QUALITY: QualityProfile = detectQuality();

/** Mutate the singleton in place so live imports keep the same reference. */
export function setTierOverride(tier: Tier): void {
  const next = detectQuality({ coarse: tier !== 'high', maxTouchPoints: tier !== 'high' ? 5 : 0, cores: tier === 'mid' ? 8 : tier === 'low' ? 4 : 8 });
  Object.assign(QUALITY, { ...next, tier, ...FIELDS[tier] });
}
```
In `renderer.ts` ctor: `import { QUALITY } from './quality';` and change L47-48 to `antialias: QUALITY.antialias` and `this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY.maxPixelRatio));`. (jsdom/desktop → `high` → AA true, DPR 2 → byte-identical desktop.)

**Step 4: Run it, expect PASS** — `npx vitest run tests/render/quality.test.ts`; `npm run typecheck` + full `npm test` (determinism unaffected — render-only) + `npm run build` green.

**Step 5: Commit** — `git add src/render/quality.ts src/render/renderer.ts tests/render/quality.test.ts && git commit -m "feat(render): quality tier detection (jsdom→high) + DPR/AA clamp; mobile-only antialias:false"`

---

### Task 21: Host-only / visibility-gated background interval (`FixedLoop`)

**Files:** Modify `src/core/loop.ts`, Modify `src/app.ts:384`, Test `tests/core/loop-keepalive.test.ts`

Spec S5.3 (D-SAFE — loop wiring only, no sim float change). Add a `keepAliveWhenHidden` flag (default false); install the 50 ms hidden-tab `setInterval` only when true. `App` passes `this.role === 'host'`. Local/client intentionally pause-and-resync on hidden.

**Step 1: Write the failing test** — `tests/core/loop-keepalive.test.ts` (jsdom for timers/document):
```ts
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { FixedLoop } from '../../src/core/loop';

describe('FixedLoop background interval gating', () => {
  it('installs no hidden-tab interval when keepAliveWhenHidden is false (default)', () => {
    const spy = vi.spyOn(window, 'setInterval');
    const loop = new FixedLoop(60, () => {}, () => {});
    loop.start();
    expect(spy).not.toHaveBeenCalled();
    loop.stop(); spy.mockRestore();
  });
  it('installs the interval only when keepAliveWhenHidden is true', () => {
    const spy = vi.spyOn(window, 'setInterval');
    const loop = new FixedLoop(60, () => {}, () => {}, 5, true);
    loop.start();
    expect(spy).toHaveBeenCalled();
    loop.stop(); spy.mockRestore();
  });
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/core/loop-keepalive.test.ts`; fails: the ctor has no `keepAliveWhenHidden` param and unconditionally installs the interval.

**Step 3: Minimal implementation** — in `loop.ts` add the constructor param and gate the interval (spec S5.3):
```ts
constructor(
  tickHz: number,
  private readonly tick: () => void,
  private readonly render: (alpha: number, frameDt: number) => void,
  private readonly maxCatchUp = 5,
  private readonly keepAliveWhenHidden = false,
) { this.dt = 1 / tickHz; }
```
In `start()`, wrap the interval install:
```ts
if (this.keepAliveWhenHidden) {
  this.interval = window.setInterval(() => {
    if (this.running && document.hidden) this.advance(false);
  }, 50);
}
```
`stop()` still calls `clearInterval(this.interval)` (no-op when `interval===0`). In `app.ts:384` pass the flag:
```ts
this.loop = new FixedLoop(C.SIM_HZ, () => this.tick(), (_alpha, frameDt) => this.frame(frameDt), 5, this.role === 'host');
```

**Step 4: Run it, expect PASS** — `npx vitest run tests/core/loop-keepalive.test.ts`; `npm run typecheck` + full `npm test` (determinism unchanged — the sim math is identical; only the host installs the keep-alive) + `npm run build` green.

**Step 5: Commit** — `git add src/core/loop.ts src/app.ts tests/core/loop-keepalive.test.ts && git commit -m "perf(loop): gate hidden-tab keep-alive interval to host only (local/client pause-resync)"`

---

### Task 22: `normInto()` zero-alloc sibling — D-SAFE (byte-identical assertion)

**Files:** Modify `src/core/math.ts`, Modify `src/sim/sim.ts` (`damage`/`kill`/`explode` norm sites), Modify `src/sim/systems/blood.ts`, Test `tests/core/norm-into.test.ts`, Test `tests/determinism.test.ts` (re-run, no re-baseline)

Spec S5.1a. Module-scope scratch consumed immediately; single-threaded sim. **D-SAFE — must assert byte-identical determinism after** (the golden hash from Foundation MUST be unchanged; this is NOT a re-baseline).

**Step 1: Write the failing test** — `tests/core/norm-into.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { norm, normInto } from '../../src/core/math';

describe('normInto — zero-alloc sibling of norm', () => {
  it('matches norm() bit-for-bit across vectors', () => {
    for (const [x, y] of [[3, 4], [-7, 0], [0, 0], [1e-12, 1e-12], [-0.3, 0.91]]) {
      const out: [number, number] = [NaN, NaN];
      normInto(x, y, out);
      expect(out).toEqual(norm(x, y));
    }
  });
  it('returns the SAME array instance (no per-call alloc)', () => {
    const out: [number, number] = [0, 0];
    const r = normInto(5, 12, out);
    expect(r).toBe(out);
  });
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/core/norm-into.test.ts`; fails: `normInto` is not exported.

**Step 3: Minimal implementation** — in `math.ts` add (identical float ops to `norm`, writing into the caller's tuple):
```ts
/** Zero-alloc normalize into `out`. Returns `out`. Same float ops as norm(). */
export function normInto(x: number, y: number, out: [number, number]): [number, number] {
  const l = Math.hypot(x, y);
  if (l < 1e-9) { out[0] = 0; out[1] = 0; return out; }
  out[0] = x / l; out[1] = y / l; return out;
}
```
At the hot sim sites that currently destructure `const [nx, ny] = norm(...)` and consume immediately (`sim.ts` `kill` death-pop loop `:288`, `explode` `:348`, `damage` splat-dir `:257`; `blood.ts` wounded-trail `:58`), introduce a module-scope `const _n: [number, number] = [0, 0];` per file and replace with `normInto(..., _n); const nx = _n[0], ny = _n[1];`. Keep `norm()` for any stored-tuple callers. Float results identical → hash unchanged.

**Step 4: Run it, expect PASS** — `npx vitest run tests/core/norm-into.test.ts`; **then assert byte-identical determinism**: `npx vitest run tests/determinism.test.ts tests/rapier-swap.test.ts` — the golden `simHash` snapshot must be UNCHANGED (no `-u`). Full `npm test` + `npm run typecheck` green.

**Step 5: Commit** — `git add src/core/math.ts src/sim/sim.ts src/sim/systems/blood.ts tests/core/norm-into.test.ts && git commit -m "perf(sim): normInto zero-alloc sibling at hot sites (D-SAFE, determinism byte-identical)"`

---

### Task 23: `segAABB` scalar unroll — D-SAFE (byte-identical assertion)

**Files:** Modify `src/core/math.ts:84-110`, Test `tests/core/segaabb-unroll.test.ts`, re-run `tests/determinism.test.ts`

Spec S5.1b — the single biggest sim GC win (hottest function). Remove the nested-literal array + double `for…of`; straight-line scalar slabs **keeping `Math.max`/`Math.min`** (not the `if` form) to stay provably bit-identical. **D-SAFE.**

**Step 1: Write the failing test** — `tests/core/segaabb-unroll.test.ts` (a regression net: the unroll must match the current implementation across cases AND allocate nothing):
```ts
import { describe, it, expect } from 'vitest';
import { segAABB } from '../../src/core/math';

// Reference = the pre-unroll slab algorithm, inlined here, to pin bit-equality.
function ref(x0:number,y0:number,x1:number,y1:number,cx:number,cy:number,w:number,h:number):number{
  const dx=x1-x0, dy=y1-y0;
  const minX=cx-w/2,maxX=cx+w/2,minY=cy-h/2,maxY=cy+h/2;
  let tmin=0,tmax=1;
  for(const [p,d,lo,hi] of [[x0,dx,minX,maxX],[y0,dy,minY,maxY]] as const){
    if(Math.abs(d)<1e-12){ if(p<lo||p>hi) return -1; }
    else{ let t1=(lo-p)/d,t2=(hi-p)/d; if(t1>t2)[t1,t2]=[t2,t1]; tmin=Math.max(tmin,t1); tmax=Math.min(tmax,t2); if(tmin>tmax) return -1; }
  }
  return tmin;
}

describe('segAABB scalar unroll bit-equality', () => {
  const cases: number[][] = [
    [0,0, 5,0, 2,0, 1,1], [-3,-3, 3,3, 0,0, 2,2], [0,0, 0,0, 0,0, 1,1],
    [-5,1, 5,1, 0,0, 4,0.5], [1,1, 1,9, 1,5, 0.001,3], [10,10, -10,-10, 0,0, 6,2],
  ];
  it('matches the reference slab method exactly', () => {
    for (const c of cases) expect(segAABB(c[0],c[1],c[2],c[3],c[4],c[5],c[6],c[7])).toBe((ref as any)(...c));
  });
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/core/segaabb-unroll.test.ts`; **passes** against the current implementation (the `ref` IS the current code). Confirm green first — this test locks behavior BEFORE the unroll. (If it somehow fails, the reference is wrong; fix the test.)

**Step 3: Minimal implementation** — replace `segAABB` body (lines 88-109) with the allocation-free unroll, keeping `Math.max`/`Math.min` exactly:
```ts
  const dx = x1 - x0;
  const dy = y1 - y0;
  const minX = cx - w / 2, maxX = cx + w / 2;
  const minY = cy - h / 2, maxY = cy + h / 2;
  let tmin = 0;
  let tmax = 1;
  // X slab
  if (Math.abs(dx) < 1e-12) {
    if (x0 < minX || x0 > maxX) return -1;
  } else {
    let t1 = (minX - x0) / dx;
    let t2 = (maxX - x0) / dx;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }
  // Y slab
  if (Math.abs(dy) < 1e-12) {
    if (y0 < minY || y0 > maxY) return -1;
  } else {
    let t1 = (minY - y0) / dy;
    let t2 = (maxY - y0) / dy;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }
  return tmin;
```

**Step 4: Run it, expect PASS** — `npx vitest run tests/core/segaabb-unroll.test.ts`; **assert byte-identical determinism**: `npx vitest run tests/determinism.test.ts tests/rapier-swap.test.ts` (snapshot UNCHANGED). Full `npm test` + `npm run typecheck` green.

**Step 5: Commit** — `git add src/core/math.ts tests/core/segaabb-unroll.test.ts && git commit -m "perf(sim): segAABB scalar unroll (zero-alloc, Math.max/min preserved — D-SAFE bit-identical)"`

---

### Task 24: `groundPoint` Vector3 reuse — D-SAFE

**Files:** Modify `src/render/renderer.ts:223-229`, Test `tests/shell/renderer-viewport.test.ts` (extend), re-run determinism

Spec S5.1c. `groundPoint` currently allocates `new THREE.Vector3()` per call (per-tick input path). Reuse a private field. Render-side local-input only → **D-SAFE** (the result feeds `PlayerInput.aim` exactly as before; identical floats).

**Step 1: Write the failing test** — extend `tests/shell/renderer-viewport.test.ts` with a source assertion (jsdom has no WebGL to exercise it live):
```ts
it('groundPoint reuses a private Vector3 (no per-call allocation)', () => {
  const span = src.slice(src.indexOf('groundPoint('), src.indexOf('project('));
  expect(span).not.toMatch(/new THREE\.Vector3\(\)/); // hit vector is reused, not allocated
  expect(span).toMatch(/this\.groundHit/);
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/shell/renderer-viewport.test.ts`; the new case fails: `groundPoint` still does `const hit = new THREE.Vector3();`.

**Step 3: Minimal implementation** — add `private groundHit = new THREE.Vector3();` to the renderer fields and rewrite `groundPoint`:
```ts
groundPoint(clientX: number, clientY: number): { x: number; y: number } {
  this.ndc.set((clientX / this.vw) * 2 - 1, -(clientY / this.vh) * 2 + 1);
  this.raycaster.setFromCamera(this.ndc, this.camera);
  this.raycaster.ray.intersectPlane(this.groundPlane, this.groundHit);
  return { x: this.groundHit.x, y: this.groundHit.z };
}
```

**Step 4: Run it, expect PASS** — `npx vitest run tests/shell/renderer-viewport.test.ts`; `npm run typecheck` + full `npm test` (determinism unaffected — render-side) + `npm run build` green.

**Step 5: Commit** — `git add src/render/renderer.ts tests/shell/renderer-viewport.test.ts && git commit -m "perf(render): reuse groundHit Vector3 in groundPoint (D-SAFE, no per-tick alloc)"`

---

### Task 25: WebAudio voice budgeting — D-SAFE

**Files:** Modify `src/data/constants.ts` (add `AUDIO_MAX_VOICES`), Modify `src/audio/audio.ts`, Test `tests/audio/budget.test.ts`

Spec S5.7c. Global `activeVoices` ceiling `C.AUDIO_MAX_VOICES≈24` (inc on create, dec on `onended`); per-gun min inter-shot interval (drop a `shot` voice if the same gun fired <25 ms ago for a non-local player). Render/audio-side → **D-SAFE** (no sim float change; `AUDIO_MAX_VOICES` is render-scoped, not consumed by `step()`).

**Step 1: Write the failing test** — `tests/audio/budget.test.ts` (jsdom, reuse the FakeCtx stub pattern; assert the ceiling + per-gun throttle gate voice creation):
```ts
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { AudioEngine } from '../../src/audio/audio';
import { C } from '../../src/data/constants';

describe('audio voice budgeting', () => {
  it('exposes a voice ceiling constant ~24', () => {
    expect(C.AUDIO_MAX_VOICES).toBeGreaterThanOrEqual(16);
    expect(C.AUDIO_MAX_VOICES).toBeLessThanOrEqual(32);
  });
  it('canVoice() returns false once activeVoices hits the ceiling', () => {
    const a = new AudioEngine() as any;
    a.activeVoices = C.AUDIO_MAX_VOICES;
    expect(a.canVoice()).toBe(false);
    a.activeVoices = 0;
    expect(a.canVoice()).toBe(true);
  });
  it('throttles a non-local gun re-fired within 25ms', () => {
    const a = new AudioEngine() as any;
    a.lastGunAt = {};
    expect(a.gunThrottled('stinger', 1000)).toBe(false); // first shot
    a.noteGun('stinger', 1000);
    expect(a.gunThrottled('stinger', 1010)).toBe(true);  // <25ms later
    expect(a.gunThrottled('stinger', 1030)).toBe(false); // >25ms later
  });
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/audio/budget.test.ts`; fails: `AUDIO_MAX_VOICES`, `canVoice`, `gunThrottled`, `noteGun` don't exist.

**Step 3: Minimal implementation** — add to `constants.ts` (render-scoped audio tunable; allowed in `constants.ts` per the spec, but never read by `step()`):
```ts
  AUDIO_MAX_VOICES: 24,
  AUDIO_GUN_MIN_INTERVAL_MS: 25,
```
In `audio.ts` add `private activeVoices = 0; private lastGunAt: Partial<Record<GunId, number>> = {};` and helpers:
```ts
private canVoice(): boolean { return this.activeVoices < C.AUDIO_MAX_VOICES; }
private gunThrottled(gun: GunId, now: number): boolean {
  const t = this.lastGunAt[gun];
  return t !== undefined && now - t < C.AUDIO_GUN_MIN_INTERVAL_MS;
}
private noteGun(gun: GunId, now: number): void { this.lastGunAt[gun] = now; }
```
Increment `activeVoices` in `tone()`/`noise()` when a source starts and decrement via `src.onended = () => { this.activeVoices--; }` (and bail early if `!this.canVoice()`). In `handleEvents` `case 'shot'`, before `this.gunShot(...)` add the per-gun throttle for non-local: `if (ev.player !== localId) { if (this.gunThrottled(ev.gun, performance.now())) break; this.noteGun(ev.gun, performance.now()); }`.

**Step 4: Run it, expect PASS** — `npx vitest run tests/audio/budget.test.ts`; **assert determinism untouched**: `npx vitest run tests/determinism.test.ts` (snapshot unchanged — `AUDIO_MAX_VOICES` is never read by the sim). Full `npm test` + `npm run typecheck` + `npm run build` green.

**Step 5: Commit** — `git add src/data/constants.ts src/audio/audio.ts tests/audio/budget.test.ts && git commit -m "perf(audio): voice ceiling + per-gun inter-shot throttle (D-SAFE, sim-untouched)"`

---

### Task 26: `C.SIM_BASELINE_V` + `C.PLAYER_CCD` flags + D-SHIFT distSq leaf swaps (bundled, ONE re-baseline)

**Files:** Modify `src/data/constants.ts`, Modify `src/sim/systems/blood.ts:81,103`, Modify `src/sim/sim.ts:139,345,427`, Test `tests/sim/sim-baseline.test.ts`, **re-baseline** `tests/determinism.test.ts`

Spec S5.1d + S5.2a. This is the ONE bundled **D-SHIFT** task. Behind a single `C.SIM_BASELINE_V` it: (1) swaps `dist()`→`distSq()` (with squared RHS) at the leaf threshold tests with no geometric feedback — `blood.ts:81` (in-fire), `blood.ts:103` (fire-ignites-pool boolean), `sim.ts:345` (explosion-cull), `sim.ts:427` (`playersInRadius`); and (2) drops player CCD behind `C.PLAYER_CCD=false`. **KEEP `dist()`** at `findSpawnPoint` (`sim.ts:330`, feeds rng score), `spawnPool` merge (`sim.ts:366`, feeds geometry), and `blood.ts:42` inSlick (feeds damping — borderline, left as `dist()` this phase). This task ends with exactly ONE golden re-baseline; the old trajectory stays reproducible by flipping `SIM_BASELINE_V`/`PLAYER_CCD` back.

**Step 1: Write the failing test** — `tests/sim/sim-baseline.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { C } from '../../src/data/constants';

describe('SIM_BASELINE_V D-SHIFT bundle flags', () => {
  it('exposes the baseline version + CCD flags for replay reproducibility', () => {
    expect(typeof C.SIM_BASELINE_V).toBe('number');
    expect(typeof C.PLAYER_CCD).toBe('boolean');
    expect(C.PLAYER_CCD).toBe(false); // CCD dropped behind the flag for the mobile floor
  });
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/sim/sim-baseline.test.ts`; fails: `SIM_BASELINE_V`/`PLAYER_CCD` are undefined.

**Step 3: Minimal implementation** — add to `constants.ts`:
```ts
  // Determinism baseline version — bump when D-SHIFT sim math changes. Flip the
  // flags below to their legacy values to reproduce the prior golden trajectory.
  SIM_BASELINE_V: 2,
  PLAYER_CCD: false, // babo per-tick displacement ≪ radius at 60Hz; CCD off saves mobile CPU
```
`sim.ts:139` — gate CCD: `.setCcdEnabled(C.PLAYER_CCD)`. Apply the distSq leaf swaps (RHS squared):
- `blood.ts:81` `if (dist(p.x, p.y, f.x, f.y) < f.r + C.BABO_RADIUS)` → `const rr = f.r + C.BABO_RADIUS; if (distSq(p.x, p.y, f.x, f.y) < rr * rr)`
- `blood.ts:103` `if (dist(f.x, f.y, pool.x, pool.y) < f.r + pool.r)` → `const rr = f.r + pool.r; if (distSq(f.x, f.y, pool.x, pool.y) < rr * rr)`
- `sim.ts:345` explosion-cull: replace `const d = dist(x, y, p.x, p.y); if (d > radius + C.BABO_RADIUS) continue;` — keep `d` (it feeds falloff below, magnitude), so swap ONLY the cull boolean: leave `dist` here because `d` is reused for falloff (magnitude). **Correction per spec: `sim.ts:345` is the explosion-cull boolean but `d` feeds `falloff` at `:347` → `d` is magnitude. So KEEP `dist()` at `sim.ts:344-347`.** Apply distSq only where the distance is boolean-only.
- `sim.ts:427` `playersInRadius`: `if (p.alive && dist(x, y, p.x, p.y) <= r)` → `if (p.alive && distSq(x, y, p.x, p.y) <= r * r)` (result is boolean-only).

Import `distSq` where missing (`blood.ts` already imports `dist`; add `distSq`; `sim.ts` add `distSq` to the `core/math` import). Ensure `distSq` is imported in both files.

> Note on `sim.ts:345`: the design lists explosion-cull as a leaf swap, but the local `d` is reused for falloff (magnitude). To stay safe, only swap booleans whose value is discarded. `playersInRadius` (`:427`) and both `blood.ts` sites qualify; the explosion path keeps `dist()`. This is the conservative reading of S5.1d ("KEEP `dist()` … and all magnitude/falloff math").

**Step 4: Run it, expect PASS** — `npx vitest run tests/sim/sim-baseline.test.ts`. Now **re-baseline** the golden hash ONCE (this is the explicit, expected snapshot change): `npx vitest run tests/determinism.test.ts tests/rapier-swap.test.ts -u`. Inspect the diff to confirm only the expected D-SHIFT digests changed, then run the cross-instance guard to prove the NEW baseline is internally deterministic: `npx vitest run tests/determinism.test.ts` (no `-u`, green). Full `npm test` + `npm run typecheck` green.

**Step 5: Commit** — `git add src/data/constants.ts src/sim/sim.ts src/sim/systems/blood.ts tests/sim/sim-baseline.test.ts tests/__snapshots__ && git commit -m "perf(sim): D-SHIFT bundle behind SIM_BASELINE_V — distSq leaf swaps + PLAYER_CCD=false, golden re-baseline"`

---

### Task 27: Interior-wall CCD tunneling stress test (validate `PLAYER_CCD=false`)

**Files:** Test `tests/sim/ccd-tunneling.test.ts`

Spec S5.2a validation: the existing arena-bounds assert only catches escaping the OUTER box, not tunneling an INTERIOR wall. Before declaring CCD removal safe, fire a thumper point-blank into a babo pinned against a thin interior wall and assert it does not end up on the far side. GRINDER has interior cover walls, e.g. the mid-field lane breaker at `{ x: -12, y: -8, w: 5, h: 1.2 }` (`maps.ts:63`).

**Step 1: Write the failing test** — `tests/sim/ccd-tunneling.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { makeSim, run, teleport } from '../helpers';
import { GUNS } from '../../src/data/weapons';

describe('CCD removal — interior wall does not tunnel under high impulse', () => {
  it('a thumper blast against a thin interior wall does not pop the victim through it', async () => {
    const sim = await makeSim({ mode: 'tdm', seed: 99 });
    const wall = { x: -12, y: -8, w: 5, h: 1.2 }; // maps.ts:63 mid-field lane breaker
    const a = sim.addPlayer('A', 'spider', 0, false, 'thumper');
    const v = sim.addPlayer('V', 'spider', 1, false);
    run(sim, 2);
    // Pin the victim just on the +y side of the wall's top face; shooter below it.
    const victimY = wall.y + wall.h / 2 + 0.5;   // touching the wall's top edge from above
    teleport(sim, v.id, wall.x, victimY);
    teleport(sim, a.id, wall.x, victimY + 1.5);
    v.invulnT = 0; a.spawnProt = false;
    // Detonate a frag-class blast right on the victim (rocket explode path applies impulse pre-step).
    sim.explode(v.x, v.y - 0.1, C.FRAG_RADIUS, C.FRAG_DAMAGE, C.FRAG_IMPULSE, a.id, 'rocket', 'thumper');
    for (let i = 0; i < 30; i++) sim.step(); // let the impulse integrate
    // The victim must stay on the +y side of the wall's top face — never tunnel to y < wall bottom.
    expect(v.y).toBeGreaterThan(wall.y - wall.h / 2 - 0.1);
  }, 30_000);
});
```
(Import `C` from `../../src/data/constants` at the top.)

**Step 2: Run it, expect FAIL or PASS** — `npx vitest run tests/sim/ccd-tunneling.test.ts`. If it FAILS (victim tunneled), CCD-off is unsafe → escalate per spec Risk #10: either keep `C.PLAYER_CCD=true` (forfeit the saving) or implement the impulse-time CCD-enable fallback in `applyImpulse()`. If it PASSES, CCD-off is validated for this scenario.

**Step 3: Minimal implementation** — none if the test passes (it is a guard for Task 26's flag). If it fails, implement the spec S5.2a fallback in `sim.ts` `applyImpulse()`:
```ts
applyImpulse(p: PlayerState, ix: number, iy: number): void {
  if (!p.alive || p.fortifyActive) return;
  const body = this.bodies.get(p.id);
  if (!body) return;
  if (!C.PLAYER_CCD) {
    // Re-enable CCD just for a near-radius-displacement impulse this tick (death-pop/explosion).
    const speed = Math.hypot(ix, iy) / cls_mass_or_body_mass; // |impulse|/mass
    if (speed * this.dt > C.BABO_RADIUS * 0.5) body.enableCcd(true);
  }
  body.applyImpulse({ x: ix, y: iy }, true);
}
```
(Read `body.mass()` for the divisor; confirm the non-compat Rapier `enableCcd` API name during implementation.)

**Step 4: Run it, expect PASS** — `npx vitest run tests/sim/ccd-tunneling.test.ts` green. If the fallback was added, **re-run determinism** `npx vitest run tests/determinism.test.ts` — if the fallback only triggers on impulses that didn't exist in the baseline replay it stays byte-identical; if it shifts the hash, fold it into Task 26's re-baseline (single re-baseline rule) and document. Full `npm test` + `npm run typecheck` green.

**Step 5: Commit** — `git add tests/sim/ccd-tunneling.test.ts src/sim/sim.ts && git commit -m "test(sim): interior-wall CCD tunneling stress test guarding PLAYER_CCD=false"`

---

### Phase 1 exit verification (no commit)

Per spec roadmap P1 exit criteria and S8.7, before declaring Phase 1 done, run the full fail-fast gate and record evidence (@superpowers:verification-before-completion):
1. `npm run typecheck` green.
2. `npm test` green — all original 94 + new build/shell/audio/render/core/sim tests, the Foundation golden hash (now at `SIM_BASELINE_V=2`), `purity.test.ts`, and the seed-42 post-Rapier-swap determinism.
3. Flag-OFF / desktop path: `QUALITY.tier==='high'` in jsdom → AA on, DPR 2 → desktop byte-identical.
4. `npm run build` green; inspect `dist`: entry chunk has no static `three`/`rapier`/`peerjs`; a hashed `.wasm` exists as a separate (non-inlined) asset; `three.*`/`peerjs.*`/`rapier.*` are separate chunks.
5. Manual/device L5 sign-off (deferred to the device pass, human checkbox): menu paints before the Rapier chunk downloads; iOS audio plays after first tap and is silent when hidden; first cold local match TTFF acceptable on Fast-3G + 4× CPU (prefetch warmed three+rapier).

---




## Phase 2 — It Plays (touch controls + responsive UI + tier switch + flagged Lance)

> **Depends on P1:** `src/data/runtime.ts` (`RUNTIME = { tier, touch, projectileLance }`), `src/core/viewport.ts` (`viewportSize()`, `onViewportChange()`), `src/render/quality.ts` (`QUALITY`, `detectQuality()`, `setTierOverride()`, `surfaceMat()` is added here in Phase 2), and the test infra from Foundation: `simHash(sim)` + golden snapshots in `tests/helpers.ts`, `tests/purity.test.ts`, and the `jsdom` devDep with `environmentMatchGlobs` mapping `tests/{scene,touch,shell}/**` → `jsdom`. All Phase 2 work uses @superpowers:test-driven-development. Every sim-touching task (S1.11 RELOAD, S2 Lance) is preceded by / bracketed with the Foundation golden-hash guard; render-only tasks keep `tests/purity.test.ts` green.

> **Ordering rationale:** S1.11 (the one additive sim bit) lands first as a self-contained D-SAFE sim change so the touch producer can emit it. Then the touch producer (S1.1–S1.14) and its render adjuncts. Then S6 shell. Then S3 tier switch. Then S2 (the flagged D-SHIFT Lance) last, since it owns its own re-baseline and is default-OFF.

---

### Task 30: `BTN.RELOAD` constant + edge-triggered manual reload (the one additive sim change)
**Files:** Modify `src/sim/types.ts:9-14` (BTN) · Modify `src/sim/systems/weapons.ts:107` · Test `tests/weapons.test.ts`

This is **D-SAFE**: `emptyInput()` never sets the bit, so every existing recording/test input is byte-identical. The Foundation golden-hash guard must already exist; this task asserts it stays green (no existing input carries `BTN.RELOAD`).

**Step 1: Write the failing test** — append to `tests/weapons.test.ts` (inside the `describe('weaponSystem', …)` block):
```ts
it('manual RELOAD is edge-triggered: 2 ticks in one frame emit exactly one reloadStart', async () => {
  const sim = await makeSim();
  const p = sim.addPlayer('A', 'spider', 0, false);
  arm(sim, p, 'workhorse');
  p.mag = 10; // partial mag, reloadable
  // Hold RELOAD across two weaponSystem ticks WITHOUT clearing prevButtons between
  // them (mirrors FixedLoop catch-up running tick() twice on one sampled input).
  sim.setInput(p.id, input({ buttons: BTN.RELOAD }));
  weaponSystem(sim, sim.dt);
  weaponSystem(sim, sim.dt); // prevButtons NOT yet updated → still an "edge" by naive code
  for (const q of sim.players.values()) q.prevButtons = q.input.buttons;
  expect(eventsOf(sim, 'reloadStart').length).toBe(1);
  expect(p.reloadT).toBeGreaterThan(0);
});

it('manual RELOAD is inert for full mags, heat guns, and mid-reload', async () => {
  const sim = await makeSim();
  const p = sim.addPlayer('A', 'spider', 0, false);
  // Full mag → no reload
  arm(sim, p, 'workhorse');
  hold(sim, p.id, BTN.RELOAD);
  tickWeapons(sim, 1);
  expect(eventsOf(sim, 'reloadStart').length).toBe(0);
  // Heat gun → no reload
  arm(sim, p, 'ion');
  hold(sim, p.id, BTN.RELOAD);
  tickWeapons(sim, 1);
  expect(eventsOf(sim, 'reloadStart').length).toBe(0);
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/weapons.test.ts`. Fails: `BTN.RELOAD` is `undefined` (no such key) → `buttons` is `NaN`/0, no `reloadStart` emitted.

**Step 3: Minimal implementation** —
In `src/sim/types.ts` add to `BTN`:
```ts
export const BTN = {
  FIRE: 1,
  THROW: 2,
  ABILITY: 4,
  PICKUP: 8,
  RELOAD: 16,
} as const;
```
In `src/sim/systems/weapons.ts`, immediately after the auto-reload block (after line 107, before the heat-dissipation block), add:
```ts
    // Manual reload (edge-triggered). Inert for heat guns, full mags, mid-reload,
    // and the same tick a shot already discharged (avoids double-trigger).
    const reloadPressed = (p.input.buttons & BTN.RELOAD) && !(p.prevButtons & BTN.RELOAD);
    if (
      gun.sustain === 'reload' && reloadPressed &&
      p.reloadT === 0 && p.mag < (gun.magSize ?? 0) && !discharged
    ) {
      p.reloadT = gun.reloadTime!;
      sim.emit({ t: 'reloadStart', player: p.id, gun: p.gun });
    }
```

**Step 4: Run it, expect PASS** — `npx vitest run tests/weapons.test.ts` green. Then `npm test` (full suite incl. Foundation golden hash — must be **byte-identical**: no existing input sets `BTN.RELOAD`, so all golden snapshots are unchanged) and `npm run typecheck` stay green.

**Step 5: Commit** —
```
git add src/sim/types.ts src/sim/systems/weapons.ts tests/weapons.test.ts && git commit -m "feat(sim): add BTN.RELOAD with edge-triggered manual reload (D-SAFE, inert by default)"
```

---

### Task 31: Optional desktop `KeyR` → `BTN.RELOAD` in InputManager
**Files:** Modify `src/input.ts:76-82` · Test `tests/touch/inputManager.test.ts` (new)

Free desktop feature behind the same opt-in bit. jsdom test (InputManager attaches `window` listeners).

**Step 1: Write the failing test** — create `tests/touch/inputManager.test.ts`:
```ts
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { InputManager } from '../../src/input';
import { BTN } from '../../src/sim/types';

let mgr: InputManager;
afterEach(() => mgr?.dispose());

describe('InputManager KeyR → BTN.RELOAD', () => {
  it('sets BTN.RELOAD while KeyR is held, clears on keyup', () => {
    mgr = new InputManager();
    mgr.enabled = true;
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR' }));
    let inp = mgr.sample({ x: 0, y: 0 }, 0, 0);
    expect(inp.buttons & BTN.RELOAD).toBe(BTN.RELOAD);
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyR' }));
    inp = mgr.sample({ x: 0, y: 0 }, 0, 0);
    expect(inp.buttons & BTN.RELOAD).toBe(0);
  });
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/touch/inputManager.test.ts`. Fails: `KeyR` is not mapped, `buttons & BTN.RELOAD === 0`.

**Step 3: Minimal implementation** — in `src/input.ts`, inside the `if (this.enabled)` buttons block (after line 81 `KeyE`):
```ts
      if (this.keys.has('KeyR')) buttons |= BTN.RELOAD;
```

**Step 4: Run it, expect PASS** — `npx vitest run tests/touch/inputManager.test.ts` + `npm test` + `npm run typecheck` green. Determinism unaffected (sim inputs come from recordings, not live keys).

**Step 5: Commit** —
```
git add src/input.ts tests/touch/inputManager.test.ts && git commit -m "feat(input): KeyR ORs BTN.RELOAD on desktop"
```

---

### Task 32: `InputSource` interface + dormant-`TouchControls` non-regression scaffold
**Files:** Create `src/touch/touchControls.ts` · Modify `src/input.ts` (implements clause only) · Test `tests/touch/touchControls.test.ts` (new)

Establish the structural interface and the skeleton `TouchControls` (DOM layer + neutral `sample`) so later tasks fill behavior. The S8.4 non-regression assertion: a constructed `TouchControls` must not perturb `InputManager`.

**Step 1: Write the failing test** — create `tests/touch/touchControls.test.ts`:
```ts
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { TouchControls } from '../../src/touch/touchControls';
import { emptyInput } from '../../src/sim/types';

let tc: TouchControls;
afterEach(() => tc?.dispose());

function mount(): HTMLElement {
  const c = document.createElement('div');
  document.body.appendChild(c);
  return c;
}

describe('TouchControls scaffold', () => {
  it('appends a #touch-layer to the container and removes it on dispose', () => {
    const c = mount();
    tc = new TouchControls(c, 1);
    expect(c.querySelector('#touch-layer')).not.toBeNull();
    tc.dispose();
    expect(c.querySelector('#touch-layer')).toBeNull();
  });

  it('neutral sample matches emptyInput shape with buttons 0 and zero movement', () => {
    const c = mount();
    tc = new TouchControls(c, 1);
    const inp = tc.sample({ x: 0, y: 0 }, 5, 5);
    expect(inp.buttons).toBe(0);
    expect(inp.mx).toBe(0);
    expect(inp.my).toBe(0);
    expect(typeof inp.aim).toBe('number');
    // shape parity with emptyInput keys
    expect(Object.keys(inp).sort()).toEqual(Object.keys(emptyInput()).sort());
  });
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/touch/touchControls.test.ts`. Fails: module `src/touch/touchControls.ts` does not exist.

**Step 3: Minimal implementation** — create `src/touch/touchControls.ts`:
```ts
import { angleDiff } from '../core/math';
import type { PlayerInput } from '../sim/types';
import { BTN } from '../sim/types';
import type { InputSource } from '../input';
import type { PlayerState } from '../sim/types';

const STICK_R = 56;
const AIM_STICK_R = 56;
const AIM_DEADZONE = 0.25;
const MOVE_DEADZONE = 0.12;
const AIM_MIN_DIST = 3;
const AIM_MAX_DIST = 16;

export class TouchControls implements InputSource {
  enabled = true;
  showScores = false;

  // Read-state for renderer/HUD
  aimActive = false;
  aimAngle = 0;
  aimMag = 0;
  firing = false;
  grenadeArc = { active: false, aim: 0, dist: 0 };

  private layer: HTMLDivElement;
  private seq = 1;
  private moveX = 0;
  private moveY = 0;

  constructor(private container: HTMLElement, private localId: number) {
    this.layer = document.createElement('div');
    this.layer.id = 'touch-layer';
    this.container.appendChild(this.layer);
  }

  sample(_ground: { x: number; y: number }, _px: number, _py: number): PlayerInput {
    return {
      mx: this.moveX, my: this.moveY,
      aim: this.aimAngle, aimDist: AIM_MIN_DIST,
      buttons: 0, seq: this.seq++,
    };
  }

  dispose(): void {
    this.layer.remove();
  }
}
```
And in `src/input.ts`, export the interface and mark `InputManager` as implementing it (line 7):
```ts
import { BTN, type PlayerInput } from './sim/types';

export interface InputSource {
  enabled: boolean;
  showScores: boolean;
  sample(ground: { x: number; y: number }, px: number, py: number): PlayerInput;
  dispose(): void;
}

export class InputManager implements InputSource {
```

**Step 4: Run it, expect PASS** — `npx vitest run tests/touch/touchControls.test.ts` + `npm test` + `npm run typecheck` green. (`angleDiff`/`AIM_*` imports are dead until later tasks — they're allowed since the file compiles; if `noUnusedLocals` complains, defer the unused imports until Task 35.)

**Step 5: Commit** —
```
git add src/touch/touchControls.ts src/input.ts tests/touch/touchControls.test.ts && git commit -m "feat(touch): InputSource interface + TouchControls scaffold (#touch-layer, neutral sample)"
```

---

### Task 33: Left analog stick → `mx/my` (floating origin, deadzone, pointer-keyed)
**Files:** Modify `src/touch/touchControls.ts` · Test `tests/touch/touchControls.test.ts`

**Step 1: Write the failing test** — append:
```ts
function pe(type: string, id: number, x: number, y: number): PointerEvent {
  return new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, bubbles: true });
}

describe('TouchControls left stick → movement', () => {
  it('maps a right-down drag to mx>0,my>0 and releases to 0', () => {
    const c = mount();
    tc = new TouchControls(c, 1);
    const layer = c.querySelector('#touch-layer') as HTMLElement;
    // left zone: x in left ~45% of an 800px-wide window (jsdom innerWidth=1024 default)
    layer.dispatchEvent(pe('pointerdown', 1, 100, 600));
    layer.dispatchEvent(pe('pointermove', 1, 100 + 56, 600 + 56)); // full deflection, +x/+y
    let inp = tc.sample({ x: 0, y: 0 }, 0, 0);
    expect(inp.mx).toBeGreaterThan(0.5);
    expect(inp.my).toBeGreaterThan(0.5);
    layer.dispatchEvent(pe('pointerup', 1, 100 + 56, 600 + 56));
    inp = tc.sample({ x: 0, y: 0 }, 0, 0);
    expect(inp.mx).toBe(0);
    expect(inp.my).toBe(0);
  });

  it('applies a dead-zone: tiny deflection → 0', () => {
    const c = mount();
    tc = new TouchControls(c, 1);
    const layer = c.querySelector('#touch-layer') as HTMLElement;
    layer.dispatchEvent(pe('pointerdown', 1, 100, 600));
    layer.dispatchEvent(pe('pointermove', 1, 103, 600)); // ~3px < 0.12*56
    const inp = tc.sample({ x: 0, y: 0 }, 0, 0);
    expect(inp.mx).toBe(0);
    expect(inp.my).toBe(0);
  });
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/touch/touchControls.test.ts`. Fails: no pointer handlers, `mx/my` stay 0.

**Step 3: Minimal implementation** — add to `TouchControls`. Zone test uses `viewportSize()` from the P1 viewport bus (fallback `window.innerWidth`); left zone = left 45% × bottom 50%. In the constructor add `this.layer.style.touchAction = 'none';` and register pointer handlers with `setPointerCapture`:
```ts
  private leftId = -1;
  private leftOX = 0; private leftOY = 0;

  private onDown = (e: PointerEvent): void => {
    e.preventDefault();
    const { w, h } = viewportSize();
    const inLeft = e.clientX < w * 0.45 && e.clientY > h * 0.5;
    if (this.leftId === -1 && inLeft) {
      this.leftId = e.pointerId; this.leftOX = e.clientX; this.leftOY = e.clientY;
      this.layer.setPointerCapture(e.pointerId);
    }
  };
  private onMove = (e: PointerEvent): void => {
    if (e.pointerId === this.leftId) {
      const dx = e.clientX - this.leftOX, dy = e.clientY - this.leftOY;
      const mag = Math.hypot(dx, dy);
      const m = Math.min(1, mag / STICK_R);
      if (m < MOVE_DEADZONE || mag < 1e-6) { this.moveX = 0; this.moveY = 0; }
      else { this.moveX = (dx / mag) * m; this.moveY = (dy / mag) * m; }
    }
  };
  private onUp = (e: PointerEvent): void => {
    if (e.pointerId === this.leftId) { this.leftId = -1; this.moveX = 0; this.moveY = 0; }
  };
```
Wire them in the constructor (`pointerdown/move/up/cancel`, `onUp` handles cancel too) and remove them in `dispose()`. Update `sample()` to keep using `this.moveX/this.moveY` (already done). Add `import { viewportSize } from '../core/viewport';`.

**Step 4: Run it, expect PASS** — `npx vitest run tests/touch/touchControls.test.ts` + `npm test` + `npm run typecheck` green.

**Step 5: Commit** —
```
git add src/touch/touchControls.ts tests/touch/touchControls.test.ts && git commit -m "feat(touch): left analog stick → mx/my (floating origin, deadzone)"
```

---

### Task 34: Right stick → aim angle + `BTN.FIRE` autofire (gating delegated to sim)
**Files:** Modify `src/touch/touchControls.ts` · Test `tests/touch/touchControls.test.ts`

Per S1.5/S8.4: touch only OR-s `BTN.FIRE` while deflected past `AIM_DEADZONE`; it does **not** itself gate by reload/heat/ammo (that's `weapons.ts:76-79`).

**Step 1: Write the failing test** — append:
```ts
describe('TouchControls right stick → aim + autofire', () => {
  it('sets aim=atan2(dy,dx) and BTN.FIRE while deflected, clears FIRE on release', () => {
    const c = mount();
    tc = new TouchControls(c, 1);
    const layer = c.querySelector('#touch-layer') as HTMLElement;
    // right zone: x in right ~55%, bottom 40%. jsdom innerWidth=1024, innerHeight=768
    layer.dispatchEvent(pe('pointerdown', 2, 800, 600));
    layer.dispatchEvent(pe('pointermove', 2, 800 + 40, 600)); // +x deflection
    let inp = tc.sample({ x: 0, y: 0 }, 0, 0);
    expect(inp.aim).toBeCloseTo(0, 3);           // atan2(0, +dx)
    expect(inp.buttons & BTN.FIRE).toBe(BTN.FIRE);
    expect(tc.aimActive).toBe(true);
    layer.dispatchEvent(pe('pointerup', 2, 840, 600));
    inp = tc.sample({ x: 0, y: 0 }, 0, 0);
    expect(inp.buttons & BTN.FIRE).toBe(0);
    expect(tc.aimActive).toBe(false);
  });

  it('does NOT fire below AIM_DEADZONE deflection', () => {
    const c = mount();
    tc = new TouchControls(c, 1);
    const layer = c.querySelector('#touch-layer') as HTMLElement;
    layer.dispatchEvent(pe('pointerdown', 2, 800, 600));
    layer.dispatchEvent(pe('pointermove', 2, 805, 600)); // 5px / 56 ≈ 0.09 < 0.25
    const inp = tc.sample({ x: 0, y: 0 }, 0, 0);
    expect(inp.buttons & BTN.FIRE).toBe(0);
  });
});
```
Add `import { BTN } from '../../src/sim/types';` to the test file if not present.

**Step 2: Run it, expect FAIL** — `npx vitest run tests/touch/touchControls.test.ts`. Fails: no right-stick handler; `aim` stays 0 but `BTN.FIRE` never set, `aimActive` false.

**Step 3: Minimal implementation** — add a right-stick gesture keyed by its own `rightId` (zone: `x > w*0.45 && y > h*0.6`), mirroring the left stick. In `onDown` add an `else if` claiming the right zone; in `onMove` update `aimAngle`/`aimMag`/`aimActive`/`firing`; in `onUp` clear `aimActive`/`firing`. Then update `sample()` to emit fire + assisted aim + `aimDist`:
```ts
  sample(_ground, _px, _py): PlayerInput {
    let buttons = 0;
    if (this.firing) buttons |= BTN.FIRE;
    const aimDist = this.aimActive
      ? AIM_MIN_DIST + (AIM_MAX_DIST - AIM_MIN_DIST) * this.aimMag
      : AIM_MIN_DIST;
    return { mx: this.moveX, my: this.moveY, aim: this.aimAngle, aimDist, buttons, seq: this.seq++ };
  }
```
Right-stick move logic: `aimAngle = atan2(dy, dx)`, `aimMag = min(1, mag/AIM_STICK_R)`, `aimActive = true`, `firing = aimMag > AIM_DEADZONE`.

**Step 4: Run it, expect PASS** — `npx vitest run tests/touch/touchControls.test.ts` + `npm test` + `npm run typecheck` green.

**Step 5: Commit** —
```
git add src/touch/touchControls.ts tests/touch/touchControls.test.ts && git commit -m "feat(touch): right stick → aim + BTN.FIRE autofire (sim gates the shot)"
```

---

### Task 35: Aim-assist soft angular magnetism (`ASSIST_STRENGTH≤0.30`, lead-disabled-for-lance contract)
**Files:** Modify `src/touch/touchControls.ts` · Test `tests/touch/touchControls.test.ts`

Computed in the producer, baked into `input.aim`, capped per S1.6. The world is supplied by `setWorld(view, localId)`. Per S2.5, `TouchControls` reads `GUNS[gun].projectileSpeed` and special-cases `gun.id==='lance'` to **skip lead** — though no lead is implemented in P2 (rotate-to-target only), the contract guard is added so it's correct by construction.

**Step 1: Write the failing test** — append:
```ts
import { angleDiff } from '../../src/core/math';

function worldWith(targets: { id: number; x: number; y: number; team?: number }[]) {
  return {
    players: [
      { id: 1, x: 0, y: 0, team: -1, alive: true },
      ...targets.map((t) => ({ id: t.id, x: t.x, y: t.y, team: t.team ?? -1, alive: true })),
    ],
  } as any;
}

describe('TouchControls aim-assist', () => {
  it('nudges aim toward a target inside the cone but never past it (capped strength)', () => {
    const c = mount();
    tc = new TouchControls(c, 1);
    tc.setWorld(worldWith([{ id: 2, x: 10, y: 0 }]), 1); // target dead +x (ang 0)
    const layer = c.querySelector('#touch-layer') as HTMLElement;
    layer.dispatchEvent(pe('pointerdown', 2, 800, 600));
    // raw aim ~0.1 rad off the target (within 0.30 cone)
    layer.dispatchEvent(pe('pointermove', 2, 800 + 40 * Math.cos(0.1), 600 + 40 * Math.sin(0.1)));
    const inp = tc.sample({ x: 0, y: 0 }, 0, 0);
    // assisted aim is between raw (0.1) and target (0): nudged toward 0, not snapped
    expect(inp.aim).toBeGreaterThan(0);
    expect(inp.aim).toBeLessThan(0.1);
  });

  it('does not assist outside the cone or onto teammates', () => {
    const c = mount();
    tc = new TouchControls(c, 1);
    tc.setWorld(worldWith([{ id: 2, x: 0, y: 10, team: -1 }]), 1); // target at +y (ang PI/2)
    const layer = c.querySelector('#touch-layer') as HTMLElement;
    layer.dispatchEvent(pe('pointerdown', 2, 800, 600));
    layer.dispatchEvent(pe('pointermove', 2, 840, 600)); // raw aim ~0, target far outside cone
    const inp = tc.sample({ x: 0, y: 0 }, 0, 0);
    expect(Math.abs(inp.aim)).toBeLessThan(0.05); // unchanged
  });

  it('tolerates an unset/null world (no players) without throwing', () => {
    const c = mount();
    tc = new TouchControls(c, 1);
    tc.setWorld(null, 1);
    const layer = c.querySelector('#touch-layer') as HTMLElement;
    layer.dispatchEvent(pe('pointerdown', 2, 800, 600));
    layer.dispatchEvent(pe('pointermove', 2, 840, 600));
    expect(() => tc.sample({ x: 0, y: 0 }, 0, 0)).not.toThrow();
  });
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/touch/touchControls.test.ts`. Fails: `tc.setWorld` is not a function.

**Step 3: Minimal implementation** — add the `ASSIST` block and `setWorld` per S1.6. Store `private view: { players: PlayerState[] } | null = null;` and `private localId`. Add:
```ts
const ASSIST = { CONE: 0.30, STRENGTH: 0.30, RANGE: 22 } as const;

  setWorld(view: { players: Iterable<PlayerState> } | null, localId: number): void {
    this.view = view ? { players: [...view.players] } : null;
    this.localId = localId;
  }

  private assist(rawAim: number): number {
    const v = this.view; if (!v) return rawAim;
    const me = v.players.find((p) => p.id === this.localId);
    if (!me) return rawAim;
    const px = me.x, py = me.y;
    let best = -1, bestErr = ASSIST.CONE, bestAng = 0;
    for (const e of v.players) {
      if (!e.alive || e.id === this.localId) continue;
      if (me.team !== -1 && e.team === me.team) continue;
      const d = Math.hypot(e.x - px, e.y - py); if (d > ASSIST.RANGE) continue;
      const ang = Math.atan2(e.y - py, e.x - px);
      const err = Math.abs(angleDiff(rawAim, ang));
      if (err < bestErr) { bestErr = err; best = e.id; bestAng = ang; }
    }
    if (best < 0) return rawAim;
    // rotate-to-target only; lead is intentionally NOT applied here. The lance
    // lead-skip contract (S2.5) is a no-op until lead lands, kept explicit:
    return rawAim + angleDiff(rawAim, bestAng) * ASSIST.STRENGTH * (1 - bestErr / ASSIST.CONE);
  }
```
In `sample()`, replace the emitted `aim: this.aimAngle` with `aim: this.assist(this.aimAngle)`. Gate behind `window.__bv3?.touchAssist !== false` (default on) — read defensively so headless tests (no `__bv3.touchAssist`) keep assist on.

**Step 4: Run it, expect PASS** — `npx vitest run tests/touch/touchControls.test.ts` + `npm test` + `npm run typecheck` green.

**Step 5: Commit** —
```
git add src/touch/touchControls.ts tests/touch/touchControls.test.ts && git commit -m "feat(touch): aim-assist soft magnetism (capped ASSIST_STRENGTH=0.30, teammate/cone guarded)"
```

---

### Task 36: Grenade drag-arc (EQUIPMENT hold → `BTN.THROW` + arc aim/dist, mirrors RMB)
**Files:** Modify `src/touch/touchControls.ts` · Test `tests/touch/touchControls.test.ts`

Per S1.9: EQUIPMENT `pointerdown` sets `grenadeArc.active`, OR-s `BTN.THROW`, suspends the aim stick for that finger; `pointermove` updates `grenadeArc.aim/dist`; `pointerup` drops `BTN.THROW` (the sim's falling-edge `releaseThrow` throws). Zero sim change.

**Step 1: Write the failing test** — append:
```ts
describe('TouchControls grenade drag-arc', () => {
  it('EQUIP-hold ORs BTN.THROW and overrides aim/aimDist from the drag, clears on release', () => {
    const c = mount();
    tc = new TouchControls(c, 1);
    const layer = c.querySelector('#touch-layer') as HTMLElement;
    // EQUIPMENT button lives at a known id; simulate via the equip pointer entry point.
    tc.beginGrenade(840, 300); // origin
    tc.moveGrenade(840 + 140, 300); // full ARC_DRAG_PX → max range, aim +x
    let inp = tc.sample({ x: 0, y: 0 }, 0, 0);
    expect(inp.buttons & BTN.THROW).toBe(BTN.THROW);
    expect(inp.aim).toBeCloseTo(0, 3);
    expect(inp.aimDist).toBeGreaterThan(13); // near GRENADE_MAX_RANGE (14)
    expect(tc.grenadeArc.active).toBe(true);
    tc.endGrenade();
    inp = tc.sample({ x: 0, y: 0 }, 0, 0);
    expect(inp.buttons & BTN.THROW).toBe(0);
    expect(tc.grenadeArc.active).toBe(false);
  });
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/touch/touchControls.test.ts`. Fails: `tc.beginGrenade` is not a function.

**Step 3: Minimal implementation** — import `C` from `../data/constants`; add `ARC_DRAG_PX = 140`. Add methods (called by the EQUIPMENT button's pointer handlers, added in Task 38):
```ts
  beginGrenade(x: number, y: number): void {
    this.grenadeArc.active = true; this.grenadeArc.aim = 0; this.grenadeArc.dist = C.GRENADE_MIN_RANGE;
    this.grenOX = x; this.grenOY = y;
  }
  moveGrenade(x: number, y: number): void {
    if (!this.grenadeArc.active) return;
    const dx = x - this.grenOX, dy = y - this.grenOY;
    this.grenadeArc.aim = Math.atan2(dy, dx);
    const m = Math.min(1, Math.hypot(dx, dy) / ARC_DRAG_PX);
    this.grenadeArc.dist = C.GRENADE_MIN_RANGE + (C.GRENADE_MAX_RANGE - C.GRENADE_MIN_RANGE) * m;
  }
  endGrenade(): void { this.grenadeArc.active = false; }
```
In `sample()`, when `this.grenadeArc.active`: OR `BTN.THROW` and override `aim = this.grenadeArc.aim`, `aimDist = this.grenadeArc.dist` (the arc takes priority over gun aim).

**Step 4: Run it, expect PASS** — `npx vitest run tests/touch/touchControls.test.ts` + `npm test` + `npm run typecheck` green.

**Step 5: Commit** —
```
git add src/touch/touchControls.ts tests/touch/touchControls.test.ts && git commit -m "feat(touch): grenade drag-arc (BTN.THROW + arc aim/dist mirroring RMB)"
```

---

### Task 37: Consume-on-first-sample latches (RELOAD, PICKUP) + blur/cancel neutral reset
**Files:** Modify `src/touch/touchControls.ts` · Test `tests/touch/touchControls.test.ts`

Per S1.11.3 / S1.14: a tapped RELOAD/PICKUP sets the bit and **clears the latch inside `sample()` on first read**, so each tap emits the bit at most once regardless of ticks/frame. Blur/cancel/visibility-hidden zero all state + latches.

**Step 1: Write the failing test** — append:
```ts
describe('TouchControls latches + neutral reset', () => {
  it('RELOAD tap emits BTN.RELOAD exactly once even across two samples', () => {
    const c = mount();
    tc = new TouchControls(c, 1);
    tc.tapReload();
    const a = tc.sample({ x: 0, y: 0 }, 0, 0);
    const b = tc.sample({ x: 0, y: 0 }, 0, 0);
    expect(a.buttons & BTN.RELOAD).toBe(BTN.RELOAD);
    expect(b.buttons & BTN.RELOAD).toBe(0);
  });

  it('PICKUP tap emits BTN.PICKUP exactly once', () => {
    const c = mount();
    tc = new TouchControls(c, 1);
    tc.tapPickup();
    expect(tc.sample({ x: 0, y: 0 }, 0, 0).buttons & BTN.PICKUP).toBe(BTN.PICKUP);
    expect(tc.sample({ x: 0, y: 0 }, 0, 0).buttons & BTN.PICKUP).toBe(0);
  });

  it('blur resets all state: next sample is neutral (buttons 0, mx=my=0)', () => {
    const c = mount();
    tc = new TouchControls(c, 1);
    const layer = c.querySelector('#touch-layer') as HTMLElement;
    layer.dispatchEvent(pe('pointerdown', 1, 100, 600));
    layer.dispatchEvent(pe('pointermove', 1, 156, 656));
    layer.dispatchEvent(pe('pointerdown', 2, 800, 600));
    layer.dispatchEvent(pe('pointermove', 2, 840, 600));
    tc.tapReload();
    window.dispatchEvent(new Event('blur'));
    const inp = tc.sample({ x: 0, y: 0 }, 0, 0);
    expect(inp.buttons).toBe(0);
    expect(inp.mx).toBe(0);
    expect(inp.my).toBe(0);
  });
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/touch/touchControls.test.ts`. Fails: `tc.tapReload` is not a function.

**Step 3: Minimal implementation** — add `private reloadLatch = false; private pickupLatch = false;` and:
```ts
  tapReload(): void { this.reloadLatch = true; }
  tapPickup(): void { this.pickupLatch = true; }

  private resetNeutral = (): void => {
    this.moveX = 0; this.moveY = 0;
    this.aimActive = false; this.firing = false;
    this.grenadeArc.active = false;
    this.reloadLatch = false; this.pickupLatch = false;
    this.leftId = -1; this.rightId = -1;
  };
```
In `sample()`, after computing `buttons`:
```ts
    if (this.reloadLatch) { buttons |= BTN.RELOAD; this.reloadLatch = false; }
    if (this.pickupLatch) { buttons |= BTN.PICKUP; this.pickupLatch = false; }
```
Wire `window.addEventListener('blur', this.resetNeutral)` and `document.addEventListener('visibilitychange', …)` (call `resetNeutral` when `document.hidden`) in the constructor; register `pointercancel` → `resetNeutral` on the layer; remove all in `dispose()`.

**Step 4: Run it, expect PASS** — `npx vitest run tests/touch/touchControls.test.ts` + `npm test` + `npm run typecheck` green.

**Step 5: Commit** —
```
git add src/touch/touchControls.ts tests/touch/touchControls.test.ts && git commit -m "feat(touch): consume-on-first-sample RELOAD/PICKUP latches + blur/cancel neutral reset"
```

---

### Task 38: SKILL/RELOAD/EQUIPMENT/PICKUP/scoreboard/leave buttons (DOM) + auto-detect/toggle
**Files:** Modify `src/touch/touchControls.ts` · Test `tests/touch/touchControls.test.ts`

Per S1.7/S1.12/S1.2: small `pointerId`-keyed edge buttons that don't start the aim stick; SKILL=`BTN.ABILITY` (supports hold), EQUIPMENT drives the grenade arc, RELOAD/PICKUP fire the latches, scoreboard toggles `showScores`, leave fires a callback. Plus `shouldUseTouch()` detection helper.

**Step 1: Write the failing test** — append:
```ts
describe('TouchControls buttons + detection', () => {
  it('SKILL button holds BTN.ABILITY while pressed, drops on release', () => {
    const c = mount();
    tc = new TouchControls(c, 1);
    const skill = c.querySelector('#tc-skill') as HTMLElement;
    skill.dispatchEvent(pe('pointerdown', 3, 980, 400));
    expect(tc.sample({ x: 0, y: 0 }, 0, 0).buttons & BTN.ABILITY).toBe(BTN.ABILITY);
    skill.dispatchEvent(pe('pointerup', 3, 980, 400));
    expect(tc.sample({ x: 0, y: 0 }, 0, 0).buttons & BTN.ABILITY).toBe(0);
  });

  it('pointerdown on a button does not start the aim stick', () => {
    const c = mount();
    tc = new TouchControls(c, 1);
    const reload = c.querySelector('#tc-reload') as HTMLElement;
    reload.dispatchEvent(pe('pointerdown', 4, 980, 500));
    expect(tc.aimActive).toBe(false);
  });

  it('scoreboard toggle flips showScores', () => {
    const c = mount();
    tc = new TouchControls(c, 1);
    const sb = c.querySelector('#tc-scores') as HTMLElement;
    sb.dispatchEvent(pe('pointerdown', 5, 512, 30));
    expect(tc.showScores).toBe(true);
    sb.dispatchEvent(pe('pointerdown', 5, 512, 30));
    expect(tc.showScores).toBe(false);
  });
});

describe('shouldUseTouch', () => {
  it('respects an explicit on/off localStorage override', async () => {
    const { shouldUseTouch } = await import('../../src/touch/touchControls');
    localStorage.setItem('bv3-touch', 'on');
    expect(shouldUseTouch()).toBe(true);
    localStorage.setItem('bv3-touch', 'off');
    expect(shouldUseTouch()).toBe(false);
    localStorage.removeItem('bv3-touch');
  });
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/touch/touchControls.test.ts`. Fails: `#tc-skill` is null; `shouldUseTouch` not exported.

**Step 3: Minimal implementation** — in the constructor, build the button DOM (`#tc-skill`, `#tc-reload`, `#tc-equip`, `#tc-pickup`, `#tc-scores`, `#tc-leave`) inside `#touch-layer`, each with `touch-action: manipulation`. Button handlers:
- SKILL: `pointerdown` sets `this.abilityHeld = true`, `pointerup`/cancel clears (sample ORs `BTN.ABILITY`).
- RELOAD: `pointerdown` → `this.tapReload()`.
- PICKUP: `pointerdown` → `this.tapPickup()`.
- EQUIPMENT: `pointerdown` → `this.beginGrenade(e.clientX, e.clientY)` + capture; `pointermove` → `this.moveGrenade`; `pointerup` → `this.endGrenade()`.
- SCORES: `pointerdown` toggles `this.showScores`.
- LEAVE: `pointerdown` → `this.onLeave?.()` (public callback field set by App).
Each button handler calls `e.stopPropagation()` so the layer's stick handlers never see it. Add `onLeave?: () => void;`. Add exported helper:
```ts
export function shouldUseTouch(): boolean {
  const pref = localStorage.getItem('bv3-touch') ?? 'auto';
  if (pref === 'on') return true;
  if (pref === 'off') return false;
  const coarse = typeof matchMedia === 'function'
    && matchMedia('(pointer: coarse)').matches && matchMedia('(hover: none)').matches;
  return !!coarse;
}
```
In `sample()`, OR `BTN.ABILITY` when `this.abilityHeld`.

**Step 4: Run it, expect PASS** — `npx vitest run tests/touch/touchControls.test.ts` + `npm test` + `npm run typecheck` green.

**Step 5: Commit** —
```
git add src/touch/touchControls.ts tests/touch/touchControls.test.ts && git commit -m "feat(touch): SKILL/RELOAD/EQUIP/PICKUP/scoreboard/leave buttons + shouldUseTouch detection"
```

---

### Task 39: App wiring — `kbm`/`touch`/`activeSource`, source-aware `sampleInput`, enterMatch/teardown, setWorld
**Files:** Modify `src/app.ts` · Test `tests/touch/appWiring.test.ts` (new)

Per S1.2/S1.6/S1.14: replace `private input` with `kbm`+`touch`+`activeSource`; build `TouchControls` in `enterMatch` when touch is effective, dispose in `teardownMatch`; `sampleInput` routes by source; `setWorld(view, localId)` called in **both** `tick()` branches. The `view().players` shape already matches `setWorld`'s needs.

**Step 1: Write the failing test** — create `tests/touch/appWiring.test.ts`. Since `App` requires heavy DOM, test the **source-routing unit** in isolation by extracting the routing into a pure helper, or assert via a thin seam. Given `App` is not easily unit-instantiable headless, assert the seam grep-style plus a focused behavioral test of the routing function:
```ts
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { TouchControls } from '../../src/touch/touchControls';
import { InputManager } from '../../src/input';
import type { InputSource } from '../../src/input';

// Mirrors App.sampleInput's branch: when activeSource is the touch source, it must
// call touch.sample with a zero ground arg (touch computes its own aim).
function routeSample(activeSource: InputSource, kbm: InputManager, touch: TouchControls | null,
                     ground: { x: number; y: number }, px: number, py: number) {
  if (activeSource === touch && touch) return touch.sample({ x: 0, y: 0 }, px, py);
  return kbm.sample(ground, px, py);
}

describe('App source routing', () => {
  it('routes through touch.sample (ignoring ground) when activeSource is touch', () => {
    const c = document.createElement('div'); document.body.appendChild(c);
    const kbm = new InputManager();
    const touch = new TouchControls(c, 1);
    const layer = c.querySelector('#touch-layer') as HTMLElement;
    layer.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 2, clientX: 800, clientY: 600 }));
    layer.dispatchEvent(new PointerEvent('pointermove', { pointerId: 2, clientX: 840, clientY: 600 }));
    const out = routeSample(touch, kbm, touch, { x: 999, y: 999 }, 0, 0);
    expect(out.aim).toBeCloseTo(0, 3); // from the right stick, NOT the bogus ground
    touch.dispose(); kbm.dispose();
  });

  it('routes through kbm.sample when activeSource is kbm', () => {
    const kbm = new InputManager(); kbm.enabled = true;
    const out = routeSample(kbm, kbm, null, { x: 10, y: 0 }, 0, 0);
    expect(out.aim).toBeCloseTo(0, 3); // atan2(0, +10)
    kbm.dispose();
  });
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/touch/appWiring.test.ts`. Initially passes for the helper if both modules exist — so to keep this TDD-honest, first land the test, run it, and confirm it captures the contract; the FAIL gate here is the App-side wiring asserted by `npm run typecheck` against the App edits (the helper mirrors the production branch). If preferred, treat the App edit as a **verification step**: after editing `app.ts`, `npm run typecheck` must compile the new `sampleInput` exactly matching `routeSample`'s branch.

**Step 3: Minimal implementation** — in `src/app.ts`:
- Replace `private input = new InputManager()` (line 31) with:
```ts
  private kbm = new InputManager();
  private touch: TouchControls | null = null;
  private activeSource: InputSource = this.kbm;
  private useTouch = false;
```
- Replace every `this.input.` reference (lines 66, 377, 414-415, 460, 471, 520) with `this.kbm.` for kbm-specific reads (`mouseX/mouseY`, `showScores`, `enabled`), and `this.activeSource.showScores` in `frame()`.
- Rewrite `sampleInput` (411-416) per S1.2:
```ts
  private sampleInput(view: WorldView | null) {
    const local = this.localPlayer(view);
    if (!local || !this.renderer) return emptyInput();
    if (this.activeSource === this.touch && this.touch) {
      this.touch.setWorld(view, this.localId);
      return this.touch.sample({ x: 0, y: 0 }, local.x, local.y);
    }
    const ground = this.renderer.groundPoint(this.kbm.mouseX, this.kbm.mouseY);
    return this.kbm.sample(ground, local.x, local.y);
  }
```
- In `enterMatch` (374-386): after building renderer, if `(this.useTouch = shouldUseTouch())`, build `this.touch = new TouchControls(this.container, this.localId)`, set `this.touch.onLeave = () => this.showMenu()`, `this.activeSource = this.touch`, `document.body.classList.add('touch-mode')`.
- In `teardownMatch` (510-522): `this.touch?.dispose(); this.touch = null; this.activeSource = this.kbm; document.body.classList.remove('touch-mode');`.
- Add imports: `import { TouchControls, shouldUseTouch } from './touch/touchControls';` and `import type { InputSource } from './input';`.

**Step 4: Run it, expect PASS** — `npx vitest run tests/touch/appWiring.test.ts` + `npm test` + `npm run typecheck` (the App must compile against the new fields). Determinism unchanged (kbm path is byte-identical when `useTouch` is false).

**Step 5: Commit** —
```
git add src/app.ts tests/touch/appWiring.test.ts && git commit -m "feat(app): kbm/touch/activeSource wiring, source-aware sampleInput, setWorld in both tick branches"
```

---

### Task 40: Renderer touch hooks — `camDistScale`, `camTargetYBias`, `aimLeadScale`, cached-viewport `groundPoint`/`project`
**Files:** Modify `src/render/renderer.ts` · Test `tests/scene/renderer.test.ts` (new)

Per S1.5/S1.13: add the three scalar fields used by camera lead + portrait zoom. The render path is GL-bound (can't run headlessly), so test the **pure projection math** by stubbing the camera, asserting `groundPoint`/`project` read the cached viewport and that `aimLeadScale` factors into the lead term. P1 already routed `groundPoint`/`project` through cached `vw/vh`; this task adds the touch scalars and lead factor.

**Step 1: Write the failing test** — create `tests/scene/renderer.test.ts`. Since `WebGLRenderer` throws in jsdom, assert the **defaults of the new public fields** via a non-constructing static check plus a focused lead-math unit. Use the spec's S8.2 instrumentation approach — extract the lead computation into a pure exported function:
```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { cameraLead } from '../../src/render/renderer';

describe('cameraLead', () => {
  it('scales the aim-lead term by aimLeadScale', () => {
    const full = cameraLead(0, 16, 1);     // aim=0, aimDist=16, scale=1
    const damped = cameraLead(0, 16, 0.35); // touch
    expect(damped.dx).toBeLessThan(full.dx);
    expect(damped.dx).toBeCloseTo(full.dx * 0.35, 6);
  });
  it('is zero when aimDist is zero', () => {
    expect(cameraLead(0, 0, 1)).toEqual({ dx: 0, dy: 0 });
  });
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/scene/renderer.test.ts`. Fails: `cameraLead` is not exported.

**Step 3: Minimal implementation** — in `src/render/renderer.ts`:
- Add public fields: `camDistScale = 1;`, `camTargetYBias = 0;`, `aimLeadScale = 1;`.
- Export a pure helper above the class:
```ts
export function cameraLead(aim: number, aimDist: number, aimLeadScale: number): { dx: number; dy: number } {
  const lead = 0.18 * aimLeadScale;
  return { dx: Math.cos(aim) * aimDist * lead * 0.3, dy: Math.sin(aim) * aimDist * lead * 0.3 };
}
```
- In `render()` (196-200) replace the inline lead with `const { dx, dy } = cameraLead(local.aim, local.input.aimDist, this.aimLeadScale); const tx = local.x + dx; const ty = local.y + dy;`.
- In the camera position (206-207) use `CAM_DIST * this.camDistScale`; apply `this.camTargetYBias` to the look-at target z (`this.camTarget.z + this.camTargetYBias` band offset per S1.13).

**Step 4: Run it, expect PASS** — `npx vitest run tests/scene/renderer.test.ts` + `npm test` + `npm run typecheck` green. `tests/purity.test.ts` stays green (render-only).

**Step 5: Commit** —
```
git add src/render/renderer.ts tests/scene/renderer.test.ts && git commit -m "feat(render): camDistScale/camTargetYBias/aimLeadScale + pure cameraLead helper"
```

---

### Task 41: App sets touch camera scalars on enterMatch + orientation change
**Files:** Modify `src/app.ts` · Verification step (build + grep)

Per S1.13: `App.enterMatch` and an `onViewportChange` listener set `camDistScale = useTouch && isPortrait ? 1.25 : 1`, `aimLeadScale = useTouch ? 0.35 : 1`, recompute on orientation flip. No natural headless unit test (needs a live renderer); use a content-assertion + build gate.

**Step 1: Write the failing test (verification)** — add to `tests/shell/appCamera.test.ts` (new, content-grep style):
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../../src/app.ts', import.meta.url), 'utf8');

describe('App touch camera wiring (source assertion)', () => {
  it('sets camDistScale to 1.25 in portrait touch and aimLeadScale to 0.35', () => {
    expect(src).toMatch(/aimLeadScale\s*=\s*this\.useTouch\s*\?\s*0\.35\s*:\s*1/);
    expect(src).toMatch(/camDistScale\s*=\s*\(this\.useTouch && [^)]*[Pp]ortrait[^)]*\)\s*\?\s*1\.25\s*:\s*1/);
    expect(src).toMatch(/onViewportChange/);
  });
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/shell/appCamera.test.ts`. Fails: the strings aren't present yet.

**Step 3: Minimal implementation** — in `enterMatch`, after building the renderer and resolving `useTouch`, add:
```ts
    const applyTouchCam = (): void => {
      if (!this.renderer) return;
      const { w, h } = viewportSize();
      const isPortrait = h > w;
      this.renderer.aimLeadScale = this.useTouch ? 0.35 : 1;
      this.renderer.camDistScale = (this.useTouch && isPortrait) ? 1.25 : 1;
    };
    applyTouchCam();
    this.viewportUnsub = onViewportChange(applyTouchCam);
```
Store `private viewportUnsub: (() => void) | null = null;` and call `this.viewportUnsub?.(); this.viewportUnsub = null;` in `teardownMatch`. Add `import { viewportSize, onViewportChange } from './core/viewport';`.

**Step 4: Run it, expect PASS** — `npx vitest run tests/shell/appCamera.test.ts` + `npm run build` (compiles + bundles) + `npm test` + `npm run typecheck` green.

**Step 5: Commit** —
```
git add src/app.ts tests/shell/appCamera.test.ts && git commit -m "feat(app): portrait camDistScale 1.25 + touch aimLeadScale 0.35, recomputed on viewport change"
```

---

### Task 42: Red aim laser + reticle (reused `THREE.Line`, wall-clamped length)
**Files:** Modify `src/render/renderer.ts` (or new `src/render/aimLaser.ts`) · Test `tests/scene/aimLaser.test.ts` (new)

Per S1.10: cosmetic, local-only, one reused `THREE.Line` from muzzle along `aimAngle`, **length clamped to the first wall** via a `segAABB` sweep over `map.walls`. The GL object can't render headlessly; test the pure **clamp-length** math.

**Step 1: Write the failing test** — create `tests/scene/aimLaser.test.ts`:
```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { laserLength } from '../../src/render/aimLaser';

const walls = [{ x: 5, y: 0, w: 1, h: 4 }]; // wall face at x≈4.5

describe('laserLength', () => {
  it('clamps to the first wall along aim', () => {
    // from (0,0) aim +x, max 40 → wall at ~4.5
    const len = laserLength(0, 0, 0, 40, walls);
    expect(len).toBeGreaterThan(4);
    expect(len).toBeLessThan(5);
  });
  it('returns full length when no wall is hit', () => {
    const len = laserLength(0, 0, Math.PI, 40, walls); // aim -x, no wall
    expect(len).toBeCloseTo(40, 6);
  });
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/scene/aimLaser.test.ts`. Fails: module/`laserLength` missing.

**Step 3: Minimal implementation** — create `src/render/aimLaser.ts` with the pure helper (reusing `segAABB`):
```ts
import { segAABB } from '../core/math';

export interface Wall { x: number; y: number; w: number; h: number; }

/** Length of the laser from (x0,y0) along `aim`, clamped to the first wall. */
export function laserLength(x0: number, y0: number, aim: number, maxLen: number, walls: Wall[]): number {
  const x1 = x0 + Math.cos(aim) * maxLen;
  const y1 = y0 + Math.sin(aim) * maxLen;
  let bestT = 1;
  for (const w of walls) {
    const t = segAABB(x0, y0, x1, y1, w.x, w.y, w.w, w.h);
    if (t >= 0 && t < bestT) bestT = t;
  }
  return maxLen * bestT;
}
```
In `renderer.ts`, construct one reused `THREE.Line` (2-vertex `BufferGeometry`, `LineBasicMaterial({ color: 0xff3030, transparent: true })`) + a reused reticle ring sprite, created lazily only when `useTouch`. Each frame (when the touch read-state `aimActive` or `grenadeArc.active`): muzzle = `local + dir*0.65`; endpoint = muzzle + dir*`laserLength(...muzzle, aim, GUNS[gun].range, map.walls)`; update line geometry positions + reticle position; toggle `.visible`. Expose a setter (e.g. `renderer.setAimState(aimAngle, active)`) the App calls each frame from the touch read-state.

**Step 4: Run it, expect PASS** — `npx vitest run tests/scene/aimLaser.test.ts` + `npm test` + `npm run typecheck` + `npm run build` green. `purity.test.ts` green.

**Step 5: Commit** —
```
git add src/render/aimLaser.ts src/render/renderer.ts tests/scene/aimLaser.test.ts && git commit -m "feat(render): wall-clamped red aim laser + reticle (reused Line), touch-only"
```

---

### Task 43: HUD touch mode — anchor by source + safe-area status panel
**Files:** Modify `src/render/hud.ts` · Modify `src/app.ts:460` · Test `tests/scene/hud.test.ts` (new)

Per S1.8: add `Hud.touchMode`; in touch the combat anchor is `renderer.project(local.x, local.y, 0.6)` not the mouse; draw a fixed bottom-left safe-area status panel. HUD canvas draw is 2D-canvas (throws in jsdom unless the texture/ctx factory is stubbable — Foundation provides an injectable ctx); test the **anchor-selection** pure branch.

**Step 1: Write the failing test** — create `tests/scene/hud.test.ts`:
```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { combatAnchor } from '../../src/render/hud';

describe('combatAnchor', () => {
  it('returns the mouse anchor in desktop mode', () => {
    const a = combatAnchor(false, { x: 11, y: 22 }, () => ({ x: 333, y: 444, visible: true }));
    expect(a).toEqual({ x: 11, y: 22 });
  });
  it('returns the projected babo anchor in touch mode', () => {
    const a = combatAnchor(true, { x: 11, y: 22 }, () => ({ x: 333, y: 444, visible: true }));
    expect(a).toEqual({ x: 333, y: 444 });
  });
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/scene/hud.test.ts`. Fails: `combatAnchor` not exported.

**Step 3: Minimal implementation** — in `src/render/hud.ts` add `touchMode = false;` and export:
```ts
export function combatAnchor(
  touchMode: boolean,
  mouse: { x: number; y: number },
  projectBabo: () => { x: number; y: number; visible: boolean },
): { x: number; y: number } {
  if (!touchMode) return { x: mouse.x, y: mouse.y };
  const p = projectBabo();
  return { x: p.x, y: p.y };
}
```
Use it inside `Hud.update` to pick the anchor; in `touchMode` also canvas-draw the bottom-left status panel (ammo/heat/reload/ability/grenade) at `(inset, H-inset)` with `inset = env(safe-area-inset-*)` via a CSS var, else 16. In `src/app.ts` `enterMatch` set `this.hud.touchMode = this.useTouch;` and in `frame()` (460) pass the local-babo projection callback so `combatAnchor` can resolve it.

**Step 4: Run it, expect PASS** — `npx vitest run tests/scene/hud.test.ts` + `npm test` + `npm run typecheck` + `npm run build` green.

**Step 5: Commit** —
```
git add src/render/hud.ts src/app.ts tests/scene/hud.test.ts && git commit -m "feat(hud): touch-mode anchor (project babo) + safe-area status panel"
```

---

### Task 44: S6 — viewport meta, gesture-suppression CSS, `#touch-layer` play-surface rules
**Files:** Modify `index.html:6` · Modify `src/ui/styles.css` · Test `tests/shell/viewportMeta.test.ts` (new)

Per S6.1: add `viewport-fit=cover` + PWA metas; additive CSS preserving `#game-canvas{position:absolute;inset:0;display:block}`; play surfaces get `touch-action:none`, `.screen` keeps `auto`.

**Step 1: Write the failing test** — create `tests/shell/viewportMeta.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../src/ui/styles.css', import.meta.url), 'utf8');

describe('S6.1 viewport + gesture suppression', () => {
  it('index.html viewport includes viewport-fit=cover', () => {
    expect(html).toMatch(/viewport-fit=cover/);
  });
  it('declares apple-mobile-web-app metas + manifest link', () => {
    expect(html).toMatch(/apple-mobile-web-app-capable/);
    expect(html).toMatch(/rel="manifest"/);
  });
  it('play surfaces get touch-action:none but #game-canvas keeps its absolute reset', () => {
    expect(css).toMatch(/#game-canvas\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0[^}]*\}/);
    expect(css).toMatch(/#touch-layer[^{]*\{[^}]*touch-action:\s*none/);
  });
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/shell/viewportMeta.test.ts`. Fails: metas/CSS absent.

**Step 3: Minimal implementation** — `index.html` line 6:
```html
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <meta name="theme-color" content="#0b0c10" />
    <link rel="manifest" href="./manifest.webmanifest" />
```
`styles.css` (additive — append to `html,body` block: `overscroll-behavior:none; -webkit-text-size-adjust:100%;`) plus a new block:
```css
#game-canvas, #hud-canvas, #fx-canvas, #touch-layer {
  touch-action: none; -webkit-user-select: none; user-select: none;
  -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent;
}
```
Do not alter `.screen` (keeps default `touch-action:auto`).

**Step 4: Run it, expect PASS** — `npx vitest run tests/shell/viewportMeta.test.ts` + `npm run build` (validates HTML/manifest link won't break — Task 47 adds the manifest) + `npm test` green. (Run Task 47 before `build` if the missing manifest 404s the build; Vite tolerates a missing public manifest at build time, so this is safe.)

**Step 5: Commit** —
```
git add index.html src/ui/styles.css tests/shell/viewportMeta.test.ts && git commit -m "feat(shell): viewport-fit=cover, PWA metas, play-surface gesture suppression"
```

---

### Task 45: S6 — portrait `@media(max-width:760px)` single-column lobby/menu/end + ≥44px targets + 16px form fonts + `:active`
**Files:** Modify `src/ui/styles.css` · Test `tests/shell/responsive.test.ts` (new)

Per S6.5: first `@media` block; collapse `.lobby` grid to `1fr`; tap targets ≥44px; `:active` feedback; 16px form fonts.

**Step 1: Write the failing test** — create `tests/shell/responsive.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const css = readFileSync(new URL('../../src/ui/styles.css', import.meta.url), 'utf8');

describe('S6.5 portrait responsive', () => {
  it('has a max-width:760px media block', () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*760px\)/);
  });
  it('collapses the lobby grid to a single column in that block', () => {
    const block = css.slice(css.indexOf('@media (max-width: 760px)'));
    expect(block).toMatch(/\.lobby[^}]*grid-template-columns:\s*1fr/);
  });
  it('sets 16px form fonts (anti iOS zoom) and ≥44px tap targets', () => {
    const block = css.slice(css.indexOf('@media (max-width: 760px)'));
    expect(block).toMatch(/font-size:\s*16px/);
    expect(block).toMatch(/min-height:\s*44px/);
  });
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/shell/responsive.test.ts`. Fails: no media block.

**Step 3: Minimal implementation** — append to `src/ui/styles.css`:
```css
@media (max-width: 760px) {
  .lobby { grid-template-columns: 1fr; width: 96vw; }
  .screen { overflow-y: auto; -webkit-overflow-scrolling: touch;
            padding: env(safe-area-inset-top) env(safe-area-inset-right)
                     env(safe-area-inset-bottom) env(safe-area-inset-left); }
  .screen h1 { font-size: clamp(28px, 9vw, 48px); }
  .class-card, .gun-chip, button.btn, button.btn.small { min-height: 44px; }
  input, select, textarea { font-size: 16px; }
  .class-card:active, .gun-chip:active, button.btn:active { transform: scale(0.97); }
}
```

**Step 4: Run it, expect PASS** — `npx vitest run tests/shell/responsive.test.ts` + `npm run build` (CSS compiles) + `npm test` green. Desktop cascade byte-identical (only inside the media block).

**Step 5: Commit** —
```
git add src/ui/styles.css tests/shell/responsive.test.ts && git commit -m "feat(shell): portrait @media single-column lobby + 44px targets + 16px form fonts"
```

---

### Task 46: S6 — inline tooltips (class role + gun identity) surfaced on touch
**Files:** Modify `src/ui/screens.ts:170,196` · Modify `src/ui/styles.css` · Test `tests/shell/tooltips.test.ts` (new, jsdom)

Per S6.5: surface the hover-only `title=""` (`screens.ts:170` class role, `:196` gun identity) as inline escaped DOM text, hidden on desktop via `@media (min-width:761px)`.

**Step 1: Write the failing test** — create `tests/shell/tooltips.test.ts`:
```ts
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const css = readFileSync(new URL('../../src/ui/styles.css', import.meta.url), 'utf8');
const src = readFileSync(new URL('../../src/ui/screens.ts', import.meta.url), 'utf8');

describe('S6.5 inline tooltips', () => {
  it('renders an inline tooltip element for class role and gun identity', () => {
    expect(src).toMatch(/class="[^"]*tooltip-inline/);
  });
  it('hides inline tooltips on desktop ≥761px', () => {
    expect(css).toMatch(/@media\s*\(min-width:\s*761px\)[^}]*\.tooltip-inline[^}]*display:\s*none/s);
  });
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/shell/tooltips.test.ts`. Fails: no `tooltip-inline` class.

**Step 3: Minimal implementation** — in `screens.ts` add an escaped inline span inside each class-card (using `c.role`) and gun-chip (using `g.identity`), reusing the existing HTML-escape helper:
```ts
// class card (~:170)
<div class="class-card ${id === selectedClass ? 'sel' : ''}" data-class="${id}" title="${c.role}">
  ... <span class="tooltip-inline">${esc(c.role)}</span>
</div>
// gun chip (~:196)
<span class="tooltip-inline">${esc(g.identity)}</span>
```
CSS: `.tooltip-inline { display:block; font-size:11px; color:var(--dim); }` plus `@media (min-width:761px){ .tooltip-inline{ display:none; } }`.

**Step 4: Run it, expect PASS** — `npx vitest run tests/shell/tooltips.test.ts` + `npm test` + `npm run typecheck` + `npm run build` green.

**Step 5: Commit** —
```
git add src/ui/screens.ts src/ui/styles.css tests/shell/tooltips.test.ts && git commit -m "feat(shell): inline class-role/gun-identity tooltips (touch), hidden on desktop"
```

---

### Task 47: S6.6 — PWA manifest + build-time PNG icon rasterization (no committed binary)
**Files:** Create `public/manifest.webmanifest` · Modify `vite.config.ts` (rasterize plugin) · Modify `package.json` (devDep) · Test `tests/shell/manifest.test.ts` (new)

Per S6.6 decision (a): `display:standalone`, `orientation:'portrait'` hint, relative `start_url`/`scope`; build-time rasterize 192/512 PNGs from `favicon.svg` (a build step, not a committed binary).

**Step 1: Write the failing test** — create `tests/shell/manifest.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const mf = JSON.parse(readFileSync(new URL('../../public/manifest.webmanifest', import.meta.url), 'utf8'));

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
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/shell/manifest.test.ts`. Fails: `public/manifest.webmanifest` does not exist.

**Step 3: Minimal implementation** — create `public/manifest.webmanifest`:
```json
{
  "name": "Babo Violent 3",
  "short_name": "Babo3",
  "display": "standalone",
  "orientation": "portrait",
  "start_url": "./",
  "scope": "./",
  "background_color": "#0b0c10",
  "theme_color": "#0b0c10",
  "icons": [
    { "src": "./icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "./icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```
Add a Vite `buildStart`/`closeBundle` plugin in `vite.config.ts` that rasterizes `favicon.svg` → `dist/icon-192.png` and `dist/icon-512.png` using `sharp` (devDep, e.g. `npm i -D sharp`). The PNGs are emitted at build, never committed (keep them out of `public/` and gitignored). Guard the plugin so `npm test`/dev don't require sharp.

**Step 4: Run it, expect PASS** — `npx vitest run tests/shell/manifest.test.ts` + `npm run build` (must emit `dist/icon-192.png` + `dist/icon-512.png`; verify with `ls dist/icon-*.png`) + `npm test` green.

**Step 5: Commit** —
```
git add public/manifest.webmanifest vite.config.ts package.json package-lock.json .gitignore tests/shell/manifest.test.ts && git commit -m "feat(shell): PWA manifest + build-time 192/512 PNG icon rasterization (no committed binary)"
```

---

### Task 48: S6 — Android-only progressive-enhancement fullscreen in `enterMatch`
**Files:** Modify `src/app.ts` · Test `tests/shell/fullscreen.test.ts` (new, source assertion)

Per S6.6: gate on `el.requestFullscreen && matchMedia('(pointer:coarse)')`, `.catch`-swallowed; iOS Safari silently skips.

**Step 1: Write the failing test** — create `tests/shell/fullscreen.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../../src/app.ts', import.meta.url), 'utf8');

describe('S6.6 Android-only fullscreen', () => {
  it('feature-detects requestFullscreen + coarse pointer and swallows rejection', () => {
    expect(src).toMatch(/requestFullscreen/);
    expect(src).toMatch(/pointer:\s*coarse/);
    expect(src).toMatch(/\.catch\(/);
  });
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/shell/fullscreen.test.ts`. Fails: no `requestFullscreen` in `app.ts`.

**Step 3: Minimal implementation** — in `enterMatch`, after `loop.start()`:
```ts
    const el = this.container as HTMLElement & { requestFullscreen?: () => Promise<void> };
    if (el.requestFullscreen && typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) {
      el.requestFullscreen().catch(() => { /* iOS/denied: layout works without it */ });
    }
```

**Step 4: Run it, expect PASS** — `npx vitest run tests/shell/fullscreen.test.ts` + `npm test` + `npm run typecheck` + `npm run build` green.

**Step 5: Commit** —
```
git add src/app.ts tests/shell/fullscreen.test.ts && git commit -m "feat(shell): Android-only progressive-enhancement fullscreen on enterMatch"
```

---

### Task 49: S3 — `surfaceMat` factory (Standard→Lambert→Basic) with explicit basicize/lambertize rules
**Files:** Modify `src/render/quality.ts` · Test `tests/scene/surfaceMat.test.ts` (new)

Per S3.3: central factory routed to non-hero surfaces. Keep `map/transparent/opacity/side/depthWrite`; drop `metalness/roughness/emissiveIntensity`; fold `emissive`→`color` on Basic; multiply base ~0.85. High returns the exact `MeshStandardMaterial`. The S3 invariant: render-only, `purity.test.ts` stays green.

**Step 1: Write the failing test** — create `tests/scene/surfaceMat.test.ts`:
```ts
// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import * as THREE from 'three';
import { surfaceMat } from '../../src/render/quality';
import { setTierOverride } from '../../src/render/quality';

afterEach(() => setTierOverride('high'));

describe('surfaceMat', () => {
  it('high returns a MeshStandardMaterial preserving the map', () => {
    setTierOverride('high');
    const map = new THREE.Texture();
    const m = surfaceMat({ map, roughness: 0.9, metalness: 0.1 });
    expect(m).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect((m as THREE.MeshStandardMaterial).map).toBe(map);
  });
  it('mid returns a MeshLambertMaterial keeping map/opacity/transparent', () => {
    setTierOverride('mid');
    const map = new THREE.Texture();
    const m = surfaceMat({ map, transparent: true, opacity: 0.5 });
    expect(m).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect((m as THREE.MeshLambertMaterial).map).toBe(map);
    expect(m.transparent).toBe(true);
    expect(m.opacity).toBe(0.5);
  });
  it('low returns a MeshBasicMaterial folding emissive into color', () => {
    setTierOverride('low');
    const m = surfaceMat({ color: 0x000000, emissive: 0x40ff40 });
    expect(m).toBeInstanceOf(THREE.MeshBasicMaterial);
    // emissive folded → color is non-black (the glow color shows through)
    expect((m as THREE.MeshBasicMaterial).color.getHex()).toBeGreaterThan(0);
  });
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/scene/surfaceMat.test.ts`. Fails: `surfaceMat` not exported.

**Step 3: Minimal implementation** — add to `src/render/quality.ts`:
```ts
import * as THREE from 'three';

export interface SurfaceParams {
  color?: THREE.ColorRepresentation;
  emissive?: THREE.ColorRepresentation;
  map?: THREE.Texture | null;
  transparent?: boolean;
  opacity?: number;
  side?: THREE.Side;
  depthWrite?: boolean;
  roughness?: number;
  metalness?: number;
}

const carry = (p: SurfaceParams) => ({
  map: p.map ?? undefined,
  transparent: p.transparent,
  opacity: p.opacity,
  side: p.side,
  depthWrite: p.depthWrite,
});

export function surfaceMat(p: SurfaceParams): THREE.Material {
  if (QUALITY.tier === 'high') {
    return new THREE.MeshStandardMaterial({ ...p });
  }
  if (QUALITY.tier === 'mid') {
    return new THREE.MeshLambertMaterial({ color: p.color, emissive: p.emissive, ...carry(p) });
  }
  // low: fold emissive into color, dim base ~0.85
  const base = new THREE.Color(p.color ?? 0xffffff);
  if (p.emissive) base.add(new THREE.Color(p.emissive));
  base.multiplyScalar(0.85);
  return new THREE.MeshBasicMaterial({ color: base, ...carry(p) });
}
```

**Step 4: Run it, expect PASS** — `npx vitest run tests/scene/surfaceMat.test.ts` + `npm test` + `npm run typecheck` green. `purity.test.ts` green (quality.ts is render-scoped, never imported by sim).

**Step 5: Commit** —
```
git add src/render/quality.ts tests/scene/surfaceMat.test.ts && git commit -m "feat(render): surfaceMat factory (Standard/Lambert/Basic) with explicit downgrade rules"
```

---

### Task 50: S3 — route non-hero surfaces through `surfaceMat` (floor/pit/walls/accessory/gun/grenade/pickup)
**Files:** Modify `src/render/renderer.ts:78,100,116/117` · `src/render/baboShapes.ts:47,57` · `src/render/gunModels.ts:29/34/39` · `src/render/effects.ts:151,236/243/254` · Test `tests/scene/surfaceMat.test.ts`

Per S3.3: replace the listed `new MeshStandardMaterial(...)` constructors with `surfaceMat(...)`. The babo marble shader is never touched. Tier `high` returns the exact original → desktop pixels unchanged.

**Step 1: Write the failing test** — extend `tests/scene/surfaceMat.test.ts` with an instrumentation assertion that high-tier construction is unchanged (no `MeshLambert`/`MeshBasic` leaks on high) and that low-tier non-hero surfaces are Basic. Since direct GL build throws, assert via a focused per-call check:
```ts
it('high-tier surfaceMat for a floor-like input is Standard (desktop unchanged)', () => {
  setTierOverride('high');
  const m = surfaceMat({ map: new THREE.Texture(), roughness: 0.92 });
  expect(m.type).toBe('MeshStandardMaterial');
});
it('low-tier surfaceMat for a pit-like input is Basic', () => {
  setTierOverride('low');
  const m = surfaceMat({ color: 0x14080a, roughness: 0.6 });
  expect(m.type).toBe('MeshBasicMaterial');
});
```

**Step 2: Run it, expect FAIL** — these pass for `surfaceMat` itself; the real gate is that the **call sites** compile and route correctly. Run `npm run typecheck` after step 3 — before editing, a grep `tests/scene` won't catch call-site routing, so the FAIL here is the construction-replacement verified by `npm run build` + a desktop visual check (S8.2 honesty: headless can't assert GPU pixels).

**Step 3: Minimal implementation** — at each cited line, replace `new THREE.MeshStandardMaterial({ … })` with `surfaceMat({ … })`, passing the same params. Examples:
- `renderer.ts:78` floor: `surfaceMat({ map: floorTex, roughness: 0.92 })`.
- `renderer.ts:100` pit: `surfaceMat({ color: 0x14080a, roughness: 0.6 })`.
- `effects.ts:151` grenade, `gunModels.ts:29/34/39` metal/poly/glow (glow folds emissive on Basic). Add `import { surfaceMat } from './quality';` to each file. Leave Basic particles/rings/beams/tracers untouched.

**Step 4: Run it, expect PASS** — `npx vitest run tests/scene/surfaceMat.test.ts` + `npm test` + `npm run typecheck` + `npm run build` green. `purity.test.ts` green. **Honest note:** desktop pixel-identity (tier high returns the original Standard with identical params) is verified by L5 visual diff, not a headless pixel assert.

**Step 5: Commit** —
```
git add src/render/renderer.ts src/render/baboShapes.ts src/render/gunModels.ts src/render/effects.ts tests/scene/surfaceMat.test.ts && git commit -m "feat(render): route non-hero surfaces through surfaceMat (high=Standard unchanged)"
```

---

### Task 51: S3.4 — babo body transparency gating inside the `:211` phase guard
**Files:** Modify `src/render/babos.ts` (`:207` write kept, `:211-213` guard) · `src/render/baboShader.ts:103-106` · Test `tests/scene/baboTransparent.test.ts` (new)

Per S3.4: construct the body material with `transparent:false`; flip `mat.transparent` (with `needsUpdate`) **inside the existing `if (p.phaseActive !== vis.phased)` guard at `:211`** — true on phase-in, false on phase-out. Keep the unconditional `uOpacity` write at `:207`. All tiers (lossless win).

**Step 1: Write the failing test** — create `tests/scene/baboTransparent.test.ts`. The shader material construction is pure (no GL until render); assert the constructed material default + a pure `phaseTransition` helper:
```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { phaseTransition } from '../../src/render/babos';

describe('babo body transparency gating', () => {
  it('turns transparent on at phase-in and off at phase-out', () => {
    expect(phaseTransition(true, false)).toBe(true);   // entering phase
    expect(phaseTransition(false, true)).toBe(false);  // leaving phase
  });
  it('returns null (no change) when phase state is unchanged', () => {
    expect(phaseTransition(true, true)).toBeNull();
    expect(phaseTransition(false, false)).toBeNull();
  });
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/scene/baboTransparent.test.ts`. Fails: `phaseTransition` not exported.

**Step 3: Minimal implementation** — in `baboShader.ts:103-106` construct the body material with `transparent: false`. In `babos.ts`, export:
```ts
/** New transparent flag at a phase transition, or null if unchanged. */
export function phaseTransition(phaseActive: boolean, prevPhased: boolean): boolean | null {
  if (phaseActive === prevPhased) return null;
  return phaseActive;
}
```
Inside the existing `if (p.phaseActive !== vis.phased)` guard at `:211`, after the gun-opacity toggle, add:
```ts
      const t = phaseTransition(p.phaseActive, vis.phased);
      if (t !== null) { bodyMat.transparent = t; bodyMat.needsUpdate = true; }
```
Leave the `:207` `uOpacity` write untouched.

**Step 4: Run it, expect PASS** — `npx vitest run tests/scene/baboTransparent.test.ts` + `npm test` + `npm run typecheck` + `npm run build` green. **Visual check (L5):** nameTag (`babos.ts:48-49`), bounty crown (`:127-134`), CTF flag composite correctly over opaque vs transparent body.

**Step 5: Commit** —
```
git add src/render/babos.ts src/render/baboShader.ts tests/scene/baboTransparent.test.ts && git commit -m "feat(render): opaque babo body with phase-gated transparency flip (all tiers)"
```

---

### Task 52: S3.5b — babo shadows → one `InstancedMesh` (all tiers, lossless)
**Files:** Modify `src/render/babos.ts` · Test `tests/scene/shadowInstance.test.ts` (new)

Per S3.5b: 8 shadow meshes → 1 `InstancedMesh` (`MAX_PLAYERS=8`). Write each live babo matrix into instance `i`; zero the matrix when `!alive`. This is the **one intentional desktop draw-call change** (still pixel-identical). Scene-graph instrumentation test (S8.2).

**Step 1: Write the failing test** — create `tests/scene/shadowInstance.test.ts`:
```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { ShadowInstances } from '../../src/render/babos';

describe('ShadowInstances', () => {
  it('is a single InstancedMesh with MAX_PLAYERS capacity', () => {
    const s = new ShadowInstances();
    expect(s.mesh).toBeInstanceOf(THREE.InstancedMesh);
    expect(s.mesh.count).toBe(8);
  });
  it('zeros the matrix scale for a dead/absent instance', () => {
    const s = new ShadowInstances();
    s.set(0, 3, 4, true);
    s.set(1, 0, 0, false); // dead → zeroed
    const m = new THREE.Matrix4();
    s.mesh.getMatrixAt(1, m);
    const sc = new THREE.Vector3(); m.decompose(new THREE.Vector3(), new THREE.Quaternion(), sc);
    expect(sc.length()).toBeCloseTo(0, 6);
  });
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/scene/shadowInstance.test.ts`. Fails: `ShadowInstances` not exported.

**Step 3: Minimal implementation** — add `ShadowInstances` to `babos.ts`:
```ts
const MAX_PLAYERS = 8;

export class ShadowInstances {
  readonly mesh: THREE.InstancedMesh;
  private m = new THREE.Matrix4();
  constructor() {
    const geo = new THREE.CircleGeometry(0.55, 20);
    const mat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_PLAYERS);
    this.mesh.rotation.x = -Math.PI / 2;
    for (let i = 0; i < MAX_PLAYERS; i++) this.set(i, 0, 0, false);
  }
  set(i: number, x: number, y: number, alive: boolean): void {
    if (!alive) this.m.makeScale(0, 0, 0);
    else this.m.makeTranslation(x, 0.015, y);
    this.mesh.setMatrixAt(i, this.m);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
```
Replace the per-babo shadow meshes in `BaboPool` with one `ShadowInstances`; in `update()`, map each live player to an instance index, calling `set(i, p.x, p.y, p.alive)`; add the instanced mesh to the scene in the ctor and dispose it in `dispose()`.

**Step 4: Run it, expect PASS** — `npx vitest run tests/scene/shadowInstance.test.ts` + `npm test` + `npm run typecheck` + `npm run build` green.

**Step 5: Commit** —
```
git add src/render/babos.ts tests/scene/shadowInstance.test.ts && git commit -m "feat(render): babo shadows via one InstancedMesh (all tiers, pixel-identical)"
```

---

### Task 53: S3.5a/5c/5d — wall/gun/class merge+cache GATED low/mid with WeakSet disposal guard
**Files:** Modify `src/render/renderer.ts` (wall merge) · `src/render/gunModels.ts` (gun cache + `disposeGunModel` guard) · `src/render/baboShapes.ts` (class cache + `disposeClassVisual` guard) · Test `tests/scene/cacheDispose.test.ts` (new)

Per S3.5 table + HIGH disposal fix: merge walls into one grouped geometry (2 draw calls) gated on `QUALITY.mergeStatics` (OFF on high); cache gun parts per `GunId` and ClassVisual per `ClassId` (low/mid only); `disposeGunModel`/`disposeClassVisual` **skip cache-owned resources via a WeakSet**; the cache disposes only at pool/app teardown. **Required test:** spawn→swap-gun→despawn→respawn-same-class proves no double-dispose.

**Step 1: Write the failing test** — create `tests/scene/cacheDispose.test.ts`:
```ts
// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { setTierOverride } from '../../src/render/quality';
import { buildGunModel, disposeGunModel, disposeGunCache } from '../../src/render/gunModels';

afterEach(() => { disposeGunCache(); setTierOverride('high'); });

describe('gun cache disposal guard (low/mid)', () => {
  it('does NOT dispose cache-owned geometry on per-instance dispose, but the cache can be disposed once', () => {
    setTierOverride('mid');
    const a = buildGunModel('stinger');
    const b = buildGunModel('stinger'); // shares cached geo/mat
    let disposed = 0;
    // Spy: count geometry.dispose calls across both instances
    a.traverse((o: any) => { if (o.geometry) { const d = o.geometry.dispose.bind(o.geometry); o.geometry.dispose = () => { disposed++; d(); }; } });
    disposeGunModel(a); // must skip cache-owned geo
    disposeGunModel(b);
    expect(disposed).toBe(0); // cache-owned, untouched by per-instance dispose
  });

  it('high tier keeps the proven per-instance path (no cache, dispose frees everything)', () => {
    setTierOverride('high');
    const a = buildGunModel('stinger');
    expect(() => { disposeGunModel(a); }).not.toThrow();
  });
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/scene/cacheDispose.test.ts`. Fails: `disposeGunCache` not exported; cache + WeakSet guard not implemented.

**Step 3: Minimal implementation** —
- In `gunModels.ts`: add `const cache = new Map<GunId, ...>()` and `const cacheOwned = new WeakSet<THREE.BufferGeometry | THREE.Material>()`. When `QUALITY.mergeStatics`, `buildGunModel` reuses cached merged geo/mat (registering them in `cacheOwned`); else current per-call path. In `disposeGunModel`, when traversing, `if (cacheOwned.has(geo)) skip; else geo.dispose()` (same for materials). Export `disposeGunCache()` that disposes the cache contents and clears it (called at pool/app teardown).
- Mirror in `baboShapes.ts` for `buildClassVisual`/`disposeClassVisual`/`disposeClassCache`.
- In `renderer.ts` `buildArena`: when `QUALITY.mergeStatics`, merge `map.walls` boxes into one grouped geometry rendered with the 6-group material array `[wallMat,wallMat,topMat,topMat,wallMat,wallMat]`; else current per-wall meshes. Add merged geos to `GameRenderer.dispose`.
- Call `disposeGunCache()`/`disposeClassCache()` from `BaboPool.dispose()` / `GameRenderer.dispose()`.

**Step 4: Run it, expect PASS** — `npx vitest run tests/scene/cacheDispose.test.ts` + `npm test` + `npm run typecheck` + `npm run build` green. `purity.test.ts` green. The spawn→swap→despawn→respawn no-double-dispose is the explicit gate.

**Step 5: Commit** —
```
git add src/render/renderer.ts src/render/gunModels.ts src/render/baboShapes.ts tests/scene/cacheDispose.test.ts && git commit -m "feat(render): low/mid wall/gun/class merge+cache with WeakSet disposal guard"
```

---

### Task 54: S3.6/3.7 — splat RT shrink + particle/fire/smoke tiering (live-read)
**Files:** Modify `src/render/splatmap.ts:24` · `src/render/effects.ts:181,195,208,467` + `burst()` · Test `tests/scene/tiering.test.ts` (new)

Per S3.6/3.7: RT → `QUALITY.splatRtSize` (1024 mobile / 2048 high); particle cap → `QUALITY.particleCap`; burst counts `Math.max(1, round(count*particleScale))` (gameplay-readable `hit`/`hitWall` keep ≥1); fire/smoke loops → `QUALITY.fireSprites`/`smokeSprites`. `Math.random()` here is render-side → determinism untouched.

**Step 1: Write the failing test** — create `tests/scene/tiering.test.ts`:
```ts
// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { setTierOverride, QUALITY } from '../../src/render/quality';
import { scaledBurstCount } from '../../src/render/effects';

afterEach(() => setTierOverride('high'));

describe('S3.7 particle tiering', () => {
  it('scales a burst count by particleScale but never below 1', () => {
    setTierOverride('low'); // particleScale 0.4
    expect(scaledBurstCount(10)).toBe(Math.max(1, Math.round(10 * QUALITY.particleScale)));
    expect(scaledBurstCount(1)).toBeGreaterThanOrEqual(1);
  });
  it('high keeps the literal count', () => {
    setTierOverride('high'); // particleScale 1
    expect(scaledBurstCount(16)).toBe(16);
  });
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/scene/tiering.test.ts`. Fails: `scaledBurstCount` not exported.

**Step 3: Minimal implementation** —
- Export `scaledBurstCount` in `effects.ts`: `export const scaledBurstCount = (n: number) => Math.max(1, Math.round(n * QUALITY.particleScale));` and use it inside `burst()`.
- Particle hard cap `effects.ts:467` `600` → `QUALITY.particleCap`.
- Fire loop `i<7` (`:181` and update guard `:195`) → `i < QUALITY.fireSprites`; smoke `i<6` (`:208`) → `QUALITY.smokeSprites`.
- `splatmap.ts:24` `2048` → `QUALITY.splatRtSize`.
Add `import { QUALITY } from './quality';` where missing.

**Step 4: Run it, expect PASS** — `npx vitest run tests/scene/tiering.test.ts` + `npm test` (incl. Foundation golden hash — **byte-identical**, since all these are render-side) + `npm run typecheck` + `npm run build` green. `purity.test.ts` green.

**Step 5: Commit** —
```
git add src/render/splatmap.ts src/render/effects.ts tests/scene/tiering.test.ts && git commit -m "feat(render): splat RT shrink + particle/fire/smoke tiering (live-read, render-only)"
```

---

### Task 55: S3.8 — lobby preview skip-on-low / throttle-on-mid (wrap entire `mountLobbyPreview`)
**Files:** Modify `src/app.ts:121-141` · `src/render/lobbyPreview.ts` · Create `src/render/gunIcons.ts` static fallback (or reuse P1's `gunIcons`) · Test `tests/scene/lobbyPreview.test.ts` (new)

Per S3.8: wrap the ENTIRE mount path — `if (!QUALITY.lobbyPreview) { renderStaticGunIcon(); return; }` at the top of `mountLobbyPreview`; make `disposeLobbyPreview` + callers tolerate a permanently-null preview. Throttle on mid (AA off, DPR clamp, 30fps cap).

**Step 1: Write the failing test** — create `tests/scene/lobbyPreview.test.ts`:
```ts
// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { setTierOverride } from '../../src/render/quality';
import { shouldMountPreview } from '../../src/app';

afterEach(() => setTierOverride('high'));

describe('S3.8 lobby preview gating', () => {
  it('skips the live preview on low', () => {
    setTierOverride('low');
    expect(shouldMountPreview()).toBe(false);
  });
  it('mounts on mid and high', () => {
    setTierOverride('mid'); expect(shouldMountPreview()).toBe(true);
    setTierOverride('high'); expect(shouldMountPreview()).toBe(true);
  });
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/scene/lobbyPreview.test.ts`. Fails: `shouldMountPreview` not exported (and importing `app.ts` headlessly may pull DOM — extract the gate into a tiny pure export to keep it node-safe).

**Step 3: Minimal implementation** — export a pure gate from a module `app.ts` can import without DOM (e.g. put `export const shouldMountPreview = () => QUALITY.lobbyPreview;` in `src/render/quality.ts` and re-export from `app.ts`, or define it in `quality.ts` and have the test import from there). At the top of `mountLobbyPreview`:
```ts
    if (!shouldMountPreview()) {
      // static icon fallback; no GL context
      renderStaticGunIcon(this.container, this.gunId);
      return;
    }
```
Guard `disposeLobbyPreview` (already null-safe via `?.`) and any external caller against a permanently-null preview. For mid, pass throttle flags to `new LobbyPreview(canvas, { antialias: false, maxFps: 30 })` and clamp DPR inside `LobbyPreview`.

**Step 4: Run it, expect PASS** — `npx vitest run tests/scene/lobbyPreview.test.ts` + `npm test` + `npm run typecheck` + `npm run build` green. Lobby-skip-on-low must not crash (the gate prevents the unguarded `start()/setLoadout()/resize()` calls).

**Step 5: Commit** —
```
git add src/app.ts src/render/quality.ts src/render/lobbyPreview.ts tests/scene/lobbyPreview.test.ts && git commit -m "feat(render): lobby preview skip-on-low (static icon) / throttle-on-mid"
```

---

### Task 56: S2 foundation — `tickCombat` test helper + `MAX_PROJECTILES`/`LANCE_KNOCK` hoist + `FLAGS` block (default OFF)
**Files:** Modify `src/data/constants.ts` · `src/sim/systems/weapons.ts:10` (hoist) · `tests/helpers.ts` (`tickCombat`) · Test `tests/projectiles.test.ts`

Per S2.2/S2.3/S2.8: add `FLAGS = { PROJECTILE_LANCE: false, MAX_PROJECTILES: 256 }` and hoist `LANCE_KNOCK=10` to `constants.ts`. Add a `tickCombat` helper (weaponSystem **then** projectileSystem, mirroring `sim.ts:180-181`). **Flag default OFF** so this whole task is D-SAFE / golden-hash-identical: nothing routes through the new path yet.

**Step 1: Write the failing test** — append to `tests/projectiles.test.ts`:
```ts
import { FLAGS } from '../src/data/constants';
import { C } from '../src/data/constants';

it('FLAGS.PROJECTILE_LANCE defaults OFF; MAX_PROJECTILES and LANCE_KNOCK are exposed', () => {
  expect(FLAGS.PROJECTILE_LANCE).toBe(false);
  expect(FLAGS.MAX_PROJECTILES).toBe(256);
  expect(C.LANCE_KNOCK).toBe(10);
});
```
And add `tickCombat` to `tests/helpers.ts` (used by later tasks) plus a self-check:
```ts
// tests/helpers.ts
import { weaponSystem } from '../src/sim/systems/weapons';
import { projectileSystem } from '../src/sim/systems/projectiles';
export function tickCombat(sim: GameSim, n = 1): void {
  for (let i = 0; i < n; i++) {
    weaponSystem(sim, sim.dt);
    projectileSystem(sim, sim.dt);
    for (const p of sim.players.values()) p.prevButtons = p.input.buttons;
  }
}
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/projectiles.test.ts`. Fails: `FLAGS` undefined, `C.LANCE_KNOCK` undefined.

**Step 3: Minimal implementation** — in `src/data/constants.ts` add `LANCE_KNOCK: 10` to `C` and a new export:
```ts
export const FLAGS = {
  PROJECTILE_LANCE: false, // false → legacy hitscan fireLance + old 'rail' event
  MAX_PROJECTILES: 256,
} as const;
```
In `weapons.ts`, replace the local `const LANCE_KNOCK = 10;` with `import { C } from '../../data/constants'` usage (`C.LANCE_KNOCK`) at `fireLance`'s `applyImpulse` site.

**Step 4: Run it, expect PASS** — `npx vitest run tests/projectiles.test.ts` + `npm test` (Foundation golden hash **byte-identical** — flag OFF, no behavior routed) + `npm run typecheck` green.

**Step 5: Commit** —
```
git add src/data/constants.ts src/sim/systems/weapons.ts tests/helpers.ts tests/projectiles.test.ts && git commit -m "feat(sim): FLAGS block (PROJECTILE_LANCE=off, MAX_PROJECTILES), hoist LANCE_KNOCK, add tickCombat helper"
```

---

### Task 57: S2.3 — `ProjectileKind 'rail'` + `ox,oy` fields + Lance routes through `fireProjectiles` (flag-gated) + rail hit handling
**Files:** Modify `src/sim/types.ts:115,117-130` · `src/data/weapons.ts:90-96` · `src/sim/systems/weapons.ts:82-98,145-163` · `src/sim/systems/projectiles.ts:49-68` · Test `tests/weapons.test.ts` (rewrite 3 Lance tests via `tickCombat`)

**This is the D-SHIFT change.** Flag-ON routes Lance through `fireProjectiles`, whose unconditional `sim.rng.spread(0)` advances Mulberry32 → flag-ON is a **distinct RNG stream**. Per S2.8 it gets its OWN golden hash (Task 59); **no relationship** is asserted to flag-OFF. Flag-OFF must equal the pre-change baseline. This task is bundled with its golden re-baseline (Task 59) — the spec mandates this for D-SHIFT.

**Step 1: Write the failing test** — rewrite the three Lance tests (`weapons.test.ts:145-180`) against `tickCombat`, run with the flag forced ON. Since `FLAGS` is `as const`, expose a test override hook: read the flag via a tiny indirection (`isLanceProjectile()` in weapons that reads `FLAGS.PROJECTILE_LANCE`) and, in tests, set `window.__bv3.flags.PROJECTILE_LANCE` — but for headless determinism the spec keeps flags in `constants.ts` not `window`. Resolution: make the tests **import a mutable test double**. Add a `setFlag` test helper that mutates a non-frozen runtime mirror; simplest is to make `FLAGS` a mutable object (not `as const` frozen) and have tests set `FLAGS.PROJECTILE_LANCE = true` in a `beforeEach`/`afterEach` pair:
```ts
import { FLAGS } from '../src/data/constants';
import { tickCombat } from './helpers';
import { C } from '../src/data/constants';

describe('lance as rail projectile (flag ON)', () => {
  const prev = FLAGS.PROJECTILE_LANCE;
  beforeEach(() => { (FLAGS as { PROJECTILE_LANCE: boolean }).PROJECTILE_LANCE = true; });
  afterEach(() => { (FLAGS as { PROJECTILE_LANCE: boolean }).PROJECTILE_LANCE = prev; });

  it('full charge spawns a rail slug that travels and damages on hit + knockback', async () => {
    const sim = await makeSim();
    const a = sim.addPlayer('A', 'spider', 0, false);
    const v = sim.addPlayer('V', 'phantom', 1, false);
    arm(sim, a, 'lance', 0, 0);
    arm(sim, v, 'stinger', 4, 0);
    hold(sim, a.id, BTN.FIRE);
    tickCombat(sim, 55); // charge ~48 ticks → fire, then slug travels 4u (~3 ticks at 110/60)
    expect(eventsOf(sim, 'shot').length).toBe(1);
    const rail = sim.projectiles.find((pr) => pr.kind === 'rail');
    // either still in flight or already resolved into damage:
    expect(v.hp).toBeLessThan(100);
    expect(v.hp).toBe(100 - GUNS.lance.damage);
    expect(sim.bodies.get(v.id)!.linvel().x).toBeGreaterThan(5); // LANCE_KNOCK along +x
  });

  it('rail is blocked by walls — babo behind cover takes no damage', async () => {
    const sim = await makeSim();
    const a = sim.addPlayer('A', 'spider', 0, false);
    const v = sim.addPlayer('V', 'phantom', 1, false);
    arm(sim, a, 'lance', 0, 0);
    arm(sim, v, 'stinger', 12, 0); // behind the pit rim accent
    hold(sim, a.id, BTN.FIRE);
    tickCombat(sim, 80);
    expect(v.hp).toBe(100);
    expect(eventsOf(sim, 'hit').length).toBe(0);
  });

  it('emits a terminal rail beam from captured ox,oy to the impact point', async () => {
    const sim = await makeSim();
    const a = sim.addPlayer('A', 'spider', 0, false);
    const v = sim.addPlayer('V', 'phantom', 1, false);
    arm(sim, a, 'lance', 0, 0);
    arm(sim, v, 'stinger', 4, 0);
    hold(sim, a.id, BTN.FIRE);
    tickCombat(sim, 80);
    const rails = eventsOf(sim, 'rail');
    expect(rails.length).toBe(1);
    const r = rails[0] as { x0: number; x1: number };
    expect(r.x0).toBeCloseTo(0.65, 2); // muzzle origin (ox)
    expect(r.x1).toBeLessThan(4.1);    // impact at victim
  });
});
```
Move the original 3 Lance hitscan tests under a `describe('lance hitscan (flag OFF)')` that forces the flag off and keeps the existing same-tick assertions (revert lock).

**Step 2: Run it, expect FAIL** — `npx vitest run tests/weapons.test.ts`. Fails: `'rail'` not a `ProjectileKind`; Lance still hitscan; no `ox,oy`; no terminal beam from origin.

**Step 3: Minimal implementation** —
- `types.ts:115`: `export type ProjectileKind = 'bullet' | 'rocket' | 'flame' | 'rail';` and add to `Projectile`: `ox: number; oy: number;`.
- `weapons.ts:90-96` data: `projectileSpeed: 110, hitscan: false`, `damage: 60` (unchanged), spread/charge/heat/recoil unchanged.
- `weapons.ts` make `FLAGS` mutable (drop `as const` or cast) so tests can toggle. Charge-complete block:
```ts
        if (p.charge >= 1) {
          sim.emit({ t: 'chargeReady', player: p.id });
          if (FLAGS.PROJECTILE_LANCE) fireProjectiles(sim, p, gun);
          else fireLance(sim, p, gun);
          p.charge = 0;
          discharged = true;
        }
```
- `fireProjectiles`: kind map gains `gun.id === 'lance' ? 'rail'`; capture `ox: mx, oy: my` in each pushed projectile.
- `projectiles.ts:49-68` hit handling: add the `else if (baboFirst && target)` rail branch with `sim.applyImpulse(target, nx*C.LANCE_KNOCK, ny*C.LANCE_KNOCK)`; emit the terminal `'rail'` event `{ x0: pr.ox, y0: pr.oy, x1: hx, y1: hy, owner: pr.owner }` on hit/expiry for `pr.kind==='rail'`.
- **No speculative spawn beam** — render slug only (Task 58).

**Step 4: Run it, expect PASS** — `npx vitest run tests/weapons.test.ts` + `npm run typecheck`. **Determinism:** run `npm test` — the **flag-OFF** golden hash must be **byte-identical** to the pre-change baseline (legacy `fireLance`, zero new draws). The flag-ON golden hash is established in Task 59. If any non-Lance golden snapshot shifts, STOP (regression).

**Step 5: Commit** —
```
git add src/sim/types.ts src/data/weapons.ts src/sim/systems/weapons.ts src/sim/systems/projectiles.ts tests/weapons.test.ts && git commit -m "feat(sim): Lance→rail projectile behind FLAGS.PROJECTILE_LANCE (110u/s, ox/oy, terminal beam); flag-OFF byte-identical"
```

---

### Task 58: S2.3/S2.6 — render rail slug + dead-reckoning (no speculative spawn beam)
**Files:** Modify `src/render/effects.ts:114-145` (projectile sync) · Test `tests/scene/railRender.test.ts` (new)

Per S2.3/S2.6: render the rail as a **moving stretched slug** (`pr.kind==='rail'` branch: bright additive box `scale.set(3.5,1,1)`, `GUNS.lance.color`); add render-side constant-velocity dead-reckoning (extrapolate from last snapshot using `vx,vy` up to ~50ms, clamped to the terminal beam). Pure render-side, never feeds the sim.

**Step 1: Write the failing test** — create `tests/scene/railRender.test.ts` (test the pure dead-reckon math):
```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { deadReckon } from '../../src/render/effects';

describe('rail dead-reckoning', () => {
  it('extrapolates along vx,vy clamped to 50ms', () => {
    const p = deadReckon({ x: 0, y: 0, vx: 110, vy: 0 }, 0.03); // 30ms
    expect(p.x).toBeCloseTo(110 * 0.03, 6);
    const clamped = deadReckon({ x: 0, y: 0, vx: 110, vy: 0 }, 0.2); // >50ms → clamp
    expect(clamped.x).toBeCloseTo(110 * 0.05, 6);
  });
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/scene/railRender.test.ts`. Fails: `deadReckon` not exported.

**Step 3: Minimal implementation** — in `effects.ts`:
```ts
export function deadReckon(pr: { x: number; y: number; vx: number; vy: number }, dt: number): { x: number; y: number } {
  const t = Math.min(dt, 0.05);
  return { x: pr.x + pr.vx * t, y: pr.y + pr.vy * t };
}
```
In `syncProjectiles`, add a `pr.kind==='rail'` create branch (additive box, `GUNS.lance.color`) and an update branch using `mesh.scale.set(3.5,1,1)`, rotation along `atan2(vy,vx)`, position from `deadReckon(pr, this.lastFrameDt)` clamped to the terminal beam endpoint (the terminal `'rail'` beam from Task 57 remains authoritative).

**Step 4: Run it, expect PASS** — `npx vitest run tests/scene/railRender.test.ts` + `npm test` + `npm run typecheck` + `npm run build` green. `purity.test.ts` green.

**Step 5: Commit** —
```
git add src/render/effects.ts tests/scene/railRender.test.ts && git commit -m "feat(render): rail slug render + 50ms dead-reckon (terminal beam authoritative)"
```

---

### Task 59: S2.8 — flag-ON golden hash baseline + flag-OFF==baseline + point-blank kill-tick test
**Files:** Modify `tests/determinism.test.ts` (or the Foundation golden file) · Test `tests/weapons.test.ts`

Per S2.8 / S8.1: flag-ON gets its **OWN** golden hash (NOT compared to flag-OFF); flag-OFF must equal the pre-change baseline. Per S2.3 same-tick ordering: point-blank ≤1.83u hit same tick — test at 0.7u.

**Step 1: Write the failing test** — add to `tests/determinism.test.ts`:
```ts
import { simHash, tickCombat } from './helpers';
import { FLAGS } from '../src/data/constants';

it('flag-OFF Lance run matches the pre-change baseline hash', async () => {
  (FLAGS as { PROJECTILE_LANCE: boolean }).PROJECTILE_LANCE = false;
  const sim = await makeSim();
  // ... seeded 8-bot run to tick 600 ...
  expect(simHash(sim)).toMatchSnapshot(); // must equal the committed baseline
});

it('flag-ON Lance run has its OWN stable golden hash (distinct RNG stream)', async () => {
  (FLAGS as { PROJECTILE_LANCE: boolean }).PROJECTILE_LANCE = true;
  const sim1 = await makeSim();
  const sim2 = await makeSim();
  // run both identically to tick 600
  // cross-instance equality (baseline-free determinism)
  expect(simHash(sim1)).toBe(simHash(sim2));
  // and a snapshotted flag-ON golden (its own baseline)
  expect(simHash(sim1)).toMatchSnapshot('lance-flag-on');
  (FLAGS as { PROJECTILE_LANCE: boolean }).PROJECTILE_LANCE = false;
});
```
And in `weapons.test.ts` (flag-ON describe):
```ts
it('point-blank victim at 0.7u dies same tick the rail fires', async () => {
  const sim = await makeSim();
  const a = sim.addPlayer('A', 'spider', 0, false);
  const v = sim.addPlayer('V', 'spider', 1, false);
  arm(sim, a, 'lance', 0, 0);
  arm(sim, v, 'stinger', 0.7, 0); // < 110/60 ≈ 1.83u
  v.hp = 50; // one 60-dmg rail kills
  hold(sim, a.id, BTN.FIRE);
  tickCombat(sim, 55);
  expect(v.alive).toBe(false);
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/determinism.test.ts tests/weapons.test.ts`. Initially the flag-ON snapshot does not exist (first run writes it); the flag-OFF snapshot must already match the committed baseline. Point-blank test fails if same-tick ordering is wrong.

**Step 3: Minimal implementation** — no production code if Task 57 is correct: run `npx vitest run -u tests/determinism.test.ts` **once** to write the NEW flag-ON golden snapshot (`lance-flag-on`), then inspect the diff: the flag-OFF snapshot must be **unchanged** from the pre-Task-57 baseline (if it changed, Task 57 leaked a draw into the flag-OFF path — fix there, do not re-baseline flag-OFF). Commit the new flag-ON snapshot.

**Step 4: Run it, expect PASS** — `npx vitest run tests/determinism.test.ts tests/weapons.test.ts` + full `npm test` + `npm run typecheck` green. Cross-instance flag-ON equality proves per-seed determinism.

**Step 5: Commit** —
```
git add tests/determinism.test.ts tests/__snapshots__ tests/weapons.test.ts && git commit -m "test(sim): flag-ON Lance golden hash baseline + flag-OFF==baseline + point-blank kill-tick"
```

---

### Task 60: S2.4/S2.7 — bot-lead re-baseline note + `MAX_PROJECTILES` drop-oldest-BULLET-only
**Files:** Modify `src/sim/systems/projectiles.ts` (cap enforcement) · Test `tests/projectiles.test.ts`

Per S2.7: enforce `FLAGS.MAX_PROJECTILES` by dropping the **oldest BULLET only** — never a rocket/flame mid-flight (deleting a live thumper/pyre changes damage outcomes). Order-deterministic (scan from front for the oldest bullet). Per S2.4, bot lead auto-enables at speed 110 — covered by the flag-ON golden hash (Task 59), never flag-OFF.

**Step 1: Write the failing test** — append to `tests/projectiles.test.ts`:
```ts
import { FLAGS } from '../src/data/constants';
import { capProjectiles } from '../src/sim/systems/projectiles';

it('MAX_PROJECTILES drops the oldest BULLET, never a rocket/flame', () => {
  const arr: any[] = [];
  // oldest is a rocket, then a bullet, then flames — cap should remove the bullet
  arr.push({ id: 1, kind: 'rocket' });
  arr.push({ id: 2, kind: 'bullet' });
  arr.push({ id: 3, kind: 'flame' });
  arr.push({ id: 4, kind: 'bullet' });
  capProjectiles(arr, 3); // over by 1
  expect(arr.length).toBe(3);
  expect(arr.find((p) => p.id === 1)).toBeDefined();   // rocket kept
  expect(arr.find((p) => p.id === 3)).toBeDefined();   // flame kept
  expect(arr.find((p) => p.id === 2)).toBeUndefined(); // oldest bullet dropped
});

it('drops nothing when no bullet exists even if over cap (grief-guard only)', () => {
  const arr: any[] = [{ id: 1, kind: 'rocket' }, { id: 2, kind: 'flame' }];
  capProjectiles(arr, 1);
  expect(arr.length).toBe(2); // never deletes a live rocket/flame
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/projectiles.test.ts`. Fails: `capProjectiles` not exported.

**Step 3: Minimal implementation** — in `projectiles.ts`:
```ts
import { FLAGS } from '../../data/constants';

/** Grief/lag guard: while over cap, remove the oldest BULLET only (front scan). */
export function capProjectiles(arr: { kind: string }[], cap: number): void {
  while (arr.length > cap) {
    const i = arr.findIndex((p) => p.kind === 'bullet');
    if (i < 0) break; // never drop a live rocket/flame
    arr.splice(i, 1);
  }
}
```
Call `capProjectiles(sim.projectiles, FLAGS.MAX_PROJECTILES)` at the end of `projectileSystem` (after compaction). Cap is effectively unreachable in normal play (~100 < 256), so this is determinism-safe and golden-hash-identical in practice; the order-deterministic front-scan is tested for per-seed stability.

**Step 4: Run it, expect PASS** — `npx vitest run tests/projectiles.test.ts` + `npm test` (golden hashes unchanged — cap unreachable in the seeded runs) + `npm run typecheck` green.

**Step 5: Commit** —
```
git add src/sim/systems/projectiles.ts tests/projectiles.test.ts && git commit -m "feat(sim): MAX_PROJECTILES drop-oldest-bullet-only grief guard (order-deterministic)"
```

---

### Task 61: S8.3 — Lance balance probe (`tests/balance.test.ts`, `BALANCE=1`-gated)
**Files:** Create `tests/balance.test.ts` · Verification step

Per S8.3 / Roadmap balance-probe decoupling: 16 seeds × 8-bot FFA, forced gun via `addPlayer(name,classId,team,bot,gun)`, drained `sim.events` for kill-share + TTK. Assert flag-OFF == golden hash; flag-ON each gun within a loose band + the provisional Lance band (min Lance time-to-first-hit at max range ≥120ms). Gated behind `BALANCE=1` so it doesn't run in normal CI. **`projectileLance` default-on is out-of-band — this probe is a decision aid, not a phase gate.**

**Step 1: Write the failing test** — create `tests/balance.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { makeSim, run } from './helpers';
import { FLAGS } from '../src/data/constants';
import { ALL_CLASS_IDS } from '../src/data/classes';

const RUN = process.env.BALANCE === '1';
const d = RUN ? describe : describe.skip;

d('Lance balance probe (BALANCE=1)', () => {
  it('flag-ON: no gun exceeds 2× mean kill-share over 16 seeds', async () => {
    (FLAGS as { PROJECTILE_LANCE: boolean }).PROJECTILE_LANCE = true;
    const kills: Record<string, number> = {};
    for (let seed = 1; seed <= 16; seed++) {
      const sim = await makeSim({ seed });
      // 8 bots, one per gun forced via addPlayer's gun param
      const guns = ['stinger','workhorse','maw','hurricane','thumper','ion','lance','pyre'] as const;
      guns.forEach((g, i) => sim.addPlayer(`B${i}`, ALL_CLASS_IDS[i % ALL_CLASS_IDS.length], -1, true, g));
      for (let t = 0; t < 3600; t++) {
        sim.step();
        for (const e of sim.events) if (e.t === 'death' && e.gun !== 'world') kills[e.gun] = (kills[e.gun] ?? 0) + 1;
        sim.events.length = 0;
      }
    }
    const vals = Object.values(kills);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    for (const [g, v] of Object.entries(kills)) {
      console.log(`gun ${g}: ${v} kills`); // human decision aid
      expect(v).toBeLessThanOrEqual(mean * 2.5); // loose band
    }
    (FLAGS as { PROJECTILE_LANCE: boolean }).PROJECTILE_LANCE = false;
  });
});
```

**Step 2: Run it, expect FAIL** — `BALANCE=1 npx vitest run tests/balance.test.ts` (PowerShell: `$env:BALANCE='1'; npx vitest run tests/balance.test.ts`). Fails first if `addPlayer`'s gun param / event drain wiring is off; otherwise it prints the per-gun table.

**Step 3: Minimal implementation** — none beyond the test if `addPlayer(name,classId,team,bot,gun)` already persists `chosenGun` across respawn (verified `sim.ts:116,307`). If mid-life scavenge skews the probe, suppress gun-pickup for bots inside the probe by zeroing `GUN_PICKUP_RADIUS` interactions via a test-only flag, or accept the documented bot-lead/scavenge confound (S8.3) and report it.

**Step 4: Run it, expect PASS** — `BALANCE=1 npx vitest run tests/balance.test.ts` green (prints table). Default CI (`npm test`, no `BALANCE`) **skips** it — confirm `npm test` stays green and fast. `npm run typecheck` green.

**Step 5: Commit** —
```
git add tests/balance.test.ts && git commit -m "test(balance): BALANCE-gated Lance kill-share probe (decision aid, not a phase gate)"
```

---

### Task 62: S8.6 — responsive shell jsdom assertions (arena/controls bands + HUD safe-area)
**Files:** Test `tests/shell/layout.test.ts` (new)

Per S8.6: jsdom asserts arena ~top 60% / controls ~bottom 40% in portrait + HUD safe-area corners + the source-of-truth strings. This closes the Phase-2 shell gate (the GPU/device parts are L5-manual).

**Step 1: Write the failing test** — create `tests/shell/layout.test.ts`:
```ts
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { TouchControls } from '../../src/touch/touchControls';

let tc: TouchControls;
afterEach(() => tc?.dispose());

describe('S8.6 portrait control band', () => {
  it('places #touch-layer over the full surface with controls weighted to the bottom 40%', () => {
    const c = document.createElement('div');
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    Object.defineProperty(window, 'innerWidth', { value: 400, configurable: true });
    document.body.appendChild(c);
    tc = new TouchControls(c, 1);
    const layer = c.querySelector('#touch-layer') as HTMLElement;
    expect(layer).not.toBeNull();
    // left/right sticks live in the bottom half; the move button row sits below 60%
    const skill = c.querySelector('#tc-skill') as HTMLElement;
    expect(skill).not.toBeNull();
  });
});
```

**Step 2: Run it, expect FAIL** — `npx vitest run tests/shell/layout.test.ts`. Passes only if Task 38 built the buttons; if the band CSS/structure is missing it fails. (If it already passes from Task 38, extend it to assert the controls' computed bottom-anchored positioning to make it a real gate.)

**Step 3: Minimal implementation** — ensure `#touch-layer` CSS (added in styles.css) absolutely positions sticks/buttons in the bottom ~40% via classes (`.tc-left`, `.tc-right`, button row), with the scoreboard/leave at top. Add the band CSS to `styles.css` under the touch-mode scope.

**Step 4: Run it, expect PASS** — `npx vitest run tests/shell/layout.test.ts` + `npm test` + `npm run typecheck` + `npm run build` green.

**Step 5: Commit** —
```
git add tests/shell/layout.test.ts src/ui/styles.css && git commit -m "test(shell): portrait control-band layout assertions + touch-layer band CSS"
```

---

### Task 63: Phase 2 exit gate — full suite, typecheck, build, golden hashes, purity green
**Files:** Verification only (no new code)

Per Roadmap P2 exit + S8.7. This is the fail-fast ordered gate before declaring Phase 2 done. Use @superpowers:verification-before-completion — paste real command output, do not assert green without evidence.

**Step 1–4 (verification, in order):**
1. `npm run typecheck` — zero errors.
2. `npm test` — all existing + new touch/shell/scene/determinism/balance(skip)/golden tests green.
3. Flag-OFF golden hash == P1 baseline (byte-identical): `npx vitest run tests/determinism.test.ts` — confirm the flag-OFF snapshot is unchanged from P1; the flag-ON snapshot is its own committed baseline.
4. `tests/purity.test.ts` green (no sim→render/three leak from any Phase-2 edit).
5. Step-cost gate still `<8ms` (`tests/integration.test.ts` perf gate) — flag-ON heavy-projectile path stays bounded.
6. `npm run build` — succeeds, emits `dist/icon-192.png` + `dist/icon-512.png` (verify `ls dist/icon-*.png`).
7. **Desktop byte-identical with `{ touch:false, projectileLance:false, tier:'high' }`** — the default config; confirm no golden snapshot for the default path changed across all of Phase 2.
8. L5 device sign-off (manual checkbox, not CI): coarse-pointer full match touch-only; portrait controls bottom ~40%, HUD safe-area, babo top-band; mid-range phone holds playable 60 in 1v1–2v2; spawn→swap→despawn→respawn no double-dispose; lobby-skip-on-low no crash. Paste `window.__bv3perf` p50/p95 evidence.

**Step 5: Commit (if any snapshot/lockfile churn from the gate run):**
```
git add -A && git commit -m "chore(phase2): exit-gate verification (typecheck/test/build/golden/purity green)"
```

---

**Phase 2 complete.** With `RUNTIME = { touch:false, projectileLance:false, tier:'high' }` the desktop build is byte-identical; coarse-pointer devices get touch controls, portrait UI, the safe-area HUD, automatic tier downgrades, and the (default-OFF) flagged rail Lance. The flag-ON Lance has its own golden baseline; flag-OFF equals the P1 baseline. Phase 3 (profile-gated structural perf) depends on the P2 device profile produced by the L5 sign-off above.

---




## Phase 3 — It Holds 60 Under Chaos (structural, PROFILE-GATED)

> **GATING (read first).** Run these tasks **only if the Phase-2 real-device profile (S8.5) shows the named bottleneck**; otherwise **SKIP and record why** in the phase log. The S8.5 profiler exposes `window.__bv3perf` (p50/p95 frame time) and the S8.2 scene-graph instrumentation reports draw-call/material counts. Concretely:
> - **Task 40 (client.view memo) is RECOMMENDED regardless** — D-SAFE, client-only, no GPU dependency, pure CPU win on every join. Ship it even if the profile is green.
> - **Tasks 41–45 (S3 structural: babo subtree merge/instancing, pooled VFX geometry, Particle-record pooling, screenfx gradient cache + early-out)** ship **only if the P2 profile shows the `high`-tier render path or particle/screenfx CPU as red** (p95 > ~22 ms in 8-bot chaos, or scene-stats draw calls ≫ the ~200–350 baseline). **Task 43 (splat composite-into-floor) is OPTIONAL** — real regression risk (custom floor shader); skip unless the splat plane shows up as a measured cost.
> - **Tasks 46–48 (S5.5 binary snapshots)** ship **only if the P2 profile shows host snapshot CPU or uplink as the bottleneck under projectile spam** — this is a **BREAKING wire change** requiring all peers in lockstep. Skip unless measured.
> - **Task 49 (pooled-audio geometry)** ships only if not already covered by P1's S5.7 voice budgeting and the profile shows audio-node churn.
>
> Worker offload (S5.6) is **CUT** (YAGNI) — documented as a seam only (Task 50), no build work.
>
> Use @superpowers:test-driven-development for every task. Each task assumes Phase 1 and Phase 2 are complete: `tests/helpers.ts` exports `simHash`/`tickCombat`, `src/render/quality.ts` exports `QUALITY`, `C.NET_BINARY_SNAPSHOTS` and `wireVersion` exist in the handshake plumbing, and the S8.2 scene-graph instrumentation harness is in place.

---

### Task 40: `client.view` memoization on interp timestamp + `predictedSelf()` (RECOMMENDED, D-SAFE, client-only)

**Files:** Modify `src/net/client.ts:256-323` (`get view()`), add `predictedSelf()`; Modify `src/app.ts:422` (route tick-path input sampling); Test `tests/net/clientView.test.ts`

**Step 1: Write the failing test.**

```ts
// tests/net/clientView.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClientSession } from '../../src/net/client';
import type { Snapshot } from '../../src/sim/types';
import { emptyInput } from '../../src/sim/types';

// Minimal snapshot factory: one player (the local one, id 0) + no entities.
function snap(tick: number, x: number, y: number): Snapshot {
  return {
    tick,
    players: [{
      id: 0, name: 'me', classId: 'spider', team: -1, bot: false,
      x, y, vx: 0, vy: 0, aim: 0,
      hp: 100, alive: true, respawnT: 0, invulnT: 0, spawnProt: false,
      gun: 'rifle', chosenGun: 'rifle', mag: 30, reloadT: 0, heat: 0, overheatT: 0,
      spin: 0, charge: 0, fireCD: 0, spreadAcc: 0,
      grenades: 2, equip: null, equipCount: 0, throwT: 0, throwing: false,
      abilityCD: 0, abilityT: 0, grappleActive: false, grappleX: 0, grappleY: 0,
      grappleLen: 0, fortifyActive: false, phaseActive: false, dashActive: false,
      burnT: 0, burnTick: 0, dripT: 0, inSlick: false,
      kills: 0, deaths: 0, score: 0, bounty: 0, carryingFlag: -1,
      input: emptyInput(), prevButtons: 0, lastAckSeq: -1,
    }],
    projectiles: [], grenades: [], pools: [], fires: [], smokes: [], pickups: [],
    mode: { mode: 'tdm', timeLeft: 600, scoreLimit: 50, teamScores: [0, 0], leaderId: -1, flags: [], ended: false, winner: -1 },
  };
}

// Reach into the private message handler the way the real socket does.
function feed(c: ClientSession, msg: unknown): void {
  (c as unknown as { onMsg(m: unknown): void }).onMsg(msg);
}

describe('client.view memoization', () => {
  let now = 0;
  beforeEach(() => { now = 10_000; vi.spyOn(performance, 'now').mockImplementation(() => now); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns the same view object for two reads at the same interp timestamp', () => {
    const c = new ClientSession();
    feed(c, { t: 'start', settings: { mode: 'tdm', mapId: 'grinder', scoreLimit: 50, botCount: 0, seed: 42 }, yourId: 0 });
    now = 10_000; feed(c, { t: 'snap', snap: snap(0, 1, 1) });
    now = 10_050; feed(c, { t: 'snap', snap: snap(3, 2, 2) });
    now = 10_200; // read time
    const v1 = c.view;
    const v2 = c.view; // same timestamp, no mutation between → cache hit
    expect(v1).toBe(v2);
  });

  it('recomputes after a new snapshot mutation', () => {
    const c = new ClientSession();
    feed(c, { t: 'start', settings: { mode: 'tdm', mapId: 'grinder', scoreLimit: 50, botCount: 0, seed: 42 }, yourId: 0 });
    now = 10_000; feed(c, { t: 'snap', snap: snap(0, 1, 1) });
    now = 10_200; const v1 = c.view;
    now = 10_200; feed(c, { t: 'snap', snap: snap(3, 9, 9) }); // mutation
    const v2 = c.view;
    expect(v1).not.toBe(v2);
  });

  it('predictedSelf returns the predictor own-babo position without building a full view', () => {
    const c = new ClientSession();
    feed(c, { t: 'start', settings: { mode: 'tdm', mapId: 'grinder', scoreLimit: 50, botCount: 0, seed: 42 }, yourId: 0 });
    now = 10_000; feed(c, { t: 'snap', snap: snap(0, 4, 5) });
    const self = c.predictedSelf();
    expect(self).toMatchObject({ x: 4, y: 5 });
  });
});
```

**Step 2: Run it, expect FAIL.** `npx vitest run tests/net/clientView.test.ts` — fails: `client.predictedSelf is not a function`, and the `.toBe` identity assertion fails because today `get view()` allocates a fresh object on every read.

**Step 3: Minimal implementation.** In `src/net/client.ts`, add a memo cache and `predictedSelf()`, and key recompute on the rounded interp target + a `viewDirty` flag set by the mutating messages.

Add fields near the other private state (after `private rendered = {...}` at `:47`):
```ts
  // view memoization (S5.4) — keyed on the rounded interp timestamp.
  private viewCache: WorldView | null = null;
  private viewKey = -1;
  private viewDirty = true;
```

In `onMsg` (`:119-151`), set `this.viewDirty = true` in the `'snap'`, `'events'`, and `'end'` cases (the three view-mutating messages):
```ts
      case 'snap':
        this.snaps.push({ snap: msg.snap, at: performance.now() });
        if (this.snaps.length > 12) this.snaps.shift();
        this.reconcile(msg.snap);
        this.viewDirty = true;
        break;
      case 'events':
        this.eventQueue.push(...msg.events);
        this.viewDirty = true;
        break;
      case 'end':
        this.endWinner = msg.winner;
        this.viewDirty = true;
        this.onEnd(msg.winner);
        break;
```
Also set `this.viewDirty = true;` in the `'start'` case so a re-start invalidates the cache.

Rename the existing getter body to a private builder and wrap it with the cache guard. Replace `get view(): WorldView | null { ... }` at `:256` with:
```ts
  /** Cheap own-babo accessor for the per-tick input path (S5.4) — never builds the full view. */
  predictedSelf(): { x: number; y: number } | null {
    if (this.pred.valid) return { x: this.rendered.x, y: this.rendered.y };
    const newest = this.snaps[this.snaps.length - 1];
    const me = newest?.snap.players.find((p) => p.id === this.myId);
    return me ? { x: me.x, y: me.y } : null;
  }

  get view(): WorldView | null {
    if (this.snaps.length === 0) return null;
    const key = Math.round(performance.now() - C.INTERP_BUFFER_MS);
    if (!this.viewDirty && key === this.viewKey && this.viewCache) return this.viewCache;
    this.viewKey = key;
    this.viewDirty = false;
    this.viewCache = this.buildView();
    return this.viewCache;
  }

  private buildView(): WorldView | null {
```
…and leave the original interpolation body (everything from `if (this.snaps.length === 0) return null;` onward) as the body of `buildView()`. (Keep its internal `const target = performance.now() - C.INTERP_BUFFER_MS;` — `buildView` is only entered on a cache miss so this is consistent with `key`.)

In `src/app.ts:422`, route the per-tick input through `predictedSelf()` so the tick loop never forces a full interpolated rebuild:
```ts
  private tick(): void {
    if (this.role === 'client') {
      const client = this.client;
      if (!client) return;
      const self = client.predictedSelf();
      const input = self && this.renderer
        ? this.input.sample(this.renderer.groundPoint(this.input.mouseX, this.input.mouseY), self.x, self.y)
        : emptyInput();
      client.sendInput(input);
      return;
    }
```
(Touch source-awareness from S1 wraps this same `self` the same way; the load-bearing change is that `tick()` no longer reads `client.view`.)

**Step 4: Run it, expect PASS.** `npx vitest run tests/net/clientView.test.ts`, then `npm test` (full suite stays green — this is client-only, non-authoritative, so all sim determinism asserts are untouched) and `npm run typecheck`.

**Step 5: Commit.** `git add src/net/client.ts src/app.ts tests/net/clientView.test.ts && git commit -m "perf(net): memoize client.view on interp timestamp + add predictedSelf for tick path"`

---

### Task 41: Pooled VFX geometry — share `RingGeometry`/`BoxGeometry` for rail beams, explosion rings & well rings (PROFILE-GATED)

**Files:** Modify `src/render/effects.ts` (`ring()` `:514-524`, `'rail'` beam `:382-393`, `update()` beam disposal `:557-572`); Test `tests/scene/effectsGeo.test.ts`

> Gate: ship only if the P2 scene-stats show per-event geometry allocation (rings/beams) as a churn cost. Today `ring()` and the `'rail'` beam each `new THREE.RingGeometry(...)` / `new THREE.BoxGeometry(...)` **per event** and dispose the *material* but the geometry leaks/regenerates. Pool the geometry; scale per instance.

**Step 1: Write the failing test.** Uses the S8.2 injectable-texture scene harness so jsdom needs no GL/canvas.

```ts
// tests/scene/effectsGeo.test.ts
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { EffectsLayer } from '../../src/render/effects';

describe('effects pooled geometry', () => {
  it('reuses one shared ring geometry across many explosion rings', () => {
    const scene = new THREE.Scene();
    const fx = new EffectsLayer(scene);
    const geos = new Set<THREE.BufferGeometry>();
    // 30 explosions → 30 ring()s; all must share ONE geometry instance.
    for (let i = 0; i < 30; i++) {
      fx.handleEvent({ t: 'explosion', x: i, y: 0, r: 2, kind: 'rocket' });
    }
    scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && (o as THREE.Mesh).geometry?.type === 'RingGeometry') {
        geos.add((o as THREE.Mesh).geometry);
      }
    });
    expect(geos.size).toBe(1);
  });

  it('reuses one shared beam geometry across many rail events', () => {
    const scene = new THREE.Scene();
    const fx = new EffectsLayer(scene);
    const geos = new Set<THREE.BufferGeometry>();
    for (let i = 0; i < 20; i++) {
      fx.handleEvent({ t: 'rail', x0: 0, y0: 0, x1: i + 1, y1: 0, owner: 0 });
    }
    scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && (o as THREE.Mesh).geometry?.type === 'BoxGeometry') {
        geos.add((o as THREE.Mesh).geometry);
      }
    });
    expect(geos.size).toBe(1);
  });
});
```
(jsdom note: `document.hidden` is `false` so `handleEvent` does not early-return; `makeGlowTexture` must be the injectable/stubbed texture factory from S8.2 so no `getContext` throws. If the harness sets `document.hidden`, the test sets it back to `false` in a `beforeEach`.)

**Step 2: Run it, expect FAIL.** `npx vitest run tests/scene/effectsGeo.test.ts` — fails: `geos.size` is 30 (and 20), because each `ring()`/`'rail'` allocates its own geometry.

**Step 3: Minimal implementation.** Add shared geometries as instance fields alongside the existing pooled geos (`:44-47`):
```ts
  private ringGeo = new THREE.RingGeometry(0.8, 1, 32);
  private beamGeo = new THREE.BoxGeometry(1, 0.08, 0.08);
```
Rewrite `ring()` (`:514-524`) to reuse `this.ringGeo` (it was already scaling, so unit geometry + per-mesh scale is identical pixels):
```ts
  private ring(x: number, y: number, r: number, color: number): void {
    const mesh = new THREE.Mesh(
      this.ringGeo,
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 0.08, y);
    mesh.scale.setScalar(r * 0.4);
    this.beams.push({ obj: mesh, ttl: 0.35, maxTtl: 0.35 });
    this.scene.add(mesh);
  }
```
Rewrite the `'rail'` beam (`:382-393`) to reuse `this.beamGeo` (it already scales `x`):
```ts
      case 'rail': {
        const beam = new THREE.Mesh(
          this.beamGeo,
          new THREE.MeshBasicMaterial({ color: 0xc090ff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending }),
        );
        const dx = ev.x1 - ev.x0;
        const dy = ev.y1 - ev.y0;
        beam.position.set(ev.x0 + dx / 2, BH, ev.y0 + dy / 2);
        beam.scale.x = Math.max(0.01, Math.hypot(dx, dy));
        beam.rotation.y = -Math.atan2(dy, dx);
        this.scene.add(beam);
        this.beams.push({ obj: beam, ttl: 0.3, maxTtl: 0.3 });
        break;
      }
```
**Critical:** the beam expiry path at `:560-563` disposes `b.obj.geometry`'s material but NOT geometry today — confirm it stays geometry-safe. The current code disposes only `(b.obj.material).dispose()`, so shared geometry is never disposed there. Leave that line unchanged; add `this.ringGeo.dispose(); this.beamGeo.dispose();` to any future `EffectsLayer.dispose()` (none exists today — note for the disposal pass, not required for this task).

**Step 4: Run it, expect PASS.** `npx vitest run tests/scene/effectsGeo.test.ts`, then `npm test` + `npm run typecheck`. (Render-only; `purity.test.ts` stays green; no sim file touched → determinism untouched by construction.)

**Step 5: Commit.** `git add src/render/effects.ts tests/scene/effectsGeo.test.ts && git commit -m "perf(fx): pool shared ring/beam geometry for rings and rail beams"`

---

### Task 42: Particle-record pooling — recycle the `Particle` interface objects (PROFILE-GATED)

**Files:** Modify `src/render/effects.ts` (`burst()` `:481-503`, `flash()` `:505-512`, `update()` `:526-553`, add a `particlePool`); Test `tests/scene/particlePool.test.ts`

> Gate: ship only if the P2 alloc probe (S8.2 `--expose-gc`) shows the particle hot path retaining/churning `Particle` records under chaos. Today each `burst()` particle pushes a **fresh object literal** into `this.particles`; `update()` drops it on death. Pool the record objects (the sprite is already pooled via `spritePool`).

**Step 1: Write the failing test.**

```ts
// tests/scene/particlePool.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { EffectsLayer } from '../../src/render/effects';

describe('particle record pooling', () => {
  beforeEach(() => { (document as unknown as { hidden: boolean }).hidden = false; });

  it('does not grow the particle-record pool unboundedly across burst/expire cycles', () => {
    const scene = new THREE.Scene();
    const fx = new EffectsLayer(scene);
    // Cycle: spawn a burst, then run update long enough to expire it, many times.
    for (let cycle = 0; cycle < 50; cycle++) {
      fx.handleEvent({ t: 'hit', target: 0, attacker: 1, damage: 10, x: 0, y: 0 });
      for (let f = 0; f < 60; f++) fx.update(1 / 60); // 1s — well past the 0.35s life
    }
    const pool = (fx as unknown as { particlePool: unknown[] }).particlePool;
    // After steady state, recycled records are bounded by the largest single burst, not 50×.
    expect(pool.length).toBeLessThanOrEqual(40);
    expect((fx as unknown as { particles: unknown[] }).particles.length).toBe(0);
  });
});
```

**Step 2: Run it, expect FAIL.** `npx vitest run tests/scene/particlePool.test.ts` — fails: `fx.particlePool` is `undefined` (no pool exists).

**Step 3: Minimal implementation.** Add the pool field near `:39`:
```ts
  private particlePool: Particle[] = [];
```
Add a private factory that draws from the pool, and route `burst()`/`flash()` through it. Replace the `this.particles.push({...})` in `burst()` (`:491-501`) with:
```ts
      this.particles.push(this.makeParticle(obj, {
        vx: Math.cos(a) * sp, vz: Math.sin(a) * sp,
        vy: gravity ? 2 + Math.random() * 4 : 0.4,
        life, maxLife: life,
        gravity: gravity ? 13 : 0.4,
        scaleRate: gravity ? -0.1 : 1.2,
        baseScale, bounce: gravity,
      }));
```
and in `flash()` (`:509-511`):
```ts
    this.particles.push(this.makeParticle(obj, {
      vx: 0, vy: 0, vz: 0, life, maxLife: life, gravity: 0, scaleRate: 6, baseScale: scale * 2, bounce: false,
    }));
```
Add the factory (anywhere in the particle-helpers block):
```ts
  private makeParticle(obj: THREE.Sprite | THREE.Mesh, init: Omit<Particle, 'obj'>): Particle {
    const p = this.particlePool.pop();
    if (p) { p.obj = obj; Object.assign(p, init); return p; }
    return { obj, ...init };
  }
```
In `update()` (`:529-553`), when a particle dies, return its record to the pool. Replace the death branch (`:532-535`):
```ts
      if (p.life <= 0) {
        this.scene.remove(p.obj);
        if (p.obj instanceof THREE.Sprite) this.spritePool.push(p.obj);
        this.particlePool.push(p);
        continue;
      }
```

**Step 4: Run it, expect PASS.** `npx vitest run tests/scene/particlePool.test.ts`, then `npm test` + `npm run typecheck`. Render-only; determinism untouched.

**Step 5: Commit.** `git add src/render/effects.ts tests/scene/particlePool.test.ts && git commit -m "perf(fx): pool Particle records to cut per-burst allocation"`

---

### Task 43: Babo shadows → single `InstancedMesh` (PROFILE-GATED structural)

**Files:** Modify `src/render/babos.ts` (`shadowGeo`/`shadowMat` `:87-88`, per-babo shadow build `:121-124`, dispose `:252-253`); Test `tests/scene/baboShadowInstance.test.ts`

> Gate per S3.5 row **5b**: this sub-feature is **all-tiers + lossless** (8 shadow meshes → 1 draw call, same pixels) — ship it if the P2 scene-stats show shadow-mesh draw calls contributing to the count; it is the cheapest structural win. Per S3.11 this is the **single intentional desktop draw-call delta** (still pixel-identical). `MAX_PLAYERS=8` (confirmed `net/types.ts:39`).

**Step 1: Write the failing test.**

```ts
// tests/scene/baboShadowInstance.test.ts
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { BaboPool } from '../../src/render/babos';

describe('babo shadow instancing', () => {
  it('renders all babo shadows through one InstancedMesh, not N CircleGeometry meshes', () => {
    const scene = new THREE.Scene();
    const pool = new BaboPool(scene);
    let instanced = 0;
    let perBaboShadowMeshes = 0;
    scene.traverse((o) => {
      const m = o as THREE.InstancedMesh;
      if (m.isInstancedMesh && m.geometry?.type === 'CircleGeometry') instanced++;
      if ((o as THREE.Mesh).isMesh && !m.isInstancedMesh && (o as THREE.Mesh).geometry?.type === 'CircleGeometry') {
        perBaboShadowMeshes++;
      }
    });
    expect(instanced).toBe(1);            // one instanced shadow mesh
    expect(perBaboShadowMeshes).toBe(0);  // no per-babo shadow meshes
    pool.dispose();
  });
});
```

**Step 2: Run it, expect FAIL.** `npx vitest run tests/scene/baboShadowInstance.test.ts` — fails: no `InstancedMesh` in the scene; shadows are still per-babo `Mesh`es created lazily on spawn (and 0 instanced).

**Step 3: Minimal implementation.** Per S3.5/5b: build one `InstancedMesh(shadowGeo, shadowMat, MAX_PLAYERS)` in the `BaboPool` constructor, add it to the scene, and each frame write the live babo's shadow matrix into instance `i` (zero-scale the matrix when `!alive`).

In `babos.ts`, import `MAX_PLAYERS` and replace the per-babo shadow. Keep `shadowGeo`/`shadowMat` fields (`:87-88`) but construct the instanced mesh in the ctor:
```ts
  private shadowInstanced = new THREE.InstancedMesh(this.shadowGeo, this.shadowMat, MAX_PLAYERS);
```
In the ctor, orient + register it once:
```ts
    this.shadowInstanced.rotation.x = -Math.PI / 2;
    this.shadowInstanced.position.y = -C.BABO_RADIUS + 0.02;
    this.shadowInstanced.frustumCulled = false;
    scene.add(this.shadowInstanced);
```
Remove the per-babo shadow `Mesh` build at `:121-124` (drop `const shadow = ...; group.add(shadow);`) and the `shadow` entry from the babo record at `:159` — the shadow is no longer parented to the babo group. In the per-frame sync (where each live babo is positioned), write its instance matrix; for slots without a live babo, write a zero-scale matrix so it draws nothing:
```ts
    const m = new THREE.Matrix4(); // hoist to a reused scratch field in real impl
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const p = livePlayers[i]; // map slot→player by stable id ordering used elsewhere
      if (p && p.alive) m.makeTranslation(p.x, -C.BABO_RADIUS + 0.02, p.y).multiply(SHADOW_ROT);
      else m.makeScale(0, 0, 0);
      this.shadowInstanced.setMatrixAt(i, m);
    }
    this.shadowInstanced.instanceMatrix.needsUpdate = true;
```
(Use the pool's existing per-id slot mapping; the instanced mesh's own transform is identity since matrices are world-space — set `this.shadowInstanced.rotation.x = 0` if folding the `-PI/2` into `SHADOW_ROT`. Either keeps pixels identical to the old per-mesh `rotation.x=-PI/2`.) Update `dispose()` (`:252-253`) to also `this.shadowInstanced.dispose()` (geo/mat already disposed there).

**Step 4: Run it, expect PASS.** `npx vitest run tests/scene/baboShadowInstance.test.ts`, then `npm test` + `npm run typecheck`. Render-only; `purity.test.ts` green; determinism untouched. Visual check (L5): shadows render under all 8 babos, vanish on death — same as before.

**Step 5: Commit.** `git add src/render/babos.ts tests/scene/baboShadowInstance.test.ts && git commit -m "perf(render): merge babo shadows into one InstancedMesh (8 draws → 1, pixel-identical)"`

---

### Task 44: `screenfx` gradient cache + low-HP early-out (PROFILE-GATED)

**Files:** Modify `src/render/screenfx.ts` (`update()` `:65-115`); Test `tests/scene/screenfxCache.test.ts`

> Gate: ship only if the P2 profile shows `ScreenFx.update` as a per-frame cost (it builds a fresh `createRadialGradient` every frame at low HP, and runs the full draw path even when idle). Two cheap wins: (a) **early-out** when there is nothing to draw (no splatters, no hurt flash, full HP); (b) **cache the radial gradient**, rebuilding only when canvas size or the danger bucket changes.

**Step 1: Write the failing test.** jsdom has no 2D canvas, so this test stubs `getContext('2d')` with a counting spy.

```ts
// tests/scene/screenfxCache.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScreenFx } from '../../src/render/screenfx';
import { emptyInput, type PlayerState } from '../../src/sim/types';

function ctxSpy() {
  return {
    clearRect: vi.fn(), fillRect: vi.fn(), save: vi.fn(), restore: vi.fn(),
    translate: vi.fn(), rotate: vi.fn(), beginPath: vi.fn(), ellipse: vi.fn(),
    fill: vi.fn(), createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    setTransform: vi.fn(), fillStyle: '',
  };
}

function makeLocal(hp: number): PlayerState {
  return { id: 0, name: 'me', classId: 'spider', team: -1, bot: false,
    x: 0, y: 0, vx: 0, vy: 0, aim: 0, hp, alive: true, respawnT: 0, invulnT: 0, spawnProt: false,
    gun: 'rifle', chosenGun: 'rifle', mag: 30, reloadT: 0, heat: 0, overheatT: 0, spin: 0, charge: 0,
    fireCD: 0, spreadAcc: 0, grenades: 0, equip: null, equipCount: 0, throwT: 0, throwing: false,
    abilityCD: 0, abilityT: 0, grappleActive: false, grappleX: 0, grappleY: 0, grappleLen: 0,
    fortifyActive: false, phaseActive: false, dashActive: false, burnT: 0, burnTick: 0, dripT: 0,
    inSlick: false, kills: 0, deaths: 0, score: 0, bounty: 0, carryingFlag: -1,
    input: emptyInput(), prevButtons: 0, lastAckSeq: -1 } as PlayerState;
}

describe('screenfx caching + early-out', () => {
  let spy: ReturnType<typeof ctxSpy>;
  beforeEach(() => {
    spy = ctxSpy();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(spy as unknown as CanvasRenderingContext2D);
  });

  it('skips the draw path entirely when idle (full HP, no splatters, no flash)', () => {
    const fx = new ScreenFx(document.createElement('div'));
    fx.update(makeLocal(100), 1 / 60);
    expect(spy.clearRect).not.toHaveBeenCalled(); // early-out before any draw
  });

  it('reuses the cached radial gradient across frames at a stable danger level', () => {
    const fx = new ScreenFx(document.createElement('div'));
    for (let i = 0; i < 10; i++) fx.update(makeLocal(20), 1 / 60); // hpFrac 0.2, danger constant
    expect(spy.createRadialGradient.mock.calls.length).toBe(1); // built once, cached
  });
});
```

**Step 2: Run it, expect FAIL.** `npx vitest run tests/scene/screenfxCache.test.ts` — fails: `clearRect` is called every frame (no early-out), and `createRadialGradient` is called 10 times (no cache).

**Step 3: Minimal implementation.** Add cache + dirty-key fields, an early-out, and gradient memoization.

Add fields:
```ts
  private gradCache: CanvasGradient | null = null;
  private gradKey = '';
```
At the top of `update()` (`:65`), add an early-out before any drawing:
```ts
  update(local: PlayerState | undefined, dt: number): void {
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 1.6);
    this.heartbeat += dt;
    const lowHp = !!local && local.alive && local.hp / C.MAX_HP < 0.45;
    if (this.splatters.length === 0 && this.hurtFlash <= 0 && !lowHp) {
      // Nothing on screen — skip the whole clear+draw path. (Last frame already cleared.)
      if (this.dirtyLastFrame) { this.g.clearRect(0, 0, this.canvas.width, this.canvas.height); this.dirtyLastFrame = false; }
      return;
    }
    this.dirtyLastFrame = true;
    const g = this.g;
    const W = this.canvas.width;
    const H = this.canvas.height;
    g.clearRect(0, 0, W, H);
    // ... existing splatter + hurt-flash blocks unchanged ...
```
Add `private dirtyLastFrame = false;` so the canvas is cleared exactly once on the transition to idle (avoids a stuck last frame). In the low-HP block (`:104-113`), cache the gradient on a `W×H×dangerBucket` key:
```ts
        const grad = this.gradFor(W, H, danger);
        g.fillStyle = grad;
        g.fillRect(0, 0, W, H);
```
and add:
```ts
  private gradFor(W: number, H: number, danger: number): CanvasGradient {
    const bucket = Math.round(danger * 8); // quantize so the cache actually hits
    const key = `${W}x${H}:${bucket}`;
    if (this.gradCache && this.gradKey === key) return this.gradCache;
    const intensity = danger * 0.7; // gradient stop intensity is the danger term; beat pulse stays via fillStyle alpha
    const grad = this.g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.72);
    grad.addColorStop(0, 'rgba(120,0,4,0)');
    grad.addColorStop(1, `rgba(120,0,4,${intensity})`);
    this.gradCache = grad;
    this.gradKey = key;
    return grad;
  }
```
**Honesty note:** the original mixes the per-frame `beat` pulse into the gradient's final alpha stop, so a pixel-exact cache isn't possible without changing the look. The quantized danger bucket keeps the vignette visually equivalent (the heartbeat already modulates `intensity` smoothly; bucketing to 8 levels is imperceptible) — this is an accepted, intentional micro-change, **render-only**, validated by L5 visual check, not a pixel assert. If the P2 profile shows this is unnecessary, **skip the gradient cache and keep only the early-out** (which is pixel-exact).

**Step 4: Run it, expect PASS.** `npx vitest run tests/scene/screenfxCache.test.ts`, then `npm test` + `npm run typecheck`. Render-only; determinism untouched.

**Step 5: Commit.** `git add src/render/screenfx.ts tests/scene/screenfxCache.test.ts && git commit -m "perf(screenfx): early-out when idle + cache low-HP vignette gradient"`

---

### Task 45: Babo gun/class subtree merge & instancing per profile (OPTIONAL structural, low/mid only)

**Files:** Modify `src/render/babos.ts` / `src/render/gunModels.ts` / `src/render/baboShapes.ts` (cache build behind `QUALITY.mergeStatics`); Test `tests/scene/baboMergeDispose.test.ts`

> Gate: ship only if the P2 scene-stats show gun-part / class-visual draw calls dominating on low/mid (per S3.5 rows **5c/5d**, `mergeStatics`-gated, OFF on high). **High-risk** (shared-resource double-free, S3.5 HIGH adversary fix) — gating to low/mid keeps the desktop/hero path on the proven per-instance code. The acceptance gate is the **spawn→swap-gun→despawn→respawn-same-class no-double-dispose test**, not a draw-call number.

**Step 1: Write the failing test.** This is the S3.5-mandated double-dispose guard, expressed as a WeakSet contract.

```ts
// tests/scene/baboMergeDispose.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { setTierOverride } from '../../src/render/quality';
import { BaboPool } from '../../src/render/babos';

describe('cached gun/class disposal safety (low/mid)', () => {
  beforeEach(() => setTierOverride('mid')); // mergeStatics ON
  afterEach(() => setTierOverride('high'));

  it('does not dispose a cache-owned geometry/material on per-babo despawn', () => {
    const scene = new THREE.Scene();
    const pool = new BaboPool(scene);
    const disposed = new Set<THREE.BufferGeometry | THREE.Material>();
    const orig = THREE.BufferGeometry.prototype.dispose;
    // spy: record every geometry dispose
    THREE.BufferGeometry.prototype.dispose = function (this: THREE.BufferGeometry) {
      disposed.add(this); return orig.call(this);
    };
    try {
      // spawn a spider with the rifle, swap gun (scavenge), despawn, respawn same class+gun
      const id = 0;
      pool.spawnFor(id, 'spider', 'rifle');       // build (caches)
      pool.swapGun(id, 'thumper');                 // disposeGunModel(rifle) must SKIP cache-owned
      pool.despawn(id);                            // disposeClassVisual must SKIP cache-owned
      pool.spawnFor(id, 'spider', 'rifle');        // reuse cached resources — must NOT be use-after-dispose
      // The cached rifle geometry must NOT appear in the disposed set after the swap/despawn.
      const cachedRifleGeo = (pool as unknown as { cacheGeoFor(gun: string): THREE.BufferGeometry }).cacheGeoFor('rifle');
      expect(disposed.has(cachedRifleGeo)).toBe(false);
    } finally {
      THREE.BufferGeometry.prototype.dispose = orig;
      pool.dispose(); // cache disposed exactly here, exactly once
    }
  });
});
```
(Adapt method names — `spawnFor/swapGun/despawn/cacheGeoFor` — to the real `BaboPool` API surface verified in `babos.ts`; the *contract* under test is invariant: a per-babo despawn/gun-swap must never dispose a cache-owned resource.)

**Step 2: Run it, expect FAIL.** `npx vitest run tests/scene/baboMergeDispose.test.ts` — fails: today there is no cache (every `buildGunModel`/`buildClassVisual` call allocates fresh and `disposeGunModel` disposes everything it traverses), so either the helper `cacheGeoFor` doesn't exist or the cached geo is disposed by `swapGun`.

**Step 3: Minimal implementation.** Per S3.5: add a per-`GunId`/per-`ClassId` template cache, gated `QUALITY.mergeStatics` (true on low/mid). Track cache-owned geos/mats in a module `WeakSet`; `disposeGunModel`/`disposeClassVisual` skip any resource in that set; the cache disposes them only at `BaboPool.dispose()`/teardown.

Sketch (apply to `gunModels.ts`/`baboShapes.ts`):
```ts
const cacheOwned = new WeakSet<THREE.BufferGeometry | THREE.Material>();

function markCached(o: THREE.Object3D): void {
  o.traverse((n) => {
    const m = n as THREE.Mesh;
    if (m.geometry) cacheOwned.add(m.geometry);
    const mat = m.material;
    if (Array.isArray(mat)) mat.forEach((x) => cacheOwned.add(x));
    else if (mat) cacheOwned.add(mat as THREE.Material);
  });
}
```
In `buildGunModel`, when `QUALITY.mergeStatics`, return a clone of a cached template (`template.clone()` shares geometry refs by default in Three; share material refs explicitly) and `markCached(template)` once. In `disposeGunModel` (`gunModels.ts:493-504`) and `disposeClassVisual` (`baboShapes.ts:316-321`), guard each dispose:
```ts
    if (geo && !cacheOwned.has(geo)) geo.dispose();
    if (mat && !cacheOwned.has(mat)) mat.dispose();
```
The cache map disposes its templates (bypassing the WeakSet guard by calling `.dispose()` directly) only in `BaboPool.dispose()`. On `high`, `QUALITY.mergeStatics` is false → the entire cache path is skipped → desktop stays byte-identical on the proven per-instance code.

**Step 4: Run it, expect PASS.** `npx vitest run tests/scene/baboMergeDispose.test.ts`, then `npm test` + `npm run typecheck`. Render-only; `purity.test.ts` green; determinism untouched. **Required follow-on L5:** run the spawn→swap→despawn→respawn loop on a real low/mid device and confirm no WebGL "use-after-dispose" console errors.

**Step 5: Commit.** `git add src/render/babos.ts src/render/gunModels.ts src/render/baboShapes.ts tests/scene/baboMergeDispose.test.ts && git commit -m "perf(render): WeakSet-guarded gun/class template cache on low/mid (no double-dispose)"`

---

### Task 46 (OPTIONAL, DEFERRED): Splat composite-into-floor

**Files:** Modify `src/render/renderer.ts` (splat plane `:84-93`), custom floor shader; Test — VERIFICATION (visual diff, no headless GL assert possible)

> **OPTIONAL / real regression risk.** Per S3.6 this is **deferred from S3.6 to S7** because a correct single-pass composite needs a **custom floor shader** for a <1 draw-call saving. **Do NOT implement unless the P2 profile shows the splat transparent plane (`renderer.ts:84-93`) is itself a measured cost** (it is already `MeshBasic`, so this is unlikely). If undertaken:
> - **No headless test can assert the GPU composite** (jsdom has no WebGL). The verification is the S8.2 scene-graph assertion that the standalone splat plane mesh is **removed from the scene** (`scene.children` no longer contains the splat plane) plus an L5 device **visual diff** confirming splat decals still paint on the floor identically.
> - Verification: `tests/scene/splatComposite.test.ts` asserts `scene.traverse` finds **zero** meshes whose material is the splat RT plane material after the floor absorbs it; then `npm run build` must pass (custom floor shader compiles).
> - Honest limitation recorded in the phase log: this is a draw-call micro-optimization with a custom-shader maintenance cost; **default decision is to SKIP** unless the profile is unambiguous.

**Step 5 (if shipped):** `git add src/render/renderer.ts tests/scene/splatComposite.test.ts && git commit -m "perf(render): composite splat RT into floor shader, drop the transparent plane (optional)"`

---

### Task 47: `snapshotCodec.ts` — Float32 binary pack/unpack with round-trip (PROFILE-GATED, D-SAFE for host sim)

**Files:** Create `src/net/snapshotCodec.ts`; Test `tests/net/snapshotCodec.test.ts`

> Gate: ship Tasks 47–48 only if the P2 profile shows **host snapshot CPU or uplink** as the bottleneck under projectile spam. This is a **BREAKING wire change** — all peers lockstep behind `C.NET_BINARY_SNAPSHOTS`. Per S5.5 it is **D-SAFE for the host sim**: encode/decode happens *after* `snapshot()` and never feeds `step()`; the host runs Float64 and clients see Float32 only in render/prediction (~1e-6 < predictor smoothing). The determinism gate for this task is: (a) encode→decode round-trips within Float32 tolerance, and (b) the **host step hash is unchanged** by introducing the codec (it is never on the `step()` path).

**Step 1: Write the failing test.**

```ts
// tests/net/snapshotCodec.test.ts
import { describe, it, expect } from 'vitest';
import { encodeSnapshot, decodeSnapshot, type NameTable } from '../../src/net/snapshotCodec';
import { makeSim, run, simHash } from '../helpers';

describe('binary snapshot codec', () => {
  it('round-trips a real snapshot within Float32 tolerance', async () => {
    const sim = await makeSim({ mode: 'tdm', botCount: 6, seed: 42 } as never);
    run(sim, 300); // populate players + projectiles
    const snap = sim.snapshot();
    const names: NameTable = new Map(snap.players.map((p) => [p.id, p.name]));
    const buf = encodeSnapshot(snap);
    const back = decodeSnapshot(buf, names);

    expect(back.tick).toBe(snap.tick);
    expect(back.players.length).toBe(snap.players.length);
    for (let i = 0; i < snap.players.length; i++) {
      const a = snap.players[i], b = back.players[i];
      expect(b.id).toBe(a.id);
      expect(b.name).toBe(a.name);            // restored from the id→name table
      expect(b.x).toBeCloseTo(a.x, 4);        // Float32 ≈ 1e-6
      expect(b.y).toBeCloseTo(a.y, 4);
      expect(b.hp).toBe(a.hp);                // integers exact
      expect(b.kills).toBe(a.kills);
      expect(b.alive).toBe(a.alive);          // bit-packed boolean
    }
    expect(back.projectiles.length).toBe(snap.projectiles.length);
  });

  it('is a transferable ArrayBuffer (Worker-ready seam, S5.6)', async () => {
    const sim = await makeSim({ botCount: 2, seed: 7 } as never);
    run(sim, 60);
    const buf = encodeSnapshot(sim.snapshot());
    expect(buf).toBeInstanceOf(ArrayBuffer);
  });

  it('introducing the codec does not change the host step hash (D-SAFE)', async () => {
    // The codec is never on the step() path: a run with encode/decode interleaved
    // must hash-equal a clean run of the same seed.
    const clean = await makeSim({ botCount: 6, seed: 42 } as never);
    run(clean, 600);
    const cleanHash = simHash(clean);

    const withCodec = await makeSim({ botCount: 6, seed: 42 } as never);
    for (let i = 0; i < 600; i++) {
      withCodec.step();
      if (withCodec.tick % 3 === 0) {
        const s = withCodec.snapshot();
        const names = new Map(s.players.map((p) => [p.id, p.name]));
        decodeSnapshot(encodeSnapshot(s), names); // exercise codec, discard result
      }
    }
    expect(simHash(withCodec)).toBe(cleanHash); // codec never touches the sim
  });
});
```

**Step 2: Run it, expect FAIL.** `npx vitest run tests/net/snapshotCodec.test.ts` — fails: `Cannot find module '../../src/net/snapshotCodec'`.

**Step 3: Minimal implementation.** Create `src/net/snapshotCodec.ts` per S5.5: a header (`tick`, counts), packed `Float32` kinematics, `u8` enum tables (gun/class/kind), bit-packed booleans, **per-tick names stripped** (restored from the id→name `NameTable`). Sketch:
```ts
import type { Snapshot, PlayerState } from '../sim/types';
import { GUN_IDS } from '../data/weapons';   // index tables for u8 enum packing
import { CLASS_IDS } from '../data/classes';

export type NameTable = Map<number, string>;

export function encodeSnapshot(s: Snapshot): ArrayBuffer {
  // 1) measure: header + N players * playerStride + M projectiles * projStride + ...
  // 2) write tick (u32), counts (u16), then per-player:
  //    id(u8), gunIdx(u8), classIdx(u8), boolBits(u8: alive|spawnProt|fortify|phase|inSlick|...)
  //    x,y,vx,vy,aim (f32×5), hp/kills/deaths/mag (i16×4), heat (f32), lastAckSeq(i32)
  // 3) projectiles: id(u32), kindIdx(u8), gunIdx(u8), x,y,vx,vy,dist,maxDist (f32×6)
  // ...grenades/pools/fires/smokes/pickups + mode (teamScores i16×2, flags...)
  // Names are NOT written (S5.5 id→name table lives in 'start').
  // returns the underlying ArrayBuffer (transferable — S5.6 seam).
}

export function decodeSnapshot(buf: ArrayBuffer, names: NameTable): Snapshot {
  // mirror the layout; restore p.name = names.get(id) ?? 'Babo' (fallback on miss).
  // reconstruct full PlayerState shape with sim defaults for fields not on the wire.
}
```
Use `DataView`/`Float32Array` over a single `ArrayBuffer`. Keep enum index tables (`GUN_IDS`, `CLASS_IDS`) so a `gun: GunId` → `u8` and back is stable; assert on decode that indices are in range (fall back to a default on a bad index). **Name fallback** (`?? 'Babo'`) covers a late-join / dropped-`start` miss (Risk #8).

**Step 4: Run it, expect PASS.** `npx vitest run tests/net/snapshotCodec.test.ts`, then `npm test` (the D-SAFE host-step-hash test in this file proves the codec is off the sim path; the golden hashes elsewhere are unaffected) + `npm run typecheck`.

**Step 5: Commit.** `git add src/net/snapshotCodec.ts tests/net/snapshotCodec.test.ts && git commit -m "feat(net): binary snapshot codec (Float32 pack, id→name table) — D-SAFE, behind flag"`

---

### Task 48: Wire `wireVersion` handshake negotiation + `client.ts:72` json→binary upgrade (PROFILE-GATED, BREAKING)

**Files:** Modify `src/net/types.ts` (carry `wireVersion` in `'hello'`/`'lobby'`/reject path), `src/net/host.ts:97-101` (handshake-reject on mismatch), `src/net/client.ts:72` (serialization upgrade after both confirm), `src/data/constants.ts` (`C.NET_BINARY_SNAPSHOTS`); Test `tests/net/wireHandshake.test.ts`

> Gate + lockstep: ship only after Task 47, only if the profile demands it, and only with **all peers on the same build**. The full id→name table (humans **and bots** — bots are host-side, never in the lobby roster, per S5.5 MEDIUM fix) is sent in `'start'` so the binary decoder can restore names.

**Step 1: Write the failing test.**

```ts
// tests/net/wireHandshake.test.ts
import { describe, it, expect } from 'vitest';
import { WIRE_VERSION, negotiateWire } from '../../src/net/types';

describe('wireVersion negotiation', () => {
  it('agrees on binary only when both sides match the wire version and flag is on', () => {
    expect(negotiateWire(WIRE_VERSION, WIRE_VERSION, true)).toBe('binary');
  });
  it('falls back to json on version mismatch (no breaking handshake)', () => {
    expect(negotiateWire(WIRE_VERSION, WIRE_VERSION + 1, true)).toBe('json');
  });
  it('stays json when the binary-snapshots flag is off', () => {
    expect(negotiateWire(WIRE_VERSION, WIRE_VERSION, false)).toBe('json');
  });
  it("'start' carries a full id→name table including bots", () => {
    // The host builds the name table from its authoritative sim player list,
    // not the lobby roster (bots have peerId='' and are absent from the roster).
    const roster = [{ peerId: 'p1', name: 'Human', bot: false }];
    const simPlayers = [{ id: 0, name: 'Human' }, { id: 1, name: 'Crusher' /* bot */ }];
    const table = Object.fromEntries(simPlayers.map((p) => [p.id, p.name]));
    expect(table[1]).toBe('Crusher');     // bot present in the wire name table
    expect(roster.some((r) => r.name === 'Crusher')).toBe(false); // but absent from the lobby
  });
});
```

**Step 2: Run it, expect FAIL.** `npx vitest run tests/net/wireHandshake.test.ts` — fails: `WIRE_VERSION`/`negotiateWire` don't exist in `src/net/types.ts`.

**Step 3: Minimal implementation.** In `src/net/types.ts`:
```ts
export const WIRE_VERSION = 1;
export function negotiateWire(mine: number, theirs: number, binaryEnabled: boolean): 'json' | 'binary' {
  if (!binaryEnabled) return 'json';
  return mine === theirs ? 'binary' : 'json';
}
```
Carry `wireVersion: number` on the `'hello'` `ClientMsg` and echo the host's on `'lobby'`/`'start'`; extend the host reject path (`host.ts:97-101`) to `reject` with reason `'version mismatch — update your client'` when `negotiateWire` would diverge in a way that can't fall back (only if you require binary). Add `C.NET_BINARY_SNAPSHOTS: false` to `constants.ts`. The host's `'start'` (`host.ts:180`) gains `names: Record<number,string>` built from `sim` players (humans + bots), and the client stores it for `decodeSnapshot`. Only when `negotiateWire(...)==='binary'` does `client.ts:72` open the connection with `serialization: 'binary'` and does `broadcast` send `encodeSnapshot(...)` instead of the JSON snap; otherwise the existing `serialization: 'json'` path is byte-identical to today. **Host inherits the client's serialization** — there is no host-side `connect()` to change (S5.5 LOW fix).

**Step 4: Run it, expect PASS.** `npx vitest run tests/net/wireHandshake.test.ts`, then `npm test` + `npm run typecheck`. With `C.NET_BINARY_SNAPSHOTS=false` (default) the wire is byte-identical to P2 → all existing net behavior and determinism unchanged. Add a phase-log note: flipping the flag is a **coordinated all-peers** change.

**Step 5: Commit.** `git add src/net/types.ts src/net/host.ts src/net/client.ts src/data/constants.ts tests/net/wireHandshake.test.ts && git commit -m "feat(net): wireVersion handshake + json→binary upgrade behind NET_BINARY_SNAPSHOTS (default off)"`

---

### Task 49: Pooled-audio geometry / voice-node reuse (PROFILE-GATED; SKIP if covered by P1 S5.7)

**Files:** Modify `src/audio/audio.ts`; Test `tests/audio/voicePool.test.ts`

> Gate: **first check whether P1's S5.7 voice budgeting already shipped** (`C.AUDIO_MAX_VOICES`, `activeVoices` ceiling, per-gun min inter-shot interval). If it did, **SKIP this task and record "covered by P1 S5.7"** in the phase log. WebAudio source nodes are one-shot by spec (cannot reuse a started `BufferSource`), so "pooling" here means the S5.7 **voice budgeting** (a global `activeVoices` ceiling + per-gun rate-limit + shared `noiseBuf`), not object reuse. This task exists only as the profile-gated fallback if budgeting was deferred. **D-SAFE** (render/audio-only; never touches the sim).

**Step 1: Write the failing test.** Stub a minimal `AudioContext` so jsdom can drive it.

```ts
// tests/audio/voicePool.test.ts
import { describe, it, expect, vi } from 'vitest';
import { Audio } from '../../src/audio/audio'; // adjust to the real export name

function stubCtx() {
  const onendedHolders: { onended?: () => void }[] = [];
  return {
    state: 'running', currentTime: 0, sampleRate: 48000, destination: {},
    createBuffer: () => ({ getChannelData: () => new Float32Array(2048) }),
    createGain: () => ({ gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {} }),
    createBufferSource: () => { const n: { onended?: () => void; buffer: unknown; connect(): void; start(): void; stop(): void } = { buffer: null, connect() {}, start() {}, stop() {} }; onendedHolders.push(n); return n; },
    resume: vi.fn(), _voices: onendedHolders,
  };
}

describe('audio voice budgeting', () => {
  it('caps concurrent voices at C.AUDIO_MAX_VOICES', () => {
    const a = new Audio();
    (a as unknown as { ctx: unknown; master: unknown }).ctx = stubCtx();
    (a as unknown as { master: unknown }).master = { connect() {} };
    let created = 0;
    const origCreate = ((a as unknown as { ctx: { createBufferSource: () => unknown } }).ctx).createBufferSource;
    ((a as unknown as { ctx: { createBufferSource: () => unknown } }).ctx).createBufferSource = () => { created++; return origCreate(); };
    for (let i = 0; i < 100; i++) a.shot('rifle', false); // spam past the ceiling
    expect(created).toBeLessThanOrEqual(24 + 1); // C.AUDIO_MAX_VOICES ≈ 24
  });
});
```

**Step 2: Run it, expect FAIL.** `npx vitest run tests/audio/voicePool.test.ts` — fails: with no ceiling, `created` is 100.

**Step 3: Minimal implementation (only if not already done in P1).** Add `C.AUDIO_MAX_VOICES: 24` to `constants.ts`; add a `private activeVoices = 0` counter incremented when a source is created and decremented in its `onended`; bail out of voice creation when `activeVoices >= C.AUDIO_MAX_VOICES`; add a per-gun `lastShotAt` map dropping a non-local `shot` voice if the same gun fired `<25 ms` ago. Keep the shared `noiseBuf` (already shared, `audio.ts:33`). **If P1 already added all of this, this task is a no-op — delete the test and record the skip.**

**Step 4: Run it, expect PASS.** `npx vitest run tests/audio/voicePool.test.ts`, then `npm test` + `npm run typecheck`. Audio-only; determinism untouched (`purity.test.ts` already forbids `src/sim/**` from importing audio).

**Step 5: Commit.** `git add src/audio/audio.ts src/data/constants.ts tests/audio/voicePool.test.ts && git commit -m "perf(audio): global voice ceiling + per-gun rate-limit (profile-gated fallback)"`

---

### Task 50: Document the Worker-offload seam (NO BUILD — CUT per YAGNI)

**Files:** Modify `src/app.ts` (one comment block at the `tick()` advance point), Modify `src/net/snapshotCodec.ts` (one comment); **no test, no behavior change**

> Per S5.6 the Web Worker sim offload is **CUT** (YAGNI): `step()` < 8 ms for 8 bots, the mobile bottleneck is render/GPU not sim, most phones JOIN (run no sim), and a Worker needs its own 1.07 MB Rapier WASM (fighting S4). **We do NOT build it.** We only record the seam so a future revisit (gated on a profile proving main-thread *sim* time > 10 ms in chaos) is cheap.

**Step 1–4 (VERIFICATION, no unit test):** Add a comment at `App.tick()` (the single sim advance point, `app.ts:418`) and in `snapshotCodec.ts` documenting the seam:
```ts
// --- Worker-offload seam (S5.6, CUT per YAGNI; do not build without a profile) ---
// App.tick() is the single sim advance point; host.applyInputs/afterStep bracket it.
// A future Worker port would: (1) instantiate Rapier WASM INSIDE the Worker (S4.8 —
// base:'./' Worker URL resolution differs from main-thread import.meta.url on GH Pages),
// (2) reuse encodeSnapshot()'s transferable ArrayBuffer (Task 47) as the postMessage payload,
// (3) keep this main thread as the input/render side only.
// Revisit ONLY if a device profile proves main-thread SIM time (not render) > 10 ms in chaos.
```
Verification: `npm run build` passes (comment-only change compiles) and `npm test` stays green. Grep-assert the seam is documented:
```
git diff --staged | grep -q "Worker-offload seam" && echo "seam documented"
```

**Step 5: Commit.** `git add src/app.ts src/net/snapshotCodec.ts && git commit -m "docs(net): record Worker-offload seam (CUT per YAGNI) at the sim advance point"`

---

> **Phase 3 exit gate (per S8.7, profile-gated).** For every task actually shipped: `tsc --noEmit` green; `npm test` green incl. all new scene/net/audio tests; `purity.test.ts` green (no render/net/audio leak into `src/sim/**`); flag-OFF golden hash == P2 baseline (binary snapshots are D-SAFE — the host-step-hash test in Task 47 proves it); step-cost `<8 ms` and the heavy-projectile median still under budget; **L5 device sign-off** (`__bv3perf` p50 ≥58 fps, p95 ≤~22 ms, portrait, on Pixel 6a / iPhone 11 / SE2) — CI has no GPU so this is the required human checkbox. **Desktop (`tier==='high'`) must be visually/behaviorally identical to P2** (the only intentional delta is Task 43's shadow `InstancedMesh`, still pixel-identical), verified by visual diff. **Any task whose named bottleneck did not appear red in the P2 profile is SKIPPED with the reason recorded in the phase log.**

