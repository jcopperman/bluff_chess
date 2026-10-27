// HTML builders. The look is a printed card game: cream stock, black ink, one
// red. Game screens take a player view (never the full state, except the
// post-game reveal) plus UI-only data, and return markup.

import { CLAIMABLE, PIECE_COUNTS, BACK_FILES, generateMoves, sqToIdx, idxToSq } from '../engine/index.ts';
import type { Arrangement, Board, ClaimRecord, ClaimType, Color, GameState, Piece, PieceType, Square } from '../engine/index.ts';
import type { Difficulty, PersonalityConfig, TypeDist } from '../bot/bot.ts';
import type { Advice } from '../coach/advice.ts';
import type { Lesson, Profile } from '../lessons/lessons.ts';
import { outcomeText } from '../daily/daily.ts';
import type { Daily, DailyEntry } from '../daily/daily.ts';
import { pieceSVG } from './art/pieces.ts';
import { emblemSVG, numeral } from './art/emblems.ts';
import type { Mood } from './art/emblems.ts';
import { icon } from './art/icons.ts';

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

/** A small inline piece icon for text (log, tracker, buttons). */
export function pieceIcon(t: PieceType, owner: Color = 'white'): string {
  return `<span class="pi pc-${owner}">${pieceSVG(t)}</span>`;
}

/** A name as it reads mid-sentence: "Chip to the Deacon", not "Chip to The Deacon". */
export function midName(name: string): string {
  return name.replace(/^The /, 'the ');
}

export function codexLink(entry: string, label: string): string {
  return `<a class="codex-link" data-act="codex" data-entry="${entry}">${label}</a>`;
}

/** Codex bodies use data-codex="id" for cross-links; make them clickable. */
function linkify(html: string): string {
  return html.replace(/<a data-codex="([\w-]+)">/g, '<a class="codex-link" data-act="codex" data-entry="$1">');
}

function purse(n: number, owner: Color): string {
  const shown = Math.min(n, 12);
  let s = '';
  for (let i = 0; i < shown; i++) s += `<span class="chip chip-${owner}" style="--i:${i}"></span>`;
  const last = n === 1;
  return `<div class="purse${last ? ' purse-last' : ''}" title="${last ? 'Last chip: one more payment busts' : `${n} chips`}"><span class="chip-stack">${s}</span><span class="purse-count">${n}</span><span class="purse-label">${last ? 'last chip' : `chip${n === 1 ? '' : 's'}`}</span></div>`;
}

// ---------------------------------------------------------------------------
// Top bar

export function hudHTML({ title, back, inGame, muted, coachOn, coachToggle }: {
  title: string; back: string | null; inGame: boolean; muted: boolean; coachOn: boolean; coachToggle: boolean;
}): string {
  return `<div class="hud-left">
      ${back ? `<button class="hud-link hud-back" data-act="${back}">${icon('back')}<span>Back</span></button>` : ''}
      <span class="hud-title">${esc(title)}</span>
    </div>
    <button class="hud-link hud-menu" data-act="hud-menu" aria-expanded="false">Menu</button>
    <nav class="hud-right">
      <button class="hud-link" data-act="codex" data-entry="overview">Rulebook</button>
      ${inGame && coachToggle ? `<button class="hud-link" data-act="toggle-coach">Coach <b>${coachOn ? 'on' : 'off'}</b></button>` : ''}
      ${inGame ? '<button class="hud-link" data-act="copy-game">Copy game</button>' : ''}
      <button class="hud-link" data-act="toggle-mute">Sound <b>${muted ? 'off' : 'on'}</b></button>
      <button class="hud-link" data-act="settings">Settings</button>
    </nav>`;
}

// ---------------------------------------------------------------------------
// Board

export interface BoardOptions {
  me: Color;
  selected?: Square | null;
  targets?: Set<Square>;
  captureTargets?: Set<Square>;
  /** Claim types that can reach each target (coach marking). */
  targetClaims?: Map<Square, ClaimType[]>;
  /** Castling: the king's landing square mapped to the corner piece it brings across. */
  castles?: Map<Square, Square>;
  lastMove?: { from: Square; to: Square } | null;
  hover?: Square[];
  guesses?: Record<string, ClaimType>;
  flip?: Set<string>;
  showdownTargets?: Set<Square>;
  checkSquare?: Square | null;
  /** Lesson highlights. */
  hints?: Square[];
  final?: boolean;
}

/** Rank and file order from the top-left corner, seen from `me`'s side of the table. */
export function boardOrder(me: Color): { ranks: number[]; files: number[] } {
  const up = [0, 1, 2, 3, 4, 5, 6, 7];
  return me === 'black' ? { ranks: up, files: [...up].reverse() } : { ranks: [...up].reverse(), files: up };
}

