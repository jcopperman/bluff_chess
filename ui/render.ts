// HTML builders. Every function here takes a player view (never the full
// state) plus UI-only data, and returns markup.

import { CLAIMABLE, PIECE_COUNTS, BACK_FILES } from '../engine/index.ts';
import type { Arrangement, ClaimRecord, ClaimType, Color, GameState, Piece, PieceType, Square } from '../engine/index.ts';
import type { PersonalityConfig, TypeDist } from '../bot/bot.ts';

export const GLYPH: Readonly<Record<PieceType, string>> = { king: '♚', queen: '♛', rook: '♜', bishop: '♝', knight: '♞', pawn: '♟︎' };

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export function typeName(t: PieceType | null | undefined): string {
  return t ? t[0].toUpperCase() + t.slice(1) : 'Unknown';
}

/** The square a back-rank piece started on, from its id ("w-c1" -> "c1"). */
export function originSquare(id: string): Square | null {
  const m = /^[wb]-([a-h][18])$/.exec(id);
  return m ? m[1] : null;
}

function chips(n: number, owner: Color): string {
  const shown = Math.min(n, 12);
  let s = '';
  for (let i = 0; i < shown; i++) s += `<span class="chip chip-${owner}" style="--i:${i}"></span>`;
  return `<span class="chip-stack" aria-label="${n} chips">${s}</span><span class="chip-count">${n}</span>`;
}

// ---------------------------------------------------------------------------
// Board

export interface BoardOptions {
  me: Color;
  selected?: Square | null;
  targets?: Set<Square>;
  captureTargets?: Set<Square>;
  lastMove?: { from: Square; to: Square } | null;
  /** Squares the bot is "hovering" (a tell). */
  hover?: Square[];
  guesses?: Record<string, ClaimType>;
  /** Piece ids to animate flipping face-up. */
  flip?: Set<string>;
  showdownTargets?: Set<Square>;
  checkSquare?: Square | null;
  /** Game over: show every true identity. */
  final?: boolean;
}

/** Works on a player view, or on the full state once the game is over (with opts.final). */
export function boardHTML(view: GameState, opts: BoardOptions): string {
  const bySq: Record<Square, Piece> = {};
  for (const p of view.pieces) if (!p.captured && p.square) bySq[p.square] = p;
  const pendingSqs = view.pending ? [view.pending.from, view.pending.to] : [];
  let html = '';
  for (let r = 7; r >= 0; r--) {
    for (let f = 0; f < 8; f++) {
      const sq = 'abcdefgh'[f] + (r + 1);
      const cls = ['sq', (f + r) % 2 === 0 ? 'dark' : 'light'];
      if (opts.selected === sq) cls.push('selected');
      if (opts.targets?.has(sq)) cls.push(opts.captureTargets?.has(sq) ? 'capture-target' : 'target');
      if (opts.lastMove && (opts.lastMove.from === sq || opts.lastMove.to === sq)) cls.push('last');
      if (pendingSqs.includes(sq)) cls.push('pending');
      if (opts.hover?.includes(sq)) cls.push('bot-hover');
      if (opts.showdownTargets?.has(sq)) cls.push('sd-target');
      if (opts.checkSquare === sq) cls.push('in-check');
      const p = bySq[sq];
      const coordF = r === 0 ? `<span class="coord coord-f">${'abcdefgh'[f]}</span>` : '';
      const coordR = f === 0 ? `<span class="coord coord-r">${r + 1}</span>` : '';
      html += `<div class="${cls.join(' ')}" data-sq="${sq}">${coordF}${coordR}${p ? pieceHTML(p, opts) : ''}</div>`;
    }
  }
  return html;
}

