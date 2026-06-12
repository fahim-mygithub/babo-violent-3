import { describe, expect, it } from 'vitest';
import { C } from '../src/data/constants';
import { GUNS, type GunId } from '../src/data/weapons';
import type { EquipKind } from '../src/data/equipment';
import type { GameSim } from '../src/sim/sim';
import { BTN, clearEvents, input, makeSim, run, runUntil, teleport } from './helpers';

// Grinder map node positions (see src/data/maps.ts)
const FRAG_NODE = { idx: 0, x: -16, y: 0 };
const MOLOTOV_NODE = { idx: 2, x: 0, y: -18 };
const SMOKE_NODE = { idx: 3, x: 0, y: 18 };
const HEALTH_W = { idx: 0, x: -26, y: 0 };
const HEALTH_E = { idx: 1, x: 26, y: 0 };

/** Sim with one live, manually-respawned player (modeSystem-independent). */
async function setup() {
  const sim = await makeSim();
  const p = sim.addPlayer('P', 'spider', 0, false);
  sim.respawn(p);
  p.respawnT = 0;
  return { sim, p };
}

function nodePickup(sim: GameSim, nodeKind: 'equip' | 'health', idx: number) {
  return sim.pickups.find((pk) => pk.nodeKind === nodeKind && pk.nodeIdx === idx);
}

function pushGunDrop(sim: GameSim, gun: GunId, x: number, y: number, ttl = C.CORPSE_DROP_TTL): void {
  sim.pickups.push({ id: sim.newId(), kind: 'gun', gun, x, y, nodeIdx: -1, ttl });
}

function pushEquipDrop(sim: GameSim, equip: EquipKind, x: number, y: number): void {
  sim.pickups.push({ id: sim.newId(), kind: 'equip', equip, x, y, nodeIdx: -1, ttl: C.CORPSE_DROP_TTL });
}

