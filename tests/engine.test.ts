import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createGame, applyAction, getLegalActions, getPlayerView, getPublicView, getApparentBoard, getActor,
  inCheck, createRng, randomArrangement, CLASSIC_ARRANGEMENT,
} from '../engine/index.ts';
import type { Action, Arrangement, Color, GameConfig, GameEvent, GameState, Piece, Result, Square } from '../engine/index.ts';

const fixtureDir = fileURLToPath(new URL('./fixtures/', import.meta.url));

interface Fixture {
  name: string;
  config: GameConfig;
  actions: Action[];
  expect: {
    error?: string;
    phase?: GameState['phase'];
    turn?: Color;
    chips?: Partial<Record<Color, number>>;
    result?: Result | null;
    pieces?: Record<string, Partial<Piece>>;
    eventsInclude?: GameEvent['type'][];
    eventsExclude?: GameEvent['type'][];
    legal?: { player: Color; includes?: { from: Square; to: Square }[]; excludes?: { from: Square; to: Square }[] };
  };
}

function runFixture(fx: Fixture) {
  let state = createGame(fx.config);
  let events: { type: string }[] = inCheck(getApparentBoard(state), state.turn) ? [{ type: 'check' }] : [];
  let error: Error | null = null;
  fx.actions.forEach((action, i) => {
    try {
      ({ state, events } = applyAction(state, action));
    } catch (e) {
      if (i !== fx.actions.length - 1 || !fx.expect.error) throw e;
      error = e as Error;
    }
  });
  return { state, events, error: error as Error | null };
}

for (const file of readdirSync(fixtureDir).filter((f) => f.endsWith('.json')).sort()) {
  const fx = JSON.parse(readFileSync(fixtureDir + file, 'utf8')) as Fixture;
  test(`fixture ${file}: ${fx.name}`, () => {
    const { state, events, error } = runFixture(fx);
    const ex = fx.expect;
    if (ex.error) {
      assert.ok(error, `expected error containing "${ex.error}"`);
      assert.match(error.message, new RegExp(ex.error));
      return;
    }
    if (ex.phase) assert.equal(state.phase, ex.phase);
    if (ex.turn) assert.equal(state.turn, ex.turn);
    if (ex.chips) assert.deepEqual(state.chips, { ...state.chips, ...ex.chips });
    if ('result' in ex) assert.deepEqual(state.result, ex.result);
    for (const [id, fields] of Object.entries(ex.pieces || {})) {
      const p = state.pieces.find((x) => x.id === id);
      assert.ok(p, `piece ${id} exists`);
      for (const [k, v] of Object.entries(fields)) assert.deepEqual(p[k as keyof Piece], v, `${id}.${k}`);
    }
    const types = events.map((e) => e.type);
    for (const t of ex.eventsInclude || []) assert.ok(types.includes(t), `event ${t} in [${types}]`);
    for (const t of ex.eventsExclude || []) assert.ok(!types.includes(t), `event ${t} not in [${types}]`);
    if (ex.legal) {
      const acts = getLegalActions(state, ex.legal.player);
      const has = (m: { from: Square; to: Square }) => acts.some((a) => a.type === 'move' && a.from === m.from && a.to === m.to);
      for (const m of ex.legal.includes || []) assert.ok(has(m), `legal ${m.from}-${m.to}`);
      for (const m of ex.legal.excludes || []) assert.ok(!has(m), `illegal ${m.from}-${m.to}`);
    }
  });
}

/** Play a random game, returning the final state. */
function randomGame(seed: number, maxActions = 400): GameState {
  const rng = createRng(seed);
  let state = createGame({ setups: { white: randomArrangement(rng), black: randomArrangement(rng) } });
  for (let i = 0; i < maxActions && state.phase !== 'over'; i++) {
    const actor = getActor(state)!;
    const acts = getLegalActions(state, actor).filter((a) => a.type !== 'resign');
    state = applyAction(state, rng.pick(acts)).state;
  }
  return state;
}

