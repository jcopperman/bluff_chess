// Phase 1 heuristic bot. Sees only a player view: it knows its own pieces,
// never the opponent's hidden ones.

import {
  getApparentBoard, generateMoves, makeMove, opponent, sqToIdx, idxToSq, inCheck,
  randomArrangement, PIECE_COUNTS,
} from '../engine/index.ts';
import type {
  Action, Arrangement, Board, Cell, ClaimType, Color, Move, MoveAction, PieceType, PlayerView, Rng, Square,
} from '../engine/index.ts';
import { computeBeliefs, lieProbability } from './belief.ts';
import { VALUES, MATE, material, search, qsearch } from './evaluate.ts';
import type {
  Beliefs, Decision, GamePhase, LineKey, Personality, PersonalityConfig, Standing, TableImage, ThinkRange, TypeDist,
} from './types.ts';

export type * from './types.ts';

const DEFAULTS: Omit<Personality, 'id' | 'name' | 'title' | 'avatar' | 'color' | 'blurb' | 'teaches'> = {
  chessStrength: 2,
  bluffRate: 0.3,
  bluffContext: {},
  bluffMargin: 30,
  riskTolerance: 300,
  bluffClaims: ['rook', 'knight', 'bishop', 'queen'],
  honestFirstClaims: 0,
  callThreshold: 0,
  chipCaution: 1,
  adaptivity: 0,
  tells: [],
  lines: {},
};

/** Fill personality defaults. */
export function withDefaults(personality: PersonalityConfig): Personality {
  return { ...DEFAULTS, ...personality, bluffContext: { ...(personality.bluffContext || {}) } };
}

// ---------------------------------------------------------------------------
// Reading the opponent (table image)

export interface OpponentModel {
  bluffRate: number;
  callRate: number;
}

/**
 * Estimates about the opponent from cross-match memory plus this match's
 * revealed claims, blended by the bot's adaptivity.
 */
export function opponentModel(view: PlayerView, personality: Personality, memory: Partial<TableImage> = {}): OpponentModel {
  const me = view.viewer;
  // Prefer what the player does in this phase of the game, once there is enough of it.
  const phase: GamePhase = view.fullmove <= 8 ? 'opening' : view.fullmove <= 30 ? 'middlegame' : 'endgame';
  const byPhase = memory.phases?.[phase];
  const usePhase = byPhase && byPhase.claims >= 5;
  let claims = usePhase ? byPhase.claims : memory.claims || 0;
  let lies = usePhase ? byPhase.lies : memory.lies || 0;
  let callOpps = memory.callOpps || 0;
  let calls = memory.calls || 0;
  for (const c of view.claims) {
    if (c.player !== me && c.honest != null) {
      claims++;
      if (!c.honest) lies++;
    }
    if (c.player === me && c.outcome !== 'pending') {
      callOpps++;
      if (c.called) calls++;
    }
  }
  const a = personality.adaptivity;
  const observedBluff = (lies + 1) / (claims + 4);
  const observedCall = (calls + 1) / (callOpps + 4);
  return {
    bluffRate: 0.25 * (1 - a) + observedBluff * a,
    callRate: 0.3 * (1 - a) + observedCall * a,
  };
}

export function beliefsFor(view: PlayerView, personality: PersonalityConfig, memory?: Partial<TableImage>): Beliefs {
  const p = withDefaults(personality);
  const model = opponentModel(view, p, memory);
  return computeBeliefs(view, { honesty: 1 - model.bluffRate });
}

// ---------------------------------------------------------------------------
// Boards

type TrueTypes = Record<string, PieceType | null>;

function expectedValue(dist: TypeDist | undefined): number {
  if (!dist) return 440;
  return dist.rook * VALUES.rook + dist.knight * VALUES.knight + dist.bishop * VALUES.bishop + dist.queen * VALUES.queen;
}

function trueTypesOf(view: PlayerView): TrueTypes {
  const out: TrueTypes = {};
  for (const x of view.pieces) if (x.owner === view.viewer) out[x.id] = x.type;
  return out;
}

/**
 * Convert an apparent board into the bot's search board.
 * Own unclaimed pieces move as their true type (the bot plans honest claims);
 * own claimed pieces keep their claimed geometry but are valued at their true type.
 */
