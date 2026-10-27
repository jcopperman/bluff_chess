// The in-game coach. Pure functions over the player's view, using only
// public information: the same rule the bots follow.

import {
  getApparentBoard, apparentIfCaught, generateMoves, makeMove, opponent, sqToIdx, idxToSq, inCheck, guardsOf, reaches,
  CLAIMABLE, PIECE_COUNTS,
} from '../engine/index.ts';
import type { Board, ClaimType, Color, Move, MoveAction, PieceType, PlayerView, Square } from '../engine/index.ts';
import { computeBeliefs } from '../bot/belief.ts';

export type AdviceTone = 'info' | 'good' | 'warn' | 'danger';

export interface Advice {
  tone: AdviceTone;
  title: string;
  lines: string[];
  /** Call advice only. */
  lean?: 'call' | 'pass';
  /** Call advice only: public estimate that the claim is a lie. */
  pLie?: number;
}

const VALUE: Record<PieceType, number> = { pawn: 100, knight: 320, bishop: 330, rook: 500, queen: 900, king: 0 };

const NAME = (t: PieceType) => t[0].toUpperCase() + t.slice(1);

const MOVE_RULE: Record<PieceType, string> = {
  king: 'The king moves one square in any direction.',
  queen: 'The queen moves any distance up, down, sideways or diagonally, but can\'t jump over pieces.',
  rook: 'A rook moves any distance up, down or sideways, but can\'t jump over pieces.',
  bishop: 'A bishop moves any distance diagonally, but can\'t jump over pieces.',
  knight: 'A knight jumps in an L shape: two squares one way, then one square sideways. It can jump over pieces.',
  pawn: 'A pawn moves one square forward (two from its starting square) and captures one square diagonally forward.',
};

export function moveRule(t: PieceType): string {
  return MOVE_RULE[t];
}

function epIdx(view: PlayerView): number {
  return view.ep ? sqToIdx(view.ep) : -1;
}

function lineBlocked(board: Board, from: number, to: number): boolean | null {
  const df = (to & 7) - (from & 7), dr = (to >> 3) - (from >> 3);
  const straight = df === 0 || dr === 0;
  const diagonal = Math.abs(df) === Math.abs(dr);
  if (!straight && !diagonal) return null;
  const sf = Math.sign(df), sr = Math.sign(dr);
  let f = (from & 7) + sf, r = (from >> 3) + sr;
  while (f !== (to & 7) || r !== (to >> 3)) {
    if (board[r * 8 + f]) return true;
    f += sf; r += sr;
  }
  return false;
}

function geometryFits(t: PieceType, from: number, to: number): boolean {
  const df = Math.abs((to & 7) - (from & 7)), dr = Math.abs((to >> 3) - (from >> 3));
  switch (t) {
    case 'rook': return df === 0 || dr === 0;
    case 'bishop': return df === dr;
    case 'queen': return df === 0 || dr === 0 || df === dr;
    case 'knight': return (df === 1 && dr === 2) || (df === 2 && dr === 1);
    case 'king': return df <= 1 && dr <= 1;
    default: return df <= 1 && dr <= 2;
  }
}

/** Why can't the selected piece go there? null if the move is legal. */
/** How a piece reads in a sentence: "the bishop on b4", or "the card claiming bishop on b4". */
function describeAt(board: Board, idx: number): string {
  const c = board[idx]!;
  return `the ${c.hidden ? `card claiming ${c.type}` : c.type} on ${idxToSq(idx)}`;
}

/**
 * Why one of your pieces has no legal moves: boxed in, pinned to the king, or unable
 * to answer a check. Short enough for the prompt bar. `squares` are the pieces
 * responsible, for highlighting.
 */
