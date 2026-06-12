# Babo Violent 3 — Polish Rubric

This is the acceptance rubric for a "polished v1" of Babo Violent 3. Every workflow
review pass scores the build against these criteria. A criterion passes only if it is
*verifiable* — by unit test, by build output, or by playing the game in a browser.

Scoring: each item is **P** (pass), **F** (fail), or **P-** (works but rough).
Ship gate: all "Core" items P, no more than three P- in "Feel", zero F anywhere.

---

## 1. Core — it is a game (must all pass)

| # | Criterion | Verify |
|---|---|---|
| C1 | `npm run build` completes with zero TypeScript errors | CI/shell |
| C2 | `npm test` passes; sim systems (damage, weapons, modes, blood caps) have unit coverage | shell |
| C3 | Game boots to a main menu in < 3 s on a dev machine; no console errors on load | browser |
| C4 | Practice mode (vs bots) reachable in ≤ 2 clicks from boot; player spawns and can move | browser |
| C5 | WASD movement is force-based with momentum — no instant stop, no instant max-speed | browser + unit test on damping |
| C6 | Mouse aim + LMB fire works; projectiles spawn, travel, hit walls and Babos | browser |
| C7 | Damage → death → pop → corpse drops gun + health pack → respawn after ~3 s with i-frames | unit + browser |
| C8 | All 5 classes selectable, each with distinct chassis feel and a working Space ability | browser |
| C9 | At least 6 of the 8 guns implemented per spec table (sustain, recoil, identity) | unit + browser |
| C10 | Recoil impulse scales with `recoil_impulse / mass` — Thumper visibly self-launches a Phantom | unit + browser |
| C11 | Blood: visual splat-map accumulates over the match; physical slick zones reduce traction, capped at 24 | unit + browser |
| C12 | TDM and High Bounty modes run to a win condition and show an end screen | unit + browser |
| C13 | Host can create a lobby with a join code; a second client can join and both see each other move | browser (two tabs) |
| C14 | The Grinder map: walls block bullets and sight; grenades arc over walls | browser |
| C15 | 60 fps with 8 Babos (bots) fighting at sim tick 60 Hz on mid hardware | browser perf |

## 2. Feel — it is a *good* game

| # | Criterion | Verify |
|---|---|---|
| F1 | Diegetic health: Babo visibly fills/reddens with damage; readable at a glance | browser |
| F2 | Crosshair HUD: ammo segments / heat fill hug the crosshair; reload & overheat states read clearly | browser |
| F3 | Death pop has impact: radial impulse, blood burst, screen splatter when near | browser |
| F4 | Screen shake on explosions and big hits — localized, not nauseating | browser |
| F5 | Low-HP state: vignette + heartbeat + wounded blood trail dripping | browser |
| F6 | Per-weapon synthesized audio: fire, reload/overheat, hit tick, death pop | browser |
| F7 | Hit markers (visual + audio tick) confirm hits | browser |
| F8 | Grenade throw: hold RMB shows arc + landing indicator, release throws, arc clears walls | browser |
| F9 | Blood-slide is *felt*: entering a pool visibly changes handling | browser |
| F10 | Pyre/Molotov ignite blood pools into fire zones that deal damage | unit + browser |
| F11 | Kill feed, scoreboard (Tab), and mode-specific UI (Bounty leader marker) work | browser |
| F12 | Bots fight credibly: move, aim with error, use abilities, seek loot | browser |
| F13 | Menu/lobby UI is clean, readable, and keyboard/mouse friendly — looks designed, not default | browser |
| F14 | Class select shows stats + ability descriptions; differences are honest | browser |

## 3. Net — multiplayer holds up

| # | Criterion | Verify |
|---|---|---|
| N1 | Join-code flow: host gets code, peer joins via code (PeerJS broker) | browser, two tabs |
| N2 | Client prediction on own Babo; remote Babos interpolate (~100 ms buffer) — no visible rubber-banding at low latency | browser |
| N3 | Snapshots at 20–30 Hz; events (kills, pops, pickups) delivered reliably | code review + browser |
| N4 | Host disconnect ends match gracefully → all peers return to menu with a message | browser |
| N5 | Late-join or full-lobby rejection handled without crashing either side | browser |

## 4. Ship — it can be published

| # | Criterion | Verify |
|---|---|---|
| S1 | `vite build` bundle works from a static file server (relative base) | shell + preview |
| S2 | GitHub Actions workflow file publishes `dist/` to Pages | code review |
| S3 | README: how to play, controls, classes, guns, hosting a lobby | review |
| S4 | No external asset downloads at runtime: all assets procedural or bundled | code review |

---

## Design-fidelity guardrails (anchor-doc deviations must be logged)

Deviations from `docs/plans/2026-06-12-babo-violent-3-design.md` are allowed but must be
recorded in `docs/DEVIATIONS.md` with a one-line rationale. Known intentional deviations:

1. **Bots / practice mode added** — not in the spec; needed for autonomous testing,
   solo play, and demoing without peers. Bots also back-fill lobbies.