function toSearchBoard(board: Board, me: Color, trueType: TrueTypes, beliefs: Beliefs): Board {
  return board.map((c) => {
    if (!c || !c.hidden) return c;
    if (c.color === me) {
      const t = trueType[c.id] ?? null;
      if (!c.claim) return { ...c, type: t, hidden: false };
      return { ...c, type: c.claim, hidden: false, value: t ? VALUES[t] : undefined };
    }
    // Unclaimed opponent pieces may move or capture as any type, so they stay live.
    return { ...c, value: expectedValue(beliefs.probs[c.id]) };
  });
}

function gamePhase(view: PlayerView, board: Board): GamePhase {
  if (view.fullmove <= 8) return 'opening';
  const pieces = board.filter((c) => c && c.type !== 'pawn' && c.type !== 'king').length;
  return pieces <= 6 ? 'endgame' : 'middlegame';
}

// ---------------------------------------------------------------------------
// Tells

function rangePick(rng: Rng, range: ThinkRange | undefined, fallback: ThinkRange): number {
  const r = range || fallback;
  return Math.round(rng.range(r[0], r[1]));
}

interface TellOutput {
  thinkMs: number;
  line: string | null;
  hover: Square[];
}

/** Turn an honest/bluff decision into consistent, learnable behaviour. */
function applyTells(
  p: Personality, rng: Rng, { callable, bluff, from }: { callable: boolean; bluff: boolean; from: Square }, view: PlayerView,
): TellOutput {
  const out: TellOutput = { thinkMs: 900, line: null, hover: [] };
  for (const tell of p.tells) {
    if (tell.kind === 'thinkTime') {
      const range = !callable ? tell.neutral || tell.honest : bluff ? tell.bluff : tell.honest;
      out.thinkMs = rangePick(rng, range, [700, 1200]);
    } else if (tell.kind === 'dialogue' && callable && rng.chance(tell.chance ?? 0.6)) {
      out.line = rng.pick(bluff ? tell.bluff : tell.honest);
    } else if (tell.kind === 'hover' && callable && bluff === (tell.on === 'bluff')) {
      // Hover a different piece first, then settle on the real one.
      const others = view.pieces.filter((x) => x.owner === view.viewer && !x.captured && x.square && x.square !== from);
      if (others.length) out.hover = [rng.pick(others).square!, from];
    }
  }
  return out;
}

function line(p: Personality, rng: Rng, key: LineKey): string | null {
  const lines = p.lines[key];
  return lines && lines.length ? rng.pick(lines) : null;
}

// ---------------------------------------------------------------------------
// Move choice

interface ScoredMove {
  m: Move;
  score: number;
  ev: number;
  callable: boolean;
  honest: boolean;
  pCall: number;
  cell: Cell;
}

