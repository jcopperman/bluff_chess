// Persistence (UI layer only, never inside the engine): circuit records, each
// bot's table-image memory of the player, lesson progress and settings.

import type { Color, GameState } from '../engine/index.ts';
import type { Difficulty, GamePhase, TableImage } from '../bot/bot.ts';
import type { Profile } from '../lessons/lessons.ts';
import type { CircuitRecord } from './render.ts';

const KEY = 'bluffchess.v1';

export interface Settings {
  volume: number;
  muted: boolean;
  /** 'auto' = on for the first few matches. */
  coach: 'auto' | 'on' | 'off';
  difficulty: Difficulty;
  reducedMotion: boolean;
  /** Which side to play against bots. */
  seat: Color | 'random';
  /** Name shown to online opponents. */
  playerName: string;
}

export interface SaveData {
  records: Record<string, CircuitRecord>;
  memory: Record<string, TableImage>;
  profile: Profile | null;
  lessonsDone: string[];
  puzzlesDone: string[];
  matchesPlayed: number;
  settings: Settings;
}

export function blank(): SaveData {
  return {
    records: {}, memory: {}, profile: null, lessonsDone: [], puzzlesDone: [], matchesPlayed: 0,
    settings: { volume: 0.6, muted: false, coach: 'auto', difficulty: 'normal', reducedMotion: false, seat: 'white', playerName: '' },
  };
}

export function load(): SaveData {
  const base = blank();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw) as Partial<SaveData>;
    return { ...base, ...saved, settings: { ...base.settings, ...(saved.settings || {}) } };
  } catch {
    return base;
  }
}

export function save(data: SaveData): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    // Storage blocked (private mode etc.): progress just won't persist.
  }
}

export function blankMemory(): TableImage {
  return {
    matches: 0, claims: 0, lies: 0, callOpps: 0, calls: 0, callsCorrect: 0,
    phases: { opening: { claims: 0, lies: 0 }, middlegame: { claims: 0, lies: 0 }, endgame: { claims: 0, lies: 0 } },
  };
}

function phaseOf(fullmove: number): GamePhase {
  return fullmove <= 8 ? 'opening' : fullmove <= 30 ? 'middlegame' : 'endgame';
}

/** Fold a finished (fully revealed) match into a bot's memory of the player. */
export function updateMemory(memory: TableImage | undefined, finalState: GameState, human: Color): TableImage {
  const base = blankMemory();
  const m: TableImage = { ...base, ...memory };
  m.phases = JSON.parse(JSON.stringify({ ...base.phases, ...(memory?.phases || {}) })) as TableImage['phases'];
  m.matches += 1;
  for (const c of finalState.claims) {
    if (c.player === human) {
      m.claims++;
      const ph = m.phases[phaseOf(c.fullmove)];
      ph.claims++;
      if (!c.honest) {
        m.lies++;
        ph.lies++;
      }
    } else if (c.outcome !== 'pending') {
      m.callOpps++;
      if (c.called) {
        m.calls++;
        if (!c.honest) m.callsCorrect++;
      }
    }
  }
  return m;
}

export function recordResult(records: Record<string, CircuitRecord>, botId: string, outcome: keyof CircuitRecord): Record<string, CircuitRecord> {
  const r: CircuitRecord = { ...(records[botId] ?? { w: 0, l: 0, d: 0 }) };
  r[outcome]++;
  return { ...records, [botId]: r };
}
