import Peer from 'peerjs';
import type { DataConnection } from 'peerjs';
import { clamp, closestOnAABB, lerp } from '../core/math';
import { angleDiff } from '../core/math';
import { C } from '../data/constants';
import { CLASSES, type ClassId } from '../data/classes';
import { type GunId } from '../data/weapons';
import { MAPS, type MapDef } from '../data/maps';
import type { WorldView } from '../render/renderer';
import type { GameEvent, PlayerInput, PlayerState, Snapshot } from '../sim/types';
import { codeToPeerId, type ClientMsg, type HostMsg, type LobbyPlayer, type MatchSettings } from './types';

interface StampedSnap {
  snap: Snapshot;
  at: number; // performance.now() arrival
}

const DT = 1 / C.SIM_HZ;

/**
 * Client side: connects to a host by join code, mirrors the lobby, and during
 * the match turns host snapshots into a smooth WorldView — interpolation for
 * remote entities (~INTERP_BUFFER_MS behind), prediction for the own babo.
 */
export class ClientSession {
  players: LobbyPlayer[] = [];
  settings: MatchSettings | null = null;
  myId = -1;

  onLobby: () => void = () => {};
  onStart: (settings: MatchSettings, yourId: number) => void = () => {};
  onEnd: (winner: number) => void = () => {};
  onClosed: (reason: string) => void = () => {};

  private peer: Peer | null = null;
  private conn: DataConnection | null = null;
  private classId: ClassId = 'spider';
  private snaps: StampedSnap[] = [];
  private eventQueue: GameEvent[] = [];
  private endWinner: number | null = null;
  private disposed = false;

  // Prediction
  private map: MapDef | null = null;
  private pending: PlayerInput[] = [];
  private pred = { x: 0, y: 0, vx: 0, vy: 0, valid: false };
  private rendered = { x: 0, y: 0 };

  static join(code: string, name: string, classId: ClassId, gun: GunId): Promise<ClientSession> {
    const s = new ClientSession();
    s.classId = classId;
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        s.dispose();
        reject(err);
      };
      const timeout = setTimeout(() => fail(new Error('timed out — check the code')), 6000);