function chooseMove(view: PlayerView, p: Personality, memory: Partial<TableImage>, rng: Rng): Decision {
  const me = view.viewer, opp = opponent(me);
  const model = opponentModel(view, p, memory);
  const beliefs = computeBeliefs(view, { honesty: 1 - model.bluffRate });
  const trueType = trueTypesOf(view);

  const board = getApparentBoard(view);
  const ep = view.ep ? sqToIdx(view.ep) : -1;
  const moves = generateMoves(board, me, ep, { claimLocking: view.config.claimLocking });
  const sBoard = toSearchBoard(board, me, trueType, beliefs);

  const depth = p.chessStrength >= 2 ? 2 : 1;
  const noise = ({ 1: 70, 2: 20, 3: 6 } as Record<number, number>)[p.chessStrength] ?? 20;
  const ctx = { nodes: 0, maxNodes: 120000 };

  // Public claim counts of our own pieces, to spot claims the opponent could prove false.
  const publicCount: Record<ClaimType, number> = { rook: 0, knight: 0, bishop: 0, queen: 0 };
  for (const x of view.pieces) {
    if (x.owner !== me || x.promoted || !x.type || !(x.type in publicCount)) continue;
    if (x.faceUp) publicCount[x.type as ClaimType]++;
    else if (x.claim && !x.captured) publicCount[x.claim]++;
  }

  const oppChips = view.chips[opp];
  const caughtCache: Record<number, number> = {};
  const caughtScore = (pieceIdx: number) => {
    if (!(pieceIdx in caughtCache)) {
      const b = sBoard.slice();
      b[pieceIdx] = null;
      caughtCache[pieceIdx] = -qsearch(b, opp, -MATE - 1, MATE + 1, ctx);
    }
    return caughtCache[pieceIdx];
  };

  const scored: ScoredMove[] = moves.map((m) => {
    const after = makeMove(board, m);
    const sAfter = toSearchBoard(after, me, trueType, beliefs);
    let score = -search(sAfter, opp, depth - 1, -MATE - 1, MATE + 1, m.double ? (m.from + m.to) / 2 : -1, ctx);
    score += rng.range(-noise, noise);

    const pieceIdx = m.castle ? m.castle.rookFrom : m.from;
    const cell = board[pieceIdx]!;
    const callable = cell.hidden;
    const honest = !callable || trueType[cell.id] === m.claim;
    let ev = score;
    let pCall = 0;
    if (callable && m.claim && oppChips > 0) {
      pCall = model.callRate;
      if (m.claim === 'queen') pCall *= 1.5;
      if (board[m.to]) pCall *= 1.3;
      if (inCheck(after, opp)) pCall *= 1.3;
      if (cell.claim !== m.claim && publicCount[m.claim] + 1 > PIECE_COUNTS[m.claim]) pCall = 0.97;
      pCall = Math.min(pCall, 0.97);
      if (honest) ev = score + pCall * 40;
      else ev = (1 - pCall) * score + pCall * caughtScore(pieceIdx);
    }
    return { m, score, ev, callable, honest, pCall, cell };
  });

  // Strong bots look one ply deeper at their best candidates.
  if (p.chessStrength >= 3) {
    const top = scored.slice().sort((a, b) => b.score - a.score).slice(0, 8);
    for (const s of top) {
      const sAfter = toSearchBoard(makeMove(board, s.m), me, trueType, beliefs);
      const deeper = -search(sAfter, opp, 2, -MATE - 1, MATE + 1, s.m.double ? (s.m.from + s.m.to) / 2 : -1, ctx);
      const delta = deeper - s.score;
      s.score += delta;
      s.ev += s.callable && !s.honest ? delta * (1 - s.pCall) : delta;
    }
  }

  const bestBy = (list: ScoredMove[], key: 'ev' | 'score') =>
    list.reduce<ScoredMove | null>((a, b) => (!a || b[key] > a[key] ? b : a), null);
  const ownClaims = view.claims.filter((c) => c.player === me).length;
  const bluffOptions = ownClaims < p.honestFirstClaims ? [] :
    scored.filter((s) => !s.honest && s.m.claim && p.bluffClaims.includes(s.m.claim));
  const H = bestBy(scored.filter((s) => s.honest), 'ev');
  const B = bestBy(bluffOptions, 'score');

  const phase = gamePhase(view, board);
  const diff = material(sBoard, me) - material(sBoard, opp);
  const standing: Standing = diff > 150 ? 'ahead' : diff < -150 ? 'behind' : 'even';
  const ctxMul = (p.bluffContext[phase] ?? 1) * (p.bluffContext[standing] ?? 1);
  const bluffProb = Math.min(0.95, p.bluffRate * ctxMul);

  // A bluff is on the table when the lie costs little position (bluffMargin)
  // and the risk of being called is tolerable; personality and context decide
  // how often the bot takes it. Lies that buy a big edge are twice as tempting.
  let pick = H ?? B;
  if (H && B && B.score >= H.score - p.bluffMargin && B.ev >= H.ev - p.riskTolerance) {
    const tempting = B.score > H.score + 150 ? 2 : 1;
    if (rng.chance(Math.min(0.95, bluffProb * tempting))) pick = B;
  }
  // A legal move always exists in the move phase (otherwise the game is over).
  const chosen = pick!;

  const m = chosen.m;
  const action: MoveAction = { type: 'move', player: me, from: idxToSq(m.from), to: idxToSq(m.to) };
  if (m.claim) action.claim = m.claim;
  if (m.promo) action.promotion = m.promo;
  const tells = applyTells(p, rng, { callable: chosen.callable, bluff: !chosen.honest, from: action.from }, view);
  return { action, ...tells, debug: { bluff: !chosen.honest, ev: Math.round(chosen.ev), phase, standing, nodes: ctx.nodes } };
}

// ---------------------------------------------------------------------------
// Call choice

