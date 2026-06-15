# Mobile + Performance — Implementation Log

Implementation of `docs/plans/2026-06-14-mobile-and-performance-design.md` (spec) via
`docs/plans/2026-06-14-mobile-and-performance-implementation-plan.md` (72-task TDD plan),
on branch `mobile-perf`. Executed strictly test-first; every change is gated so the
desktop build stays byte-identical and per-seed sim determinism is preserved.

## Determinism discipline (held throughout)
- A golden-hash guard (`tests/determinism.test.ts`, `simHash` over the full sim state incl.
  smokes/pickups/CTF flags) freezes tdm/bounty/ctf at ticks 300/600/1200, plus cross-instance
  equality. **D-SAFE** changes keep it byte-identical (never `-u`); the single **D-SHIFT**
  bundle (`SIM_BASELINE_V`) was the only sanctioned re-baseline — and it turned out hash-neutral.
- `tests/purity.test.ts` statically forbids `src/sim/**` from importing render/net/audio/three/peerjs.

## Foundation (DONE)
`src/data/runtime.ts` RUNTIME config; `simHash` + golden-hash guard; purity guard; inert
`FLAGS`/`C.*` flags. The regression safety net all later phases depend on.

## Phase 1 — "It Loads" (DONE)
- **Rapier deferral:** lazy `initPhysics()` (no eager await; loads at match entry, never on the menu).
  The 1 MB WASM rides a **deferred chunk** — the original single ~2.25 MB bundle is now a **~87 KB
  entry** + lazy `three`/`peerjs`/rapier chunks. (See "Rapier loading" below for the production fix.)
- **Mobile shell:** `visualViewport` sizing bus; `viewport-fit=cover` + scoped gesture suppression;
  iOS audio unlock (`webkitAudioContext` + silent buffer) + visibility suspend; wake-lock; host-only
  hidden-tab keep-alive.
- **Quality tiers:** `quality.ts` tier detection (coarse-pointer/cores; never `deviceMemory`) + DPR/AA
  clamp on mobile. Desktop = `high` = byte-identical.
- **Sim D-SAFE cleanups:** `normInto`, `segAABB` scalar unroll, `groundPoint` reuse, audio voice budgeting.
- **D-SHIFT bundle:** `PLAYER_CCD=false` + `distSq` leaf swaps behind `SIM_BASELINE_V=2`; **hash-neutral**
  in the golden replays; interior-wall tunneling stress test passes (~6u margin).

## Phase 2 — "It Plays" (DONE)
- **Touch layer** (`src/touch/touchControls.ts`, an `InputSource` sibling): twin floating sticks
  (left = analog move, right = aim + auto-fire), soft **aim-assist** (≤0.30, Lance-lead-exempt,
  computed in the producer so the sim is untouched), grenade **drag-arc**, SKILL/RELOAD/EQUIP/PICKUP/
  scoreboard/leave buttons, consume-on-first-sample latches, blur/cancel neutral reset. Desktop
  mouse/kb is byte-identical (dormant TouchControls asserted no-op; `activeSource` stays `kbm`).
- **App/camera/HUD:** source-aware `sampleInput`; portrait camera zoom (`camDistScale 1.25`) + reduced
  aim-lead; wall-clamped **red aim laser**; HUD relocates to safe-area corners on touch.
- **Responsive shell + PWA:** portrait `@media` single-column lobby/menu/end, ≥44 px targets, inline
  tooltips; manifest + **build-time PNG icon rasterization** (`@resvg/resvg-js`, no committed binary);
  Android-only progressive-enhancement fullscreen (iOS Safari has none — layout works without it).
- **Render tiers:** `surfaceMat` Standard→Lambert→Basic (high = original Standard, untouched); babo body
  opaque-with-phase-gated-transparency; babo shadows → one `InstancedMesh` (all tiers, pixel-identical);
  WeakSet-guarded wall/gun/class merge+cache (low/mid only); splat-RT shrink + particle/fire/smoke
  tiering; lobby-preview skip-on-low / throttle-on-mid. The babo marble shader is never downgraded.
- **All-projectile Lance** behind `FLAGS.PROJECTILE_LANCE` (**default OFF**): Lance → 110 u/s rail slug
  through `fireProjectiles`, terminal-only beam, render dead-reckon, `MAX_PROJECTILES` drops oldest
  *bullet* only. Flag-OFF is byte-identical to the pre-change baseline; flag-ON is a distinct RNG stream
  with its **own** golden baseline; a `BALANCE=1` probe is the tuning aid (Lance not dominating).

### Rapier loading — production-build fix (IMPORTANT)
The spec's `@dimforge/rapier2d` (non-compat) + `vite-plugin-wasm` + `vite-plugin-top-level-await` +
dynamic `import()` **passes vitest and dev mode but fails the production build**: the WASM-init TLA
wrapper lands in the entry chunk, disconnected from the Rapier module in the deferred chunk, so
`new World()` throws `rawintegrationparameters_new of undefined`. Caught only by browser-testing the
built output. **Fixed** by reverting to `@dimforge/rapier2d-compat` loaded **lazily** via
`await RAPIER.init()` inside the existing dynamic import — its base64 WASM rides the deferred chunk
(menu still loads Rapier-free), and compat@0.14.0 is the same engine so determinism is byte-identical.
Lesson: always `vite preview` (production build) browser-test for code-split/WASM changes, not just dev.

