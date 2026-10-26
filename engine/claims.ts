// Moves, including claims by face-down pieces and the pending call and defend windows.

import { guardsOf, idxToSq, opponent } from './moves.ts';
import { legalMoves, must, pieceAt } from './state.ts';
import { finalizeMove } from './calls.ts';
import { getApparentBoard } from './view.ts';
import type { GameEvent, GameState, Move, MoveAction, Pending } from './types.ts';

function sameMove(m: Move, action: MoveAction): boolean {
  return idxToSq(m.from) === action.from &&
    idxToSq(m.to) === action.to &&
    (m.claim || null) === (action.claim || null) &&
    (m.promo || null) === (action.promotion || null);
}

export function applyMove(state: GameState, action: MoveAction, events: GameEvent[]): void {
  const player = action.player;
  if (state.phase !== 'move') throw new Error(`Cannot move during ${state.phase}`);
  if (state.turn !== player) throw new Error(`It is ${state.turn}'s turn`);

  const m = legalMoves(state, player).find((x) => sameMove(x, action));
  if (!m) throw new Error(`Illegal move ${action.from}-${action.to}${action.claim ? ' as ' + action.claim : ''}`);

  const piece = must(pieceAt(state, action.from), 'moving piece');
  const pend: Pending = {
    mover: player,
    action: { from: action.from, to: action.to, claim: action.claim || null, promotion: action.promotion || null },
    pieceId: piece.id,
    from: action.from,
    to: action.to,
    claim: null,
    honest: null,
    prevClaim: piece.claim,
    prevHasMoved: piece.hasMoved,
    capturedId: null,
    capturedSquare: null,
    castle: null,
    prevEp: state.ep,
    claimIndex: null,
  };

  // Capture (normal or en passant).
  const capSq = m.ep ? idxToSq(m.to + (player === 'white' ? -8 : 8)) : action.to;
  const cap = pieceAt(state, capSq);
  if (cap && cap.owner !== player) {
    pend.capturedId = cap.id;
    pend.capturedSquare = capSq;
    cap.captured = true;
    cap.square = null;
  }

  let callable = false;
  if (m.castle) {
    const rook = must(pieceAt(state, idxToSq(m.castle.rookFrom)), 'castling corner piece');
    pend.castle = { side: m.castle.side, kingId: piece.id, kingFrom: action.from, kingTo: action.to, kingPrevHasMoved: piece.hasMoved };
    piece.square = action.to;
    piece.hasMoved = true;
    pend.pieceId = rook.id;
    pend.from = must(rook.square, 'corner square');
    pend.to = idxToSq(m.castle.rookTo);
    pend.prevClaim = rook.claim;
    pend.prevHasMoved = rook.hasMoved;
    rook.square = pend.to;
    rook.hasMoved = true;
    if (!rook.faceUp) {
      rook.claim = 'rook';
      callable = true;
      pend.claim = 'rook';
      pend.honest = rook.type === 'rook';
    }
  } else {
    piece.square = action.to;
    piece.hasMoved = true;
    if (!piece.faceUp && m.claim) {
      piece.claim = m.claim;
      callable = true;
      pend.claim = m.claim;
      pend.honest = piece.type === m.claim;
    }
    if (m.promo) {
      piece.type = m.promo;
      piece.promoted = true;
      piece.faceUp = true;
    }
  }

  state.ep = m.double ? idxToSq((m.from + m.to) / 2) : null;
  state.halfmove = m.type === 'pawn' || pend.capturedId ? 0 : state.halfmove + 1;
  const fullmove = state.fullmove;
  if (player === 'black') state.fullmove += 1;

  events.push({
    type: 'moved', player, pieceId: piece.id, from: action.from, to: action.to,
    claim: pend.claim, capturedId: pend.capturedId, castle: pend.castle ? pend.castle.side : null,
    promotion: m.promo || null,
  });

  if (callable && pend.claim) {
    state.claims.push({
      fullmove, player, pieceId: pend.pieceId, from: pend.from, to: pend.to,
      claim: pend.claim, honest: pend.honest, called: false, outcome: 'pending',
      castle: !!pend.castle, capture: !!pend.capturedId,
    });
    pend.claimIndex = state.claims.length - 1;
    state.pending = pend;
    state.phase = 'callWindow';
    events.push({ type: 'claimMade', player, pieceId: pend.pieceId, claim: pend.claim, square: pend.to });
    events.push({ type: 'callWindowOpened', player: opponent(player), pieceId: pend.pieceId });
    return;
  }

  // Unclaimed cards attack nothing on the apparent board, so a king may step (or capture)
  // where one of them really reaches. If one could, the opponent gets to defend the square.
  const opp = opponent(player);
  if (m.type === 'king' && !m.castle && state.chips[opp] > 0) {
    const board = getApparentBoard(state);
    const defenders = guardsOf(board, m.to, opp).map((i) => board[i]!.id);
    if (defenders.length) {
      pend.defenders = defenders;
      state.pending = pend;
      state.phase = 'defendWindow';
      events.push({ type: 'defendWindowOpened', player: opp, kingId: piece.id, square: action.to, defenders });
      return;
    }
  }
  finalizeMove(state, pend, events);
}