function chooseCall(view: PlayerView, p: Personality, memory: Partial<TableImage>, rng: Rng): Decision {
  const me = view.viewer;
  const pend = view.pending!;
  const pass: Action = { type: 'pass', player: me };
  const callThink = () => rangePick(rng, p.callThinkMs, [600, 1400]);
  if (view.chips[me] <= 0) return { action: pass, thinkMs: callThink(), line: line(p, rng, 'pass') };

  const model = opponentModel(view, p, memory);
  const beliefs = computeBeliefs(view, { honesty: 1 - model.bluffRate });
  const piece = view.pieces.find((x) => x.id === pend.pieceId)!;
  const pLie = lieProbability(beliefs, piece);

  const trueType = trueTypesOf(view);
  const board = getApparentBoard(view);

  // The position if the lie is caught: the liar is gone, any capture is undone.
  const rb = board.slice();
  rb[sqToIdx(pend.to)] = null;
  if (pend.castle) {
    const k = rb[sqToIdx(pend.castle.kingTo)]!;
    rb[sqToIdx(pend.castle.kingTo)] = null;
    rb[sqToIdx(pend.castle.kingFrom)] = { ...k, hasMoved: pend.castle.kingPrevHasMoved };
  }
  if (pend.capturedId && pend.capturedSquare) {
    const cap = view.pieces.find((x) => x.id === pend.capturedId)!;
    rb[sqToIdx(pend.capturedSquare)] = {
      id: cap.id, color: cap.owner, type: cap.faceUp ? cap.type : cap.claim || null,
      hidden: !cap.faceUp, claim: cap.claim, hasMoved: cap.hasMoved,
    };
  }
  const ctx = { nodes: 0, maxNodes: 60000 };
  const ifPass = search(toSearchBoard(board, me, trueType, beliefs), me, 1, -MATE - 1, MATE + 1, -1, ctx);
  const ifLie = search(toSearchBoard(rb, me, trueType, beliefs), me, 1, -MATE - 1, MATE + 1, -1, ctx);
  const gain = Math.min(3000, Math.max(0, ifLie - ifPass)) + 40;

  const chips = view.chips[me];
  const scarcity = chips <= 1 ? 2.5 : chips <= 3 ? 1.5 : 1;
  const cost = 110 * p.chipCaution * scarcity;
  const ev = pLie * gain - (1 - pLie) * cost;
  const adaptShift = -p.adaptivity * (model.bluffRate - 0.25) * 300;
  const threshold = p.callThreshold + adaptShift + rng.range(-15, 15);
  const call = ev > threshold;
  return {
    action: call ? { type: 'call', player: me } : pass,
    thinkMs: callThink(),
    line: line(p, rng, call ? 'call' : 'pass'),
    debug: { pLie: Math.round(pLie * 100) / 100, gain: Math.round(gain), ev: Math.round(ev), threshold: Math.round(threshold) },
  };
}

// ---------------------------------------------------------------------------
// Showdown choice

function chooseShowdown(view: PlayerView, p: Personality, memory: Partial<TableImage>, rng: Rng): Decision {
  const me = view.viewer, opp = opponent(me);
  const beliefs = beliefsFor(view, p, memory);
  const board = getApparentBoard(view);
  const targets = view.pieces.filter((x) => x.owner === opp && !x.faceUp && x.claim && !x.captured && x.square);
  let best: { id: string; pLie: number } | null = null;
  if (view.chips[me] > 0) {
    for (const t of targets) {
      const b = board.slice();
      b[sqToIdx(t.square!)] = null;
      if (!generateMoves(b, me, -1, { claimLocking: view.config.claimLocking }).length) continue;
      const pLie = lieProbability(beliefs, t);
      if (!best || pLie > best.pLie) best = { id: t.id, pLie };
    }
  }
  const thinkMs = rangePick(rng, p.callThinkMs, [1200, 2000]) + 800;
  if (!best) return { action: { type: 'acceptMate', player: me }, thinkMs, line: line(p, rng, 'lose') };
  return {
    action: { type: 'showdown', player: me, targetPieceId: best.id },
    thinkMs,
    line: line(p, rng, 'showdown'),
  };
}

/** The bot's secret back-rank arrangement. */
export function chooseSetup(personality: PersonalityConfig, rng: Rng): Arrangement {
  return personality.setup ?? randomArrangement(rng);
}

/**
 * The bot's whole decision interface.
 * @param view getPlayerView(state, botColor)
 * @param memory table image of the human, from the UI layer
 * @returns null when it is not the bot's turn to act
 */
export function chooseAction(view: PlayerView, personality: PersonalityConfig, memory: Partial<TableImage>, rng: Rng): Decision | null {
  const p = withDefaults(personality);
  const me = view.viewer;
  if (view.phase === 'setup') {
    return { action: { type: 'setup', player: me, arrangement: chooseSetup(p, rng) }, thinkMs: 0, line: null };
  }
  if (view.phase === 'callWindow' && view.pending && view.pending.mover !== me) return chooseCall(view, p, memory, rng);
  if (view.phase === 'showdown' && view.turn === me) return chooseShowdown(view, p, memory, rng);
  if (view.phase === 'move' && view.turn === me) return chooseMove(view, p, memory, rng);
  return null;
}