export function whyStuck(view: PlayerView, from: Square): { title: string; text: string; squares: Square[] } | null {
  const me = view.viewer, opp = opponent(me);
  const board = getApparentBoard(view);
  const fi = sqToIdx(from);
  const cell = board[fi];
  if (!cell || cell.color !== me) return null;
  const opts = { claimLocking: view.config.claimLocking };
  const mine = (ms: Move[]) => ms.filter((m) => m.from === fi);
  if (mine(generateMoves(board, me, epIdx(view), opts)).length) return null;
  const what = cell.hidden ? 'card' : cell.type!;
  const enemies: number[] = [];
  board.forEach((c, i) => { if (c && c.color === opp) enemies.push(i); });

  if (cell.type === 'king') return kingStuck(board, fi, me, enemies);
  if (inCheck(board, me)) {
    // Checkers: enemies whose removal ends the check.
    const checkers = enemies.filter((i) => { const b = board.slice(); b[i] = null; return !inCheck(b, me); });
    const by = checkers.length === 1 ? ` from ${describeAt(board, checkers[0])}` : '';
    return { title: "You're in check", text: `Your ${what} can't block the check${by} or capture the attacker.`, squares: checkers.map(idxToSq) };
  }
  if (!mine(generateMoves(board, me, epIdx(view), { ...opts, pseudo: true })).length) {
    return cell.type === 'pawn'
      ? { title: 'Pawn is blocked', text: "A piece stands in front of it, and there's nothing to capture diagonally.", squares: [] }
      : { title: 'Boxed in', text: `Your own pieces cover every square your ${what} could reach.`, squares: [] };
  }
  // Pinned: lifting the piece off the board exposes the king. Find who would give check.
  const lifted = board.slice();
  lifted[fi] = null;
  const pinner = enemies.find((i) => { const b = lifted.slice(); b[i] = null; return inCheck(lifted, me) && !inCheck(b, me); });
  if (pinner !== undefined) {
    return { title: 'Pinned', text: `Moving your ${what} would expose your king to ${describeAt(board, pinner)}.`, squares: [idxToSq(pinner)] };
  }
  return { title: 'No legal moves', text: `Every move your ${what} could make would leave your king in check.`, squares: [] };
}

/** Squares written as "d8", "d8 and f8" or "d8, f8 and f7". */
function listSquares(sqs: Square[]): string {
  return sqs.length < 2 ? sqs.join('') : `${sqs.slice(0, -1).join(', ')} and ${sqs[sqs.length - 1]}`;
}

/** A stuck king: name the squares its own pieces fill and the ones the enemy covers. */
function kingStuck(board: Board, fi: number, me: Color, enemies: number[]): { title: string; text: string; squares: Square[] } {
  const own: Square[] = [];
  const covered = new Map<Square, number[]>();
  const f = fi & 7, r = fi >> 3;
  for (let dr = -1; dr <= 1; dr++) {
    for (let df = -1; df <= 1; df++) {
      const ff = f + df, rr = r + dr;
      if ((!df && !dr) || ff < 0 || ff > 7 || rr < 0 || rr > 7) continue;
      const to = rr * 8 + ff, c = board[to];
      if (c?.color === me) own.push(idxToSq(to));
      else if (c?.type !== 'king') {
        // Who covers it: enemies whose removal makes the step safe.
        const after = makeMove(board, { from: fi, to, type: 'king' });
        covered.set(idxToSq(to), enemies.filter((i) => i !== to && !inCheck(after.map((x, j) => (j === i ? null : x)), me)));
      }
    }
  }
  const check = inCheck(board, me);
  const checkers = check ? enemies.filter((i) => { const b = board.slice(); b[i] = null; return !inCheck(b, me); }) : [];
  const parts: string[] = [];
  if (own.length) parts.push(`${listSquares(own)} ${own.length === 1 ? 'holds' : 'hold'} your own ${own.length === 1 ? 'piece' : 'pieces'}`);
  const byAttacker = new Map<string, Square[]>();
  for (const [sq, by] of covered) {
    const who = by.length !== 1 ? 'more than one enemy piece'
      : checkers.length === 1 && by[0] === checkers[0] ? 'it' : describeAt(board, by[0]);
    byAttacker.set(who, [...(byAttacker.get(who) ?? []), sq]);
  }
  for (const [who, sqs] of byAttacker) parts.push(`${who} covers ${listSquares(sqs)}`);
  const why = parts.length ? `${parts.join('; ')}.` : '';
  const flagged = [...new Set([...covered.values()].flat())].map(idxToSq);
  if (check) {
    const by = checkers.length === 1 ? ` from ${describeAt(board, checkers[0])}` : '';
    return {
      title: "You're in check",
      text: `Your king can't step out of check${by}${why ? `: ${why}` : '.'} Block or capture with another piece.`,
      squares: [...new Set([...checkers.map(idxToSq), ...flagged])],
    };
  }
  return covered.size
    ? { title: 'King has nowhere to go', text: `Every square next to your king is unsafe or taken: ${why}`, squares: flagged }
    : { title: 'Boxed in', text: 'Your own pieces cover every square your king could reach.', squares: [] };
}

