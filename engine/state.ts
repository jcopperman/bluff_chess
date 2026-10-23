// Game creation, shared helpers and end-of-turn evaluation.

import { generateMoves, inCheck, opponent, sqToIdx, idxToSq, CLAIMABLE } from './moves.ts';
import { getApparentBoard, positionKey } from './view.ts';
import type { Rng } from './rng.ts';
import type {
  Arrangement, ClaimType, Color, Config, GameConfig, GameEvent, GameState, Move, MoveAction, Piece, ResultReason, Square,
} from './types.ts';

export const COLORS: readonly Color[] = ['white', 'black'];
/** Files of the seven secretly arranged back-rank squares, in order. */
export const BACK_FILES = ['a', 'b', 'c', 'd', 'f', 'g', 'h'] as const;
export const CLASSIC_ARRANGEMENT: readonly ClaimType[] = ['rook', 'knight', 'bishop', 'queen', 'bishop', 'knight', 'rook'];
export const PIECE_COUNTS: Readonly<Record<ClaimType, number>> = { rook: 2, knight: 2, bishop: 2, queen: 1 };

export const DEFAULT_CONFIG: Readonly<Config> = {
  startingChips: 6,
  claimLocking: true,
  chipsOutLoss: false,
  liarPaysChip: false,
  showdownsPerMate: 0,
  repetition: true,
  fiftyMove: true,
};

/** Throw if a value the rules guarantee is missing; narrows the type. */
export function must<T>(value: T | null | undefined, what: string): T {
  if (value == null) throw new Error(`Missing ${what}`);
  return value;
}

export function isValidArrangement(arr: unknown): arr is Arrangement {
  if (!Array.isArray(arr) || arr.length !== 7) return false;
  const counts: Record<string, number> = { rook: 0, knight: 0, bishop: 0, queen: 0 };
  for (const t of arr) {
    if (typeof t !== 'string' || !(t in counts)) return false;
    counts[t]++;
  }
  return CLAIMABLE.every((t) => counts[t] === PIECE_COUNTS[t]);
}

export function randomArrangement(rng: Rng): Arrangement {
  return rng.shuffle(CLASSIC_ARRANGEMENT);
}

function newPiece(id: string, owner: Color, type: Piece['type'], square: Square, faceUp: boolean): Piece {
  return { id, owner, type, square, faceUp, claim: null, hasMoved: false, captured: false, promoted: false, removed: false };
}

function standardPieces(): Piece[] {
  const pieces: Piece[] = [];
  for (const color of COLORS) {
    const c = color[0];
    const back = color === 'white' ? '1' : '8';
    const pawnRank = color === 'white' ? '2' : '7';
    pieces.push(newPiece(`${c}-k`, color, 'king', 'e' + back, true));
    for (const f of BACK_FILES) pieces.push(newPiece(`${c}-${f}${back}`, color, null, f + back, false));
    for (const f of 'abcdefgh') pieces.push(newPiece(`${c}-p${f}`, color, 'pawn', f + pawnRank, true));
  }
  return pieces;
}

export function placeArrangement(state: GameState, player: Color, arrangement: Arrangement): void {
  const back = player === 'white' ? '1' : '8';
  BACK_FILES.forEach((f, i) => {
    must(state.pieces.find((x) => x.id === `${player[0]}-${f}${back}`), 'back-rank piece').type = arrangement[i];
  });
  state.setupDone[player] = true;
}

export function createGame(config: GameConfig = {}): GameState {
  const cfg: Config = { ...DEFAULT_CONFIG };
  for (const k of Object.keys(DEFAULT_CONFIG) as (keyof Config)[]) {
    if (config[k] !== undefined) (cfg as unknown as Record<string, unknown>)[k] = config[k];
  }

  const state: GameState = {
    turn: config.turn || 'white',
    phase: 'setup',
    pieces: [],
    chips: { white: cfg.startingChips, black: cfg.startingChips, ...(config.chips || {}) },
    pending: null,
    ep: config.ep || null,
    halfmove: 0,
    fullmove: 1,
    positions: {},
    claims: [],
    showdowns: [],
    history: [],
    setupDone: { white: false, black: false },
    mateShowdowns: 0,
    result: null,
    revealed: false,
    config: cfg,
  };

  if (config.pieces) {
    state.pieces = config.pieces.map((p) => ({
      claim: null, hasMoved: false, captured: false, promoted: false, removed: false,
      faceUp: p.type === 'king' || p.type === 'pawn',
      ...p,
    }));
    state.setupDone = { white: true, black: true };
    updateStatus(state, []);
    return state;
  }

  state.pieces = standardPieces();
  const setups = config.setups || {};
  for (const color of COLORS) {
    const arrangement = setups[color];
    if (arrangement) {
      if (!isValidArrangement(arrangement)) throw new Error(`Invalid arrangement for ${color}`);
      placeArrangement(state, color, arrangement);
    }
  }
  if (state.setupDone.white && state.setupDone.black) updateStatus(state, []);
  return state;
}

