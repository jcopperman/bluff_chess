// Daily game: one match a day, seeded by the date. The date picks the opponent,
// a rule twist, both back ranks and your colour, so everyone who plays that day
// gets the same game. Pure logic; the UI supplies today's date key.

import { createRng, randomArrangement, opponent } from '../engine/index.ts';
import type { Color, Config, GameConfig } from '../engine/index.ts';

export interface Twist {
  id: string;
  title: string;
  /** One line describing the rule change. */
  text: string;
  config: Partial<Config>;
}

/** House rules come up more often than any single twist. */
export const TWISTS: readonly Twist[] = [
  { id: 'house', title: 'House rules', text: 'Four chips each and the standard rules.', config: {} },
  { id: 'house', title: 'House rules', text: 'Four chips each and the standard rules.', config: {} },
  { id: 'short', title: 'Short stacks', text: 'Two chips each. Every call is expensive, so bluffs go further.', config: { startingChips: 2 } },
  { id: 'deep', title: 'Deep pockets', text: 'Eight chips each. Expect to be called.', config: { startingChips: 8 } },
  { id: 'loose', title: 'Loose claims', text: 'Claim locking is off: a card can claim something new on every move.', config: { claimLocking: false } },
  { id: 'free-lies', title: 'Free lies', text: 'Caught liars pay nothing. Only wrong calls cost chips.', config: { liarPaysChip: false } },
  { id: 'last-stand', title: 'Last stand', text: 'One showdown per checkmate, however many chips you hold.', config: { showdownsPerMate: 1 } },
  { id: 'no-bust', title: 'No bust', text: 'Running out of chips does not lose the game.', config: { chipsOutLoss: false } },
];

export interface Daily {
  /** Local date, YYYY-MM-DD. */
  key: string;
  seed: number;
  botId: string;
  /** The side you play. */
  seat: Color;
  twist: Twist;
  /** Rules plus both dealt back ranks. */
  config: GameConfig;
}

/** FNV-1a: a stable seed from the date key. */
export function seedFor(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

export function dailyFor(key: string, roster: readonly string[]): Daily {
  const seed = seedFor(`bluff-chess:${key}`);
  const rng = createRng(seed);
  const botId = rng.pick(roster);
  const seat: Color = rng.chance(0.5) ? 'white' : 'black';
  const twist = rng.pick(TWISTS);
  const mine = randomArrangement(rng);
  const theirs = randomArrangement(rng);
  return { key, seed, botId, seat, twist, config: { ...twist.config, setups: { [seat]: mine, [opponent(seat)]: theirs } } };
}

export interface DailyEntry {
  outcome: 'w' | 'l' | 'd';
  /** Your moves played. */
  moves: number;
  /** Your chips at the end. */
  chips: number;
  /** False while the counted attempt is still being played (it stands as a loss if abandoned). */
  done: boolean;
}

/** The key for the day before, in plain calendar arithmetic. */
export function previousKey(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d - 1));
  return t.toISOString().slice(0, 10);
}

/** Days in a row with a counted attempt, ending today (or yesterday, if today isn't played yet). */
export function streak(history: Record<string, DailyEntry>, today: string): number {
  let key = history[today] ? today : previousKey(today);
  let n = 0;
  while (history[key]) {
    n++;
    key = previousKey(key);
  }
  return n;
}

export function outcomeText(e: DailyEntry): string {
  if (!e.done) return 'Abandoned';
  if (e.outcome === 'l' && e.moves === 0) return 'Lost without a move';
  const moves = `${e.moves} move${e.moves === 1 ? '' : 's'}`;
  const chips = `${e.chips} chip${e.chips === 1 ? '' : 's'} left`;
  return `${e.outcome === 'w' ? 'Won' : e.outcome === 'l' ? 'Lost' : 'Drew'} in ${moves}, ${chips}`;
}

/** A spoiler-free result line to paste for friends. */
export function shareText(d: Daily, botName: string, e: DailyEntry, days: number): string {
  return [`Bluff Chess daily ${d.key}`, `vs ${botName} · ${d.twist.title}`, outcomeText(e), `Streak: ${days} day${days === 1 ? '' : 's'}`].join('\n');
}
