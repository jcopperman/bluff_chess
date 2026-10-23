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
- `tests/lessons.test.ts`: every lesson can be played start to finish against the real engine, and each one teaches what it says.
- `tests/coach.test.ts`: illegal-move explanations, the blunder guard, claim risk and call advice.

## TypeScript setup

- Source is TypeScript with only erasable syntax (`erasableSyntaxOnly`), and imports name `.ts` files. Node strips the types at runtime, so tests and `tools/serve.ts` need no build step.
- `tsc` rewrites those imports to `.js` (`rewriteRelativeImportExtensions`) when it builds the browser bundle into `dist/`. There is no bundler.
- There are three tsconfigs, sharing `tsconfig.base.json`:
  - `tsconfig.core.json` checks `engine/` and `bot/` with no DOM or Node types. Any browser or platform API used there is a compile error.
  - `tsconfig.json` is the browser build.
  - `tsconfig.node.json` covers tests and tools.

## Structure

```
engine/        pure rules: no DOM, no Math.random, no Date. Runs in browser and Node. Types in engine/types.ts.
bot/           heuristic bot (belief model, search, bluff/call/showdown policy). Sees only player views.
coach/         the in-game coach: illegal-move explanations, blunder guard, claim and call advice. Public info only.
lessons/       lesson runner logic (matching player actions to scripted steps).
data/          bot personalities, lessons (data/lessons/*.json) and the codex (data/codex.json).
ui/            rendering, input, animations, synthesized sound (audio.ts), localStorage.
ui/art/        SVG chess pieces, character emblems, icons.
assets/fonts/  Archivo, a variable font (SIL Open Font License, licence alongside).
main.ts        wires engine, bot, coach, lessons and UI together.
tools/         dev server.
dist/          build output (generated, git-ignored).
```

The engine, bot, coach and lessons are all type-checked without DOM types (`tsconfig.core.json`).

## What's implemented

- **Engine:** the full rules: secret setup, claims and locking, call windows with reversal (including captures and castling), chips, apparent-board check and mate, showdowns, stalemate, threefold repetition, fifty-move rule, and every tuning knob. Adds one action type the doc didn't list, `acceptMate`, so a mated player can decline a showdown.
- **Bots:** an exact belief model (enumerates every consistent hidden arrangement), alpha-beta search on the apparent board, a personality-driven bluff policy, an EV-based call policy, and showdown targeting. There are five circuit characters plus a tutorial bot, each with consistent tells (think time, dialogue, hovering).
- **Look and feel:** a printed card game: cream card stock, black ink and one red, laid on a dark table, with flat surfaces and ink rules. The board is drawn like an old chess-book diagram, with hatched dark squares. Hidden pieces are small playing cards with a corner index showing their claim. Opponents are tarot-style emblem cards rather than faces, and they react by tilting, trembling, rocking while they think, or taking a "Caught" stamp. Caught lies and confirmed claims get rubber stamps. Whose turn it is shows on the table itself: a prompt bar under the board turns red with the buttons for any decision you owe (move, call or pass, showdown, coach warning), a red edge marks your side of the board, claims are labelled on their squares, and the claim picker opens on the destination square. A fixed 16:9 stage scales to the window, with a tall layout on phones. Sound effects are synthesized.
- **For newcomers:**
  - **First-run questions** about your chess and poker experience recommend a lesson path.
  - **Seven interactive lessons** run on staged positions: moving, check and mate, claims, calling, bluffing, the apparent board, and showdowns. Wrong moves get a hint instead of a penalty. A practice match against Professor Fumble follows.
  - **The coach** (on for your first five matches, or toggle it) colours where a hidden card can go by claim type, explains why a move is illegal, guards against blunders, rates each claim's risk, and gives a plain-language read and lean on the opponent's claims.
  - **The codex** covers rules, pieces (with move diagrams), bluffing terms, and the characters you've met. Key terms in the UI link to it.
- **Settings:** volume, mute, coach mode, reduced motion (also honours the OS setting), and a progress reset.

## Not yet

- Bluff Puzzles (design 3.3). The lesson format (staged position plus scripted steps) is a natural base for them.
- Phase 2 bot search (ISMCTS) and Web Workers. The Phase 1 bot thinks in well under 100 ms.
- PvP (design section 8).
- The player always plays white.

## Tuning notes

A literal "bluff only when it beats the best honest move" rule almost never fires, because lies rarely buy a big tactical edge. So the bot treats a bluff as available when it costs little position (`bluffMargin`) and the risk of being called is tolerable (`riskTolerance`). Personality and context (`bluffRate`, `bluffContext`) then decide how often it takes one. Lies that win big are twice as tempting. Measured lie rates against the Deacon: Tutor about 50%, Widow about 19%, Pip about 16%, Marlowe about 14% (honest for his first four claims), Sable about 5% (queen claims only), and the Deacon about 1% unless he falls behind.
