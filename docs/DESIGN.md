# Bluff Chess — Design Document

*Working title. Version 0.1 — single-player vs bots, browser-based (HTML/JavaScript).*

---

## 1. Concept

Chess where some of your pieces are hidden, every move is a claim, and your opponent can call your bluff.

The board, pieces and movement are standard chess. The twist is borrowed from poker: your back-rank pieces are face-down to your opponent, any of them can move *as if* it were any piece type, and your opponent can bet a chip to call you out. Chess players bring their positional thinking; poker players bring reads, bet management and nerve.

The first release is **player vs bot**. Bots are a roster of distinct characters with consistent, learnable personalities and tells. Progression comes from the player getting better at reading opponents, not from unlocking power.

### Design pillars

1. **Familiar first.** A chess player or poker player should learn the full rules from one card. Every new rule must earn its place.
2. **Depth from reads, not rules.** Challenge comes from deduction, bluffing and table image, never from rule complexity.
3. **Fair and provably so.** Bots never see hidden information. The architecture enforces this, and the post-match reveal shows it.
4. **Not a roguelike.** No shops, no rule-bending upgrades, no runs. The player improves; their deck doesn't.

---

## 2. Core rules

### 2.1 Setup

- Standard 8x8 board. Each player has the standard 16 pieces.
- **Pawns and the king are always face-up.** King starts on its normal square (e1 / e8).
- Each player **secretly arranges** their other seven back-rank pieces (2 rooks, 2 knights, 2 bishops, 1 queen) across the seven remaining back-rank squares. These are **face-down** to the opponent.
- Bishops may end up on the same colour. That's a legitimate strategic choice.
- Each player starts with **4 chips** (tuning knob).

### 2.2 Claims

- Moving a face-down piece is a **claim** that it is a particular type (rook, knight, bishop or queen). Kings and pawns cannot be claimed.
- The move must be legal for the claimed type on the **apparent board** (see 2.5).
- If more than one type could make the move (e.g. a one-square diagonal could be bishop or queen), the player chooses the claim explicitly.
- **Claims are locked.** A face-down piece's first claim fixes its claimed identity. All its later moves must be legal for that type.
- Face-up pieces (pawns, king, revealed pieces) move normally and make no claim.

### 2.3 Calling

- After a face-down piece moves, the opponent gets a **call window**: they may **call** (bet 1 chip) or **pass**. Moves by face-up pieces skip the call window.
- The move is held as **pending** until the call window closes.
- **If the claim was a lie:**
  - the move is reversed (including restoring any captured piece),
  - the lying piece is removed from the board,
  - the liar pays the caller 1 chip,
  - the liar's turn is forfeited and play passes to the caller, unless undoing the move leaves the liar in check: then the liar must move again to answer it, and with no legal answer it is checkmate (showdown rules apply). A check is never left standing on the other player's move.
- **If the claim was true:**
  - the piece flips face-up permanently,
  - the move stands,
  - the caller pays the mover 1 chip.
