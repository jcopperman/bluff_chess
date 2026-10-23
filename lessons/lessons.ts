// Lessons: short scripted scenarios on staged positions (data/lessons/*.json).
// Pure logic; the UI drives the steps.

import { createGame, applyAction, getLegalActions } from '../engine/index.ts';
import type { Action, Color, GameConfig, GameState, Square } from '../engine/index.ts';

export type Audience = 'chess' | 'poker' | 'everyone';

/** A partial action: any field given must match the player's action. */
export type Expect = Partial<Omit<Extract<Action, { type: 'move' }>, 'player'>> & { type?: Action['type']; targetPieceId?: string };

export interface LessonStep {
  /** Instruction for the player (trusted HTML). */
  say: string;
  /** Reset the board to this position before the step. */
  position?: GameConfig;
  /** Scripted actions (usually the opponent's) played when the step starts. */
  before?: Action[];
  /** What the player must do: one of these actions, or 'next' for a read-only step. */
  expect: Expect[] | 'next';
  highlight?: Square[];
  /** Shown after a wrong action. */
  hint?: string;
  /** Shown after the right action. */
  success?: string;
  /** Scripted actions played after the right action. */
  reply?: Action[];
}

export interface Lesson {
  id: string;
  title: string;
  blurb: string;
  audience: Audience;
  steps: LessonStep[];
}

export const PLAYER: Color = 'white';

export function matchesExpect(action: Action, expect: Expect[] | 'next'): boolean {
  if (expect === 'next') return false;
  const a = action as unknown as Record<string, unknown>;
  return expect.some((e) => {
    const type = e.type ?? 'move';
    if (a.type !== type) return false;
    return Object.entries(e).every(([k, v]) => k === 'type' || a[k] === v);
  });
}

/** Apply scripted actions in order. */
export function applyAll(state: GameState, actions: Action[] = []): GameState {
  let s = state;
  for (const a of actions) s = applyAction(s, a).state;
  return s;
}

/** The state a step starts from, given the state the previous step ended in. */
export function startStep(prev: GameState | null, step: LessonStep): GameState {
  const base = step.position ? createGame(step.position) : prev;
  if (!base) throw new Error('First lesson step needs a position');
  return applyAll(base, step.before);
}

/**
 * Play a lesson through, taking the first legal action that satisfies each
 * step, and throw if a step can't be completed. Returns the final state.
 */
export function walkLesson(lesson: Lesson): GameState {
  let state: GameState | null = null;
  for (const [i, step] of lesson.steps.entries()) {
    try {
      state = startStep(state, step);
      if (step.expect !== 'next') {
        const expect = step.expect;
        const action = getLegalActions(state, PLAYER).find((a) => matchesExpect(a, expect));
        if (!action) throw new Error('no legal action satisfies the expectation');
        state = applyAction(state, action).state;
        state = applyAll(state, step.reply);
      }
    } catch (e) {
      throw new Error(`${lesson.id} step ${i + 1}: ${(e as Error).message}`);
    }
  }
  return state!;
}

/** Which lessons to recommend from the first-run questions. */
export interface Profile {
  chess: 'new' | 'basic' | 'confident';
  poker: 'new' | 'basic' | 'confident';
}

export function recommended(lesson: Lesson, profile: Profile | null): boolean {
  if (!profile) return true;
  if (lesson.audience === 'everyone') return true;
  if (lesson.audience === 'chess') return profile.chess === 'new' || (profile.chess === 'basic' && lesson.id === 'check');
  return profile.poker !== 'confident';
}
