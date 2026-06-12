import { dist } from '../../core/math';
import { C } from '../../data/constants';
import type { GameSim } from '../sim';
import type { FlagState } from '../types';

/** Base stand position for a team's flag (cap point + return spot). */
function flagStand(sim: GameSim, team: 0 | 1): { x: number; y: number } {
  return team === 0 ? sim.map.flags!.team0 : sim.map.flags!.team1;
}

/** Put a flag back on its stand (no event — callers emit flagReturned/flagCapped). */
function resetFlag(sim: GameSim, flag: FlagState): void {
  const stand = flagStand(sim, flag.team);
  flag.state = 'base';
  flag.x = stand.x;
  flag.y = stand.y;
  flag.carrier = -1;
  flag.returnT = 0;
}

function endMatch(sim: GameSim, winner: number): void {
  sim.mode.ended = true;
  sim.mode.winner = winner;
  sim.emit({ t: 'matchEnd', winner });
}

/**
 * Scoring, timers, win conditions, respawns.
 * - Tick respawnT for dead players → sim.respawn(p).
 * - Consume sim.deathsThisTick:
 *   - tdm: killer's team +1 (no credit for suicides/world).
 *   - bounty: killer score +1 (+C.BOUNTY_LEADER_BONUS if victim was leader →
 *     victim bounty reset, emit leaderKilled); killer bounty +1; recompute
 *     leader (highest bounty > 0, emit leaderChange).
 *   - all: killer.kills++, killer.score++ (bounty uses score as win metric).
 * - ctf: flag pickup (enemy flag at C.FLAG_PICKUP_RADIUS), carry (flag follows
 *   carrier; carrier ability disabled — enforce by holding abilityCD ≥ 0.25),
 *   cap at own base when own flag is home (+1 teamScore, emit flagCapped),
 *   dropped flag return (own team touch or returnT expiry).
 * - Timer: mode.timeLeft down; end when score/cap/time reached → mode.ended,
 *   winner, emit matchEnd.
 */
export function modeSystem(sim: GameSim, dt: number): void {
  const mode = sim.mode;
  if (mode.ended) return;

  // --- Respawns --------------------------------------------------------------
  for (const p of sim.players.values()) {
    if (p.alive) continue;
    p.respawnT -= dt;
    if (p.respawnT <= 0) sim.respawn(p);
  }

  // --- Score this tick's deaths ------------------------------------------------
  for (const d of sim.deathsThisTick) {
    const victim = sim.players.get(d.victim); // may have left mid-tick
    const victimWasLeader = mode.mode === 'bounty' && mode.leaderId >= 0 && d.victim === mode.leaderId;
    // Heat persists through ordinary deaths; only killing the LEADER resets
    // their heat (design §6.3 — "a new villain rises").
    if (victim && victimWasLeader) victim.bounty = 0;
    if (d.killer < 0 || d.killer === d.victim) continue; // suicide/world: no credit
    const k = sim.players.get(d.killer); // may have left mid-tick
    if (!k) continue;
    k.kills++;
    k.score++;
    if (mode.mode === 'tdm' && (k.team === 0 || k.team === 1)) mode.teamScores[k.team]++;
    if (mode.mode === 'bounty') {
      k.bounty++;
      if (victimWasLeader) {
        k.score += C.BOUNTY_LEADER_BONUS;
        sim.emit({ t: 'leaderKilled', killer: d.killer, victim: d.victim });
      }
    }
  }

  // --- Bounty: re-mark the leader (highest bounty > 0; ties keep current) -----
  if (mode.mode === 'bounty') {
    let leader = -1;
    let best = 0;
    for (const p of sim.players.values()) {
      if (p.bounty > best) { best = p.bounty; leader = p.id; }
    }
    const current = sim.players.get(mode.leaderId);
    if (current && best > 0 && current.bounty === best) leader = current.id;
    if (leader !== mode.leaderId) {
      mode.leaderId = leader;
      sim.emit({ t: 'leaderChange', player: leader });
    }
  }

  // --- CTF flags ---------------------------------------------------------------
  for (const flag of mode.flags) {
    if (flag.state === 'dropped') {
      flag.returnT -= dt;
      if (flag.returnT <= 0) {
        resetFlag(sim, flag);
        sim.emit({ t: 'flagReturned', team: flag.team });
        continue;
      }
    }

    if (flag.state !== 'carried') {
      // Touch: enemies steal the flag; own team returns a dropped one.
      for (const p of sim.players.values()) {
        if (!p.alive || p.carryingFlag !== -1) continue;
        if (dist(p.x, p.y, flag.x, flag.y) > C.FLAG_PICKUP_RADIUS) continue;
        if (p.team !== flag.team) {
          flag.state = 'carried';
          flag.carrier = p.id;
          p.carryingFlag = flag.team;
          p.abilityT = 0; // cancel any engaged ability — carriers fight powerless
          sim.emit({ t: 'flagTaken', team: flag.team, by: p.id });
          break;
        }
        if (flag.state === 'dropped') {
          resetFlag(sim, flag);
          sim.emit({ t: 'flagReturned', team: flag.team });
          break;
        }
      }
    }

    if (flag.state === 'carried') {
      const carrier = sim.players.get(flag.carrier);
      if (!carrier || !carrier.alive || carrier.carryingFlag !== flag.team) {
        // Defensive: kill()/removePlayer() drop carried flags, so this shouldn't hit.
        flag.state = 'dropped';
        flag.carrier = -1;
        flag.returnT = C.FLAG_RETURN_TIME;
        sim.emit({ t: 'flagDropped', team: flag.team, x: flag.x, y: flag.y });
        continue;
      }
      // Flag rides the carrier; carrying locks the carrier's ability out.
      flag.x = carrier.x;
      flag.y = carrier.y;
      carrier.abilityCD = Math.max(carrier.abilityCD, 0.25);

      // Cap: carrier at own stand while their own flag sits at home.
      if (carrier.team === 0 || carrier.team === 1) {
        const own = mode.flags.find((f) => f.team === carrier.team);
        const stand = flagStand(sim, carrier.team);
        if (own && own.state === 'base'
            && dist(carrier.x, carrier.y, stand.x, stand.y) <= C.FLAG_PICKUP_RADIUS) {
          mode.teamScores[carrier.team]++;
          carrier.score += 3;
          carrier.carryingFlag = -1;
          resetFlag(sim, flag);
          sim.emit({ t: 'flagCapped', team: flag.team, by: carrier.id });
        }
      }
    }
  }

  // --- Timer + win conditions ----------------------------------------------------
  mode.timeLeft -= dt;
  if (mode.mode === 'bounty') {
    let winner = -1;
    let best = -Infinity;
    let tied = false;
    for (const p of sim.players.values()) {
      if (p.score > best) { best = p.score; winner = p.id; tied = false; }
      else if (p.score === best) tied = true;
    }
    if (best >= mode.scoreLimit || mode.timeLeft <= 0) {
      endMatch(sim, tied ? -1 : winner);
    }
  } else {
    const [s0, s1] = mode.teamScores;
    if (s0 >= mode.scoreLimit || s1 >= mode.scoreLimit || mode.timeLeft <= 0) {
      endMatch(sim, s0 > s1 ? 0 : s1 > s0 ? 1 : -1);
    }
  }
}
