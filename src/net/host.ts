import Peer from 'peerjs';
import type { DataConnection } from 'peerjs';
import type { ClassId } from '../data/classes';
import type { GameEvent, PlayerInput, Snapshot } from '../sim/types';
import { emptyInput } from '../sim/types';
import type { GameSim } from '../sim/sim';
import {
  MAX_PLAYERS, codeToPeerId, makeJoinCode,
  type ClientMsg, type HostMsg, type LobbyPlayer, type MatchSettings,
} from './types';

interface PeerEntry {
  conn: DataConnection;
  lobby: LobbyPlayer | null; // null until 'hello'
  playerId: number;          // sim player id, -1 until match start
  freshest: PlayerInput | null;
  applied: number;           // last applied seq
}

/**
 * Host side of the star topology. The host's browser runs the authoritative
 * GameSim; this class handles lobby membership, input ingestion and
 * snapshot/event broadcast. JSON serialization throughout (Infinity-safe via
 * snapshot sanitization).
 */
export class HostSession {
  code = '';
  players: LobbyPlayer[] = [];
  settings: MatchSettings;

  onLobby: () => void = () => {};
  onPeerLeft: (peerId: string) => void = () => {};
  onError: (msg: string) => void = () => {};

  private peer: Peer | null = null;
  private peers = new Map<string, PeerEntry>();
  private started = false;

  private constructor(settings: MatchSettings) {
    this.settings = settings;
  }

  static create(name: string, classId: ClassId, settings: MatchSettings): Promise<HostSession> {
    const session = new HostSession(settings);
    session.players = [{ peerId: '', name, classId, isHost: true, bot: false }];
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const tryOpen = (): void => {
        const code = makeJoinCode();
        const peer = new Peer(codeToPeerId(code));
        let settled = false;
        peer.on('open', () => {
          settled = true;
          session.peer = peer;
          session.code = code;
          session.wire(peer);
          resolve(session);
        });
        peer.on('error', (err) => {
          const type = (err as { type?: string }).type;
          if (!settled && type === 'unavailable-id' && attempts++ < 2) {
            peer.destroy();
            tryOpen();
          } else if (!settled) {
            peer.destroy();
            reject(new Error(type ?? err.message));
          } else {
            session.onError(type ?? err.message);
          }
        });
      };
      tryOpen();
    });
  }

  private wire(peer: Peer): void {
    peer.on('connection', (conn) => {
      const entry: PeerEntry = { conn, lobby: null, playerId: -1, freshest: null, applied: -1 };
      conn.on('data', (raw) => {
        try {
          this.onMsg(entry, raw as ClientMsg);
        } catch (err) {
          console.warn('[bv3-host] bad message', err);
        }
      });
      conn.on('close', () => this.dropPeer(conn.peer));
      conn.on('error', () => this.dropPeer(conn.peer));
      this.peers.set(conn.peer, entry);
    });
  }

  private onMsg(entry: PeerEntry, msg: ClientMsg): void {
    switch (msg.t) {
      case 'hello': {
        if (this.started || this.players.length >= MAX_PLAYERS) {
          this.send(entry.conn, { t: 'reject', reason: this.started ? 'match already started' : 'lobby is full' });
          setTimeout(() => entry.conn.close(), 250);
          return;
        }
        entry.lobby = {
          peerId: entry.conn.peer,
          name: String(msg.name).slice(0, 18) || 'Babo',
          classId: msg.classId,
          isHost: false,
          bot: false,
        };
        this.players.push(entry.lobby);
        this.broadcastLobby();
        break;
      }
      case 'class':
        if (entry.lobby) {
          entry.lobby.classId = msg.classId;
          this.broadcastLobby();
        }
        break;
      case 'input': {
        for (const input of msg.inputs) {
          if (!entry.freshest || input.seq > entry.freshest.seq) entry.freshest = input;
        }
        break;
      }
    }
  }

  private dropPeer(peerId: string): void {
    const entry = this.peers.get(peerId);
    if (!entry) return;
    this.peers.delete(peerId);
    if (entry.lobby) {
      this.players = this.players.filter((p) => p.peerId !== peerId);
      if (!this.started) this.broadcastLobby();
    }
    // Mid-match: the babo idles (zeroed input) rather than vanishing.
    entry.freshest = emptyInput();
    entry.playerId = -1;
    this.onPeerLeft(peerId);
  }

  private send(conn: DataConnection, msg: HostMsg): void {
    if (conn.open) conn.send(msg);
  }

  private broadcast(msg: HostMsg): void {
    for (const entry of this.peers.values()) {
      if (entry.lobby) this.send(entry.conn, msg);
    }
  }

  private broadcastLobby(): void {
    this.broadcast({ t: 'lobby', players: this.players, settings: this.settings });
    this.onLobby();
  }

  setLocalClass(classId: ClassId): void {
    this.players[0].classId = classId;
    this.broadcastLobby();
  }

  updateSettings(s: Partial<MatchSettings>): void {
    Object.assign(this.settings, s);
    this.broadcastLobby();
  }

  /** peerId → sim player id; broadcasts 'start'. */
  startMatch(assignments: Map<string, number>): void {
    this.started = true;
    for (const [peerId, playerId] of assignments) {
      const entry = this.peers.get(peerId);
      if (!entry) continue;
      entry.playerId = playerId;
      this.send(entry.conn, { t: 'start', settings: this.settings, yourId: playerId });
    }
  }

  /** Write freshest buffered inputs into the sim. Call before sim.step(). */
  applyInputs(sim: GameSim): void {
    for (const entry of this.peers.values()) {
      if (entry.playerId < 0 || !entry.freshest) continue;
      if (entry.freshest.seq <= entry.applied) continue;
      entry.applied = entry.freshest.seq;
      sim.setInput(entry.playerId, entry.freshest);
      const p = sim.players.get(entry.playerId);
      if (p) p.lastAckSeq = entry.freshest.seq;
    }
  }

  /** Broadcast events + periodic snapshot. Call after sim.step(). */
  afterStep(sim: GameSim, events: GameEvent[]): void {
    if (events.length > 0) this.broadcast({ t: 'events', events, tick: sim.tick });
    if (sim.tick % 3 === 0) this.broadcast({ t: 'snap', snap: sanitize(sim.snapshot()) });
  }

  sendEnd(winner: number): void {
    this.broadcast({ t: 'end', winner });
  }

  dispose(): void {
    for (const entry of this.peers.values()) entry.conn.close();
    this.peers.clear();
    this.peer?.destroy();
    this.peer = null;
  }
}

/** JSON turns Infinity into null — clamp non-finite ttls before sending. */
function sanitize(snap: Snapshot): Snapshot {
  for (const pk of snap.pickups) {
    if (!Number.isFinite(pk.ttl)) pk.ttl = 99999;
  }
  return snap;
}
