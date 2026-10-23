// Showdown: the mated player's last chance to expose a lying piece.

import { opponent } from './moves.ts';
import { canShowdown, gameOver, must, updateStatus } from './state.ts';
import type { AcceptMateAction, Color, GameEvent, GameState, ShowdownAction } from './types.ts';

function requireShowdown(state: GameState, player: Color): void {
  if (state.phase !== 'showdown') throw new Error('No showdown is available');
  if (state.turn !== player) throw new Error('Only the mated player may call a showdown');
}

export function applyShowdown(state: GameState, action: ShowdownAction, events: GameEvent[]): void {
  const player = action.player;
  requireShowdown(state, player);
  if (!canShowdown(state, player)) throw new Error('Showdown not allowed');
  const opp = opponent(player);
  const piece = state.pieces.find((p) => p.id === action.targetPieceId);
  if (!piece || piece.owner !== opp || piece.faceUp || !piece.claim || piece.captured) {
    throw new Error('Invalid showdown target');
  }
  const claim = piece.claim;
  const pieceType = must(piece.type, 'target type');
  const square = must(piece.square, 'target square');

  state.mateShowdowns += 1;
  const honest = pieceType === claim;
  state.showdowns.push({ fullmove: state.fullmove, player, pieceId: piece.id, claim, honest, square });
  events.push({ type: 'showdown', player, pieceId: piece.id, claim, square });

  if (honest) {
    piece.faceUp = true;
    state.chips[player] -= 1;
    state.chips[opp] += 1;
    events.push({ type: 'claimConfirmed', pieceId: piece.id, pieceType, square, mover: opp, caller: player, showdown: true });
  } else {
    piece.square = null;
    piece.captured = true;
    piece.faceUp = true;
    piece.removed = true;
    // Same stakes as a call: an exposed liar pays the caller a chip.
    const paid = state.config.liarPaysChip && state.chips[opp] > 0;
    if (paid) {
      state.chips[opp] -= 1;
      state.chips[player] += 1;
    }
    events.push({ type: 'lieCaught', pieceId: piece.id, pieceType, claim, square, liar: opp, caller: player, showdown: true, paid });
  }
  events.push({ type: 'pieceRevealed', pieceId: piece.id, pieceType });
  updateStatus(state, events, { afterShowdown: true });
}

export function applyAcceptMate(state: GameState, action: AcceptMateAction, events: GameEvent[]): void {
  requireShowdown(state, action.player);
  gameOver(state, opponent(action.player), 'checkmate', events);
}
