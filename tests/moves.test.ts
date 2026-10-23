// Move generation, tested three ways:
//  1. Perft: total legal move sequences from standard chess positions, compared
//     with published counts (covers castling, en passant, promotion, pins, checks).
//  2. The same perft driven through the full engine (createGame/applyAction), so
//     state tracking (castling rights, en passant square, captures) is checked too.
//  3. A differential test for hidden pieces: an independent, deliberately simple
//     reference generator in this file must agree with the engine on every
//     position reached in random games with claims, bluffs and claim locking.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, applyAction, getLegalActions, getActor, getApparentBoard, generateMoves, makeMove,
  createRng, randomArrangement, sqToIdx, idxToSq, opponent,
} from '../engine/index.ts';
import type { Board, Cell, ClaimType, Color, GameState, Move, MoveAction, PieceInit, PieceType } from '../engine/index.ts';

// ---------------------------------------------------------------------------
// FEN loading (all pieces face-up: plain chess)

const FEN_TYPES: Record<string, PieceType> = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };

function fenToConfig(fen: string) {
  const [placement, side, castling, ep] = fen.split(' ');
  const pieces: PieceInit[] = [];
  placement.split('/').forEach((row, i) => {
    const rank = 8 - i;
    let file = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) { file += Number(ch); continue; }
      const owner: Color = ch === ch.toUpperCase() ? 'white' : 'black';
      const square = 'abcdefgh'[file] + rank;
      pieces.push({ id: `${owner[0]}${square}`, owner, type: FEN_TYPES[ch.toLowerCase()], square, faceUp: true, hasMoved: true });
      file++;
    }
  });
  // Castling rights: the king and the relevant rook are unmoved.
  const unmoved = (sq: string) => { const p = pieces.find((x) => x.square === sq); if (p) p.hasMoved = false; };
  if (castling.includes('K')) { unmoved('e1'); unmoved('h1'); }
  if (castling.includes('Q')) { unmoved('e1'); unmoved('a1'); }
  if (castling.includes('k')) { unmoved('e8'); unmoved('h8'); }
  if (castling.includes('q')) { unmoved('e8'); unmoved('a8'); }
  // Pawns on their home rank count as unmoved (for the double step).
  for (const p of pieces) if (p.type === 'pawn' && p.square?.[1] === (p.owner === 'white' ? '2' : '7')) p.hasMoved = false;
  return { pieces, turn: (side === 'w' ? 'white' : 'black') as Color, ep: ep === '-' ? null : ep, repetition: false, fiftyMove: false };
}

/** Perft on the board layer (generateMoves + makeMove). */
function perftBoard(board: Board, color: Color, ep: number, depth: number): number {
  const moves = generateMoves(board, color, ep);
  if (depth === 1) return moves.length;
  let n = 0;
  for (const m of moves) n += perftBoard(makeMove(board, m), opponent(color), m.double ? (m.from + m.to) / 2 : -1, depth - 1);
  return n;
}

/** Perft through the full engine: every action applied to a real game state. */
function perftEngine(state: GameState, depth: number): number {
  const actor = getActor(state)!;
  const moves = getLegalActions(state, actor).filter((a) => a.type === 'move');
  if (depth === 1) return moves.length;
  let n = 0;
  for (const a of moves) {
    const next = applyAction(state, a).state;
    n += next.phase === 'over' ? 0 : perftEngine(next, depth - 1);
  }
  return n;
}

