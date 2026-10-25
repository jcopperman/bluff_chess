// Wires the engine, bot, coach, lessons, puzzles, PvP and UI together. The UI
// only ever renders one seat's view; the bot only ever receives its own view.

import * as E from './engine/index.ts';
import type {
  Action, Arrangement, ClaimType, Color, GameConfig, GameEvent, GameState, MoveAction, Piece, PlayerView, Result, Rng, Square,
} from './engine/index.ts';
import { chooseSetup, beliefsFor, applyDifficulty } from './bot/bot.ts';
import type { LineKey, PersonalityConfig, TableImage } from './bot/bot.ts';
import { computeBeliefs } from './bot/belief.ts';
import { explainIllegal, whyStuck, blunderCheck, claimAdvice, callAdvice } from './coach/advice.ts';
import type { Advice } from './coach/advice.ts';
import { matchesExpect, startStep, recommended } from './lessons/lessons.ts';
import type { Lesson, Profile } from './lessons/lessons.ts';
import { startPuzzle as puzzleState, judge, movesMade } from './puzzles/puzzles.ts';
import type { Puzzle, Verdict } from './puzzles/puzzles.ts';
import * as R from './ui/render.ts';
import type { BeliefSnap, CodexData, ColorChoice, FreeKnobs, LogEntry, LogKind, PvpForm } from './ui/render.ts';
import type { Mood } from './ui/art/emblems.ts';
import { bindInput } from './ui/input.ts';
import type { InputHandlers } from './ui/input.ts';
import * as FX from './ui/animations.ts';
import * as Sound from './ui/audio.ts';
import * as Store from './ui/storage.ts';
import { think } from './ui/think.ts';
import * as Net from './ui/online.ts';
import type { RoomMessage, Seat } from './ui/online.ts';

declare global {
  interface Window {
    bluffChess?: { app: App; E: typeof E; advance: () => void };
  }
}

/** The seat whose view the screen shows: the human against a bot, the player holding the device, or our online seat. */
const me = (): Color => app.match?.me ?? 'white';
const opp = (): Color => E.opponent(me());
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

/** circuit, free, practice, lesson and puzzle are against a bot; local is pass-and-play; online is a room. */
type Mode = 'circuit' | 'free' | 'practice' | 'lesson' | 'puzzle' | 'local' | 'online';
type Screen = 'title' | 'hub' | 'circuit' | 'free' | 'lessons' | 'puzzles' | 'pvp' | 'room' | 'setup' | 'game';

const vsHuman = (mode: Mode) => mode === 'local' || mode === 'online';

interface SetupState {
  mode: Mode;
  botId: string;
  config: GameConfig;
  arrangement: Arrangement;
  picked: number | null;
  /** The seat being arranged. */
  color: Color;
  /** Bot matches: which side to play. */
  colorChoice: ColorChoice | null;
  /** Pass-and-play: both names, and White's arrangement once White is done. */
  local?: { names: Record<Color, string>; white?: Arrangement };
}

interface LessonRun {
  lesson: Lesson;
  step: number;
  /** playing: waiting for the player; success: step done, waiting for Continue; busy: scripted moves running. */
  phase: 'playing' | 'success' | 'busy';
  feedback: { tone: 'hint' | 'success'; text: string } | null;
}

interface PuzzleRun {
  puzzle: Puzzle;
  /** History length when the puzzle began (scripted moves excluded from your count). */
  start: number;
  verdict: Verdict;
}

interface Match {
  mode: Mode;
  /** The seat on screen. Changes hands in pass-and-play. */
  me: Color;
  /** Display names. Against a bot or online, our own seat is "You". */
  names: Record<Color, string>;
  botId: string;
  /** The opponent's card: a character, or a plain card for a human. */
  bot: PersonalityConfig;
  config: GameConfig;
  seed: number;
  rng: Rng;
  state: GameState;
  memory: TableImage;
  log: LogEntry[];
  snaps: BeliefSnap[];
  /** Right-click notes on the other side's cards, per seat. */
  notes: Record<Color, Record<string, ClaimType>>;
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
  puzzle: PuzzleRun | null;
  /** Pass-and-play: the table is covered until this seat takes the device. */
  curtain: Color | null;
  /** Pass-and-play: how much of the log each seat has seen. */
  seen: Record<Color, number>;
  /** Online: which game in the room this match is. */
  game: number;
}

interface OnlineLink {
  seat: Seat;
  names: Record<Color, string>;
  seated: Record<Color, boolean>;
  online: Record<Color, boolean>;
  rematch: Record<Color, boolean>;
  down: boolean;
  stop: () => void;
}

interface App {
  roster: string[];
  tutorialId: string;
  bots: Record<string, PersonalityConfig>;
  lessons: Lesson[];
  puzzles: Puzzle[];
  codex: CodexData;
  data: Store.SaveData;
  screen: Screen;
  free: FreeKnobs;
  setup: SetupState | null;
  lastArrangement: Arrangement | null;
  match: Match | null;
  draftProfile: Partial<Profile>;
  pvp: PvpForm;
  pvpError: string | null;
  pvpBusy: boolean;
  online: OnlineLink | null;
  /** Whether a room server answered at boot; without one the PvP screen offers only same-device play. */
  onlineAvailable: boolean;
}

const app: App = {
  roster: [],
  tutorialId: 'tutor',
  bots: {},
  lessons: [],
  puzzles: [],
  codex: { categories: [] },
  data: Store.load(),
  screen: 'title',
  free: { bot: '', startingChips: 4, claimLocking: true, liarPaysChip: true, chipsOutLoss: true, oneShowdown: false },
  setup: null,
  lastArrangement: null,
  match: null,
  draftProfile: {},
  pvp: { white: 'White', black: 'Black', name: '', color: 'random', code: '' },
  pvpError: null,
  pvpBusy: false,
  online: null,
  onlineAvailable: false,
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
  const puzzleIds = await fetchJson<string[]>('data/puzzles/index.json');
  app.puzzles = await Promise.all(puzzleIds.map((id) => fetchJson<Puzzle>(`data/puzzles/${id}.json`)));
  app.codex = await fetchJson<CodexData>('data/codex.json');
  app.free.bot = app.roster[0];
  app.pvp.name = app.data.settings.playerName;
  applySettings();
  if (params.has('debug')) window.bluffChess = { app, E, advance: () => advance() };
  bindInput(el('#app'), handlers);
  window.addEventListener('resize', fitStage);
  fitStage();
  show('title');
  // A reload during an online game rejoins it.
  app.onlineAvailable = await Net.serverAvailable();
  const seat = Net.savedSeat();
  if (seat && app.onlineAvailable) goOnline(seat);
  if (app.screen === 'pvp') show('pvp');
}

/**
 * Fit the stage to the window. Tablets and desktops scale a fixed stage (16:9, or tall
 * when portrait). Phones get the window itself at real pixel size, so text stays readable
 * and nothing is letterboxed; the phone styles lay the screens out for that.
 */
function fitStage(): void {
  const stage = el('#stage');
  const vw = window.innerWidth, vh = window.innerHeight;
  const portrait = vw < vh * 0.9;
  const phone = Math.min(vw, vh) < 560;
  const [w, h] = phone ? [vw, vh] : portrait ? [900, 1600] : [1600, 900];
  const changed = stage.dataset.layout !== (portrait ? 'portrait' : 'landscape') || stage.dataset.size !== (phone ? 'phone' : 'stage');
  stage.dataset.layout = portrait ? 'portrait' : 'landscape';
  stage.dataset.size = phone ? 'phone' : 'stage';
  stage.style.width = `${w}px`;
  stage.style.height = `${h}px`;
  stage.style.setProperty('--stage-w', `${w}px`);
  stage.style.setProperty('--stage-h', `${h}px`);
  stage.style.setProperty('--scale', String(phone ? 1 : Math.min(vw / w, vh / h)));
  // Overlay labels are placed in pixels, so redraw the board when the layout changes size.
  if (app.screen === 'game' && app.match) {
    if (changed) hideTooltip();
    renderGame({ noSlide: true });
  }
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
  // Puzzles test what you can read yourself.
  if (m?.mode === 'puzzle') return false;
  if (m && (m.mode === 'lesson' || m.mode === 'practice')) return app.data.settings.coach !== 'off';
  const c = app.data.settings.coach;
  return c === 'on' || (c === 'auto' && app.data.matchesPlayed < 5);
}

