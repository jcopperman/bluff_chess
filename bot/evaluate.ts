// Static evaluation and a small alpha-beta search on a "search board": the
// apparent board with the bot's own pieces at their true types and the
// opponent's pieces valued by the bot's beliefs.

import { generateMoves, makeMove, opponent } from '../engine/index.ts';
import type { Board, Cell, Color, Move, PieceType } from '../engine/index.ts';

export const VALUES: Readonly<Record<PieceType, number>> = { pawn: 100, knight: 320, bishop: 330, rook: 500, queen: 900, king: 0 };
export const MATE = 100000;
const UNKNOWN_VALUE = 440;

export interface SearchContext {
  nodes: number;
  maxNodes: number;
}

export function cellValue(c: Cell): number {
  if (c.value != null) return c.value;
  return c.type ? VALUES[c.type] : UNKNOWN_VALUE;
}

function positional(c: Cell, idx: number): number {
  const f = idx & 7, r = idx >> 3;
  const rr = c.color === 'white' ? r : 7 - r;
  const center = 3.5 - Math.max(Math.abs(f - 3.5), Math.abs(r - 3.5));
  switch (c.type) {
    case 'pawn': return rr * 6 + (f >= 2 && f <= 5 ? rr * 3 : 0);
    case 'knight': return center * 10;
    case 'bishop': return center * 6;
    case 'queen': return center * 2;
    case 'rook': return rr === 6 ? 15 : 0;
    case 'king': return rr === 0 ? (f === 6 || f === 2 ? 20 : 0) : -rr * 12;
    default: return rr > 0 ? 8 : 0;
  }
}

/** Score from `color`'s point of view, in centipawns. */
export function evaluate(board: Board, color: Color): number {
  let s = 0;
  for (let i = 0; i < 64; i++) {
    const c = board[i];
    if (!c) continue;
    const v = cellValue(c) + positional(c, i);
    s += c.color === color ? v : -v;
  }
  return s;
}

/** Sum of piece values for `color` (kings excluded). */
export function material(board: Board, color: Color): number {
  let s = 0;
  for (const c of board) if (c && c.color === color) s += cellValue(c);
  return s;
}

function orderMoves(board: Board, moves: Move[]): Move[] {
  const key = (m: Move) => {
    const t = board[m.to];
    let k = 0;
    if (t) k += 10 * cellValue(t) - cellValue(board[m.from]!) / 10;
    if (m.promo) k += 8000;
    return k;
  };
  return moves.sort((a, b) => key(b) - key(a));
}

function epAfter(m: Move): number {
  return m.double ? (m.from + m.to) / 2 : -1;
}

/**
 * Captures-only search, so the static eval is not taken mid-exchange.
 * Pseudo-legal: capturing the king scores as mate.
 */
export function qsearch(board: Board, color: Color, alpha: number, beta: number, ctx: SearchContext, qd = 0): number {
  ctx.nodes++;
  const stand = evaluate(board, color);
  if (stand >= beta) return stand;
  if (stand > alpha) alpha = stand;
  if (qd >= 4 || ctx.nodes > ctx.maxNodes) return stand;
  const moves = generateMoves(board, color, -1, { pseudo: true }).filter((m) => board[m.to] || m.promo);
  for (const m of orderMoves(board, moves)) {
    if (board[m.to]?.type === 'king') return MATE;
    const score = -qsearch(makeMove(board, m), opponent(color), -beta, -alpha, ctx, qd + 1);
    if (score >= beta) return score;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

/** Negamax alpha-beta. Returns the score for `color` to move. */
export function search(
  board: Board, color: Color, depth: number, alpha: number, beta: number, ep: number, ctx: SearchContext, ply = 0,
): number {
  if (depth <= 0) return qsearch(board, color, alpha, beta, ctx);
  ctx.nodes++;
  const moves = generateMoves(board, color, ep, { pseudo: true });
  if (!moves.length) return 0;
  let best = -Infinity;
  for (const m of orderMoves(board, moves)) {
    if (board[m.to]?.type === 'king') return MATE - ply;
    const score = -search(makeMove(board, m), opponent(color), depth - 1, -beta, -alpha, epAfter(m), ctx, ply + 1);
    if (score > best) best = score;
    if (score > alpha) alpha = score;
    if (alpha >= beta || ctx.nodes > ctx.maxNodes) break;
  }
  return best;
}
