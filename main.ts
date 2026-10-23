// Wires the engine, bot and UI together. The UI only ever renders the
// player's view; the bot only ever receives its own view.

import * as E from './engine/index.ts';
import type {
  Action, Arrangement, ClaimType, Color, GameConfig, GameEvent, GameState, MoveAction, Piece, PlayerView, Result, Rng, Square,
} from './engine/index.ts';
import { chooseAction, chooseSetup, beliefsFor } from './bot/bot.ts';
import type { LineKey, PersonalityConfig, TableImage } from './bot/bot.ts';
import { computeBeliefs } from './bot/belief.ts';
import * as R from './ui/render.ts';
import type { BeliefSnap, FreeKnobs, LogEntry, LogKind } from './ui/render.ts';
import { bindInput } from './ui/input.ts';
import type { InputHandlers } from './ui/input.ts';
import * as FX from './ui/animations.ts';
import * as Store from './ui/storage.ts';

declare global {
  interface Window {
    bluffChess?: { app: App; E: typeof E; advance: () => void };
  }
}

const ME: Color = 'white';
const BOT: Color = 'black';
const { GLYPH, typeName, esc } = R;

/** Optional element lookup. */
const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
/** Required element lookup: the game shell guarantees these exist. */
function el(sel: string): HTMLElement {
  const found = $(sel);
  if (!found) throw new Error(`Missing element ${sel}`);
  return found;
}

const params = new URLSearchParams(location.search);
// ?fast shortens bot think time (tells keep their proportions); ?debug exposes state for testing.
const SPEED = params.has('fast') ? 0.05 : 1;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms * SPEED));

type Mode = 'circuit' | 'free' | 'tutorial';
type Screen = 'menu' | 'circuit' | 'free' | 'setup' | 'game';
type TipKey = 'start' | 'select-hidden' | 'claimed' | 'bot-claim' | 'lie' | 'true' | 'check' | 'showdown';

interface SetupState {
  botId: string;
  mode: Mode;
  config: GameConfig;
  arrangement: Arrangement;
  picked: number | null;
}

interface Match {
  mode: Mode;
  botId: string;
  bot: PersonalityConfig;
  config: GameConfig;
  seed: number;
  rng: Rng;
  state: GameState;
  memory: TableImage;
  log: LogEntry[];
  snaps: BeliefSnap[];
  guesses: Record<string, ClaimType>;
  selected: Square | null;
  choice: { options: MoveAction[] } | null;
  hover: Square[];
  flip: Set<string>;
  pendingFx: (() => void)[];
  lastMove: { from: Square; to: Square } | null;
  busy: boolean;
  thinking: boolean;
  lastThinkMs: number | null;
  tips: Set<TipKey>;
  tipQueue: string[];
  over: boolean;
  newlyUnlocked: string[];
}

interface App {
  roster: string[];
  tutorialId: string;
  bots: Record<string, PersonalityConfig>;
  data: Store.SaveData;
  screen: Screen;
  free: FreeKnobs;
  setup: SetupState | null;
  lastArrangement: Arrangement | null;
  match: Match | null;
}

const app: App = {
  roster: [],
  tutorialId: 'tutor',
  bots: {},
  data: Store.load(),
  screen: 'menu',
  free: { bot: '', startingChips: 6, claimLocking: true, liarPaysChip: false, chipsOutLoss: false, oneShowdown: false },
  setup: null,
  lastArrangement: null,
  match: null,
};

// ---------------------------------------------------------------------------
// Boot

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return (await res.json()) as T;
}

async function init(): Promise<void> {
  const index = await fetchJson<{ tutorial: string; circuit: string[] }>('data/personalities/index.json');
  app.roster = index.circuit;
  app.tutorialId = index.tutorial;
  for (const id of [index.tutorial, ...index.circuit]) {
    app.bots[id] = await fetchJson<PersonalityConfig>(`data/personalities/${id}.json`);
  }
  app.free.bot = app.roster[0];
  if (params.has('debug')) window.bluffChess = { app, E, advance: () => advance() };
  bindInput(el('#app'), handlers);
  show('menu');
}

function unlocked(): Set<string> {
  const set = new Set<string>();
  app.roster.forEach((id, i) => {
    if (i === 0 || (app.data.records[app.roster[i - 1]]?.w || 0) > 0) set.add(id);
  });
  return set;
}