// Standard positions and their published perft counts (chessprogramming.org/Perft_Results).
const POSITIONS: { name: string; fen: string; counts: number[] }[] = [
  { name: 'start', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', counts: [20, 400, 8902, 197281] },
  { name: 'kiwipete', fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', counts: [48, 2039, 97862] },
  { name: 'position 3', fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', counts: [14, 191, 2812, 43238] },
  { name: 'position 4', fen: 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', counts: [6, 264, 9467] },
  { name: 'position 5', fen: 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', counts: [44, 1486, 62379] },
  { name: 'position 6', fen: 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10', counts: [46, 2079, 89890] },
];

for (const pos of POSITIONS) {
  test(`perft (board): ${pos.name}`, () => {
    const state = createGame(fenToConfig(pos.fen));
    const board = getApparentBoard(state);
    const ep = state.ep ? sqToIdx(state.ep) : -1;
    pos.counts.forEach((expected, i) => {
      assert.equal(perftBoard(board, state.turn, ep, i + 1), expected, `${pos.name} depth ${i + 1}`);
    });
  });
}

for (const pos of POSITIONS) {
  test(`perft (full engine): ${pos.name}`, () => {
    const state = createGame(fenToConfig(pos.fen));
    // Two plies through applyAction cover castling-right loss, en passant and promotion bookkeeping.
    pos.counts.slice(0, 2).forEach((expected, i) => {
      assert.equal(perftEngine(state, i + 1), expected, `${pos.name} depth ${i + 1}`);
    });
  });
}

test('perft (full engine): start position, depth 3', () => {
  const state = createGame(fenToConfig(POSITIONS[0].fen));
  assert.equal(perftEngine(state, 3), 8902);
});

// ---------------------------------------------------------------------------
// Independent reference generator for the apparent board, hidden pieces included.
// Written for clarity, not speed, and shares no code with engine/moves.ts.

const FILES = 'abcdefgh';
const at = (b: Board, f: number, r: number) => (f >= 0 && f < 8 && r >= 0 && r < 8 ? b[r * 8 + f] : undefined);

/** Can a piece of `type` at (f0,r0) reach (f1,r1) by geometry and clear path? (Pawns handled separately.) */
function reaches(b: Board, type: PieceType, f0: number, r0: number, f1: number, r1: number): boolean {
  const df = f1 - f0, dr = r1 - r0;
  if (df === 0 && dr === 0) return false;
  const clear = () => {
    const sf = Math.sign(df), sr = Math.sign(dr);
    for (let f = f0 + sf, r = r0 + sr; f !== f1 || r !== r1; f += sf, r += sr) if (at(b, f, r)) return false;
    return true;
  };
  switch (type) {
    case 'knight': return (Math.abs(df) === 1 && Math.abs(dr) === 2) || (Math.abs(df) === 2 && Math.abs(dr) === 1);
    case 'king': return Math.abs(df) <= 1 && Math.abs(dr) <= 1;
    case 'rook': return (df === 0 || dr === 0) && clear();
    case 'bishop': return Math.abs(df) === Math.abs(dr) && clear();
    case 'queen': return (df === 0 || dr === 0 || Math.abs(df) === Math.abs(dr)) && clear();
    default: return false;
  }
}

/** Is `color`'s king attacked? Unclaimed face-down cards (type null) attack nothing. */
function kingAttacked(b: Board, color: Color): boolean {
  const k = b.findIndex((c) => c?.color === color && c.type === 'king');
  if (k < 0) return false;
  const kf = k % 8, kr = Math.floor(k / 8);
  for (let i = 0; i < 64; i++) {
    const c = b[i];
    if (!c || c.color === color || !c.type) continue;
    const f = i % 8, r = Math.floor(i / 8);
    if (c.type === 'pawn') {
      const dir = c.color === 'white' ? 1 : -1;
      if (kr === r + dir && Math.abs(kf - f) === 1) return true;
    } else if (reaches(b, c.type, f, r, kf, kr)) return true;
  }
  return false;
}

interface RefMove { from: string; to: string; claim?: ClaimType; promotion?: ClaimType }

function referenceMoves(state: GameState, color: Color): RefMove[] {
  const b = getApparentBoard(state);
  const ep = state.ep ? sqToIdx(state.ep) : -1;
  const locking = state.config.claimLocking;
  const out: RefMove[] = [];
  const add = (from: number, to: number, mover: Cell, asType: PieceType, claim: ClaimType | undefined, extra: (nb: Board) => void = () => {}) => {
    const nb = b.slice();
    nb[from] = null;
    nb[to] = { ...mover, type: asType, hidden: mover.hidden && asType !== 'pawn', hasMoved: true };
    extra(nb);
    if (kingAttacked(nb, color)) return;
    const promoRank = color === 'white' ? 7 : 0;
    if (asType === 'pawn' && Math.floor(to / 8) === promoRank) {
      for (const p of ['queen', 'rook', 'bishop', 'knight'] as ClaimType[]) out.push({ from: idxToSq(from), to: idxToSq(to), promotion: p });
    } else {
      out.push({ from: idxToSq(from), to: idxToSq(to), ...(claim ? { claim } : {}) });
    }
  };
  for (let i = 0; i < 64; i++) {
    const c = b[i];
    if (!c || c.color !== color) continue;
    const f = i % 8, r = Math.floor(i / 8);
    const types: PieceType[] = c.hidden ? (c.claim && locking ? [c.claim] : ['rook', 'knight', 'bishop', 'queen']) : [c.type!];
    for (const t of types) {
      const claim = c.hidden ? (t as ClaimType) : undefined;
      if (t === 'pawn') {
        const dir = color === 'white' ? 1 : -1;
        const one = at(b, f, r + dir);
        if (one === null) {
          add(i, (r + dir) * 8 + f, c, 'pawn', undefined);
          const home = color === 'white' ? 1 : 6;
          if (r === home && at(b, f, r + 2 * dir) === null) add(i, (r + 2 * dir) * 8 + f, c, 'pawn', undefined);
        }
        for (const df of [-1, 1]) {
          const target = at(b, f + df, r + dir);
          const to = (r + dir) * 8 + f + df;
          if (target === undefined) continue;
          if (target && target.color !== color && target.type !== 'king') add(i, to, c, 'pawn', undefined);
          if (target === null && to === ep) add(i, to, c, 'pawn', undefined, (nb) => { nb[r * 8 + f + df] = null; });
        }
        continue;
      }
      for (let to = 0; to < 64; to++) {
        const target = b[to];
        if (target && (target.color === color || target.type === 'king')) continue;
        if (reaches(b, t, f, r, to % 8, Math.floor(to / 8))) add(i, to, c, t, claim);
      }
    }
    // Castling: unmoved king on its home square; the corner piece is a rook or an unclaimed card.
    if (c.type === 'king' && !c.hidden && !c.hasMoved && i === (color === 'white' ? 4 : 60) && !kingAttacked(b, color)) {
      const rank = color === 'white' ? 0 : 7;
      for (const [rf, path, pass, kTo] of [[7, [5, 6], [5, 6], 6], [0, [1, 2, 3], [3, 2], 2]] as [number, number[], number[], number][]) {
        const rc = b[rank * 8 + rf];
        if (!rc || rc.color !== color || rc.hasMoved) continue;
        if (rc.hidden ? rc.claim && rc.claim !== 'rook' : rc.type !== 'rook') continue;
        if (path.some((pf) => b[rank * 8 + pf])) continue;
        const safe = pass.every((pf) => { const nb = b.slice(); nb[i] = null; nb[rank * 8 + pf] = c; return !kingAttacked(nb, color); });
        if (safe) out.push({ from: idxToSq(i), to: FILES[kTo] + (rank + 1), ...(rc.hidden ? { claim: 'rook' as ClaimType } : {}) });
      }
    }
  }
  return out;
}

const key = (m: RefMove) => `${m.from}${m.to}${m.claim ?? ''}${m.promotion ?? ''}`;

function engineMoves(state: GameState, color: Color): RefMove[] {
  return getLegalActions(state, color).filter((a): a is MoveAction => a.type === 'move')
    .map((a) => ({ from: a.from, to: a.to, ...(a.claim ? { claim: a.claim } : {}), ...(a.promotion ? { promotion: a.promotion } : {}) }));
}

function compare(state: GameState, label: string) {
  const color = state.turn;
  const ref = new Set(referenceMoves(state, color).map(key));
  const eng = new Set(engineMoves(state, color).map(key));
  const missing = [...ref].filter((k) => !eng.has(k));
  const extra = [...eng].filter((k) => !ref.has(k));
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, label);
}

for (const locking of [true, false]) {
  test(`hidden pieces: engine matches the reference generator in random games (claim locking ${locking ? 'on' : 'off'})`, () => {
    let positions = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const rng = createRng(seed * 7919);
      let state = createGame({ setups: { white: randomArrangement(rng), black: randomArrangement(rng) }, claimLocking: locking });
      for (let ply = 0; ply < 160 && state.phase !== 'over'; ply++) {
        if (state.phase === 'move') {
          compare(state, `seed ${seed} ply ${ply}`);
          positions++;
        }
        const actor = getActor(state)!;
        const acts = getLegalActions(state, actor).filter((a) => a.type !== 'resign');
        // Pass most claims, so lying pieces survive and keep moving under their claims.
        const pick = acts.find((a) => a.type === 'pass' && rng.chance(0.8)) ?? rng.pick(acts);
        state = applyAction(state, pick).state;
      }
    }
    assert.ok(positions > 2000, `checked ${positions} positions`);
  });
}

// ---------------------------------------------------------------------------
// Targeted cases: pieces keep moving after leaving the back rank.

const classic = (): ClaimType[] => ['rook', 'knight', 'bishop', 'queen', 'bishop', 'knight', 'rook'];

function play(state: GameState, ...actions: Parameters<typeof applyAction>[1][]): GameState {
  for (const a of actions) state = applyAction(state, a).state;
  return state;
}

const targetsFrom = (s: GameState, sq: string) =>
  engineMoves(s, s.turn).filter((m) => m.from === sq).map((m) => m.to).sort();

test('a hidden knight keeps moving after leaving the back rank: passed, called honest, or bluffed', () => {
  const knightFromC3 = ['a4', 'b1', 'b5', 'd5', 'e4'];
  for (const [reply, setup] of [['pass', classic()], ['call', classic()], ['pass', ['rook', 'bishop', 'knight', 'queen', 'bishop', 'knight', 'rook'] as ClaimType[]]] as const) {
    let s = createGame({ setups: { white: [...setup], black: classic() } });
    s = play(s, { type: 'move', player: 'white', from: 'b1', to: 'c3', claim: 'knight' }, { type: reply, player: 'black' }, { type: 'move', player: 'black', from: 'e7', to: 'e5' });
    assert.deepEqual(targetsFrom(s, 'c3'), knightFromC3, `${reply} ${setup[1]}`);
    // And again, several hops in.
    s = play(s, { type: 'move', player: 'white', from: 'c3', to: 'd5', ...(s.pieces.find((p) => p.id === 'w-b1')!.faceUp ? {} : { claim: 'knight' as ClaimType }) });
    if (s.phase === 'callWindow') s = play(s, { type: 'pass', player: 'black' });
    s = play(s, { type: 'move', player: 'black', from: 'h7', to: 'h6' });
    assert.deepEqual(targetsFrom(s, 'd5'), ['b4', 'b6', 'c3', 'c7', 'e3', 'e7', 'f4', 'f6'], `second hop, ${reply}`);
  }
});

test('every claimable type keeps moving under its claim after its first move', () => {
  const routes: { claim: ClaimType; from: string; via: string; pawn?: string; next: string }[] = [
    { claim: 'knight', from: 'g1', via: 'f3', next: 'g5' },
    { claim: 'bishop', from: 'f1', via: 'c4', pawn: 'e2', next: 'b5' },
    { claim: 'queen', from: 'd1', via: 'h5', pawn: 'e2', next: 'h4' },
    { claim: 'rook', from: 'a1', via: 'a3', pawn: 'a2', next: 'h3' },
  ];
  for (const r of routes) {
    let s = createGame({ setups: { white: classic(), black: classic() } });
    if (r.pawn) s = play(s, { type: 'move', player: 'white', from: r.pawn, to: r.pawn[0] + '4' }, { type: 'move', player: 'black', from: 'a7', to: 'a6' });
    s = play(s, { type: 'move', player: 'white', from: r.from, to: r.via, claim: r.claim }, { type: 'pass', player: 'black' }, { type: 'move', player: 'black', from: 'h7', to: 'h6' });
    assert.ok(targetsFrom(s, r.via).includes(r.next), `${r.claim} ${r.via}->${r.next}: [${targetsFrom(s, r.via)}]`);
  }
});

test('after a caught lie elsewhere, the other pieces still move', () => {
  let s = createGame({ setups: { white: ['rook', 'bishop', 'knight', 'queen', 'bishop', 'knight', 'rook'], black: classic() } });
  s = play(s, { type: 'move', player: 'white', from: 'g1', to: 'f3', claim: 'knight' }, { type: 'pass', player: 'black' }, { type: 'move', player: 'black', from: 'e7', to: 'e5' });
  s = play(s, { type: 'move', player: 'white', from: 'b1', to: 'c3', claim: 'knight' }, { type: 'call', player: 'black' }); // b1 is a bishop: caught
  s = play(s, { type: 'move', player: 'black', from: 'd7', to: 'd6' });
  assert.deepEqual(targetsFrom(s, 'f3'), ['d4', 'e5', 'g1', 'g5', 'h4']);
});