test('determinism: same seed and same actions give an identical final state', () => {
  assert.deepEqual(randomGame(42), randomGame(42));
  assert.notDeepEqual(randomGame(42), randomGame(43));
});

test('replay: the action log reproduces the match', () => {
  const final = randomGame(7);
  // Setups were passed through config, so rebuild them from the back-rank pieces.
  const arr = (c: Color) => ['a', 'b', 'c', 'd', 'f', 'g', 'h']
    .map((f) => final.pieces.find((p) => p.id === `${c[0]}-${f}${c === 'white' ? 1 : 8}`)!.type) as Arrangement;
  let state = createGame({ setups: { white: arr('white'), black: arr('black') } });
  for (const a of final.history) state = applyAction(state, a).state;
  assert.deepEqual(state, final);
});

test('random games never throw and always end in a legal phase', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const s = randomGame(seed, 600);
    assert.ok(['move', 'callWindow', 'showdown', 'over'].includes(s.phase));
  }
});

test('player view hides the opponent\'s face-down identities', () => {
  const state = createGame({ setups: { white: [...CLASSIC_ARRANGEMENT], black: [...CLASSIC_ARRANGEMENT] } });
  const view = getPlayerView(state, 'white');
  for (const p of view.pieces) {
    if (p.owner === 'black' && !p.faceUp) assert.equal(p.type, null);
    if (p.owner === 'white') assert.ok(p.type);
  }
  assert.ok(!JSON.stringify(view.pieces.filter((p) => p.owner === 'black' && !p.faceUp)).includes('queen'));
});

test('player view hides pending honesty and the opponent\'s setup action', () => {
  let state = createGame({});
  state = applyAction(state, { type: 'setup', player: 'white', arrangement: [...CLASSIC_ARRANGEMENT] }).state;
  state = applyAction(state, { type: 'setup', player: 'black', arrangement: [...CLASSIC_ARRANGEMENT] }).state;
  state = applyAction(state, { type: 'move', player: 'white', from: 'b1', to: 'c3', claim: 'knight' }).state;
  const bv = getPlayerView(state, 'black');
  assert.equal(bv.pending!.honest, undefined);
  assert.equal(bv.claims[0].honest, undefined);
  const whiteSetup = bv.history.find((a) => a.player === 'white');
  assert.ok(whiteSetup?.type === 'setup' && whiteSetup.arrangement === undefined);
  const wv = getPlayerView(state, 'white');
  assert.equal(wv.pending!.honest, true);
});

test('legal actions computed from a view match those from the full state', () => {
  const s = randomGame(11, 40);
  const actor = getActor(s);
  if (!actor) return;
  assert.deepEqual(getLegalActions(getPlayerView(s, actor), actor), getLegalActions(s, actor));
});

test('everything is revealed when the game is over', () => {
  let state = createGame({ setups: { white: [...CLASSIC_ARRANGEMENT], black: [...CLASSIC_ARRANGEMENT] } });
  state = applyAction(state, { type: 'resign', player: 'black' }).state;
  const view = getPlayerView(state, 'white');
  assert.ok(view.pieces.every((p) => p.type));
});

test('public view: neither side\'s hidden cards, claim honesty or arrangement', () => {
  // b1 is really a bishop, so the knight claim is a lie.
  let s = createGame({ setups: { white: ['rook', 'bishop', 'knight', 'queen', 'bishop', 'knight', 'rook'], black: [...CLASSIC_ARRANGEMENT] } });
  s = applyAction(s, { type: 'move', player: 'white', from: 'b1', to: 'c3', claim: 'knight' }).state;
  const v = getPublicView(s);
  assert.ok(v.pieces.filter((p) => !p.faceUp).every((p) => p.type === null));
  assert.equal(v.pending?.honest, undefined);
  assert.ok(v.claims.every((c) => c.honest === undefined));
  assert.ok(v.history.every((a) => a.type !== 'setup' || !a.arrangement));
  assert.equal(getApparentBoard(v).filter(Boolean).length, getApparentBoard(s).filter(Boolean).length);
});
