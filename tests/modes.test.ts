import { describe, expect, it } from 'vitest';
import { C } from '../src/data/constants';
import { clearEvents, eventsOf, makeSim, run, runUntil, teleport } from './helpers';

describe('mode system', () => {
  it('auto-spawns players at match start via the respawnT path', async () => {
    const sim = await makeSim();
    const a = sim.addPlayer('A', 'spider', 0, false);
    const b = sim.addPlayer('B', 'bastion', 1, false);
    expect(a.alive).toBe(false);
    run(sim, 1);
    expect(a.alive).toBe(true);
    expect(b.alive).toBe(true);
    expect(eventsOf(sim, 'respawn').length).toBe(2);
  });

  it('respawns the dead after RESPAWN_DELAY', async () => {
    const sim = await makeSim();
    const a = sim.addPlayer('A', 'spider', 0, false);
    const v = sim.addPlayer('V', 'phantom', 1, false);
    run(sim, 1);
    v.invulnT = 0;
    a.spawnProt = false; // spawn protection also blocks dealing damage
    sim.damage(v, a.id, 999, 'stinger');
    expect(v.alive).toBe(false);
    const ticks = runUntil(sim, () => v.alive);
    expect(ticks).toBeGreaterThan(C.RESPAWN_DELAY * C.SIM_HZ - 5);
    expect(ticks).toBeLessThan(C.RESPAWN_DELAY * C.SIM_HZ + 5);
  });

  it('tdm: a kill credits the killer and their team', async () => {
    const sim = await makeSim();
    const a = sim.addPlayer('A', 'spider', 0, false);
    const v = sim.addPlayer('V', 'phantom', 1, false);
    run(sim, 1);
    v.invulnT = 0;
    a.spawnProt = false;
    sim.damage(v, a.id, 999, 'stinger');
    run(sim, 1);
    expect(a.kills).toBe(1);
    expect(a.score).toBe(1);
    expect(sim.mode.teamScores).toEqual([1, 0]);
    expect(v.deaths).toBe(1);
  });

  it('tdm: suicide and world deaths score nothing (heat persists)', async () => {
    const sim = await makeSim();
    const a = sim.addPlayer('A', 'spider', 0, false);
    run(sim, 1);
    a.invulnT = 0;
    a.spawnProt = false;
    a.bounty = 2; // pretend heat; persists through ordinary deaths (design §6.3)
    sim.damage(a, a.id, 999, 'thumper'); // self-damage discount still lethal
    run(sim, 1);
    expect(a.alive).toBe(false);
    expect(a.kills).toBe(0);
    expect(a.score).toBe(0);
    expect(a.bounty).toBe(2);
    expect(sim.mode.teamScores).toEqual([0, 0]);

    // World kill after respawn: still no credit
    expect(runUntil(sim, () => a.alive)).toBeGreaterThan(0);
    sim.kill(a, -1, 'world');
    run(sim, 1);
    expect(a.score).toBe(0);
    expect(sim.mode.teamScores).toEqual([0, 0]);
  });

  it('bounty: kills build heat and mark the leader once', async () => {
    const sim = await makeSim({ mode: 'bounty' });
    const a = sim.addPlayer('A', 'spider', -1, false);
    const v = sim.addPlayer('V', 'phantom', -1, false);
    run(sim, 1);
    clearEvents(sim);

    v.invulnT = 0;
    a.spawnProt = false;
    sim.damage(v, a.id, 999, 'stinger');
    run(sim, 1);
    expect(a.bounty).toBe(1);
    expect(sim.mode.leaderId).toBe(a.id);
    expect(eventsOf(sim, 'leaderChange')).toEqual([{ t: 'leaderChange', player: a.id }]);

    // Second kill: heat grows, leader unchanged → no duplicate event
    runUntil(sim, () => v.alive);
    clearEvents(sim);
    v.invulnT = 0;
    sim.damage(v, a.id, 999, 'stinger');
    run(sim, 1);
    expect(a.bounty).toBe(2);
    expect(sim.mode.leaderId).toBe(a.id);
    expect(eventsOf(sim, 'leaderChange').length).toBe(0);
  });

  it('bounty: killing the leader pays the bonus, resets their heat, can win', async () => {
    const sim = await makeSim({ mode: 'bounty' });
    const a = sim.addPlayer('A', 'spider', -1, false);
    const b = sim.addPlayer('B', 'phantom', -1, false);
    run(sim, 1);
    a.bounty = 3; // mark A as leader directly
    run(sim, 1);
    expect(sim.mode.leaderId).toBe(a.id);
    clearEvents(sim);

    sim.mode.scoreLimit = 1 + C.BOUNTY_LEADER_BONUS; // the leader kill should also win it
    a.invulnT = 0;
    b.spawnProt = false;
    sim.damage(a, b.id, 999, 'stinger');
    run(sim, 1);
    expect(b.score).toBe(1 + C.BOUNTY_LEADER_BONUS);
    expect(a.bounty).toBe(0);
    expect(b.bounty).toBe(1);
    expect(sim.mode.leaderId).toBe(b.id);
    expect(eventsOf(sim, 'leaderKilled')).toEqual([{ t: 'leaderKilled', killer: b.id, victim: a.id }]);
    expect(sim.mode.ended).toBe(true);
    expect(sim.mode.winner).toBe(b.id);
    expect(eventsOf(sim, 'matchEnd')).toEqual([{ t: 'matchEnd', winner: b.id }]);
  });

  it('tdm: ends when a team reaches the score limit, then stops stepping', async () => {
    const sim = await makeSim();
    const a = sim.addPlayer('A', 'spider', 0, false);
    const v = sim.addPlayer('V', 'phantom', 1, false);
    sim.mode.scoreLimit = 1;
    run(sim, 1);
    v.invulnT = 0;
    a.spawnProt = false;
    sim.damage(v, a.id, 999, 'stinger');
    run(sim, 1);
    expect(sim.mode.ended).toBe(true);
    expect(sim.mode.winner).toBe(0);
    expect(eventsOf(sim, 'matchEnd')).toEqual([{ t: 'matchEnd', winner: 0 }]);
    const tick = sim.tick;
    run(sim, 5);
    expect(sim.tick).toBe(tick); // sim halts once ended
  });

  it('tdm: time expiry picks the leading team, or a draw', async () => {
    const sim = await makeSim();
    const a = sim.addPlayer('A', 'spider', 0, false);
    const v = sim.addPlayer('V', 'phantom', 1, false);
    run(sim, 1);
    v.invulnT = 0;
    a.spawnProt = false;
    sim.damage(v, a.id, 999, 'stinger');
    run(sim, 1);
    sim.mode.timeLeft = 0.02;
    run(sim, 3);
    expect(sim.mode.ended).toBe(true);
    expect(sim.mode.winner).toBe(0);

    const draw = await makeSim();
    draw.addPlayer('A', 'spider', 0, false);
    draw.addPlayer('B', 'phantom', 1, false);
    draw.mode.timeLeft = 0.02;
    run(draw, 3);
    expect(draw.mode.ended).toBe(true);
    expect(draw.mode.winner).toBe(-1);
  });

  it('ctf: enemy grabs the flag, carries it, and caps for a point', async () => {
    const sim = await makeSim({ mode: 'ctf' });
    const a = sim.addPlayer('A', 'spider', 0, false);
    run(sim, 1);
    clearEvents(sim);
    const enemyFlag = sim.mode.flags.find((f) => f.team === 1)!;

    // Grab: stand on the enemy flag
    teleport(sim, a.id, enemyFlag.x, enemyFlag.y);
    run(sim, 1);
    expect(enemyFlag.state).toBe('carried');
    expect(enemyFlag.carrier).toBe(a.id);
    expect(a.carryingFlag).toBe(1);
    expect(eventsOf(sim, 'flagTaken')).toEqual([{ t: 'flagTaken', team: 1, by: a.id }]);

    // Carry: flag follows; ability locked out
    teleport(sim, a.id, 5, 5);
    run(sim, 1);
    expect(enemyFlag.x).toBeCloseTo(a.x, 1);
    expect(enemyFlag.y).toBeCloseTo(a.y, 1);
    expect(a.abilityCD).toBeGreaterThanOrEqual(0.25);

    // Cap: own stand while own flag is home
    teleport(sim, a.id, sim.map.flags!.team0.x, sim.map.flags!.team0.y);
    run(sim, 1);
    expect(sim.mode.teamScores).toEqual([1, 0]);
    expect(a.carryingFlag).toBe(-1);
    expect(a.score).toBe(3);
    expect(enemyFlag.state).toBe('base');
    expect(enemyFlag.x).toBeCloseTo(sim.map.flags!.team1.x, 5);
    expect(enemyFlag.y).toBeCloseTo(sim.map.flags!.team1.y, 5);
    expect(eventsOf(sim, 'flagCapped').length).toBe(1);
  });

  it('ctf: dropped flags return on own-team touch or returnT expiry', async () => {
    const sim = await makeSim({ mode: 'ctf' });
    sim.addPlayer('A', 'spider', 0, false);
    const b = sim.addPlayer('B', 'phantom', 1, false);
    run(sim, 1);
    const flag = sim.mode.flags.find((f) => f.team === 1)!;

    // Drive a dropped flag directly; its own team touches it
    flag.state = 'dropped';
    flag.x = 10; flag.y = 10;
    flag.returnT = C.FLAG_RETURN_TIME;
    clearEvents(sim);
    teleport(sim, b.id, 10, 10);
    run(sim, 1);
    expect(flag.state).toBe('base');
    expect(flag.x).toBeCloseTo(sim.map.flags!.team1.x, 5);
    expect(eventsOf(sim, 'flagReturned')).toEqual([{ t: 'flagReturned', team: 1 }]);

    // Auto-return when returnT runs out, nobody nearby
    teleport(sim, b.id, -20, -20);
    flag.state = 'dropped';
    flag.x = 10; flag.y = 10;
    flag.returnT = 0.2;
    clearEvents(sim);
    run(sim, 30); // 0.5 s
    expect(flag.state).toBe('base');
    expect(eventsOf(sim, 'flagReturned').length).toBe(1);
  });
});