export function pieceHTML(p: Piece, opts: BoardOptions): string {
  const flip = opts.flip?.has(p.id) ? ' flip-in' : '';
  if (p.faceUp && p.type) {
    return `<div class="pc pc-${p.owner}${flip}" data-piece="${p.id}"><span class="glyph">${GLYPH[p.type]}</span></div>`;
  }
  const mine = p.owner === opts.me;
  const known = p.type && (mine || opts.final) ? p.type : null;
  const lying = !!known && !!p.claim && p.claim !== known;
  const cls = ['pc', 'card', `card-${p.owner}`];
  if (mine) cls.push('mine');
  if (opts.final) cls.push('final');
  if (lying) cls.push('liar');
  let inner = known
    ? `<span class="true-type">${GLYPH[known]}</span>`
    : '<span class="card-mark">?</span>';
  if (p.claim) inner += `<span class="badge${lying ? ' badge-lie' : ''}" title="Claims ${typeName(p.claim)}">${GLYPH[p.claim]}</span>`;
  const guess = opts.guesses?.[p.id];
  if (guess && !mine) inner += `<span class="guess" title="Your guess">${GLYPH[guess]}</span>`;
  return `<div class="${cls.join(' ')}${flip}" data-piece="${p.id}">${inner}</div>`;
}

export function capturedTray(view: GameState, owner: Color): string {
  const caps = view.pieces.filter((p) => p.owner === owner && p.captured && p.faceUp && p.type);
  if (!caps.length) return '<span class="tray-empty">no losses</span>';
  return caps.map((p) => `<span class="tray-pc pc-${owner}${p.removed ? ' removed' : ''}" title="${typeName(p.type)}${p.removed ? ' (caught lying)' : ''}">${GLYPH[p.type!]}</span>`).join('');
}

// ---------------------------------------------------------------------------
// Side panels

export interface StripProps {
  name: string;
  avatar: string;
  color: string;
  chipsN: number;
  owner: Color;
  status: string;
  isTurn: boolean;
  tray: string;
}

export function stripHTML({ name, avatar, color, chipsN, owner, status, isTurn, tray }: StripProps): string {
  return `
    <div class="strip-id">
      <span class="avatar" style="--c:${color}">${avatar}</span>
      <div><div class="strip-name">${esc(name)}${isTurn ? ' <span class="turn-dot" title="To act"></span>' : ''}</div>
      <div class="strip-status">${status || ''}</div></div>
    </div>
    <div class="strip-tray">${tray}</div>
    <div class="strip-chips">${chips(chipsN, owner)}</div>`;
}

/** "Knights: 3 claimed / 2 possible" for the opponent's pieces. */
export function trackerHTML(view: GameState, opp: Color): string {
  const rows = CLAIMABLE.map((t) => {
    let claimed = 0, dead = 0;
    for (const p of view.pieces) {
      if (p.owner !== opp || p.promoted) continue;
      if (p.captured && p.faceUp && p.type === t) dead++;
      else if (!p.captured && ((p.faceUp && p.type === t) || (!p.faceUp && p.claim === t))) claimed++;
    }
    const possible = PIECE_COUNTS[t] - dead;
    const over = claimed > possible;
    return `<div class="trk-row${over ? ' over' : ''}">
      <span class="trk-glyph">${GLYPH[t]}</span><span class="trk-name">${typeName(t)}s</span>
      <span class="trk-val"><b>${claimed}</b> claimed / ${possible} possible</span>
      ${over ? '<span class="trk-flag" title="More claims than pieces: someone is lying">LIE!</span>' : ''}
    </div>`;
  }).join('');
  const unclaimed = view.pieces.filter((p) => p.owner === opp && !p.faceUp && !p.claim && !p.captured).length;
  return `${rows}<div class="trk-foot">${unclaimed} unclaimed hidden piece${unclaimed === 1 ? '' : 's'}</div>`;
}

export type LogKind = 'system' | 'move' | 'claim' | 'pass' | 'lie' | 'true' | 'reveal' | 'check' | 'showdown' | 'over';

export interface LogEntry {
  html: string;
  kind: LogKind;
  n?: string;
}

export function logHTML(log: LogEntry[]): string {
  if (!log.length) return '<div class="log-empty">Moves, claims and calls appear here.</div>';
  return log.map((e) => `<div class="log-row log-${e.kind}">${e.n ? `<span class="log-n">${e.n}</span>` : ''}<span>${e.html}</span></div>`).join('');
}

