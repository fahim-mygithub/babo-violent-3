import Peer from 'peerjs';
import type { DataConnection } from 'peerjs';
import { ALL_CLASS_IDS, type ClassId } from '../data/classes';
import { ALL_GUN_IDS, STARTER_GUN, type GunId } from '../data/weapons';
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
  /** Players whose peer dropped mid-match — their input gets zeroed once. */
  private droppedPlayers: number[] = [];

  private constructor(settings: MatchSettings) {
    this.settings = settings;
  }

  static create(name: string, classId: ClassId, gun: GunId, settings: MatchSettings): Promise<HostSession> {
    const session = new HostSession(settings);
    session.players = [{ peerId: '', name, classId, gun, isHost: true, bot: false }];
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
          classId: sanitizeClass(msg.classId),
          gun: sanitizeGun(msg.gun),
          isHost: false,
          bot: false,
        };
        this.players.push(entry.lobby);
        this.broadcastLobby();
        break;
      }
      case 'loadout':
        if (entry.lobby) {
          entry.lobby.classId = sanitizeClass(msg.classId);
          entry.lobby.gun = sanitizeGun(msg.gun);
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
    // Mid-match: the babo idles — queue a one-time input zero for applyInputs
    // (the sim otherwise keeps replaying the last received input forever).
    if (entry.playerId >= 0) this.droppedPlayers.push(entry.playerId);
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

  setLocalLoadout(classId: ClassId, gun: GunId): void {
    this.players[0].classId = classId;
    this.players[0].gun = gun;
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
    if (this.droppedPlayers.length > 0) {
      for (const id of this.droppedPlayers) sim.setInput(id, emptyInput());
      this.droppedPlayers.length = 0;
    }
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

/** Never trust peer-supplied ids — a bad classId would crash sim.addPlayer. */
function sanitizeClass(id: ClassId): ClassId {
  return ALL_CLASS_IDS.includes(id) ? id : 'spider';
}

function sanitizeGun(id: GunId): GunId {
  return ALL_GUN_IDS.includes(id) ? id : STARTER_GUN;
}
