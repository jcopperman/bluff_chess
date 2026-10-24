import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyAction, getPlayerView, CLASSIC_ARRANGEMENT } from '../engine/index.ts';
import type { Arrangement, PieceInit } from '../engine/index.ts';
import { explainIllegal, whyStuck, blunderCheck, claimAdvice, callAdvice } from '../coach/advice.ts';

const P = (id: string, owner: 'white' | 'black', type: PieceInit['type'], square: string, extra: Partial<PieceInit> = {}): PieceInit =>
  ({ id, owner, type, square, ...extra });

test('explainIllegal: geometry, blocking, own pieces, check', () => {
  const s = createGame({ pieces: [P('w-k', 'white', 'king', 'e1'), P('b-k', 'black', 'king', 'h8'), P('w-r', 'white', 'rook', 'a1', { faceUp: true }), P('w-p', 'white', 'pawn', 'a3')] });
  const v = getPlayerView(s, 'white');
  assert.match(explainIllegal(v, 'a1', 'b2')!, /can't move like that/);
  assert.match(explainIllegal(v, 'a1', 'a5')!, /blocking/);
  assert.match(explainIllegal(v, 'a1', 'a3')!, /own pieces/);
  assert.equal(explainIllegal(v, 'a1', 'a2'), null);

  const checked = createGame({ pieces: [P('w-k', 'white', 'king', 'e1'), P('b-k', 'black', 'king', 'h8'), P('b-r', 'black', 'rook', 'e8', { faceUp: true }), P('w-n', 'white', 'knight', 'b1', { faceUp: true })] });
  assert.match(explainIllegal(getPlayerView(checked, 'white'), 'b1', 'a3')!, /in check/);
});

test('explainIllegal: locked claims', () => {
  let s = createGame({ setups: { white: [...CLASSIC_ARRANGEMENT], black: [...CLASSIC_ARRANGEMENT] } });
  s = applyAction(s, { type: 'move', player: 'white', from: 'b1', to: 'c3', claim: 'knight' }).state;
  s = applyAction(s, { type: 'pass', player: 'black' }).state;
  s = applyAction(s, { type: 'move', player: 'black', from: 'e7', to: 'e5' }).state;
  assert.match(explainIllegal(getPlayerView(s, 'white'), 'c3', 'c5')!, /locked as a knight/);
});

test('blunderCheck: warns when a piece is left en prise, not for safe moves', () => {
  const s = createGame({ pieces: [P('w-k', 'white', 'king', 'e1'), P('b-k', 'black', 'king', 'h8'), P('w-q', 'white', 'queen', 'd1', { faceUp: true }), P('b-p', 'black', 'pawn', 'e6')] });
  const v = getPlayerView(s, 'white');
  const warn = blunderCheck(v, { type: 'move', player: 'white', from: 'd1', to: 'd5' });
  assert.ok(warn);
  assert.match(warn.lines[0], /queen on d5 can be taken for free/);
  assert.equal(blunderCheck(v, { type: 'move', player: 'white', from: 'd1', to: 'd2' }), null);
});

test('claimAdvice: honest, bluff, and provable lies', () => {
  const s = createGame({ setups: { white: ['rook', 'bishop', 'knight', 'queen', 'bishop', 'knight', 'rook'] as Arrangement, black: [...CLASSIC_ARRANGEMENT] } });
  const v = getPlayerView(s, 'white');
  assert.equal(claimAdvice(v, { type: 'move', player: 'white', from: 'g1', to: 'f3', claim: 'knight' }, 'Pip').tone, 'good');
  const bluff = claimAdvice(v, { type: 'move', player: 'white', from: 'b1', to: 'c3', claim: 'knight' }, 'Pip');
  assert.equal(bluff.tone, 'warn');
  assert.match(bluff.lines[0], /really a bishop/);

  const s2 = createGame({ pieces: [P('w-k', 'white', 'king', 'e1'), P('b-k', 'black', 'king', 'h8'),
    P('w-b1', 'white', 'knight', 'b3', { faceUp: true, hasMoved: true }), P('w-g1', 'white', 'knight', 'g3', { claim: 'knight', hasMoved: true }), P('w-c1', 'white', 'bishop', 'c1')] });
  const risky = claimAdvice(getPlayerView(s2, 'white'), { type: 'move', player: 'white', from: 'c1', to: 'd3', claim: 'knight' }, 'Pip');
  assert.equal(risky.tone, 'danger');
});

test('callAdvice: leans call on a provable lie, pass on an ordinary first claim', () => {
  let s = createGame({ turn: 'black', pieces: [P('w-k', 'white', 'king', 'e1'), P('b-k', 'black', 'king', 'h8'),
    P('b-b8', 'black', 'knight', 'b6', { faceUp: true, hasMoved: true }), P('b-g8', 'black', 'knight', 'g6', { faceUp: true, hasMoved: true }), P('b-c8', 'black', 'bishop', 'c8')] });
  s = applyAction(s, { type: 'move', player: 'black', from: 'c8', to: 'd6', claim: 'knight' }).state;
  const sure = callAdvice(getPlayerView(s, 'white'), 'Pip');
  assert.equal(sure?.lean, 'call');
  assert.match(sure!.lines[0], /Count check/);

  let s2 = createGame({ setups: { white: [...CLASSIC_ARRANGEMENT], black: [...CLASSIC_ARRANGEMENT] } });
  s2 = applyAction(s2, { type: 'move', player: 'white', from: 'e2', to: 'e4' }).state;
  s2 = applyAction(s2, { type: 'move', player: 'black', from: 'g8', to: 'f6', claim: 'knight' }).state;
  const calm = callAdvice(getPlayerView(s2, 'white'), 'Pip', [800, 900, 1000], 950);
  assert.equal(calm?.lean, 'pass');
});

test('chip stakes: last-chip bluffs and calls warn about busting', () => {
  const setups = { white: ['rook', 'bishop', 'knight', 'queen', 'bishop', 'knight', 'rook'] as Arrangement, black: [...CLASSIC_ARRANGEMENT] };
  const short = getPlayerView(createGame({ setups, chips: { white: 1 } }), 'white');
  const bluff = claimAdvice(short, { type: 'move', player: 'white', from: 'b1', to: 'c3', claim: 'knight' }, 'Pip');
  assert.equal(bluff.tone, 'danger');
  assert.ok(bluff.lines.some((l) => /bust/.test(l)));

  let s = createGame({ setups, chips: { black: 1 } });
  s = applyAction(s, { type: 'move', player: 'white', from: 'g1', to: 'f3', claim: 'knight' }).state;
  const reply = callAdvice(getPlayerView(s, 'black'), 'Pip');
  assert.ok(reply!.lines.some((l) => /last chip/.test(l)));
  assert.equal(reply!.lean, 'pass');
});

test('callAdvice: catching a lie that escaped mate is checkmate', () => {
  let s = createGame({ turn: 'white', pieces: [P('w-k', 'white', 'king', 'e1'), P('w-r', 'white', 'rook', 'a1', { faceUp: true }),
    P('b-k', 'black', 'king', 'h8'), P('b-pg', 'black', 'pawn', 'g7'), P('b-ph', 'black', 'pawn', 'h7'), P('b-c8', 'black', 'bishop', 'c8')] });
  s = applyAction(s, { type: 'move', player: 'white', from: 'a1', to: 'a8' }).state;
  s = applyAction(s, { type: 'move', player: 'black', from: 'c8', to: 'a8', claim: 'rook' }).state;
  const advice = callAdvice(getPlayerView(s, 'white'), 'Pip');
  assert.ok(advice!.lines.some((l) => /checkmate/.test(l)));
  assert.equal(advice!.lean, 'call');
});

test('whyStuck: pinned, blocked, and in check', () => {
  const base = [P('w-k', 'white', 'king', 'e1'), P('b-k', 'black', 'king', 'h8'), P('w-pd', 'white', 'pawn', 'd2')];
  // A card claiming bishop on b4 pins the d2 pawn to the king.
  const pinned = whyStuck(getPlayerView(createGame({ pieces: [...base, P('b-c8', 'black', 'knight', 'b4', { claim: 'bishop', hasMoved: true })] }), 'white'), 'd2')!;
  assert.equal(pinned.title, 'Pinned');
  assert.match(pinned.text, /card claiming bishop on b4/);
  assert.deepEqual(pinned.squares, ['b4']);

  const blocked = whyStuck(getPlayerView(createGame({ pieces: [...base, P('b-pd', 'black', 'pawn', 'd3')] }), 'white'), 'd2')!;
  assert.equal(blocked.title, 'Pawn is blocked');

  const checked = whyStuck(getPlayerView(createGame({ pieces: [...base, P('b-r', 'black', 'rook', 'e8', { faceUp: true })] }), 'white'), 'd2')!;
  assert.match(checked.text, /rook on e8/);

  assert.equal(whyStuck(getPlayerView(createGame({ pieces: base }), 'white'), 'd2'), null);
});
