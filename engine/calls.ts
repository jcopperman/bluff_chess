// Call window resolution: call, pass, and finalizing a held move.

import { inCheck, opponent } from './moves.ts';
import { getApparentBoard } from './view.ts';
import { must, pieceById, updateStatus } from './state.ts';
import type { CallAction, Color, GameEvent, GameState, PassAction, Pending } from './types.ts';

/**
 * Make a held (or immediate) move permanent and pass the turn.
 * Captured pieces are revealed only here, once the capture can no longer be undone.
 */
export function finalizeMove(state: GameState, pend: Pending, events: GameEvent[]): void {
  if (pend.capturedId) {
    const cap = pieceById(state, pend.capturedId);
    const wasHidden = !cap.faceUp;
    const pieceType = must(cap.type, 'captured piece type');
    cap.faceUp = true;
    events.push({ type: 'captured', pieceId: cap.id, pieceType, owner: cap.owner, square: must(pend.capturedSquare, 'capture square'), by: pend.mover, claim: cap.claim });
    if (wasHidden) events.push({ type: 'pieceRevealed', pieceId: cap.id, pieceType });
  }
  state.pending = null;
  state.turn = opponent(pend.mover);
  updateStatus(state, events);
}

function requireCallWindow(state: GameState, player: Color): Pending {
  if (state.phase !== 'callWindow' || !state.pending) throw new Error('No call window is open');
  if (player !== opponent(state.pending.mover)) throw new Error('Only the opponent of the mover may call or pass');
  return state.pending;
}

function claimEntry(state: GameState, pend: Pending) {
  return must(state.claims[must(pend.claimIndex, 'claim index')], 'claim record');
}

export function applyPass(state: GameState, action: PassAction, events: GameEvent[]): void {
  const pend = requireCallWindow(state, action.player);
  claimEntry(state, pend).outcome = 'passed';
  events.push({ type: 'passed', player: action.player, pieceId: pend.pieceId });
  finalizeMove(state, pend, events);
}

export function applyCall(state: GameState, action: CallAction, events: GameEvent[]): void {
  const caller = action.player;
  const pend = requireCallWindow(state, caller);
  if (state.chips[caller] <= 0) throw new Error('No chips to call with');
  const mover = pend.mover;
  const claim = must(pend.claim, 'pending claim');
  const entry = claimEntry(state, pend);
  entry.called = true;
  const piece = pieceById(state, pend.pieceId);
  const pieceType = must(piece.type, 'claiming piece type');
  events.push({ type: 'called', player: caller, pieceId: piece.id });

  if (pend.honest) {
    piece.faceUp = true;
    state.chips[caller] -= 1;
    state.chips[mover] += 1;
    entry.outcome = 'confirmed';
    events.push({ type: 'claimConfirmed', pieceId: piece.id, pieceType, square: must(piece.square, 'square'), mover, caller });
    events.push({ type: 'pieceRevealed', pieceId: piece.id, pieceType });
    finalizeMove(state, pend, events);
    return;
  }

  // The claim was a lie: reverse the move, restore any capture, remove the liar.
  const liarSquare = must(piece.square, 'liar square');
  if (pend.castle) {
    const king = pieceById(state, pend.castle.kingId);
    king.square = pend.castle.kingFrom;
    king.hasMoved = pend.castle.kingPrevHasMoved;
  }
  piece.square = pend.from;
  piece.hasMoved = pend.prevHasMoved;
  if (pend.capturedId) {
    const cap = pieceById(state, pend.capturedId);
    cap.captured = false;
    cap.square = pend.capturedSquare;
  }
  state.ep = pend.prevEp;
  state.halfmove = 0;

  piece.square = null;
  piece.captured = true;
  piece.faceUp = true;
  piece.removed = true;
  const paid = state.config.liarPaysChip && state.chips[mover] > 0;
  if (paid) {
    state.chips[mover] -= 1;
    state.chips[caller] += 1;
  }
  entry.outcome = 'caught';
  state.pending = null;
  // The liar normally forfeits the turn, but a check must be answered: if undoing the
  // lie leaves the liar in check, they move again, and with no answer it's checkmate.
  const stillInCheck = inCheck(getApparentBoard(state), mover);
  events.push({ type: 'lieCaught', pieceId: piece.id, pieceType, claim, square: liarSquare, from: pend.from, liar: mover, caller, restoredId: pend.capturedId, paid, stillInCheck });
  events.push({ type: 'pieceRevealed', pieceId: piece.id, pieceType });

  state.turn = stillInCheck ? mover : caller;
  updateStatus(state, events);
}