// ---------------------------------------------------------------------------
// Screens

const TITLES: Record<Screen, string> = {
  title: '', hub: '', circuit: 'Circuit', free: 'Free play', lessons: 'Lessons', puzzles: 'Puzzles', pvp: 'Player vs player', room: 'Online room',
  setup: 'Setup', game: '',
};

/** Card number for a character: the tutor is 0, circuit opponents I to V. */
function botNumber(id: string): number {
  return id === app.tutorialId ? 0 : app.roster.indexOf(id) + 1;
}

/** Corner mark on the opponent's card. */
function oppNumber(m: Match): number | string {
  return vsHuman(m.mode) ? (opp() === 'white' ? 'W' : 'B') : botNumber(m.botId);
}

/** A plain card standing in for a human opponent. */
function humanCard(name: string, color: Color): PersonalityConfig {
  return { id: `human-${color}`, name, title: '', avatar: '', color: '', blurb: '', teaches: '' };
}

function matchTitle(m: Match): string {
  if (m.mode === 'lesson') return `Lesson · ${m.lesson!.lesson.title}`;
  if (m.mode === 'puzzle') return `Puzzle · ${m.puzzle!.puzzle.title}`;
  if (m.mode === 'local') return `${m.names.white} vs ${m.names.black}`;
  if (m.mode === 'online') return `Online · versus ${m.names[opp()]}`;
  return `Versus ${m.bot.name}`;
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
  const title = inGame ? matchTitle(m) : TITLES[app.screen];
  const back = app.screen === 'hub' ? null : inGame ? 'leave' : app.screen === 'setup' ? 'setup-back' : app.screen === 'room' ? 'room-leave' : 'go-hub';
  hud.innerHTML = R.hudHTML({ title, back, inGame: inGame && m.mode !== 'puzzle', muted: app.data.settings.muted, coachOn: coachOn() });
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
  } else if (screen === 'puzzles') {
    root.innerHTML = R.puzzlesScreen({ puzzles: app.puzzles, done: new Set(app.data.puzzlesDone) });
  } else if (screen === 'pvp') {
    root.innerHTML = R.pvpScreen({ form: app.pvp, error: app.pvpError, busy: app.pvpBusy, online: app.onlineAvailable });
  } else if (screen === 'room' && app.online) {
    const o = app.online;
    root.innerHTML = R.roomScreen({ code: o.seat.code, you: o.seat.color, names: o.names, joined: o.seated[E.opponent(o.seat.color)], down: o.down });
  } else if (screen === 'setup' && app.setup) {
    root.innerHTML = R.setupScreen(setupView(app.setup));
  }
  renderHud();
}

function setupView(s: SetupState) {
  const base = { arrangement: s.arrangement, picked: s.picked, color: s.color, colorChoice: s.colorChoice };
  if (s.local) {
    const other = E.opponent(s.color);
    return {
      ...base, heading: `${s.local.names[s.color]}: arrange your back rank`,
      side: `${R.cardBack(other === 'white' ? 'W' : 'B')}<p>${esc(s.local.names[other])}, look away.</p>`,
      startLabel: s.color === 'white' ? `Done: pass to ${s.local.names.black}` : 'Done: start the game',
    };
  }
  if (s.mode === 'online' && app.online) {
    const o = app.online;
    const them = E.opponent(s.color);
    return {
      ...base, heading: 'Arrange your back rank',
      side: `${R.characterCard(humanCard(o.names[them], them), them === 'white' ? 'W' : 'B', { mood: 'thinking' })}<p>${esc(o.names[them])} is arranging in secret.</p>`,
      startLabel: 'Ready',
    };
  }
  return { ...base, heading: 'Arrange your back rank', side: R.setupBotSide(app.bots[s.botId], botNumber(s.botId)) };
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
  el('#modal-root').innerHTML = `<div class="modal-overlay${cls.includes('modal-curtain') ? ' curtain-overlay' : ''}" data-act="close-modal-bg"><div class="modal ${cls}">${html}</div></div>`;
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
  const choice = app.data.settings.seat;
  app.setup = {
    botId, mode, config, arrangement: [...(app.lastArrangement || E.CLASSIC_ARRANGEMENT)], picked: null,
    color: choice === 'black' ? 'black' : 'white', colorChoice: choice,
  };
  show('setup');
}

function newMatch(mode: Mode, botId: string, config: GameConfig, state: GameState, rng: Rng, seed: number, seat: Color = 'white'): Match {
  const names = { white: 'White', black: 'Black' } as Record<Color, string>;
  names[seat] = 'You';
  names[E.opponent(seat)] = app.bots[botId]?.name ?? 'Opponent';
  return {
    mode, me: seat, names, botId, bot: app.bots[botId], config, seed, rng, state,
    memory: app.data.memory[botId] || Store.blankMemory(),
    log: [], snaps: [], notes: { white: {}, black: {} }, selected: null, choice: null, guard: null, note: null, stuck: null, hover: [],
    flip: new Set(), pendingFx: [], lastMove: null, busy: false, thinking: false, lastThinkMs: null, botThinks: [], mood: 'neutral', over: false,
    newlyUnlocked: [], lesson: null, puzzle: null, curtain: null, seen: { white: 0, black: 0 }, game: 0,
  };
}

function enterGame(m: Match): void {
  app.match = m;
  app.screen = 'game';
  hideTooltip();
  closeModal();
  const root = el('#screen');
  root.className = 'screen screen-game';
  root.innerHTML = R.gameShell(m.mode);
  infoOpen = false;
  renderHud();
}

