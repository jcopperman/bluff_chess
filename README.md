# Bluff Chess

Chess where your back-rank pieces are hidden, every move is a claim, and your opponent can call your bluff. See [docs/DESIGN.md](docs/DESIGN.md) for the full design.

## Play

```sh
npm install        # TypeScript and Node types (dev only)
npm start          # builds to dist/ and serves at http://localhost:8080
npm run dev        # same, rebuilding on every change
```

The same server hosts online rooms (PvP), so a friend on your network can join at `http://<your-ip>:8080`. To play over the internet, run the server somewhere both players can reach. Everything else, pass-and-play included, works from any static host.

Requires Node 23.6 or later, which runs TypeScript directly. ES modules and the JSON data need `http://`, so opening `index.html` as a file will not work.

URL flags for development: `?fast` cuts bot think time to 5% (tells keep their proportions), and `?debug` exposes `window.bluffChess` for poking at state.

## Test and type-check

```sh
npm test           # node --test, straight from the .ts source
npm run typecheck  # strict tsc over the engine/bot, the browser build, and tests/tools
```

- `tests/fixtures/*.json`: one fixture per rule (claims, locking, call outcomes, reversal with capture, castling claims, apparent check, defending, showdowns, tuning knobs, setup). Each fixture holds a starting config, a list of actions, and the expected state, events, legal moves or error.
- `tests/engine.test.ts`: runs the fixtures, plus determinism, replay-from-log, random-game fuzzing and view-hiding tests.
- `tests/bot.test.ts`: fairness (bot decisions are identical whatever the opponent's hidden arrangement), legality across whole bot-vs-bot games, the belief model, showdown choice, tells and table image.
- `tests/moves.test.ts`: move generation three ways. Perft from six standard chess positions against published counts (castling, en passant, promotion, pins), the same perft through the full engine, and a differential test where an independent reference generator must agree with the engine on every position from random games with hidden pieces, claims and bluffs.
- `tests/lessons.test.ts`: every lesson can be played start to finish against the real engine, and each one teaches what it says.
- `tests/coach.test.ts`: illegal-move explanations, the blunder guard, claim risk and call advice.
- `tests/daily.test.ts`: the daily game. The same date always deals the same game, every day of a year deals a valid one, the days vary, a game replays from its seed, and streaks count across month and year ends.
- `tests/rooms.test.ts`: online rooms. Seats, full and unknown rooms, actions checked against the seat and the rules, each player seeing only their own cards, presence, rematches and cleanup.

## TypeScript setup

- Source is TypeScript with only erasable syntax (`erasableSyntaxOnly`), and imports name `.ts` files. Node strips the types at runtime, so tests and `tools/serve.ts` need no build step.
- `tsc` rewrites those imports to `.js` (`rewriteRelativeImportExtensions`) when it builds the browser bundle into `dist/`. There is no bundler.
- There are three tsconfigs, sharing `tsconfig.base.json`:
  - `tsconfig.core.json` checks `engine/`, `bot/`, `coach/`, `lessons/` and `daily/` with no DOM or Node types. Any browser or platform API used there is a compile error.
  - `tsconfig.json` is the browser build.
  - `tsconfig.node.json` covers tests and tools.

## Structure

```
engine/        pure rules: no DOM, no Math.random, no Date. Runs in browser and Node. Types in engine/types.ts.
bot/           heuristic bot (belief model, search, bluff/call/showdown policy) and the expert's determinized search. Sees only player views.
coach/         the in-game coach: illegal-move explanations, blunder guard, claim and call advice. Public info only.
lessons/       lesson runner logic (matching player actions to scripted steps).
daily/         the daily game: the date picks the opponent, rule twist, colour and both back ranks.
net/           message types shared by the room server and the browser.
data/          bot personalities, lessons (data/lessons/*.json) and the codex (data/codex.json).
ui/            rendering, input, animations, synthesized sound (audio.ts), localStorage, the bot worker, the online client.
ui/art/        SVG chess pieces, character emblems, icons.
assets/fonts/  Archivo, a variable font (SIL Open Font License, licence alongside).
main.ts        wires engine, bot, coach, lessons and UI together.
tools/         dev server, online rooms (rooms.ts), difficulty measurement.
dist/          build output (generated, git-ignored).
```

The engine, bot, coach and lessons are all type-checked without DOM types (`tsconfig.core.json`).

## What's implemented

- **Engine:** the full rules: secret setup, claims and locking, call windows with reversal (including captures and castling), defend windows against the king, chips, apparent-board check and mate, showdowns, stalemate, threefold repetition, fifty-move rule, insufficient material (once every piece left is face-up), and every tuning knob. Adds one action type the doc didn't list, `acceptMate`, so a mated player can decline a showdown.
- **Bots:** an exact belief model (enumerates every consistent hidden arrangement), alpha-beta search on the apparent board, a personality-driven bluff policy, an EV-based call policy, and showdown targeting. There are five circuit characters plus a tutorial bot, each with consistent tells (think time, dialogue, hovering). Bots think in a Web Worker, so a long search never freezes the page.
- **Expert difficulty (Phase 2 search):** the Phase 1 search treats every unclaimed enemy card as a piece that can move as anything. At Expert, each bot also samples six concrete identities for your hidden cards from its beliefs, searches each sampled world a ply deeper with full information, and averages the results (determinization). It never blunders on purpose and avoids repeating a position when ahead. Personalities, bluffing and tells are unchanged. In test games against Harder it won 3 and drew 3 of 6, at about 0.2 s a move.
- **Play either colour:** pick White, Black or Random on the setup screen. The board turns to face you.
- **Phones:** on small screens the game drops the scaled stage and lays out at real size. The board runs the full width, the opponent and you sit in slim strips, the coach, claims and move list share tabs, and the turn bar sits at the bottom. Claims are picked from a sheet along the bottom edge, and a long press on a card shows what it could be and lets you note a guess. Turning the phone puts the board beside everything else.
- **Daily game:** one full game a day, the same for everyone. The date picks a circuit opponent, a rule twist (house rules, short stacks, loose claims and so on), your colour and both back ranks, which are dealt rather than arranged. It plays at Normal whatever your difficulty setting. Your first attempt counts (leaving or reloading counts as a loss) and replays don't; the screen keeps a streak and recent results, and copies a spoiler-free result line to share. It doesn't touch circuit records or unlocks.
- **PvP:**
  - **Pass-and-play** on one device. Both players arrange their cards in secret, and between turns the table is covered by a "Pass to…" screen that shows what happened since that player last looked. The shared log only ever uses public information.
  - **Online rooms** with a five-letter code. The server runs the same engine and holds the real game, and each player receives only their own view, so no client ever has the other side's hidden cards. It handles reconnecting (a reload rejoins), an offline marker, resigning and rematches with colours swapped.
- **Look and feel:** a printed card game: cream card stock, black ink and one red, laid on a dark table, with flat surfaces and ink rules. The board is drawn like an old chess-book diagram, with hatched dark squares. Hidden pieces are small playing cards with a corner index showing their claim. Opponents are tarot-style emblem cards rather than faces, and they react by tilting, trembling, rocking while they think, or taking a "Caught" stamp. Caught lies and confirmed claims get rubber stamps. Whose turn it is shows on the table itself: a prompt bar under the board turns red with the buttons for any decision you owe (move, call or pass, showdown, coach warning), a red edge marks your side of the board, claims are labelled on their squares, and the claim picker opens on the destination square. A fixed 16:9 stage scales to the window, with a tall layout on phones. Sound effects are synthesized.
- **For newcomers:**
  - **First-run questions** about your chess and poker experience recommend a lesson path.
  - **Seven interactive lessons** run on staged positions: moving, check and mate, claims, calling, bluffing, the apparent board, and showdowns. Wrong moves get a hint instead of a penalty. A practice match against Professor Fumble follows.
  - **The coach** (on for your first five matches, or toggle it) colours where a hidden card can go by claim type, explains why a move is illegal, guards against blunders, rates each claim's risk, and gives a plain-language read and lean on the opponent's claims.
  - **The codex** covers rules, pieces (with move diagrams), bluffing terms, and the characters you've met. Key terms in the UI link to it.
- **Settings:** volume, mute, coach mode, reduced motion (also honours the OS setting), and a progress reset.

## Not yet

- Full ISMCTS. The expert's determinized alpha-beta was chosen over Monte Carlo tree search, because random playouts are weak in chess-like games and it fits the time budget.
- PvP extras from design section 8: a call-window timer (an online opponent can stall), ratings, lifetime table image for humans, and a hosted server.

## Tuning notes

A literal "bluff only when it beats the best honest move" rule almost never fires, because lies rarely buy a big tactical edge. So the bot treats a bluff as available when it costs little position (`bluffMargin`) and the risk of being called is tolerable (`riskTolerance`). Personality and context (`bluffRate`, `bluffContext`) then decide how often it takes one. Lies that win big are twice as tempting. Measured lie rates against the Deacon: Tutor about 50%, Widow about 19%, Pip about 16%, Marlowe about 14% (honest for his first four claims), Sable about 5% (queen claims only), and the Deacon about 1% unless he falls behind.

**Difficulty.** Opponents were measured against two stand-ins for a new player: a novice that takes the biggest capture it sees and otherwise moves at random, and a casual player that looks one move ahead and often settles for a lesser move. Each bot has a `chessStrength` (search depth) and a `mistakeRate`/`mistakeWindow` (how often it plays a lesser move, and how much worse that move may be). On Normal, the casual stand-in wins about 75% against Professor Fumble, 41% against the Deacon, 39% against Marlowe, 31% against Pip, 25% against Sable and 20% against the Widow (measured with two-way chip bets and busting). A Difficulty setting (Easier / Normal / Harder, in Settings or on the Circuit page) adjusts every opponent's strength, mistakes and calling; against the Deacon it gives roughly 73% / 41% / 13%. The novice stand-in doesn't win, because random moves can't deliver checkmate; it only shows that the bots never lose to random play. Re-measure with `npm run difficulty -- deacon 30` after changing any bot parameter.