/** Works on a player view, or on the full state once the game is over (with opts.final). */
export function boardHTML(view: GameState, opts: BoardOptions): string {
  const bySq: Record<Square, Piece> = {};
  for (const p of view.pieces) if (!p.captured && p.square) bySq[p.square] = p;
  const pendingSqs = view.pending ? [view.pending.from, view.pending.to] : [];
  const { ranks, files } = boardOrder(opts.me);
  let html = '';
  for (const r of ranks) {
    for (const f of files) {
      const sq = 'abcdefgh'[f] + (r + 1);
      const cls = ['sq', (f + r) % 2 === 0 ? 'dark' : 'light'];
      let marker = '';
      if (opts.selected === sq) cls.push('selected');
      if (opts.targets?.has(sq)) {
        const claims = opts.targetClaims?.get(sq);
        const capture = opts.captureTargets?.has(sq);
        cls.push(capture ? 'capture-target' : 'target');
        if (claims?.length === 1 && !capture) marker = `<span class="tclaim">${pieceSVG(claims[0])}</span>`;
        else if (!capture) marker = '<span class="tdot"></span>';
        if (opts.castles?.has(sq)) marker = '<span class="tcastle">Castle</span>';
      }
      if ([...(opts.castles?.values() ?? [])].includes(sq)) cls.push('castle-corner');
      if (opts.lastMove && (opts.lastMove.from === sq || opts.lastMove.to === sq)) cls.push('last');
      if (pendingSqs.includes(sq)) cls.push('pending');
      if (opts.hover?.includes(sq)) cls.push('bot-hover');
      if (opts.showdownTargets?.has(sq)) cls.push('sd-target');
      if (opts.checkSquare === sq) cls.push('in-check');
      if (opts.hints?.includes(sq)) cls.push('hint-sq');
      const p = bySq[sq];
      const coordF = r === ranks[7] ? `<span class="coord coord-f">${'abcdefgh'[f]}</span>` : '';
      const coordR = f === files[0] ? `<span class="coord coord-r">${r + 1}</span>` : '';
      html += `<div class="${cls.join(' ')}" data-sq="${sq}">${coordF}${coordR}${p ? pieceHTML(p, opts) : ''}${marker}</div>`;
    }
  }
  return html;
}

export function pieceHTML(p: Piece, opts: Pick<BoardOptions, 'me' | 'flip' | 'guesses' | 'final'>): string {
  const flip = opts.flip?.has(p.id) ? ' flip-in' : '';
  if (p.faceUp && p.type) {
    return `<div class="pc pc-${p.owner}${flip}" data-piece="${p.id}">${pieceSVG(p.type)}</div>`;
  }
  const mine = p.owner === opts.me;
  const known = p.type && (mine || opts.final) ? p.type : null;
  const lying = !!known && !!p.claim && p.claim !== known;
  const cls = ['pc', 'card', `card-${p.owner}`];
  if (mine) cls.push('mine');
  if (opts.final) cls.push('final');
  if (lying) cls.push('liar');
  let inner = known ? `<span class="card-face pc-${p.owner}">${pieceSVG(known)}</span>` : '<span class="card-mark"></span>';
  if (p.claim) inner += `<span class="idx${lying ? ' idx-lie' : ''}" title="Claims ${typeName(p.claim)}">${pieceSVG(p.claim)}</span>`;
  const guess = opts.guesses?.[p.id];
  if (guess && !mine) inner += `<span class="guess" title="Your guess">${pieceSVG(guess)}</span>`;
  return `<div class="${cls.join(' ')}${flip}" data-piece="${p.id}">${inner}</div>`;
}

export function capturedTray(view: GameState, owner: Color): string {
  const caps = view.pieces.filter((p) => p.owner === owner && p.captured && p.faceUp && p.type);
  return caps.map((p) => `<span class="tray-pc pc-${owner}${p.removed ? ' removed' : ''}" title="${typeName(p.type)}${p.removed ? ' (caught lying)' : ''}">${pieceSVG(p.type!)}</span>`).join('');
}

// ---------------------------------------------------------------------------
// Opponent cards

/** `num` is the corner index: a numeral for characters, or a letter (W, B) for human players. */
export function characterCard(bot: PersonalityConfig, num: number | string, opts: { mood?: Mood; active?: boolean; small?: boolean } = {}): string {
  const mood = opts.mood ?? 'neutral';
  const corner = typeof num === 'number' ? numeral(num) : esc(num);
  return `<div class="ccard mood-${mood}${opts.active ? ' active' : ''}${opts.small ? ' small' : ''}">
    <span class="cc-corner cc-tl">${corner}</span><span class="cc-corner cc-br">${corner}</span>
    <div class="cc-emblem">${emblemSVG(bot.id)}</div>
    <div class="cc-name">${esc(bot.name)}</div>
    ${mood === 'caught' ? '<span class="cc-stamp">Caught</span>' : mood === 'beaten' ? '<span class="cc-stamp beaten">Beaten</span>' : ''}
  </div>`;
}

export function cardBack(label = ''): string {
  return `<div class="ccard back"><span class="cb-label">${label}</span></div>`;
}

export function oppPanelHTML({ bot, num, mood, chips, tray, thinking, isTurn, color, status }: {
  bot: PersonalityConfig; num: number | string; mood: Mood; chips: number; tray: string; thinking: boolean; isTurn: boolean; color: Color;
  /** Overrides the turn pill, e.g. "Offline" for a disconnected online opponent. */
  status?: string;
}): string {
  const pill = status ? `<span class="turn-pill muted">${esc(status)}</span>`
    : thinking ? '<span class="turn-pill muted">Thinking<span class="dots"></span></span>' : isTurn ? '<span class="turn-pill muted">To act</span>' : '';
  return `${characterCard(bot, num, { mood, active: isTurn })}
    <div class="seat"><div class="seat-name">${esc(bot.name)}</div><div class="seat-status">${pill}</div></div>
    <div class="seat-row">${purse(chips, color)}</div>
    ${tray ? `<div class="tray"><span class="tray-label">Lost</span>${tray}</div>` : ''}`;
}

export function mePanelHTML({ chips, tray, isTurn, color, name = 'You' }: { chips: number; tray: string; isTurn: boolean; color: Color; name?: string }): string {
  return `<div class="seat"><div class="seat-name">${esc(name)}</div><div class="seat-status">${isTurn ? '<span class="turn-pill">Your turn</span>' : ''}</div></div>
    <div class="seat-row">${purse(chips, color)}</div>
    ${tray ? `<div class="tray"><span class="tray-label">Lost</span>${tray}</div>` : ''}`;
}

