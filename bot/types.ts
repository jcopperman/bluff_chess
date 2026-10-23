// Bot types: personalities (data/personalities/*.json), table image, decisions.

import type { Action, Arrangement, ClaimType, Square } from '../engine/index.ts';

export type ThinkRange = [number, number];

/** Consistent, learnable behaviour keyed to whether the bot is bluffing. */
export type Tell =
  | { kind: 'thinkTime'; neutral?: ThinkRange; honest: ThinkRange; bluff: ThinkRange }
  | { kind: 'dialogue'; chance?: number; honest: string[]; bluff: string[] }
  | { kind: 'hover'; on: 'bluff' | 'honest' };

export type LineKey =
  | 'greet' | 'win' | 'lose' | 'call' | 'pass' | 'caughtLying' | 'catchesYou'
  | 'wrongCall' | 'confirmed' | 'showdown' | 'playerQueen';

export type GamePhase = 'opening' | 'middlegame' | 'endgame';
/** A player-chosen difficulty applied on top of each personality. */
export type Difficulty = 'easier' | 'normal' | 'harder';
export type Standing = 'ahead' | 'even' | 'behind';

export interface Personality {
  id: string;
  name: string;
  title: string;
  avatar: string;
  color: string;
  blurb: string;
  teaches: string;
  /** 1-3: search depth and evaluation noise. */
  chessStrength: number;
  /** 0-1: chance per move of settling for another reasonable move instead of the best. */
  mistakeRate: number;
  /** How much worse (centipawns) a mistaken move may be than the best one. */
  mistakeWindow: number;
  /** Base probability of taking an available bluff. */
  bluffRate: number;
  /** Multipliers on bluffRate by game phase and material standing. */
  bluffContext: Partial<Record<GamePhase | Standing, number>>;
  /** How much position (centipawns) the bot will give up to lie. */
  bluffMargin: number;
  /** How much expected value (centipawns) the bot will risk on being called. */
  riskTolerance: number;
  /** Claim types the bot is willing to lie about. */
  bluffClaims: ClaimType[];
  /** Number of opening claims that are always honest. */
  honestFirstClaims: number;
  /** Call when the expected value of calling exceeds this (centipawns). */
  callThreshold: number;
  /** Multiplier on how much the bot values a chip. */
  chipCaution: number;
  /** 0-1: how strongly the bot reacts to the player's table image. */
  adaptivity: number;
  callThinkMs?: ThinkRange;
  tells: Tell[];
  lines: Partial<Record<LineKey, string[]>>;
  /** Fixed secret arrangement; random when omitted. */
  setup?: Arrangement;
}

/** A personality as stored in JSON: tuning fields fall back to defaults. */
export type PersonalityConfig =
  Pick<Personality, 'id' | 'name' | 'title' | 'avatar' | 'color' | 'blurb' | 'teaches'> & Partial<Personality>;

export interface PhaseStats {
  claims: number;
  lies: number;
}

/** What a bot remembers about the player across matches (kept by the UI layer). */
export interface TableImage {
  matches: number;
  claims: number;
  lies: number;
  /** Bot claims the player could have called. */
  callOpps: number;
  calls: number;
  callsCorrect: number;
  phases: Record<GamePhase, PhaseStats>;
}

export type TypeDist = Record<ClaimType, number>;

export interface Beliefs {
  /** Per hidden opponent piece id, a distribution over its true type. */
  probs: Record<string, TypeDist>;
  remaining: Record<ClaimType, number>;
  /** Types claimed by more pieces than can exist. */
  certainLies: ClaimType[];
  hiddenIds: string[];
}

export interface DecisionDebug {
  bluff?: boolean;
  ev?: number;
  phase?: GamePhase;
  standing?: Standing;
  nodes?: number;
  pLie?: number;
  gain?: number;
  threshold?: number;
}

export interface Decision {
  action: Action;
  /** How long to appear to think: a tell, not compute time. */
  thinkMs: number;
  line: string | null;
  /** Squares to highlight in order while thinking (hover tell). */
  hover?: Square[];
  debug?: DecisionDebug;
}
