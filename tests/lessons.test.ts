import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyAction, getLegalActions } from '../engine/index.ts';
import type { GameState } from '../engine/index.ts';
import { walkLesson, startStep, matchesExpect, recommended, applyAll, PLAYER } from '../lessons/lessons.ts';
import type { Lesson } from '../lessons/lessons.ts';

const dir = new URL('../data/lessons/', import.meta.url);
const ids = JSON.parse(readFileSync(new URL('index.json', dir), 'utf8')) as string[];
const lessons = ids.map((id) => JSON.parse(readFileSync(new URL(`${id}.json`, dir), 'utf8')) as Lesson);

/** State after completing the first `n` steps of a lesson. */
function afterSteps(lesson: Lesson, n: number): GameState {
  let state: GameState | null = null;
  for (const step of lesson.steps.slice(0, n)) {
    state = startStep(state, step);
    if (step.expect !== 'next') {
      const expect = step.expect;
      const action = getLegalActions(state, PLAYER).find((a) => matchesExpect(a, expect))!;
      state = applyAll(applyAction(state, action).state, step.reply);
    }
  }
  return state!;
}

for (const lesson of lessons) {
  test(`lesson ${lesson.id} can be played start to finish`, () => {
    assert.ok(lesson.steps.length > 0);
    walkLesson(lesson);
  });
}

test('lesson steps: wrong actions do not match', () => {
  const claims = lessons.find((l) => l.id === 'claims')!;
  const step = claims.steps[1];
  assert.equal(matchesExpect({ type: 'move', player: 'white', from: 'b1', to: 'c3', claim: 'knight' }, step.expect), true);
  assert.equal(matchesExpect({ type: 'move', player: 'white', from: 'b1', to: 'c3', claim: 'bishop' }, step.expect), false);
  assert.equal(matchesExpect({ type: 'call', player: 'white' }, step.expect), false);
});

test('lesson outcomes teach what they claim to', () => {
  const byId = (id: string) => lessons.find((l) => l.id === id)!;
  const calling = byId('calling');
  assert.equal(afterSteps(calling, 1).pieces.find((p) => p.id === 'b-g8')!.removed, true);
  assert.equal(afterSteps(calling, 2).chips.white, 5);
  const bluff = byId('bluffing');
  assert.equal(afterSteps(bluff, 1).pieces.find((p) => p.id === 'b-r')!.captured, true);
  assert.equal(afterSteps(bluff, 2).pieces.find((p) => p.id === 'w-c1')!.removed, true);
  assert.deepEqual(afterSteps(byId('check'), 2).result, { winner: 'white', reason: 'checkmate' });
  assert.equal(afterSteps(byId('showdown'), 1).phase, 'showdown');
  assert.equal(afterSteps(byId('showdown'), 2).phase, 'move');
});

test('recommendations follow the first-run profile', () => {
  const moving = lessons.find((l) => l.id === 'moving')!;
  const calling = lessons.find((l) => l.id === 'calling')!;
  const claims = lessons.find((l) => l.id === 'claims')!;
  assert.equal(recommended(moving, { chess: 'confident', poker: 'new' }), false);
  assert.equal(recommended(moving, { chess: 'new', poker: 'confident' }), true);
  assert.equal(recommended(calling, { chess: 'new', poker: 'confident' }), false);
  assert.equal(recommended(claims, { chess: 'confident', poker: 'confident' }), true);
});