/** Opponent claims per type against how many can exist. */
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
    return `<div class="trk-row${over ? ' over' : ''}">${pieceIcon(t, opp)}<span>${typeName(t)}</span><span class="trk-val">${claimed}/${possible}</span></div>`;
  }).join('');
  const unclaimed = view.pieces.filter((p) => p.owner === opp && !p.faceUp && !p.claim && !p.captured).length;
  return `<div class="sheet-head"><span>${codexLink('counting', 'Claim tracker')}</span><small>their claims / possible</small></div>
    <div class="trk-rows">${rows}</div><div class="trk-foot">${unclaimed} unclaimed</div>`;
}

export type LogKind = 'system' | 'move' | 'claim' | 'pass' | 'lie' | 'true' | 'reveal' | 'check' | 'showdown' | 'over';

export interface LogEntry {
  html: string;
  kind: LogKind;
  n?: string;
}

export function logHTML(log: LogEntry[]): string {
  if (!log.length) return '<div class="log-empty">No moves yet.</div>';
  return log.map((e) => `<div class="log-row log-${e.kind}">${e.n ? `<span class="log-n">${e.n}</span>` : ''}<span>${e.html}</span></div>`).join('');
}

export function tooltipHTML(piece: Piece, dist: TypeDist | undefined, history: ClaimRecord[], guess: ClaimType | undefined, touch = false): string {
  const rows = CLAIMABLE.filter((t) => dist && dist[t] > 0.001)
    .sort((a, b) => dist![b] - dist![a])
    .map((t) => `<div class="tt-row">${pieceIcon(t, piece.owner)}<span>${typeName(t)}</span><span class="tt-bar"><i style="width:${Math.round(dist![t] * 100)}%"></i></span><span>${Math.round(dist![t] * 100)}%</span></div>`)
    .join('');
  const hist = history.length
    ? history.map((h) => `<div class="tt-hist">Move ${h.fullmove}: claimed ${typeName(h.claim)}, ${h.outcome === 'passed' ? 'not called' : h.outcome}</div>`).join('')
    : '<div class="tt-hist">No claim yet: it can\'t give check, but it may defend a square against your king.</div>';
  return `<div class="tt-title">Card from ${originSquare(piece.id) || '?'}${piece.claim ? `, claims ${typeName(piece.claim)}` : ''}</div>
    <div class="tt-sub">Could be, from public information:</div>${rows}${hist}
    ${touch
    ? `<div class="tt-foot">Note a guess:</div><div class="tt-marks">${CLAIMABLE.map((t) =>
      `<button class="btn btn-small${guess === t ? ' btn-ink' : ''}" data-act="mark" data-piece="${piece.id}" data-v="${t}" aria-label="${typeName(t)}">${pieceIcon(t)}</button>`).join('')}
      <button class="btn btn-small" data-act="mark" data-piece="${piece.id}" data-v="">Clear</button></div>`
    : `<div class="tt-foot">${guess ? `Your note: ${typeName(guess)}. ` : ''}Right-click to note a guess.</div>`}`;
}

const MARK: Record<Advice['tone'], string> = { info: '☞', good: '✓', warn: '!', danger: '✗' };

export function coachCardHTML(advice: Advice | null, legend: { types: ClaimType[]; multi: boolean } | null): string {
  let body: string;
  if (advice) {
    body = `<div class="coach-title tone-${advice.tone}"><span class="mark">${MARK[advice.tone]}</span>${esc(advice.title)}</div>
      <ul>${advice.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
      ${advice.pLie != null ? `<div class="meter" title="Chance it's a lie, from public information"><span>Lie</span><span class="meter-bar"><i style="width:${Math.round(advice.pLie * 100)}%"></i></span><b>${Math.round(advice.pLie * 100)}%</b></div>` : ''}`;
  } else if (legend?.types.length) {
    body = `<div class="coach-title"><span class="mark">☞</span>Where this card can go</div>
      <p>An unclaimed card may move as any type. Each mark shows the claim that reaches it${legend.multi ? '; a dot means more than one' : ''}.</p>
      <div class="legend">${legend.types.map((t) => `<span>${pieceIcon(t)} ${typeName(t)}</span>`).join('')}</div>`;
  } else {
    body = '<p class="coach-idle">Select a piece to see its moves. I\'ll flag blunders and help with calls.</p>';
  }
  return `<div class="sheet-head"><span>Coach</span></div>${body}`;
}

// ---------------------------------------------------------------------------
// Screens

export function titleScreen(version: string): string {
  return `<section class="title-screen">
    <div class="title-cards" aria-hidden="true">
      <span class="tcard t1">${pieceSVG('knight')}</span><span class="tcard t2 backside"></span><span class="tcard t3">${pieceSVG('queen')}</span>
    </div>
    <h1 class="wordmark">Bluff <span class="red">Chess</span></h1>
    <p class="title-tag">Chess with hidden pieces. Move one and you claim what it is. Your opponent can call your bluff.</p>
    <button class="btn btn-red btn-big" data-act="enter">Play</button>
    ${version ? `<small class="title-version">v${esc(version)}</small>` : ''}
  </section>`;
}

export function hubScreen({ nudge }: { nudge: string | null }): string {
  const card = (act: string, n: string, piece: PieceType, label: string, sub: string) =>
    `<button class="menu-card" data-act="${act}">
      <span class="mc-num">${n}</span><span class="mc-art pc-white">${pieceSVG(piece)}</span>
      <span class="mc-label">${label}</span><span class="mc-sub">${sub}</span></button>`;
  return `<section class="hub">
    <h1 class="wordmark small">Bluff <span class="red">Chess</span></h1>
    <div class="menu-row">
      ${card('go-circuit', 'I', 'king', 'Circuit', 'Five opponents')}
      ${card('go-lessons', 'II', 'pawn', 'Lessons', 'Learn the game')}
      ${card('go-daily', 'III', 'bishop', 'Daily', 'Today’s game')}
      ${card('go-free', 'IV', 'knight', 'Free play', 'Your rules')}
      ${card('go-pvp', 'V', 'queen', 'PvP', 'Play a friend')}
      ${card('codex', 'VI', 'rook', 'Rulebook', 'Rules and pieces')}
    </div>
    ${nudge ? `<p class="nudge">${nudge}</p>` : ''}
  </section>`;
}

