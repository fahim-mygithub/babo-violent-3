# Babo Violent 3 — Mobile Playability & Performance Design Spec

## Intent

Babo Violent 3 is a web-native, top-down, host-authoritative physics arena shooter (Vite + TypeScript + Three.js + Rapier2D-WASM + PeerJS, shipped on GitHub Pages, zero binary assets, deterministic 60 Hz sim). This document specifies how to add **mobile playability** (portrait twin-stick touch controls) and **mid-range-phone performance** (automatic quality tiers, render/bundle/netcode optimizations) as a **strictly additive, feature-flagged, phase-gated** layer on top of the shipping desktop game — without regressing desktop behavior and without breaking per-seed float determinism. Every change is gated behind a single `RUNTIME` config object; forcing `{ touch:false, tier:'high', projectileLance:false }` reproduces today's exact desktop build at every phase boundary, so mobile can be cut at any boundary without harming the desktop product.

---

## Goals & Non-Goals

### Goals
- A phone player can move, aim, auto-fire, throw grenades, use skills, reload, and read the HUD in **portrait** orientation, touch-only.
- Stable 60 fps in normal fights on the mid-range floor (Pixel 6a / iPhone 11 / SE2 class), graceful dip under chaos, automatic quality tier.
- Faster startup: menu paints before any WASM/Three/PeerJS download.
- Convert the one remaining hitscan weapon (Lance) to a fast projectile game-wide, feature-flagged, for more counterplay.
- Desktop game is byte-identical with the default config.
- Per-seed determinism preserved; the vitest determinism + perf-budget gates stay green.

### Non-Goals
- **Landscape orientation.** Portrait only (locked).
- **Fullscreen dependence.** iPhone Safari lacks `Element.requestFullscreen`; layout must work without it. Fullscreen is Android-only progressive enhancement.
- **Web Worker sim offload, full babo instancing, binary snapshots are NOT committed for the 60 fps floor** — they are Phase-3-optional/profile-gated or cut (see roadmap & YAGNI rationale).
- **Lag-compensation / shooter-side rewind.** Host-authoritative, defender's dodge is authoritative; no rewind buffer.
- **Damage falloff** on the new projectile Lance (preserves the "huge single hit" identity).
- `navigator.deviceMemory` is never read (unsupported on iOS Safari).

---

## Locked Decisions (design around these)

1. **PORTRAIT** orientation: arena fills top ~60%, transparent controls overlay bottom ~40%. Camera zooms out a notch in portrait. Never landscape; never `screen.orientation.lock()`.
2. **Performance floor = mid-range phone** (Pixel 6a / iPhone 11 / SE2). Stable 60 fps normal fights, graceful dip under chaos, automatic quality tier.
3. **Twin virtual sticks**, additive/experimental (desktop mouse/kb unchanged; auto-detect coarse pointer + manual toggle). Left stick = analog move; right stick = aim + **auto-fire while deflected** (gated by reload/heat/ammo) + red laser/reticle + soft **aim-assist** magnetism. Right-side buttons: SKILL, RELOAD (manual), EQUIPMENT (press-hold pops a grenade drag-arc). Combat HUD relocates to fixed safe-area corners on touch.
4. **All gun bullets become projectiles** game-wide (convert Lance hitscan → very fast projectile). Carries a balance/TTK retune and projectile netcode handling. Must be feature-flaggable.

---

## S1 — Mobile Control Architecture

### S1.0 Design invariant
The sim consumes aim verbatim: `GameSim.step()` does `p.aim = p.input.aim` (`src/sim/sim.ts:195`); the host applies the client's `PlayerInput` unchanged (`src/net/host.ts:190-197`); the client predicts with the same `PlayerInput` (`src/net/client.ts:235-241,288-289`). **Therefore the entire touch layer — including aim-assist — is computed in the input producer and emitted as an ordinary `PlayerInput`.** The sim, bots, netcode, and snapshot format are untouched; determinism is preserved by construction. The one required additive sim change (manual reload, S1.11) is inert for all existing inputs.

### S1.1 `TouchControls` as an `InputSource` sibling
Today `App` owns `private input = new InputManager()` (`src/app.ts:31`), sampled in `sampleInput()` (`src/app.ts:411-416`). Introduce a structural interface and a parallel producer with the identical contract:

```ts
export interface InputSource {
  enabled: boolean;
  showScores: boolean;
  sample(ground: { x: number; y: number }, px: number, py: number): PlayerInput;
  dispose(): void;
}
```

`InputManager` already matches this (`src/input.ts:92-100`). New file `src/touch/touchControls.ts` exporting `class TouchControls implements InputSource`, plus touch-only read state for renderer/HUD: `aimActive, aimAngle, aimMag(0..1), firing, grenadeArc{active,aim,dist}`. For touch, the `ground` arg is ignored — `TouchControls.sample` computes its own aim from the right stick.

### S1.2 Auto-detect + manual toggle
Detection: `matchMedia('(pointer: coarse)').matches && matchMedia('(hover: none)').matches` (iOS-safe). Persist `localStorage['bv3-touch'] ∈ 'auto'|'on'|'off'` (default `'auto'`; `auto`→coarse).

`App` changes: replace `private input` with `private kbm = new InputManager()`, `private touch: TouchControls | null`, `private activeSource: InputSource = this.kbm`, `private useTouch = false`. Build `TouchControls` lazily in `enterMatch()` (`src/app.ts:374-386`) when touch is effective; dispose+null in `teardownMatch()` (`src/app.ts:510-522`); add/remove `document.body.classList.toggle('touch-mode')`. A menu toggle (S6 owns the DOM) rewrites localStorage and hot-swaps `activeSource`.

`sampleInput()` becomes source-aware:
```ts
private sampleInput(view: WorldView | null) {
  const local = this.localPlayer(view);
  if (!local || !this.renderer) return emptyInput();
  if (this.activeSource === this.touch && this.touch)
    return this.touch.sample({ x: 0, y: 0 }, local.x, local.y);
  const ground = this.renderer.groundPoint(this.kbm.mouseX, this.kbm.mouseY);
  return this.kbm.sample(ground, local.x, local.y);
}
```

### S1.3 DOM + event model
`TouchControls` builds one absolutely-positioned `<div id="touch-layer">` (S6 reserves this id and its gesture-suppression CSS) appended to `this.container`, above `#game-canvas`, below the dialog layer. **Input uses Pointer Events** (`pointerdown/move/up/cancel`) with `setPointerCapture`, each gesture keyed by `pointerId` (left stick, right stick, each button, grenade arc) so up to 4 contacts never cross-talk. `touch-action:none` on the surface + `preventDefault()` on `pointerdown` kill scroll/zoom/long-press. **S1 buttons (SKILL/RELOAD/EQUIPMENT) use `touch-action: manipulation`** so taps fire without the 300 ms delay while remaining tappable. `pointercancel`/blur/visibility-hidden reset the owning gesture to neutral. `sample()` is pure (no alloc beyond the returned object).

### S1.4 Left stick → analog movement
Floating-origin stick (origin = first left-zone touch-down). `STICK_R = 56` CSS px. `m = min(1, hypot(dx,dy)/STICK_R)`; map screen→sim axes identity (screen +x→sim +x, screen +y→sim +y, per `groundPoint` `clientY→sim y`, `src/render/renderer.ts:223-228`):
```ts
this.moveX = (dx / mag) * m;  // mag = hypot(dx,dy), guarded for 0
this.moveY = (dy / mag) * m;
```
`sample()` sets `input.mx=moveX, input.my=moveY`. Sim normalizes `[-1,1]` intent (`src/sim/types.ts:17`) → analog walk/sprint free. Dead-zone `m<0.12`→0; release snaps to 0.

### S1.5 Right stick → aim angle + auto-fire
```ts
this.aimAngle = Math.atan2(dy, dx);          // screen +y = sim +y
this.aimMag   = Math.min(1, mag / AIM_STICK_R);
this.aimActive = true;
```
**Auto-fire delegates ALL gating to the sim's `weaponSystem` (`src/sim/systems/weapons.ts:76-98`)** — touch only OR-s `BTN.FIRE` while deflected past `AIM_DEADZONE=0.25`; the sim suppresses shots when reloading/overheated/empty. Releasing clears `aimActive`→`BTN.FIRE` drops→fire stops (mirrors LMB-up; charge guns decay, heat cools).

`aim`/`aimDist` emitted:
- `input.aim` = the assisted angle (S1.6).
- `input.aimDist = lerp(AIM_MIN_DIST=3, AIM_MAX_DIST=16, aimMag)` (bullets ignore aimDist; it feeds camera lead + grenade/well range). Grenade arc overrides (S1.9).
- Inactive stick: hold last `aimAngle`, emit `aimDist = AIM_MIN_DIST`.

**Camera-lead reconciliation (adversary fix):** synthesized `aimDist` feeds camera lead (`renderer.ts:196-200`) and on a small portrait viewport can shove the babo out of the top-60% band, fighting the S1.13 `camTargetYBias`. **Add `GameRenderer.aimLeadScale` (default 1; set to 0.35 when `useTouch`)** applied to the lead term, and validate the babo stays in the top band against `camTargetYBias`. Documented in S1.13.

### S1.6 Aim-assist — soft angular magnetism (client-side, host-recomputable)
Computed inside `TouchControls.sample()` on the local client, baked into `input.aim`, **before** transmission. Loop over the current world (no alloc), reusing `angleDiff` (`src/core/math.ts:47`):
```ts
let best=-1, bestErr=ASSIST_CONE, bestAng=0;
for (const e of this.players) {
  if (!e.alive || e.id===this.localId) continue;
  if (local.team!==-1 && e.team===local.team) continue;      // teammates excluded
  const d = Math.hypot(e.x-px, e.y-py); if (d>ASSIST_RANGE) continue;
  const ang = Math.atan2(e.y-py, e.x-px);
  const err = Math.abs(angleDiff(rawAim, ang));
  if (err<bestErr){ bestErr=err; best=e.id; bestAng=ang; }
}
let aim = rawAim;
if (best>=0) {
  // optional lead toward target+vel*(dist/projSpeed); see S2.5
  aim = rawAim + angleDiff(rawAim, bestAng) * ASSIST_STRENGTH * (1 - bestErr/ASSIST_CONE);
}
input.aim = aim;
```
Defaults (one `ASSIST` block): `ASSIST_CONE=0.30` rad, `ASSIST_STRENGTH=0.30` (capped low — see netcode fix below), `ASSIST_RANGE=22`. No LOS requirement (soft, forgiving; sim resolves the real hit). `window.__bv3.touchAssist` (default on) gates it.

