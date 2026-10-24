// Bluff Puzzles: curated positions with a goal (design 3.3), stored as JSON in
// data/puzzles/. Pure logic; the UI plays the opponent and asks judge() after
// every action.

import { createGame, applyAction, getActor, getLegalActions } from '../engine/index.ts';
import type { Action, Color, GameConfig, GameEvent, GameState } from '../engine/index.ts';
import type { Personality } from '../bot/bot.ts';

export type Goal =
  /** Checkmate (or otherwise win) within this many of your moves. */
  | { type: 'mate'; moves: number }
  /** Call the pending claim if it's a lie, pass if it's true. */
  | { type: 'decide' }
  /** You're checkmated on the apparent board: expose a lie and break the mate. */
  | { type: 'breakMate' };

export interface Puzzle {
  id: string;
  title: string;
  blurb: string;
  /** The brief shown beside the board (trusted HTML). */
  say: string;
  position: GameConfig;
  /** Scripted actions played before the puzzle starts (e.g. the claim to judge). */
  before?: Action[];
  goal: Goal;
  /** Personality id of the opponent, who answers your moves in mate puzzles. */
  opponent: string;
  overrides?: Partial<Personality>;
  /** Your actions in a solution; the tests replay them against the opponent. */
  solution: Action[];
  /** Why the solution works, shown once solved (trusted HTML). */
  explain: string;
  /** Shown after a failed attempt. */
  hint: string;
}

/** You always play white in puzzles. */
export const SOLVER: Color = 'white';

export type Verdict = 'playing' | 'solved' | 'failed';

export function startPuzzle(p: Puzzle): GameState {
  let s = createGame(p.position);
  for (const a of p.before ?? []) s = applyAction(s, a).state;
  return s;
}

/** Your moves so far: move actions that weren't caught as lies count all the same. */
export function movesMade(state: GameState, startLength: number): number {
  return state.history.slice(startLength).filter((a) => a.type === 'move' && a.player === SOLVER).length;
}

/**
 * Judge the puzzle after an action. `before` is the state the action was
 * applied to; `startLength` is the history length when the puzzle began.
 */
export function judge(p: Puzzle, before: GameState, action: Action, after: GameState, events: GameEvent[], startLength: number): Verdict {
  const won = after.result?.winner === SOLVER;
  const lost = after.phase === 'over' && !won;
  if (p.goal.type === 'decide') {
    if (action.player !== SOLVER || (action.type !== 'call' && action.type !== 'pass')) return lost ? 'failed' : 'playing';
    const honest = before.pending?.honest;
    return (action.type === 'call') === (honest === false) ? 'solved' : 'failed';
  }
  if (p.goal.type === 'breakMate') {
    if (events.some((e) => e.type === 'mateBroken' && e.player === SOLVER)) return 'solved';
    return lost ? 'failed' : 'playing';
  }
  if (won) return 'solved';
  if (lost) return 'failed';
  // Out of moves: it's your move again and the allowance is spent.
  const spent = movesMade(after, startLength) >= p.goal.moves;
  return spent && getActor(after) === SOLVER && after.phase === 'move' ? 'failed' : 'playing';
}

/**
 * Exhaustive check on the full state (both sides' cards known): can white force
 * a win within `moves` of its own moves, whatever the opponent does, calls
 * included? Returns a winning first action, or null. For tests and authoring.
 */
export function forcedWin(state: GameState, moves: number): Action | null {
  const memo = new Map<string, boolean>();
  const options = (s: GameState, who: Color) => getLegalActions(s, who).filter((a) => a.type !== 'resign');
  const wins = (s: GameState, left: number): boolean => {
    if (s.phase === 'over') return s.result?.winner === SOLVER;
    const actor = getActor(s);
    if (!actor) return false;
    const key = `${left}|${JSON.stringify([s.pieces, s.chips, s.pending, s.turn, s.phase, s.mateShowdowns])}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let result: boolean;
    if (actor === SOLVER) {
      const isMove = s.phase === 'move';
      if (isMove && left <= 0) result = false;
      else result = options(s, actor).some((a) => wins(applyAction(s, a).state, isMove && a.type === 'move' ? left - 1 : left));
    } else {
      result = options(s, actor).every((a) => wins(applyAction(s, a).state, left));
    }
    memo.set(key, result);
    return result;
  };
  if (getActor(state) !== SOLVER || moves <= 0) return null;
  const isMove = state.phase === 'move';
  return options(state, SOLVER).find((a) => wins(applyAction(state, a).state, isMove && a.type === 'move' ? moves - 1 : moves)) ?? null;
}