export function explainIllegal(view: PlayerView, from: Square, to: Square): string | null {
  const me = view.viewer;
  const board = getApparentBoard(view);
  const fi = sqToIdx(from), ti = sqToIdx(to);
  const cell = board[fi];
  if (!cell || cell.color !== me) return 'Select one of your own pieces first.';
  const locking = view.config.claimLocking;
  const legal = generateMoves(board, me, epIdx(view), { claimLocking: locking });
  if (legal.some((m) => m.from === fi && m.to === ti)) return null;

  const target = board[ti];
  if (target && target.color === me) return 'One of your own pieces is already on that square.';
  if (target && target.type === 'king') return 'Kings are never captured. Checkmate wins instead.';

  const pseudo = generateMoves(board, me, epIdx(view), { claimLocking: locking, pseudo: true });
  if (pseudo.some((m) => m.from === fi && m.to === ti)) {
    return inCheck(board, me)
      ? 'You\'re in check: this move doesn\'t get your king out of it. Move the king, block, or capture the attacker.'
      : 'That would leave your king in check, which is never allowed.';
  }

  const piece = view.pieces.find((p) => p.id === cell.id);
  const real = piece?.type ?? null;
  if (cell.type === 'king' && Math.abs((ti & 7) - (fi & 7)) === 2 && (ti >> 3) === (fi >> 3)) {
    return 'Castling needs the king and that corner piece to be unmoved, the squares between them empty, and the king not in check, passing through check, or landing in check.';
  }
  if (cell.hidden) {
    if (cell.claim && locking) {
      const why = geometryFits(cell.claim, fi, ti) && lineBlocked(board, fi, ti) ? ' Something is blocking the path.' : '';
      return `This card is locked as a ${cell.claim}, so it can only move like one.${why} ${MOVE_RULE[cell.claim]}`;
    }
    const blocked = (['rook', 'bishop', 'queen'] as ClaimType[]).some((t) => geometryFits(t, fi, ti)) && lineBlocked(board, fi, ti);
    return blocked
      ? 'Something is blocking the path.'
      : `No piece type can reach that square from here. (A hidden card may claim to be a rook, knight, bishop or queen${real ? `; yours is really a ${real}` : ''}.)`;
  }
  const t = cell.type!;
  if (t !== 'knight' && t !== 'pawn' && geometryFits(t, fi, ti) && lineBlocked(board, fi, ti)) {
    return `Something is blocking the path. ${MOVE_RULE[t]}`;
  }
  return `A ${t} can't move like that. ${MOVE_RULE[t]}`;
}

// ---------------------------------------------------------------------------
// Blunder guard

function findMove(view: PlayerView, action: MoveAction): Move | undefined {
  const board = getApparentBoard(view);
  return generateMoves(board, view.viewer, epIdx(view), { claimLocking: view.config.claimLocking })
    .find((m) => idxToSq(m.from) === action.from && idxToSq(m.to) === action.to &&
      (m.claim || null) === (action.claim || null) && (m.promo || null) === (action.promotion || null));
}

/** Moves by visible attackers only: unclaimed enemy cards threaten nothing on the apparent board. */
function attackerValues(board: Board, sq: number, by: Color, locking: boolean): number[] {
  return generateMoves(board, by, -1, { claimLocking: locking, pseudo: true })
    .filter((m) => m.to === sq && !(board[m.from]!.hidden && !board[m.from]!.claim))
    .map((m) => (board[m.from]!.type ? VALUE[board[m.from]!.type!] || 1000 : 400));
}

interface Hanging { id: string; square: Square; type: PieceType; loss: number; byPawn: boolean; free: boolean }