**Host/client aim-reconciliation (HIGH adversary fix — applied).** Verified: the host applies only `entry.freshest` and discards older buffered inputs (`host.ts:190-197`); the client sends only `window=pending.slice(-3)` (`client.ts:239-240`) and snapshots every 3rd tick (`host.ts:203`); the predictor reconciles only x/y/vx/vy and sets `p.aim = pending[last].aim` with **no aim reconciliation** (`client.ts:283-289`). Therefore client-baked per-tick magnetism can make the rendered laser and the host's actual shot diverge under jitter/loss — the "my reticle was on him" problem, worsened by S2 travel-time projectiles. **Resolution (decisive):**
- Aim-assist is documented as a **client-local feel aid**; no aim reconciliation is added.
- To bound divergence, **`ASSIST_STRENGTH` is capped at ≤0.30** and the accepted-mismatch risk is recorded in the S8 netcode test plan.
- **Phase-2-optional host re-derivation (deferred, not default):** ship the raw stick angle + an `assistTargetId` in `PlayerInput` and let the host re-derive the magnetized angle from its own authoritative positions, removing the mismatch entirely. This is a clean extension of `PlayerInput` and is only undertaken if playtest shows the capped client-baked assist feels wrong. Marked Phase-2-optional to keep Phase-2 scope bounded.

`setWorld(view, localId)` is called in **both** `App.tick()` branches (host/local and client) with a null/empty guard (MEDIUM adversary fix): on a fresh client `client.view` is null until the first snapshot (`client.ts:257`) → assist loop is skipped harmlessly. On a client the assist targets interpolated (lagged ~`INTERP_BUFFER_MS`) positions (`client.ts:273-292`) — accepted given the low `ASSIST_STRENGTH`; the host-re-derivation option above removes the lag if needed.

### S1.7 Right-thumb contention — spatial zoning + modality
- **Aim stick** owns the open lower-right (~bottom 40% × right 55%); first pointer-down here = aim+autofire; dominant.
- **SKILL/RELOAD/EQUIPMENT** are small (~58 px) `pointerId`-keyed edge buttons mid-height; a `pointerdown` on a button rect is consumed by the button, never starts the aim stick.
- **Grenade drag-arc is modal** — exists only while EQUIPMENT is held; that finger's drag becomes the arc; release restores aim. Arc and aim stick never share a finger. Left thumb (move) is unaffected, so the player can strafe while aiming a grenade. (Accepted gap vs desktop: cannot fire gun and aim grenade simultaneously — intended; flagged for playtest.)

### S1.8 Combat HUD relocation to safe-area corners
Today the combat cluster anchors to the mouse (`src/render/hud.ts:104,116-117`; `{x:mouseX,y:mouseY}` from `src/app.ts:460`). Additive:
- Add `Hud.touchMode`; `App.enterMatch` sets it from `useTouch`.
- In `App.frame()` (`src/app.ts:460`) pass anchor by source: desktop → `{x:mouseX,y:mouseY}`; touch → `renderer.project(local.x,local.y,0.6)` so reticle/heat ring hug the babo.
- In `touchMode`, also draw a **fixed status panel** in the bottom-left safe area (ammo/heat, reload progress, ability-ready pip, grenade/equip count) at `(inset, H-inset)` — canvas-draw only, no DOM. Inset = `env(safe-area-inset-*)` via CSS var, else 16 px.
- Scoreboard: desktop Tab-hold (`src/input.ts:30-38`); touch adds a top-center toggle flipping `touch.showScores` (`App.frame()` already forwards `activeSource.showScores`). Leave-match: top-left button calling `showMenu()` via an `App` callback.

### S1.9 Grenade drag-arc (mirrors RMB hold-release, zero sim change)
Desktop: hold RMB → `BTN.THROW` grows `p.throwT`; release throws toward `p.input.aim` at `clamp(p.input.aimDist,…)` scaled by hold time (`src/sim/systems/grenades.ts:40-45,147-149`). Touch:
- `pointerdown` EQUIPMENT: `grenadeArc.active=true`, record origin; `sample()` OR-s `BTN.THROW`; suspend aim stick for this pointer.
- `pointermove`: `grenadeArc.aim = atan2(dy,dx)`; `grenadeArc.dist = clamp(lerp(GRENADE_MIN_RANGE, GRENADE_MAX_RANGE, min(1, hypot(dx,dy)/ARC_DRAG_PX=140)), …)`. `sample()` sets `input.aim/aimDist` from the arc (overrides gun aim).
- `pointerup`/`pointercancel`: clear active, drop `BTN.THROW` → the sim's `releaseThrow` falling-edge (`grenades.ts:43-45,125-161`) throws using the last-sent arc aim/dist. Empty pockets → no-op (`grenades.ts:138`); death zeroes `throwT` (`grenades.ts:33-37`).

Renderer draws the predicted arc (dashed line + landing reticle) while active, reusing projection.

### S1.10 Aim laser + reticle (render-only, honest occlusion)
Cosmetic, local-only, no netcode. While `aimActive`/`grenadeArc.active`: one reused `THREE.Line` (2-vertex `BufferGeometry`, `LineBasicMaterial 0xff3030`, `transparent`) from muzzle (`babo + dir*0.65`, per `weapons.ts:8`) along `aimAngle`. Reticle = a reused ring sprite at the laser end. Created once, reused (no per-frame alloc), only when `useTouch`.

**Occlusion (LOW adversary fix — applied):** the draft's `depthTest:false` would draw the beam **through walls**, falsely implying a clear shot. **Clamp the laser length to the first wall** via the existing wall sweep used at `sim.ts:216-223` (`segAABB` loop over `map.walls`) so the beam stops at the first wall — honest about projectile travel. (Either drop `depthTest:false` to let wall meshes occlude via the depth buffer, or clamp the length; we choose the length-clamp because it also matches projectile stop semantics.)

### S1.11 Manual RELOAD — the one required additive sim change
Verified: no manual reload exists; `weaponSystem` reloads only automatically (empty-mag shot or FIRE-on-empty, `weapons.ts:100-107`). `BTN` has only FIRE/THROW/ABILITY/PICKUP (`types.ts:9-14`); `p.prevButtons` exists (`sim.ts:202`).
1. Add `RELOAD: 16` to `BTN`; `emptyInput` unchanged.
2. After the auto-reload block (`weapons.ts:107`), add an edge-triggered manual reload, inert for heat guns/full mags/mid-reload:
```ts
const reloadPressed = (p.input.buttons & BTN.RELOAD) && !(p.prevButtons & BTN.RELOAD);
if (gun.sustain === 'reload' && reloadPressed &&
    p.reloadT === 0 && p.mag < (gun.magSize ?? 0) && !discharged) {
  p.reloadT = gun.reloadTime!;
  sim.emit({ t: 'reloadStart', player: p.id, gun: p.gun });
}
```
3. **Touch RELOAD latch (MEDIUM adversary fix — applied):** `FixedLoop.advance` can call `tick()`→`sample()` more than once per frame during catch-up (`loop.ts:38-41`), so a "clear-after-one-emit" latch is fragile. **Set `buttons |= BTN.RELOAD` and clear the latch inside `sample()` the first time it is consumed**, so each `sample()` emits the bit at most once and exactly the first sample after the tap sees it — independent of ticks/frame. Same rule for the contextual PICKUP latch.
4. Optional desktop `KeyR` OR-ing `BTN.RELOAD` (`input.ts:76-82`) — free feature behind the same opt-in bit; cannot change existing recordings.

S8 adds a test running 2 ticks in one frame asserting exactly one `reloadStart`.

### S1.12 SKILL and PICKUP buttons
- **SKILL = `BTN.ABILITY`** (`abilities.ts:62,75`): supports hold (grapple, `abilities.ts:63`) and rising-edge casts (dash/fortify/phase/well, `abilities.ts:75`) — `pointerdown` OR `BTN.ABILITY` while held, `pointerup` drops (exactly desktop Space). Well/grapple aim off `p.aim`/`aimDist` = the right-stick aim.
- **PICKUP = `BTN.PICKUP`** (desktop `KeyE`): contextual button appearing only when the HUD pickup prompt is live (proximity test `hud.ts:339-342`); press → one-frame `BTN.PICKUP` via the same consume-on-first-sample latch.

### S1.13 Portrait camera zoom-out + lead reconciliation
Renderer hardcodes `CAM_DIST=21, CAM_ANGLE=65°` (`renderer.ts:23-24`). Add:
- `GameRenderer.camDistScale=1`; `render()` uses `CAM_DIST * camDistScale` (`renderer.ts:206-207`). `App.enterMatch` + a S6 orientation listener set `camDistScale = useTouch && isPortrait ? 1.25 : 1` (`isPortrait = innerHeight>innerWidth`).
- `GameRenderer.camTargetYBias=0` applied in `render()` so the babo sits in the upper band (S6 tunes the offset).
- `GameRenderer.aimLeadScale=1` (set 0.35 on touch) reducing the synthesized-aimDist camera lead so the babo stays in the top-60% band (from S1.5).

**Cross-section note to S3:** the 1.25× portrait zoom enlarges the view frustum → more entities in view → more draw calls on exactly the mid-range phones S3 must keep at 60 fps. S3's tier budget accounts for this (the tiered material/instancing path is sized for the wider portrait frustum).

### S1.14 Edge & error handling (normative)
- **No local/dead player:** `sampleInput` returns `emptyInput()`; `TouchControls.sample` tolerates unset `players` (assist skipped).
- **pointercancel / blur / visibilitychange-hidden (NORMATIVE, MEDIUM adversary fix):** zero `moveX/moveY/aimActive/firing/grenadeArc` **and all button latches** so the very next `sample()` returns neutral — critical because the host keeps simming while hidden (`loop.ts:56-58`, host-only per S5.3). Add a test asserting post-blur `sample()` returns `buttons===0, mx===my===0`.
- **Source hot-swap mid-match (NORMATIVE):** force the outgoing source to emit `emptyInput` for one tick before swapping; reset `kbm` held keys; dispose `#touch-layer`; no sim state touched.
- **Orientation flip:** recompute zone rects + `camDistScale`/`camTargetYBias` on `resize`/`orientationchange`; in-flight gestures treated as `pointercancel`.

---

## S2 — Projectile-Combat Gameplay Change

### S2.0 Current reality
Verified: **7 of 8 guns are already projectiles**; only the **Lance** is hitscan (`fireLance`, `weapons.ts:166-196`; data `weapons.ts:90-96` `projectileSpeed:0, hitscan:true`). The `hitscan` flag is effectively dead (selection is by `gun.chargeTime`, `weapons.ts:82`). The 7 projectile guns flow through `fireProjectiles()` (`weapons.ts:145-163`) → `projectileSystem` (`projectiles.ts:18-94`, host-authoritative, kinematic, no rapier body). **The entire S2 change is converting the Lance.**

### S2.1 Summary
1. Add `ProjectileKind 'rail'` and route the Lance through `fireProjectiles`.
2. Retune Lance data (finite speed, knockback on hit).
3. Feature flag `FLAGS.PROJECTILE_LANCE`.
4. Per-tick projectile budget cap.
5. Reuse existing projectile snapshot/interp netcode; mask the fast slug visually.