export function tooltipHTML(piece: Piece, dist: TypeDist | undefined, history: ClaimRecord[], guess: ClaimType | undefined): string {
  const rows = CLAIMABLE.filter((t) => dist && dist[t] > 0.001)
    .sort((a, b) => dist![b] - dist![a])
    .map((t) => `<div class="tt-row"><span>${GLYPH[t]} ${typeName(t)}</span><span class="tt-bar"><i style="width:${Math.round(dist![t] * 100)}%"></i></span><span>${Math.round(dist![t] * 100)}%</span></div>`)
    .join('');
  const hist = history.length
    ? history.map((h) => `<div class="tt-hist">Move ${h.fullmove}: claimed ${typeName(h.claim)} (${h.outcome === 'passed' ? 'not called' : h.outcome})</div>`).join('')
    : '<div class="tt-hist">No claims yet: invisible as a threat.</div>';
  return `<div class="tt-title">Hidden piece from ${originSquare(piece.id) || '?'}${piece.claim ? ` · claims ${typeName(piece.claim)}` : ''}</div>
    <div class="tt-sub">Could be (public info):</div>${rows}${hist}
    <div class="tt-foot">${guess ? `Your guess: ${typeName(guess)} · ` : ''}Right-click to mark a guess</div>`;
}

// ---------------------------------------------------------------------------
// Screens

export function menuScreen(): string {
  return `<section class="menu">
    <div class="hero">
      <div class="hero-cards"><span class="pc card card-black"><span class="card-mark">?</span></span><span class="pc pc-white"><span class="glyph">♞</span></span><span class="pc card card-white"><span class="card-mark">?</span><span class="badge">♛</span></span></div>
      <h1>Bluff Chess</h1>
      <p class="tagline">Chess where your pieces are hidden, every move is a claim, and your opponent can call your bluff.</p>
    </div>
    <div class="menu-buttons">
      <button class="btn btn-primary btn-big" data-act="go" data-to="circuit">The Circuit</button>
      <button class="btn btn-big" data-act="go" data-to="free">Free Play</button>
      <button class="btn btn-big" data-act="tutorial">Tutorial</button>
      <button class="btn btn-ghost" data-act="rules">How to play</button>
    </div>
  </section>`;
}

export interface CircuitRecord {
  w: number;
  l: number;
  d: number;
}

function botCard(bot: PersonalityConfig, rec: CircuitRecord | undefined, locked: boolean, i: number): string {
  const r = rec || { w: 0, l: 0, d: 0 };
  return `<button class="bot-card${locked ? ' locked' : ''}" data-act="pick-bot" data-bot="${bot.id}" ${locked ? 'disabled' : ''}>
    <span class="avatar avatar-lg" style="--c:${bot.color}">${locked ? '🔒' : bot.avatar}</span>
    <span class="bot-info">
      <span class="bot-step">Opponent ${i + 1}</span>
      <span class="bot-name">${esc(bot.name)}</span>
      <span class="bot-blurb">${locked ? 'Beat the previous opponent to unlock.' : esc(bot.blurb)}</span>
      ${locked ? '' : `<span class="bot-teaches">Teaches: ${esc(bot.teaches)}</span>`}
    </span>
    <span class="bot-record"><b>${r.w}</b>W <b>${r.l}</b>L <b>${r.d}</b>D</span>
  </button>`;
}

export function circuitScreen({ roster, bots, records, unlocked }: {
  roster: string[]; bots: Record<string, PersonalityConfig>; records: Record<string, CircuitRecord>; unlocked: Set<string>;
}): string {
  return `<section class="panel-screen">
    <div class="screen-head"><button class="btn btn-ghost" data-act="go" data-to="menu">← Back</button><h2>The Circuit</h2></div>
    <p class="screen-sub">Work through the roster. Each opponent has a consistent personality and tells. Learn to read them.</p>
    <div class="bot-list">${roster.map((id, i) => botCard(bots[id], records[id], !unlocked.has(id), i)).join('')}</div>
  </section>`;
}

export interface FreeKnobs {
  bot: string;
  startingChips: number;
  claimLocking: boolean;
  liarPaysChip: boolean;
  chipsOutLoss: boolean;
  oneShowdown: boolean;
}