function hangingPieces(view: PlayerView, board: Board): Hanging[] {
  const me = view.viewer, opp = opponent(me);
  const locking = view.config.claimLocking;
  const out: Hanging[] = [];
  for (let i = 0; i < 64; i++) {
    const c = board[i];
    if (!c || c.color !== me || c.type === 'king') continue;
    const real = view.pieces.find((p) => p.id === c.id)?.type ?? c.type;
    if (!real) continue;
    const value = VALUE[real];
    const attackers = attackerValues(board, i, opp, locking);
    if (!attackers.length) continue;
    // Defended if one of our pieces could recapture on that square.
    const flipped = board.slice();
    flipped[i] = { ...c, color: opp };
    const defended = generateMoves(flipped, me, -1, { claimLocking: locking, pseudo: true }).some((m) => m.to === i);
    const cheapest = Math.min(...attackers);
    const loss = defended ? value - cheapest : value;
    if (loss >= 150) out.push({ id: c.id, square: idxToSq(i), type: real, loss, byPawn: cheapest === 100, free: !defended });
  }
  return out;
}

/** Warn if a move leaves a piece capturable at a clear loss (visible threats only). */
export function blunderCheck(view: PlayerView, action: MoveAction): Advice | null {
  const m = findMove(view, action);
  if (!m) return null;
  const before = getApparentBoard(view);
  const after = makeMove(before, m);
  const defend = defendRisk(view, m, after);
  if (defend) return defend;
  const already = new Set(hangingPieces(view, before).map((h) => h.id));
  const movedId = before[m.from]!.id;
  const fresh = hangingPieces(view, after).filter((h) => !already.has(h.id) || h.id === movedId);
  if (!fresh.length) return null;
  const worst = fresh.sort((a, b) => b.loss - a.loss)[0];
  const how = worst.free ? 'for free' : worst.byPawn ? 'by a pawn' : 'by a cheaper piece';
  return {
    tone: 'warn',
    title: 'Careful!',
    lines: [`Your ${worst.type} on ${worst.square} can be taken ${how}.`],
  };
}

/** A king move onto a square an unclaimed enemy card could defend, with the public odds that one really does. */
function defendRisk(view: PlayerView, m: Move, after: Board): Advice | null {
  const opp = opponent(view.viewer);
  if (m.type !== 'king' || m.castle || view.chips[opp] <= 0) return null;
  const guards = guardsOf(after, m.to, opp);
  if (!guards.length) return null;
  const probs = computeBeliefs(view).probs;
  let safe = 1;
  for (const g of guards) {
    const dist = probs[after[g]!.id];
    safe *= 1 - CLAIMABLE.reduce((p, t) => p + (reaches(after, g, m.to, t) ? dist?.[t] ?? 0.25 : 0), 0);
  }
  const where = guards.map(idxToSq).join(', ');
  const capture = view.pieces.some((p) => !p.captured && p.square === idxToSq(m.to)) ? ', the capture is undone' : '';
  return {
    tone: 'warn',
    title: 'Careful!',
    lines: [
      `Unclaimed ${guards.length > 1 ? `cards on ${where} could` : `card on ${where} could`} defend ${idxToSq(m.to)}. If one really reaches it, your king goes back${capture}, you pay a chip and lose your turn.`,
      `About ${Math.round((1 - safe) * 100)}% that one does.`,
    ],
  };
}

/** Advice for the defend window: which of your cards really reach the king's square. */
export function defendAdvice(view: PlayerView, opponentName: string): Advice | null {
  const me = view.viewer, opp = opponent(me);
  const pend = view.pending;
  if (view.phase !== 'defendWindow' || !pend || pend.mover !== opp) return null;
  const mid = opponentName.replace(/^The /, 'the ');
  const board = getApparentBoard(view);
  const to = sqToIdx(pend.to);
  const guards = view.pieces.filter((p) => pend.defenders?.includes(p.id) && p.square && p.type && reaches(board, sqToIdx(p.square), to, p.type as ClaimType));
  if (view.chips[me] <= 0) return { tone: 'info', title: 'Coach leans: pass', lines: ['You have no chips, so you can only pass.'], lean: 'pass' };
  if (!guards.length) {
    return {
      tone: 'info', title: 'Coach leans: pass', lean: 'pass',
      lines: [`None of your cards really reach ${pend.to}. Defending would flip the card and hand ${mid} a chip.`],
    };
  }
  const g = guards[0];
  const lines = [`Your hidden ${g.type} on ${g.square} really reaches ${pend.to}. Defend with it and the king goes back${pend.capturedId ? ', your piece returns' : ''} and ${mid} pays you a chip.`];
  const undone = getApparentBoard({ ...view, pieces: view.pieces.map((p) => p.id === pend.pieceId ? { ...p, square: pend.from } : p.id === pend.capturedId ? { ...p, captured: false, square: pend.capturedSquare } : p.id === g.id ? { ...p, faceUp: true } : p) });
  lines.push(inCheck(undone, opp) ? `The king is back in check, so ${mid} must move again.` : `${opponentName} loses the turn.`);
  lines.push('The card flips face-up, so they learn what it is.');
  return { tone: 'good', title: 'Coach: defend', lines };
}

