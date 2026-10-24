// Wires the engine, bot, coach, lessons and UI together. The UI only ever
// renders the player's view; the bot only ever receives its own view.

import * as E from './engine/index.ts';
import type {
  Action, Arrangement, ClaimType, Color, GameConfig, GameEvent, GameState, MoveAction, Piece, PlayerView, Result, Rng, Square,
} from './engine/index.ts';
import { chooseAction, chooseSetup, beliefsFor, applyDifficulty } from './bot/bot.ts';
import type { LineKey, PersonalityConfig, TableImage } from './bot/bot.ts';
import { computeBeliefs } from './bot/belief.ts';
import { explainIllegal, whyStuck, blunderCheck, claimAdvice, callAdvice } from './coach/advice.ts';
import type { Advice } from './coach/advice.ts';
import { matchesExpect, startStep, applyAll, recommended } from './lessons/lessons.ts';
import type { Lesson, Profile } from './lessons/lessons.ts';
import * as R from './ui/render.ts';
import type { BeliefSnap, CodexData, FreeKnobs, LogEntry, LogKind } from './ui/render.ts';
import type { Mood } from './ui/art/emblems.ts';
import { bindInput } from './ui/input.ts';
import type { InputHandlers } from './ui/input.ts';
import * as FX from './ui/animations.ts';
import * as Sound from './ui/audio.ts';
import * as Store from './ui/storage.ts';

declare global {
  interface Window {
    bluffChess?: { app: App; E: typeof E; advance: () => void };
  }
}

const ME: Color = 'white';
const BOT: Color = 'black';
const { typeName, esc, pieceIcon, codexLink, midName } = R;

const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
function el(sel: string): HTMLElement {
  const found = $(sel);
  if (!found) throw new Error(`Missing element ${sel}`);
  return found;
}

const params = new URLSearchParams(location.search);
// ?fast shortens bot think time (tells keep their proportions); ?debug exposes state for testing.
const SPEED = params.has('fast') ? 0.05 : 1;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms * SPEED));

type Mode = 'circuit' | 'free' | 'practice' | 'lesson';
type Screen = 'title' | 'hub' | 'circuit' | 'free' | 'lessons' | 'setup' | 'game';

interface SetupState {
  botId: string;
  mode: Mode;
  config: GameConfig;
  arrangement: Arrangement;
  picked: number | null;
}

interface LessonRun {
  lesson: Lesson;
  step: number;
  /** playing: waiting for the player; success: step done, waiting for Continue; busy: scripted moves running. */
  phase: 'playing' | 'success' | 'busy';
  feedback: { tone: 'hint' | 'success'; text: string } | null;
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
  /** Coach blunder warning awaiting confirmation. */
  guard: { action: MoveAction; advice: Advice } | null;
  /** Transient coach note (e.g. why a move is illegal). */
  note: Advice | null;
  /** Why the last click did nothing; shown in the prompt bar even with the coach off. */
  stuck: { title: string; text: string; squares: Square[] } | null;
  hover: Square[];
  flip: Set<string>;
  pendingFx: (() => void)[];
  lastMove: { from: Square; to: Square } | null;
  busy: boolean;
  thinking: boolean;
  lastThinkMs: number | null;
  botThinks: number[];
  mood: Mood;
  over: boolean;
  newlyUnlocked: string[];
  lesson: LessonRun | null;
}

interface App {
  roster: string[];
  tutorialId: string;
  bots: Record<string, PersonalityConfig>;
  lessons: Lesson[];
  codex: CodexData;
  data: Store.SaveData;
  screen: Screen;
  free: FreeKnobs;
  setup: SetupState | null;
  lastArrangement: Arrangement | null;
  match: Match | null;
  draftProfile: Partial<Profile>;
}

const app: App = {
  roster: [],
  tutorialId: 'tutor',
  bots: {},
  lessons: [],
  codex: { categories: [] },
  data: Store.load(),
  screen: 'title',
  free: { bot: '', startingChips: 4, claimLocking: true, liarPaysChip: true, chipsOutLoss: true, oneShowdown: false },
  setup: null,
  lastArrangement: null,
  match: null,
  draftProfile: {},
};

// ---------------------------------------------------------------------------
// Boot, stage scaling, persistence

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
  const lessonIds = await fetchJson<string[]>('data/lessons/index.json');
  app.lessons = await Promise.all(lessonIds.map((id) => fetchJson<Lesson>(`data/lessons/${id}.json`)));
  app.codex = await fetchJson<CodexData>('data/codex.json');
  app.free.bot = app.roster[0];
  applySettings();
  if (params.has('debug')) window.bluffChess = { app, E, advance: () => advance() };
  bindInput(el('#app'), handlers);
  window.addEventListener('resize', fitStage);
  fitStage();
  show('title');
}

/** Scale the fixed-size stage to the window: 16:9 landscape, or a tall layout on phones. */
function fitStage(): void {
  const stage = el('#stage');
  const portrait = window.innerWidth < window.innerHeight * 0.9;
  const [w, h] = portrait ? [900, 1600] : [1600, 900];
  stage.dataset.layout = portrait ? 'portrait' : 'landscape';
  stage.style.width = `${w}px`;
  stage.style.height = `${h}px`;
  stage.style.setProperty('--scale', String(Math.min(window.innerWidth / w, window.innerHeight / h)));
}

function save(): void {
  Store.save(app.data);
}

function applySettings(): void {
  const s = app.data.settings;
  Sound.setVolume(s.volume);
  Sound.setMuted(s.muted);
  document.body.classList.toggle('reduce-motion', s.reducedMotion);
}

function unlocked(): Set<string> {
  const set = new Set<string>();
  app.roster.forEach((id, i) => {
    if (i === 0 || (app.data.records[app.roster[i - 1]]?.w || 0) > 0) set.add(id);
  });
  return set;
}

function coachOn(): boolean {
  const m = app.match;
  if (m && (m.mode === 'lesson' || m.mode === 'practice')) return app.data.settings.coach !== 'off';
  const c = app.data.settings.coach;
  return c === 'on' || (c === 'auto' && app.data.matchesPlayed < 5);
}

// ---------------------------------------------------------------------------
// Screens

const TITLES: Record<Screen, string> = {
  title: '', hub: '', circuit: 'Circuit', free: 'Free play', lessons: 'Lessons', setup: 'Setup', game: '',
};

/** Card number for a character: the tutor is 0, circuit opponents I to V. */
function botNumber(id: string): number {
  return id === app.tutorialId ? 0 : app.roster.indexOf(id) + 1;
}

