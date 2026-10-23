import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyAction, getPlayerView, CLASSIC_ARRANGEMENT } from '../engine/index.ts';
import type { Arrangement, PieceInit } from '../engine/index.ts';
import { explainIllegal, blunderCheck, claimAdvice, callAdvice } from '../coach/advice.ts';

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
  assert.match(explainIllegal(getPlayerView(s, 'white'), 'c3', 'c5')!, /locked as a Knight/);
});

test('blunderCheck: warns when a piece is left en prise, not for safe moves', () => {
  const s = createGame({ pieces: [P('w-k', 'white', 'king', 'e1'), P('b-k', 'black', 'king', 'h8'), P('w-q', 'white', 'queen', 'd1', { faceUp: true }), P('b-p', 'black', 'pawn', 'e6')] });
  const v = getPlayerView(s, 'white');
  const warn = blunderCheck(v, { type: 'move', player: 'white', from: 'd1', to: 'd5' });
  assert.ok(warn);
  assert.match(warn.lines[0], /Queen on d5 can be taken for free/);
  assert.equal(blunderCheck(v, { type: 'move', player: 'white', from: 'd1', to: 'd2' }), null);
});

test('claimAdvice: honest, bluff, and provable lies', () => {
  const s = createGame({ setups: { white: ['rook', 'bishop', 'knight', 'queen', 'bishop', 'knight', 'rook'] as Arrangement, black: [...CLASSIC_ARRANGEMENT] } });
  const v = getPlayerView(s, 'white');
  assert.equal(claimAdvice(v, { type: 'move', player: 'white', from: 'g1', to: 'f3', claim: 'knight' }, 'Pip').tone, 'good');
  const bluff = claimAdvice(v, { type: 'move', player: 'white', from: 'b1', to: 'c3', claim: 'knight' }, 'Pip');
  assert.equal(bluff.tone, 'warn');
  assert.match(bluff.lines[0], /really a Bishop/);

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