function show(screen: Exclude<Screen, 'game'>): void {
  app.screen = screen;
  hideTooltip();
  const root = el('#screen');
  if (screen === 'menu') root.innerHTML = R.menuScreen();
  else if (screen === 'circuit') root.innerHTML = R.circuitScreen({ roster: app.roster, bots: app.bots, records: app.data.records, unlocked: unlocked() });
  else if (screen === 'free') {
    const choices = [...unlocked(), app.tutorialId];
    if (!choices.includes(app.free.bot)) app.free.bot = choices[0];
    root.innerHTML = R.freePlayScreen({ choices, bots: app.bots, knobs: app.free });
  } else if (screen === 'setup' && app.setup) {
    root.innerHTML = R.setupScreen({ ...app.setup, bot: app.bots[app.setup.botId] });
  }
  window.scrollTo(0, 0);
}

function openModal(html: string, cls = ''): void {
  el('#modal-root').innerHTML = `<div class="modal-overlay" data-act="close-modal-bg"><div class="modal ${cls}">${html}</div></div>`;
}

function closeModal(): void {
  el('#modal-root').innerHTML = '';
}

// ---------------------------------------------------------------------------
// Setup and match start

function startSetup(botId: string, mode: Mode, config: GameConfig): void {
  app.setup = { botId, mode, config, arrangement: [...(app.lastArrangement || E.CLASSIC_ARRANGEMENT)], picked: null };
  show('setup');
}