function renderHud(): void {
  const hud = el('#hud');
  if (app.screen === 'title') {
    hud.innerHTML = '';
    hud.classList.add('hidden');
    return;
  }
  hud.classList.remove('hidden');
  const m = app.match;
  const inGame = app.screen === 'game' && !!m;
  const title = inGame ? (m.mode === 'lesson' ? `Lesson · ${m.lesson!.lesson.title}` : `Versus ${m.bot.name}`) : TITLES[app.screen];
  const back = app.screen === 'hub' ? null : inGame ? 'leave' : app.screen === 'setup' ? 'setup-back' : 'go-hub';
  hud.innerHTML = R.hudHTML({ title, back, inGame, muted: app.data.settings.muted, coachOn: coachOn() });
}

function show(screen: Exclude<Screen, 'game'>): void {
  app.screen = screen;
  hideTooltip();
  const root = el('#screen');
  root.className = `screen screen-${screen}`;
  if (screen === 'title') root.innerHTML = R.titleScreen();
  else if (screen === 'hub') {
    root.innerHTML = R.hubScreen({ nudge: hubNudge() });
    if (!app.data.profile) openProfile();
  } else if (screen === 'circuit') root.innerHTML = R.circuitScreen({ roster: app.roster, bots: app.bots, records: app.data.records, unlocked: unlocked(), difficulty: app.data.settings.difficulty });
  else if (screen === 'free') {
    const choices = [...unlocked(), app.tutorialId];
    if (!choices.includes(app.free.bot)) app.free.bot = choices[0];
    root.innerHTML = R.freePlayScreen({ choices, bots: app.bots, knobs: app.free, numbers: Object.fromEntries(choices.map((id) => [id, botNumber(id)])) });
  } else if (screen === 'lessons') {
    const profile = app.data.profile;
    root.innerHTML = R.lessonsScreen({ lessons: app.lessons, done: new Set(app.data.lessonsDone), isRecommended: (l) => recommended(l, profile), profile });
  } else if (screen === 'setup' && app.setup) {
    root.innerHTML = R.setupScreen({ ...app.setup, bot: app.bots[app.setup.botId], num: botNumber(app.setup.botId) });
  }
  renderHud();
}

function hubNudge(): string | null {
  const next = app.lessons.find((l) => recommended(l, app.data.profile) && !app.data.lessonsDone.includes(l.id));
  const link = (l: Lesson) => `<a class="codex-link" data-act="start-lesson" data-lesson="${l.id}">${esc(l.title)}</a>`;
  if (next && app.data.lessonsDone.length === 0) return `New to the game? Start with the lesson ${link(next)}.`;
  if (next) return `Next lesson: ${link(next)}.`;
  if (!app.data.records[app.roster[0]]?.w) return 'Ready for a real game? Start the <a class="codex-link" data-act="go-circuit">Circuit</a>.';
  return null;
}

function openModal(html: string, cls = ''): void {
  el('#modal-root').innerHTML = `<div class="modal-overlay" data-act="close-modal-bg"><div class="modal ${cls}">${html}</div></div>`;
}

function closeModal(): void {
  el('#modal-root').innerHTML = '';
}

function openProfile(): void {
  app.draftProfile = { ...(app.data.profile || {}) };
  openModal(R.profileHTML(app.draftProfile));
}

function openCodex(entryId: string): void {
  const met = new Set([app.tutorialId, ...unlocked()]);
  const characters = [app.tutorialId, ...app.roster].map((id) => ({ bot: app.bots[id], num: botNumber(id), met: met.has(id) }));
  openModal(R.codexHTML({ codex: app.codex, entryId, characters }), 'modal-wide');
}

function openSettings(): void {
  openModal(R.settingsHTML(app.data.settings));
}

// ---------------------------------------------------------------------------
// Setup and match start

function startSetup(botId: string, mode: Mode, config: GameConfig): void {
  app.setup = { botId, mode, config, arrangement: [...(app.lastArrangement || E.CLASSIC_ARRANGEMENT)], picked: null };
  show('setup');
}

function newMatch(mode: Mode, botId: string, config: GameConfig, state: GameState, rng: Rng, seed: number): Match {
  return {
    mode, botId, bot: app.bots[botId], config, seed, rng, state,
    memory: app.data.memory[botId] || Store.blankMemory(),
    log: [], snaps: [], guesses: {}, selected: null, choice: null, guard: null, note: null, stuck: null, hover: [], flip: new Set(), pendingFx: [],
    lastMove: null, busy: false, thinking: false, lastThinkMs: null, botThinks: [], mood: 'neutral', over: false,
    newlyUnlocked: [], lesson: null,
  };
}

function enterGame(m: Match): void {
  app.match = m;
  app.screen = 'game';
  hideTooltip();
  const root = el('#screen');
  root.className = 'screen screen-game';
  root.innerHTML = R.gameShell(m.mode);
  renderHud();
}