export interface CircuitRecord {
  w: number;
  l: number;
  d: number;
}

export function circuitScreen({ roster, bots, records, unlocked, difficulty }: {
  roster: string[]; bots: Record<string, PersonalityConfig>; records: Record<string, CircuitRecord>; unlocked: Set<string>; difficulty: Difficulty;
}): string {
  const items = roster.map((id, i) => {
    const b = bots[id];
    const r = records[id] ?? { w: 0, l: 0, d: 0 };
    if (!unlocked.has(id)) {
      return `<div class="opp-slot locked">${cardBack(numeral(i + 1))}<div class="opp-info"><b>Locked</b><small>Beat the previous opponent.</small></div></div>`;
    }
    return `<button class="opp-slot" data-act="pick-bot" data-bot="${id}">
      ${characterCard(b, i + 1)}
      <div class="opp-info"><b>${esc(b.name)}</b><small>${esc(b.blurb)}</small>
        <span class="opp-teach">${esc(b.teaches)}</span>
        <span class="opp-rec">${r.w > 0 ? '<span class="rec-beaten">Beaten</span>' : ''}${r.w}–${r.l}–${r.d}</span></div>
    </button>`;
  }).join('');
  return `<section class="circuit"><header class="page-head"><h2>Circuit</h2><p>Beat each opponent to unlock the next. Each one has habits you can learn.</p>
      <p class="difficulty-line">Difficulty: <b>${DIFFICULTY_LABEL[difficulty]}</b> <button class="btn btn-small" data-act="settings">Change</button></p></header>
    <div class="opp-row">${items}</div></section>`;
}

export interface FreeKnobs {
  bot: string;
  startingChips: number;
  claimLocking: boolean;
  liarPaysChip: boolean;
  chipsOutLoss: boolean;
  oneShowdown: boolean;
}

export function freePlayScreen({ choices, bots, knobs, numbers }: {
  choices: string[]; bots: Record<string, PersonalityConfig>; knobs: FreeKnobs; numbers: Record<string, number>;
}): string {
  const who = choices.map((id) => `<button class="pick${id === knobs.bot ? ' on' : ''}" data-act="free-bot" data-bot="${id}">
      ${characterCard(bots[id], numbers[id], { small: true })}</button>`).join('');
  const chk = (k: keyof FreeKnobs, label: string, help: string) =>
    `<label class="rule"><input type="checkbox" data-knob="${k}" ${knobs[k] ? 'checked' : ''}><span class="box"></span><span><b>${label}</b><small>${help}</small></span></label>`;
  return `<section class="free"><header class="page-head"><h2>Free play</h2><p>Pick an opponent and set the rules.</p></header>
    <div class="free-body">
      <div class="picks">${who}</div>
      <div class="sheet rules-sheet">
        <label class="rule rule-range"><span><b>Starting chips: <span id="chip-val">${knobs.startingChips}</span></b><small>Fewer chips make every call riskier, so bluffs are safer.</small></span>
          <input type="range" min="1" max="5" value="${knobs.startingChips}" data-knob="startingChips"></label>
        ${chk('claimLocking', 'Claim locking', "A piece's first claim fixes its identity.")}
        ${chk('liarPaysChip', 'Liars pay', 'A caught liar pays the caller 1 chip. Off: only wrong calls cost chips.')}
        ${chk('chipsOutLoss', 'Bust at zero chips', 'Running out of chips loses the game.')}
        ${chk('oneShowdown', 'One showdown per mate', 'Otherwise unlimited while chips last.')}
        <button class="btn btn-red" data-act="free-start">Continue</button>
      </div>
    </div></section>`;
}

const AUDIENCE: Record<Lesson['audience'], string> = { chess: 'Chess', poker: 'Bluffing', everyone: 'Bluff Chess' };