describe('pickup system', () => {
  it('damaged player auto-takes health: +HEAL, capped at MAX_HP, pack consumed', async () => {
    const { sim, p } = await setup();
    p.hp = 30;
    teleport(sim, p.id, HEALTH_W.x, HEALTH_W.y);
    run(sim, 1);
    expect(p.hp).toBe(30 + C.HEALTH_PACK_HEAL); // 90
    expect(nodePickup(sim, 'health', HEALTH_W.idx)).toBeUndefined();
    expect(sim.events.some((e) => e.t === 'pickup' && e.player === p.id && e.kind === 'health')).toBe(true);

    // Second pack caps the heal at MAX_HP
    teleport(sim, p.id, HEALTH_E.x, HEALTH_E.y);
    run(sim, 1);
    expect(p.hp).toBe(C.MAX_HP);
    expect(nodePickup(sim, 'health', HEALTH_E.idx)).toBeUndefined();
  });

  it('full-HP player does not consume health packs', async () => {
    const { sim, p } = await setup();
    p.hp = C.MAX_HP;
    teleport(sim, p.id, HEALTH_W.x, HEALTH_W.y);
    clearEvents(sim);
    run(sim, 30);
    expect(p.hp).toBe(C.MAX_HP);
    expect(nodePickup(sim, 'health', HEALTH_W.idx)).toBeDefined();
    expect(sim.events.some((e) => e.t === 'pickup' && e.kind === 'health')).toBe(false);
  });

  it('frag node grants a grenade and respawns ~EQUIPMENT_RESPAWN later', async () => {
    const { sim, p } = await setup();
    p.grenades = 0;
    teleport(sim, p.id, FRAG_NODE.x, FRAG_NODE.y);
    run(sim, 1);
    expect(p.grenades).toBe(1);
    expect(nodePickup(sim, 'equip', FRAG_NODE.idx)).toBeUndefined();
    expect(sim.events.some((e) => e.t === 'pickup' && e.kind === 'equip' && e.equip === 'frag')).toBe(true);

    // Step off so the respawned node is not instantly re-taken
    teleport(sim, p.id, 26, 26);
    const ticks = runUntil(sim, () => nodePickup(sim, 'equip', FRAG_NODE.idx) !== undefined, 2000);
    const expected = C.EQUIPMENT_RESPAWN * C.SIM_HZ;
    expect(ticks).toBeGreaterThanOrEqual(expected - 5);
    expect(ticks).toBeLessThanOrEqual(expected + 5);
    const node = nodePickup(sim, 'equip', FRAG_NODE.idx)!;
    expect(node.equip).toBe('frag');
    expect(node.x).toBe(FRAG_NODE.x);
    expect(node.ttl).toBe(Infinity);
  });

  it('respects the grenade cap (node left on the ground)', async () => {
    const { sim, p } = await setup();
    p.grenades = C.GRENADE_CAP;
    teleport(sim, p.id, FRAG_NODE.x, FRAG_NODE.y);
    run(sim, 30);
    expect(p.grenades).toBe(C.GRENADE_CAP);
    expect(nodePickup(sim, 'equip', FRAG_NODE.idx)).toBeDefined();
  });

  it('molotov/smoke: equips, never silently swaps kinds, stacks to EQUIP_CAP', async () => {
    const { sim, p } = await setup();
    teleport(sim, p.id, MOLOTOV_NODE.x, MOLOTOV_NODE.y);
    run(sim, 1);
    expect(p.equip).toBe('molotov');
    expect(p.equipCount).toBe(1);
    expect(nodePickup(sim, 'equip', MOLOTOV_NODE.idx)).toBeUndefined();

    // Different kind while holding one: left on the pad (no accidental loss)
    teleport(sim, p.id, SMOKE_NODE.x, SMOKE_NODE.y);
    run(sim, 1);
    expect(p.equip).toBe('molotov');
    expect(p.equipCount).toBe(1);
    expect(nodePickup(sim, 'equip', SMOKE_NODE.idx)).toBeDefined();

    // Same kind stacks up to EQUIP_CAP, then leaves extras on the ground
    pushEquipDrop(sim, 'molotov', p.x, p.y);
    run(sim, 1);
    expect(p.equipCount).toBe(C.EQUIP_CAP);
    pushEquipDrop(sim, 'molotov', p.x, p.y);
    run(sim, 1);
    expect(p.equipCount).toBe(C.EQUIP_CAP);
    expect(sim.pickups.some((pk) => pk.kind === 'equip' && pk.equip === 'molotov' && pk.nodeIdx === -1)).toBe(true);

    // Once empty, a different kind can be taken (clear leftover ground drops
    // first — they sit at the player's feet and would be taken before the pad)
    for (let i = sim.pickups.length - 1; i >= 0; i--) {
      if (sim.pickups[i].nodeIdx === -1) sim.pickups.splice(i, 1);
    }
    p.equipCount = 0;
    p.equip = null;
    run(sim, 1);
    expect(p.equip).toBe('smoke');
    expect(p.equipCount).toBe(1);
  });

  it('gun swap on PICKUP press edge: drops old gun at player, equips new with full mag', async () => {
    const { sim, p } = await setup();
    p.mag = 3; // partially spent stinger
    pushGunDrop(sim, 'thumper', 0, 5);
    teleport(sim, p.id, 0, 5);
    clearEvents(sim);
    sim.setInput(p.id, input({ buttons: BTN.PICKUP }));
    run(sim, 1);

    expect(p.gun).toBe('thumper');
    expect(p.mag).toBe(GUNS.thumper.magSize);
    expect(p.heat).toBe(0);
    expect(p.reloadT).toBe(0);
    expect(sim.pickups.some((pk) => pk.kind === 'gun' && pk.gun === 'thumper')).toBe(false);
    const drop = sim.pickups.find((pk) => pk.kind === 'gun' && pk.gun === 'stinger');
    expect(drop).toBeDefined();
    expect(Math.hypot(drop!.x - p.x, drop!.y - p.y)).toBeLessThan(0.5);
    expect(sim.events.some((e) => e.t === 'gunDrop' && e.gun === 'stinger')).toBe(true);
    expect(sim.events.some((e) => e.t === 'pickup' && e.kind === 'gun' && e.gun === 'thumper')).toBe(true);

    // Holding the button is not a new edge — no swap-back
    run(sim, 10);
    expect(p.gun).toBe('thumper');

    // Release, press again: swaps back to the dropped stinger (full mag)
    sim.setInput(p.id, input({}));
    run(sim, 1);
    sim.setInput(p.id, input({ buttons: BTN.PICKUP }));
    run(sim, 1);
    expect(p.gun).toBe('stinger');
    expect(p.mag).toBe(GUNS.stinger.magSize);
  });

  it('walking over a gun without pressing PICKUP does nothing', async () => {
    const { sim, p } = await setup();
    pushGunDrop(sim, 'maw', 0, 5);
    teleport(sim, p.id, 0, 5);
    run(sim, 30);
    expect(p.gun).toBe('stinger');
    expect(sim.pickups.some((pk) => pk.kind === 'gun' && pk.gun === 'maw')).toBe(true);
  });

  it('finite drops expire, nodes persist, dead players take nothing', async () => {
    const sim = await makeSim();
    const dead = sim.addPlayer('D', 'spider', 0, false); // never respawned
    dead.respawnT = 9999;
    dead.hp = 50;
    pushEquipDrop(sim, 'frag', dead.x, dead.y); // sits on the dead player
    sim.pickups.push({ id: sim.newId(), kind: 'health', x: 10, y: 10, nodeIdx: -1, ttl: 0.05 });

    const nodeCount = sim.pickups.filter((pk) => pk.nodeIdx >= 0).length;
    run(sim, 10);
    expect(sim.pickups.some((pk) => pk.kind === 'health' && pk.nodeIdx === -1)).toBe(false); // expired
    expect(sim.pickups.some((pk) => pk.kind === 'equip' && pk.nodeIdx === -1)).toBe(true);   // not taken
    expect(dead.hp).toBe(50);
    const nodes = sim.pickups.filter((pk) => pk.nodeIdx >= 0);
    expect(nodes.length).toBe(nodeCount);
    expect(nodes.every((pk) => pk.ttl === Infinity)).toBe(true);
  });
});
