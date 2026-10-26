// How often does a new player beat each bot? Plays a bot against stand-ins for
// a new human player at each difficulty level.
// Usage: npm run difficulty -- <bot id> [games] [easier|normal|harder]
//        (set PROXY=novice or PROXY=casual to run one stand-in only, CHIPS=n to change starting chips)
import { readFileSync } from 'node:fs';
import * as E from '../engine/index.ts';
import { chooseAction, applyDifficulty } from '../bot/bot.ts';
import type { PersonalityConfig } from '../bot/bot.ts';

const load = (id: string) => JSON.parse(readFileSync(new URL(`../data/personalities/${id}.json`, import.meta.url), 'utf8')) as PersonalityConfig;
const VAL: Record<string, number> = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 0 };

/** Novice stand-in: grabs the biggest capture, else random; honest; calls rarely. */
function novice(view: any, rng: any): any {
  const me = view.viewer;
  const acts = E.getLegalActions(view, me).filter((a: any) => a.type !== 'resign');
  if (view.phase === 'callWindow') return rng.chance(0.15) ? acts.find((a: any) => a.type === 'call') ?? acts[0] : acts.find((a: any) => a.type === 'pass');
  if (view.phase === 'showdown') return acts.find((a: any) => a.type === 'showdown') ?? acts.find((a: any) => a.type === 'acceptMate');
  const mine = (sq: string) => view.pieces.find((p: any) => !p.captured && p.square === sq);
  const moves = acts.filter((a: any) => a.type === 'move').filter((a: any) => {
    const p = mine(a.from);
    return !a.claim || p.type === a.claim || !acts.some((b: any) => b.from === a.from && b.to === a.to && b.claim === p.type);
  });
  const honest = moves.filter((a: any) => !a.claim || mine(a.from).type === a.claim);
  const pool = honest.length ? honest : moves;
  const value = (a: any) => { const t = view.pieces.find((p: any) => !p.captured && p.square === a.to); return t ? (t.type ? VAL[t.type] : 4) : 0; };
  const best = Math.max(...pool.map(value));
  const top = best > 0 ? pool.filter((a: any) => value(a) === best) : pool;
  return rng.pick(top);
}

const CASUAL = { id: 'casual', name: 'Casual', title: '', avatar: '', color: '', blurb: '', teaches: '',
  chessStrength: 1, bluffRate: 0.1, callThreshold: 60, chipCaution: 1, mistakeRate: 0.35 };

const chips = process.env.CHIPS ? Number(process.env.CHIPS) : undefined;

function game(botP: any, proxy: 'novice' | 'casual', seed: number): { out: 'W' | 'L' | 'D'; reason: string; calls: number } {
  const rng = E.createRng(seed);
  let s = E.createGame({ startingChips: chips, setups: { white: E.randomArrangement(rng), black: E.randomArrangement(rng) } });
  for (let n = 0; n < 400 && s.phase !== 'over'; n++) {
    const actor = E.getActor(s)!;
    const v = E.getPlayerView(s, actor);
    const a = actor === 'black' ? chooseAction(v, botP, {}, rng)!.action
      : proxy === 'novice' ? novice(v, rng) : chooseAction(v, CASUAL, {}, rng)!.action;
    s = E.applyAction(s, a).state;
  }
  const calls = s.history.filter((a) => a.type === 'call').length;
  const reason = s.result?.reason ?? 'unfinished';
  if (!s.result || !s.result.winner) return { out: 'D', reason, calls };
  return { out: s.result.winner === 'black' ? 'W' : 'L', reason, calls };
}

const id = process.argv[2] ?? 'deacon';
const n = Number(process.argv[3] ?? 16);
for (const level of ['easier', 'normal', 'harder'] as const) {
  if (process.argv[4] && process.argv[4] !== level) continue;
  const p = applyDifficulty(load(id), level);
  for (const proxy of (process.env.PROXY ? [process.env.PROXY] : ['novice', 'casual']) as ('novice' | 'casual')[]) {
    const r = { W: 0, L: 0, D: 0 };
    const reasons: Record<string, number> = {};
    let calls = 0;
    for (let i = 0; i < n; i++) {
      const g = game(p, proxy, 1000 + i);
      r[g.out]++;
      reasons[g.reason] = (reasons[g.reason] ?? 0) + 1;
      calls += g.calls;
    }
    const ends = Object.entries(reasons).map(([k, v]) => `${k} ${v}`).join(', ');
    console.log(`${id.padEnd(8)} ${level.padEnd(7)} vs ${proxy.padEnd(7)}: bot wins ${r.W}, loses ${r.L}, draws ${r.D}  (player win rate ${Math.round(100 * r.L / n)}%)  ends: ${ends}; calls/game ${(calls / n).toFixed(1)}`);
  }
}