- Every call is a two-way bet: whoever was wrong pays.
- **Bust:** a player who runs out of chips loses immediately. (Changed after playtesting: with free calls and no bust, nobody ever ran low and chips didn't matter.)

### 2.4 Captures, promotion, special moves

- Captured pieces are revealed to both players.
- Promotion is standard; promoted pieces are face-up.
- En passant is standard.
- **Castling** counts as the corner piece claiming to be a rook. It is callable like any claim. Normal castling conditions apply (king and that corner piece have not moved, no apparent check through the path).

### 2.5 The apparent board, check and checkmate

Check is evaluated on the **apparent board**, which is fully public:

- face-up pieces count as their true type,
- face-down pieces with a locked claim count as their claimed type,
- face-down pieces with no claim yet occupy their square (they block lines) but attack nothing.

Rules:

- You may not make a move that leaves your king in apparent check.
- The king is never captured. The game ends by checkmate or stalemate on the apparent board.
- A bluffed check is a real check until someone calls it. The defender can respond normally or call the checking move.
- Consequence: an unclaimed piece can't give check until it commits to a claim. Claiming early gives a piece power but also gives the opponent information.

**Defending.** (Added after playtesting: a king could take a queen guarded by an unclaimed bishop, because the bishop "attacked nothing".)

- When a king moves (not castling) to a square that one of the opponent's unclaimed cards *could* reach as some claimable type (a knight jump, or a clear queen line), the move is held and the opponent gets a **defend window**. It needs a chip to defend; with none, no window opens.
- The defender may pass, or **defend** by naming one of those cards. The card flips face-up whatever happens.
  - If its true type really attacks the square: the king move is undone (any capture restored), the king's player pays the defender a chip (if `liarPaysChip`) and forfeits the turn, unless the undo leaves them in check: then they move again, and with no answer it is checkmate (showdown rules apply). The same rule as a caught lie.
  - If it doesn't: the defender pays the king's player a chip and the move stands.
- The window opens on what a card *could* do, from public information, so whether it opens says nothing about the cards. The defender knows their own cards, so a defend is a sure thing when they have a real guard; the gamble is the king's.
- Unclaimed cards still never give check, and they don't pin: only king moves open a defend window.

### 2.6 Showdown

When a player is in apparent checkmate (after the mating move's call window has closed), they may declare a **showdown**:

- Spend 1 chip to name any opponent face-down piece that has a claim.
- If that piece is lying, it is removed, its owner pays the defender 1 chip, and the position is re-evaluated. If the mate is broken, play continues with the defender to move.
- If the piece is honest, it flips face-up and the defender pays the opponent 1 chip.
- The defender may keep calling showdowns while they have chips and remain mated.

This is the dramatic last-chance moment and should be presented as such.

### 2.7 End of game

- Checkmate (after any showdowns) wins, and so does busting your opponent (taking their last chip). Stalemate on the apparent board is a draw. Threefold repetition and the 50-move rule apply as in chess (low priority for v0.1). Insufficient material (bare kings, a lone bishop or knight, bishops all on one colour) is a draw too, but only once every remaining piece is face-up, so declaring it never reveals a hidden card.
- At the end of every match, **all pieces are revealed**, followed by the post-match reveal (section 4.5).

### 2.8 Tuning knobs

| Knob | Default | Notes |
|---|---|---|
| Starting chips | 4 | Tuned by simulation: about 7% of games end in a bust and about 40% reach someone's last chip. |
| Chips-out loss (bust) | On | Makes chips matter; off restores the original rules. |
| Lie caught penalty | Piece removed + turn forfeited + liar pays 1 chip | "Liars pay" off: the caller just keeps their chip. |
| Claim locking | On | Off makes lies easier to maintain and deduction weaker. |
| Showdowns per mate | Unlimited (while chips last) | Could cap at 1. |
| Call window timer | None vs bots | Needed later for PvP. |

---

## 3. Game modes

### 3.1 The Circuit (main mode)

A roster of bot opponents the player works through, roughly ordered by difficulty. Beating a character unlocks the next. Matches can be replayed at any time. The player's record against each character is tracked.

### 3.2 Free Play

Pick any unlocked opponent and adjust tuning knobs (starting chips, claim locking, etc.). Good for testing and for players who want specific rules.

### 3.3 Bluff Puzzles

Curated positions with a goal, in the spirit of chess puzzles:

- "Win in three moves, using exactly one lie."
- "The bot has a hidden queen. Find it before it finds your king."
- "You have one chip. Which move do you call?"

Stored as JSON so new puzzles are data, not code. A daily puzzle is a natural later addition.

**As built:** each puzzle is a position, optional scripted moves that set it up, one goal and an opponent personality. There are three goal types: `mate` (win within N of your moves; the opponent bot answers), `decide` (call or pass on a pending claim) and `breakMate` (expose a lie in a showdown). You always play white, and the coach is off. Tests prove every mate puzzle is forced in exactly N moves by searching the full state, calls included.

### 3.4 Tutorial

A short guided match against a deliberately loose bot that bluffs a lot, teaching: hidden pieces, claims, calling, the apparent board, showdowns.

---

## 4. Bots

### 4.1 Fairness by architecture

Bots receive only the **player view** (section 6.3), the same information a human has. They cannot access true identities of hidden pieces. This is enforced in code, not by convention.

### 4.2 Personality parameters

Each bot is a JSON config. Suggested parameters:

| Parameter | Meaning |
|---|---|
| `chessStrength` | Search depth / evaluation quality on the apparent board |
| `bluffRate` | Base probability of making a false claim when a good one exists |
| `bluffContext` | When bluffing rises or falls: opening, middlegame, endgame, when ahead, when behind |
| `callThreshold` | How suspicious a claim must be before calling |
| `chipCaution` | How much the bot values holding chips vs spending them |
| `adaptivity` | How strongly it reacts to the player's table image (0 = ignores) |
| `tells` | List of consistent behavioural tells (see 4.4) |

### 4.3 Starter roster (placeholder names)

1. **The Deacon** — honest until losing, then bluffs wildly. Teaches: watch the material count.
2. **Marlowe** — never lies on its first move with a piece, often lies later. Teaches: claim history.
3. **Pip** — calls almost everything. Teaches: when to play honestly and farm chips.
4. **Sable** — rarely bluffs, but every bluff is a big one (queen claims). Teaches: suspicion of high-value claims.
5. **The Widow** — strong chess, moderate bluffing, adapts hard to table image. Circuit boss.

### 4.4 Tells

Tells must be **consistent and learnable**, never random noise. Examples:

- Think time: longer pauses before bluffs (or, for a reverse-tell bot, before honest moves).
- Dialogue lines that correlate with honesty.
- Piece hover/selection behaviour before committing.
- Reaction to the player's moves (e.g. comments after the player claims a queen).

Tells live in personality config so they can be tuned without code changes.

### 4.5 Post-match reveal

After every match, show:

- all true identities,
- every lie each side told and whether it was called,
- the bot's beliefs about the player's pieces at key moments ("At move 12, I was 80% sure your c1 piece was a knight").

This builds trust and is a core reward moment.

### 4.6 Table image

Each bot remembers the player across matches:

- observed bluff rate (from calls and end-of-match reveals),
- call frequency and accuracy,
- tendencies by game phase.

Bots with `adaptivity > 0` shift their call threshold based on this. A player who bluffs constantly gets called more; a player who has been honest for a while can land a big lie. Store per-bot memory in `localStorage` (UI layer only, never inside the engine).

### 4.7 Bot implementation phases

**Phase 1: heuristic bot**

- **Belief model:** for each opponent face-down piece, a probability distribution over {R, N, B, Q}, constrained by remaining counts (2R, 2N, 2B, 1Q minus revealed) and updated by claim history. Flag impossible combinations (e.g. three pieces claiming knight).
- **Move choice:** shallow search on the apparent board, plus a bluff decision: when a false claim would yield a significantly better move, bluff with probability shaped by `bluffRate` and `bluffContext`.
- **Call choice:** call when `P(lie) × value of catching it` exceeds `callThreshold`, adjusted by `chipCaution` and table image.

**Phase 2: stronger search (built as the Expert difficulty)**

- Determinization: sample six plausible hidden arrangements from the belief model, give each enemy card its sampled identity, run a ply-deeper alpha-beta on each world and average the scores of the best few moves (plus the best lie). Full ISMCTS was set aside, because random playouts are weak in chess-like games.
- All bot decisions run in a Web Worker, falling back to the main thread where workers are unavailable.

---

## 5. UI and UX

- **Board:** standard chessboard. Face-down pieces use a distinct "card back" design showing their locked claim as a badge once they've claimed. This design is a key part of the game's visual identity.
- **Claim tracker:** per type, how many opponent pieces claim it vs how many could exist ("Knights: 3 claimed / 2 possible").
- **Possible identities:** hovering an opponent face-down piece shows what it could be, based on public information.
- **Pinning guesses:** player can mark their own guesses on opponent pieces.
- **Call window:** clear Call / Pass buttons after every callable bot move, with the bot's tell animation or line playing during the window.
- **Showdown:** a distinct, dramatic presentation.
- **Chips:** always visible for both players.
- **Move log:** with claims, calls and outcomes.
- **Reveal animations:** flipping a piece should feel satisfying. Catching a lie should feel great.

Placeholder art is fine for early milestones. Pieces can be drawn as simple SVG or CSS shapes.

---

## 6. Architecture

### 6.1 Principles

- **Pure engine.** All rules live in `/engine`, written in plain JavaScript with no DOM, no browser APIs, no framework, no `Math.random()`, no `Date`. It takes a state and an action and returns a new state.
- **Pure data state.** The full game state is JSON-serializable. It doubles as the save format.
- **Action log.** Every match is a starting state plus an ordered list of actions. Replays, the post-match reveal and future networking all build on this.
- **Seeded randomness.** Anything random (bot decisions, random setups) uses a seeded PRNG passed in explicitly, so every match is reproducible.
- **UI is disposable.** Rendering and input can be rewritten freely without touching rules.
- **Same engine everywhere.** The engine must run unchanged in the browser and in Node (for tests now, and a PvP server later).

### 6.2 Engine API (sketch)

```js
createGame(config)                     // -> state (config includes both secret setups, chips, knobs)
getLegalActions(state, player)         // -> action[]
applyAction(state, action)             // -> { state, events }
getPlayerView(state, player)           // -> view with opponent hidden types stripped
getApparentBoard(state)                // -> public board used for check/mate
getResult(state)                       // -> null | { winner, reason }
```

Action types:

```js
{ type: 'setup', player, arrangement }             // secret back-rank arrangement
{ type: 'move', player, from, to, claim?, promotion? }
{ type: 'call', player }
{ type: 'pass', player }                           // declines a call or a defend
{ type: 'defend', player, pieceId }                // in a defend window (2.5)
{ type: 'showdown', player, targetPieceId }
{ type: 'resign', player }
```

Events (for UI and logs): `moved`, `claimMade`, `callWindowOpened`, `lieCaught`, `claimConfirmed`, `defendWindowOpened`, `defended`, `defenseFailed`, `pieceRevealed`, `captured`, `check`, `showdownAvailable`, `gameOver`, etc.

### 6.3 State shape (sketch)

```json
{
  "turn": "white",
  "phase": "move | callWindow | showdown | over",
  "pieces": [
    {
      "id": "w-b1",
      "owner": "white",
      "type": "knight",
      "square": "b1",
      "faceUp": false,
      "claim": null,
      "hasMoved": false
    }
  ],
  "chips": { "white": 4, "black": 4 },
  "pending": null,
  "history": [],
  "config": { "startingChips": 4, "claimLocking": true }
}
```

`getPlayerView` returns the same shape but sets `type: null` on the opponent's face-down pieces. Bots and the UI only ever consume player views.

### 6.4 Project structure

```
/index.html               // loads dist/main.js
/main.ts                  // wires engine, bot, UI together
/engine/                  // pure rules, no DOM
  index.ts
  types.ts                // state, actions, events, boards
  state.ts
  moves.ts                // standard chess movement on the apparent board
  claims.ts
  calls.ts
  showdown.ts
  view.ts                 // getPlayerView, getApparentBoard
  rng.ts                  // seeded PRNG
/bot/
  bot.ts                  // chooseAction(view, personality, memory, rng)
  types.ts
  belief.ts
  evaluate.ts
/data/
  personalities/*.json
  puzzles/*.json
/ui/
  render.ts
  input.ts
  animations.ts
  storage.ts
  styles.css
/tests/
  fixtures/*.json         // positions + actions + expected outcomes
  engine.test.ts
  bot.test.ts
/tools/
  serve.ts                // local static server
/docs/
  DESIGN.md
```

### 6.5 Tech stack

- TypeScript (strict), ES modules. Only erasable syntax (no enums or namespaces), so Node runs the `.ts` source directly.
- The browser loads a `tsc` build in `/dist`; there is no bundler. Node needs no build step for tests or tools.
- `engine/` and `bot/` are type-checked without DOM or Node types, so the compiler enforces that they never touch platform APIs.
- Tests with Node's built-in test runner (`node --test`). Dev dependencies are only `typescript` and `@types/node`.
- Local dev via `npm run dev` (static server plus `tsc --watch`).

### 6.6 Testing

- **Fixture-driven tests.** Each fixture is JSON: starting state, list of actions, expected resulting state fields and/or events. Every rule (claims, locking, call outcomes, reversal with capture, castling claims, apparent check, showdown) gets fixtures.
- Every rule change ships with a new or updated fixture.
- Add a determinism test: same seed + same actions = identical final state.

---

## 7. Milestones

**M1 — Engine core**
Standard chess movement on the apparent board, secret setup, claims and locking, pending moves and call resolution (including reversal), chips, showdown, end conditions. Full fixture test suite. No UI.

**M2 — Playable prototype**
Browser board with placeholder art, the player vs a trivial bot (random legal moves, random calls). Claim selection, call window, chips display, move log.

**M3 — First real opponent**
Belief model, Phase 1 heuristic bot, one personality with one tell. End-of-match reveal and bot-belief replay.

**M4 — The Circuit**
Three to five personalities with distinct tells, table image memory, circuit progression and records.

**M5 — Teaching and polish**
Tutorial, first set of bluff puzzles, claim tracker, possible-identities readout, reveal animations, final card-back design.

**PvP** (see section 8): pass-and-play and online rooms are built; a call timer, ratings and hosting are still to do.

---

## 8. PvP

**As built:**

- **Pass-and-play** on one device. Secret setup for both players, a covering "Pass to…" screen whenever the device must change hands, and a shared log that uses only public information (`getPublicView`).
- **Online rooms.** The dev server (`tools/rooms.ts`) is the authoritative server below: it holds the true state, validates each action against the seat and the legal actions, and sends each player only `getPlayerView` for their own seat, over server-sent events. Rooms use five-letter codes, reconnect on reload, show presence, and offer rematches with colours swapped. Because the server holds the state, commit-reveal isn't needed.

**Still to do** from the original plan:

- **Async first.** Correspondence-style matches need minimal infrastructure and suit the game's pace.
- **Commit-reveal for hidden pieces.** At setup, each player publishes a salted hash per hidden piece. When a piece is called, captured or revealed, its owner reveals type + salt and the opponent verifies against the hash. No one can change a piece mid-game, and no client ever receives hidden information it shouldn't. Casual PvP can run over a lightweight relay.
- **Authoritative server for ranked.** A Node server running the same `/engine` code holds true state, protects ratings and handles disconnects.
- **Call window timer** becomes required.
- **Table image for humans:** show lifetime bluff rate and call accuracy for each player before the match.

---

## 9. Open questions

- Is 4 chips right with human players? The simulation says so, but playtest 3–5.
- Unclaimed cards now defend against the king (2.5). Should they also pin, or is that too much for the defend window?
- Should the king ever be placeable elsewhere on the back rank during secret setup?
- Unlimited showdowns, or one per game?
- Is the call window on every face-down move too frequent? Does it slow the game?
- What's the final title?

---

## 10. Out of scope / guardrails

- No roguelike structure: no runs, shops or upgrade drafting.
- No rule-modifying items or powers.
- No changes to how pieces move. Bluffing changes information, never geometry.
- Bots never receive hidden information, under any difficulty setting.
- The engine never imports from `/ui`, `/bot` or browser APIs.
