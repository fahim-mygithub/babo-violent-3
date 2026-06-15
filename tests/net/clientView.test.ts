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
      gun: 'stinger', chosenGun: 'stinger', mag: 30, reloadT: 0, heat: 0, overheatT: 0,
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

  it('memoized read equals a fresh read for the same timestamp (caches, not approximates)', () => {
    const c = new ClientSession();
    feed(c, { t: 'start', settings: { mode: 'tdm', mapId: 'grinder', scoreLimit: 50, botCount: 0, seed: 42 }, yourId: 0 });
    now = 10_000; feed(c, { t: 'snap', snap: snap(0, 1, 1) });
    now = 10_050; feed(c, { t: 'snap', snap: snap(3, 2, 2) });
    now = 10_200;
    const cached = c.view; // populates + returns cache
    // A second, independent ClientSession fed the identical inputs, read fresh at
    // the same timestamp, must produce the SAME interpolated values.
    const fresh = new ClientSession();
    feed(fresh, { t: 'start', settings: { mode: 'tdm', mapId: 'grinder', scoreLimit: 50, botCount: 0, seed: 42 }, yourId: 0 });
    now = 10_000; feed(fresh, { t: 'snap', snap: snap(0, 1, 1) });
    now = 10_050; feed(fresh, { t: 'snap', snap: snap(3, 2, 2) });
    now = 10_200;
    const freshView = fresh.view;
    expect(JSON.parse(JSON.stringify(cached))).toEqual(JSON.parse(JSON.stringify(freshView)));
  });

  it('does not leak stale entities across frames when reusing containers', () => {
    const c = new ClientSession();
    feed(c, { t: 'start', settings: { mode: 'tdm', mapId: 'grinder', scoreLimit: 50, botCount: 0, seed: 42 }, yourId: 0 });
    // First snapshot has a 2-player roster.
    const two = snap(0, 1, 1);
    two.players.push({ ...two.players[0], id: 7, name: 'other', x: 3, y: 3 });
    now = 10_000; feed(c, { t: 'snap', snap: two });
    now = 10_200; const v1 = c.view!;
    expect([...v1.players].map((p) => p.id).sort()).toEqual([0, 7]);
    // Second snapshot drops player 7. The reused container must not retain it.
    now = 10_200; feed(c, { t: 'snap', snap: snap(3, 2, 2) });
    now = 10_300; const v2 = c.view!;
    expect([...v2.players].map((p) => p.id)).toEqual([0]);
  });

  it('an update() between two reads in the same ms bucket reflects the moved local position', () => {
    const c = new ClientSession();
    feed(c, { t: 'start', settings: { mode: 'tdm', mapId: 'grinder', scoreLimit: 50, botCount: 0, seed: 42 }, yourId: 0 });
    // Two snaps so prediction is valid AND rendered != pred (rendered snapped to
    // the FIRST valid snap; the second only moves pred), so update()'s lerp toward
    // pred actually moves the rendered local position.
    now = 10_000; feed(c, { t: 'snap', snap: snap(0, 4, 5) });
    now = 10_050; feed(c, { t: 'snap', snap: snap(3, 60, 70) });
    now = 10_200;
    const localX = (v: { players: Iterable<{ id: number; x: number }> }): number => {
      for (const p of v.players) if (p.id === 0) return p.x;
      throw new Error('no local player');
    };
    const before = localX(c.view!);
    c.update(0.016); // per-frame lerp toward prediction
    const after = localX(c.view!); // SAME ms bucket → must NOT be a stale cache hit
    expect(after).not.toBe(before);
    expect(after).toBeGreaterThan(before); // moved toward pred (60)
  });

  it('predictedSelf returns the predictor own-babo position without building a full view', () => {
    const c = new ClientSession();
    feed(c, { t: 'start', settings: { mode: 'tdm', mapId: 'grinder', scoreLimit: 50, botCount: 0, seed: 42 }, yourId: 0 });
    now = 10_000; feed(c, { t: 'snap', snap: snap(0, 4, 5) });
    const self = c.predictedSelf();
    expect(self).toMatchObject({ x: 4, y: 5 });
  });

  it('predictedSelf matches the own-babo position the full view reports for the local player', () => {
    const c = new ClientSession();
    feed(c, { t: 'start', settings: { mode: 'tdm', mapId: 'grinder', scoreLimit: 50, botCount: 0, seed: 42 }, yourId: 0 });
    now = 10_000; feed(c, { t: 'snap', snap: snap(0, 4, 5) });
    now = 10_050; feed(c, { t: 'snap', snap: snap(3, 6, 7) });
    now = 10_200;
    const self = c.predictedSelf()!;
    const view = c.view!;
    let me: { x: number; y: number } | undefined;
    for (const p of view.players) if (p.id === 0) me = p;
    expect(self.x).toBeCloseTo(me!.x, 6);
    expect(self.y).toBeCloseTo(me!.y, 6);
  });
});