export function lessonsScreen({ lessons, done, isRecommended, profile }: {
  lessons: Lesson[]; done: Set<string>; isRecommended: (l: Lesson) => boolean; profile: Profile | null;
}): string {
  const rows = lessons.map((l, i) => {
    const rec = isRecommended(l) && !done.has(l.id);
    return `<button class="toc-row${done.has(l.id) ? ' done' : ''}${isRecommended(l) ? '' : ' optional'}" data-act="start-lesson" data-lesson="${l.id}">
      <span class="toc-num">${numeral(i + 1)}.</span>
      <span class="toc-title"><b>${esc(l.title)}</b><small>${esc(l.blurb)}</small></span>
      <span class="toc-tag">${AUDIENCE[l.audience]}${done.has(l.id) ? ' · <span class="red">done</span>' : rec ? ' · <span class="red">suggested</span>' : ''}</span>
      <span class="toc-check">${done.has(l.id) ? icon('check') : ''}</span>
    </button>`;
  }).join('');
  return `<section class="lessons"><header class="page-head"><h2>Lessons</h2>
      <p>About a minute each. ${profile ? '' : 'Tell us what you know for suggestions.'} <button class="btn btn-small" data-act="profile-open">${profile ? 'Change experience' : 'Set experience'}</button></p></header>
    <div class="sheet toc">${rows}
      <button class="toc-row practice" data-act="practice"><span class="toc-num">—</span>
        <span class="toc-title"><b>Practice match</b><small>A full game against Professor Fumble, with the coach on.</small></span><span class="toc-tag">Practice</span><span class="toc-check"></span></button>
    </div></section>`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "26 October" from a YYYY-MM-DD key. */
function dayLabel(key: string): string {
  const [, m, d] = key.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

export function dailyScreen({ daily, bot, num, entry, streak, history }: {
  daily: Daily; bot: PersonalityConfig; num: number; entry: DailyEntry | undefined; streak: number; history: [string, DailyEntry][];
}): string {
  const rank = daily.config.setups![daily.seat]!;
  const result = entry
    ? `<div class="dy-result"><div class="kicker">Your result</div><b>${outcomeText(entry)}</b>
        ${entry.done ? '<button class="btn btn-small" data-act="daily-share">Copy result</button>' : '<small>Leaving a game early counts as a loss.</small>'}</div>`
    : '';
  const past = history.length
    ? `<div class="dy-past"><div class="sheet-head">Recent days</div>${history.map(([k, e]) =>
        `<div class="dy-day"><span>${dayLabel(k)}</span><span class="${e.outcome === 'w' && e.done ? 'red' : ''}">${outcomeText(e)}</span></div>`).join('')}</div>`
    : '';
  return `<section class="free daily"><header class="page-head"><h2>Daily game</h2>
      <p>${dayLabel(daily.key)}. One game, the same for everyone today. Your first try counts.</p></header>
    <div class="free-body dy-body">
      <div class="picks">${characterCard(bot, num)}</div>
      <div class="sheet dy-sheet">
        <div class="dy-facts">
          <div><div class="kicker">Opponent</div><b>${esc(bot.name)}</b><small>${esc(bot.title)}</small></div>
          <div><div class="kicker">Rules</div><b>${esc(daily.twist.title)}</b><small>${esc(daily.twist.text)}</small></div>
          <div><div class="kicker">You play</div><b>${daily.seat === 'white' ? 'White' : 'Black'}</b><small>${daily.seat === 'white' ? 'You move first.' : `${esc(bot.name)} moves first.`}</small></div>
          <div><div class="kicker">Your back rank</div><span class="dy-rank">${[...rank.slice(0, 4), 'king' as const, ...rank.slice(4)].map((t) => pieceIcon(t, daily.seat)).join('')}</span><small>Dealt, not arranged. Files a to h.</small></div>
        </div>
        ${result}
        <div class="dy-foot">
          <span class="dy-streak">Streak <b>${streak}</b> ${streak === 1 ? 'day' : 'days'}</span>
          <button class="btn btn-red" data-act="daily-start">${entry ? 'Play again (won’t count)' : 'Play today’s game'}</button>
        </div>
        ${past}
      </div>
    </div></section>`;
}

export interface PvpForm {
  white: string;
  black: string;
  name: string;
  color: ColorChoice;
  code: string;
}

export function pvpScreen({ form, error, busy, online }: { form: PvpForm; error: string | null; busy: boolean; online: boolean }): string {
  const pick = (c: ColorChoice, label: string) => `<button class="btn btn-small${form.color === c ? ' btn-ink' : ''}" data-act="pvp-color" data-v="${c}">${label}</button>`;
  const field = (k: keyof PvpForm, label: string, extra = '') =>
    `<label class="field"><span>${label}</span><input type="text" data-field="${k}" value="${esc(form[k])}" maxlength="20" autocomplete="off" spellcheck="false" ${extra}></label>`;
  return `<section class="pvp"><header class="page-head"><h2>Player vs player</h2><p>${online ? 'Play a friend at the same table or over the internet.' : 'Play a friend at the same table.'}</p></header>
    <div class="pvp-body">
      <div class="sheet pvp-sheet">
        <h3>Same device</h3>
        <p>Take turns at one screen. Between turns the board hides, so nobody sees the other player's cards.</p>
        ${field('white', 'White')}
        ${field('black', 'Black')}
        <button class="btn btn-red" data-act="pvp-local">Start</button>
      </div>
      ${online ? `<div class="sheet pvp-sheet">
        <h3>Online</h3>
        <p>Open a room and send the code to your friend, or join theirs.</p>
        ${field('name', 'Your name')}
        <div class="field"><span>Play as</span><span class="seg">${pick('white', 'White')}${pick('black', 'Black')}${pick('random', 'Random')}</span></div>
        <button class="btn btn-red" data-act="pvp-create" ${busy ? 'disabled' : ''}>Open a room</button>
        <div class="pvp-join">${field('code', 'Room code', 'class="code-input"')}<button class="btn" data-act="pvp-join" ${busy ? 'disabled' : ''}>Join</button></div>
      </div>` : ''}
    </div>
    ${error ? `<p class="pvp-error">${esc(error)}</p>` : ''}
  </section>`;
}

export function roomScreen({ code, you, names, joined, down }: {
  code: string; you: Color; names: Record<Color, string>; joined: boolean; down: boolean;
}): string {
  const them: Color = you === 'white' ? 'black' : 'white';
  return `<section class="room">
    <div class="sheet room-sheet">
      <div class="kicker">Room code</div>
      <div class="room-code">${esc(code)}</div>
      <p>Send this code to your friend. They choose <b>PvP</b>, then <b>Join</b>.</p>
      <p>You play <b>${you === 'white' ? 'White' : 'Black'}</b>.</p>
      <p class="room-status">${down ? 'Reconnecting to the server…' : joined ? `${esc(names[them])} has joined.` : 'Waiting for your opponent<span class="dots"></span>'}</p>
      <div class="modal-actions"><button class="btn" data-act="room-leave">Leave room</button></div>
    </div>
  </section>`;
}

/** Covers the table between turns in pass-and-play, with what happened since this player last looked. */
export function curtainHTML({ name, color, recent, setup }: { name: string; color: Color; recent: LogEntry[]; setup?: boolean }): string {
  const other = color === 'white' ? 'Black' : 'White';
  return `<div class="curtain-card">
    <span class="curtain-piece pc-${color}">${pieceSVG('king')}</span>
    <div class="kicker">${setup ? 'Secret setup' : 'Your turn'}</div>
    <h2>Pass to ${esc(name)}</h2>
    <p>${other}, look away.</p>
    ${recent.length ? `<div class="curtain-log"><div class="kicker">Since your last turn</div>${logHTML(recent)}</div>` : ''}
    <button class="btn btn-red btn-big" data-act="curtain-open">I'm ${esc(name)}: show my pieces</button>
  </div>`;
}

export type ColorChoice = Color | 'random';

export function setupScreen({ arrangement, picked, color, colorChoice, heading, side, startLabel = 'Start' }: {
  arrangement: Arrangement; picked: number | null; color: Color;
  /** Shown as a White / Black / Random picker when set (bot matches). */
  colorChoice: ColorChoice | null;
  heading: string;
  /** Left column: the opponent's card and status. */
  side: string;
  startLabel?: string;
}): string {
  const back = color === 'white' ? '1' : '8';
  const order = boardOrder(color).files.map((f) => 'abcdefgh'[f]);
  const cells = order.map((f) => {
    if (f === 'e') return `<div class="slot fixed"><span class="pc pc-${color}">${pieceSVG('king')}</span><small>e${back}</small></div>`;
    const i = (BACK_FILES as readonly string[]).indexOf(f);
    return `<button class="slot${picked === i ? ' picked' : ''}" data-act="setup-swap" data-i="${i}">
      <span class="pc card card-${color} mine"><span class="card-face pc-${color}">${pieceSVG(arrangement[i])}</span></span><small>${f}${back}</small></button>`;
  }).join('');
  // a1 and h8 are dark: a square is dark when file and rank have the same parity.
  const rank = Number(back) - 1;
  const bishopColors = [BACK_FILES[arrangement.indexOf('bishop')], BACK_FILES[arrangement.lastIndexOf('bishop')]]
    .map((f) => (('abcdefgh'.indexOf(f) + rank) % 2 === 0 ? 'dark' : 'light'));
  const pick = (c: ColorChoice, label: string) => `<button class="btn btn-small${colorChoice === c ? ' btn-ink' : ''}" data-act="setup-color" data-v="${c}">${label}</button>`;
  return `<section class="setup">
    <div class="setup-opp">${side}</div>
    <div class="setup-main">
      <h2>${esc(heading)}</h2>
      ${colorChoice ? `<p class="setup-color">Play as <span class="seg">${pick('white', 'White')}${pick('black', 'Black')}${pick('random', 'Random')}</span> <small>White moves first.</small></p>` : ''}
      <p>Your opponent sees only card backs. Pick two cards to swap them.</p>
      <div class="slots">${cells}</div>
      <p class="setup-note">${bishopColors[0] === bishopColors[1] ? `Both bishops are on ${bishopColors[0]} squares. That's allowed.` : 'Bishops on opposite colours.'}</p>
      <div class="setup-actions">
        <button class="btn" data-act="setup-classic">Classic</button>
        <button class="btn" data-act="setup-random">Shuffle</button>
        <button class="btn btn-red" data-act="setup-start">${esc(startLabel)}</button>
      </div>
    </div>
  </section>`;
}

/** The setup screen's left column for a bot match. */
export function setupBotSide(bot: PersonalityConfig, num: number): string {
  return `${characterCard(bot, num, { mood: 'thinking' })}<p>${esc(bot.name)} is arranging in secret.</p>`;
}

export function gameShell(mode: string): string {
  return `<section class="game" data-mode="${mode}">
    <div class="g-opp"><div id="opp-panel"></div><div class="speech hidden" id="speech"></div></div>
    <div class="g-board">
      <div class="board-frame"><div class="board" id="board"></div><div class="board-overlay" id="board-overlay"></div><div class="fx-layer" id="fx-layer"></div>
        <div class="callouts"><div id="prompt" role="status" aria-live="polite"></div><div id="flash" aria-hidden="true"></div></div>
      </div>
    </div>
    <div class="g-me" id="me-panel"></div>
    <button class="info-btn" id="info-btn" data-act="info-open" aria-haspopup="dialog">Info</button>
    <div class="info-scrim" data-act="info-close"></div>
    <aside class="g-side" aria-label="Game info">
      <div class="sheet action-panel" id="action-panel"></div>
      <div class="side-tabs" id="side-tabs" role="toolbar"></div>
      <div class="sheet coach-card" id="coach-card"></div>
      <div class="sheet record"><div id="tracker"></div><div class="log" id="log"></div></div>
    </aside>
    <div class="curtain hidden" id="curtain"></div>
  </section>`;
}

// ---------------------------------------------------------------------------
// Modals

export function profileHTML(profile: Partial<Profile>): string {
  const q = (k: keyof Profile, label: string, opts: [Profile['chess'], string][]) =>
    `<div class="pq"><div class="pq-label">${label}</div><div class="pq-opts">${opts.map(([v, text]) =>
      `<button class="btn${profile[k] === v ? ' btn-ink' : ''}" data-act="profile-set" data-k="${k}" data-v="${v}">${text}</button>`).join('')}</div></div>`;
  return `<div class="sheet modal-sheet profile">
    <h2>Before you play</h2>
    <p>Two questions, so we can suggest where to start.</p>
    ${q('chess', 'How well do you know chess?', [['new', 'Never played'], ['basic', 'I know the moves'], ['confident', 'I play regularly']])}
    ${q('poker', 'How well do you know poker and bluffing?', [['new', 'Never played'], ['basic', 'I know the idea'], ['confident', 'Comfortable']])}
    <div class="modal-actions"><button class="btn btn-red" data-act="profile-done" ${profile.chess && profile.poker ? '' : 'disabled'}>Done</button></div>
  </div>`;
}

export const DIFFICULTY_LABEL: Record<Difficulty, string> = { easier: 'Easier', normal: 'Normal', harder: 'Harder', expert: 'Expert' };

export function settingsHTML({ volume, muted, coach, difficulty, reducedMotion }: {
  volume: number; muted: boolean; coach: 'auto' | 'on' | 'off'; difficulty: Difficulty; reducedMotion: boolean;
}): string {
  const seg = (v: 'auto' | 'on' | 'off', label: string) => `<button class="btn btn-small${coach === v ? ' btn-ink' : ''}" data-act="coach-mode" data-v="${v}">${label}</button>`;
  const diff = (v: Difficulty) => `<button class="btn btn-small${difficulty === v ? ' btn-ink' : ''}" data-act="difficulty" data-v="${v}">${DIFFICULTY_LABEL[v]}</button>`;
  return `<div class="sheet modal-sheet settings">
    <h2>Settings</h2>
    <div class="set-row"><span>Difficulty<small>Opponents keep their style; easier ones blunder more and call less. Expert searches deeper and never blunders on purpose.</small></span><span class="seg">${diff('easier')}${diff('normal')}${diff('harder')}${diff('expert')}</span></div>
    <label class="set-row"><span>Volume</span><input type="range" min="0" max="100" value="${Math.round(volume * 100)}" data-knob="volume"></label>
    <label class="set-row"><span>Mute</span><input type="checkbox" data-knob="muted" ${muted ? 'checked' : ''}></label>
    <div class="set-row"><span>Coach</span><span class="seg">${seg('auto', 'First 5 games')}${seg('on', 'Always')}${seg('off', 'Off')}</span></div>
    <label class="set-row"><span>Reduce motion</span><input type="checkbox" data-knob="reducedMotion" ${reducedMotion ? 'checked' : ''}></label>
    <div class="modal-actions"><button class="btn btn-plain danger" data-act="reset-progress">Reset progress</button><button class="btn btn-ink" data-act="close-modal">Done</button></div>
  </div>`;
}

export interface CodexEntry {
  id: string;
  title: string;
  body: string;
  diagram?: PieceType;
}

export interface CodexData {
  categories: { id: string; title: string; entries: CodexEntry[] }[];
}

/** A small board showing where a piece can move. */
function diagramHTML(t: PieceType): string {
  const board: Board = new Array(64).fill(null);
  const from = t === 'pawn' ? sqToIdx('d2') : sqToIdx('d4');
  board[from] = { id: 'x', color: 'white', type: t, hidden: false, claim: null, hasMoved: false };
  if (t === 'pawn') {
    board[sqToIdx('c3')] = { id: 'y', color: 'black', type: 'pawn', hidden: false, claim: null, hasMoved: true };
    board[sqToIdx('e3')] = { id: 'z', color: 'black', type: 'pawn', hidden: false, claim: null, hasMoved: true };
  }
  const targets = new Set(generateMoves(board, 'white', -1, { pseudo: true }).map((m) => idxToSq(m.to)));
  let html = '';
  for (let r = 7; r >= 0; r--) {
    for (let f = 0; f < 8; f++) {
      const i = r * 8 + f;
      const c = board[i];
      const sq = idxToSq(i);
      html += `<div class="dg-sq ${(f + r) % 2 === 0 ? 'dark' : 'light'}${targets.has(sq) ? (c ? ' dg-cap' : ' dg-dot') : ''}">${c?.type ? `<span class="pc pc-${c.color}">${pieceSVG(c.type)}</span>` : ''}</div>`;
    }
  }
  return `<div class="diagram">${html}</div>`;
}

export function codexHTML({ codex, entryId, characters }: {
  codex: CodexData; entryId: string; characters: { bot: PersonalityConfig; num: number; met: boolean }[];
}): string {
  const cats = [...codex.categories, {
    id: 'characters', title: 'Opponents',
    entries: characters.map(({ bot, met }) => ({ id: `bot-${bot.id}`, title: met ? bot.name : 'Unknown', body: '' })),
  }];
  const list = cats.map((c) => `<div class="cx-cat"><div class="cx-cat-title">${esc(c.title)}</div>${c.entries.map((e) =>
    `<button class="cx-item${e.id === entryId ? ' on' : ''}" data-act="codex" data-entry="${e.id}">${esc(e.title)}</button>`).join('')}</div>`).join('');

  let page: string;
  const ch = entryId.startsWith('bot-') ? characters.find((c) => `bot-${c.bot.id}` === entryId) : null;
  if (ch) {
    page = ch.met
      ? `<h3>${esc(ch.bot.name)}</h3><div class="cx-card">${characterCard(ch.bot, ch.num, { small: true })}</div>
         <p>${esc(ch.bot.blurb)}</p><p><b>What they teach:</b> ${esc(ch.bot.teaches)}</p><p class="cx-note">Their habits are for you to find.</p>`
      : '<h3>Unknown</h3><p>You haven\'t met this opponent yet. Unlock them in the Circuit.</p>';
  } else {
    const entry = codex.categories.flatMap((c) => c.entries).find((e) => e.id === entryId) ?? codex.categories[0].entries[0];
    page = `<h3>${esc(entry.title)}</h3>${entry.diagram ? diagramHTML(entry.diagram) : ''}${linkify(entry.body)}`;
  }
  return `<div class="rulebook">
    <nav class="cx-index"><h2>Rulebook</h2>${list}</nav>
    <article class="cx-page">${page}<div class="modal-actions"><button class="btn" data-act="close-modal">Close</button></div></article>
  </div>`;
}

export function lessonDoneHTML({ lesson, next }: { lesson: Lesson; next: Lesson | null }): string {
  return `<div class="sheet modal-sheet lesson-done">
    <span class="done-stamp">Complete</span>
    <h2>${esc(lesson.title)}</h2>
    <p>${next ? `Next: ${esc(next.title)}.` : 'That\'s every lesson. Try a practice match, then the Circuit.'}</p>
    <div class="modal-actions">
      <button class="btn" data-act="go-lessons">All lessons</button>
      ${next ? `<button class="btn btn-red" data-act="start-lesson" data-lesson="${next.id}">Next lesson</button>` : '<button class="btn btn-red" data-act="practice">Practice match</button>'}
    </div>
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

function lieList(groups: ClaimGroup[], emptyText: string, owner: Color): string {
  const lies = groups.filter((g) => g.piece.type !== g.claim);
  if (!lies.length) return `<div class="rv-empty">${emptyText}</div>`;
  return lies.map((g) => `<div class="rv-lie ${g.outcome.startsWith('never') ? 'got-away' : 'caught'}">
      <span class="rv-glyphs">${pieceIcon(g.piece.type!, owner)}<span class="rv-arrow">as</span>${pieceIcon(g.claim, owner)}</span>
      <span>Move ${g.first}: ${originSquare(g.piece.id) || ''} ${typeName(g.piece.type)} claimed ${typeName(g.claim)}${g.moves > 1 ? ` (${g.moves} moves)` : ''}<small>${g.outcome}</small></span>
    </div>`).join('');
}

function stats(state: GameState, player: Color) {
  const mine = state.claims.filter((c) => c.player === player);
  const theirs = state.claims.filter((c) => c.player !== player && c.outcome !== 'pending');
  const calls = theirs.filter((c) => c.called);
  return {
    claims: mine.length, lies: mine.filter((c) => !c.honest).length, caught: mine.filter((c) => c.outcome === 'caught').length,
    calls: calls.length, right: calls.filter((c) => !c.honest).length,
  };
}

/** "1 claim", "2 claims". */
function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
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
  }).slice(0, 5).sort((a, b) => a.fullmove - b.fullmove);
}

