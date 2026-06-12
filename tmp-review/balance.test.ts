/**
 * REVIEW PROBE — balance + game-health experiments (throwaway, not part of suite).
 * 1. Class balance: 5x 10-bot FFA bounty matches, kills/deaths per class.
 * 2. Gun lethality: bot duels with fixed guns, mean time-to-kill per gun.
 * 3. Match pacing: 8-bot TDM, kills/minute over the first 3 sim-minutes.
 */
import { describe, expect, it } from 'vitest';
import { makeSim, teleport } from '../tests/helpers';
import { ALL_CLASS_IDS, type ClassId } from '../src/data/classes';
import { GUNS, type GunId } from '../src/data/weapons';
import type { GameSim } from '../src/sim/sim';

interface DeathEv { victim: number; killer: number; gun: string }

/** Collect deaths from this tick's events, then drain (keeps memory flat). */
function drainDeaths(sim: GameSim): DeathEv[] {
  const out: DeathEv[] = [];
  for (const e of sim.events) {
    if (e.t === 'death') out.push({ victim: e.victim, killer: e.killer, gun: e.gun });
  }
  sim.events.length = 0;
  return out;
}

function pct(n: number, d: number): string {
  return d > 0 ? ((100 * n) / d).toFixed(1) + '%' : 'n/a';
}

