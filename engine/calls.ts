// Call and defend window resolution: call, pass, defend, and finalizing a held move.

import { inCheck, opponent, reaches, sqToIdx } from './moves.ts';
import { getApparentBoard } from './view.ts';
import { must, pieceById, updateStatus } from './state.ts';
import type { CallAction, ClaimType, Color, DefendAction, GameEvent, GameState, PassAction, Pending, Phase } from './types.ts';

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

function requireWindow(state: GameState, player: Color, phase: Phase = 'callWindow'): Pending {
  const what = phase === 'callWindow' ? 'call' : 'defend';
  if (state.phase !== phase || !state.pending) throw new Error(`No ${what} window is open`);
  if (player !== opponent(state.pending.mover)) throw new Error(`Only the opponent of the mover may ${what} or pass`);
  return state.pending;
}

/** Put a held move back: the moved piece (and the king, when castling) home, any capture restored. */
function undoMove(state: GameState, pend: Pending): void {
  if (pend.castle) {
    const king = pieceById(state, pend.castle.kingId);
    king.square = pend.castle.kingFrom;
    king.hasMoved = pend.castle.kingPrevHasMoved;
  }
  const piece = pieceById(state, pend.pieceId);
  piece.square = pend.from;
  piece.hasMoved = pend.prevHasMoved;
  if (pend.capturedId) {
    const cap = pieceById(state, pend.capturedId);
    cap.captured = false;
    cap.square = pend.capturedSquare;
  }
  state.ep = pend.prevEp;
  state.halfmove = 0;
}

function claimEntry(state: GameState, pend: Pending) {
  return must(state.claims[must(pend.claimIndex, 'claim index')], 'claim record');
}

export function applyPass(state: GameState, action: PassAction, events: GameEvent[]): void {
  const pend = requireWindow(state, action.player, state.phase === 'defendWindow' ? 'defendWindow' : 'callWindow');
  if (pend.claimIndex != null) claimEntry(state, pend).outcome = 'passed';
  events.push({ type: 'passed', player: action.player, pieceId: pend.pieceId });
  finalizeMove(state, pend, events);
}

export function applyCall(state: GameState, action: CallAction, events: GameEvent[]): void {
  const caller = action.player;
  const pend = requireWindow(state, caller);
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
  undoMove(state, pend);

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

/**
 * The defender flips an unclaimed card that could have reached the king's new square.
 * If its true type really attacks that square, the king move is undone, and the king's
 * player pays a chip and loses the turn (unless the undo leaves them in check: then
 * they move again). If it doesn't, the defender pays and the move stands. Either way
 * the card stays face-up.
 */
export function applyDefend(state: GameState, action: DefendAction, events: GameEvent[]): void {
  const defender = action.player;
  const pend = requireWindow(state, defender, 'defendWindow');
  if (state.chips[defender] <= 0) throw new Error('No chips to defend with');
  if (!pend.defenders?.includes(action.pieceId)) throw new Error('That card cannot defend this square');
  const mover = pend.mover;
  const piece = pieceById(state, action.pieceId);
  const pieceType = must(piece.type, 'defending piece type') as ClaimType;
  const square = must(piece.square, 'defender square');
  const holds = reaches(getApparentBoard(state), sqToIdx(square), sqToIdx(pend.to), pieceType);
  piece.faceUp = true;

  if (!holds) {
    state.chips[defender] -= 1;
    state.chips[mover] += 1;
    events.push({ type: 'defenseFailed', player: defender, pieceId: piece.id, pieceType, square, mover, kingTo: pend.to });
    events.push({ type: 'pieceRevealed', pieceId: piece.id, pieceType });
    finalizeMove(state, pend, events);
    return;
  }

  undoMove(state, pend);
  const paid = state.config.liarPaysChip && state.chips[mover] > 0;
  if (paid) {
    state.chips[mover] -= 1;
    state.chips[defender] += 1;
  }
  state.pending = null;
  const stillInCheck = inCheck(getApparentBoard(state), mover);
  events.push({ type: 'defended', player: defender, pieceId: piece.id, pieceType, square, mover, kingFrom: pend.from, kingTo: pend.to, restoredId: pend.capturedId, paid, stillInCheck });
  events.push({ type: 'pieceRevealed', pieceId: piece.id, pieceType });
  state.turn = stillInCheck ? mover : defender;
  updateStatus(state, events);
}
