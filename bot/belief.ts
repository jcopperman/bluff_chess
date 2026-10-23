// Belief model: what could each of the opponent's face-down pieces be?
// Uses only public information from a player view.

import { CLAIMABLE, PIECE_COUNTS, opponent } from '../engine/index.ts';
import type { ClaimType, Piece, PlayerView } from '../engine/index.ts';
import type { Beliefs, TypeDist } from './types.ts';

const emptyDist = (): TypeDist => ({ rook: 0, knight: 0, bishop: 0, queen: 0 });

/**
 * Exact posterior over the opponent's hidden pieces, by enumerating every
 * arrangement of the remaining types (at most 7!/(2!2!2!) = 630) and weighting
 * each by how likely the observed claims are.
 *
 * @param opts.honesty P(claim is true) for a single claim, before constraints (default 0.75)
 */
export function computeBeliefs(view: PlayerView, opts: { honesty?: number } = {}): Beliefs {
  const h = opts.honesty ?? 0.75;
  const opp = opponent(view.viewer);
  const remaining: Record<ClaimType, number> = { ...PIECE_COUNTS };
  const hidden: Piece[] = [];
  for (const p of view.pieces) {
    if (p.owner !== opp || p.promoted || p.type === 'king' || p.type === 'pawn') continue;
    if (p.faceUp && p.type) remaining[p.type] -= 1;
    else if (!p.faceUp) hidden.push(p);
  }

  const like = (p: Piece, t: ClaimType) => (!p.claim ? 1 : t === p.claim ? h : (1 - h) / 3);
  const probs: Record<string, TypeDist> = {};
  for (const p of hidden) probs[p.id] = emptyDist();

  const counts = { ...remaining };
  let total = 0;
  const assign: ClaimType[] = new Array(hidden.length);
  const recurse = (i: number, w: number) => {
    if (w === 0) return;
    if (i === hidden.length) {
      total += w;
      for (let j = 0; j < hidden.length; j++) probs[hidden[j].id][assign[j]] += w;
      return;
    }
    for (const t of CLAIMABLE) {
      if (counts[t] <= 0) continue;
      counts[t]--;
      assign[i] = t;
      recurse(i + 1, w * like(hidden[i], t));
      counts[t]++;
    }
  };
  // Counts are an upper bound: custom positions (puzzles, tests) may hold fewer pieces.
  const consistent = CLAIMABLE.every((t) => remaining[t] >= 0) &&
    CLAIMABLE.reduce((s, t) => s + remaining[t], 0) >= hidden.length;
  if (consistent) recurse(0, 1);

  if (total > 0) {
    for (const id in probs) for (const t of CLAIMABLE) probs[id][t] /= total;
  } else {
    // Should not happen; fall back to independent per-piece estimates.
    for (const p of hidden) {
      let z = 0;
      for (const t of CLAIMABLE) z += probs[p.id][t] = like(p, t);
      for (const t of CLAIMABLE) probs[p.id][t] /= z;
    }
  }

  // Claim counts that exceed what can exist mean at least one of those pieces is lying.
  const certainLies: ClaimType[] = [];
  for (const t of CLAIMABLE) {
    const claiming = hidden.filter((p) => p.claim === t);
    if (claiming.length > remaining[t]) certainLies.push(t);
  }
  return { probs, remaining, certainLies, hiddenIds: hidden.map((p) => p.id) };
}

/** P(the piece's current claim is a lie). */
export function lieProbability(beliefs: Beliefs, piece: Piece): number {
  const dist = beliefs.probs[piece.id];
  if (!dist || !piece.claim) return 0;
  return 1 - dist[piece.claim];
}

/** Most likely type and its probability. */
export function topGuess(dist: TypeDist): { type: ClaimType; p: number } {
  let best: ClaimType = 'rook';
  for (const t of CLAIMABLE) if (dist[t] > dist[best]) best = t;
  return { type: best, p: dist[best] };
}