describe('balance probe', () => {
  it('1. class balance — 5x 10-bot FFA bounty (scoreLimit 15, 5 min cap)', async () => {
    const seeds = [101, 202, 303, 404, 505];
    const agg = new Map<ClassId, { kills: number; deaths: number; score: number }>();
    for (const c of ALL_CLASS_IDS) agg.set(c, { kills: 0, deaths: 0, score: 0 });
    const lines: string[] = [];

    for (const seed of seeds) {
      const sim = await makeSim({ mode: 'bounty', seed, scoreLimit: 15, timeLimit: 300 });
      const bots = [];
      for (let i = 0; i < 10; i++) {
        bots.push(sim.addPlayer(`B${i}`, ALL_CLASS_IDS[i % 5], -1, true));
      }
      let ticks = 0;
      const maxTicks = 300 * 60;
      while (!sim.mode.ended && ticks < maxTicks) {
        sim.step();
        sim.events.length = 0;
        ticks++;
      }
      let matchKills = 0;
      for (const b of bots) {
        const a = agg.get(b.classId)!;
        a.kills += b.kills;
        a.deaths += b.deaths;
        a.score += b.score;
        matchKills += b.kills;
      }
      const winner = sim.players.get(sim.mode.winner);
      lines.push(
        `  seed ${seed}: ended=${sim.mode.ended} at ${(ticks / 60).toFixed(1)}s, ` +
        `kills=${matchKills}, winner=${winner ? `${winner.name}(${winner.classId}, score ${winner.score})` : 'draw/time'}`,
      );
    }

    let totalKills = 0;
    let totalDeaths = 0;
    for (const a of agg.values()) { totalKills += a.kills; totalDeaths += a.deaths; }
    lines.push(`  TOTAL kills=${totalKills} deaths=${totalDeaths} (fair share per class = 20%)`);
    for (const c of ALL_CLASS_IDS) {
      const a = agg.get(c)!;
      const kd = a.deaths > 0 ? (a.kills / a.deaths).toFixed(2) : 'inf';
      lines.push(
        `  ${c.padEnd(11)} kills=${String(a.kills).padStart(4)} (${pct(a.kills, totalKills).padStart(6)})  ` +
        `deaths=${String(a.deaths).padStart(4)} (${pct(a.deaths, totalDeaths).padStart(6)})  K/D=${kd}  score=${a.score}`,
      );
    }
    console.log('CLASS BALANCE (5 matches, 2 bots/class):\n' + lines.join('\n'));
    expect(totalKills).toBeGreaterThan(0);
  }, 600_000);

  it('2. gun lethality — fixed-gun bot duels, mean TTK per gun', async () => {
    // Start distance = the bots' preferred engagement range for each gun.
    const duels: { gun: GunId; startDist: number }[] = [
      { gun: 'stinger', startDist: 9 },
      { gun: 'workhorse', startDist: 11 },
      { gun: 'maw', startDist: 4 },
      { gun: 'hurricane', startDist: 11 },
      { gun: 'thumper', startDist: 13 },
      { gun: 'ion', startDist: 9 },
      { gun: 'lance', startDist: 13 },
      { gun: 'pyre', startDist: 4 },
    ];
    const TRIALS = 8;
    const CAP_S = 45;
    const lines: string[] = [];

    for (let gi = 0; gi < duels.length; gi++) {
      const { gun, startDist } = duels[gi];
      const sim = await makeSim({ mode: 'tdm', seed: 9000 + gi * 17 });
      const a = sim.addPlayer('A', 'bastion', 0, true); // bastion: ability never fires in a 1v1
      const b = sim.addPlayer('B', 'bastion', 1, true);

      const ttks: number[] = [];
      let timeouts = 0;
      let shots = 0;
      const deathGuns = new Map<string, number>();

      for (let trial = 0; trial < TRIALS; trial++) {
        // Sterile open-field reset: no loot, no gore, no grenades, full HP.
        sim.projectiles.length = 0;
        sim.grenades.length = 0;
        sim.pools.length = 0;
        sim.fires.length = 0;
        sim.smokes.length = 0;
        sim.pickups.length = 0;
        for (const p of [a, b]) {
          if (!p.alive) sim.respawn(p);
          p.hp = 100; p.invulnT = 0; p.burnT = 0;
          p.grenades = 0; p.equip = null; p.equipCount = 0;
          p.gun = gun; p.mag = GUNS[gun].magSize ?? 0;
          p.heat = 0; p.reloadT = 0; p.overheatT = 0;
          p.spin = 0; p.charge = 0; p.fireCD = 0; p.spreadAcc = 0;
        }
        teleport(sim, a.id, -startDist / 2, -12); // open band, no cover between
        teleport(sim, b.id, startDist / 2, -12);
        sim.events.length = 0;

        let killTick = -1;
        for (let t = 0; t < CAP_S * 60 && killTick < 0; t++) {
          sim.step();
          for (const e of sim.events) if (e.t === 'shot') shots++;
          const deaths = drainDeaths(sim);
          if (deaths.length > 0) {
            killTick = t;
            for (const d of deaths) deathGuns.set(d.gun, (deathGuns.get(d.gun) ?? 0) + 1);
          }
        }
        if (killTick >= 0) ttks.push(killTick / 60);
        else timeouts++;
      }

      const mean = ttks.length ? (ttks.reduce((s, x) => s + x, 0) / ttks.length).toFixed(1) : 'n/a';
      const med = ttks.length ? ttks.slice().sort((x, y) => x - y)[Math.floor(ttks.length / 2)].toFixed(1) : 'n/a';
      const attribution = [...deathGuns.entries()].map(([g, n]) => `${g}:${n}`).join(' ') || 'none';
      lines.push(
        `  ${gun.padEnd(10)} d=${String(startDist).padStart(2)}  kills=${ttks.length}/${TRIALS}  ` +
        `meanTTK=${String(mean).padStart(5)}s  medTTK=${String(med).padStart(5)}s  timeouts=${timeouts}  ` +
        `shots=${shots}  deathBy[${attribution}]`,
      );
    }
    console.log(`GUN LETHALITY (bastion-v-bastion duels, ${TRIALS} trials, cap ${CAP_S}s):\n` + lines.join('\n'));
    expect(lines.length).toBe(duels.length);
  }, 600_000);

  it('2b. thumper drill-down — TTK vs start distance, suicide tracking', async () => {
    const TRIALS = 8;
    const CAP_S = 45;
    const lines: string[] = [];
    for (const startDist of [5, 8, 13]) {
      const sim = await makeSim({ mode: 'tdm', seed: 777 + startDist });
      const a = sim.addPlayer('A', 'bastion', 0, true);
      const b = sim.addPlayer('B', 'bastion', 1, true);
      const ttks: number[] = [];
      let timeouts = 0;
      let suicides = 0;
      let frags = 0;
      for (let trial = 0; trial < TRIALS; trial++) {
        sim.projectiles.length = 0; sim.grenades.length = 0; sim.pools.length = 0;
        sim.fires.length = 0; sim.smokes.length = 0; sim.pickups.length = 0;
        for (const p of [a, b]) {
          if (!p.alive) sim.respawn(p);
          p.hp = 100; p.invulnT = 0; p.burnT = 0;
          p.grenades = 0; p.equip = null; p.equipCount = 0;
          p.gun = 'thumper'; p.mag = 1;
          p.heat = 0; p.reloadT = 0; p.overheatT = 0;
          p.spin = 0; p.charge = 0; p.fireCD = 0; p.spreadAcc = 0;
        }
        teleport(sim, a.id, -startDist / 2, -12);
        teleport(sim, b.id, startDist / 2, -12);
        sim.events.length = 0;
        let killTick = -1;
        for (let t = 0; t < CAP_S * 60 && killTick < 0; t++) {
          sim.step();
          const deaths = drainDeaths(sim);
          if (deaths.length > 0) {
            killTick = t;
            for (const d of deaths) {
              if (d.killer === d.victim) suicides++; else frags++;
            }
          }
        }
        if (killTick >= 0) ttks.push(killTick / 60); else timeouts++;
      }
      const mean = ttks.length ? (ttks.reduce((s, x) => s + x, 0) / ttks.length).toFixed(1) : 'n/a';
      lines.push(
        `  d=${String(startDist).padStart(2)}: kills=${ttks.length}/${TRIALS} meanTTK=${mean}s ` +
        `timeouts=${timeouts} frags=${frags} suicides=${suicides}`,
      );
    }
    console.log('THUMPER DRILL-DOWN:\n' + lines.join('\n'));
    expect(lines.length).toBe(3);
  }, 600_000);

  it('3. match pacing — 8-bot TDM, kills/min over first 3 sim-minutes', async () => {
    const seeds = [11, 22, 33];
    const lines: string[] = [];
    const rates: number[] = [];

    for (const seed of seeds) {
      const sim = await makeSim({ mode: 'tdm', seed }); // default limits
      for (let i = 0; i < 8; i++) {
        sim.addPlayer(`B${i}`, ALL_CLASS_IDS[i % 5], (i % 2) as 0 | 1, true);
      }
      const perMin = [0, 0, 0];
      let credited = 0;
      let ticks = 0;
      const byGun = new Map<string, number>();
      const maxTicks = 3 * 60 * 60;
      while (!sim.mode.ended && ticks < maxTicks) {
        sim.step();
        const deaths = drainDeaths(sim);
        const minute = Math.min(2, Math.floor(ticks / 3600));
        for (const d of deaths) {
          perMin[minute]++;
          byGun.set(d.gun, (byGun.get(d.gun) ?? 0) + 1);
          if (d.killer >= 0 && d.killer !== d.victim) credited++;
        }
        ticks++;
      }
      lines.push(`    kills by gun: ${[...byGun.entries()].sort((x, y) => y[1] - x[1]).map(([g, n]) => `${g}:${n}`).join(' ')}`);
      const minutes = ticks / 3600;
      const total = perMin[0] + perMin[1] + perMin[2];
      const rate = total / minutes;
      rates.push(rate);
      lines.push(
        `  seed ${seed}: deaths/min by minute = [${perMin.join(', ')}], total=${total} in ${minutes.toFixed(1)}min ` +
        `=> ${rate.toFixed(1)} deaths/min (${(credited / minutes).toFixed(1)} credited kills/min)`,
      );
    }
    const avg = rates.reduce((s, x) => s + x, 0) / rates.length;
    lines.push(`  AVG = ${avg.toFixed(1)} deaths/min (healthy band ~4-12)`);
    console.log('MATCH PACING (8-bot TDM 4v4, default limits):\n' + lines.join('\n'));
    expect(rates.length).toBe(3);
  }, 600_000);
});