### S2.2 Feature flag
In `src/data/constants.ts` (where sim tunables live; imported by sim + tests — **not** `window.__bv3`, to stay headless/deterministic):
```ts
export const FLAGS = {
  PROJECTILE_LANCE: true,   // false → exact legacy hitscan fireLance + old 'rail' event
  MAX_PROJECTILES: 256,     // applies to all guns (S2.7)
} as const;
```
Read once per fire (compile-time-like branch). Expose `window.__bv3.flags = FLAGS` for dev toggling. **Must be identical on host + all clients** (build/match constant, never per-client); if ever runtime-toggled it must be part of the host-sent match config.

### S2.3 The conversion

**Type** (`types.ts:115`): `export type ProjectileKind = 'bullet' | 'rocket' | 'flame' | 'rail';`. No new `Projectile` fields except `ox, oy` (see beam fix below).

**Data** (`weapons.ts:90-96`): `projectileSpeed: 110, hitscan:false` (was `0`/`true`); damage `60`, `spread:0`, charge/heat/recoil/lockout unchanged.

**Muzzle speed = 110 u/s (MEDIUM adversary fix — recalibrated from 140).** Rationale: at the **median** engagement distance (~15 u), 140 u/s gives only ~0.107 s flight (~7 ticks) with sub-pixel required lead — combined with aim-assist the slug would be functionally un-dodgeable at typical range, so "more counterplay" would only exist at long range where Lance is already niche. **110 u/s** crosses the full 40-u range in ~0.36 s and 15 u in ~0.136 s, making mid-range dodging real while still reading as a railslug (~3× the fastest existing bullet). This is the **mandatory balance-probe starting value** (S2.4 / S8.3), tunable as a single number. **Aim-assist LEAD is disabled for the Lance** (assist may rotate-to-target but must not auto-lead the railslug) so the promised counterplay actually exists (S2.5).

**Hit handling** (`projectiles.ts:49-68`): rail deals full `damage` on first babo, knockback along travel, stopped by walls. Hoist `LANCE_KNOCK=10` from `weapons.ts:10` (NOT `:9` — adversary correction) to `constants.ts` so hitscan-revert and projectile paths use the identical impulse → determinism:
```ts
} else if (baboFirst && target) {
  sim.damage(target, pr.owner, pr.damage, pr.gun);
  const [nx, ny] = norm(pr.vx, pr.vy);
  if (pr.kind === 'bullet') sim.applyImpulse(target, nx*pr.damage*0.06, ny*pr.damage*0.06);
  else if (pr.kind === 'rail') sim.applyImpulse(target, nx*C.LANCE_KNOCK, ny*C.LANCE_KNOCK);
}
```

**Beam VFX — single source of truth (two HIGH adversary fixes — applied).** The draft's speculative full-range spawn beam (clipped by an independent `raycastWalls`) can disagree with where the slug actually stops (it hits a babo first, or the beam clips at a wall the slug never reaches), re-introducing the "looks instant/un-dodgeable" read. **Resolution:**
- **Do NOT emit a speculative full-range spawn beam.** Render the rail as a **moving stretched slug only** via an `effects.ts` `pr.kind==='rail'` branch (bright additive box, `scale.set(3.5,1,1)`, `GUNS.lance.color`).
- Emit the legacy `'rail'` beam event **only at the slug's real terminus** (on hit/expiry), from the captured muzzle origin to the actual impact point. This requires the 2 added `Projectile` fields `ox, oy` (spawn origin), committed (not "optional"). The terminal beam is then authoritative — it draws exactly where damage resolved.
- Optionally a brief muzzle **flash** sprite at spawn (no full-length line), purely cosmetic.

This keeps the `'rail'` GameEvent type and the `effects.ts:382-395` beam renderer reused (terminal-only), so no render regression and no visual/authority contradiction.

**Same-tick ordering (HIGH adversary fix — specified).** System order is `weaponSystem` then `projectileSystem` in the same tick (`sim.ts:180-181`). A rail spawned at fire time gets one `projectileSystem` step that tick, advancing `110/60 ≈ 1.83 u`. So point-blank (victim ≤1.83 u) is hit the same tick; a victim at 2–4 u is hit a tick or two later (unlike the old instant hitscan). This is the intended behavior. S8 adds a test asserting a point-blank victim (0.7 u) dies and on which tick.

**Firing path** (`weapons.ts:82-98`): flag branch inside the charge-complete block; `discharge()` runs in both paths so heat/recoil/lockout are byte-for-byte preserved:
```ts
if (p.charge >= 1) {
  sim.emit({ t: 'chargeReady', player: p.id });
  if (FLAGS.PROJECTILE_LANCE) fireProjectiles(sim, p, gun);  // rail slug
  else fireLance(sim, p, gun);                                // legacy hitscan
  p.charge = 0; discharged = true;
}
```
`fireProjectiles` kind map gains `gun.id === 'lance' ? 'rail'`, captures `ox,oy` at spawn.

### S2.4 Counterplay / TTK / lead
Damage stays flat 60, **no falloff** (2-shot TTK preserved; effective TTK rises only against players who successfully dodge — the point). Bot lead comes free: `bots.ts:269` `lead = gun.projectileSpeed>0 ? (td/gun.projectileSpeed)*0.6 : 0` auto-enables for the Lance at `110`. **This changes bot aim floats — re-baseline the golden snapshot** (S8). Note (adversary): bot lead toggling on is itself a flag-ON behavior change, covered by the flag-ON golden hash, never the flag-OFF one.

### S2.5 Interaction with aim-assist (S1)
S1's aim-assist may **rotate-to-target** for the Lance but **must NOT auto-lead it** (decisive, from the balance fix) so mid-range dodging exists. For the other 7 guns, aim-assist lead (if implemented) uses `GUNS[gun].projectileSpeed`; `projectileSpeed===0` short-circuits lead to 0 (same guard as bots) so the flag-off revert is correct. **S1 owns this contract explicitly** (not a soft assumption): the assist module reads `GUNS[gun].projectileSpeed` and special-cases `gun.id==='lance'` to skip lead.

### S2.6 Netcode
No new primitive — the rail rides the existing pipeline (`snapshot().projectiles` `sim.ts:440`; broadcast every 3 ticks `host.ts:203`; client interp by id `client.ts:294-298`). **Fast-slug interp (MEDIUM adversary fix — promoted).** At 110 u/s and 20 Hz the slug moves ~5.5 u between snapshots, lives ~0.36 s ≈ 7 snapshot frames, and clients render `INTERP_BUFFER_MS=100` behind, so a remote observer sees it in only a few interp samples. Because the draft's primary mask (the speculative spawn beam) was removed (S2.3), **render-side dead-reckoning is now part of the S2 deliverable, not deferred:** extrapolate the rail from its last snapshot using its known `vx,vy` (constant-velocity, no collision) up to ~50 ms, clamped to the terminal beam endpoint. Pure render-side; never feeds the sim. Lag-comp/rewind is explicitly out of scope (defender's dodge is authoritative).

### S2.7 Per-tick cost bound
`projectileSystem` is O(P·N) with zero per-tick alloc (in-place compaction `projectiles.ts:19-26`). Lance adds ≤1 in-flight rail per wielder (≤8 worst case) — negligible; peak P is dominated by hurricane/maw. Bound three ways:
1. **`MAX_PROJECTILES=256` cap.** **Drop the oldest BULLET only — NEVER a rocket/flame mid-flight** (MEDIUM adversary fix): silently deleting a thumper rocket or pyre flame before it detonates/ignites changes damage outcomes surprisingly. The cap is a grief/lag-spam guard; legitimate worst case (~100) is well under 256, so it is effectively unreachable in normal play. Drop rule is order-deterministic (scan from front for the oldest bullet); tested for per-seed stability.
2. **distSq broadphase reject before `segCircle`.** **Owned by S5, not S2** (cross-section fix) to avoid both sections editing the projectile hot loop.
3. **Tier hook (S3):** only the render mesh sync is tiered; the sim stays full-fidelity on all tiers → determinism identical across tiers. The new `pr.kind==='rail'` render branch is covered by S3's tier downgrade.

### S2.8 Determinism + tests
Determinism by construction: rail uses only `sim.rng` (Lance `spread:0` draws none), integer `newId()`, unchanged array order, same `segCircle`/`raycastWalls` math. **Flag-ON is a different RNG stream from flag-OFF** the moment Lance routes through `fireProjectiles` (its unconditional `sim.rng.spread(0)` at `weapons.ts:152` still advances Mulberry32 state — HIGH S8 adversary fix): so flag-ON gets its OWN golden-hash baseline; **no relationship is asserted between flag-ON and flag-OFF hashes.** Flag-OFF must equal the pre-change baseline (legacy `fireLance`, zero new draws).

Test impact (must rewrite — currently assert same-tick hitscan):
- Add a `tickCombat` helper running `weaponSystem` **then** `projectileSystem` (mirrors `sim.ts:180-181`) — `tickWeapons` (`weapons.test.ts:10-13`) has no projectile step (LOW adversary fix).
- Rewrite the three Lance tests (`weapons.test.ts:145-180`) against `tickCombat`: assert hp after the slug travels, knockback on hit (`LANCE_KNOCK=10`), wall-block via `projectileSystem` `raycastWalls`, terminal `'rail'` event endpoint.
- New tests: flag-OFF identical same-tick hitscan (revert lock); moving max-range target missed by a non-leading shot; `MAX_PROJECTILES` drops oldest **bullet** deterministically; flag-ON per-seed determinism; point-blank kill tick.

---

## S3 — Performance Tier System + Render Optimizations

### S3.0 Invariants
Every change is **render-only** — never touches `src/sim/**`, `src/net/**`, `core/loop.ts`, or `constants.ts` sim values → determinism structurally untouched. The babo marble shader (`baboShader.ts`) is **never downgraded**. No tier branch reads/writes sim state, RNG, or event order. `groundPoint`/`project` keep identical signatures/math.

