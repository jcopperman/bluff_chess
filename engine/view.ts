// What each side is allowed to see. Bots and the UI only ever consume views.

import { idxToSq, sqToIdx } from './moves.ts';
import type { Board, Color, GameState, PlayerView } from './types.ts';

/** The public board used for check and mate. Works on full states and on views. */
export function getApparentBoard(state: GameState): Board {
  const board: Board = new Array(64).fill(null);
  for (const p of state.pieces) {
    if (p.captured || !p.square) continue;
    board[sqToIdx(p.square)] = {
      id: p.id,
      color: p.owner,
      type: p.faceUp ? p.type : p.claim || null,
      hidden: !p.faceUp,
      claim: p.claim,
      hasMoved: p.hasMoved,
    };
  }
  return board;
}

/** Stable key of the apparent position, for repetition. */
export function positionKey(state: GameState): string {
  const b = getApparentBoard(state);
  let key = state.turn[0] + (state.ep || '-');
  for (let i = 0; i < 64; i++) {
    const c = b[i];
    if (c) key += idxToSq(i) + c.color[0] + (c.type ? c.type[0] + c.type[1] : '??') + (c.hasMoved ? '' : '*');
  }
  return key;
}

/**
 * Same shape as the state, with the opponent's hidden identities stripped.
 * After the game ends everything is revealed.
 */
export function getPlayerView(state: GameState, player: Color): PlayerView {
  const v: PlayerView = { ...(JSON.parse(JSON.stringify(state)) as GameState), viewer: player };
  if (state.revealed) return v;

  const hiddenIds = new Set<string>();
  for (const p of v.pieces) {
    if (p.owner !== player && !p.faceUp) {
      p.type = null;
      hiddenIds.add(p.id);
    }
  }
  if (v.pending && v.pending.mover !== player) delete v.pending.honest;
  for (const c of v.claims) {
    if (c.player !== player && hiddenIds.has(c.pieceId)) delete c.honest;
  }
  for (const a of v.history) {
    if (a.type === 'setup' && a.player !== player) delete a.arrangement;
  }
  return v;
}