      const peer = new Peer();
      s.peer = peer;
      peer.on('error', (err) => {
        const type = (err as { type?: string }).type;
        if (type === 'peer-unavailable') fail(new Error('no lobby with that code'));
        else if (!settled) fail(new Error(type ?? err.message));
        else s.close(type ?? err.message);
      });
      peer.on('open', () => {
        const conn = peer.connect(codeToPeerId(code.trim()), { reliable: true, serialization: 'json' });
        s.conn = conn;
        conn.on('open', () => s.send({ t: 'hello', name, classId, gun }));
        conn.on('data', (raw) => {
          try {
            const msg = raw as HostMsg;
            if (msg.t === 'reject') {
              fail(new Error(msg.reason));
              return;
            }
            s.onMsg(msg);
            if (msg.t === 'lobby' && !settled) {
              settled = true;
              clearTimeout(timeout);
              resolve(s);
            }
          } catch (err) {
            console.warn('[bv3-client] bad message', err);
          }
        });
        conn.on('close', () => {
          if (!settled) fail(new Error('connection closed'));
          else s.close('hostLeft');
        });
        conn.on('error', () => {
          if (!settled) fail(new Error('connection failed'));
          else s.close('hostLeft');
        });
      });
    });
  }

  private close(reason: string): void {
    if (this.disposed) return;
    this.disposed = true;
    this.onClosed(reason);
  }

  private send(msg: ClientMsg): void {
    if (this.conn?.open) this.conn.send(msg);
  }

  private onMsg(msg: HostMsg): void {
    switch (msg.t) {
      case 'lobby':
        this.players = msg.players;
        this.settings = msg.settings;
        this.onLobby();
        break;
      case 'start':
        this.settings = msg.settings;
        this.myId = msg.yourId;
        this.map = MAPS[msg.settings.mapId] ?? MAPS.grinder;
        this.snaps.length = 0;
        this.pending.length = 0;
        this.pred.valid = false;
        this.endWinner = null;
        this.onStart(msg.settings, msg.yourId);
        break;
      case 'snap':
        this.snaps.push({ snap: msg.snap, at: performance.now() });
        if (this.snaps.length > 12) this.snaps.shift();
        this.reconcile(msg.snap);
        break;
      case 'events':
        this.eventQueue.push(...msg.events);
        break;
      case 'end':
        this.endWinner = msg.winner;
        this.onEnd(msg.winner);
        break;
      case 'reject':
        break; // handled during join
    }
  }

  setLoadout(classId: ClassId, gun: GunId): void {
    this.classId = classId;
    this.send({ t: 'loadout', classId, gun });
  }

  // -------------------------------------------------------------------------
  // Prediction
  // -------------------------------------------------------------------------

  private ownClass(): ClassId {
    const newest = this.snaps[this.snaps.length - 1];
    const me = newest?.snap.players.find((p) => p.id === this.myId);
    return me?.classId ?? this.classId;
  }

  /** One movement tick with the same constants as the host's movement system. */
  private integrate(input: PlayerInput): void {
    const cls = CLASSES[this.ownClass()];
    const p = this.pred;
    let mx = input.mx;
    let my = input.my;
    const il = Math.hypot(mx, my);
    if (il > 1) { mx /= il; my /= il; }
    p.vx += ((mx * cls.moveForce) / cls.mass) * DT;
    p.vy += ((my * cls.moveForce) / cls.mass) * DT;
    // Mirror the host's damping modifiers (slick blood / fortify) from the
    // latest snapshot — skipping them causes visible rubber-banding in pools.
    const newest = this.snaps[this.snaps.length - 1];
    const meSnap = newest?.snap.players.find((q) => q.id === this.myId);
    const dampMult = (meSnap?.inSlick ? C.SLICK_DAMPING_MULT : 1) * (meSnap?.fortifyActive ? 2 : 1);
    const damp = 1 / (1 + cls.linearDamping * dampMult * DT);
    p.vx *= damp;
    p.vy *= damp;
    const speed = Math.hypot(p.vx, p.vy);
    if (speed > cls.maxSpeed) {
      const brake = (speed - cls.maxSpeed) * 4 * DT; // accel = (v-max)*4
      p.vx -= (p.vx / speed) * brake;
      p.vy -= (p.vy / speed) * brake;
    }
    p.x += p.vx * DT;
    p.y += p.vy * DT;
    // Circle-vs-wall pushout
    if (this.map) {
      for (const w of this.map.walls) {
        const [cx, cy] = closestOnAABB(p.x, p.y, w.x, w.y, w.w, w.h);
        const dx = p.x - cx;
        const dy = p.y - cy;
        const d = Math.hypot(dx, dy);
        if (d >= C.BABO_RADIUS || d < 1e-6) continue;
        const nx = dx / d;
        const ny = dy / d;
        const push = C.BABO_RADIUS - d;
        p.x += nx * push;
        p.y += ny * push;
        const vn = p.vx * nx + p.vy * ny;
        if (vn < 0) {
          p.vx -= vn * nx;
          p.vy -= vn * ny;
        }
      }
    }
  }

  /** Server state arrived: rewind to it and replay unacked inputs. */
  private reconcile(snap: Snapshot): void {
    const me = snap.players.find((p) => p.id === this.myId);
    if (!me) return;
    this.pending = this.pending.filter((i) => i.seq > me.lastAckSeq);
    const wasValid = this.pred.valid;
    this.pred.x = me.x;
    this.pred.y = me.y;
    this.pred.vx = me.vx;
    this.pred.vy = me.vy;
    this.pred.valid = me.alive;
    for (const input of this.pending) this.integrate(input);
    if (!wasValid && this.pred.valid) {
      this.rendered.x = this.pred.x;
      this.rendered.y = this.pred.y;
    }
  }

  /** Sample + send the local input each tick; also feeds prediction. */
  sendInput(input: PlayerInput): void {
    this.pending.push(input);
    if (this.pending.length > 120) this.pending.shift();
    if (this.pred.valid) this.integrate(input);
    const window = this.pending.slice(-3);
    this.send({ t: 'input', inputs: window });
  }

  /** Advance render smoothing. Call once per render frame. */
  update(dt: number): void {
    if (this.pred.valid) {
      const k = Math.min(1, 12 * dt);
      this.rendered.x += (this.pred.x - this.rendered.x) * k;
      this.rendered.y += (this.pred.y - this.rendered.y) * k;
    }
  }

  // -------------------------------------------------------------------------
  // Interpolated view
  // -------------------------------------------------------------------------

  get view(): WorldView | null {
    if (this.snaps.length === 0) return null;
    const newest = this.snaps[this.snaps.length - 1];
    const target = performance.now() - C.INTERP_BUFFER_MS;
    let a = this.snaps[0];
    let b = newest;
    for (let i = this.snaps.length - 1; i >= 0; i--) {
      if (this.snaps[i].at <= target) {
        a = this.snaps[i];
        b = this.snaps[Math.min(i + 1, this.snaps.length - 1)];
        break;
      }
    }
    const span = Math.max(1, b.at - a.at);
    const t = a === b ? 1 : clamp((target - a.at) / span, 0, 1);

    const olderPlayers = new Map(a.snap.players.map((p) => [p.id, p]));
    const players: PlayerState[] = b.snap.players.map((pb) => {
      const pa = olderPlayers.get(pb.id);
      const p: PlayerState = { ...pb };
      if (pa && pa.alive && pb.alive) {
        p.x = lerp(pa.x, pb.x, t);
        p.y = lerp(pa.y, pb.y, t);
        p.vx = lerp(pa.vx, pb.vx, t);
        p.vy = lerp(pa.vy, pb.vy, t);
        p.aim = pa.aim + angleDiff(pa.aim, pb.aim) * t;
      }
      if (pb.id === this.myId && this.pred.valid && pb.alive) {
        p.x = this.rendered.x;
        p.y = this.rendered.y;
        p.vx = this.pred.vx;
        p.vy = this.pred.vy;
        p.aim = this.pending.length > 0 ? this.pending[this.pending.length - 1].aim : pb.aim;
        p.input = this.pending.length > 0 ? this.pending[this.pending.length - 1] : pb.input;
      }
      return p;
    });

    const olderProj = new Map(a.snap.projectiles.map((e) => [e.id, e]));
    const projectiles = b.snap.projectiles.map((eb) => {
      const ea = olderProj.get(eb.id);
      return ea ? { ...eb, x: lerp(ea.x, eb.x, t), y: lerp(ea.y, eb.y, t) } : { ...eb };
    });
    const olderGren = new Map(a.snap.grenades.map((e) => [e.id, e]));
    const grenades = b.snap.grenades.map((eb) => {
      const ea = olderGren.get(eb.id);
      return ea
        ? { ...eb, x: lerp(ea.x, eb.x, t), y: lerp(ea.y, eb.y, t), z: lerp(ea.z, eb.z, t) }
        : { ...eb };
    });

    const mode = { ...b.snap.mode };
    if (this.endWinner !== null) {
      mode.ended = true;
      mode.winner = this.endWinner;
    }

    return {
      players,
      projectiles,
      grenades,
      pools: b.snap.pools,
      fires: b.snap.fires,
      smokes: b.snap.smokes,
      pickups: b.snap.pickups,
      mode,
    };
  }

  drainEvents(): GameEvent[] {
    return this.eventQueue.splice(0);
  }

  dispose(): void {
    this.disposed = true;
    this.conn?.close();
    this.peer?.destroy();
    this.peer = null;
    this.conn = null;
  }
}