export function freePlayScreen({ choices, bots, knobs }: {
  choices: string[]; bots: Record<string, PersonalityConfig>; knobs: FreeKnobs;
}): string {
  const opt = (id: string) => `<option value="${id}" ${id === knobs.bot ? 'selected' : ''}>${esc(bots[id].name)}</option>`;
  const chk = (k: keyof FreeKnobs, label: string, help: string) =>
    `<label class="knob"><input type="checkbox" data-knob="${k}" ${knobs[k] ? 'checked' : ''}><span><b>${label}</b><small>${help}</small></span></label>`;
  return `<section class="panel-screen">
    <div class="screen-head"><button class="btn btn-ghost" data-act="go" data-to="menu">← Back</button><h2>Free Play</h2></div>
    <p class="screen-sub">Any unlocked opponent, your rules.</p>
    <div class="free-grid">
      <label class="knob knob-col"><b>Opponent</b><select data-knob="bot">${choices.map(opt).join('')}</select></label>
      <label class="knob knob-col"><b>Starting chips: <span id="chip-val">${knobs.startingChips}</span></b>
        <input type="range" min="1" max="12" value="${knobs.startingChips}" data-knob="startingChips"></label>
      ${chk('claimLocking', 'Claim locking', "A piece's first claim fixes its identity.")}
      ${chk('liarPaysChip', 'Liar pays a chip', 'A caught liar also pays the caller 1 chip.')}
      ${chk('chipsOutLoss', 'Chips-out loss', 'Running out of chips loses the game.')}
      ${chk('oneShowdown', 'One showdown per mate', 'Otherwise unlimited while chips last.')}
    </div>
    <button class="btn btn-primary btn-big" data-act="free-start">Arrange pieces →</button>
  </section>`;
}

export function setupScreen({ arrangement, picked, bot }: { arrangement: Arrangement; picked: number | null; bot: PersonalityConfig }): string {
  const cells = 'abcdefgh'.split('').map((f) => {
    if (f === 'e') return `<div class="setup-sq fixed"><span class="pc pc-white"><span class="glyph">${GLYPH.king}</span></span><small>e1</small></div>`;
    const i = (BACK_FILES as readonly string[]).indexOf(f);
    const t = arrangement[i];
    return `<button class="setup-sq${picked === i ? ' picked' : ''}" data-act="setup-swap" data-i="${i}">
      <span class="pc card card-white mine"><span class="true-type">${GLYPH[t]}</span></span><small>${f}1</small></button>`;
  }).join('');
  const bishopColors = [BACK_FILES[arrangement.indexOf('bishop')], BACK_FILES[arrangement.lastIndexOf('bishop')]]
    .map((f) => ('abcdefgh'.indexOf(f) % 2 === 0 ? 'dark' : 'light'));
  const sameColor = bishopColors[0] === bishopColors[1];
  return `<section class="panel-screen setup">
    <div class="screen-head"><button class="btn btn-ghost" data-act="go" data-to="menu">← Back</button><h2>Secret setup</h2></div>
    <p class="screen-sub">Arrange your seven back-rank pieces. ${esc(bot.name)} will only ever see card backs. Click two pieces to swap them.</p>
    <div class="setup-row">${cells}</div>
    <p class="setup-note">${sameColor ? `Both bishops are on ${bishopColors[0]} squares. Legal, and a little sneaky.` : 'Bishops on opposite colours.'}</p>
    <div class="setup-actions">
      <button class="btn" data-act="setup-classic">Classic</button>
      <button class="btn" data-act="setup-random">Randomize</button>
      <button class="btn btn-primary btn-big" data-act="setup-start">Start match vs ${esc(bot.name)}</button>
    </div>
  </section>`;
}

export function gameShell(bot: PersonalityConfig): string {
  return `<section class="game">
    <div class="board-col">
      <div class="strip strip-opp" id="strip-opp"></div>
      <div class="board-wrap">
        <div class="board" id="board"></div>
        <div class="fx-layer" id="fx-layer"></div>
        <div class="speech hidden" id="speech" style="--c:${bot.color}"></div>
      </div>
      <div class="strip strip-me" id="strip-me"></div>
    </div>
    <aside class="side">
      <div class="action-panel" id="action-panel"></div>
      <div class="card-box"><h3>Claim tracker <small>${esc(bot.name)}'s pieces</small></h3><div id="tracker"></div></div>
      <div class="card-box log-box"><h3>Move log</h3><div class="log" id="log"></div></div>
      <div class="side-foot">
        <button class="btn btn-ghost" data-act="rules">Rules</button>
        <button class="btn btn-ghost btn-danger" data-act="resign">Resign</button>
      </div>
    </aside>
  </section>`;
}

