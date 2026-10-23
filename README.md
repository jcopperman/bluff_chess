# Bluff Chess

Chess where your back-rank pieces are hidden, every move is a claim, and your opponent can call your bluff. See [docs/DESIGN.md](docs/DESIGN.md) for the full design.

## Play

```sh
npm install        # TypeScript and Node types (dev only)
npm start          # builds to dist/ and serves at http://localhost:8080
npm run dev        # same, rebuilding on every change
```

Requires Node 23.6 or later, which runs TypeScript directly. ES modules and the JSON data need `http://`, so opening `index.html` as a file will not work.

URL flags for development: `?fast` cuts bot think time to 5% (tells keep their proportions), and `?debug` exposes `window.bluffChess` for poking at state.

## Test and type-check

```sh
npm test           # node --test, straight from the .ts source
npm run typecheck  # strict tsc over the engine/bot, the browser build, and tests/tools
```

- `tests/fixtures/*.json`: one fixture per rule (claims, locking, call outcomes, reversal with capture, castling claims, apparent check, showdowns, tuning knobs, setup). Each fixture holds a starting config, a list of actions, and the expected state, events, legal moves or error.
- `tests/engine.test.ts`: runs the fixtures, plus determinism, replay-from-log, random-game fuzzing and view-hiding tests.
- `tests/bot.test.ts`: fairness (bot decisions are identical whatever the opponent's hidden arrangement), legality across whole bot-vs-bot games, the belief model, showdown choice, tells and table image.

## TypeScript setup

- Source is TypeScript with only erasable syntax (`erasableSyntaxOnly`), and imports name `.ts` files. Node strips the types at runtime, so tests and `tools/serve.ts` need no build step.
- `tsc` rewrites those imports to `.js` (`rewriteRelativeImportExtensions`) when it builds the browser bundle into `dist/`. There is no bundler.
- There are three tsconfigs, sharing `tsconfig.base.json`:
  - `tsconfig.core.json` checks `engine/` and `bot/` with no DOM or Node types. Any browser or platform API used there is a compile error.
  - `tsconfig.json` is the browser build.
  - `tsconfig.node.json` covers tests and tools.

## Structure

```
engine/   pure rules: no DOM, no Math.random, no Date. Runs in browser and Node. Types in engine/types.ts.
bot/      heuristic bot (belief model, search, bluff/call/showdown policy). Sees only player views.
data/     bot personalities as JSON (stats, bluff context, tells, dialogue), typed by bot/types.ts.
ui/       rendering, input, animations, localStorage (records + table image).
main.ts   wires engine, bot and UI together.
tools/    dev server.
dist/     build output (generated, git-ignored).
```

## What's implemented

Milestones M1 to M4 from the design doc, plus most of M5:

- **Engine:** the full rules: secret setup, claims and locking, call windows with reversal (including captures and castling), chips, apparent-board check and mate, showdowns, stalemate, threefold repetition, fifty-move rule, and every tuning knob. Adds one action type the doc didn't list, `acceptMate`, so a mated player can decline a showdown.
- **Bots:** an exact belief model (enumerates every consistent hidden arrangement), alpha-beta search on the apparent board, a personality-driven bluff policy, an EV-based call policy, and showdown targeting. There are five circuit characters plus a tutorial bot, each with consistent tells (think time, dialogue, hovering).
- **Modes:** The Circuit (unlocks and W/L/D records), Free Play (any unlocked bot, all knobs), and a Tutorial with contextual tips.
- **UI:** card-back pieces with claim badges, a claim picker that labels honest and bluff, the call window, a claim tracker, a move log with think times, a possible-identities tooltip, pinned guesses (right-click), stamps, flips and the showdown banner, and the post-match reveal (all lies, calls, and what the bot believed at key moments).
- **Table image:** each bot remembers your bluff rate (overall and per game phase) and how often you call, across matches. Adaptive bots shift their calling to match.

## Not yet

- Bluff Puzzles (design 3.3).
- Phase 2 bot search (ISMCTS) and Web Workers. The Phase 1 bot thinks in well under 100 ms.
- PvP (design section 8).
- The player always plays white.

## Tuning notes

A literal "bluff only when it beats the best honest move" rule almost never fires, because lies rarely buy a big tactical edge. So the bot treats a bluff as available when it costs little position (`bluffMargin`) and the risk of being called is tolerable (`riskTolerance`). Personality and context (`bluffRate`, `bluffContext`) then decide how often it takes one. Lies that win big are twice as tempting. Measured lie rates against the Deacon: Tutor about 50%, Widow about 19%, Pip about 16%, Marlowe about 14% (honest for his first four claims), Sable about 5% (queen claims only), and the Deacon about 1% unless he falls behind.
