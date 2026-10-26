// Standard chess movement on a 64-cell board. Knows nothing about chips or
// calls: it works on whatever board it is given (usually the apparent board).
// See Cell and Board in types.ts.

import type { Board, Cell, ClaimType, Color, Move, PieceType, Square } from './types.ts';

export const CLAIMABLE: readonly ClaimType[] = ['rook', 'knight', 'bishop', 'queen'];
export const PROMOTIONS: readonly ClaimType[] = ['queen', 'rook', 'bishop', 'knight'];

type Dir = readonly [number, number];
const ROOK_D: readonly Dir[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISHOP_D: readonly Dir[] = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const QUEEN_D: readonly Dir[] = ROOK_D.concat(BISHOP_D);
const KNIGHT_D: readonly Dir[] = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];

export function sqToIdx(sq: Square): number {
  return (sq.charCodeAt(1) - 49) * 8 + (sq.charCodeAt(0) - 97);
}

export function idxToSq(i: number): Square {
  return 'abcdefgh'[i & 7] + ((i >> 3) + 1);
}

export function opponent(color: Color): Color {
  return color === 'white' ? 'black' : 'white';
}

function onBoard(f: number, r: number): boolean {
  return f >= 0 && f < 8 && r >= 0 && r < 8;
}

/** Is square `idx` attacked by `by` on this board? */
export function isAttacked(board: Board, idx: number, by: Color): boolean {
  const f = idx & 7, r = idx >> 3;
  const pr = by === 'white' ? r - 1 : r + 1;
  for (const df of [-1, 1]) {
    const ff = f + df;
    if (onBoard(ff, pr)) {
      const c = board[pr * 8 + ff];
      if (c && c.color === by && c.type === 'pawn') return true;
    }
  }
  for (const [df, dr] of KNIGHT_D) {
    const ff = f + df, rr = r + dr;
    if (!onBoard(ff, rr)) continue;
    const c = board[rr * 8 + ff];
    if (c && c.color === by && c.type === 'knight') return true;
  }
  for (const [df, dr] of QUEEN_D) {
    const ff = f + df, rr = r + dr;
    if (!onBoard(ff, rr)) continue;
    const c = board[rr * 8 + ff];
    if (c && c.color === by && c.type === 'king') return true;
  }
  const sliders: [readonly Dir[], PieceType[]][] = [[ROOK_D, ['rook', 'queen']], [BISHOP_D, ['bishop', 'queen']]];
  for (const [dirs, kinds] of sliders) {
    for (const [df, dr] of dirs) {
      let ff = f + df, rr = r + dr;
      while (onBoard(ff, rr)) {
        const c = board[rr * 8 + ff];
        if (c) {
          if (c.color === by && c.type && kinds.includes(c.type)) return true;
          break;
        }
        ff += df; rr += dr;
      }
    }
  }
  return false;
}

/** Can a piece of `type` on `from` reach `to` (empty or occupied) on this board? Line pieces need a clear path. */
export function reaches(board: Board, from: number, to: number, type: ClaimType): boolean {
  const df = (to & 7) - (from & 7), dr = (to >> 3) - (from >> 3);
  if (!df && !dr) return false;
  if (type === 'knight') return Math.abs(df * dr) === 2;
  const straight = !df || !dr, diagonal = Math.abs(df) === Math.abs(dr);
  if (type === 'rook' ? !straight : type === 'bishop' ? !diagonal : !straight && !diagonal) return false;
  const sf = Math.sign(df), sr = Math.sign(dr);
  for (let i = from + sr * 8 + sf; i !== to; i += sr * 8 + sf) if (board[i]) return false;
  return true;
}

/**
 * `by`'s unclaimed face-down pieces that could reach square `idx` as some claimable type.
 * They attack nothing on the apparent board, so these are the cards that may defend it.
 */
export function guardsOf(board: Board, idx: number, by: Color): number[] {
  const out: number[] = [];
  for (let i = 0; i < 64; i++) {
    const c = board[i];
    if (c && c.color === by && c.hidden && !c.claim && (reaches(board, i, idx, 'queen') || reaches(board, i, idx, 'knight'))) out.push(i);
  }
  return out;
}

export function kingIdx(board: Board, color: Color): number {
  for (let i = 0; i < 64; i++) {
    const c = board[i];
    if (c && c.color === color && c.type === 'king') return i;
  }
  return -1;
}

export function inCheck(board: Board, color: Color): boolean {
  const k = kingIdx(board, color);
  return k >= 0 && isAttacked(board, k, opponent(color));
}

/**
 * Push pseudo-legal moves for a piece moving as `type`.
 * Kings are never captured unless allowKingCapture (used by search).
 */