export function rulesHTML(): string {
  return `<div class="rules">
    <h2>How to play</h2>
    <ol>
      <li><b>Setup.</b> Standard chess, but your seven back-rank pieces (2 rooks, 2 knights, 2 bishops, queen) are arranged in secret and are <b>face-down</b> to your opponent. Pawns and kings are always face-up.</li>
      <li><b>Claims.</b> Moving a face-down piece is a <b>claim</b> that it is a rook, knight, bishop or queen. The move only has to be legal for the claimed type. The first claim <b>locks</b>: the piece must keep moving as that type.</li>
      <li><b>Calling.</b> After a face-down piece moves, the opponent may <b>call</b> (bet 1 chip) or pass.<br>
        <span class="rule-lie">Lie caught:</span> the move is undone, the liar is removed, the caller keeps their chip and moves next.<br>
        <span class="rule-true">Claim true:</span> the piece flips face-up, the move stands, and the caller's chip goes to the mover.</li>
      <li><b>The apparent board.</b> Check and mate use claims as if true. An <b>unclaimed</b> face-down piece blocks lines but threatens nothing. A bluffed check is a real check until someone calls it.</li>
      <li><b>Showdown.</b> Checkmated? Spend a chip to expose any claimed face-down enemy piece. If it was lying it's removed, and if that breaks the mate, play on.</li>
      <li><b>Castling</b> counts as the corner piece claiming to be a rook. <b>Captured</b> pieces are revealed. Everything is revealed at the end.</li>
    </ol>
    <p class="rules-tip">You start with 6 chips. Run out and you can't call (or showdown). Read the bot's think time and lines: every character has consistent tells.</p>
    <button class="btn btn-primary" data-act="close-modal">Got it</button>
  </div>`;
}

// ---------------------------------------------------------------------------
// Post-match reveal

/** What the bot believed about one of the player's claims, recorded during the match. */
export interface BeliefSnap {
  fullmove: number;
  pieceId: string;
  claim: ClaimType;
  square: Square;
  dist: TypeDist;
  decision?: 'call' | 'pass';
}

interface ClaimGroup {
  piece: Piece;
  claim: ClaimType;
  first: number;
  moves: number;
  outcome: string;
}

function groupClaims(state: GameState, player: Color): ClaimGroup[] {
  const groups = new Map<string, ClaimGroup>();
  for (const c of state.claims) {
    if (c.player !== player) continue;
    const key = c.pieceId + c.claim;
    const piece = state.pieces.find((p) => p.id === c.pieceId)!;
    const g = groups.get(key) || { piece, claim: c.claim, first: c.fullmove, moves: 0, outcome: 'never called' };
    g.moves++;
    if (c.outcome === 'caught') g.outcome = `caught on move ${c.fullmove}`;
    else if (c.outcome === 'confirmed' && g.outcome === 'never called') g.outcome = `called on move ${c.fullmove}, true`;
    groups.set(key, g);
  }
  for (const sd of state.showdowns) {
    if (sd.player === player) continue;
    const g = groups.get(sd.pieceId + sd.claim);
    if (g && !sd.honest) g.outcome = `exposed in a showdown on move ${sd.fullmove}`;
  }
  return [...groups.values()];
}

function lieList(groups: ClaimGroup[], emptyText: string): string {
  const lies = groups.filter((g) => g.piece.type !== g.claim);
  if (!lies.length) return `<div class="rv-empty">${emptyText}</div>`;
  return lies.map((g) => `<div class="rv-lie ${g.outcome.startsWith('never') ? 'got-away' : 'caught'}">
      <span class="rv-glyphs">${GLYPH[g.piece.type!]}<span class="rv-arrow">→</span>${GLYPH[g.claim]}</span>
      <span>Move ${g.first}: the ${originSquare(g.piece.id) || ''} ${typeName(g.piece.type)} claimed ${typeName(g.claim)}${g.moves > 1 ? ` (${g.moves} moves)` : ''}<small>${g.outcome}</small></span>
    </div>`).join('');
}

