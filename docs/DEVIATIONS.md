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
