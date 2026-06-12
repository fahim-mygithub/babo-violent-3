import { describe, expect, it } from 'vitest';
import { HostSession } from '../src/net/host';
import { makeSim } from '../tests/helpers';
import { emptyInput } from '../src/sim/types';

/**
 * Repro: when a peer disconnects mid-match, the host claims (per the dropPeer
 * comment) that "the babo idles (zeroed input) rather than vanishing." We show
 * the sim player KEEPS its last input forever instead.
 */
describe('host disconnect handling', () => {
  it('does NOT idle a disconnected player; babo keeps last input', async () => {
    const sim = await makeSim();
    const p = sim.addPlayer('victim', 'spider', 0, false);
    sim.respawn(p); p.respawnT = 0; p.invulnT = 0;

    // Build a HostSession without PeerJS (constructor is private at compile time only).
    const settings = { mode: 'tdm', mapId: 'grinder', scoreLimit: 50, botCount: 0, seed: 1 };
    const host = new (HostSession as unknown as new (s: typeof settings) => HostSession)(settings);
    (host as unknown as { started: boolean }).started = true;
    (host as unknown as { players: unknown[] }).players = [];

    const fakeConn = { open: true, peer: 'PEER', send: () => {}, close: () => {} };
    const entry = {
      conn: fakeConn,
      lobby: { peerId: 'PEER', name: 'victim', classId: 'spider', isHost: false, bot: false },
      playerId: p.id,
      freshest: { ...emptyInput(), mx: 1, buttons: 1, seq: 10 }, // driving forward + firing
      applied: 9,
    };
    const peers = (host as unknown as { peers: Map<string, unknown> }).peers;
    peers.set('PEER', entry);

    // Normal flow: host applies the latest input into the sim.
    host.applyInputs(sim);
    expect(p.input.mx).toBe(1);
    expect(p.input.buttons).toBe(1);

    // Peer disconnects → dropPeer fires (what conn.on('close') calls).
    (host as unknown as { dropPeer: (id: string) => void }).dropPeer('PEER');

    // Subsequent ticks: host tries to keep applying inputs.
    for (let i = 0; i < 5; i++) host.applyInputs(sim);

    console.log('after disconnect: mx=%s buttons=%s (expected idle 0/0)', p.input.mx, p.input.buttons);
    // BUG: the babo never idles — it is still driving forward and firing.
    expect(p.input.mx).toBe(1);
    expect(p.input.buttons).toBe(1);
  });
});
