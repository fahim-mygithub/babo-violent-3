import type { ClassId } from '../data/classes';
import type { GunId } from '../data/weapons';
import type { GameEvent, ModeId, PlayerInput, Snapshot } from '../sim/types';

/** A player as seen in the lobby (host's authoritative list). */
export interface LobbyPlayer {
  peerId: string; // '' for the host themself and for bots
  name: string;
  classId: ClassId;
  gun: GunId;
  isHost: boolean;
  bot: boolean;
}

export interface MatchSettings {
  mode: ModeId;
  mapId: string;
  scoreLimit: number;
  botCount: number;
  seed: number;
}

/** Client → host messages. */
export type ClientMsg =
  | { t: 'hello'; name: string; classId: ClassId; gun: GunId }
  | { t: 'loadout'; name: string; classId: ClassId; gun: GunId }
  /** Redundant input window: the last ≤3 sampled inputs, newest last. */
  | { t: 'input'; inputs: PlayerInput[] };

/** Host → client messages. */
export type HostMsg =
  | { t: 'lobby'; players: LobbyPlayer[]; settings: MatchSettings }
  | { t: 'start'; settings: MatchSettings; yourId: number }
  | { t: 'snap'; snap: Snapshot }
  | { t: 'events'; events: GameEvent[]; tick: number }
  | { t: 'end'; winner: number }
  | { t: 'reject'; reason: string };

export const MAX_PLAYERS = 8;
export const PEER_ID_PREFIX = 'bv3-';

/**
 * Clamp a name (local or peer-supplied) to a safe, non-empty 18-char label.
 * Shared by the host and the local app so both sides agree on the exact string
 * (the client matches its own lobby row by the host-echoed name).
 */
export function sanitizeName(name: string): string {
  return String(name).trim().slice(0, 18) || 'Babo';
}

/** Short human join code → full PeerJS id. */
export function codeToPeerId(code: string): string {
  return PEER_ID_PREFIX + code.toLowerCase();
}

export function makeJoinCode(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/O/1/l/i ambiguity
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}