function startMatch(): void {
  if (!app.setup) return;
  const { botId, mode, config, arrangement } = app.setup;
  app.lastArrangement = [...arrangement];
  const bot = app.bots[botId];
  const seed = (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0;
  const rng = E.createRng(seed);
  const state = E.createGame({ ...config, setups: { [ME]: arrangement, [BOT]: chooseSetup(bot, rng) } });

  app.match = {
    mode, botId, bot, config, seed, rng, state,
    memory: app.data.memory[botId] || Store.blankMemory(),
    log: [], snaps: [], guesses: {}, selected: null, choice: null, hover: [], flip: new Set(), pendingFx: [],
    lastMove: null, busy: false, thinking: false, lastThinkMs: null, tips: new Set(), tipQueue: [], over: false,
    newlyUnlocked: [],
  };
  app.screen = 'game';
  el('#screen').innerHTML = R.gameShell(bot);
  log(`Match vs ${esc(bot.name)}. You play white and move first.`, 'system');
  say(pickLine('greet'));
  tip('start');
  advance();
}

// ---------------------------------------------------------------------------
// Game loop

/** The current match; only called while one is running. */
function match(): Match {
  if (!app.match) throw new Error('No match in progress');
  return app.match;
}

const view = (): PlayerView => E.getPlayerView(match().state, ME);

function advance(): void {
  const m = match();
  renderGame();
  const s = m.state;
  if (s.phase === 'over') {
    if (!m.over) finishMatch();
    return;
  }
  if (E.getActor(s) === BOT && !m.busy) void botAct();
}

async function botAct(): Promise<void> {
  const m = match();
  m.busy = true;
  m.thinking = true;
  renderGame();
  const v = E.getPlayerView(m.state, BOT);
  const t0 = performance.now();
  const d = chooseAction(v, m.bot, m.memory, m.rng);
  const elapsed = performance.now() - t0;
  if (!d) {
    m.busy = m.thinking = false;
    return;
  }

  const hover = d.hover;
  if (hover?.length) {
    m.hover = [hover[0]];
    renderGame();
    setTimeout(() => { if (app.match === m && m.thinking) { m.hover = [hover[1]]; renderGame(); } }, d.thinkMs * 0.55 * SPEED);
  }
  await sleep(Math.max(200, d.thinkMs - elapsed / SPEED));
  if (app.match !== m || m.state.phase === 'over') return;
  m.hover = [];
  m.thinking = false;

  if (d.action.type === 'move') m.lastThinkMs = d.thinkMs;
  let line = d.line;
  if (v.phase === 'callWindow' && v.pending) {
    const snap = m.snaps[m.snaps.length - 1];
    if (snap && (d.action.type === 'call' || d.action.type === 'pass')) snap.decision = d.action.type;
    if (!line && v.pending.claim === 'queen') line = pickLine('playerQueen');
  }
  if (line) say(line);
  if (d.action.type === 'call' && v.pending) {
    FX.stamp($('#fx-layer'), $('#board'), v.pending.to, 'CALL!', 'call');
    await sleep(650);
  }
  m.busy = false;
  dispatch(d.action);
}

function dispatch(action: Action): void {
  const m = match();
  const before = m.state;
  let res: ReturnType<typeof E.applyAction>;
  try {
    res = E.applyAction(before, action);
  } catch (e) {
    console.error(e);
    return;
  }
  m.state = res.state;
  m.selected = null;
  m.choice = null;
  handleEvents(res.events, before);
  advance();
}

// ---------------------------------------------------------------------------
// Events -> log, speech, effects, tips

function who(color: Color): string {
  return color === ME ? 'You' : esc(match().bot.name);
}

function pieceLabel(p: Piece | undefined): string {
  if (!p) return 'piece';
  if (p.faceUp) return `${GLYPH[p.type!]} ${typeName(p.type)}`;
  if (p.owner === ME) return `hidden ${typeName(p.type)}`;
  return 'hidden piece';
}

function claimTag(claim: ClaimType): string {
  return `<b class="claim-tag">${GLYPH[claim]} ${typeName(claim)}</b>`;
}

function handleEvents(events: GameEvent[], before: GameState): void {
  const m = match();
  const bv = E.getPlayerView(before, ME);
  const fx = (f: () => void) => m.pendingFx.push(f);

  for (const ev of events) {
    switch (ev.type) {
      case 'moved': {
        m.lastMove = { from: ev.from, to: ev.to };
        const p = bv.pieces.find((x) => x.id === ev.pieceId);
        const cap = ev.capturedId ? bv.pieces.find((x) => x.id === ev.capturedId) : undefined;
        const n = `${before.fullmove}${ev.player === 'white' ? '.' : '…'}`;
        let text: string;
        if (ev.castle) {
          text = `${who(ev.player)} castled ${ev.castle === 'K' ? 'kingside' : 'queenside'}`;
          if (ev.claim) text += `, the corner piece claims ${claimTag('rook')}`;
        } else {
          text = `${who(ev.player)}: ${pieceLabel(p)} ${ev.from}→${ev.to}`;
          if (cap) text += ` ×${pieceLabel(cap)}`;
          if (ev.promotion) text += ` =${GLYPH[ev.promotion]}`;
          if (ev.claim) text += `, claims ${claimTag(ev.claim)}`;
        }
        const mover = ev.castle ? bv.pieces.find((x) => x.owner === ev.player && x.square === m.state.pending?.from) : p;
        if (ev.claim && ev.player === ME && mover && mover.type !== ev.claim) text += ' <span class="tag-bluff">bluff</span>';
        if (ev.claim && ev.player === BOT && m.lastThinkMs) text += ` <span class="think" title="Think time">${(m.lastThinkMs / 1000).toFixed(1)}s</span>`;
        log(text, ev.claim ? 'claim' : 'move', n);
        if (ev.claim && ev.player === ME) tip('claimed', { type: typeName(ev.claim) });
        if (ev.claim && ev.player === BOT) tip('bot-claim', { type: typeName(ev.claim) });
        break;
      }
      case 'claimMade':
        if (ev.player === ME) {
          const bview = E.getPlayerView(m.state, BOT);
          const dist = beliefsFor(bview, m.bot, m.memory).probs[ev.pieceId];
          if (dist) m.snaps.push({ fullmove: before.fullmove, pieceId: ev.pieceId, claim: ev.claim, square: ev.square, dist });
        }
        break;
      case 'passed':
        log(`↳ ${who(ev.player)} ${ev.player === ME ? 'pass' : 'passes'}.`, 'pass');
        break;
      case 'lieCaught': {
        const caller = who(ev.caller);
        log(`↳ ${ev.showdown ? 'Showdown' : `${caller} ${ev.caller === ME ? 'call' : 'calls'}`}: <b>LIE!</b> The ${typeName(ev.pieceType)} claiming ${typeName(ev.claim)} is removed${ev.restoredId ? ' and the capture is undone' : ''}.`, 'lie');
        fx(() => {
          FX.stamp($('#fx-layer'), $('#board'), ev.square, 'LIE!', 'lie');
          FX.shake($('#board'));
        });
        say(pickLine(ev.liar === BOT ? 'caughtLying' : 'catchesYou'));
        tip('lie');
        break;
      }
      case 'claimConfirmed': {
        log(`↳ ${ev.showdown ? 'Showdown' : `${who(ev.caller)} ${ev.caller === ME ? 'call' : 'calls'}`}: it really is a <b>${typeName(ev.pieceType)}</b>. Chip to ${ev.mover === ME ? 'you' : who(ev.mover)}.`, 'true');
        m.flip.add(ev.pieceId);
        fx(() => {
          FX.stamp($('#fx-layer'), $('#board'), ev.square, 'TRUE', 'true');
          FX.chipFly($(ev.caller === ME ? '#strip-me .strip-chips' : '#strip-opp .strip-chips'), $(ev.caller === ME ? '#strip-opp .strip-chips' : '#strip-me .strip-chips'));
        });
        say(pickLine(ev.caller === BOT ? 'wrongCall' : 'confirmed'));
        tip('true');
        break;
      }
      case 'captured':
        if (ev.claim && ev.claim !== ev.pieceType) log(`Captured piece revealed: a ${typeName(ev.pieceType)} that claimed ${typeName(ev.claim)}.`, 'reveal');
        else if (ev.owner === BOT && !bv.pieces.find((x) => x.id === ev.pieceId)?.faceUp) log(`Captured piece revealed: ${GLYPH[ev.pieceType]} ${typeName(ev.pieceType)}.`, 'reveal');
        break;
      case 'check':
        log(`${ev.player === ME ? 'You are' : `${esc(m.bot.name)} is`} in check.`, 'check');
        if (ev.player === ME) tip('check');
        break;
      case 'showdownAvailable':
        log(`${who(ev.player)} ${ev.player === ME ? 'are' : 'is'} checkmated on the apparent board. Showdown!`, 'showdown');
        void FX.banner('SHOWDOWN', ev.player === ME ? 'Expose a lying piece or lose.' : `${esc(m.bot.name)} looks for a lie...`);
        tip('showdown');
        break;
      case 'showdown':
        log(`⚔ ${who(ev.player)} ${ev.player === ME ? 'expose' : 'exposes'} the piece on ${ev.square} claiming ${typeName(ev.claim)}...`, 'showdown');
        break;
      case 'mateBroken':
        log('The mate is broken! Play continues.', 'showdown');
        break;
      case 'gameOver':
        log(resultText(ev), 'over');
        break;
      default:
        break;
    }
  }
}

const REASONS: Record<Result['reason'], string> = {
  checkmate: 'checkmate', stalemate: 'stalemate', resign: 'resignation', chips: 'running out of chips',
  repetition: 'threefold repetition', fiftyMove: 'the fifty-move rule',
};

function resultText(r: Result): string {
  if (!r.winner) return `Draw by ${REASONS[r.reason]}.`;
  return `${r.winner === ME ? 'You win' : `${esc(match().bot.name)} wins`} by ${REASONS[r.reason]}.`;
}

function log(html: string, kind: LogKind, n?: string): void {
  match().log.push({ html, kind, n });
}

function pickLine(key: LineKey): string | null {
  const lines = match().bot.lines?.[key];
  return lines?.length ? lines[Math.floor(Math.random() * lines.length)] : null;
}

let speechTimer: ReturnType<typeof setTimeout> | undefined;
function say(text: string | null): void {
  const bubble = $('#speech');
  if (!text || !bubble) return;
  bubble.innerHTML = `<b>${esc(match().bot.name)}:</b> ${esc(text)}`;
  bubble.classList.remove('hidden');
  clearTimeout(speechTimer);
  speechTimer = setTimeout(() => bubble.classList.add('hidden'), 4200);
}

const TIPS: Record<TipKey, string> = {
  start: 'Your back-rank pieces are <b>face-down</b> to the Professor: you see their true type on a card back. His show only as "?" cards. Pawns and kings are face-up. Click a piece to move.',
  'select-hidden': 'Moving a face-down piece is a <b>claim</b>. The dots show moves for <i>any</i> type it could claim. Claim its true type to play honest, or bluff. Bluffs get removed if called.',
  claimed: 'Your claim is <b>locked</b>: this piece must keep moving as a {type}. The gold badge shows your claim.',
  'bot-claim': 'The Professor moved a hidden piece and claimed a <b>{type}</b>. <b>Call</b> (1 chip) if you think he\'s lying, or pass. Hint: watch how long he thought. The tracker on the right counts his claims.',
  lie: 'Caught! A liar is removed, its move is undone, and the caller moves next.',
  true: 'An honest claim flips face-up and wins the caller\'s chip. Chips are your ammunition for calls.',
  check: 'Check is judged on the <b>apparent board</b>: claims count as real. If you think the checking piece is lying, call it next time.',
  showdown: '<b>Showdown!</b> Mated on the apparent board, you can spend a chip to expose a claimed enemy piece. If it\'s lying, it\'s removed and the mate may break.',
};

function tip(key: TipKey, vars: Record<string, string> = {}): void {
  const m = match();
  if (m.mode !== 'tutorial' || m.tips.has(key)) return;
  m.tips.add(key);
  m.tipQueue.push(TIPS[key].replace(/\{(\w+)\}/g, (_, k: string) => esc(vars[k])));
}

// ---------------------------------------------------------------------------
// Rendering the match

function renderGame(): void {
  const m = app.match;
  if (!m || app.screen !== 'game') return;
  const v = view();
  const actor = E.getActor(v);
  const board = E.getApparentBoard(v);

  let checkSquare: Square | null = null;
  for (const c of [ME, BOT]) {
    if (E.inCheck(board, c)) checkSquare = v.pieces.find((p) => p.owner === c && p.type === 'king')?.square ?? null;
  }
  const targets = new Set<Square>();
  const captureTargets = new Set<Square>();
  if (m.selected && v.phase === 'move' && actor === ME) {
    for (const a of E.getLegalActions(v, ME)) {
      if (a.type !== 'move' || a.from !== m.selected) continue;
      targets.add(a.to);
      if (v.pieces.some((p) => !p.captured && p.square === a.to)) captureTargets.add(a.to);
    }
  }
  const showdownTargets = new Set<Square>();
  if (v.phase === 'showdown' && actor === ME) {
    for (const a of E.getLegalActions(v, ME)) {
      if (a.type !== 'showdown') continue;
      const sq = v.pieces.find((p) => p.id === a.targetPieceId)?.square;
      if (sq) showdownTargets.add(sq);
    }
  }

  el('#board').innerHTML = R.boardHTML(v, {
    me: ME, selected: m.selected, targets, captureTargets, lastMove: m.lastMove, hover: m.hover,
    guesses: m.guesses, flip: m.flip, showdownTargets, checkSquare, final: v.phase === 'over',
  });
  m.flip.clear();

  el('#strip-opp').innerHTML = R.stripHTML({
    name: m.bot.name, avatar: m.bot.avatar, color: m.bot.color, chipsN: v.chips[BOT], owner: BOT,
    status: m.thinking ? '<span class="dots">thinking</span>' : esc(m.bot.title), isTurn: actor === BOT,
    tray: R.capturedTray(v, BOT),
  });
  el('#strip-me').innerHTML = R.stripHTML({
    name: 'You', avatar: '♔', color: '#3b5b8a', chipsN: v.chips[ME], owner: ME,
    status: actor === ME ? 'your turn' : '', isTurn: actor === ME, tray: R.capturedTray(v, ME),
  });
  el('#action-panel').innerHTML = actionPanelHTML(v, actor);
  el('#tracker').innerHTML = R.trackerHTML(v, BOT);
  const logEl = el('#log');
  logEl.innerHTML = R.logHTML(m.log);
  logEl.scrollTop = logEl.scrollHeight;

  if (m.pendingFx.length) {
    const queue = m.pendingFx.splice(0);
    requestAnimationFrame(() => queue.forEach((f) => f()));
  }
}

function actionPanelHTML(v: PlayerView, actor: Color | null): string {
  const m = match();
  const name = esc(m.bot.name);
  let tipBox = '';
  if (m.tipQueue.length) {
    tipBox = `<div class="tip"><span class="tip-label">Tutorial</span><div>${m.tipQueue[0]}</div><button class="btn btn-small" data-act="dismiss-tip">Got it</button></div>`;
  }
  let body: string;
  if (v.phase === 'over' && v.result) {
    body = `<div class="ap-title">${resultText(v.result)}</div>
      <div class="ap-buttons"><button class="btn btn-primary" data-act="reveal">See the reveal</button><button class="btn" data-act="rematch">Rematch</button></div>`;
  } else if (v.phase === 'callWindow' && v.pending && v.pending.mover === BOT) {
    const p = v.pending;
    const claim = p.claim!;
    const certain = computeBeliefs(v).certainLies.includes(claim);
    const secs = m.lastThinkMs ? (m.lastThinkMs / 1000).toFixed(1) : '?';
    body = `<div class="ap-kicker">Call window</div>
      <div class="ap-title">${name} claims ${claimTag(claim)}</div>
      <div class="ap-sub">${p.castle ? 'Castled' : `Moved ${p.from}→${p.to}`}${p.capturedId ? ', capturing' : ''} · thought ${secs}s</div>
      ${certain ? '<div class="ap-alert">Count check: more pieces claim this than can exist. Someone is lying.</div>' : ''}
      <div class="ap-buttons">
        <button class="btn btn-call" data-act="call" ${v.chips[ME] > 0 ? '' : 'disabled'}>Call <small>1 chip · C</small></button>
        <button class="btn" data-act="pass">Pass <small>P</small></button>
      </div>`;
  } else if (v.phase === 'callWindow') {
    body = `<div class="ap-kicker">Call window</div><div class="ap-title">${name} is deciding whether to call...</div>`;
  } else if (v.phase === 'showdown' && actor === ME) {
    body = `<div class="ap-kicker sd">Showdown</div>
      <div class="ap-title">You're checkmated... unless they're lying.</div>
      <div class="ap-sub">Spend 1 chip to expose a claimed piece (glowing). If it's a lie it's removed, and if that breaks the mate, play on.</div>
      <div class="ap-buttons"><button class="btn btn-ghost btn-danger" data-act="accept-mate">Accept defeat</button></div>`;
  } else if (v.phase === 'showdown') {
    body = `<div class="ap-kicker sd">Showdown</div><div class="ap-title">${name} is mated and hunting for a lie...</div>`;
  } else if (actor === ME) {
    body = m.choice ? choiceHTML(v, m.choice.options) : yourMoveHTML(v);
  } else {
    body = `<div class="ap-title">${name} is thinking<span class="dots"></span></div>`;
  }
  return tipBox + body;
}

function yourMoveHTML(v: PlayerView): string {
  const m = match();
  const inCheck = E.inCheck(E.getApparentBoard(v), ME);
  let sub = 'Select a piece. Right-click (or long-press) a hidden enemy piece to mark a guess.';
  if (m.selected) {
    const p = v.pieces.find((x) => !x.captured && x.square === m.selected);
    if (p && !p.faceUp && !p.claim) sub = `Hidden ${typeName(p.type)}: unclaimed, so it can move as any type. Your first claim will lock it.`;
    else if (p && !p.faceUp) sub = `Hidden ${typeName(p.type)}, locked as a ${typeName(p.claim)}${p.claim !== p.type ? ' (a bluff: every move can be called)' : ''}.`;
    else if (p) sub = `${typeName(p.type)}: face-up, no claim needed.`;
  }
  return `<div class="ap-title">Your move${inCheck ? ' <span class="ap-check">You are in check</span>' : ''}</div><div class="ap-sub">${sub}</div>`;
}

function choiceHTML(v: PlayerView, options: MoveAction[]): string {
  const piece = v.pieces.find((x) => !x.captured && x.square === options[0].from);
  const isHonest = (a: MoveAction) => a.claim === piece?.type;
  const promo = options[0].promotion;
  const btns = options.map((a, i) => ({ a, i }))
    .sort((x, y) => Number(isHonest(y.a)) - Number(isHonest(x.a)))
    .map(({ a, i }) => {
      if (promo && a.promotion) return `<button class="btn btn-claim" data-act="choose" data-i="${i}"><span class="claim-glyph">${GLYPH[a.promotion]}</span>${typeName(a.promotion)}</button>`;
      const honest = isHonest(a);
      return `<button class="btn btn-claim ${honest ? 'honest' : 'bluff'}" data-act="choose" data-i="${i}">
        <span class="claim-glyph">${a.claim ? GLYPH[a.claim] : ''}</span>${typeName(a.claim)}<small>${honest ? 'honest' : 'bluff'}</small></button>`;
    }).join('');
  return `<div class="ap-kicker">${promo ? 'Promotion' : 'Choose your claim'}</div>
    <div class="ap-title">${promo ? 'Promote to' : `Move ${options[0].from}→${options[0].to} as a...`}</div>
    <div class="claim-grid">${btns}</div>
    <button class="btn btn-ghost btn-small" data-act="cancel-choice">Cancel</button>`;
}

// ---------------------------------------------------------------------------
// Match end

function finishMatch(): void {
  const m = match();
  m.over = true;
  const s = m.state;
  const result = s.result!;
  const outcome = !result.winner ? 'd' : result.winner === ME ? 'w' : 'l';
  const before = unlocked();
  app.data.records = Store.recordResult(app.data.records, m.botId, outcome);
  app.data.memory[m.botId] = Store.updateMemory(app.data.memory[m.botId], s, ME);
  Store.save(app.data);
  m.newlyUnlocked = [...unlocked()].filter((id) => !before.has(id)).map((id) => app.bots[id].name);
  say(pickLine(outcome === 'w' ? 'lose' : outcome === 'l' ? 'win' : 'pass'));
  const title = outcome === 'w' ? 'VICTORY' : outcome === 'l' ? 'DEFEAT' : 'DRAW';
  void FX.banner(title, resultText(result), outcome === 'w' ? 'win' : outcome === 'l' ? 'loss' : 'draw', 2000)
    .then(() => { if (app.match === m && app.screen === 'game') openReveal(); });
}

function openReveal(): void {
  const m = match();
  openModal(R.revealHTML({ state: m.state, bot: m.bot, snaps: m.snaps, me: ME, newlyUnlocked: m.newlyUnlocked, resultText: resultText(m.state.result!) }), 'modal-wide');
}

// ---------------------------------------------------------------------------
// Input

function onSquare(sq: Square): void {
  const m = app.match;
  if (!m || app.screen !== 'game' || m.busy) return;
  const v = view();
  const actor = E.getActor(v);
  if (actor !== ME) return;

  if (v.phase === 'showdown') {
    const p = v.pieces.find((x) => !x.captured && x.square === sq);
    if (p && E.getLegalActions(v, ME).some((a) => a.type === 'showdown' && a.targetPieceId === p.id)) {
      dispatch({ type: 'showdown', player: ME, targetPieceId: p.id });
    }
    return;
  }
  if (v.phase !== 'move') return;

  m.choice = null;
  const legal = E.getLegalActions(v, ME).filter((a): a is MoveAction => a.type === 'move');
  if (m.selected) {
    const opts = legal.filter((a) => a.from === m.selected && a.to === sq);
    if (opts.length === 1) return dispatch(opts[0]);
    if (opts.length > 1) {
      m.choice = { options: opts };
      return renderGame();
    }
  }
  const p = v.pieces.find((x) => !x.captured && x.square === sq);
  if (p && p.owner === ME && m.selected !== sq && legal.some((a) => a.from === sq)) {
    m.selected = sq;
    if (!p.faceUp && !p.claim) tip('select-hidden');
  } else {
    m.selected = null;
  }
  renderGame();
}

function onGuess(sq: Square): void {
  const m = app.match;
  if (!m || app.screen !== 'game') return;
  const p = view().pieces.find((x) => !x.captured && x.square === sq);
  if (!p || p.owner !== BOT || p.faceUp) return;
  const order: (ClaimType | undefined)[] = [undefined, 'rook', 'knight', 'bishop', 'queen'];
  const next = order[(order.indexOf(m.guesses[p.id]) + 1) % order.length];
  if (next) m.guesses[p.id] = next;
  else delete m.guesses[p.id];
  renderGame();
}

function onHover(pieceId: string, pieceEl: HTMLElement): void {
  const m = app.match;
  if (!m || app.screen !== 'game') return;
  const v = view();
  const p = v.pieces.find((x) => x.id === pieceId);
  if (!p || p.faceUp) return hideTooltip();
  let html: string;
  if (p.owner === BOT && v.phase !== 'over') {
    const dist = computeBeliefs(v).probs[p.id];
    html = R.tooltipHTML(p, dist, v.claims.filter((c) => c.pieceId === p.id), m.guesses[p.id]);
  } else {
    html = `<div class="tt-title">Your hidden ${typeName(p.type)}</div><div class="tt-hist">${p.claim ? `Claims ${typeName(p.claim)}${p.claim !== p.type ? ': a bluff. Every move it makes can be called.' : '.'}` : `Unclaimed: ${esc(m.bot.name)} sees only a card back.`}</div>`;
  }
  const tt = el('#tooltip');
  tt.innerHTML = html;
  tt.classList.remove('hidden');
  const r = pieceEl.getBoundingClientRect();
  const w = tt.offsetWidth;
  const left = Math.min(window.innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2));
  const top = r.top - tt.offsetHeight - 8 < 8 ? r.bottom + 8 : r.top - tt.offsetHeight - 8;
  tt.style.left = `${left}px`;
  tt.style.top = `${top + window.scrollY}px`;
}