// ---------------------------------------------------------------------------
// Claims and calls

function publicClaimCount(view: PlayerView, owner: Color, t: ClaimType, excludeId?: string): number {
  let n = 0;
  for (const p of view.pieces) {
    if (p.owner !== owner || p.promoted || p.id === excludeId) continue;
    if (p.faceUp && p.type === t) n++;
    else if (!p.faceUp && !p.captured && p.claim === t) n++;
  }
  return n;
}

/** What a claim risks, for the claim picker. */
export function claimAdvice(view: PlayerView, action: MoveAction, opponentName: string): Advice {
  const me = view.viewer, opp = opponent(me);
  const board = getApparentBoard(view);
  const m = findMove(view, action);
  const pieceIdx = m?.castle ? m.castle.rookFrom : sqToIdx(action.from);
  const cell = board[pieceIdx];
  const piece = view.pieces.find((p) => p.id === cell?.id);
  const claim = (action.claim ?? 'rook') as ClaimType;
  const real = piece?.type ?? null;
  const mid = opponentName.replace(/^The /, 'the ');
  const firstClaim = !piece?.claim;
  const lines: string[] = [];

  const oppChips = view.chips[opp];
  const bust = view.config.chipsOutLoss;
  if (real === claim) {
    lines.push(`Honest. If ${mid} calls, the ${claim} flips face-up and you win their chip.`);
    if (bust && oppChips === 1) lines.push(`It's their last chip, so a call would lose them the game. Don't expect one.`);
    if (firstClaim) lines.push(`This locks the piece as a ${NAME(claim)} for the rest of the game.`);
    return { tone: 'good', title: 'Honest claim', lines };
  }

  const count = publicClaimCount(view, me, claim, piece?.id) + 1;
  let tone: AdviceTone = 'warn';
  const pays = view.config.liarPaysChip;
  lines.push(`Bluff: it's really a ${real ?? 'different piece'}. If ${mid} calls, the move is undone, the piece is removed${pays ? ', you pay them a chip' : ''} and you lose your turn.`);
  if (pays && bust && view.chips[me] === 1 && oppChips > 0) {
    tone = 'danger';
    lines.push('You have one chip left. Get caught and you bust, which loses the game.');
  }
  if (count > PIECE_COUNTS[claim]) {
    tone = 'danger';
    lines.push(`${opponentName} can prove this is a lie: that would be ${count} ${NAME(claim)} claims, and only ${PIECE_COUNTS[claim]} exist.`);
  }
  if (oppChips <= 0) {
    tone = 'good';
    lines.push(`${opponentName} has no chips left, so they can't call it!`);
  } else {
    const mine = view.claims.filter((c) => c.player === me && c.outcome !== 'pending');
    const called = mine.filter((c) => c.called).length;
    if (mine.length) lines.push(`${opponentName} has called ${called} of your ${mine.length} claims so far.`);
  }
  if (firstClaim) lines.push(`It stays locked as a "${NAME(claim)}", and every later move it makes can be called too.`);
  return { tone, title: tone === 'danger' ? 'Risky bluff' : 'Bluff', lines };
}

/**
 * A plain-language read on the opponent's pending claim.
 * @param thinkHistory the opponent's earlier think times (ms) for claims, oldest first
 * @param thinkMs think time for the pending claim
 */