function stats(state: GameState, player: Color) {
  const mine = state.claims.filter((c) => c.player === player);
  const theirs = state.claims.filter((c) => c.player !== player && c.outcome !== 'pending');
  const lies = mine.filter((c) => !c.honest).length;
  const calls = theirs.filter((c) => c.called);
  const right = calls.filter((c) => !c.honest).length;
  return { claims: mine.length, lies, caught: mine.filter((c) => c.outcome === 'caught').length, calls: calls.length, right };
}

/** Beliefs worth showing: confident ones and the ones the bot got wrong. */
function pickSnaps(state: GameState, snaps: BeliefSnap[]) {
  const scored = snaps.map((s) => {
    const piece = state.pieces.find((p) => p.id === s.pieceId)!;
    let best: ClaimType = 'rook';
    for (const t of CLAIMABLE) if (s.dist[t] > s.dist[best]) best = t;
    const p = s.dist[best];
    const right = best === piece.type;
    return { ...s, piece, best, p, right, score: (right ? 0 : 1) + p };
  });
  const seen = new Set<string>();
  return scored.sort((a, b) => b.score - a.score).filter((s) => {
    if (seen.has(s.pieceId)) return false;
    seen.add(s.pieceId);
    return true;
  }).slice(0, 6).sort((a, b) => a.fullmove - b.fullmove);
}

export function revealHTML({ state, bot, snaps, me, newlyUnlocked, resultText }: {
  state: GameState; bot: PersonalityConfig; snaps: BeliefSnap[]; me: Color; newlyUnlocked: string[]; resultText: string;
}): string {
  const opp: Color = me === 'white' ? 'black' : 'white';
  const you = stats(state, me);
  const them = stats(state, opp);
  const beliefs = pickSnaps(state, snaps);
  const beliefRows = beliefs.length
    ? beliefs.map((s) => `<div class="rv-belief ${s.right ? 'right' : 'wrong'}">
        <span class="rv-quote">"Move ${s.fullmove}: I was ${Math.round(s.p * 100)}% sure your ${originSquare(s.pieceId) || ''} piece was a ${typeName(s.best)}."</span>
        <small>${s.right ? 'Correct.' : `It was a ${typeName(s.piece.type)}.`} You claimed ${typeName(s.claim)}${s.decision ? `; I ${s.decision === 'call' ? 'called' : 'let it go'}` : ''}.</small>
      </div>`).join('')
    : `<div class="rv-empty">You never made a claim for ${esc(bot.name)} to read.</div>`;

  return `<div class="reveal">
    <div class="rv-head">
      <span class="avatar avatar-lg" style="--c:${bot.color}">${bot.avatar}</span>
      <div><div class="rv-kicker">The reveal</div><h2>${resultText}</h2>
      ${newlyUnlocked.length ? `<div class="rv-unlock">New opponent unlocked: <b>${newlyUnlocked.map(esc).join(', ')}</b></div>` : ''}</div>
    </div>
    <div class="rv-grid">
      <div class="rv-board-col">
        <div class="board board-small">${boardHTML(state, { me, final: true })}</div>
        <div class="rv-legend"><span class="legend-liar"></span> red cards were lying when the game ended</div>
      </div>
      <div class="rv-cols">
        <div class="rv-col">
          <h3>Your lies</h3>
          <div class="rv-stat">${you.claims} claims · ${you.lies} lies · ${you.caught} caught</div>
          ${lieList(groupClaims(state, me), 'Honest all game.')}
          <div class="rv-stat">Your calls: ${you.calls}, ${you.right} correct</div>
        </div>
        <div class="rv-col">
          <h3>${esc(bot.name)}'s lies</h3>
          <div class="rv-stat">${them.claims} claims · ${them.lies} lies · ${them.caught} caught</div>
          ${lieList(groupClaims(state, opp), 'Not a single lie.')}
          <div class="rv-stat">${esc(bot.name)}'s calls: ${them.calls}, ${them.right} correct</div>
        </div>
      </div>
    </div>
    <div class="rv-beliefs"><h3>What ${esc(bot.name)} was thinking</h3>${beliefRows}</div>
    <div class="rv-actions">
      <button class="btn" data-act="close-modal">View board</button>
      <button class="btn" data-act="back">Back</button>
      <button class="btn btn-primary" data-act="rematch">Rematch</button>
    </div>
  </div>`;
}