function hideTooltip(): void {
  $('#tooltip')?.classList.add('hidden');
}

function playerDecision(type: 'call' | 'pass'): void {
  const m = app.match;
  if (!m || m.busy) return;
  const v = view();
  if (v.phase !== 'callWindow' || !v.pending || v.pending.mover !== BOT) return;
  if (type === 'call') {
    if (v.chips[ME] <= 0) return;
    m.busy = true;
    FX.stamp($('#fx-layer'), $('#board'), v.pending.to, 'CALL!', 'call');
    setTimeout(() => { m.busy = false; dispatch({ type: 'call', player: ME }); }, 550);
  } else {
    dispatch({ type: 'pass', player: ME });
  }
}

const handlers: InputHandlers = {
  action(name, ds, e) {
    const m = app.match;
    switch (name) {
      case 'go': return show(ds.to as Exclude<Screen, 'game'>);
      case 'rules': return openModal(R.rulesHTML());
      case 'close-modal': return closeModal();
      case 'close-modal-bg':
        if (e.target instanceof Element && e.target.classList.contains('modal-overlay')) closeModal();
        return;
      case 'tutorial': return startSetup(app.tutorialId, 'tutorial', {});
      case 'pick-bot': return startSetup(ds.bot!, 'circuit', {});
      case 'free-start':
        return startSetup(app.free.bot, 'free', {
          startingChips: app.free.startingChips, claimLocking: app.free.claimLocking,
          liarPaysChip: app.free.liarPaysChip, chipsOutLoss: app.free.chipsOutLoss,
          showdownsPerMate: app.free.oneShowdown ? 1 : 0,
        });
      case 'setup-swap': {
        const s = app.setup;
        if (!s) return;
        const i = Number(ds.i);
        if (s.picked == null) s.picked = i;
        else {
          [s.arrangement[s.picked], s.arrangement[i]] = [s.arrangement[i], s.arrangement[s.picked]];
          s.picked = null;
        }
        return show('setup');
      }
      case 'setup-classic':
        if (!app.setup) return;
        app.setup.arrangement = [...E.CLASSIC_ARRANGEMENT];
        app.setup.picked = null;
        return show('setup');
      case 'setup-random':
        if (!app.setup) return;
        app.setup.arrangement = E.randomArrangement(E.createRng(Math.floor(Math.random() * 1e9)));
        app.setup.picked = null;
        return show('setup');
      case 'setup-start': return startMatch();
      case 'call': return playerDecision('call');
      case 'pass': return playerDecision('pass');
      case 'choose': {
        const a = m?.choice?.options[Number(ds.i)];
        if (a) dispatch(a);
        return;
      }
      case 'cancel-choice':
        if (!m) return;
        m.choice = null;
        m.selected = null;
        return renderGame();
      case 'accept-mate':
        return dispatch({ type: 'acceptMate', player: ME });
      case 'resign':
        if (m && m.state.phase !== 'over' && confirm('Resign this match?')) dispatch({ type: 'resign', player: ME });
        return;
      case 'dismiss-tip':
        if (!m) return;
        m.tipQueue.shift();
        return renderGame();
      case 'reveal': return openReveal();
      case 'rematch':
        if (!m) return;
        closeModal();
        return startSetup(m.botId, m.mode, m.config);
      case 'back':
        closeModal();
        app.match = null;
        return show(m?.mode === 'free' ? 'free' : m?.mode === 'circuit' ? 'circuit' : 'menu');
      default:
    }
  },
  square: onSquare,
  guess: onGuess,
  hover: onHover,
  unhover: hideTooltip,
  knob(k, val) {
    if (k === 'bot') app.free.bot = String(val);
    else if (k === 'startingChips') {
      app.free.startingChips = Number(val);
      el('#chip-val').textContent = String(val);
    } else if (k === 'claimLocking' || k === 'liarPaysChip' || k === 'chipsOutLoss' || k === 'oneShowdown') {
      app.free[k] = Boolean(val);
    }
  },
  key(k) {
    const modalOpen = !!el('#modal-root').innerHTML;
    if (k === 'escape') {
      if (modalOpen) return closeModal();
      if (app.match) {
        app.match.selected = null;
        app.match.choice = null;
        renderGame();
      }
    }
    if (app.screen !== 'game' || modalOpen) return;
    if (k === 'c') playerDecision('call');
    if (k === 'p') playerDecision('pass');
  },
};

init().catch((e: unknown) => {
  console.error(e);
  el('#screen').innerHTML = `<div class="boot-error"><h2>Could not start</h2><p>Bluff Chess uses ES modules and JSON data, so it must be served over HTTP, not opened as a file.</p><p>Run <code>npm start</code> in the project folder and open the printed URL.</p></div>`;
});