export function pieceById(state: GameState, id: string): Piece {
  return must(state.pieces.find((p) => p.id === id), `piece ${id}`);
}

export function pieceAt(state: GameState, sq: Square): Piece | undefined {
  return state.pieces.find((p) => !p.captured && p.square === sq);
}

/** Internal legal moves for `player` on the apparent board. */
export function legalMoves(state: GameState, player: Color): Move[] {
  const board = getApparentBoard(state);
  const ep = state.ep ? sqToIdx(state.ep) : -1;
  return generateMoves(board, player, ep, { claimLocking: state.config.claimLocking });
}

/** Convert an internal move to a public action. */
export function moveToAction(m: Move, player: Color): MoveAction {
  const a: MoveAction = { type: 'move', player, from: idxToSq(m.from), to: idxToSq(m.to) };
  if (m.claim) a.claim = m.claim;
  if (m.promo) a.promotion = m.promo;
  return a;
}

/** Opponent face-down pieces that have a claim. */
export function showdownTargets(state: GameState, player: Color): Piece[] {
  const opp = opponent(player);
  return state.pieces.filter((p) => p.owner === opp && !p.faceUp && p.claim && !p.captured);
}

export function canShowdown(state: GameState, player: Color): boolean {
  const cfg = state.config;
  if (state.chips[player] <= 0) return false;
  if (cfg.showdownsPerMate > 0 && state.mateShowdowns >= cfg.showdownsPerMate) return false;
  return showdownTargets(state, player).length > 0;
}

export function gameOver(state: GameState, winner: Color | null, reason: ResultReason, events: GameEvent[]): void {
  state.phase = 'over';
  state.pending = null;
  state.result = { winner, reason };
  state.revealed = true;
  events.push({ type: 'gameOver', winner, reason });
}

function chipsOutCheck(state: GameState, events: GameEvent[]): boolean {
  if (!state.config.chipsOutLoss) return false;
  for (const c of COLORS) {
    if (state.chips[c] <= 0) {
      gameOver(state, opponent(c), 'chips', events);
      return true;
    }
  }
  return false;
}

/**
 * Called whenever play passes to `state.turn` (or after a showdown).
 * Decides between normal play, a showdown, or the end of the game.
 */
export function updateStatus(state: GameState, events: GameEvent[], { afterShowdown = false } = {}): void {
  state.phase = 'move';
  if (chipsOutCheck(state, events)) return;

  const board = getApparentBoard(state);
  const player = state.turn;
  const check = inCheck(board, player);
  const hasMoves = legalMoves(state, player).length > 0;
  if (check) events.push({ type: 'check', player });

  if (!hasMoves) {
    if (check) {
      if (!afterShowdown) state.mateShowdowns = 0;
      if (canShowdown(state, player)) {
        state.phase = 'showdown';
        events.push({ type: 'showdownAvailable', player });
      } else {
        gameOver(state, opponent(player), 'checkmate', events);
      }
    } else {
      gameOver(state, null, 'stalemate', events);
    }
    return;
  }
  if (afterShowdown) {
    events.push({ type: 'mateBroken', player });
    return;
  }

  if (state.config.repetition) {
    const key = positionKey(state);
    state.positions[key] = (state.positions[key] || 0) + 1;
    if (state.positions[key] >= 3) return gameOver(state, null, 'repetition', events);
  }
  if (state.config.fiftyMove && state.halfmove >= 100) gameOver(state, null, 'fiftyMove', events);
}
