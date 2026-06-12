# Babo Violent 3

A top-down, physics-driven multiplayer arena shooter — the spiritual successor to
*Babo Violent 2*. You are a **Babo**: a blood-filled rolling sphere with a class chassis
and a scavenged gun.

**Momentum is the skill · blood is the terrain · recoil is movement · every kill is a
contested loot scramble.**

Runs in any browser. Ships on GitHub Pages. Player-hosted P2P lobbies (PeerJS/WebRTC) —
no central game server, true to the original.

## Play

```bash
npm install
npm run dev        # http://localhost:5173
```

- **Practice vs bots** — instant single-player arena (also great for learning the guns).
- **Host game** — opens a lobby with a 6-letter join code; share it with friends.
- **Join** — paste a code, pick your class, wait for the host to start.

## Controls

| Action | Bind |
|---|---|
| Move | `WASD` |
| Aim / Fire | Mouse / `LMB` |
| Throw grenade (hold to aim the arc) | `RMB` |
| Class ability | `Space` |
| Swap to a dropped gun | `E` |
| Scoreboard | `Tab` (hold) |
| Leave match | `Esc` ×2 |

Your **health shows on your Babo** — it visibly fills with blood as you take damage.
Ammo, heat and ability cooldown hug the crosshair. Eyes on the fight.

## The systems that make it BV3

- **Blood is physical.** Splatter accumulates on the arena floor for the whole match
  (a single splat-map draw). Fresh, large pools are *slick* — you slide through them
  (max 24 physical zones, oldest congeal). Wounded Babos drip a trackable trail. Fire
  (Pyre, Molotov) ignites pools into area-denial fire zones.
- **Recoil is movement.** Every shot shoves you opposite your aim, scaled by your class's
  mass. Rocket-jump with the Thumper, kick-retreat with the Maw, strafe-thrust with the
  Hurricane. Fortify negates it; Phantoms fly.
- **The loot loop.** Kills pop the victim: their gun + a health pack drop on the spot,
  making every kill site a contested node. One-gun swap (`E`), health auto-pickup.
  Equipment (frags, molotovs, smokes) spawns on map nodes every 20s.

## Classes

| Class | Chassis | Ability (Space) |
|---|---|---|
| **Spider** | light, fast | Grappling hook — tether to a wall and swing (hold) |
| **Juggernaut** | heavy, slow | Pinball Dash — bouncing ram with i-frames + impact damage |
| **Bastion** | tanky | Fortify — briefly immune to knockback, recoil and pulls |
| **Phantom** | featherweight | Phase Shift — ethereal; bodies and shots pass through |
| **Trapper** | medium | Gravity Well — drags everyone near the crosshair together |

## Arsenal (8 guns, reload or heat — never hunt ammo)

Stinger (SMG) · Workhorse (AR) · Maw (shotgun) · Hurricane (minigun, spin-up) ·
Thumper (rocket, self-launch) · Ion (plasma, overheats) · Lance (charged railgun) ·
Pyre (flamethrower, ignites blood)

## Modes

- **Team Deathmatch** — first team to the frag limit.
- **High Bounty (FFA)** — kills raise your heat; the leader is marked for everyone;
  killing the leader pays +5 and resets them. Rotating-villain snowball control.
- **Capture the Flag** — carriers lose their ability; 3 caps win.

## Tech

Vite + TypeScript · Three.js (render) · Rapier2D WASM (physics, headless-testable) ·
PeerJS (WebRTC star topology, host-authoritative, client prediction + interpolation) ·
WebAudio synthesis (zero audio assets) · procedural canvas textures (zero image assets).

```bash
npm test           # 100 sim tests incl. full bot matches, determinism, perf
npm run typecheck
npm run build      # static bundle → dist/ (deployed by .github/workflows/deploy.yml)
```

Design docs: `../docs/plans/2026-06-12-babo-violent-3-design.md` (full spec),
`docs/RUBRIC.md` (the polish bar this build is held to), `docs/DEVIATIONS.md`.
