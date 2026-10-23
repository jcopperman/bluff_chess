import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createGame, applyAction, getLegalActions, getPlayerView, getActor, createRng, randomArrangement, CLASSIC_ARRANGEMENT,
} from '../engine/index.ts';
import type { Action, Arrangement, GameState, PlayerView } from '../engine/index.ts';
import { chooseAction } from '../bot/bot.ts';
import type { Decision, PersonalityConfig, TableImage } from '../bot/bot.ts';
import { computeBeliefs } from '../bot/belief.ts';

const load = (id: string) =>
  JSON.parse(readFileSync(new URL(`../data/personalities/${id}.json`, import.meta.url), 'utf8')) as PersonalityConfig;
const sameAction = (a: Action, b: Action) => JSON.stringify(a) === JSON.stringify(b);
const classic = (): Arrangement => [...CLASSIC_ARRANGEMENT];

/** chooseAction, asserting the bot had something to do. */
function decide(view: PlayerView, p: PersonalityConfig, memory: Partial<TableImage>, seed: number | ReturnType<typeof createRng>): Decision {
  const rng = typeof seed === 'number' ? createRng(seed) : seed;
  const d = chooseAction(view, p, memory, rng);
  assert.ok(d, 'bot should act');
  return d;
}

test('fairness: bot decisions do not depend on the opponent\'s hidden arrangement', () => {
  const widow = load('widow');
  const actions: Action[] = [
    { type: 'move', player: 'white', from: 'e2', to: 'e4' },
    { type: 'move', player: 'black', from: 'b8', to: 'c6', claim: 'knight' },
  ];
  const blackSetups: Arrangement[] = [classic(), ['queen', 'knight', 'rook', 'bishop', 'rook', 'knight', 'bishop']];
  const decisions = blackSetups.map((blackSetup) => {
    let s = createGame({ setups: { white: classic(), black: blackSetup } });
    for (const a of actions) s = applyAction(s, a).state;
    return decide(getPlayerView(s, 'white'), widow, {}, 9);
  });
  assert.ok(sameAction(decisions[0].action, decisions[1].action));
  assert.equal(decisions[0].thinkMs, decisions[1].thinkMs);
});

test('bots only ever choose legal actions, through whole games', () => {
  const pairs = [['tutor', 'pip'], ['marlowe', 'sable'], ['widow', 'deacon']];
  pairs.forEach(([w, b], i) => {
    const P = { white: load(w), black: load(b) };
    const rng = createRng(100 + i);
    let s: GameState = createGame({ setups: { white: randomArrangement(rng), black: randomArrangement(rng) } });
    for (let n = 0; n < 300 && s.phase !== 'over'; n++) {
      const actor = getActor(s)!;
      const { action } = decide(getPlayerView(s, actor), P[actor], {}, rng);
      const legal = getLegalActions(s, actor);
      assert.ok(legal.some((a) => sameAction(a, action)), `illegal ${JSON.stringify(action)}`);
      s = applyAction(s, action).state;
    }
  });
});

test('beliefs: a third knight claim is a certain lie', () => {
  let s = createGame({
    pieces: [
      { id: 'w-k', owner: 'white', type: 'king', square: 'e1' },
      { id: 'b-k', owner: 'black', type: 'king', square: 'h8' },
      { id: 'w-b1', owner: 'white', type: 'knight', square: 'b1', faceUp: true, hasMoved: true },
      { id: 'w-g1', owner: 'white', type: 'knight', square: 'g1', faceUp: true, hasMoved: true },
      { id: 'w-c1', owner: 'white', type: 'bishop', square: 'c3' },
    ],
  });
  s = applyAction(s, { type: 'move', player: 'white', from: 'c3', to: 'd5', claim: 'knight' }).state;
  const view = getPlayerView(s, 'black');
  const b = computeBeliefs(view);
  assert.equal(b.probs['w-c1'].knight, 0);
  assert.deepEqual(b.certainLies, ['knight']);
  assert.equal(decide(view, load('sable'), {}, 1).action.type, 'call');
});

test('showdown: a mated bot exposes the piece whose removal breaks the mate', () => {
  let s = createGame({
    pieces: [
      { id: 'w-k', owner: 'white', type: 'king', square: 'a1' },
      { id: 'b-k', owner: 'black', type: 'king', square: 'g8' },
      { id: 'b-pf', owner: 'black', type: 'pawn', square: 'f7' },
      { id: 'b-pg', owner: 'black', type: 'pawn', square: 'g7' },
      { id: 'b-ph', owner: 'black', type: 'pawn', square: 'h7' },
      { id: 'w-d1', owner: 'white', type: 'knight', square: 'd1', claim: 'rook', hasMoved: true },
      { id: 'w-b1', owner: 'white', type: 'bishop', square: 'b2', claim: 'bishop', hasMoved: true },
    ],
  });
  s = applyAction(s, { type: 'move', player: 'white', from: 'd1', to: 'd8', claim: 'rook' }).state;
  s = applyAction(s, { type: 'pass', player: 'black' }).state;
  assert.equal(s.phase, 'showdown');
  const d = decide(getPlayerView(s, 'black'), load('deacon'), {}, 1);
  assert.deepEqual(d.action, { type: 'showdown', player: 'black', targetPieceId: 'w-d1' });
});

test('tells are consistent: the tutor thinks longer before bluffs', () => {
  const tutor = load('tutor');
  const rng = createRng(3);
  const times: { bluff: number[]; honest: number[] } = { bluff: [], honest: [] };
  let s = createGame({ setups: { white: classic(), black: randomArrangement(rng) } });
  for (let n = 0; n < 200 && s.phase !== 'over'; n++) {
    const actor = getActor(s)!;
    const d = decide(getPlayerView(s, actor), tutor, {}, rng);
    if (d.action.type === 'move' && d.action.claim && d.debug) times[d.debug.bluff ? 'bluff' : 'honest'].push(d.thinkMs);
    s = applyAction(s, d.action).state;
  }
  assert.ok(times.bluff.length && times.honest.length);
  assert.ok(Math.min(...times.bluff) > Math.max(...times.honest));
});

test('table image: a bot that remembers a habitual liar calls more', () => {
  const widow = load('widow');
  let s = createGame({ setups: { white: classic(), black: classic() } });
  s = applyAction(s, { type: 'move', player: 'white', from: 'g1', to: 'f3', claim: 'knight' }).state;
  const view = getPlayerView(s, 'black');
  const phases = { opening: { claims: 0, lies: 0 }, middlegame: { claims: 0, lies: 0 }, endgame: { claims: 0, lies: 0 } };
  const liar: Partial<TableImage> = { claims: 40, lies: 30, callOpps: 10, calls: 2, phases };
  const honest: Partial<TableImage> = { claims: 40, lies: 0, callOpps: 10, calls: 2, phases };
  const pLie = (mem: Partial<TableImage>) => decide(view, widow, mem, 5).debug!.pLie!;
  assert.ok(pLie(liar) > pLie(honest) + 0.2);
});
