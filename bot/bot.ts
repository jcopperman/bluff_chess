// Phase 1 heuristic bot. Sees only a player view: it knows its own pieces,
// never the opponent's hidden ones.

import {
  getApparentBoard, apparentIfCaught, generateMoves, makeMove, opponent, sqToIdx, idxToSq, inCheck,
  randomArrangement, boardKey, reaches, PIECE_COUNTS,
} from '../engine/index.ts';
import type {
  Action, Arrangement, Board, Cell, ClaimType, Color, Move, MoveAction, PieceType, PlayerView, Rng, Square,
} from '../engine/index.ts';
import { computeBeliefs, lieProbability } from './belief.ts';
import { VALUES, MATE, material, search, qsearch } from './evaluate.ts';
import type {
  Beliefs, Decision, Difficulty, GamePhase, LineKey, Personality, PersonalityConfig, Standing, TableImage, ThinkRange, TypeDist,
} from './types.ts';

export type * from './types.ts';

const DEFAULTS: Omit<Personality, 'id' | 'name' | 'title' | 'avatar' | 'color' | 'blurb' | 'teaches'> = {
  chessStrength: 2,
  mistakeRate: 0,
  mistakeWindow: 400,
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

/**
 * Adjust a personality for the player's chosen difficulty. Character (bluffing
 * style, tells) is untouched; only chess strength, mistakes and calling change.
 */
export function applyDifficulty(personality: PersonalityConfig, level: Difficulty): Personality {
  const p = withDefaults(personality);
  if (level === 'easier') {
    return {
      ...p, chessStrength: Math.max(1, p.chessStrength - 1), mistakeRate: Math.min(0.6, p.mistakeRate + 0.2),
      mistakeWindow: Math.max(p.mistakeWindow, 700), callThreshold: p.callThreshold + 80, adaptivity: p.adaptivity / 2,
    };
  }
  if (level === 'harder') {
    return { ...p, chessStrength: Math.min(3, p.chessStrength + 1), mistakeRate: Math.max(0, p.mistakeRate - 0.15), callThreshold: p.callThreshold - 20 };
  }
  if (level === 'expert') {
    // Strength 4 switches on the determinized search below.
    return { ...p, chessStrength: 4, mistakeRate: 0, callThreshold: p.callThreshold - 20 };
  }
  return p;
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
  const noise = ({ 1: 70, 2: 20, 3: 6, 4: 0 } as Record<number, number>)[p.chessStrength] ?? 20;
  const ctx = { nodes: 0, maxNodes: 120000 };

  // Public claim counts of our own pieces, to spot claims the opponent could prove false.
  const publicCount: Record<ClaimType, number> = { rook: 0, knight: 0, bishop: 0, queen: 0 };
  for (const x of view.pieces) {
    if (x.owner !== me || x.promoted || !x.type || !(x.type in publicCount)) continue;
    if (x.faceUp) publicCount[x.type as ClaimType]++;
    else if (x.claim && !x.captured) publicCount[x.claim]++;
  }

  const oppChips = view.chips[opp];
  const liarCost = view.config.liarPaysChip ? chipLoss(view, me, p.chipCaution) : 0;
  const caughtCache: Record<number, number> = {};
  const caughtScore = (pieceIdx: number) => {
    if (!(pieceIdx in caughtCache)) {
      const b = sBoard.slice();
      b[pieceIdx] = null;
      // A caught liar left in check moves again instead of forfeiting the turn.
      caughtCache[pieceIdx] = inCheck(b, me) ? qsearch(b, me, -MATE - 1, MATE + 1, ctx) : -qsearch(b, opp, -MATE - 1, MATE + 1, ctx);
    }
    return caughtCache[pieceIdx];
  };

  const scored: ScoredMove[] = moves.map((m) => {
    const after = makeMove(board, m);
    const sAfter = toSearchBoard(after, me, trueType, beliefs);
    let score: number;
    // The search finds mates by "capturing the king", which can't tell mate from
    // stalemate. Check for real at the root: no legal reply is mate only in check.
    if (generateMoves(after, opp, m.double ? (m.from + m.to) / 2 : -1, { claimLocking: view.config.claimLocking }).length === 0) {
      score = inCheck(after, opp) ? MATE : 0;
    } else {
      score = -search(sAfter, opp, depth - 1, -MATE - 1, MATE + 1, m.double ? (m.from + m.to) / 2 : -1, ctx);
      score += rng.range(-noise, noise);
    }

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
      // Nobody sensible calls with their last chip, so an honest claim won't bait a
      // bust, and a lie is less likely to be called.
      const lastChip = oppChips <= 1 && view.config.chipsOutLoss;
      if (lastChip) pCall *= 0.3;
      if (honest) ev = score + (lastChip ? 0 : pCall * chipGain(view, opp));
      else ev = (1 - pCall) * score + pCall * (caughtScore(pieceIdx) - liarCost);
    }
    return { m, score, ev, callable, honest, pCall, cell };
  });

  // Expert bots search their best candidates across sampled hidden arrangements;
  // strong bots look one ply deeper at them.
  if (p.chessStrength >= 4) refineByDeterminization(view, board, scored, beliefs, trueType, rng);
  else if (p.chessStrength >= 3) {
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
  const honest = scored.filter((s) => s.honest);
  const H = bestBy(honest, 'ev');
  const B = bestBy(bluffOptions, 'score');

  const phase = gamePhase(view, board);
  const diff = material(sBoard, me) - material(sBoard, opp);
  const standing: Standing = diff > 150 ? 'ahead' : diff < -150 ? 'behind' : 'even';
  const ctxMul = (p.bluffContext[phase] ?? 1) * (p.bluffContext[standing] ?? 1);
  const bluffProb = Math.min(0.95, p.bluffRate * ctxMul);

  // A bluff is on the table when the lie costs little position (bluffMargin)
  // and the risk of being called is tolerable; personality and context decide
  // how often the bot takes it. Lies that buy a big edge are twice as tempting.
  // If every legal move is a lie this personality won't normally tell, it still has to move.
  let pick = H ?? B ?? bestBy(scored, 'ev');
  if (H && B && B.score >= H.score - p.bluffMargin && B.ev >= H.ev - p.riskTolerance) {
    const tempting = B.score > H.score + 150 ? 2 : 1;
    if (rng.chance(Math.min(0.95, bluffProb * tempting))) pick = B;
  }
  // Mistakes: sometimes settle for another reasonable honest move instead of the best.
  // "Reasonable" (mistakeWindow) still allows dropping material, which is what
  // makes the early opponents beatable.
  if (pick === H && H && p.mistakeRate > 0 && rng.chance(p.mistakeRate)) {
    const alternatives = honest.filter((s) => s !== H && s.ev >= H.ev - p.mistakeWindow).sort((a, b) => b.ev - a.ev).slice(0, 5);
    if (alternatives.length) pick = rng.pick(alternatives);
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
// Phase 2: determinized search (expert difficulty)
//
// The Phase 1 search treats each unclaimed enemy card as a piece that may move
// as any type, which makes it cautious around every card. Here we sample
// concrete identities for the hidden cards from the belief model, search each
// sampled world a ply deeper with perfect information, and average. Hidden
// information is only ever sampled from public beliefs, never read.

const WORLDS = 6;
const CANDIDATES = 6;
const WORLD_DEPTH = 3;
const WORLD_NODES = 12000;

/** One concrete assignment of true types to the opponent's hidden cards, consistent with the counts. */
export function sampleWorld(beliefs: Beliefs, rng: Rng): Record<string, ClaimType> {
  const left = { ...beliefs.remaining };
  const out: Record<string, ClaimType> = {};
  for (const id of rng.shuffle(beliefs.hiddenIds)) {
    const dist = beliefs.probs[id];
    const options = (['rook', 'knight', 'bishop', 'queen'] as ClaimType[]).filter((t) => left[t] > 0);
    if (!options.length) continue;
    const weights = options.map((t) => (dist ? dist[t] : 1) + 1e-6);
    let r = rng.next() * weights.reduce((a, b) => a + b, 0);
    let pick = options[options.length - 1];
    for (let i = 0; i < options.length; i++) {
      r -= weights[i];
      if (r <= 0) { pick = options[i]; break; }
    }
    out[id] = pick;
    left[pick]--;
  }
  return out;
}

/** The search board for one sampled world: enemy cards move as their claim, or their sampled type when unclaimed. */
function worldBoard(board: Board, me: Color, trueType: TrueTypes, world: Record<string, ClaimType>, beliefs: Beliefs): Board {
  return toSearchBoard(board, me, trueType, beliefs).map((c) => {
    if (!c || c.color === me || !c.hidden) return c;
    const t = world[c.id];
    if (!t) return c;
    return { ...c, type: c.claim ?? t, hidden: false, value: VALUES[t] };
  });
}

function refineByDeterminization(view: PlayerView, board: Board, scored: ScoredMove[], beliefs: Beliefs, trueType: TrueTypes, rng: Rng): void {
  const me = view.viewer, opp = opponent(me);
  const worlds = Array.from({ length: WORLDS }, () => sampleWorld(beliefs, rng));
  const byScore = scored.slice().sort((a, b) => b.score - a.score);
  // The best few moves, plus the best lie so a bluff is judged on the same footing.
  const top = byScore.slice(0, CANDIDATES);
  const lie = byScore.find((s) => !s.honest);
  if (lie && !top.includes(lie)) top.push(lie);
  for (const s of top) {
    if (Math.abs(s.score) >= MATE - 1000) continue;
    const after = makeMove(board, s.m);
    const ep = s.m.double ? (s.m.from + s.m.to) / 2 : -1;
    let total = 0;
    for (const w of worlds) {
      total += -search(worldBoard(after, me, trueType, w, beliefs), opp, WORLD_DEPTH, -MATE - 1, MATE + 1, ep, { nodes: 0, maxNodes: WORLD_NODES });
    }
    const delta = total / worlds.length - s.score;
    s.score += delta;
    s.ev += s.callable && !s.honest ? delta * (1 - s.pCall) : delta;
  }
  // Don't repeat the position when ahead: a third repetition is a draw.
  if (!view.config.repetition) return;
  for (const s of scored) {
    if (s.score <= 50) continue;
    const ep = s.m.double ? idxToSq((s.m.from + s.m.to) / 2) : null;
    const seen = view.positions[boardKey(makeMove(board, s.m), opp, ep)] ?? 0;
    if (!seen) continue;
    const delta = (seen >= 2 ? 0 : s.score - 40) - s.score;
    s.score += delta;
    s.ev += delta;
  }
}

// ---------------------------------------------------------------------------
// Chip stakes

/** Score of busting: as bad as being mated, but kept inside the search's range. */
const BUST = 4000;

/** What it costs `color` to pay one chip; the last chip is the game when busting is on. */
function chipLoss(view: PlayerView, color: 'white' | 'black', caution: number): number {
  const chips = view.chips[color];
  if (view.config.chipsOutLoss && chips <= 1) return BUST;
  const scarcity = chips <= 2 ? 2 : chips <= 3 ? 1.5 : 1;
  return 110 * caution * scarcity;
}

/** What it is worth to take one chip from `from`; their last chip wins the game. */
function chipGain(view: PlayerView, from: 'white' | 'black'): number {
  if (view.config.chipsOutLoss && view.chips[from] <= 1) return BUST;
  return view.chips[from] <= 2 ? 120 : 70;
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
  // Normally we move next; if the liar is left in check, they must move again.
  const opp = opponent(me);
  const rb = apparentIfCaught(view);
  const ctx = { nodes: 0, maxNodes: 60000 };
  const ifPass = search(toSearchBoard(board, me, trueType, beliefs), me, 1, -MATE - 1, MATE + 1, -1, ctx);
  const rbs = toSearchBoard(rb, me, trueType, beliefs);
  const ifLie = !inCheck(rb, opp) ? search(rbs, me, 1, -MATE - 1, MATE + 1, -1, ctx)
    : generateMoves(rb, opp, -1, { claimLocking: view.config.claimLocking }).length === 0 ? MATE
      : -search(rbs, opp, 1, -MATE - 1, MATE + 1, -1, ctx);
  const gain = Math.min(3000, Math.max(0, ifLie - ifPass)) + 40 + (view.config.liarPaysChip ? chipGain(view, opp) : 0);
  const cost = chipLoss(view, me, p.chipCaution);
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
// Defend choice

/**
 * The bot knows its own cards, so a defend is never a guess: flip a card that really
 * reaches the king's square (the least valuable one, to give away the least), else pass.
 */
function chooseDefend(view: PlayerView, p: Personality, rng: Rng): Decision {
  const me = view.viewer;
  const pend = view.pending!;
  const board = getApparentBoard(view);
  const to = sqToIdx(pend.to);
  const thinkMs = rangePick(rng, p.callThinkMs, [600, 1400]);
  const guards = view.chips[me] > 0
    ? view.pieces.filter((x) => pend.defenders?.includes(x.id) && x.square && x.type && reaches(board, sqToIdx(x.square), to, x.type as ClaimType))
    : [];
  if (!guards.length) return { action: { type: 'pass', player: me }, thinkMs, line: null };
  const pick = guards.sort((a, b) => VALUES[a.type!] - VALUES[b.type!])[0];
  return { action: { type: 'defend', player: me, pieceId: pick.id }, thinkMs, line: line(p, rng, 'defend') };
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
  if (view.phase === 'defendWindow' && view.pending && view.pending.mover !== me) return chooseDefend(view, p, rng);
  if (view.phase === 'showdown' && view.turn === me) return chooseShowdown(view, p, memory, rng);
  if (view.phase === 'move' && view.turn === me) return chooseMove(view, p, memory, rng);
  return null;
}