function startMatch(): void {
  if (!app.setup) return;
  const { botId, mode, config, arrangement } = app.setup;
  app.lastArrangement = [...arrangement];
  const bot = app.bots[botId];
  const seed = (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0;
  const rng = E.createRng(seed);
  const state = E.createGame({ ...config, setups: { [ME]: arrangement, [BOT]: chooseSetup(bot, rng) } });
  enterGame(newMatch(mode, botId, config, state, rng, seed));
  log(`New game against ${esc(bot.name)}. You are white and move first.`, 'system');
  say(pickLine('greet'));
  advance();
}

function startLesson(id: string): void {
  const lesson = app.lessons.find((l) => l.id === id);
  if (!lesson) return;
  closeModal();
  const first = startStep(null, lesson.steps[0]);
  const m = newMatch('lesson', app.tutorialId, {}, first, E.createRng(1), 1);
  m.lesson = { lesson, step: 0, phase: 'playing', feedback: null };
  enterGame(m);
  log(`Lesson: ${esc(lesson.title)}`, 'system');
  lessonEnterStep(0);
}

// ---------------------------------------------------------------------------
// Lessons

function lessonStep() {
  const run = match().lesson!;
  return run.lesson.steps[run.step];
}

/** Set up step `i`: reset the position if it has one, then play its scripted opening moves. */
async function lessonEnterStep(i: number): Promise<void> {
  const m = match();
  const run = m.lesson!;
  run.step = i;
  run.feedback = null;
  const step = run.lesson.steps[i];
  if (step.position) {
    m.state = E.createGame(step.position);
    m.lastMove = null;
  }
  if (step.before?.length) {
    run.phase = 'busy';
    renderGame();
    for (const a of step.before) {
      await sleep(700);
      if (app.match !== m) return;
      dispatch(a, { silentAdvance: true });
    }
  }
  run.phase = 'playing';
  Sound.play('step');
  renderGame();
}

/** Check a player action against the lesson. Returns true if it should be applied. */
function lessonAccepts(action: Action): boolean {
  const m = match();
  const run = m.lesson!;
  const step = lessonStep();
  if (run.phase !== 'playing' || step.expect === 'next') return false;
  if (matchesExpect(action, step.expect)) return true;
  run.feedback = { tone: 'hint', text: step.hint || 'Not quite. Try again!' };
  m.selected = null;
  m.choice = null;
  Sound.play('error');
  setMood('smug');
  renderGame();
  return false;
}

async function lessonAfterAction(): Promise<void> {
  const m = match();
  const run = m.lesson!;
  const step = lessonStep();
  run.phase = 'busy';
  run.feedback = step.success ? { tone: 'success', text: step.success } : null;
  renderGame();
  for (const a of step.reply ?? []) {
    await sleep(800);
    if (app.match !== m) return;
    dispatch(a, { silentAdvance: true });
  }
  run.phase = 'success';
  renderGame();
}

function lessonContinue(): void {
  const m = match();
  const run = m.lesson!;
  const step = lessonStep();
  if (run.phase === 'busy') return;
  if (step.expect !== 'next' && run.phase !== 'success') return;
  if (run.step + 1 < run.lesson.steps.length) {
    void lessonEnterStep(run.step + 1);
    return;
  }
  if (!app.data.lessonsDone.includes(run.lesson.id)) app.data.lessonsDone.push(run.lesson.id);
  save();
  Sound.play('win');
  setMood('triumphant');
  const idx = app.lessons.indexOf(run.lesson);
  const next = app.lessons.slice(idx + 1).find((l) => !app.data.lessonsDone.includes(l.id)) ?? null;
  openModal(R.lessonDoneHTML({ lesson: run.lesson, next }));
}

// ---------------------------------------------------------------------------
// Game loop

function match(): Match {
  if (!app.match) throw new Error('No match in progress');
  return app.match;
}

const view = (): PlayerView => E.getPlayerView(match().state, ME);

function advance(): void {
  const m = match();
  renderGame();
  const s = m.state;
  if (m.mode === 'lesson') return;
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
  const d = chooseAction(v, applyDifficulty(m.bot, app.data.settings.difficulty), m.memory, m.rng);
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

  if (d.action.type === 'move') {
    if (m.lastThinkMs != null && d.action.claim) m.botThinks.push(m.lastThinkMs);
    m.lastThinkMs = d.thinkMs;
  }
  let line = d.line;
  if (v.phase === 'callWindow' && v.pending) {
    const snap = m.snaps[m.snaps.length - 1];
    if (snap && (d.action.type === 'call' || d.action.type === 'pass')) snap.decision = d.action.type;
    if (!line && v.pending.claim === 'queen') line = pickLine('playerQueen');
  }
  if (line) say(line);
  if (d.action.type === 'call' && v.pending) {
    Sound.play('call');
    FX.stamp($('#fx-layer'), $('#board'), v.pending.to, 'Called', 'call');
    await sleep(650);
  } else if (d.action.type === 'pass' && v.pending) {
    Sound.play('step');
    FX.stamp($('#fx-layer'), $('#board'), v.pending.to, 'Pass', 'pass');
    await sleep(450);
  }
  m.busy = false;
  dispatch(d.action);
}

/** Every player action goes through here: lesson checks and the coach's blunder guard. */
function playerAct(action: Action, opts: { skipGuard?: boolean } = {}): void {
  const m = match();
  m.note = null;
  if (m.mode === 'lesson') {
    if (!lessonAccepts(action)) return;
    dispatch(action, { silentAdvance: true });
    void lessonAfterAction();
    return;
  }
  if (action.type === 'move' && coachOn() && !opts.skipGuard) {
    const advice = blunderCheck(view(), action);
    if (advice) {
      m.guard = { action, advice };
      m.choice = null;
      Sound.play('error');
      renderGame();
      return;
    }
  }
  m.guard = null;
  dispatch(action);
}

function dispatch(action: Action, opts: { silentAdvance?: boolean } = {}): void {
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
  if (opts.silentAdvance) renderGame();
  else advance();
}

// ---------------------------------------------------------------------------
// Events -> log, speech, sound, effects, moods

function who(color: Color): string {
  return color === ME ? 'You' : esc(match().bot.name);
}

function pieceLabel(p: Piece | undefined): string {
  if (!p) return 'piece';
  if (p.faceUp && p.type) return `${pieceIcon(p.type, p.owner)} ${typeName(p.type)}`;
  if (p.owner === ME) return `hidden ${typeName(p.type)}`;
  return 'a card';
}

function claimTag(claim: ClaimType): string {
  return `<b class="claim-tag">${pieceIcon(claim)} ${typeName(claim)}</b>`;
}

let moodTimer: ReturnType<typeof setTimeout> | undefined;
function setMood(e: Mood, ms = 2800): void {
  const m = app.match;
  if (!m) return;
  m.mood = e;
  clearTimeout(moodTimer);
  if (e !== 'neutral') moodTimer = setTimeout(() => { if (app.match === m) { m.mood = 'neutral'; renderOpp(); } }, ms);
}

function handleEvents(events: GameEvent[], before: GameState): void {
  const m = match();
  const bv = E.getPlayerView(before, ME);
  const fx = (f: () => void) => m.pendingFx.push(f);

  for (const ev of events) {
    switch (ev.type) {
      case 'moved': {
        m.lastMove = { from: ev.from, to: ev.to };
        Sound.play(ev.capturedId ? 'capture' : 'move');
        const p = bv.pieces.find((x) => x.id === ev.pieceId);
        const cap = ev.capturedId ? bv.pieces.find((x) => x.id === ev.capturedId) : undefined;
        const n = m.mode === 'lesson' ? '' : `${before.fullmove}${ev.player === 'white' ? '.' : '…'}`;
        let text: string;
        if (ev.castle) {
          text = `${who(ev.player)} castled ${ev.castle === 'K' ? 'kingside' : 'queenside'}`;
          if (ev.claim) text += `, the corner card claims ${claimTag('rook')}`;
        } else {
          text = `${who(ev.player)}: ${pieceLabel(p)} ${ev.from}→${ev.to}`;
          if (cap) text += ` takes ${pieceLabel(cap)}`;
          if (ev.promotion) text += `, promotes to ${pieceIcon(ev.promotion, ev.player)}`;
          if (ev.claim) text += `, claims ${claimTag(ev.claim)}`;
        }
        const mover = ev.castle ? bv.pieces.find((x) => x.owner === ev.player && x.square === m.state.pending?.from) : p;
        if (ev.claim && ev.player === ME && mover && mover.type !== ev.claim) text += ' <span class="tag-bluff">bluff</span>';
        if (ev.claim && ev.player === BOT && m.lastThinkMs && m.mode !== 'lesson') text += ` <span class="think" title="Think time">${(m.lastThinkMs / 1000).toFixed(1)}s</span>`;
        log(text, ev.claim ? 'claim' : 'move', n);
        break;
      }
      case 'claimMade':
        if (ev.player === ME && m.mode !== 'lesson') {
          const bview = E.getPlayerView(m.state, BOT);
          const dist = beliefsFor(bview, m.bot, m.memory).probs[ev.pieceId];
          if (dist) m.snaps.push({ fullmove: before.fullmove, pieceId: ev.pieceId, claim: ev.claim, square: ev.square, dist });
        }
        break;
      case 'passed':
        log(`↳ ${who(ev.player)} ${ev.player === ME ? 'pass' : 'passes'}.`, 'pass');
        break;
      case 'called':
        if (ev.player === ME) Sound.play('call');
        break;
      case 'lieCaught': {
        const caller = who(ev.caller);
        log(`↳ ${ev.showdown ? 'Showdown' : `${caller} ${ev.caller === ME ? 'call' : 'calls'}`}: <b>a lie.</b> The ${typeName(ev.pieceType)} claiming ${typeName(ev.claim)} is removed${ev.restoredId ? ' and the capture is undone' : ''}.${ev.paid ? ` Chip to ${ev.caller === ME ? 'you' : esc(midName(m.bot.name))}.` : ''}${ev.stillInCheck ? ` ${ev.liar === ME ? 'You are' : `${esc(m.bot.name)} is`} back in check and must answer it.` : ''}`, 'lie');
        fx(() => {
          Sound.play('lie');
          FX.stamp($('#fx-layer'), $('#board'), ev.square, 'Liar', 'lie');
          if (!app.data.settings.reducedMotion) FX.shake($('#board'));
          if (ev.paid) {
            setTimeout(() => Sound.play('coin'), 250);
            FX.chipFly($(ev.liar === ME ? '#me-panel .purse' : '#opp-panel .purse'), $(ev.liar === ME ? '#opp-panel .purse' : '#me-panel .purse'));
          }
        });
        say(pickLine(ev.liar === BOT ? 'caughtLying' : 'catchesYou'));
        setMood(ev.liar === BOT ? 'caught' : 'smug');
        break;
      }
      case 'claimConfirmed': {
        log(`↳ ${ev.showdown ? 'Showdown' : `${who(ev.caller)} ${ev.caller === ME ? 'call' : 'calls'}`}: it really is a <b>${typeName(ev.pieceType)}</b>. Chip to ${ev.mover === ME ? 'you' : esc(midName(m.bot.name))}.`, 'true');
        m.flip.add(ev.pieceId);
        fx(() => {
          Sound.play('flip');
          setTimeout(() => Sound.play('coin'), 250);
          FX.stamp($('#fx-layer'), $('#board'), ev.square, 'True', 'true');
          FX.chipFly($(ev.caller === ME ? '#me-panel .purse' : '#opp-panel .purse'), $(ev.caller === ME ? '#opp-panel .purse' : '#me-panel .purse'));
        });
        say(pickLine(ev.caller === BOT ? 'wrongCall' : 'confirmed'));
        setMood(ev.caller === BOT ? 'nervous' : 'smug');
        break;
      }
      case 'captured':
        if (ev.claim && ev.claim !== ev.pieceType) log(`Captured card revealed: a ${typeName(ev.pieceType)} that claimed ${typeName(ev.claim)}.`, 'reveal');
        else if (ev.owner === BOT && !bv.pieces.find((x) => x.id === ev.pieceId)?.faceUp) log(`Captured card revealed: ${pieceIcon(ev.pieceType, 'black')} ${typeName(ev.pieceType)}.`, 'reveal');
        setMood(ev.owner === BOT ? 'nervous' : 'smug');
        break;
      case 'check':
        log(`${ev.player === ME ? 'You are' : `${esc(m.bot.name)} is`} in check.`, 'check');
        fx(() => Sound.play('check'));
        setMood(ev.player === ME ? 'smug' : 'nervous');
        break;
      case 'showdownAvailable':
        log(`${who(ev.player)} ${ev.player === ME ? 'are' : 'is'} checkmated on the apparent board. Showdown!`, 'showdown');
        Sound.play('showdown');
        void FX.banner('Showdown', ev.player === ME ? 'Expose a lying card, or lose.' : `${esc(m.bot.name)} looks for a lie.`);
        break;
      case 'showdown':
        log(`⚔ ${who(ev.player)} ${ev.player === ME ? 'expose' : 'exposes'} the card on ${ev.square} claiming ${typeName(ev.claim)}...`, 'showdown');
        break;
      case 'mateBroken':
        log('The mate is broken! Play continues.', 'showdown');
        break;
      case 'gameOver':
        log(resultText(ev), 'over');
        setMood(ev.winner === BOT ? 'triumphant' : ev.winner === ME ? 'beaten' : 'neutral', 60000);
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
  if (r.reason === 'chips') return r.winner === ME ? `You win: ${esc(midName(match().bot.name))} went bust.` : `You went bust. ${esc(match().bot.name)} wins.`;
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
  bubble.innerHTML = esc(text);
  bubble.classList.remove('hidden', 'pop');
  void bubble.offsetWidth;
  bubble.classList.add('pop');
  clearTimeout(speechTimer);
  speechTimer = setTimeout(() => bubble.classList.add('hidden'), 4200);
}

// ---------------------------------------------------------------------------
// Rendering the match

function renderOpp(): void {
  const m = app.match;
  const panel = $('#opp-panel');
  if (!m || !panel) return;
  const v = view();
  panel.innerHTML = R.oppPanelHTML({
    bot: m.bot, num: botNumber(m.botId), mood: m.thinking ? 'thinking' : m.mood, chips: v.chips[BOT],
    tray: R.capturedTray(v, BOT), thinking: m.thinking, isTurn: E.getActor(v) === BOT && !(m.lesson && m.lesson.phase !== 'playing'),
  });
}

function renderGame(): void {
  const m = app.match;
  if (!m || app.screen !== 'game') return;
  const v = view();
  const actor = E.getActor(v);
  const board = E.getApparentBoard(v);
  const legal = E.getLegalActions(v, ME);

  let checkSquare: Square | null = null;
  for (const c of [ME, BOT]) {
    if (E.inCheck(board, c)) checkSquare = v.pieces.find((p) => p.owner === c && p.type === 'king')?.square ?? null;
  }
  const targets = new Set<Square>();
  const captureTargets = new Set<Square>();
  const targetClaims = new Map<Square, ClaimType[]>();
  let legend: { types: ClaimType[]; multi: boolean } | null = null;
  if (m.selected && v.phase === 'move' && actor === ME) {
    const selected = v.pieces.find((p) => !p.captured && p.square === m.selected);
    const unclaimedCard = selected && !selected.faceUp && !selected.claim;
    for (const a of legal) {
      if (a.type !== 'move' || a.from !== m.selected) continue;
      targets.add(a.to);
      if (v.pieces.some((p) => !p.captured && p.square === a.to)) captureTargets.add(a.to);
      if (unclaimedCard && a.claim) targetClaims.set(a.to, [...(targetClaims.get(a.to) ?? []), a.claim]);
    }
    if (unclaimedCard && coachOn()) {
      const reach = [...targetClaims.values()];
      legend = { types: E.CLAIMABLE.filter((t) => reach.some((cs) => cs.includes(t))), multi: reach.some((cs) => cs.length > 1) };
    }
  }
  const showdownTargets = new Set<Square>();
  if (v.phase === 'showdown' && actor === ME) {
    for (const a of legal) {
      if (a.type !== 'showdown') continue;
      const sq = v.pieces.find((p) => p.id === a.targetPieceId)?.square;
      if (sq) showdownTargets.add(sq);
    }
  }
  const step = m.lesson ? lessonStep() : null;

  const boardEl = el('#board');
  const before = app.data.settings.reducedMotion ? null : FX.snapshotPieces(boardEl);
  boardEl.innerHTML = R.boardHTML(v, {
    me: ME, selected: m.selected, targets, captureTargets, targetClaims: coachOn() ? targetClaims : undefined,
    lastMove: m.lastMove, hover: m.hover, guesses: m.guesses, flip: m.flip, showdownTargets, checkSquare,
    hints: step && m.lesson?.phase === 'playing' ? step.highlight : m.stuck?.squares, final: v.phase === 'over',
  });
  if (before) FX.slidePieces(boardEl, before);
  m.flip.clear();

  renderOpp();
  el('#me-panel').innerHTML = R.mePanelHTML({ chips: v.chips[ME], tray: R.capturedTray(v, ME), isTurn: actor === ME });
  renderPrompt(v, actor);
  // Only replace the overlay when it changes, so the claim flag animates in once.
  const overlay = el('#board-overlay'), overlayNow = overlayHTML(v);
  if (overlay.dataset.html !== overlayNow) { overlay.dataset.html = overlayNow; overlay.innerHTML = overlayNow; }
  el('#action-panel').innerHTML = infoPanelHTML(v);
  const coach = el('#coach-card');
  coach.classList.toggle('hidden', !coachOn());
  if (coachOn()) coach.innerHTML = R.coachCardHTML(coachAdvice(v), legend);
  const hasCards = v.pieces.some((p) => p.owner === BOT && (!p.faceUp || p.claim));
  const tracker = el('#tracker');
  tracker.classList.toggle('hidden', !hasCards);
  tracker.innerHTML = hasCards ? R.trackerHTML(v, BOT) : '';
  const logEl = el('#log');
  logEl.innerHTML = R.logHTML(m.log);
  logEl.scrollTop = logEl.scrollHeight;
  renderHud();

  if (m.pendingFx.length) {
    const queue = m.pendingFx.splice(0);
    requestAnimationFrame(() => queue.forEach((f) => f()));
  }
}

/** The coach's current message, most urgent first. */
function coachAdvice(v: PlayerView): Advice | null {
  const m = match();
  if (m.guard) return m.guard.advice;
  if (m.note) return m.note;
  // In lessons the script decides calls; the coach would only contradict it.
  if (v.phase === 'callWindow' && v.pending?.mover === BOT && m.mode !== 'lesson') return callAdvice(v, m.bot.name, m.botThinks, m.lastThinkMs ?? undefined);
  if (m.choice && m.choice.options[0].claim) {
    const options = m.choice.options;
    const bluff = options.find((a) => claimAdvice(v, a, m.bot.name).tone !== 'good');
    return claimAdvice(v, bluff ?? options[0], m.bot.name);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Turn signals: the prompt bar under the board, the board edge, on-board labels

type PromptTone = 'act' | 'wait' | 'done';

interface Prompt {
  tone: PromptTone;
  /** Longer explanatory text, set smaller so it fits the bar. */
  small?: boolean;
  /** Identifies the situation; the bar animates in when it changes. */
  key: string;
  title: string;
  sub?: string;
  buttons?: string;
}

/** What the player should do right now, or who we're waiting for. */
function promptFor(v: PlayerView, actor: Color | null): Prompt {
  const m = match();
  const name = esc(m.bot.name);
  const run = m.lesson;
  const step = run ? lessonStep() : null;

  if (m.guard) {
    return {
      tone: 'act', key: 'guard', title: 'Are you sure?', sub: `${esc(m.guard.advice.lines.join(' '))} Click the board to choose again.`,
      buttons: '<button class="btn" data-act="guard-cancel">Take it back</button><button class="btn btn-ink" data-act="guard-confirm">Move anyway</button>',
    };
  }
  if (run && step) {
    if (run.phase === 'busy') return { tone: 'wait', key: `lesson-busy-${run.step}`, title: 'Watch the board' };
    const last = run.step + 1 === run.lesson.steps.length;
    if (run.phase === 'success' || step.expect === 'next') {
      return {
        tone: 'act', key: `lesson-next-${run.step}-${run.phase}`, title: run.phase === 'success' ? 'Well done' : 'Read the lesson',
        sub: run.phase === 'success' ? '' : 'Then continue.',
        buttons: `<button class="btn btn-ink" data-act="lesson-next">${last ? 'Finish lesson' : 'Continue'}</button>`,
      };
    }
  }
  if (v.phase === 'over' && v.result) {
    return {
      tone: 'done', key: 'over', title: resultText(v.result),
      buttons: '<button class="btn btn-red" data-act="reveal">See the reveal</button><button class="btn" data-act="rematch">Rematch</button>',
    };
  }
  if (v.phase === 'callWindow' && v.pending) {
    if (v.pending.mover === BOT) {
      return {
        tone: 'act', key: `call-${v.pending.pieceId}-${v.fullmove}`, title: 'Call or pass?', sub: `${name} claims ${claimTag(v.pending.claim!)}.`,
        buttons: `<button class="btn btn-ink" data-act="call" ${v.chips[ME] > 0 ? '' : 'disabled'}>Call <small>${v.config.chipsOutLoss && v.chips[ME] === 1 ? 'last chip' : '1 chip'} · C</small></button>
          <button class="btn" data-act="pass">Pass <small>P</small></button>`,
      };
    }
    return { tone: 'wait', key: 'bot-calling', title: `${name} is deciding`, sub: 'Will they call your claim?' };
  }
  if (v.phase === 'showdown') {
    if (actor === ME) {
      return {
        tone: 'act', key: 'showdown-me', title: 'Showdown', sub: 'Click a marked card to expose it for 1 chip.',
        buttons: m.mode === 'lesson' ? '' : '<button class="btn" data-act="accept-mate">Accept defeat</button>',
      };
    }
    return { tone: 'wait', key: 'showdown-bot', title: `${name} is in a showdown`, sub: 'Looking for a lie.' };
  }
  if (actor === ME) {
    if (m.choice) {
      return {
        tone: 'act', key: 'choice', title: m.choice.options[0].promotion ? 'Promote' : 'Choose a claim', sub: 'Pick from the card on the board.',
        buttons: '<button class="btn" data-act="cancel-choice">Cancel</button>',
      };
    }
    if (m.stuck) return { tone: 'act', key: `move-${v.fullmove}`, title: esc(m.stuck.title), sub: esc(m.stuck.text), small: true };
    const check = E.inCheck(E.getApparentBoard(v), ME);
    return { tone: 'act', key: `move-${v.fullmove}`, title: check ? 'Your move: check!' : 'Your move', sub: moveHint(v) };
  }
  return { tone: 'wait', key: 'bot-thinking', title: `${name} is thinking` };
}

function moveHint(v: PlayerView): string {
  const m = match();
  if (!m.selected) return 'Select one of your pieces.';
  const p = v.pieces.find((x) => !x.captured && x.square === m.selected);
  if (!p) return '';
  if (!p.faceUp && !p.claim) return `Your hidden ${typeName(p.type)} is unclaimed: it may move as any type.`;
  if (!p.faceUp) return `Hidden ${typeName(p.type)}, locked as a ${typeName(p.claim)}${p.claim !== p.type ? ' (a bluff)' : ''}.`;
  return `${typeName(p.type)} selected. Pick a marked square.`;
}

let lastActKey: string | null = null;

function renderPrompt(v: PlayerView, actor: Color | null): void {
  const m = match();
  const p = promptFor(v, actor);
  const bar = el('#prompt');
  const html = `<div class="prompt-text"><b>${p.title}</b>${p.sub ? `<span>${p.sub}</span>` : ''}</div>${p.buttons ? `<div class="prompt-actions">${p.buttons}</div>` : ''}`;
  if (bar.dataset.key !== p.key) {
    // New content rises in; a change of tone wipes the new colour across. When the
    // opponent has just acted, wait for their piece to land before asking anything.
    const prevTone = bar.dataset.tone;
    const late = prevTone === 'wait' && p.tone === 'act';
    bar.dataset.key = p.key;
    bar.dataset.tone = p.tone;
    bar.className = `prompt prompt-${p.tone} prompt-enter${prevTone !== p.tone ? ' prompt-tone-in' : ''}${late ? ' prompt-late' : ''}`;
  } else {
    bar.className = bar.className.replace(/prompt-(act|wait|done)/, `prompt-${p.tone}`);
  }
  bar.classList.toggle('prompt-small', !!p.small);
  if (bar.innerHTML !== html) bar.innerHTML = html;

  const frame = el('.board-frame');
  frame.classList.toggle('turn-me', p.tone === 'act');
  frame.classList.toggle('turn-opp', p.tone === 'wait' && actor === BOT);

  // A chime and a tab title when it becomes your turn.
  const acting = p.tone === 'act';
  if (acting && lastActKey === null && m.mode !== 'lesson') Sound.play('turn');
  lastActKey = acting ? p.key : null;
  document.title = acting ? `● ${p.title.replace(/<[^>]+>/g, '')} · Bluff Chess` : 'Bluff Chess';
}

/** Position of a square's top-centre within the board frame, in layout pixels. */
function squareSpot(sq: Square): { x: number; y: number; size: number; rank: number } {
  const size = el('#board').offsetWidth / 8;
  const file = sq.charCodeAt(0) - 97, rank = Number(sq[1]) - 1;
  const pad = 20;
  return { x: pad + (file + 0.5) * size, y: pad + (7 - rank) * size, size, rank };
}

/** On-board labels: the pending claim, and the claim picker at the destination square. */
function overlayHTML(v: PlayerView): string {
  const m = match();
  let html = '';
  if (v.phase === 'callWindow' && v.pending?.claim) {
    const s = squareSpot(v.pending.to);
    // Sit above the square unless that would cover a piece and the square below is free.
    const file = v.pending.to[0];
    const occupied = (rank: number) => rank >= 0 && rank <= 7 && v.pieces.some((p) => !p.captured && p.square === `${file}${rank + 1}`);
    const below = s.rank === 7 || (occupied(s.rank + 1) && !occupied(s.rank - 1));
    const text = v.pending.mover === BOT ? `Claims ${typeName(v.pending.claim)}?` : `You claim ${typeName(v.pending.claim)}`;
    html += `<div class="claim-flag${below ? ' below' : ''}${v.pending.mover === BOT ? ' theirs' : ''}" style="left:${s.x}px;top:${below ? s.y + s.size + 6 : s.y - 6}px">${text}</div>`;
  }
  if (m.choice) {
    const s = squareSpot(m.choice.options[0].to);
    const frameW = el('.board-frame').offsetWidth;
    const width = Math.min(frameW - 20, m.choice.options.length * 116 + 36);
    const x = Math.min(Math.max(s.x, width / 2 + 10), frameW - width / 2 - 10);
    const above = s.rank <= 3;
    const top = above ? s.y - 8 : s.y + s.size + 8;
    html += `<div class="claim-pop${above ? ' above' : ''}" style="left:${x}px;top:${top}px;width:${width}px">${choiceHTML(v, m.choice.options)}</div>`;
  }
  return html;
}

/** Sidebar detail: lesson text and the specifics of a pending claim. Actions live in the prompt bar. */
function infoPanelHTML(v: PlayerView): string {
  const m = match();
  let html = m.lesson ? lessonCardHTML() : '';
  if (v.phase === 'callWindow' && v.pending && v.pending.mover === BOT) {
    const p = v.pending;
    const claim = p.claim!;
    const certain = computeBeliefs(v).certainLies.includes(claim);
    const secs = m.lastThinkMs && m.mode !== 'lesson' ? ` · thought ${(m.lastThinkMs / 1000).toFixed(1)}s` : '';
    html += `<div class="ap-kicker">${codexLink('call', 'Their claim')}</div>
      <div class="ap-title">${esc(m.bot.name)} claims ${claimTag(claim)}</div>
      <div class="ap-sub">${p.castle ? 'Castled' : `Moved ${p.from}→${p.to}`}${p.capturedId ? ', capturing' : ''}${secs}</div>
      ${certain ? '<div class="ap-alert">More cards claim this than can exist, so one of them is lying.</div>' : ''}`;
  }
  return html;
}

function lessonCardHTML(): string {
  const run = match().lesson!;
  const step = lessonStep();
  return `<div class="lesson-panel">
    <div class="lp-head"><span>${esc(run.lesson.title)}</span><span class="lp-dots">${run.lesson.steps.map((_, i) => `<i class="${i < run.step ? 'done' : i === run.step ? 'now' : ''}"></i>`).join('')}</span></div>
    <div class="lp-say">${step.say}</div>
    ${run.feedback ? `<div class="lp-feedback ${run.feedback.tone}">${esc(run.feedback.text)}</div>` : ''}
  </div>`;
}

function choiceHTML(v: PlayerView, options: MoveAction[]): string {
  const m = match();
  const piece = v.pieces.find((x) => !x.captured && x.square === options[0].from);
  const isHonest = (a: MoveAction) => a.claim === piece?.type;
  const promo = options[0].promotion;
  const btns = options.map((a, i) => ({ a, i }))
    .sort((x, y) => Number(isHonest(y.a)) - Number(isHonest(x.a)))
    .map(({ a, i }) => {
      if (promo && a.promotion) return `<button class="btn btn-claim" data-act="choose" data-i="${i}">${pieceIcon(a.promotion)}<span>${typeName(a.promotion)}</span></button>`;
      const honest = isHonest(a);
      const risk = coachOn() && !honest ? claimAdvice(v, a, m.bot.name).tone : null;
      const tag = honest ? 'Honest' : risk === 'danger' ? 'Provable lie' : risk === 'good' ? 'Safe bluff' : 'Bluff';
      return `<button class="btn btn-claim${honest ? ' honest' : ''}${risk === 'danger' ? ' danger' : ''}" data-act="choose" data-i="${i}">
        ${a.claim ? pieceIcon(a.claim) : ''}<span>${typeName(a.claim)}</span><small>${tag}</small></button>`;
    }).join('');
  return `<div class="claim-pop-title">${promo ? 'Promote to' : `${options[0].from}→${options[0].to}: ${codexLink('claim', 'claim it as')}`}</div>
    <div class="claim-grid">${btns}</div>`;
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
  app.data.matchesPlayed += 1;
  save();
  m.newlyUnlocked = [...unlocked()].filter((id) => !before.has(id)).map((id) => app.bots[id].name);
  say(pickLine(outcome === 'w' ? 'lose' : outcome === 'l' ? 'win' : 'pass'));
  Sound.play(outcome === 'w' ? 'win' : 'lose');
  const title = outcome === 'w' ? 'You win' : outcome === 'l' ? 'You lose' : 'Draw';
  void FX.banner(title, resultText(result), outcome === 'w' ? 'win' : outcome === 'l' ? 'loss' : 'draw', 2000)
    .then(() => { if (app.match === m && app.screen === 'game') openReveal(); });
}

function openReveal(): void {
  const m = match();
  const r = m.state.result!;
  openModal(R.revealHTML({
    state: m.state, bot: m.bot, num: botNumber(m.botId), snaps: m.snaps, me: ME, newlyUnlocked: m.newlyUnlocked, resultText: resultText(r),
    won: r.winner ? r.winner === ME : null,
  }), 'modal-wide');
}

function leaveGame(): void {
  const m = app.match;
  if (!m) return show('hub');
  if (m.mode !== 'lesson' && m.state.phase !== 'over') {
    if (!confirm('Leave the table? This match will count as a loss.')) return;
    dispatch({ type: 'resign', player: ME }, { silentAdvance: true });
    finishMatch();
  }
  closeModal();
  app.match = null;
  show(m.mode === 'free' ? 'free' : m.mode === 'circuit' ? 'circuit' : m.mode === 'lesson' || m.mode === 'practice' ? 'lessons' : 'hub');
}

// ---------------------------------------------------------------------------
// Input

function onSquare(sq: Square): void {
  const m = app.match;
  if (!m || app.screen !== 'game' || m.busy) return;
  if (m.lesson && m.lesson.phase !== 'playing') return;
  // Clicking the board while the coach's warning is up means "take it back":
  // dismiss the warning and handle the click, so the board never feels frozen.
  if (m.guard) {
    m.guard = null;
    m.selected = null;
  }
  m.stuck = null;
  const v = view();
  const actor = E.getActor(v);
  if (actor !== ME) return;

  if (v.phase === 'showdown') {
    const p = v.pieces.find((x) => !x.captured && x.square === sq);
    if (p && E.getLegalActions(v, ME).some((a) => a.type === 'showdown' && a.targetPieceId === p.id)) {
      playerAct({ type: 'showdown', player: ME, targetPieceId: p.id });
    } else Sound.play('error');
    return;
  }
  if (v.phase !== 'move') return;

  m.choice = null;
  const legal = E.getLegalActions(v, ME).filter((a): a is MoveAction => a.type === 'move');
  const p = v.pieces.find((x) => !x.captured && x.square === sq);
  if (m.selected && m.selected !== sq) {
    const opts = legal.filter((a) => a.from === m.selected && a.to === sq);
    if (opts.length === 1) return playerAct(opts[0]);
    if (opts.length > 1) {
      m.choice = { options: opts };
      Sound.play('select');
      return renderGame();
    }
    if (!(p && p.owner === ME)) {
      // Not a legal destination: explain why.
      m.stuck = { title: 'Can\'t move there', text: explainIllegal(v, m.selected, sq) ?? 'That move isn\'t allowed.', squares: [] };
      Sound.play('error');
      return renderGame();
    }
  }
  if (p && p.owner === ME && m.selected !== sq) {
    if (legal.some((a) => a.from === sq)) {
      m.selected = sq;
      m.note = null;
      Sound.play('select');
    } else {
      m.selected = null;
      m.stuck = whyStuck(v, sq) ?? { title: 'No legal moves', text: 'That piece can\'t move right now.', squares: [] };
      Sound.play('error');
    }
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
  Sound.play('click');
  renderGame();
}

function onHover(pieceId: string, pieceEl: HTMLElement): void {
  const m = app.match;
  if (!m || app.screen !== 'game' || pieceEl.closest('.modal')) return;
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
  const stage = el('#stage');
  const k = FX.stageScale(stage);
  const s = stage.getBoundingClientRect();
  const r = pieceEl.getBoundingClientRect();
  const tt = el('#tooltip');
  tt.innerHTML = html;
  tt.classList.remove('hidden');
  const w = tt.offsetWidth, h = tt.offsetHeight;
  const cx = (r.left - s.left + r.width / 2) / k;
  const top = (r.top - s.top) / k;
  tt.style.left = `${Math.min(stage.offsetWidth - w - 10, Math.max(10, cx - w / 2))}px`;
  tt.style.top = `${top - h - 10 < 10 ? (r.bottom - s.top) / k + 10 : top - h - 10}px`;
}

function hideTooltip(): void {
  $('#tooltip')?.classList.add('hidden');
}

function playerDecision(type: 'call' | 'pass'): void {
  const m = app.match;
  if (!m || m.busy) return;
  if (m.lesson && m.lesson.phase !== 'playing') return;
  const v = view();
  if (v.phase !== 'callWindow' || !v.pending || v.pending.mover !== BOT) return;
  if (type === 'call') {
    if (v.chips[ME] <= 0) return;
    if (m.lesson && !lessonAccepts({ type: 'call', player: ME })) return;
    m.busy = true;
    Sound.play('call');
    FX.stamp($('#fx-layer'), $('#board'), v.pending.to, 'Called', 'call');
    setTimeout(() => {
      m.busy = false;
      if (m.lesson) {
        dispatch({ type: 'call', player: ME }, { silentAdvance: true });
        void lessonAfterAction();
      } else playerAct({ type: 'call', player: ME });
    }, 550 * Math.max(SPEED, 0.3));
  } else {
    if (m.lesson && !lessonAccepts({ type: 'pass', player: ME })) return;
    m.busy = true;
    Sound.play('step');
    FX.stamp($('#fx-layer'), $('#board'), v.pending.to, 'Pass', 'pass');
    setTimeout(() => {
      m.busy = false;
      playerAct({ type: 'pass', player: ME });
    }, 380 * Math.max(SPEED, 0.3));
  }
}

const handlers: InputHandlers = {
  action(name, ds, e) {
    const m = app.match;
    if (name !== 'close-modal-bg') Sound.play('click');
    switch (name) {
      case 'enter': return show('hub');
      case 'go-hub': return show('hub');
      case 'go-circuit': closeModal(); app.match = null; return show('circuit');
      case 'go-free': return show('free');
      case 'go-lessons': closeModal(); app.match = null; return show('lessons');
      case 'codex': return openCodex(ds.entry || 'overview');
      case 'settings': return openSettings();
      case 'toggle-mute':
        app.data.settings.muted = !app.data.settings.muted;
        applySettings();
        save();
        return renderHud();
      case 'toggle-coach':
        app.data.settings.coach = coachOn() ? 'off' : 'on';
        save();
        return app.screen === 'game' ? renderGame() : renderHud();
      case 'difficulty':
        app.data.settings.difficulty = ds.v as Store.Settings['difficulty'];
        save();
        openSettings();
        if (app.screen === 'circuit') show('circuit');
        return;
      case 'coach-mode':
        app.data.settings.coach = ds.v as Store.Settings['coach'];
        save();
        openSettings();
        return app.screen === 'game' ? renderGame() : renderHud();
      case 'reset-progress':
        if (confirm('Reset all progress: records, lessons, and what the regulars remember about you?')) {
          app.data = Store.blank();
          save();
          applySettings();
          closeModal();
          show('hub');
        }
        return;
      case 'profile-open': return openProfile();
      case 'profile-set':
        app.draftProfile = { ...app.draftProfile, [ds.k!]: ds.v };
        return openModal(R.profileHTML(app.draftProfile));
      case 'profile-done':
        if (app.draftProfile.chess && app.draftProfile.poker) app.data.profile = app.draftProfile as Profile;
        save();
        closeModal();
        return show(app.screen === 'lessons' ? 'lessons' : 'hub');
      case 'close-modal': return closeModal();
      case 'close-modal-bg':
        if (e.target instanceof Element && e.target.classList.contains('modal-overlay')) closeModal();
        return;
      case 'start-lesson': return startLesson(ds.lesson!);
      case 'practice': closeModal(); return startSetup(app.tutorialId, 'practice', {});
      case 'lesson-next': return lessonContinue();
      case 'pick-bot': return startSetup(ds.bot!, 'circuit', {});
      case 'free-bot':
        app.free.bot = ds.bot!;
        return show('free');
      case 'free-start':
        return startSetup(app.free.bot, 'free', {
          startingChips: app.free.startingChips, claimLocking: app.free.claimLocking,
          liarPaysChip: app.free.liarPaysChip, chipsOutLoss: app.free.chipsOutLoss,
          showdownsPerMate: app.free.oneShowdown ? 1 : 0,
        });
      case 'setup-back':
        return show(app.setup?.mode === 'free' ? 'free' : app.setup?.mode === 'practice' ? 'lessons' : 'circuit');
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
        if (a) playerAct(a);
        return;
      }
      case 'cancel-choice':
        if (!m) return;
        m.choice = null;
        m.selected = null;
        return renderGame();
      case 'guard-confirm': {
        const g = m?.guard;
        if (!m || !g) return;
        m.guard = null;
        return playerAct(g.action, { skipGuard: true });
      }
      case 'guard-cancel':
        if (!m) return;
        m.guard = null;
        m.selected = null;
        return renderGame();
      case 'accept-mate':
        return playerAct({ type: 'acceptMate', player: ME });
      case 'leave': return leaveGame();
      case 'reveal': return openReveal();
      case 'rematch':
        if (!m) return;
        closeModal();
        return startSetup(m.botId, m.mode, m.config);
      default:
    }
  },
  square: onSquare,
  guess: onGuess,
  hover: onHover,
  unhover: hideTooltip,
  knob(k, val) {
    const s = app.data.settings;
    if (k === 'startingChips') {
      app.free.startingChips = Number(val);
      el('#chip-val').textContent = String(val);
    } else if (k === 'claimLocking' || k === 'liarPaysChip' || k === 'chipsOutLoss' || k === 'oneShowdown') {
      app.free[k] = Boolean(val);
    } else if (k === 'volume') {
      s.volume = Number(val) / 100;
      applySettings();
      save();
    } else if (k === 'muted' || k === 'reducedMotion') {
      s[k] = Boolean(val);
      applySettings();
      save();
      renderHud();
    }
  },
  key(k) {
    const modalOpen = !!el('#modal-root').innerHTML;
    if (k === 'escape') {
      if (modalOpen) return closeModal();
      if (app.match) {
        app.match.selected = null;
        app.match.choice = null;
        app.match.guard = null;
        renderGame();
      }
    }
    if (app.screen !== 'game' || modalOpen) return;
    if (k === 'c') playerDecision('call');
    if (k === 'p') playerDecision('pass');
    if ((k === 'enter' || k === ' ') && app.match?.lesson) lessonContinue();
  },
};

init().catch((e: unknown) => {
  console.error(e);
  el('#screen').innerHTML = `<div class="boot-error"><h2>Could not start</h2><p>Bluff Chess uses ES modules and JSON data, so it must be served over HTTP, not opened as a file.</p><p>Run <code>npm start</code> in the project folder and open the printed URL.</p></div>`;
});