## Phase 3 — "It Holds 60" (PROFILE-GATED — implemented the un-gated wins, deferred the rest)
The spec gates Phase-3 structural work on a real-device frame-time profile (S8.5, `window.__bv3perf`
p50/p95 on a mid-range phone). **No such device was available in this environment**, so per the spec's
own instruction ("SKIP and record why"):

**Implemented (recommended / low-risk, audit-justified, no profile needed):**
- **`client.view` memoization** on the interp timestamp + `predictedSelf()` so the per-tick path skips
  full view rebuilds (D-SAFE, client-only; memo equals fresh, not an approximation).
- **Pooled VFX geometry** (shared ring/beam geometry, no per-event alloc/dispose).
- **Particle-record pooling** (recycled `Particle` free-list).
- **screenfx gradient cache + idle early-out** (skip the full-screen clear+gradient when nothing to
  draw; vignette gradient rebuilt on resize only; pixel-exact via `globalAlpha`).

**Already covered earlier:** babo shadow `InstancedMesh` (Phase-2 Task 52); audio voice budgeting
(Phase-1 S5.7).

**Deferred — pending a measured red device profile (do NOT build speculatively):**
- Babo gun/class subtree merge & instancing per profile (risk: the custom babo shader; low/mid only).
- Splat composite-into-floor (OPTIONAL; custom floor-shader regression risk).
- **Binary `Float32` snapshots + `wireVersion` json→binary upgrade** — a **BREAKING** wire change
  requiring all peers in lockstep; ship only if the profile shows host snapshot CPU / uplink as the
  bottleneck under projectile spam.

**Cut (YAGNI):** Web Worker sim offload — the bottleneck is render/GPU, `step()` is < 8 ms (~0.03 ms
measured for 8 bots), and most phones join rather than host. Documented as a seam only.

## Verification
- `npm test`: **300 passed + 1 skipped** (the `BALANCE`-gated probe); `npm run typecheck` clean;
  `npm run build` clean (entry chunk has no static three/rapier/peerjs; deferred chunks + the WASM).
- Determinism golden snapshot stable without `-u` across all D-SAFE work; the one D-SHIFT re-baseline
  was hash-neutral.
- **Production build browser-verified** (`vite preview`): menu boots Rapier-free; a touch practice match
  starts (touch layer + all 6 action buttons mount, left-stick drag yields analog movement, sim runs),
  zero console errors.
- Remaining: **L5 real-device sign-off** (mid-range phone, p50 ≥58 fps in 8-bot chaos, touch-only full
  match) is a manual checkbox by design and gates whether any deferred Phase-3 item is needed.

## Control GUI redesign (post-first-device-feedback)
First-device feedback: the floating sticks were **invisible** ("guessing where to put your thumbs"),
controls had **no icons**, and the action buttons **stacked aimlessly up the right edge** (colliding with
the aim thumb). Redesigned from a researched spec (`docs/plans/` design workflow: 5-angle web sweep on
portrait twin-stick GUI + thumb-zone ergonomics → synthesis → adversarial critique). All changes are
**visual + input-PRODUCTION only**; the emitted `PlayerInput` and every sim constant stay byte-identical
(golden determinism guard green, never `-u`; 50 touch tests incl. an explicit "visuals don't change
emitted input" pin).
- **Visible hybrid sticks** (`src/touch/touchControls.ts` + `src/ui/styles.css`): each side keeps the
  determinism-safe floating origin but now draws a faint always-on **home ghost ring + center SVG glyph**
  (move-cross / crosshair) so the thumb has a permanent, self-documenting target; a **floating active ring
  + knob** blooms at the (on-screen-clamped) touch point and tracks deflection. Right stick reddens and
  swaps crosshair→**muzzle-burst** past the autofire deadzone (and drops that visual while the grenade arc
  is modal, mirroring the FIRE suppression).
- **Action-chip cluster, no stack**: SKILL/RELOAD/NADE placed off the aim-thumb working envelope (≥88px
  keep-out, ≥14px inter-chip gaps on the 390×844 baseline), each with an **SVG icon + caption**; contextual
  PICKUP low-center; SCORE/LEAVE demoted to dim top corners. The right activation zone now **carves out the
  chip hit rects** so a thumb-down on a button can't start a phantom aim stick, and `onDown` ignores the
  bottom **home-indicator strip**.
- **Screen-space grenade drag-arc affordance** on EQUIP-hold (origin dot + max-range ring + knob), hidden
  the instant THROW releases. World landing reticle already gold — distinct from the red aim laser.
- **Robustness**: `setPointerCapture` is now routed through a guarded `capture()` helper (swallows the
  NotFoundError on synthetic/lost pointers) for both sticks AND the SKILL/EQUIP buttons; the window-level
  pointerup fallback was extended from SKILL-only to **both sticks** so nothing can stick on if capture fails.
- **Verified**: adversarial code review (no blockers, determinism confirmed by line-by-line diff); the
  **production build** browser-tested (`vite preview`) — sticks render with glyphs, active rings bloom,
  firing reddens + glyph-swaps, grenade overlay shows/hides, zero console errors, Rapier defers cleanly.
  Ergonomic spacing (exact thumb reach) is the next **real-device** check on the user's phone.
- **Deferred** (YAGNI for first device feel): left-handed mirror mode (designed + gated, not built),
  accumulated/edge-relative grenade drag magnitude for the screen-edge corner case.
