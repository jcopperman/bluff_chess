// Public engine API. Pure: state + action in, new state + events out.
// No DOM, no browser APIs, no Math.random, no Date.

import { opponent } from './moves.ts';
import {
  createGame, legalMoves, moveToAction, canShowdown, showdownTargets, gameOver,
  isValidArrangement, placeArrangement, updateStatus,
} from './state.ts';
import { applyMove } from './claims.ts';
import { applyCall, applyPass } from './calls.ts';
import { applyShowdown, applyAcceptMate } from './showdown.ts';
import { getPlayerView, getPublicView, getApparentBoard, apparentIfCaught, boardKey } from './view.ts';
import type { Action, Color, GameEvent, GameState, Result } from './types.ts';

export { createGame, getPlayerView, getPublicView, getApparentBoard, apparentIfCaught, boardKey };
export { randomArrangement, isValidArrangement, CLASSIC_ARRANGEMENT, BACK_FILES, PIECE_COUNTS, DEFAULT_CONFIG } from './state.ts';
export { opponent, CLAIMABLE, sqToIdx, idxToSq, inCheck, generateMoves, makeMove } from './moves.ts';
export { createRng } from './rng.ts';
export type { Rng } from './rng.ts';
export type * from './types.ts';

/** Who must act next, or null when the game is over (or still in setup). */
export function getActor(state: GameState): Color | null {
  if (state.phase === 'move' || state.phase === 'showdown') return state.turn;
  if (state.phase === 'callWindow' && state.pending) return opponent(state.pending.mover);
  return null;
}

/**
 * Every action `player` may take right now. Works on full states and on that player's view.
 * Setup actions are not enumerated (any valid arrangement is allowed).
 */
export function getLegalActions(state: GameState, player: Color): Action[] {
  if (state.phase === 'over') return [];
  const resign: Action = { type: 'resign', player };
  if (state.phase === 'setup') return [resign];

  if (state.phase === 'move') {
    if (state.turn !== player) return [resign];
    return [...legalMoves(state, player).map((m) => moveToAction(m, player)), resign];
  }
  if (state.phase === 'callWindow' && state.pending) {
    if (player === state.pending.mover) return [resign];
    const acts: Action[] = [{ type: 'pass', player }];
    if (state.chips[player] > 0) acts.unshift({ type: 'call', player });
    return [...acts, resign];
  }
  if (state.phase === 'showdown') {
    if (state.turn !== player) return [resign];
    const acts: Action[] = [];
    if (canShowdown(state, player)) {
      for (const p of showdownTargets(state, player)) acts.push({ type: 'showdown', player, targetPieceId: p.id });
    }
    acts.push({ type: 'acceptMate', player });
    return [...acts, resign];
  }
  return [];
}

export function applyAction(state: GameState, action: Action): { state: GameState; events: GameEvent[] } {
  if (!action || !action.type) throw new Error('Action must have a type');
  if (state.phase === 'over') throw new Error('Game is over');
  const s = JSON.parse(JSON.stringify(state)) as GameState;
  const events: GameEvent[] = [];

  switch (action.type) {
    case 'setup':
      if (s.phase !== 'setup') throw new Error('Setup is finished');
      if (s.setupDone[action.player]) throw new Error('Already set up');
      if (!isValidArrangement(action.arrangement)) throw new Error('Invalid arrangement');
      placeArrangement(s, action.player, action.arrangement);
      events.push({ type: 'setupDone', player: action.player });
      if (s.setupDone.white && s.setupDone.black) updateStatus(s, events);
      break;
    case 'move': applyMove(s, action, events); break;
    case 'call': applyCall(s, action, events); break;
    case 'pass': applyPass(s, action, events); break;
    case 'showdown': applyShowdown(s, action, events); break;
    case 'acceptMate': applyAcceptMate(s, action, events); break;
    case 'resign': gameOver(s, opponent(action.player), 'resign', events); break;
    default: throw new Error(`Unknown action type ${(action as { type: string }).type}`);
  }
  s.history.push(JSON.parse(JSON.stringify(action)) as Action);
  return { state: s, events };
}

export function getResult(state: GameState): Result | null {
  return state.result;
}