function pushTypeMoves(
  board: Board, from: number, type: PieceType, color: Color, ep: number,
  claim: ClaimType | undefined, out: Move[], allowKingCapture: boolean,
): void {
  const f = from & 7, r = from >> 3;
  const canTake = (c: Cell) => c.color !== color && (allowKingCapture || c.type !== 'king');

  if (type === 'pawn') {
    const dir = color === 'white' ? 1 : -1;
    const startRank = color === 'white' ? 1 : 6;
    const promoRank = color === 'white' ? 7 : 0;
    const pushPawn = (to: number) => {
      if ((to >> 3) === promoRank) {
        for (const p of PROMOTIONS) out.push({ from, to, type, promo: p });
      } else {
        out.push({ from, to, type });
      }
    };
    const one = from + 8 * dir;
    if (onBoard(f, r + dir) && !board[one]) {
      pushPawn(one);
      const two = from + 16 * dir;
      if (r === startRank && !board[two]) out.push({ from, to: two, type, double: true });
    }
    for (const df of [-1, 1]) {
      const ff = f + df, rr = r + dir;
      if (!onBoard(ff, rr)) continue;
      const to = rr * 8 + ff;
      const c = board[to];
      if (c && canTake(c)) pushPawn(to);
      else if (!c && to === ep) out.push({ from, to, type, ep: true });
    }
    return;
  }

  const steps = (dirs: readonly Dir[], slide: boolean) => {
    for (const [df, dr] of dirs) {
      let ff = f + df, rr = r + dr;
      while (onBoard(ff, rr)) {
        const to = rr * 8 + ff;
        const c = board[to];
        if (!c) out.push({ from, to, type, claim });
        else {
          if (canTake(c)) out.push({ from, to, type, claim });
          break;
        }
        if (!slide) break;
        ff += df; rr += dr;
      }
    }
  };
  if (type === 'knight') steps(KNIGHT_D, false);
  else if (type === 'bishop') steps(BISHOP_D, true);
  else if (type === 'rook') steps(ROOK_D, true);
  else if (type === 'queen') steps(QUEEN_D, true);
  else if (type === 'king') steps(QUEEN_D, false);
}

function pushCastling(board: Board, from: number, color: Color, out: Move[]): void {
  const c = board[from]!;
  const rank = color === 'white' ? 0 : 7;
  if (c.hasMoved || from !== rank * 8 + 4) return;
  const opp = opponent(color);
  if (isAttacked(board, from, opp)) return;
  const sides = [
    { rf: 7, between: [5, 6], pass: [5, 6], kTo: 6, rTo: 5, side: 'K' as const },
    { rf: 0, between: [1, 2, 3], pass: [3, 2], kTo: 2, rTo: 3, side: 'Q' as const },
  ];
  for (const s of sides) {
    const rc = board[rank * 8 + s.rf];
    if (!rc || rc.color !== color || rc.hasMoved) continue;
    // The corner piece must be (or claim to be) a rook.
    const ok = rc.hidden ? !rc.claim || rc.claim === 'rook' : rc.type === 'rook';
    if (!ok) continue;
    if (s.between.some((f) => board[rank * 8 + f])) continue;
    if (s.pass.some((f) => isAttacked(board, rank * 8 + f, opp))) continue;
    out.push({
      from,
      to: rank * 8 + s.kTo,
      type: 'king',
      castle: { side: s.side, rookFrom: rank * 8 + s.rf, rookTo: rank * 8 + s.rTo },
      claim: rc.hidden ? 'rook' : undefined,
    });
  }
}

/**
 * Apply an internal move to a board copy. Moving a face-down piece sets its
 * apparent type to the claim; castling makes the corner piece claim rook.
 */
export function makeMove(board: Board, m: Move): Board {
  const b = board.slice();
  const mover = b[m.from]!;
  b[m.from] = null;
  if (m.ep) {
    const capIdx = m.to + (mover.color === 'white' ? -8 : 8);
    b[capIdx] = null;
  }
  const moved: Cell = { ...mover, hasMoved: true };
  if (m.castle) {
    const rc = b[m.castle.rookFrom]!;
    b[m.castle.rookFrom] = null;
    b[m.castle.rookTo] = { ...rc, hasMoved: true, type: 'rook', claim: rc.hidden ? 'rook' : rc.claim };
  } else if (mover.hidden && m.claim) {
    moved.type = m.claim;
    moved.claim = m.claim;
  }
  if (m.promo) {
    moved.type = m.promo;
    moved.hidden = false;
  }
  b[m.to] = moved;
  return b;
}

export interface GenerateOptions {
  /** Default true: a claimed face-down piece may only move as its claim. */
  claimLocking?: boolean;
  /** Skip the king-safety filter (search uses king capture instead). */
  pseudo?: boolean;
}

/** Generate moves for `color`. */
export function generateMoves(board: Board, color: Color, ep = -1, opts: GenerateOptions = {}): Move[] {
  const locking = opts.claimLocking !== false;
  const pseudo = !!opts.pseudo;
  const out: Move[] = [];
  for (let i = 0; i < 64; i++) {
    const c = board[i];
    if (!c || c.color !== color) continue;
    if (c.hidden) {
      const types = c.claim && locking ? [c.claim] : CLAIMABLE;
      for (const t of types) pushTypeMoves(board, i, t, color, ep, t, out, pseudo);
    } else if (c.type) {
      pushTypeMoves(board, i, c.type, color, ep, undefined, out, pseudo);
      if (c.type === 'king' && !pseudo) pushCastling(board, i, color, out);
    }
  }
  if (pseudo) return out;
  return out.filter((m) => !inCheck(makeMove(board, m), color));
}