export function revealHTML({ state, bot, num, snaps, me, newlyUnlocked, resultText, won, meName = 'You', beliefs: showBeliefs = true, again = 'Rematch' }: {
  state: GameState; bot: PersonalityConfig; num: number | string; snaps: BeliefSnap[]; me: Color; newlyUnlocked: string[]; resultText: string; won: boolean | null;
  /** "You" against a bot or online; the seat's name in pass-and-play. */
  meName?: string;
  /** The bot's beliefs section; off for human opponents. */
  beliefs?: boolean;
  /** Label for the play-again button. */
  again?: string;
}): string {
  const isYou = meName === 'You';
  const yours = isYou ? 'Your' : `${esc(meName)}'s`;
  const opp: Color = me === 'white' ? 'black' : 'white';
  const you = stats(state, me);
  const them = stats(state, opp);
  const beliefs = pickSnaps(state, snaps);
  const beliefRows = beliefs.length
    ? beliefs.map((s) => `<div class="rv-belief ${s.right ? 'right' : 'wrong'}">
        <span class="rv-quote">“Move ${s.fullmove}: I was ${Math.round(s.p * 100)}% sure your ${originSquare(s.pieceId) || ''} piece was a ${typeName(s.best)}.”</span>
        <small>${s.right ? 'Correct.' : `It was a ${typeName(s.piece.type)}.`} You claimed ${typeName(s.claim)}${s.decision ? `; they ${s.decision === 'call' ? 'called' : 'passed'}` : ''}.</small>
      </div>`).join('')
    : `<div class="rv-empty">You made no claims for ${esc(midName(bot.name))} to read.</div>`;

  return `<div class="sheet modal-sheet reveal">
    <header class="rv-head">
      ${characterCard(bot, num, { small: true, mood: won === true ? 'beaten' : won === false ? 'triumphant' : 'neutral' })}
      <div><div class="kicker">Result</div><h2>${resultText}</h2>
      ${newlyUnlocked.length ? `<p class="rv-unlock">Unlocked: ${newlyUnlocked.map(esc).join(', ')}</p>` : ''}</div>
    </header>
    <div class="rv-grid">
      <div class="rv-board-col">
        <div class="board board-small">${boardHTML(state, { me, final: true })}</div>
        <div class="rv-legend">Cards marked in red were lying when the game ended.</div>
      </div>
      <div class="rv-cols">
        <div><h3>${yours} lies</h3>
          <div class="rv-stat">${count(you.claims, 'claim')}, ${count(you.lies, 'lie')}, ${you.caught} caught</div>
          ${lieList(groupClaims(state, me), you.claims ? (isYou ? 'None. You played it straight.' : 'None.') : (isYou ? 'You made no claims.' : 'No claims.'), me)}
          <div class="rv-stat">${isYou ? 'You' : esc(meName)} called ${count(you.calls, 'time')}, ${you.right} correctly</div></div>
        <div><h3>${esc(bot.name)}'s lies</h3>
          <div class="rv-stat">${count(them.claims, 'claim')}, ${count(them.lies, 'lie')}, ${them.caught} caught</div>
          ${lieList(groupClaims(state, opp), them.claims ? 'None.' : 'They made no claims.', opp)}
          <div class="rv-stat">They called ${count(them.calls, 'time')}, ${them.right} correctly</div></div>
      </div>
    </div>
    ${showBeliefs ? `<div class="rv-beliefs"><h3>What ${esc(midName(bot.name))} believed</h3>${beliefRows}</div>` : ''}
    <div class="modal-actions">
      <button class="btn" data-act="close-modal">View board</button>
      <button class="btn" data-act="copy-game">Copy game</button>
      <button class="btn" data-act="leave">Leave</button>
      <button class="btn btn-red" data-act="rematch">${again}</button>
    </div>
  </div>`;
}