function startMatch(): void {
  const setup = app.setup;
  if (!setup) return;
  if (setup.local) return localSetupDone(setup);
  if (setup.mode === 'online') return onlineSetupDone(setup);
  const { botId, mode, config, arrangement, colorChoice } = setup;
  app.lastArrangement = [...arrangement];
  const bot = app.bots[botId];
  const seed = (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0;
  const rng = E.createRng(seed);
  const seat: Color = colorChoice === 'random' ? (rng.chance(0.5) ? 'white' : 'black') : setup.color;
  const state = E.createGame({ ...config, setups: { [seat]: arrangement, [E.opponent(seat)]: chooseSetup(bot, rng) } });
  enterGame(newMatch(mode, botId, config, state, rng, seed, seat));
  log(seat === 'white' ? `New game against ${esc(bot.name)}. You are white and move first.` : `New game against ${esc(bot.name)}. You are black: ${esc(bot.name)} moves first.`, 'system');
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
// Puzzles

function startPuzzle(id: string): void {
  const puzzle = app.puzzles.find((p) => p.id === id);
  if (!puzzle) return;
  const state = puzzleState(puzzle);
  const m = newMatch('puzzle', puzzle.opponent, puzzle.position, state, E.createRng(7), 7);
  m.bot = { ...app.bots[puzzle.opponent], ...puzzle.overrides };
  m.puzzle = { puzzle, start: state.history.length, verdict: 'playing' };
  // Show the scripted move that set the puzzle up.
  const last = [...state.history].reverse().find((a): a is MoveAction => a.type === 'move');
  if (last) m.lastMove = { from: last.from, to: last.to };
  enterGame(m);
  log(`Puzzle: ${esc(puzzle.title)}`, 'system');
  Sound.play('step');
  advance();
}

function puzzleJudge(before: GameState, action: Action, events: GameEvent[]): void {
  const m = match();
  const run = m.puzzle;
  if (!run || run.verdict !== 'playing') return;
  run.verdict = judge(run.puzzle, before, action, m.state, events, run.start);
  if (run.verdict === 'solved') {
    if (!app.data.puzzlesDone.includes(run.puzzle.id)) app.data.puzzlesDone.push(run.puzzle.id);
    save();
    m.pendingFx.push(() => Sound.play('win'));
    setMood('beaten', 60000);
  } else if (run.verdict === 'failed') {
    m.pendingFx.push(() => Sound.play('lose'));
    setMood('smug', 60000);
  }
}

function nextPuzzle(): Puzzle | null {
  const run = match().puzzle!;
  const idx = app.puzzles.indexOf(run.puzzle);
  // The next unsolved puzzle, wrapping around; failing that, simply the next one.
  const order = [...app.puzzles.slice(idx + 1), ...app.puzzles.slice(0, idx)];
  return order.find((p) => !app.data.puzzlesDone.includes(p.id)) ?? app.puzzles[idx + 1] ?? null;
}

// ---------------------------------------------------------------------------
// Pass-and-play

function startLocalSetup(names: Record<Color, string>): void {
  app.setup = {
    mode: 'local', botId: '', config: {}, arrangement: [...E.CLASSIC_ARRANGEMENT], picked: null, color: 'white', colorChoice: null,
    local: { names },
  };
  show('setup');
}

function localSetupDone(setup: SetupState): void {
  const local = setup.local!;
  if (setup.color === 'white') {
    // Cover White's arrangement before Black sits down.
    local.white = [...setup.arrangement];
    setup.color = 'black';
    setup.arrangement = [...E.CLASSIC_ARRANGEMENT];
    setup.picked = null;
    show('setup');
    openModal(R.curtainHTML({ name: local.names.black, color: 'black', recent: [], setup: true }), 'modal-curtain');
    return;
  }
  const state = E.createGame({ setups: { white: local.white!, black: setup.arrangement } });
  const seed = Date.now() >>> 0;
  const m = newMatch('local', '', {}, state, E.createRng(seed), seed, 'black');
  m.names = { ...local.names };
  m.bot = humanCard(local.names.white, 'white');
  enterGame(m);
  const seat = (c: Color) => `${esc(local.names[c])}${local.names[c].toLowerCase() === c ? '' : ` (${c})`}`;
  log(`${seat('white')} against ${seat('black')}. White moves first.`, 'system');
  advance();
}

/** Uncover the table for the seat whose turn it is. */
function openCurtain(): void {
  const m = app.match;
  if (app.screen === 'setup') return closeModal();
  if (!m || !m.curtain) return;
  m.seen[m.curtain] = m.log.length;
  m.me = m.curtain;
  m.bot = humanCard(m.names[opp()], opp());
  m.curtain = null;
  m.selected = null;
  m.choice = null;
  m.guard = null;
  m.stuck = null;
  m.note = null;
  renderGame({ noSlide: true });
}

// ---------------------------------------------------------------------------
// Online

function goOnline(seat: Seat): void {
  app.online?.stop();
  Net.rememberSeat(seat);
  const link: OnlineLink = {
    seat, names: { white: 'White', black: 'Black' }, seated: { white: false, black: false }, online: { white: false, black: false },
    rematch: { white: false, black: false }, down: false, stop: () => {},
  };
  app.online = link;
  link.stop = Net.connect(seat, (msg) => { if (app.online === link) onRoomMessage(msg); }, (down) => {
    if (app.online !== link || link.down === down) return;
    link.down = down;
    if (app.screen === 'room') show('room');
    else if (app.screen === 'game') renderGame();
  });
  show('room');
}

function leaveOnline(): void {
  app.online?.stop();
  app.online = null;
  Net.rememberSeat(null);
}

function onRoomMessage(msg: RoomMessage): void {
  const o = app.online!;
  if (msg.type === 'error') {
    app.pvpError = msg.message;
    return;
  }
  o.names = msg.names;
  o.seated = msg.seated;
  o.online = msg.online;
  o.rematch = msg.rematch;
  o.seat.color = msg.you;
  Net.rememberSeat(o.seat);
  const v = msg.view;
  const them = E.opponent(msg.you);
  if (!o.seated[them]) return show('room');
  const m = app.match;
  const current = m && m.mode === 'online' && m.game === msg.game ? m : null;
  if (!current && v.phase === 'setup' && !v.setupDone[msg.you]) {
    if (app.screen !== 'setup' || app.setup?.mode !== 'online') {
      app.match = null;
      app.setup = {
        mode: 'online', botId: '', config: {}, arrangement: [...(app.lastArrangement || E.CLASSIC_ARRANGEMENT)], picked: null,
        color: msg.you, colorChoice: null,
      };
      show('setup');
    }
    return;
  }
  if (!current) {
    const nm = newMatch('online', '', {}, v, E.createRng(1), 1, msg.you);
    nm.names[them] = o.names[them];
    nm.bot = humanCard(o.names[them], them);
    nm.game = msg.game;
    enterGame(nm);
    log(`Online game against ${esc(o.names[them])}. You are ${msg.you}${msg.you === 'white' ? ' and move first' : ''}.`, 'system');
    advance();
    return;
  }
  current.names[them] = o.names[them];
  current.bot = humanCard(o.names[them], them);
  const before = current.state;
  current.state = v;
  current.busy = false;
  if (msg.events.length) handleEvents(msg.events, before);
  if (app.screen === 'game') advance();
}

function onlineSetupDone(setup: SetupState): void {
  const o = app.online;
  if (!o) return;
  app.lastArrangement = [...setup.arrangement];
  const action: Action = { type: 'setup', player: setup.color, arrangement: [...setup.arrangement] };
  Net.sendAction(o.seat, action).catch((e: Error) => {
    app.pvpError = e.message;
    show('pvp');
  });
}

async function createOnline(): Promise<void> {
  app.pvpBusy = true;
  app.pvpError = null;
  show('pvp');
  try {
    const seat = await Net.createRoom(app.pvp.name, app.pvp.color);
    app.pvpBusy = false;
    goOnline(seat);
  } catch (e) {
    app.pvpBusy = false;
    app.pvpError = (e as Error).message;
    show('pvp');
  }
}

async function joinOnline(): Promise<void> {
  if (!app.pvp.code.trim()) {
    app.pvpError = 'Type the room code your friend sent you.';
    return show('pvp');
  }
  app.pvpBusy = true;
  app.pvpError = null;
  show('pvp');
  try {
    const seat = await Net.joinRoom(app.pvp.code, app.pvp.name);
    app.pvpBusy = false;
    goOnline(seat);
  } catch (e) {
    app.pvpBusy = false;
    app.pvpError = (e as Error).message;
    show('pvp');
  }
}

// ---------------------------------------------------------------------------
// Game loop

function match(): Match {
  if (!app.match) throw new Error('No match in progress');
  return app.match;
}

const view = (): PlayerView => E.getPlayerView(match().state, me());

/** Whether the bot (not a human) controls the other seat right now. */
function botControlled(m: Match): boolean {
  return !vsHuman(m.mode) && m.mode !== 'lesson' && !(m.puzzle && m.puzzle.verdict !== 'playing');
}

function advance(): void {
  const m = match();
  const s = m.state;
  if (m.mode === 'local' && s.phase !== 'over' && !m.curtain) {
    const actor = E.getActor(s);
    if (actor && actor !== m.me) {
      m.seen[m.me] = m.log.length;
      m.curtain = actor;
    }
  }
  renderGame();
  if (m.mode === 'lesson') return;
  if (s.phase === 'over') {
    if (!m.over && m.mode !== 'puzzle') finishMatch();
    return;
  }
  if (botControlled(m) && E.getActor(s) === opp() && !m.busy) void botAct();
}

async function botAct(): Promise<void> {
  const m = match();
  m.busy = true;
  m.thinking = true;
  renderGame();
  const v = E.getPlayerView(m.state, opp());
  const t0 = performance.now();
  const level = m.mode === 'puzzle' ? 'normal' : app.data.settings.difficulty;
  const d = await think(v, applyDifficulty(m.bot, level), m.memory, m.rng.int(0x7fffffff));
  const elapsed = performance.now() - t0;
  if (app.match !== m) return;
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
  if (m.mode === 'online') return sendOnline(action);
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
  if (m.puzzle) puzzleJudge(before, action, res.events);
  if (opts.silentAdvance) renderGame();
  else advance();
}

/** Online, the server applies the action; the result comes back over the event stream. */
function sendOnline(action: Action): void {
  const m = match();
  const o = app.online;
  if (!o || m.busy) return;
  m.busy = true;
  m.selected = null;
  m.choice = null;
  renderGame();
  Net.sendAction(o.seat, action).catch((e: Error) => {
    if (app.match !== m) return;
    m.busy = false;
    m.stuck = { title: 'Not sent', text: e.message, squares: [] };
    renderGame();
  });
}

// ---------------------------------------------------------------------------
// Events -> log, speech, sound, effects, moods

/** True when `color` is the player reading the screen as "you" (never in pass-and-play, where both share it). */
function isYou(color: Color): boolean {
  const m = match();
  return m.mode !== 'local' && color === m.me;
}

function who(color: Color): string {
  return isYou(color) ? 'You' : esc(match().names[color]);
}

/** Verb agreement: "You call" / "The Deacon calls". */
function verb(color: Color, base: string, third: string): string {
  return `${who(color)} ${isYou(color) ? base : third}`;
}

function pieceLabel(p: Piece | undefined): string {
  if (!p) return 'piece';
  if (p.faceUp && p.type) return `${pieceIcon(p.type, p.owner)} ${typeName(p.type)}`;
  if (p.type) return `hidden ${typeName(p.type)}`;
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
  // The log is shared at a pass-and-play table, so there it only uses public information.
  const bv = m.mode === 'local' ? E.getPublicView(before) : E.getPlayerView(before, me());
  const fx = (f: () => void) => m.pendingFx.push(f);
  const vsBot = !vsHuman(m.mode);

  for (const ev of events) {
    switch (ev.type) {
      case 'moved': {
        m.lastMove = { from: ev.from, to: ev.to };
        Sound.play(ev.capturedId ? 'capture' : 'move');
        const p = bv.pieces.find((x) => x.id === ev.pieceId);
        const cap = ev.capturedId ? bv.pieces.find((x) => x.id === ev.capturedId) : undefined;
        const n = m.mode === 'lesson' || m.mode === 'puzzle' ? '' : `${before.fullmove}${ev.player === 'white' ? '.' : '…'}`;
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
        if (ev.claim && isYou(ev.player) && mover?.type && mover.type !== ev.claim) text += ' <span class="tag-bluff">bluff</span>';
        if (ev.claim && ev.player === opp() && vsBot && m.lastThinkMs && m.mode !== 'lesson') text += ` <span class="think" title="Think time">${(m.lastThinkMs / 1000).toFixed(1)}s</span>`;
        log(text, ev.claim ? 'claim' : 'move', n);
        break;
      }
      case 'claimMade':
        if (ev.player === me() && vsBot && m.mode !== 'lesson' && m.mode !== 'puzzle') {
          const bview = E.getPlayerView(m.state, opp());
          const dist = beliefsFor(bview, m.bot, m.memory).probs[ev.pieceId];
          if (dist) m.snaps.push({ fullmove: before.fullmove, pieceId: ev.pieceId, claim: ev.claim, square: ev.square, dist });
        }
        break;
      case 'passed':
        log(`↳ ${verb(ev.player, 'pass', 'passes')}.`, 'pass');
        break;
      case 'called':
        if (ev.player === me()) Sound.play('call');
        break;
      case 'lieCaught': {
        const liarIs = isYou(ev.liar) ? 'You are' : `${esc(m.names[ev.liar])} is`;
        log(`↳ ${ev.showdown ? 'Showdown' : verb(ev.caller, 'call', 'calls')}: <b>a lie.</b> The ${typeName(ev.pieceType)} claiming ${typeName(ev.claim)} is removed${ev.restoredId ? ' and the capture is undone' : ''}.${ev.paid ? ` Chip to ${isYou(ev.caller) ? 'you' : esc(midName(m.names[ev.caller]))}.` : ''}${ev.stillInCheck ? ` ${liarIs} back in check and must answer it.` : ''}`, 'lie');
        fx(() => {
          Sound.play('lie');
          FX.stamp($('#fx-layer'), $('#board'), ev.square, 'Liar', 'lie');
          if (!app.data.settings.reducedMotion) FX.shake($('#board'));
          if (ev.paid) {
            setTimeout(() => Sound.play('coin'), 250);
            FX.chipFly($(ev.liar === me() ? '#me-panel .purse' : '#opp-panel .purse'), $(ev.liar === me() ? '#opp-panel .purse' : '#me-panel .purse'));
          }
        });
        say(pickLine(ev.liar === opp() ? 'caughtLying' : 'catchesYou'));
        setMood(ev.liar === opp() ? 'caught' : 'smug');
        break;
      }
      case 'claimConfirmed': {
        log(`↳ ${ev.showdown ? 'Showdown' : verb(ev.caller, 'call', 'calls')}: it really is a <b>${typeName(ev.pieceType)}</b>. Chip to ${isYou(ev.mover) ? 'you' : esc(midName(m.names[ev.mover]))}.`, 'true');
        m.flip.add(ev.pieceId);
        fx(() => {
          Sound.play('flip');
          setTimeout(() => Sound.play('coin'), 250);
          FX.stamp($('#fx-layer'), $('#board'), ev.square, 'True', 'true');
          FX.chipFly($(ev.caller === me() ? '#me-panel .purse' : '#opp-panel .purse'), $(ev.caller === me() ? '#opp-panel .purse' : '#me-panel .purse'));
        });
        say(pickLine(ev.caller === opp() ? 'wrongCall' : 'confirmed'));
        setMood(ev.caller === opp() ? 'nervous' : 'smug');
        break;
      }
      case 'captured': {
        const known = bv.pieces.find((x) => x.id === ev.pieceId);
        if (ev.claim && ev.claim !== ev.pieceType) log(`Captured card revealed: a ${typeName(ev.pieceType)} that claimed ${typeName(ev.claim)}.`, 'reveal');
        else if (known && !known.faceUp && !known.type) log(`Captured card revealed: ${pieceIcon(ev.pieceType, ev.owner)} ${typeName(ev.pieceType)}.`, 'reveal');
        setMood(ev.owner === opp() ? 'nervous' : 'smug');
        break;
      }
      case 'check':
        log(`${isYou(ev.player) ? 'You are' : `${esc(m.names[ev.player])} is`} in check.`, 'check');
        fx(() => Sound.play('check'));
        setMood(ev.player === me() ? 'smug' : 'nervous');
        break;
      case 'showdownAvailable':
        log(`${who(ev.player)} ${isYou(ev.player) ? 'are' : 'is'} checkmated on the apparent board. Showdown!`, 'showdown');
        Sound.play('showdown');
        void FX.banner('Showdown', isYou(ev.player) ? 'Expose a lying card, or lose.' : `${esc(m.names[ev.player])} looks for a lie.`);
        break;
      case 'showdown':
        log(`⚔ ${verb(ev.player, 'expose', 'exposes')} the card on ${ev.square} claiming ${typeName(ev.claim)}...`, 'showdown');
        break;
      case 'mateBroken':
        log('The mate is broken! Play continues.', 'showdown');
        break;
      case 'gameOver':
        log(resultText(ev), 'over');
        setMood(ev.winner === opp() ? 'triumphant' : ev.winner === me() ? 'beaten' : 'neutral', 60000);
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
  const m = match();
  const w = r.winner, l = E.opponent(w);
  if (r.reason === 'chips') {
    return isYou(w) ? `You win: ${esc(midName(m.names[l]))} went bust.` : `${who(l)} went bust. ${verb(w, 'win', 'wins')}.`;
  }
  return `${verb(w, 'win', 'wins')} by ${REASONS[r.reason]}.`;
}

function log(html: string, kind: LogKind, n?: string): void {
  match().log.push({ html, kind, n });
}

function pickLine(key: LineKey): string | null {
  const lines = match().bot.lines?.[key];
  return lines?.length ? lines[Math.floor(Math.random() * lines.length)] : null;
}

/** Which side panel a phone shows below the board: they don't fit side by side. */
type SideTab = 'coach' | 'claims' | 'log';
let sideTab: SideTab = 'coach';
/** Upright phones keep the side panel in a popup so the board can take the screen's width. */
let infoOpen = false;

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

/** What the screen shows: the seat's own view, or only public information while the table is covered. */
function shownView(m: Match): PlayerView {
  return m.curtain ? E.getPublicView(m.state) : E.getPlayerView(m.state, m.me);
}

function renderOpp(): void {
  const m = app.match;
  const panel = $('#opp-panel');
  if (!m || !panel) return;
  const v = shownView(m);
  const o = app.online;
  panel.innerHTML = R.oppPanelHTML({
    bot: m.bot, num: oppNumber(m), mood: m.thinking ? 'thinking' : m.mood, chips: v.chips[opp()], color: opp(),
    tray: R.capturedTray(v, opp()), thinking: m.thinking, isTurn: E.getActor(v) === opp() && !(m.lesson && m.lesson.phase !== 'playing'),
    status: m.mode === 'online' && o && !o.online[opp()] && v.phase !== 'over' ? 'Offline' : undefined,
  });
}

function renderGame(opts: { noSlide?: boolean } = {}): void {
  const m = app.match;
  if (!m || app.screen !== 'game') return;
  const v = shownView(m);
  const actor = E.getActor(v);
  const board = E.getApparentBoard(v);
  const legal = m.curtain ? [] : E.getLegalActions(v, me());

  let checkSquare: Square | null = null;
  for (const c of ['white', 'black'] as const) {
    if (E.inCheck(board, c)) checkSquare = v.pieces.find((p) => p.owner === c && p.type === 'king')?.square ?? null;
  }
  const targets = new Set<Square>();
  const captureTargets = new Set<Square>();
  const targetClaims = new Map<Square, ClaimType[]>();
  const castles = new Map<Square, Square>();
  let legend: { types: ClaimType[]; multi: boolean } | null = null;
  if (m.selected && v.phase === 'move' && actor === me()) {
    const selected = v.pieces.find((p) => !p.captured && p.square === m.selected);
    const unclaimedCard = selected && !selected.faceUp && !selected.claim;
    for (const a of legal) {
      if (a.type !== 'move' || a.from !== m.selected) continue;
      targets.add(a.to);
      if (v.pieces.some((p) => !p.captured && p.square === a.to)) captureTargets.add(a.to);
      if (unclaimedCard && a.claim) targetClaims.set(a.to, [...(targetClaims.get(a.to) ?? []), a.claim]);
    }
    for (const [corner, a] of castlesFrom(v, legal, m.selected)) castles.set(a.to, corner);
    if (unclaimedCard && coachOn()) {
      const reach = [...targetClaims.values()];
      legend = { types: E.CLAIMABLE.filter((t) => reach.some((cs) => cs.includes(t))), multi: reach.some((cs) => cs.length > 1) };
    }
  }
  const showdownTargets = new Set<Square>();
  if (v.phase === 'showdown' && actor === me()) {
    for (const a of legal) {
      if (a.type !== 'showdown') continue;
      const sq = v.pieces.find((p) => p.id === a.targetPieceId)?.square;
      if (sq) showdownTargets.add(sq);
    }
  }
  const step = m.lesson ? lessonStep() : null;

  const boardEl = el('#board');
  const before = app.data.settings.reducedMotion || opts.noSlide ? null : FX.snapshotPieces(boardEl);
  boardEl.innerHTML = R.boardHTML(v, {
    me: me(), selected: m.selected, targets, captureTargets, targetClaims: coachOn() ? targetClaims : undefined, castles,
    lastMove: m.lastMove, hover: m.hover, guesses: m.notes[me()], flip: m.flip, showdownTargets, checkSquare,
    hints: step && m.lesson?.phase === 'playing' ? step.highlight : m.stuck?.squares, final: v.phase === 'over',
  });
  if (before) FX.slidePieces(boardEl, before);
  m.flip.clear();

  renderOpp();
  el('#me-panel').innerHTML = R.mePanelHTML({
    chips: v.chips[me()], tray: R.capturedTray(v, me()), isTurn: actor === me(), color: me(), name: m.mode === 'local' ? m.names[me()] : 'You',
  });
  renderPrompt(v, actor);
  // Only replace the overlay when it changes, so the claim flag animates in once.
  const overlay = el('#board-overlay'), overlayNow = m.curtain ? '' : overlayHTML(v);
  if (overlay.dataset.html !== overlayNow) { overlay.dataset.html = overlayNow; overlay.innerHTML = overlayNow; }
  const info = infoPanelHTML(v);
  el('#action-panel').innerHTML = info;
  // A warning in the popup marks the button, so it isn't missed while the popup is shut.
  el('#info-btn').classList.toggle('alert', info.includes('ap-alert'));
  el('.game').classList.toggle('info-open', infoOpen);
  const coach = el('#coach-card');
  coach.classList.toggle('hidden', !coachOn());
  if (coachOn()) coach.innerHTML = R.coachCardHTML(coachAdvice(v), legend);
  const hasCards = v.pieces.some((p) => p.owner === opp() && (!p.faceUp || p.claim));
  const tracker = el('#tracker');
  tracker.classList.toggle('trk-none', !hasCards);
  tracker.innerHTML = hasCards ? R.trackerHTML(v, opp()) : '<p class="coach-idle">No hidden cards in play.</p>';
  const logEl = el('#log');
  logEl.innerHTML = R.logHTML(m.log);
  logEl.scrollTop = logEl.scrollHeight;
  // Phones show one side panel at a time; the stage shows them all and hides the tabs.
  const tabs: [SideTab, string][] = [...(coachOn() ? [['coach', 'Coach'] as [SideTab, string]] : []), ['claims', 'Claims'], ['log', 'Moves']];
  const tab = tabs.some(([t]) => t === sideTab) ? sideTab : tabs[0][0];
  el('.g-side').dataset.tab = tab;
  el('#side-tabs').innerHTML = tabs.map(([t, label]) =>
    `<button class="side-tab${t === tab ? ' on' : ''}" data-act="side-tab" data-tab="${t}" aria-pressed="${t === tab}">${label}</button>`).join('')
    + '<button class="side-close" data-act="info-close" aria-label="Close">Close</button>';
  const curtain = el('#curtain');
  curtain.classList.toggle('hidden', !m.curtain);
  if (m.curtain) {
    hideTooltip();
    curtain.innerHTML = R.curtainHTML({ name: m.names[m.curtain], color: m.curtain, recent: m.log.slice(m.seen[m.curtain]) });
  }
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
  if (v.phase === 'callWindow' && v.pending?.mover === opp() && m.mode !== 'lesson') {
    return vsHuman(m.mode) ? callAdvice(v, m.names[opp()], [], undefined) : callAdvice(v, m.bot.name, m.botThinks, m.lastThinkMs ?? undefined);
  }
  if (m.choice && m.choice.options[0].claim) {
    const options = m.choice.options;
    const bluff = options.find((a) => claimAdvice(v, a, m.names[opp()]).tone !== 'good');
    return claimAdvice(v, bluff ?? options[0], m.names[opp()]);
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
  const name = esc(m.names[opp()]);
  const human = vsHuman(m.mode);
  const run = m.lesson;
  const step = run ? lessonStep() : null;
  const pz = m.puzzle;

  if (m.curtain) return { tone: 'wait', key: `curtain-${m.curtain}`, title: `Pass to ${esc(m.names[m.curtain])}` };
  if (m.mode === 'online' && app.online?.down) return { tone: 'wait', key: 'down', title: 'Reconnecting to the server', sub: 'Your game is safe on the server.' };
  if (m.guard) {
    return {
      tone: 'act', key: 'guard', title: 'Are you sure?', sub: `${esc(m.guard.advice.lines.join(' '))} Pick a move on the board to choose again.`,
      buttons: '<button class="btn" data-act="guard-cancel">Take it back</button><button class="btn btn-ink" data-act="guard-confirm">Move anyway</button>',
    };
  }
  if (pz && pz.verdict !== 'playing') {
    const next = nextPuzzle();
    return pz.verdict === 'solved'
      ? {
          tone: 'done', key: 'puzzle-solved', title: 'Solved!', sub: 'See why on the right.',
          buttons: `<button class="btn" data-act="go-puzzles">All puzzles</button>${next ? `<button class="btn btn-red" data-act="start-puzzle" data-puzzle="${next.id}">Next puzzle</button>` : ''}`,
        }
      : {
          tone: 'done', key: 'puzzle-failed', title: 'Not this time', sub: esc(pz.puzzle.hint),
          buttons: `<button class="btn" data-act="go-puzzles">All puzzles</button><button class="btn btn-red" data-act="start-puzzle" data-puzzle="${pz.puzzle.id}">Try again</button>`,
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
    let buttons = '<button class="btn btn-red" data-act="reveal">See the reveal</button><button class="btn" data-act="rematch">Rematch</button>';
    if (m.mode === 'online') {
      const o = app.online;
      const asked = o?.rematch[me()], offered = o?.rematch[opp()];
      buttons = `<button class="btn btn-red" data-act="reveal">See the reveal</button>${asked ? `<button class="btn" disabled>Waiting for ${name}</button>` : `<button class="btn" data-act="rematch">${offered ? 'Accept rematch' : 'Rematch'}</button>`}`;
    }
    return { tone: 'done', key: 'over', title: resultText(v.result), buttons };
  }
  if (v.phase === 'setup') return { tone: 'wait', key: 'setup-wait', title: `Waiting for ${name}`, sub: 'They are arranging their back rank.' };
  if (v.phase === 'callWindow' && v.pending) {
    if (v.pending.mover === opp()) {
      return {
        tone: 'act', key: `call-${v.pending.pieceId}-${v.fullmove}`, title: 'Call or pass?', sub: `${name} claims ${claimTag(v.pending.claim!)}.`,
        buttons: `<button class="btn btn-ink" data-act="call" ${v.chips[me()] > 0 ? '' : 'disabled'}>Call <small>${v.config.chipsOutLoss && v.chips[me()] === 1 ? 'last chip' : '1 chip'} · C</small></button>
          <button class="btn" data-act="pass">Pass <small>P</small></button>`,
      };
    }
    return { tone: 'wait', key: 'bot-calling', title: `${name} is deciding`, sub: 'Will they call your claim?' };
  }
  if (v.phase === 'showdown') {
    if (actor === me()) {
      return {
        tone: 'act', key: 'showdown-me', title: 'Showdown', sub: 'Pick a marked card to expose it for 1 chip.',
        buttons: m.mode === 'lesson' ? '' : '<button class="btn" data-act="accept-mate">Accept defeat</button>',
      };
    }
    return { tone: 'wait', key: 'showdown-bot', title: `${name} is in a showdown`, sub: 'Looking for a lie.' };
  }
  if (actor === me()) {
    if (m.choice) {
      return {
        tone: 'act', key: 'choice', title: m.choice.options[0].promotion ? 'Promote' : 'Choose a claim', sub: 'Pick from the card on the board.',
        buttons: '<button class="btn" data-act="cancel-choice">Cancel</button>',
      };
    }
    if (m.stuck) return { tone: 'act', key: `move-${v.fullmove}`, title: esc(m.stuck.title), sub: esc(m.stuck.text), small: true };
    const check = E.inCheck(E.getApparentBoard(v), me());
    const yourMove = m.mode === 'local' ? `${esc(m.names[me()])} to move` : 'Your move';
    return { tone: 'act', key: `move-${v.fullmove}`, title: check ? `${yourMove}: check!` : yourMove, sub: moveHint(v) };
  }
  return { tone: 'wait', key: 'bot-thinking', title: human ? `${name} to move` : `${name} is thinking` };
}

function moveHint(v: PlayerView): string {
  const m = match();
  if (m.busy && m.mode === 'online') return 'Sending…';
  if (!m.selected) return 'Select one of your pieces.';
  const p = v.pieces.find((x) => !x.captured && x.square === m.selected);
  if (!p) return '';
  if (!p.faceUp && !p.claim) return `Your hidden ${typeName(p.type)} is unclaimed: it may move as any type.`;
  if (!p.faceUp) return `Hidden ${typeName(p.type)}, locked as a ${typeName(p.claim)}${p.claim !== p.type ? ' (a bluff)' : ''}.`;
  if (castlesFrom(v, E.getLegalActions(v, me()), m.selected).size) return 'King selected. Pick a marked square. To castle, pick Castle or the corner card.';
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
    bar.className = bar.className.replace(/prompt-(act|wait|done)/, `prompt-${p.tone}`);
  }
  bar.classList.toggle('prompt-small', !!p.small);
  if (bar.innerHTML !== html) bar.innerHTML = html;

  const frame = el('.board-frame');
  frame.classList.toggle('turn-me', p.tone === 'act');
  frame.classList.toggle('turn-opp', p.tone === 'wait' && actor === opp());

  // A chime and a tab title when it becomes your turn.
  const acting = p.tone === 'act';
  if (acting && lastActKey === null && m.mode !== 'lesson') Sound.play('turn');
  lastActKey = acting ? p.key : null;
  document.title = acting ? `● ${p.title.replace(/<[^>]+>/g, '')} · Bluff Chess` : 'Bluff Chess';
}

/** Position of a square's top-centre within the board frame, in layout pixels. */
function squareSpot(sq: Square): { x: number; y: number; size: number; rank: number } {
  const boardEl = el('#board');
  const size = boardEl.offsetWidth / 8;
  const file = sq.charCodeAt(0) - 97, rank = Number(sq[1]) - 1;
  const { ranks, files } = R.boardOrder(me());
  // The frame's padding: 20px on the stage, less on phones.
  const pad = boardEl.offsetLeft;
  return { x: pad + (files.indexOf(file) + 0.5) * size, y: pad + ranks.indexOf(rank) * size, size, rank };
}

/** On-board labels: the pending claim, and the claim picker at the destination square. */
function overlayHTML(v: PlayerView): string {
  const m = match();
  let html = '';
  // Rank + 1 is up the screen for white and down it for black.
  const up = me() === 'white' ? 1 : -1;
  if (v.phase === 'callWindow' && v.pending?.claim) {
    const s = squareSpot(v.pending.to);
    // Sit above the square unless that would cover a piece and the square below is free.
    const file = v.pending.to[0];
    const occupied = (rank: number) => rank >= 0 && rank <= 7 && v.pieces.some((p) => !p.captured && p.square === `${file}${rank + 1}`);
    const atTop = s.rank === (up > 0 ? 7 : 0);
    const below = atTop || (occupied(s.rank + up) && !occupied(s.rank - up));
    const theirs = v.pending.mover === opp();
    const text = theirs ? `Claims ${typeName(v.pending.claim)}?` : `${m.mode === 'local' ? `${esc(m.names[me()])} claims` : 'You claim'} ${typeName(v.pending.claim)}`;
    html += `<div class="claim-flag${below ? ' below' : ''}${theirs ? ' theirs' : ''}" style="left:${s.x}px;top:${below ? s.y + s.size + 6 : s.y - 6}px">${text}</div>`;
  }
  if (m.choice) {
    const s = squareSpot(m.choice.options[0].to);
    const frameW = el('.board-frame').offsetWidth;
    const width = Math.min(frameW - 20, m.choice.options.length * 116 + 36);
    const x = Math.min(Math.max(s.x, width / 2 + 10), frameW - width / 2 - 10);
    const above = (up > 0 ? s.rank : 7 - s.rank) <= 3;
    const top = above ? s.y - 8 : s.y + s.size + 8;
    html += `<div class="claim-pop${above ? ' above' : ''}" style="left:${x}px;top:${top}px;width:${width}px">${choiceHTML(v, m.choice.options)}</div>`;
  }
  return html;
}

/** Sidebar detail: lesson or puzzle text and the specifics of a pending claim. Actions live in the prompt bar. */
function infoPanelHTML(v: PlayerView): string {
  const m = match();
  let html = m.lesson ? lessonCardHTML() : m.puzzle ? puzzleCardHTML(v) : '';
  if (v.phase === 'callWindow' && v.pending && v.pending.mover === opp() && !m.curtain) {
    const p = v.pending;
    const claim = p.claim!;
    // Puzzles ask you to do the counting.
    const certain = m.mode !== 'puzzle' && computeBeliefs(v).certainLies.includes(claim);
    const secs = m.lastThinkMs && !vsHuman(m.mode) && m.mode !== 'lesson' && m.mode !== 'puzzle' ? ` · thought ${(m.lastThinkMs / 1000).toFixed(1)}s` : '';
    html += `<div class="ap-claim"><div class="ap-kicker">${codexLink('call', 'Their claim')}</div>
      <div class="ap-title">${esc(m.names[opp()])} claims ${claimTag(claim)}</div>
      <div class="ap-sub">${p.castle ? 'Castled' : `Moved ${p.from}→${p.to}`}${p.capturedId ? ', capturing' : ''}${secs}</div></div>
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

function puzzleCardHTML(v: PlayerView): string {
  const run = match().puzzle!;
  const p = run.puzzle;
  const g = p.goal;
  let goal: string;
  if (g.type === 'mate') {
    const left = Math.max(0, g.moves - movesMade(v, run.start));
    goal = `Mate in ${g.moves} · ${left} left`;
  } else goal = g.type === 'decide' ? 'Call or pass' : 'Break the mate';
  return `<div class="lesson-panel">
    <div class="lp-head"><span>${esc(p.title)}</span><span class="lp-goal">${goal}</span></div>
    <div class="lp-say">${p.say}</div>
    ${run.verdict === 'solved' ? `<div class="lp-feedback success">${p.explain}</div>` : ''}
    ${run.verdict === 'failed' ? `<div class="lp-feedback hint">${esc(p.hint)}</div>` : ''}
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
      const risk = coachOn() && !honest ? claimAdvice(v, a, m.names[opp()]).tone : null;
      const tag = honest ? 'Honest' : risk === 'danger' ? 'Provable lie' : risk === 'good' ? 'Safe bluff' : 'Bluff';
      return `<button class="btn btn-claim${honest ? ' honest' : ''}${risk === 'danger' ? ' danger' : ''}" data-act="choose" data-i="${i}">
        ${a.claim ? pieceIcon(a.claim) : ''}<span>${typeName(a.claim)}</span><small>${tag}</small></button>`;
    }).join('');
  return `<div class="claim-pop-title">${promo ? 'Promote to' : `${options[0].from}→${options[0].to}: ${codexLink('claim', 'claim it as')}`}</div>
    <div class="claim-grid">${btns}</div>
    <button class="btn claim-cancel" data-act="cancel-choice">Cancel</button>`;
}

// ---------------------------------------------------------------------------
// Match end

function finishMatch(): void {
  const m = match();
  m.over = true;
  const s = m.state;
  const result = s.result!;
  if (vsHuman(m.mode)) {
    const lost = m.mode === 'online' && !!result.winner && result.winner !== me();
    const title = !result.winner ? 'Draw' : m.mode === 'local' ? `${m.names[result.winner]} wins` : lost ? 'You lose' : 'You win';
    Sound.play(lost ? 'lose' : 'win');
    void FX.banner(esc(title), resultText(result), !result.winner ? 'draw' : lost ? 'loss' : 'win', 2000)
      .then(() => { if (app.match === m && app.screen === 'game') openReveal(); });
    return;
  }
  const outcome = !result.winner ? 'd' : result.winner === me() ? 'w' : 'l';
  const before = unlocked();
  app.data.records = Store.recordResult(app.data.records, m.botId, outcome);
  app.data.memory[m.botId] = Store.updateMemory(app.data.memory[m.botId], s, me());
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
    state: m.state, bot: m.bot, num: oppNumber(m), snaps: m.snaps, me: me(), newlyUnlocked: m.newlyUnlocked, resultText: resultText(r),
    won: r.winner ? r.winner === me() : null, meName: m.mode === 'local' ? m.names[me()] : 'You', beliefs: !vsHuman(m.mode),
  }), 'modal-wide');
}

function leaveGame(): void {
  const m = app.match;
  if (!m) return show('hub');
  const live = m.state.phase !== 'over';
  if (m.mode === 'online') {
    if (live && !confirm('Leave the game? You will resign.')) return;
    if (live && app.online) void Net.sendAction(app.online.seat, { type: 'resign', player: me() }).catch(() => {});
    leaveOnline();
  } else if (m.mode === 'local') {
    if (live && !confirm('Leave this game? It will be abandoned.')) return;
  } else if (m.mode !== 'lesson' && m.mode !== 'puzzle' && live) {
    if (!confirm('Leave the table? This match will count as a loss.')) return;
    dispatch({ type: 'resign', player: me() }, { silentAdvance: true });
    finishMatch();
  }
  closeModal();
  app.match = null;
  const back: Record<Mode, Exclude<Screen, 'game'>> = {
    circuit: 'circuit', free: 'free', practice: 'lessons', lesson: 'lessons', puzzle: 'puzzles', local: 'pvp', online: 'pvp',
  };
  show(back[m.mode]);
}

function rematch(): void {
  const m = app.match;
  if (!m) return;
  closeModal();
  if (m.mode === 'online') {
    if (app.online) void Net.requestRematch(app.online.seat).catch((e: Error) => { m.stuck = { title: 'Rematch failed', text: e.message, squares: [] }; renderGame(); });
    return;
  }
  // Swap colours for the next pass-and-play game.
  if (m.mode === 'local') return startLocalSetup({ white: m.names.black, black: m.names.white });
  startSetup(m.botId, m.mode, m.config);
}

// ---------------------------------------------------------------------------
// Input

/** Castling moves for the selected king, keyed by the corner square they bring across. */
function castlesFrom(v: PlayerView, legal: Action[], from: Square | null): Map<Square, MoveAction> {
  const out = new Map<Square, MoveAction>();
  const king = v.pieces.find((p) => !p.captured && p.square === from && p.type === 'king');
  if (!king || !from) return out;
  for (const a of legal) {
    if (a.type !== 'move' || a.from !== from) continue;
    const df = a.to.charCodeAt(0) - from.charCodeAt(0);
    if (Math.abs(df) === 2) out.set(`${df > 0 ? 'h' : 'a'}${from[1]}`, a);
  }
  return out;
}

function onSquare(sq: Square): void {
  const m = app.match;
  if (!m || app.screen !== 'game' || m.busy || m.curtain) return;
  if (m.lesson && m.lesson.phase !== 'playing') return;
  if (m.puzzle && m.puzzle.verdict !== 'playing') return;
  // Clicking the board while the coach's warning is up means "take it back":
  // dismiss the warning and handle the click, so the board never feels frozen.
  if (m.guard) {
    m.guard = null;
    m.selected = null;
  }
  m.stuck = null;
  const v = view();
  const actor = E.getActor(v);
  if (actor !== me()) return;

  if (v.phase === 'showdown') {
    const p = v.pieces.find((x) => !x.captured && x.square === sq);
    if (p && E.getLegalActions(v, me()).some((a) => a.type === 'showdown' && a.targetPieceId === p.id)) {
      playerAct({ type: 'showdown', player: me(), targetPieceId: p.id });
    } else Sound.play('error');
    return;
  }
  if (v.phase !== 'move') return;

  m.choice = null;
  const legal = E.getLegalActions(v, me()).filter((a): a is MoveAction => a.type === 'move');
  const p = v.pieces.find((x) => !x.captured && x.square === sq);
  // King selected, then its corner piece clicked: castle on that side.
  const castle = castlesFrom(v, legal, m.selected).get(sq);
  if (castle) return playerAct(castle);
  if (m.selected && m.selected !== sq) {
    const opts = legal.filter((a) => a.from === m.selected && a.to === sq);
    if (opts.length === 1) return playerAct(opts[0]);
    if (opts.length > 1) {
      m.choice = { options: opts };
      Sound.play('select');
      return renderGame();
    }
    if (!(p && p.owner === me())) {
      // Not a legal destination: explain why.
      m.stuck = { title: 'Can\'t move there', text: explainIllegal(v, m.selected, sq) ?? 'That move isn\'t allowed.', squares: [] };
      Sound.play('error');
      return renderGame();
    }
  }
  if (p && p.owner === me() && m.selected !== sq) {
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
  if (!m || app.screen !== 'game' || m.curtain) return;
  const p = view().pieces.find((x) => !x.captured && x.square === sq);
  if (!p || p.owner !== opp() || p.faceUp) return;
  const notes = m.notes[me()];
  const order: (ClaimType | undefined)[] = [undefined, 'rook', 'knight', 'bishop', 'queen'];
  const next = order[(order.indexOf(notes[p.id]) + 1) % order.length];
  if (next) notes[p.id] = next;
  else delete notes[p.id];
  Sound.play('click');
  renderGame();
}

function onHover(pieceId: string, pieceEl: HTMLElement, touch = false): void {
  const m = app.match;
  if (!m || app.screen !== 'game' || m.curtain || pieceEl.closest('.modal')) return;
  const v = view();
  const p = v.pieces.find((x) => x.id === pieceId);
  if (!p || p.faceUp) return hideTooltip();
  let html: string;
  if (p.owner === opp() && v.phase !== 'over') {
    const dist = computeBeliefs(v).probs[p.id];
    html = R.tooltipHTML(p, dist, v.claims.filter((c) => c.pieceId === p.id), m.notes[me()][p.id], touch);
  } else {
    html = `<div class="tt-title">Your hidden ${typeName(p.type)}</div><div class="tt-hist">${p.claim ? `Claims ${typeName(p.claim)}${p.claim !== p.type ? ': a bluff. Every move it makes can be called.' : '.'}` : `Unclaimed: ${esc(m.names[opp()])} sees only a card back.`}</div>`;
  }
  const stage = el('#stage');
  const k = FX.stageScale(stage);
  const s = stage.getBoundingClientRect();
  const r = pieceEl.getBoundingClientRect();
  const tt = el('#tooltip');
  tt.innerHTML = html;
  tt.classList.remove('hidden');
  // A long-pressed card stays open with buttons, so it takes taps.
  tt.classList.toggle('tt-touch', touch);
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
  if (!m || m.busy || m.curtain) return;
  if (m.lesson && m.lesson.phase !== 'playing') return;
  if (m.puzzle && m.puzzle.verdict !== 'playing') return;
  const v = view();
  if (v.phase !== 'callWindow' || !v.pending || v.pending.mover !== opp()) return;
  if (type === 'call') {
    if (v.chips[me()] <= 0) return;
    if (m.lesson && !lessonAccepts({ type: 'call', player: me() })) return;
    m.busy = true;
    Sound.play('call');
    FX.stamp($('#fx-layer'), $('#board'), v.pending.to, 'Called', 'call');
    setTimeout(() => {
      m.busy = false;
      if (m.lesson) {
        dispatch({ type: 'call', player: me() }, { silentAdvance: true });
        void lessonAfterAction();
      } else playerAct({ type: 'call', player: me() });
    }, 550 * Math.max(SPEED, 0.3));
  } else {
    if (m.lesson && !lessonAccepts({ type: 'pass', player: me() })) return;
    m.busy = true;
    Sound.play('step');
    FX.stamp($('#fx-layer'), $('#board'), v.pending.to, 'Pass', 'pass');
    setTimeout(() => {
      m.busy = false;
      playerAct({ type: 'pass', player: me() });
    }, 380 * Math.max(SPEED, 0.3));
  }
}

const handlers: InputHandlers = {
  action(name, ds, e) {
    const m = app.match;
    if (name !== 'close-modal-bg') Sound.play('click');
    if (name !== 'hud-menu') el('#hud').classList.remove('menu-open');
    switch (name) {
      case 'enter': return show('hub');
      case 'go-hub': return show('hub');
      case 'go-circuit': closeModal(); app.match = null; return show('circuit');
      case 'go-free': return show('free');
      case 'go-lessons': closeModal(); app.match = null; return show('lessons');
      case 'go-puzzles': closeModal(); app.match = null; return show('puzzles');
      case 'go-pvp':
        app.pvpError = null;
        return show(app.online ? 'room' : 'pvp');
      case 'codex': return openCodex(ds.entry || 'overview');
      case 'settings': return openSettings();
      case 'hud-menu': {
        // Phones fold the top-bar links into a menu.
        const open = el('#hud').classList.toggle('menu-open');
        $('.hud-menu')?.setAttribute('aria-expanded', String(open));
        return;
      }
      case 'mark': {
        // Noting a guess from the touch details card.
        if (!m) return;
        const notes = m.notes[me()];
        if (ds.v) notes[ds.piece!] = ds.v as ClaimType;
        else delete notes[ds.piece!];
        hideTooltip();
        return renderGame({ noSlide: true });
      }
      case 'side-tab':
        sideTab = ds.tab as SideTab;
        return renderGame();
      case 'info-open':
      case 'info-close':
        infoOpen = name === 'info-open';
        return renderGame({ noSlide: true });
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
        if (confirm('Reset all progress: records, lessons, puzzles, and what the regulars remember about you?')) {
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
        if (e.target instanceof Element && e.target.classList.contains('modal-overlay') && !e.target.classList.contains('curtain-overlay')) closeModal();
        return;
      case 'start-lesson': return startLesson(ds.lesson!);
      case 'start-puzzle': return startPuzzle(ds.puzzle!);
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
      case 'setup-back': {
        const mode = app.setup?.mode;
        if (mode === 'online') {
          if (!confirm('Leave the room?')) return;
          leaveOnline();
        }
        return show(mode === 'free' ? 'free' : mode === 'practice' ? 'lessons' : mode === 'local' || mode === 'online' ? 'pvp' : 'circuit');
      }
      case 'setup-color': {
        const s = app.setup;
        if (!s || !s.colorChoice) return;
        s.colorChoice = ds.v as ColorChoice;
        s.color = s.colorChoice === 'black' ? 'black' : 'white';
        app.data.settings.seat = s.colorChoice;
        save();
        return show('setup');
      }
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
      case 'curtain-open': return openCurtain();
      case 'pvp-color':
        app.pvp.color = ds.v as ColorChoice;
        return show('pvp');
      case 'pvp-local':
        return startLocalSetup({ white: app.pvp.white.trim() || 'White', black: app.pvp.black.trim() || 'Black' });
      case 'pvp-create': return void createOnline();
      case 'pvp-join': return void joinOnline();
      case 'room-leave':
        leaveOnline();
        return show('pvp');
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
        return playerAct({ type: 'acceptMate', player: me() });
      case 'leave': return leaveGame();
      case 'reveal': return openReveal();
      case 'rematch': return rematch();
      default:
    }
  },
  square(sq) {
    el('#hud').classList.remove('menu-open');
    onSquare(sq);
  },
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
  field(k, val) {
    if (k === 'white' || k === 'black' || k === 'code') app.pvp[k] = val;
    else if (k === 'name') {
      app.pvp.name = val;
      app.data.settings.playerName = val.trim();
      save();
    }
  },
  key(k) {
    const modalOpen = !!el('#modal-root').innerHTML;
    if (k === 'escape') {
      if (modalOpen && !$('.curtain-overlay')) return closeModal();
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
