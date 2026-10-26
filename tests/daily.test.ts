import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGame, createRng, isValidArrangement, opponent, applyAction, getActor, getPlayerView, DEFAULT_CONFIG } from '../engine/index.ts';
import type { GameState } from '../engine/index.ts';
import { chooseAction } from '../bot/bot.ts';
import type { PersonalityConfig } from '../bot/bot.ts';
import { dailyFor, previousKey, streak, shareText, TWISTS } from '../daily/daily.ts';
import type { DailyEntry } from '../daily/daily.ts';

const dir = new URL('../data/personalities/', import.meta.url);
const roster = (JSON.parse(readFileSync(new URL('index.json', dir), 'utf8')) as { circuit: string[] }).circuit;
const bot = (id: string) => JSON.parse(readFileSync(new URL(`${id}.json`, dir), 'utf8')) as PersonalityConfig;

/** Every day of 2026. */
const year = (() => {
  const keys: string[] = [];
  for (let k = '2026-12-31'; k.startsWith('2026'); k = previousKey(k)) keys.push(k);
  return keys;
})();

test('the same date always deals the same game', () => {
  assert.deepEqual(dailyFor('2026-10-26', roster), dailyFor('2026-10-26', roster));
  assert.notDeepEqual(dailyFor('2026-10-26', roster).config, dailyFor('2026-10-27', roster).config);
});

test('every day of a year deals a valid game with a circuit opponent', () => {
  for (const key of year) {
    const d = dailyFor(key, roster);
    assert.ok(roster.includes(d.botId), key);
    for (const side of [d.seat, opponent(d.seat)]) assert.ok(isValidArrangement(d.config.setups?.[side]), `${key} ${side}`);
    const s = createGame(d.config);
    assert.equal(s.phase, 'move', key);
    assert.equal(s.chips[d.seat], d.twist.config.startingChips ?? DEFAULT_CONFIG.startingChips, key);
  }
});

test('over a year, the days vary in opponent, colour and twist', () => {
  const days = year.map((k) => dailyFor(k, roster));
  assert.deepEqual(new Set(days.map((d) => d.botId)), new Set(roster));
  assert.deepEqual(new Set(days.map((d) => d.seat)), new Set(['white', 'black']));
  assert.deepEqual(new Set(days.map((d) => d.twist.id)), new Set(TWISTS.map((t) => t.id)));
});

test('a daily game replays identically from its seed', () => {
  const d = dailyFor('2026-10-26', roster);
  const play = () => {
    let s: GameState = createGame(d.config);
    const rng = createRng(d.seed);
    for (let ply = 0; ply < 40 && s.phase !== 'over'; ply++) {
      const actor = getActor(s)!;
      const dec = chooseAction(getPlayerView(s, actor), bot(d.botId), {}, rng)!;
      s = applyAction(s, dec.action).state;
    }
    return s.history;
  };
  assert.deepEqual(play(), play());
});

test('previous day crosses months, years and leap days', () => {
  assert.equal(previousKey('2026-03-01'), '2026-02-28');
  assert.equal(previousKey('2028-03-01'), '2028-02-29');
  assert.equal(previousKey('2027-01-01'), '2026-12-31');
});

test('streak counts days in a row up to today, or yesterday if today is unplayed', () => {
  const e: DailyEntry = { outcome: 'w', moves: 20, chips: 3, done: true };
  const h = { '2026-10-23': e, '2026-10-24': e, '2026-10-25': e };
  assert.equal(streak(h, '2026-10-26'), 3);
  assert.equal(streak({ ...h, '2026-10-26': e }, '2026-10-26'), 4);
  assert.equal(streak(h, '2026-10-27'), 0);
  assert.equal(streak({}, '2026-10-26'), 0);
});

test('the share text names the day, opponent and result without the deal', () => {
  const d = dailyFor('2026-10-26', roster);
  const text = shareText(d, 'The Widow', { outcome: 'w', moves: 23, chips: 1, done: true }, 4);
  assert.equal(text, `Bluff Chess daily 2026-10-26\nvs The Widow · ${d.twist.title}\nWon in 23 moves, 1 chip left\nStreak: 4 days`);
});