export function callAdvice(view: PlayerView, opponentName: string, thinkHistory: number[] = [], thinkMs?: number): Advice | null {
  const me = view.viewer, opp = opponent(me);
  const pend = view.pending;
  if (!pend || pend.mover !== opp || !pend.claim) return null;
  const claim = pend.claim;
  const mid = opponentName.replace(/^The /, 'the ');
  const piece = view.pieces.find((p) => p.id === pend.pieceId);
  if (!piece) return null;
  const beliefs = computeBeliefs(view);
  const pLie = 1 - (beliefs.probs[piece.id]?.[claim] ?? 1);
  const lines: string[] = [];

  const certain = beliefs.certainLies.includes(claim);
  if (certain) {
    const n = publicClaimCount(view, opp, claim);
    lines.push(`Count check: ${n} pieces claim ${NAME(claim)}, but only ${beliefs.remaining[claim]} can still exist. At least one is lying.`);
  }
  const earlier = view.claims.filter((c) => c.pieceId === piece.id && c.outcome === 'passed').length;
  lines.push(earlier ? `This piece has made ${earlier} earlier ${NAME(claim)} move${earlier > 1 ? 's' : ''} that nobody called.` : 'This is the first claim this piece has made.');

  let stakes = 0;
  if (pend.capturedId) {
    const cap = view.pieces.find((p) => p.id === pend.capturedId);
    if (cap?.type) {
      lines.push(`If it's a lie, your captured ${cap.type} comes back.`);
      stakes += VALUE[cap.type] / 300;
    }
  }
  const board = getApparentBoard(view);
  if (inCheck(board, me)) {
    const noMoves = generateMoves(board, me, epIdx(view), { claimLocking: view.config.claimLocking }).length === 0;
    lines.push(noMoves
      ? 'If you pass, you\'re checkmated (you would still get a showdown).'
      : 'It puts you in check.');
    stakes += noMoves ? 4 : 1;
  }
  const caughtBoard = apparentIfCaught(view);
  if (inCheck(caughtBoard, opp)) {
    const mated = generateMoves(caughtBoard, opp, -1, { claimLocking: view.config.claimLocking }).length === 0;
    lines.push(mated
      ? `If it's a lie, undoing it leaves ${mid} in check with no way out: checkmate.`
      : `If it's a lie, undoing it leaves ${mid} in check, and they must move again.`);
    stakes += mated ? 4 : 1;
  }

  const caught = view.claims.filter((c) => c.player === opp && c.outcome === 'caught').length;
  const confirmed = view.claims.filter((c) => c.player === opp && c.outcome === 'confirmed').length;
  if (caught + confirmed) lines.push(`${opponentName}'s called claims so far: ${caught} lie${caught === 1 ? '' : 's'}, ${confirmed} honest.`);

  if (thinkMs != null && thinkHistory.length >= 2) {
    const avg = thinkHistory.reduce((a, b) => a + b, 0) / thinkHistory.length;
    if (thinkMs > avg * 1.4) lines.push(`${opponentName} took longer than usual on this move (${(thinkMs / 1000).toFixed(1)}s against about ${(avg / 1000).toFixed(1)}s).`);
    else if (thinkMs < avg * 0.6) lines.push(`${opponentName} moved faster than usual (${(thinkMs / 1000).toFixed(1)}s against about ${(avg / 1000).toFixed(1)}s).`);
  }

  const chips = view.chips[me];
  const bust = view.config.chipsOutLoss;
  let winsGame = false;
  if (view.config.liarPaysChip && chips > 0) {
    if (bust && view.chips[opp] === 1) {
      lines.push(`${opponentName} is on their last chip. Catch a lie and they bust: you win the game.`);
      winsGame = true;
    } else lines.push(`Catch a lie and ${mid} pays you a chip.`);
  }
  if (chips <= 0) lines.push('You have no chips, so you can only pass.');
  else if (bust && chips === 1) lines.push(`This is your last chip. A wrong call hands it to ${mid} and you bust, which loses the game.`);
  else lines.push(`You have ${chips} chip${chips === 1 ? '' : 's'}. A wrong call hands one to ${mid}.`);

  let lean: 'call' | 'pass';
  if (chips <= 0) lean = 'pass';
  else if (certain && pLie > 0.95) lean = 'call';
  // Last chip against last chip: whoever is wrong loses, so it's a straight coin flip on the lie.
  else if (chips <= 1 && bust && winsGame) lean = pLie > 0.5 ? 'call' : 'pass';
  else if (chips <= 1) lean = pLie > (bust ? 0.8 : 0.6) || stakes >= 4 ? 'call' : 'pass';
  else if (winsGame) lean = pLie > 0.15 ? 'call' : 'pass';
  else lean = pLie > 0.45 || (pLie > 0.2 && stakes >= 1) ? 'call' : 'pass';

  const tone: AdviceTone = lean === 'call' ? 'warn' : 'info';
  return { tone, title: lean === 'call' ? 'Coach leans: call' : 'Coach leans: pass', lines, lean, pLie };
}
