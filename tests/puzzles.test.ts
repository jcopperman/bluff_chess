import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyAction, getActor, getLegalActions, getPlayerView, createRng } from '../engine/index.ts';
import type { Action } from '../engine/index.ts';
import { chooseAction, applyDifficulty } from '../bot/bot.ts';
import type { PersonalityConfig } from '../bot/bot.ts';
import { startPuzzle, judge, forcedWin, SOLVER } from '../puzzles/puzzles.ts';
import type { Puzzle, Verdict } from '../puzzles/puzzles.ts';

const read = <T>(path: string) => JSON.parse(readFileSync(new URL(`../data/${path}`, import.meta.url), 'utf8')) as T;
const puzzles = read<string[]>('puzzles/index.json').map((id) => read<Puzzle>(`puzzles/${id}.json`));

/** Play `actions` as white, with the puzzle's opponent answering, and return the verdict. */
function play(p: Puzzle, actions: Action[]): Verdict {
  let s = startPuzzle(p);
  const start = s.history.length;
  const bot = applyDifficulty({ ...read<PersonalityConfig>(`personalities/${p.opponent}.json`), ...p.overrides }, 'normal');
  const rng = createRng(7);
  let verdict: Verdict = 'playing';
  let i = 0;
  for (let n = 0; n < 60 && verdict === 'playing'; n++) {
    const actor = getActor(s);
    if (!actor) break;
    const a = actor === SOLVER ? actions[i++] : chooseAction(getPlayerView(s, actor), bot, {}, rng)!.action;
    if (!a) break;
    const r = applyAction(s, a);
    verdict = judge(p, s, a, r.state, r.events, start);
    s = r.state;
  }
  return verdict;
}

for (const p of puzzles) {
  test(`puzzle ${p.id}: starts with white to act and its solution solves it`, () => {
    assert.equal(getActor(startPuzzle(p)), SOLVER);
    assert.equal(play(p, p.solution), 'solved');
  });

  if (p.goal.type === 'mate') {
    const moves = p.goal.moves;
    test(`puzzle ${p.id}: a forced win in exactly ${moves}, whatever black does`, () => {
      const s = startPuzzle(p);
      assert.ok(forcedWin(s, moves), `no forced win in ${moves}`);
      assert.equal(forcedWin(s, moves - 1), null, `already forced in ${moves - 1}`);
    });
  } else {
    test(`puzzle ${p.id}: every other answer fails`, () => {
      const s = startPuzzle(p);
      const wrong = getLegalActions(s, SOLVER).filter((a) => a.type !== 'resign' && JSON.stringify(a) !== JSON.stringify(p.solution[0]));
      assert.ok(wrong.length > 0);
      for (const a of wrong) assert.equal(play(p, [a]), 'failed', JSON.stringify(a));
    });
  }
}

test('mate puzzles fail once the moves are used up', () => {
  const ladder = puzzles.find((p) => p.id === 'ladder')!;
  const verdict = play(ladder, [
    { type: 'move', player: 'white', from: 'e2', to: 'e3' },
    { type: 'move', player: 'white', from: 'e3', to: 'e4' },
  ]);
  assert.equal(verdict, 'failed');
});