### S3.1 Tier detection (`src/render/quality.ts`)
Synchronous singleton resolved at import (no await; doesn't delay boot). Signals: `matchMedia('(pointer:coarse)')`, `navigator.hardwareConcurrency ?? 4`, `navigator.maxTouchPoints ?? 0`, `Math.min(devicePixelRatio||1, 3)`. **Never `deviceMemory`.** Classification:
```
isMobile = coarse || maxTouchPoints>0
tier = !isMobile ? 'high' : cores>=6 ? 'mid' : 'low'
```
(iPhone 11/SE2 = 6 cores → mid; Pixel 6a = 8 → mid; <6 → low.) In jsdom (no `matchMedia`/WebGL) `detectQuality()` **defaults to `'high'`** so render-touching tests and determinism asserts see the unchanged path.

`QUALITY` profile fields: `tier, isMobile, maxPixelRatio(1/1.25/2), antialias(false mobile/true high), downgradeMaterials, mergeStatics, splatRtSize(1024/2048), particleScale(0.4/0.65/1), particleCap(200/350/600), fireSprites(3/5/7), smokeSprites(3/4/6), lobbyPreview(false low/true mid+high), baboBodyTransparent`. `setTierOverride(t)` mutates in place (live imports keep the reference). `App.setQuality(t)` on `window.__bv3` rebuilds the renderer if mid-match.

**Construction-time vs live (documented in `quality.ts`):** AA, DPR, splat RT size, merged geometry, lobby GL context are fixed at build → manual change rebuilds on next `enterMatch`. Particle caps, sprite counts, `surfaceMat` for new entities, babo transparency are read live → apply immediately. **`detectQuality()` runs at import with zero await** so `QUALITY` is available before the first renderer construction in `enterMatch` (S4 must not wrap `quality.ts` behind a delaying dynamic import — cross-section agreement).

### S3.2 Renderer construction (`renderer.ts:43-63`)
- L47 `antialias: QUALITY.antialias` (false mobile). L48 `setPixelRatio(Math.min(devicePixelRatio, QUALITY.maxPixelRatio))`.
- Keep `HemisphereLight` + key `DirectionalLight` all tiers; **drop the fill `DirectionalLight` (L61-63) on low/mid**. No shadow maps exist. High = current values → desktop unchanged.

### S3.3 Non-hero material downgrade (central factory)
`surfaceMat(params)` in `quality.ts`: `MeshStandardMaterial` (high) → `MeshLambertMaterial` (mid) → `MeshBasicMaterial` (low). **`basicize()`/`lambertize()` must explicitly (LOW adversary fix): keep `map/transparent/opacity/side/depthWrite`; DROP `metalness/roughness/emissiveIntensity` (unsupported on Basic/Lambert); for glow parts on Basic, fold `emissive` into `color` so energy guns stay bright; multiply base color ~0.85 so unlit surfaces aren't flat-black.** Route existing constructors: floor/pit/walls (`renderer.ts:78,100,116/117`), accessory/ghost (`baboShapes.ts:47,57`), gun metal/poly/glow (`gunModels.ts:29/34/39`), grenades/pickups (`effects.ts:151,236/243/254`). Leave Basic particles/rings/beams/tracers. High returns the exact original `MeshStandardMaterial` → desktop pixels unchanged. S8 unit test: `surfaceMat` per tier returns a material whose `.map === input.map` and emits no unsupported-property warnings.

### S3.4 Babo body transparency gating (`baboShader.ts:103-106`, `babos.ts`)
`transparent:true` is unconditional today; blending is only needed during Phantom phase fade. Construct with `transparent:false` (opaque marble; `gl_FragColor.a` ignored → non-phasing babo identical). **The body's `uOpacity` is written every frame unconditionally at `babos.ts:207` (harmless for opaque), while the gun opacity toggles inside the `if (p.phaseActive !== vis.phased)` guard at `:211-213` (adversary clarification).** Add the **body** `mat.transparent` flip **inside that `:211` guard** (true on phase-in, false on phase-out, `needsUpdate=true`) — one recompile per transition. Do NOT remove the `:207` per-frame `uOpacity` write. Applies all tiers (pure win, visually lossless). S8/visual check: name tag (`babos.ts:48-49`), bounty crown (`:127-134`, `renderOrder:999`), CTF flag still composite correctly over opaque vs transparent body.

### S3.5 Static geometry merging — per-feature policy (MEDIUM adversary fix: resolve the "all tiers" vs "off on high" contradiction)
**GRINDER has 18 walls** (4 outer + 4 spawn shields + 4 mid cover + 4 side pillars + 2 pit rim, `maps.ts:51-76` — LOW adversary correction; ~36 wall draw calls today). Per-feature:

| Sub-feature | Policy | Rationale |
|---|---|---|
| **5a Walls → 1 grouped geometry (2 draw calls)** | `mergeStatics`-gated (OFF on high) | Desktop byte-identical guarantee. Merge 18 boxes into one geometry keeping the 6-group layout, render with `[wallMat,wallMat,topMat,topMat,wallMat,wallMat]`. Static → safe. |
| **5b Babo shadows → 1 `InstancedMesh`** | **All tiers** | Genuinely lossless + cheap (8 shadows → 1 draw call). Write each live babo matrix into instance `i`; zero the matrix when `!alive`. `MAX_PLAYERS=8` (confirmed `net/types.ts:39`). **S3.11 updated: desktop draw-call count changes by shadows→1 (still pixel-identical).** |
| **5c Gun parts merged per `GunId`** | `mergeStatics`-gated (OFF on high) | Avoids the disposal-ownership hazard on the hero/desktop path. |
| **5d `ClassVisual` geo/mat cached per `ClassId`** | `mergeStatics`-gated (OFF on high) | Same. |

**Shared-resource disposal (HIGH adversary fix — applied).** `buildGunModel` (`gunModels.ts:300-306`) and `buildClassVisual` (`baboShapes.ts:274`) allocate fresh materials per call; `disposeGunModel` (`gunModels.ts:493-504`, called per scavenge swap `babos.ts:189`) and `disposeClassVisual` (`baboShapes.ts:316-321`, per despawn) dispose everything they traverse. Caching shared templates would double-free on the 2nd babo. **Resolution:** when caching is on (low/mid only), `disposeGunModel`/`disposeClassVisual` must **skip cache-owned resources** (guard via a `WeakSet` of cached geos/mats); the cache disposes only at `BaboPool.dispose()`/app teardown. **Required S8 test:** spawn → swap-gun → despawn → respawn-same-class proves no double-dispose (GL use-after-dispose). Gating 5c/5d to low/mid keeps desktop on the proven per-instance path.

Merged statics break per-mesh frustum culling — irrelevant (64×64 arena almost always fully in view). Add merged geos to `GameRenderer.dispose` (`:247-254`) + pool dispose. If a future map uses per-wall materials, the merge keys by material set and falls back to per-wall meshes.

### S3.6 Splat RT shrink (composite deferred to S7)
RT is `2048²` (`splatmap.ts:24`, ~16 MB) drawn as a separate full-arena transparent plane (`renderer.ts:84-93`, already `MeshBasic`). **Net S3.6 change = RT shrink to `QUALITY.splatRtSize` (1024 mobile / 2048 high).** The "composite into floor to drop the plane" idea is **deferred to S7** — a correct single-pass composite needs a custom floor shader for <1 draw-call saving and real regression risk. The ortho stamp cam is resolution-independent. Determinism: `nextRand()` (`splatmap.ts:43-48`) is the splatmap's own PRNG, not sim RNG; RT size changes pixels, not stamp count/order.

### S3.7 Particle / fire / smoke tiering (live-read)
- Particle hard cap (`effects.ts:467`) `600` → `QUALITY.particleCap` (`getPooledSprite` returns null past cap; all callers null-guard → self-throttling).
- Burst counts: `n = Math.max(1, Math.round(count * QUALITY.particleScale))` inside `burst()` (gameplay-readable `hit`/`hitWall` keep ≥1).
- Fire loop `i<7` (`effects.ts:181`) **and the update guard `i<7` at `:195`** → `i < QUALITY.fireSprites`. Smoke `i<6` (`:208`) → `QUALITY.smokeSprites`.
- `Math.random()` here is render-side → determinism untouched. High = current literals → identical.

### S3.8 Lobby preview (`lobbyPreview.ts`, `app.ts:121-141`)
2nd WebGL context today. **Skip on low** (static `makeGunIcon` canvas fallback) — **wrap the ENTIRE mount path (MEDIUM adversary fix):** `mountLobbyPreview` calls `this.lobbyPreview.start()/setLoadout()/resize()` (`app.ts:136/139/140`) WITHOUT optional chaining, so guarding only the constructor crashes. Add at the top of `mountLobbyPreview`: `if (!QUALITY.lobbyPreview) { renderStaticGunIcon(); return; }`, and make `disposeLobbyPreview()` + external callers tolerate a permanently-null preview. **Throttle on mid:** `antialias:false`, DPR clamp, cap render to 30 fps (track accum, still rAF-schedule); keep the `document.hidden` pause. High unchanged.

### S3.11 Regression guard (corrected)
Desktop (`tier==='high'`) is **pixel-identical** to today, with the **single intentional exception that babo shadows render via one `InstancedMesh` (5b)** — same pixels, draw-call count reduced. Everything else (AA, DPR, PBR, fill light, no wall/gun/class merging, 2048 splat, full particles, 60 fps lobby) is byte-identical. The S3 system is otherwise a no-op on desktop unless manually overridden.

---

## S4 — Bundle / Startup Deferral

### S4.0 Current reality
One ~2.25 MB chunk (~769 KB gz), no `manualChunks`. (1) Rapier `-compat` base64-inlines 1.07 MB WASM and `main.ts:5-9` awaits `initPhysics()` before the menu paints. (2) `app.ts:1-17` statically imports the whole game. (3) `screens.ts:4` pulls `makeGunIcon` (pure Canvas2D) from `gunModels.ts` whose line 1 is `import * as THREE`. `LobbyPreview` IS a live Three scene (off the menu, not the lobby). `import * as THREE` count = exactly 9 files.

### S4.1 Lazy Rapier via non-compat WASM
Swap `@dimforge/rapier2d-compat` → `@dimforge/rapier2d` (same 0.14.x pin). `sim.ts:1` becomes type-only import + a lazily-bound `let RAPIER`. **`initPhysics()` must handle BOTH init contracts defensively (CRITICAL adversary fix — the non-compat init contract is unverified against an installed package):**
```ts
export function initPhysics(): Promise<void> {
  if (rapierReady) return Promise.resolve();
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const mod = await import('@dimforge/rapier2d');
    if (typeof (mod as any).init === 'function') await (mod as any).init(); // compat-style if present
    RAPIER = mod as typeof RAPIER_NS;                                       // else auto-instantiated
    rapierReady = true;
  })().catch(e => { initPromise = null; throw e; });                        // reset for retry
  return initPromise;
}
```
**Acceptance gate (mandatory before committing):** actually run `npm i @dimforge/rapier2d@0.14.0 && npm rm @dimforge/rapier2d-compat`, read its `package.json` `module`/`exports` + entry to confirm the init contract, then run the full vitest suite and **assert byte-identical determinism (seed 42) before/after the swap** — assert, do not assume, that compat→non-compat at the same version is bit-identical.

`vite.config.ts`: `assetsInlineLimit: 0` (never re-inline the WASM). Vite's `new URL('...wasm', import.meta.url)` + `base:'./'` (verified `:6`) emits a hashed `.wasm` with a GitHub-Pages-relative fetch; the loader's `instantiateStreaming` + `instantiate` fallback covers MIME edge cases.

### S4.2 Remove eager init; init on host/local match entry
`main.ts` drops the eager await → menu paints with zero WASM. Gate `initPhysics()` only at the host/local launch sites before `new GameSim`; the **client never builds a sim** (`launchClientMatch` sets `this.sim=null`) → clients never download Rapier.

**Ordering + floating-promise safety (MEDIUM adversary fix — applied).** `enterMatch` (`app.ts:374`) is shared by `launchLocal/Host/Client` AND respawn/rematch, wired as fire-and-forget callbacks. Making these async without care produces unhandled rejections and a black screen (because `enterMatch` calls `ui.hide()` at `:375` before awaiting imports). **Resolution:** `await initPhysics()` + the dynamic render/sim imports FIRST **while the lobby is still visible**; only call `ui.hide()/disposeLobbyPreview()/loop.start()` after they resolve. Wrap each `onStart` callback body in `.catch` that restores the lobby and shows a "Failed to load — check connection" toast. A rejected `initPhysics` resets `initPromise` for retry.

**Prefetch (MEDIUM adversary fix — extended).** On lobby-open, fire-and-forget warm **Rapier AND the render chunks** so first cold local match isn't a frozen black screen: `import('@dimforge/rapier2d'); import('./render/renderer'); import('./render/hud'); import('./render/screenfx');`. Wrap the awaited imports in `enterMatch` with the existing lobby→match transition spinner. S8 validates first-cold-local-match TTFF on Fast-3G + 4× CPU.

### S4.3 Code-split via dynamic `import()` + `manualChunks`
Dynamic-import boundaries in `app.ts`: render (Three) on `enterMatch`; `LobbyPreview` on lobby-mount; net (PeerJS) on Host/Join; `GameSim` (+ Rapier) in `launchLocal/Host`. Leave `import type` shims for field/param types (typecheck is the gate). `vite.config.ts` `manualChunks: { three:['three'], peerjs:['peerjs'], rapier:['@dimforge/rapier2d'] }`. Result: entry = menu + lobby UI shell (no Three/Rapier/PeerJS); `three.*` on lobby/match; `peerjs.*` on Host/Join only; `rapier.*` + `*.wasm` on host/local match only.

### S4.4 Extract `makeGunIcon` out of Three
New `src/render/gunIcons.ts` holding `makeGunIcon` + Canvas2D helpers (`gunModels.ts:476-486,314-323,359-475`). Repoint `screens.ts:4`. Only consumer is `screens.ts` (grep-confirmed). Entry chunk then imports zero Three.

### S4.5 `import * as THREE` → named imports (9 files)
Mechanical, `tsc`-checked, render-only → zero sim impact. Enables tree-shaking of the `three` chunk.

### S4.6 Determinism & test infra
Same Rapier version → identical solver; assert empirically (S4.1 gate). **Vitest has no separate config (runs off `vite.config.ts`); the non-compat WASM top-level-await package frequently trips Vitest's dep optimizer (HIGH adversary fix — make the fix mandatory, not conditional):** add to `vite.config.ts`:
```ts
test: { deps: { optimizer: { ssr: { exclude: ['@dimforge/rapier2d'] } }, inline: ['@dimforge/rapier2d'] } }
```
If Vitest still chokes on the WASM URL, split a dedicated `vitest.config.ts` resolving the Node/WASM-from-disk entry, keeping the production build config separate. **Acceptance gated on `npm test` green AND determinism unchanged.**

### S4.7 `index.html` preconnect
Add `<link rel="preconnect" href="https://0.peerjs.com" crossorigin>` + `<link rel="dns-prefetch" href="https://0.peerjs.com">` (default broker, verified `new Peer(...)` with no config). **Drop the STUN `preconnect` (LOW adversary fix)** — `stun.l.google.com:19302` speaks UDP, not TLS, so a TLS preconnect to that port just times out; keep at most `<link rel="dns-prefetch" href="//stun.l.google.com">`. No `modulepreload` for three/rapier (would defeat deferral).

### S4.8 Worker reconciliation (cross-section)
If a future Worker sim (S5.6, currently CUT) ever lands, Rapier WASM must instantiate **inside the Worker**, and the S4.2 main-thread `initPhysics`/prefetch become partially moot. Worker URL resolution under `base:'./'` on GitHub Pages differs from main-thread `import.meta.url` — flagged for reconciliation if/when undertaken. Not a Phase-1/2 concern.

---

## S5 — Sim / Netcode Performance

### S5.0 Determinism contract
The suite asserts positions `<1e-9`, `hp`/`kills` exact-integer, two same-build same-seed runs compared (`integration.test.ts:104-122`); perf gate `avg step < 8 ms` (`:124-138`). Step order (`sim.ts:172-203`) is **frozen**. Every change is labeled **D-SAFE** (identical float ops, same order, bit-identical) or **D-SHIFT** (gated + re-baselined). Add a golden-hash regression guard before touching anything (S8.1).

### S5.1 Allocation / scalar cleanups
- **(a) `normInto()` zero-alloc sibling** (`math.ts`): module-scope scratch, single-threaded sim, callers consume immediately. **D-SAFE.** Keep `norm()` for any stored-tuple callers (none today). Used at the hot sites in `sim.damage/kill/explode` and `blood.ts`.
- **(b) `segAABB` unroll** (`math.ts:84-110`): remove the nested-literal `[[…],[…]]` + double `for…of`; straight-line scalar slabs **keeping `Math.max`/`Math.min`** (not the `if` form) to stay provably bit-identical (avoids any `NaN`/`-0` divergence). The single biggest sim GC win (hottest function). **D-SAFE.**
- **(c) `groundPoint` Vector3 reuse** (`renderer.ts:223-229`): add `private groundHit`, reuse. Per-tick (not per-frame). **D-SAFE** (local input only).
- **(d) `dist`→`distSq` threshold swaps — D-SHIFT, narrowly scoped (MEDIUM S5-adversary fix).** `Math.hypot(a,b) !== Math.sqrt(a²+b²)` at the last ULP, and the comparison RHS must be squared. **Apply ONLY to leaf threshold tests whose boolean has no geometric feedback:** `blood.ts:81` (in-fire), `blood.ts:103` (fire-ignites-pool boolean), `sim.ts:345` (explosion-cull), `sim.ts:427` (`playersInRadius`). **KEEP `dist()` at:** `findSpawnPoint` (`sim.ts:330`, feeds `rng` score), `sim.ts:366` **pool-merge** (its result feeds `pool.r` growth → inSlick → movement damping → trajectories → who dies — NOT threshold-only), and all magnitude/falloff math. `blood.ts:42` (inSlick, feeds damping) is borderline → treat as D-SHIFT and diff a chaos replay before/after, not just self-consistency. Bundle **all** D-SHIFT swaps + CCD behind one `C.SIM_BASELINE_V` flag and one golden re-baseline so the old trajectory stays reproducible for replay/debug.

### S5.2 Physics
- **(a) Drop player CCD** (`sim.ts:139`) behind `C.PLAYER_CCD=false`. Babo per-tick displacement ≪ radius at 60 Hz, so tunneling isn't a normal risk; largest single sim CPU win on mobile. **D-SHIFT** → re-baseline (bundled with S5.1d). **High-impulse fallback (LOW adversary fix — corrected).** The dangerous case is a death-pop/explosion impulse applied THIS tick (`sim.ts:290` `kill`, `sim.ts:349` `explode`) before `world.step()`; a speed gate read from the post-step mirror loop lags by one tick. **If shipping the fallback, enable CCD at impulse-application time** inside `applyImpulse()` (`sim.ts:235`) when `|impulse|/mass` implies near-radius displacement — not in the post-step mirror. **Validation:** the arena-bounds assert (`integration.test.ts:24-25`) only catches escaping the outer box, NOT tunneling an **interior** wall — add a dedicated stress test firing a thumper point-blank into a babo pinned against a thin interior wall, asserting it doesn't end up on the far side, before declaring CCD removal safe.
- **(b) Keep `world.step()` UNCONDITIONAL.** Conditional-skip is a D-SHIFT landmine (changes sleep/wake accumulator + damping integration) for negligible gain (rapier's all-asleep step is near-free). `SIM_HZ` stays 60 (`constants.ts:7`) — lowering it is a global D-SHIFT breaking client prediction `DT=1/60` (`client.ts:18`). Out of scope.

### S5.3 Background interval host-only (`loop.ts:55-59`)
Add `keepAliveWhenHidden` constructor flag (default false); install the 50 ms `setInterval` only for it. At `app.ts:384` pass `this.role === 'host'`. **D-SAFE.** Local/client never needed background sim (client interpolates; local pauses harmlessly, `maxGap` clamp prevents catch-up spiral). Document: local/client now **intentionally pause-and-resync on hidden, dropping hidden-elapsed sim time** (a behavior change for local, fine, not a no-op — LOW adversary clarification). Pairs with S5.7b/S6.3 audio suspend.

### S5.4 `client.view` memoization (`client.ts:256-323`)
**Memoize on the exact interpolation timestamp, NOT a beginFrame token (HIGH adversary fix).** `client.view` is read in `frame()` AND `dispatchEvents()` (same frame) AND inside `tick()` at `app.ts:422`; `tick()` runs in a `while(acc>=dt)` catch-up loop before the single `frame()` (`loop.ts:38-42`) and on the hidden-tab interval path with no `frame()` at all. A `viewDirty`-cleared-on-beginFrame scheme would never reset on those paths and could serve a view computed at the wrong `performance.now()`. **Resolution:**
- Cache keyed on the rounded interp target (`performance.now() - INTERP_BUFFER_MS`); recompute only when that advances AND a `'snap'`/`'events'`/`'end'` mutation set `viewDirty`. The within-frame double-call (frame + dispatchEvents) becomes a cache hit; the tick/frame split and interval path stay correct.
- **Add `client.predictedSelf(): {x,y}`** — a cheap accessor returning the predictor's own-babo position (`client.ts:283-290`) — and route `app.ts:422`'s input-sampling through it so the per-tick path **never triggers a full interpolated view rebuild** (the actual per-tick win; the tick path only needs the own position).
- Reuse per-id Maps + array containers across frames (`.clear()` + repopulate). Entity-object pooling deferred. **D-SAFE** (client-only, non-authoritative).

### S5.5 Binary snapshots — Phase-3-OPTIONAL, profile-gated
**Not committed for the 60 fps floor (YAGNI).** Only undertaken if a real device profile shows host snapshot CPU/uplink as the bottleneck under projectile spam. If undertaken:
- New `src/net/snapshotCodec.ts` (`encodeSnapshot/decodeSnapshot`): header + packed `Float32` kinematics, `u8` enum tables, bit-packed booleans; per-tick names stripped.
- **Name table (MEDIUM adversary fix):** bots are host-side and never in the lobby roster, so send the **full id→name table (humans + bots)** in `'start'` (and on roster change), or a per-player name-dirty bit in the first snapshot after a player appears, with a fallback name on miss.
- **Transport (LOW adversary fix):** the only serialization change is **`client.ts:72` `json`→`binary`** — the host accepts inbound connections (`host.ts:80`) and inherits the client's serialization; there is no host-side `connect()` to change. Negotiate encoding in the always-JSON lobby `'join'` handshake (carry a `wireVersion`); only upgrade after both sides confirm, and extend the handshake-reject path (`host.ts:97-101`) to compare `wireVersion`.
- **D-SAFE for the host sim** (encode/decode after `snapshot()`, never feeds `step()`; host runs Float64, clients see Float32 only in render/prediction, ~1e-6 < predictor smoothing). Behind `C.NET_BINARY_SNAPSHOTS`.

### S5.6 Web Worker sim offload — CUT (YAGNI)
**Do not build.** `step()` < 8 ms for 8 bots; the mobile bottleneck is render/GPU, not the sim. A Worker adds per-tick structured-clone cost, needs its own 1.07 MB Rapier WASM (fighting S4), and complicates the authoritative loop — net neutral-to-negative. Most phones JOIN (run no sim), not host. **Documented seam only:** `App.tick()` is the single advance point; `host.applyInputs`/`afterStep` bracket it; a future port would reuse the S5.5 codec as a transferable `ArrayBuffer`. Revisit only if a device profile proves main-thread sim time (not render) > 10 ms in chaos.

### S5.7 WebAudio voice budgeting + iOS unlock/suspend (`audio.ts`)
- **(a) iOS unlock:** `window.AudioContext ?? webkitAudioContext`; play a silent 1-sample buffer **inside the gesture** (created after the lazy `if (!this.ctx)` init block, `audio.ts:22-36`); change `state==='suspended'` → `state !== 'running'` so an `interrupted` context resumes. Broaden the one-shot unlock set to `pointerdown`+`touchend`+`keydown`; **add an `unlocked` boolean and remove ALL unlock listeners on first success (LOW adversary fix)** so a single tap firing both pointerdown+touchend doesn't run the silent-buffer kick twice (`resume()` is idempotent via the ctx guard, but de-register cleanly).
- **(b) Suspend on hidden / resume on visible** via `visibilitychange` (S6.3 owns the wiring). Backgrounded host: sim keeps running (S5.3), audio suspends. ~1-frame audio gap on tab-return is accepted (async `resume()`), not "zero transient."
- **(c) Voice budgeting** (real "pooling" — nodes are one-shot by spec): global `activeVoices` ceiling `C.AUDIO_MAX_VOICES≈24` (inc on create, dec on `onended`), per-gun min inter-shot interval (drop a `shot` voice if same gun fired <25 ms ago for a non-local player). Keep the shared `noiseBuf`. **D-SAFE.**

### S5.8 Flags
`C.PLAYER_CCD`(false), `C.SIM_BASELINE_V` (bundles D-SHIFT swaps), `C.NET_BINARY_SNAPSHOTS`(Phase-3-opt), `C.AUDIO_MAX_VOICES`, `wireVersion`. The distSq broadphase reject before `segCircle` in the projectile loop (S2.7 item 2) is **owned by S5** to avoid double-editing the hot loop.

---

## S6 — Mobile Shell / Viewport / Immersion

Pure shell (HTML/CSS, canvas sizing, AudioContext lifecycle, DOM layout) — **no `src/sim/**` edit**, so determinism is unaffected by construction; `groundPoint`/`project` changes are bit-identical on a stable desktop viewport. Every change is additive CSS gated `@media (max-width:760px)`/coarse-pointer, or a strict sizing superset returning identical desktop values.

### S6.1 Viewport meta + gesture suppression (`index.html:6`, `styles.css`)
Add `viewport-fit=cover` (prerequisite for nonzero `env(safe-area-inset-*)`) + `mobile-web-app-capable`, `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style=black-translucent`, `theme-color`, `<link rel="manifest">`. Keep `user-scalable=no`; no `maximum-scale`.

CSS (**ADDITIVE — append properties to the existing `html,body` block; preserve `#game-canvas{position:absolute;inset:0;display:block}` at `:30` — LOW adversary fix**): add `overscroll-behavior:none`, `-webkit-text-size-adjust:100%` to `html,body`; add a play-surface block:
```css
#game-canvas, #hud-canvas, #fx-canvas, #touch-layer {
  touch-action: none; -webkit-user-select: none; user-select: none;
  -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent;
}
```
**`.screen`/lobby scroll containers MUST keep `touch-action:auto` (or `pan-y`) (MEDIUM adversary fix)** so the S6.5 `overflow-y:auto` momentum-scroll works — `touch-action:none` is scoped to play surfaces ONLY. S1 buttons use `touch-action: manipulation`. `touch-action:none` is a desktop no-op.

### S6.2 Dynamic-viewport sizing — single `visualViewport` bus (`src/core/viewport.ts`)
`viewportSize()` prefers `visualViewport` (iOS URL-bar aware) over `innerWidth/Height`, falling back when absent. `onViewportChange(cb)` rAF-coalesces `visualViewport` `resize`+`scroll` + window `resize`+`orientationchange` into one fire so the three canvases never desync during URL-bar transitions.

Route all three surfaces through it:
- **`renderer.ts`:** `applyViewport()` sets cached `vw/vh`, aspect, `setSize(w,h,false)`, `setPixelRatio(min(devicePixelRatio, maxDpr))`, CSS size. **`groundPoint` (`:224`) and `project` (`:235-236`) read cached `vw/vh` instead of `window.innerWidth/Height`** — the load-bearing aim-correctness fix (unprojection denominator must match `setSize`). `maxDpr` field default 2, owned by S3. Subscribe in ctor, unsubscribe in `dispose()`.
- **`hud.ts`/`screenfx.ts`:** DPR-aware resize via the bus; cache `cssW/cssH`; `ctx.setTransform(dpr,…)` so existing CSS-px draw code is preserved. **Audit EVERY `this.canvas.width`/`height` read, not just the cited lines (HIGH adversary fix):** repoint all to `cssW/cssH` — including **`screenfx.ts:48-50` `addSplatter()`** (an independent read NOT at `:67-68`; missing it scatters splatters across DPR-pixel range off-screen). Grep `this.canvas.width|height` across `hud.ts`+`screenfx.ts` and convert each.

Determinism: none of these feed the sim; desktop values are identical (`vw===innerWidth` on a stable viewport).

### S6.3 iOS audio unlock + suspend-on-hidden
S6 wires `app.ts` `onVisibility` → `audio.suspend()` (hidden) / `audio.resumeIfUnlocked()` + `reacquireWakeLock()` (visible). The unlock/`webkitAudioContext`/silent-buffer mechanics live in S5.7. **Suspend ONLY the AudioContext, never `FixedLoop`** — the loop's hidden-tab tick is load-bearing for the multiplayer host (S5.3). Render already pauses (rAF stops backgrounded). Benign on desktop.

### S6.4 Screen Wake Lock
`navigator.wakeLock.request('screen')` feature-detected + try/catch (iOS<16.4 degrades silently). **Acquire at the START gesture (MEDIUM adversary fix).** The lock auto-releases when hidden, so re-acquire on `visibilitychange`-visible (gated on `this.loop` so only during a match). The shared `enterMatch` is reached via tap for START and PLAY AGAIN, but the async chain (`teardownMatch`→`launch*`→`enterMatch`→`acquireWakeLock` after `loop.start()`) can land outside the gesture window on rematch. **Resolution:** acquire synchronously at the top of the click handler where possible; otherwise accept best-effort and rely on the `visibilitychange` re-acquire — document that the screen may briefly dim on rematch until the next foreground event. Release in `teardownMatch`. Confirm on a real device that `enterMatch`-time acquisition still counts as gesture-adjacent.

### S6.5 Portrait-first responsive menu/lobby/end (`styles.css`, `screens.ts`)
First `@media` blocks in the project, all inside `@media (max-width:760px)` (desktop cascade byte-identical). Collapse the fixed 3-col `.lobby` grid (`:111`) to `1fr`; `.screen` becomes the scroll container (`overflow-y:auto`, `-webkit-overflow-scrolling:touch`, **`touch-action` left default**); `clamp()` title; ≥44 px tap targets (`.class-card`, `.gun-chip`, `.btn`, `.btn.small`); `:active` feedback; **16 px form fonts (stops iOS focus-zoom)**; `env(safe-area-inset-*)` padding (nonzero via S6.1). Surface the hover-only `title=""` tooltips (class role `screens.ts:170`, gun identity `:196`) as inline esc'd DOM text, hidden on desktop via `@media (min-width:761px)`. Append a mobile control line to the how-to (`screens.ts:139`; wording owned by S1).

### S6.6 PWA standalone — NOT fullscreen
Layout works WITHOUT fullscreen by design (S6.2 + S6.1). `public/manifest.webmanifest`: `display:standalone`, `orientation:'portrait'` (**a hint only — no `screen.orientation.lock()`**, honoring locked portrait), relative `start_url:'./'`/`scope:'./'` (works under `base:'./'`). **Icon honesty (HIGH adversary fix):** a single SVG icon does NOT satisfy Android's installability (needs 192/512 PNGs), and iOS standalone ignores the manifest entirely (relies on the apple-* metas). **Resolution (pick, stated):** either (a) **build-time rasterize** 192/512 PNGs from `favicon.svg` (a build step, not a committed binary — preserves the zero-binary-assets repo rule), enabling real Android install; or (b) keep SVG-only and explicitly down-scope: the manifest provides standalone/theme polish, install may not prompt without raster icons, and the iOS chromeless path comes from the apple-* metas, not the manifest. **Decision: (a)** — build-time PNG rasterization from the existing SVG, so Android install + standalone both work without committing binaries.

Fullscreen is **Android-only progressive enhancement** in `enterMatch`, gated on `el.requestFullscreen && matchMedia('(pointer:coarse)')`, `.catch`-swallowed; iOS Safari silently skips (no `requestFullscreen`) and falls back to the visualViewport/safe-area layout.

### S6.7 Cursor on touch
`document.body.style.cursor='none'` (`app.ts:379`) is harmless on touch. The crosshair-anchor source switches to the S1 aim-stick projection in touch mode (S1.8); S6 only guarantees `mouseX/mouseY` defaults don't produce an off-screen crosshair under the new sizing.

### S6.8 Edge handling
`visualViewport` absent → `innerWidth/Height` fallback. Wake Lock denied → screen may dim (re-acquire on foreground). AudioContext `interrupted` → resume on non-running. Fullscreen rejected → layout works without it. URL-bar event spam → rAF-coalesced. **Cross-section:** S3 must subscribe to the shared `onViewportChange` bus (never add its own `visualViewport` listener) for tier re-evaluation.

---

## Roadmap (3 phases, dependencies, exit criteria)

**Cross-cutting prerequisite:** a single mutable `RUNTIME` config (new `src/data/runtime.ts`: `tier/touch/projectileLance`) read by render/input/net/shell, **never imported by `src/sim/**`** except S2's one gated branch and the S2/S5 flags in `constants.ts`. (Note: sim-scoped flags `FLAGS.PROJECTILE_LANCE`, `C.PLAYER_CCD`, `C.SIM_BASELINE_V` live in `constants.ts`; UI/render-scoped `tier/touch` live in `runtime.ts`.) Forcing `{touch:false, tier:'high', projectileLance:false}` reproduces today's desktop build. **The game is shippable at every phase boundary.**

| Phase | Theme | Items (sections) | Depends on | Measurable exit criteria |
|---|---|---|---|---|
| **P1 — "It loads"** | Bundle deferral + perf quick-wins + mobile shell | S4 (Rapier swap+gate+verify determinism, code-split, gunIcons extract, named THREE, vitest dep config); S6 (viewport bus, safe-area, audio unlock/suspend, wake-lock plumbing); S3 (tier **detection** + DPR/AA clamp only); S5 (host-only interval, `segAABB`/`normInto`/`groundPoint` D-SAFE allocs, **D-SHIFT distSq/CCD bundle behind `SIM_BASELINE_V` + one golden re-baseline**, audio budgeting) | `RUNTIME` + golden-hash guard (S8.1) | Menu paints before WASM (FCP not blocked on Rapier chunk); entry gz ≥40% smaller. Pixel 6a/iPhone 11: menu interactive <3 s cold; 6-bot local match runs steady, no crash. iOS audio plays after first tap; silent when hidden. **First cold local match TTFF acceptable on Fast-3G+4×CPU** (prefetch warms three+rapier). `npm test` green incl. determinism canary + new golden hashes + **post-Rapier-swap byte-identical determinism (seed 42)**; `npm run build` green. Desktop byte-identical (tier `high`). |
| **P2 — "It plays"** | Touch + responsive UI + tier switch + HUD reloc + flagged projectile-Lance | S1 (touch sticks, aim-assist [capped strength], laser/reticle [wall-clamped], grenade arc, SKILL/RELOAD[+sim bit]/EQUIP/PICKUP, scoreboard/leave, portrait cam zoom+lead scale); S6 (portrait `@media`, inline tooltips, HUD safe-area reloc, PNG-rasterized PWA icons); S3 (tier **switch**: AA/material/particle/lobby downgrades; shadow InstancedMesh all-tiers; merge/cache low-mid with WeakSet disposal); S2 (Lance→rail behind `PROJECTILE_LANCE`, flag-OFF default, terminal-only beam, render dead-reckon, `MAX_PROJECTILES` drop-oldest-bullet) | P1 (`RUNTIME`, viewport shell, tier detection) | Coarse-pointer device: full match touch-only (move, aim+autofire, grenade arc, skill, manual reload, scoreboard, leave) — none need key/mouse. Portrait: controls bottom ~40%, HUD safe-area corners, no notch overlap, babo stays top-band. Mid-range phone holds playable 60 in 1v1–2v2. Flag-ON per-seed determinism green; flag-OFF == P1 golden hash. Spawn→swap-gun→despawn→respawn-same-class: no double-dispose. Lobby-skip-on-low doesn't crash. Desktop unchanged with `{touch:false, projectileLance:false}`. `npm test`+build green. **(`projectileLance` default-on is an out-of-band balance decision, NOT a phase gate — see below.)** |
| **P3 — "It holds 60 under chaos"** | Structural perf, tier-gated, YAGNI-pruned, **profile-driven** | S3 (babo subtree merge/instancing per profile; splat composite [deferred from S3.6]; pooled audio/VFX geometry; screenfx gradient cache); S5 (**binary snapshots [profile-gated]**, `client.view` timestamp memo + `predictedSelf`); **Worker offload = CUT** | P2 tier switch + **P2 device profile (YAGNI gate)** | Pixel 6a/iPhone 11/SE2: stable 60 normal fights, graceful dip (no hard stall) in 8-bot chaos with fire/explosions/splat. Low/mid draw calls ≪ ~200–350 baseline (instancing <100 in a typical fight). Host CPU/tick within `avg<8ms` (binary snapshots must not regress). Desktop (`high`) visually/behaviorally identical to P2 (verified by visual diff). Determinism unchanged. `npm test`+build green. **Each P3 item ships only if the P2 profile flags it red.** |

**Balance-probe decoupling (LOW S7-adversary fix):** Phase-2 is shippable with `projectileLance` **default-OFF**. Flipping default-ON is an **out-of-band balance decision NOT gated on the phase** (avoids stalling P2 on tuning). Provisional starting band for the S8 probe: min Lance time-to-first-hit at max range ≥120 ms; Lance share of kills within ±X% of the hitscan baseline over N seeded 8-bot matches; calibrate against real matches before flipping.

---

## Testing & Validation Strategy (S8)

Layers: **L0** determinism guards → **L1** headless unit/system → **L2** headless perf + scene-stats → **L3** balance re-probe → **L4** synthetic-touch DOM → **L5** real-device Chrome. L0–L4 in CI; L5 manual per-phase. Existing harness: 11 vitest files (~94 cases), `node` env, Mulberry32 seeded; sim never calls `Math.random` (only render-side camera shake `renderer.ts:202-203`).

### S8.1 Determinism
- **`simHash(sim)` golden digest** in `tests/helpers.ts`: order-stable Float64→hex FNV over players (x,y,vx,vy,aim,hp,kills,deaths,heat,mag) + projectiles (id,x,y,vx,vy) + teamScores, **extended to grenades, pools, fires, and CTF `mode.flags` carrier/state** (LOW adversary fix — the digest must cover VFX/mode state, or scope it explicitly and add a second broader digest). Used (a) cross-instance (primary, baseline-free) and (b) `toMatchSnapshot` at ticks 300/600/1200.
- **`tests/purity.test.ts`:** fs-static assert `src/sim/**` imports nothing from render/audio/net/input/`three`/`peerjs` (allowlist `@dimforge/rapier2d`, `./core`, `./data`). Protects the deterministic core from render-work leaks.
- Per-change guards: **S2 flag-ON gets its OWN golden hash (NOT compared to flag-OFF — the RNG stream differs from tick one via `weapons.ts:152` `sim.rng.spread(0)`); flag-OFF == pre-change baseline.** S5 D-SHIFT bundle (distSq/CCD) behind `SIM_BASELINE_V` with one re-baseline; CCD high-impulse interior-wall stress test. S4 post-swap byte-identical determinism (seed 42). Manual-reload one-rising-edge test (2 ticks/frame → exactly one `reloadStart`). Touch blur-reset test (post-blur `sample()` neutral).

### S8.2 Headless perf + scene-stats
- **Step-cost:** keep `<8 ms` hard gate; add warm median over N=3000 (`<4 ms` generous; track `console.log` baseline ~0.05 ms). Add a heavy-projectile (flag-ON, hurricane×8) step-cost test asserting bounded projectile array + median under budget.
- **Scene-stats (HIGH adversary fix — re-scoped).** jsdom has NO canvas; the render layer's `getContext('2d')!` (`textures.ts:8`, `babos.ts:34-37`, `gunModels.ts:477-480`, `hud.ts:36`, `screenfx.ts:25`) and `WebGLRenderer` throw before `renderer.info` is readable. **Primary plan = scene-graph instrumentation unit tests** (count `scene.add` of Mesh/Material/Geometry; assert instancing on the `BaboPool`/builder in isolation — pure data, no GL, no 2D canvas) behind an injectable texture factory so `getContext` is stubbable. The `WebGLRenderer.info` + null-GL-stub path is kept ONLY as an optional fallback that requires adding native `canvas` to devDeps; the S3 acceptance gate is the instrumentation tests + L5 device fps, NOT a CI draw-call number that can't be produced headlessly.
- **Alloc probes:** `--expose-gc`, sample `heapUsed` around hot paths post-`gc()`, assert ~0 retained delta after the `groundPoint`/`segAABB` hoists.

### S8.3 Balance re-probe (`tests/balance.test.ts`, `BALANCE=1`-gated)
16 seeds × 8-bot FFA/TDM, **forced gun via `addPlayer(name,classId,team,bot,gun)`** (LOW adversary fix — the param exists `sim.ts:116`; `chosenGun` persists across respawn `sim.ts:307`; only suppress mid-life gun-pickup scavenge). Metrics: kill-share + TTK from drained `sim.events`. Assert flag-OFF == golden hash; flag-ON each gun within a loose band (no gun >2× mean share, none below floor) + the provisional Lance band (S7). **Document the bot-lead confound (MEDIUM adversary fix):** flag-ON flips bot lead on (`bots.ts:269`), so the measured delta mixes projectile physics + bot-AI change — report it as intended (bots SHOULD lead a real projectile), covered by the flag-ON hash. `console.log` a per-gun table as the human decision aid. Plus headless snapshot-size + client-interp tests for the rail.

### S8.4 Synthetic touch (jsdom, `tests/touch/*`)
Dispatch `PointerEvent`s against a detached overlay (no canvas/GPU). Assert: left stick → analog `mx,my`; right stick → `aim=atan2(dy,dx)` + `BTN.FIRE` set while deflected, cleared on release; touch layer does NOT itself gate FIRE (gating is `weapons.ts:76-79`); aim-assist nudges within cone, no-op outside; grenade arc → `BTN.THROW` + `aimDist` scales, clears on release; SKILL/RELOAD/PICKUP one-rising-edge latches; coarse-pointer auto-detect + manual toggle both directions; **dormant `TouchControls` leaves `InputManager.sample` byte-identical** (desktop non-regression).

### S8.5 Real-device (L5, manual gate, claude-in-chrome MCP)
Inject a rAF frame-time sampler on `window.__bv3perf` (p50/p95); drive a scripted fight via `window.__bv3`. **Gate:** p50 ≥58 fps, p95 ≤~22 ms, portrait, reference device. **Mandatory `document.hidden` mitigation:** keep the tab foregrounded, assert `visibilityState==='visible'` before sampling, discard runs whose deltas cluster at Chrome's 50 ms/1000 ms hidden-throttle (the loop's `advance(false)` renders nothing when hidden). Device checks: tier auto-selection lands on intended tier (iOS picks sane tier without `deviceMemory`); iOS audio unlock → context `running`; canvas height tracks `visualViewport` after URL-bar collapse.

### S8.6 Responsive shell (jsdom `tests/shell/*` + device pass)
Assert arena ~top 60% / controls ~bottom 40% in portrait; HUD relocates to safe-area corners; `index.html` viewport includes `viewport-fit=cover`; `styles.css` contains lobby `@media`; `.screen` keeps `touch-action:auto`. Device: portrait screenshot, controls don't overlap action, HUD in safe area.

### S8.7 Per-phase gate (fail-fast, ordered)
1. `tsc --noEmit`. 2. `npm test` (all existing + new golden/purity/touch). 3. Flag-OFF golden hash == baseline. 4. Step-cost (`<8 ms` + median envelope). 5. Scene-graph instrumentation assertions. 6. Phase-specific suite. 7. **L5 device sign-off** (human checkbox + pasted `__bv3perf` evidence; CI has no GPU). Sim-touching phases MUST add/update a golden hash; render-touching phases MUST keep `purity.test.ts` green. CI-block steps 1–6; step 7 is a required human checkbox.

### S8.8 New infra
`tests/{determinism,purity,balance}.test.ts` (node); `tests/{scene,touch,shell}/*` (jsdom); `vitest.config.ts` or `vite.config.ts` `test` block with `environmentMatchGlobs` (**note: valid in vitest 2.1; superseded by `test.projects` in vitest 3+ — migrate on bump** — LOW adversary fix); add `jsdom` to devDeps; `--expose-gc` for alloc probes; the S4 `deps.inline:['@dimforge/rapier2d']` block; L5 runbook doc.

---

## Appendix — Adversarial Findings Resolved

| Section | Flaw | Severity | Resolution |
|---|---|---|---|
| S1 | Determinism "host re-applies exact aim" overstated for AIM (host applies only freshest input; no aim reconciliation) | High | Documented as accepted client-local feel aid; **`ASSIST_STRENGTH` capped ≤0.30**; Phase-2-optional host re-derivation (ship raw angle + `assistTargetId`) deferred |
| S1 | `setWorld` only wired for host/local; client path null/interpolated view | Medium | `setWorld` called in BOTH `tick()` branches with null guard; lagged-position assist accepted (host re-derivation removes it if needed) |
| S1 | RELOAD/PICKUP one-frame latch fragile under multi-tick/frame catch-up | Medium | Consume-and-clear the latch INSIDE `sample()` on first read → ≤1 emit/sample regardless of ticks; test 2 ticks/frame |
| S1 | Stuck-button on hot-swap/hidden (host keeps simming) | Medium | Made NORMATIVE: blur/visibility/cancel zero all state+latches; hot-swap emits `emptyInput` one tick |
| S1 | Laser `depthTest:false` punches through walls | Low | Clamp laser length to first wall via existing `segAABB` wall sweep (honest occlusion) |
| S1 | Synthesized `aimDist` camera lead shoves babo out of portrait band | Low | Add `aimLeadScale=0.35` on touch; validate against `camTargetYBias` |
| S2 | Same-tick double-resolution / point-blank timing unspecified | High | Specified: 1 `projectileSystem` step same tick (~1.83 u); point-blank ≤1.83 u hit same tick; test at 0.7 u |
| S2 | Two-source-of-truth VFX (spawn beam vs slug terminus) | High | Drop speculative spawn beam; moving slug only + terminal-only beam from committed `ox,oy` origin; optional muzzle flash |
| S2 | Fast-slug interp worse than admitted; primary mask was the removed beam | Medium | Render-side constant-velocity dead-reckon PROMOTED into the S2 deliverable; speed recalibrated to 110 |
| S2 | Near-instant Lance adds little counterplay at median range | Medium | Speed 110 (mid-range dodge real); aim-assist LEAD disabled for Lance; mandatory probe value |
| S2 | `MAX_PROJECTILES` drop-oldest can delete a live rocket/flame | Medium | Drop oldest BULLET only; never a rocket/flame mid-flight; order-deterministic; cap = grief guard |
| S2 | `tickWeapons` has no projectile step; LANCE_KNOCK line ref | Low | Add `tickCombat` (weapon+projectile); rewrite 3 Lance tests; LANCE_KNOCK at `weapons.ts:10` |
| S3 | Gun/ClassVisual cache double-frees shared resources on 2nd babo | High | WeakSet-guard disposal to skip cache-owned; cache disposes at teardown; gate 5c/5d to low/mid; spawn→swap→respawn test |
| S3 | "all tiers" vs "off on high" merge contradiction | Medium | Per-feature policy table: shadows all-tiers; walls/gun/class merge low-mid only; S3.11 corrected |
| S3 | Lobby-skip crashes (`start/setLoadout/resize` unguarded) | Medium | Wrap entire `mountLobbyPreview`; static-icon early return; null-tolerant dispose |
| S3 | GRINDER wall count (16 vs 18) | Low | Corrected to 18 walls (~36 draw calls) |
| S3 | Babo transparency hooks gun-only guard; sorting of overlays | Low | Add body `mat.transparent` flip inside the `:211` guard; keep `:207` write; verify nameTag/crown/flag sorting |
| S3 | `basicize`/`lambertize` under-specified for glow/map | Low | Explicit: keep map/transparent/opacity/side/depthWrite; drop metalness/roughness/emissiveIntensity; fold emissive→color; unit test |
| S4 | Non-compat Rapier init contract unverified (init() vs auto-instantiate) | Critical | Defensive `initPhysics` handles both; mandatory install+read+full-suite+seed-42 determinism gate before commit |
| S4 | Vitest WASM top-level-await dep-optimizer hazard left conditional | High | Make `deps.inline`/optimizer-exclude mandatory in config; acceptance gated on `npm test` green |
| S4 | Async `enterMatch` floating promises → black screen on reject | Medium | Await imports BEFORE `ui.hide()`; `.catch` restores lobby+toast; reset `initPromise` on reject |
| S4 | First cold local match freeze (prefetch only warmed Rapier) | Medium | Prefetch warms Rapier + render chunks; spinner around awaited imports; Fast-3G+4×CPU TTFF check |
| S4 | STUN `preconnect` to a non-TLS UDP port | Low | Drop STUN preconnect; keep `dns-prefetch`; keep valid 0.peerjs.com preconnect |
| S5 | `client.view` memo wrong for tick()/interval call graph | High | Memo on interp timestamp (not beginFrame token); add `predictedSelf()` so tick path skips full rebuild |
| S5 | Binary snapshot strips names; bots absent from lobby table | Medium | Full id→name table (humans+bots) in `'start'`/dirty-bit; (binary itself Phase-3-optional) |
| S5 | distSq blast radius (pool-merge feeds geometry) | Medium | Keep `dist()` at pool-merge + spawn + magnitude; distSq only leaf-boolean sites; `SIM_BASELINE_V` bundle + chaos-replay diff |
| S5 | CCD speed-gate reads stale post-step velocity on impulse tick | Low | Enable CCD at `applyImpulse()` time; add interior-wall high-impulse tunneling test |
| S5 | "set serialization on both ends" misleading | Low | Only `client.ts:72` changes; host inherits client serialization |
| S5 | iOS unlock double-entry / silent-buffer twice | Low | `unlocked` flag; remove ALL unlock listeners on first success; silent buffer after lazy-init block |
| S6 | DPR canvas read audit under-scoped (`addSplatter` independent read) | High | Audit EVERY `canvas.width/height` in hud/screenfx incl. `screenfx.ts:48-50`; repoint all to `cssW/cssH` |
| S6 | SVG-only manifest icon fails Android install; iOS ignores manifest | High | Build-time rasterize 192/512 PNGs from SVG (no committed binary); apple-* metas own iOS chromeless |
| S6 | Wake Lock re-acquire fails on async rematch flow | Medium | Acquire at click-handler top where possible; else best-effort + visibility re-acquire; document brief rematch dim |
| S6 | `.screen` scroll container could lose touch on global `touch-action:none` | Medium | Scope `touch-action:none` to play surfaces ONLY; `.screen` keeps `auto`/`pan-y`; buttons `manipulation` |
| S6 | ~1-frame audio gap on tab-return claimed as zero transient | Low | Acknowledged as accepted transient |
| S6 | "Extend the global reset" could drop load-bearing `#game-canvas` rule | Low | Edits are ADDITIVE; explicitly preserve `#game-canvas{position:absolute;inset:0;display:block}` |
| S7 | Binary snapshot mis-located (PeerJS option, not JSON.stringify) | Medium | Re-scoped: serialization changes at `client.ts:72`, negotiated in lobby handshake; Phase-3/profile-gated |
| S7 | Host-only interval is a behavior change for local (hidden pause), not a no-op | Low | Documented: local/client pause-and-resync on hidden, dropping hidden-elapsed time |
| S7 | Wrong file count ("12"); blood uses `dist()` not literal `Math.hypot` | Low | Corrected to 11 suites; swap is `dist()`→`distSq()` with squared RHS |
| S7 | Balance probe has no numeric pass/fail; could stall P2 | Low | Decoupled: P2 ships flag-OFF; default-on is out-of-band; provisional band given |
| S8 | "Lance gains rng draw only if spread>0" factually wrong | High | `sim.rng.spread(0)` still advances state → flag-ON is a distinct RNG stream; flag-ON gets its OWN baseline |
| S8 | Headless scene-stats infeasible in plain jsdom (no canvas/GL) | High | Primary = scene-graph instrumentation unit tests + injectable texture factory; `renderer.info` path optional fallback |
| S8 | Balance probe ignores bot-lead confound | Medium | Documented; reported as intended (bots lead real projectiles); covered by flag-ON hash |
| S8 | blood distSq math reasoning inverted | Medium | Corrected: squaring is boundary-exact; only float-rounding-of-RHS is the hazard (golden hash catches) |
| S8 | Forced-gun scenario over-engineered | Low | Use `addPlayer` gun param; suppress mid-life scavenge; `chosenGun` persists on respawn |
| S8 | `simHash` under-covers VFX/mode state | Low | Extend digest to grenades/pools/fires/CTF flags, or scope + second digest |
| S8 | `environmentMatchGlobs` deprecated in vitest 3 | Low | Valid in 2.1; flag migration to `test.projects` on bump |

---

## Risks & Remaining Open Questions

1. **Non-compat Rapier init contract** (S4) — the single highest-uncertainty item; only `-compat` is installed today. The defensive `initPhysics` + mandatory install-and-verify gate de-risks it, but the swap cannot be merged until the seed-42 byte-identical determinism check passes empirically.
2. **Aim-assist host/client mismatch under latency** (S1/S2) — capped `ASSIST_STRENGTH` bounds it; if playtest on a laggy link still shows "my reticle was on him," undertake the Phase-2-optional host re-derivation. The all-projectile change amplifies this (every hit is now travel-time-gated).
3. **Lance balance** (S2) — 110 u/s and the disabled-lead-for-Lance rule are starting values; the balance probe + manual playtest (desktop + touch) must confirm mid-range dodging feels real before flipping `projectileLance` default-on. Lever is muzzle speed, never falloff or lag-comp.
4. **Mid-range 60 fps actually achievable** (S3/S7) — the whole P3 list is profile-gated; the P2 device profile decides which structural items (instancing, splat composite) are needed. If the profile is worse than assumed, binary snapshots and/or babo instancing become required; if better, both may be cut. Worker offload stays CUT unless main-thread sim (not render) > 10 ms in chaos.
5. **DPR 2D-canvas regression surface** (S6) — the `cssW/cssH` repoint touches every `canvas.width/height` read in hud/screenfx; a missed read mis-places HUD/splatter. Needs the full grep pass + a desktop + one-phone visual regression check.
6. **Shared-cache disposal** (S3) — the WeakSet-guarded disposal is the highest-risk render change; the spawn→swap→despawn→respawn test is the gate. Gating to low/mid keeps the hero/desktop path on the proven per-instance code.
7. **Build-time PNG icon rasterization** (S6) — preserves the zero-binary-assets rule but adds a build step; confirm the toolchain (e.g. an SVG→PNG step in the Vite build) is acceptable, else fall back to the down-scoped SVG-only manifest (Android install best-effort).
8. **Per-tick name table for binary snapshots** (S5, Phase-3-opt) — late-join/dropped-`start` must fall back to a default name; only relevant if binary snapshots are undertaken.
9. **iOS `visualViewport` transient sizing** during URL-bar animation — rAF-coalesce mitigates thrash; a mid-animation sample can momentarily mis-size (self-corrects next frame). On-device confirm needed.
10. **CCD removal under extreme knockback** (S5) — the impulse-time CCD-enable fallback + interior-wall stress test must validate before shipping `PLAYER_CCD=false`; otherwise keep CCD on (the savings are forfeit but determinism/safety hold).
