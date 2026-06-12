# Deviations from the design doc

Per `docs/RUBRIC.md`, every deviation from
`docs/plans/2026-06-12-babo-violent-3-design.md` is logged with a rationale.

1. **Bots / practice mode added.** Not in the spec. Needed for autonomous testing, solo
   play, demoing without peers, and back-filling lobbies. Bots use the same input
   pipeline as players (no cheats).
2. **Babos have no faces.** The first visual pass gave Babos eyes; reference screenshots
   of BV2 show plain glossy grid-patterned marbles. Reverted to a faceless globe-grid
   shell (the rolling pattern also reads motion better). The grid is shader-etched.
3. **Self-damage at 35%.** The spec doesn't define self-damage; rocket-jump tech requires
   surviving your own Thumper splash, so self-hits deal 35% (≈25 HP per rocket jump).
4. **aimDist added to the input packet.** Gravity Well "at the crosshair" and the grenade
   landing indicator need the cursor's ground distance, not just the angle. The grenade
   arc grows toward the cursor and is capped by hold time (spec: hold time only).
5. **CTF shipped in v1.** Spec listed it as fast-follow; the mode system made it cheap.
   Bots don't pursue flags yet (logged in tests), so it's best with humans.
6. **Single reliable DataChannel.** Spec asks for unreliable+redundant input transport;
   v1 uses one reliable-ordered JSON channel (PeerJS default) with a 3-input redundancy
   window. At 8 players the bandwidth is trivial; revisit if jitter shows up in play.
7. **Heat guns cool only while not firing** (spec said "simpler: cool whenever no
   discharge this tick") — with Ion's numbers, cooling during held fire meant it could
   never overheat; sustained fire now overheats in ~9s, matching the gun's identity.
8. **Host keeps simulating in a hidden tab** via a throttled setInterval fallback
   (Chrome suspends rAF in background tabs; without this, an alt-tabbed host froze the
   match for everyone).
9. **Lobby team assignment is join-order alternating**, not "auto-assigned to smaller
   team" (equivalent at lobby time; mid-match join isn't in v1).
10. **Snapshot cadence 20 Hz** (every 3rd tick) — the spec's 20–30 Hz range, bottom end,
    chosen because interpolation at 100 ms buffer covers it cleanly.

## Added after the adversarial review (2026-06-12)

11. **Spawn protection is symmetric and breakable.** Spec: protected Babos "can't deal
    or take damage". Implemented: dealing is blocked, and any attack (shot, throw,
    ability cast) immediately forfeits remaining protection — prevents both protected
    aggression and confusing no-damage shots.
12. **Grapple is capped at 3 s with a 0.8 s cooldown** (spec table: "— (held)",
    uncapped). Prevents permanent wall-hangs; numbers tunable.
13. **Gravity Well is pull-only.** Spec lists "pull/repel"; the class identity
    (drag enemies into hazards) is the pull. Repel variant deferred.
14. **CTF "ability disabled"** = new casts blocked (cooldown held at ≥0.25 s) and any
    engaged ability cancelled at the moment of flag pickup.
15. **Lance pacing**: charge time is the rate limiter (~0.9 s/shot), not the generic
    fire-rate lockout (which read as ~1.8 s/shot).
16. **Client prediction approximations**: mirrors the host's slick/fortify damping from
    snapshots, but does not replicate dash/grapple forces or wall restitution —
    divergence is bounded by reconciliation every third tick.
17. **Equipment never auto-swaps kinds**: rolling over a different special while holding
    one leaves it on the pad (the spec's anti-accidental-loss rationale, extended).
18. **High Bounty heat persists through ordinary deaths** (fixed to match spec §6.3:
    only killing the *Leader* resets their heat).

## Lobby loadout showcase (2026-06-12)

19. **Animated lobby showcase + editable name + weapon models.** Beyond the spec's
    static lobby, the lobby now renders a live 3D hero preview of the selected Babo
    (own WebGL context, turntable + aim sweep) that periodically *demonstrates the
    chosen class ability* (grapple/dash/fortify/phase/gravity-well) with a caption,
    plus an editable Babo name (synced over the `loadout` net message), distinct
    procedural 3D models + 2D silhouette icons for all 8 guns (held in-match too),
    and class-distinctive chassis accessories (legs / armor belt / shield ring /
    ethereal wisps / orbiting satellites) keyed off mass and ability. All procedural
    — zero added binary assets, preserving the GitHub Pages "no runtime downloads"
    constraint. The babo shader was extracted to `render/baboShader.ts` so the
    preview and the in-match babos read identically.
