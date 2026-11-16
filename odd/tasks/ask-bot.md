# ask-bot

Objective: a bot can ask another bot a question and get the answer inside the same turn (R2 of `docs/requirements-superbot-ideas.md`).
Branch: `feat/ask-bot`, stacked on `feat/engine-adapters` (`5a73fba`) because both change `server/src/agent/loop.ts`. Delivery: `ask-on-risk`, to the fork (`origin`) only. Test runner: `npm test`; `npm run typecheck`.

## Specs

- S1. User (verbatim): "sigamos con R2". R2 as written: "A bot can ask another bot and get the answer in the same turn".
- S2. (R2.1) A bot can ask another bot a question and receive the answer as the result of that tool call, inside the same turn.
- S3. (R2.2) The other bot answers in its own chat, where the user can read the exchange.
- S4. (R2.3) If the answer takes longer than a set limit, the call returns saying so and the answer arrives later as a message, as it does today.
- S5. (R2.4) The existing hop limit applies. Two bots waiting on each other must not block forever.
- S6. (R2.5) Fire-and-forget delegation (`send_to_bot` as it is) stays available.
- S7. Done when (from R2): "Bot A asks Bot B for a fact, B answers in its own chat, and A uses that answer in the same reply to the user. A question B cannot answer in time returns the "still working" result and the late answer reaches A as a message."
- Assumption: the waiting limit is 9 minutes (the open decision of R2; superbot's value), changeable with `ASK_BOT_WAIT_SECONDS`. It is below the 30-minute tool timeout both engines are given.
- Assumption: the new tool is `ask_bot`; it works for both engines because it is one of the app's own tools.
- Assumption: a question that would close a circle of bots waiting on each other is refused at once instead of waiting for the limit.

## Tasks

- [x] T1 (S2,S4,S5) inline: the waiting logic (answer, limit, circle, release), tested on its own (`server/src/agent/asks.ts`). Risk: item 4 (concurrency).
- [x] T2 (S2,S3,S4,S5,S6) inline: `ask_bot` tool, the loop collecting the asked bot's reply and delivering late answers, prompt and docs.
- [x] T3 (S7) inline: end-to-end check with two bots (L4).
All three are in one commit, the one that adds this document.

Route: inline (one behavior; T2 depends on T1).

## Log

- L1 (2026-11-16) User: "sigamos con R2".
- L2 (2026-11-16) Evidence: `send_to_bot` (`server/src/agent/tools.ts`) queues a message with `enqueueBotMessage` and returns at once; a bot's turns run one at a time in a per-bot queue (`loop.ts`); `runTurn` writes the reply through `closeMessage` and `say` and returns nothing, so nothing can wait for another bot's reply today.
- L3 (2026-11-16) RED/GREEN: `asks.test.ts` (10 tests) failed first (module missing), then passed. Suite: 100 tests, 99 pass, 0 fail, 1 skipped; `npm run typecheck -w server` clean. The loop wiring (`askBot`, collecting what a bot said, late delivery) has no unit test; it is covered by L4.
- L4 (2026-11-16) End-to-end, isolated server (`mktemp -d` data, port 8799, no `.env`), two Claude Code bots (Alice, Bob), model `haiku`:
  - Same turn: Alice called `ask_bot`; the question appeared in Bob's chat as a message from Alice; Bob wrote "17 times 3 is 51. The fruit is apple."; Alice's tool row is "Asked Bob" and her reply in the same turn quotes Bob. 10 s in all.
  - Circle: asked by Alice, Bob tried `ask_bot` back to Alice; it returned at once with "Alice is waiting for an answer from you right now, so asking them back would leave you both waiting. Answer them first." (row summary "Not sent"), and Bob then answered Alice.
  - Late answer, `ASK_BOT_WAIT_SECONDS=6`: Bob's shell command waited 14 s on its approval card; Alice's `ask_bot` returned "Bob is still working on it. Their answer will arrive later as a message; do not ask again." and her turn ended; after the approval Bob's reply arrived in Alice's chat as a message from Bob and started a new turn of hers.
  - Not checked: the default 9-minute limit itself, the hop limit of 3 with `ask_bot` (same check as `send_to_bot`, read in the code), Hermes bots (no gateway here; `ask_bot` is one of the app's own tools, served to every engine), an asker stopped by the user while it waits (unit test of `release` only).
- L5 (2026-11-16) Change to existing behavior, intended: the instructions line about `send_to_bot` now also describes `ask_bot`, so every bot's instructions text changes once; managed Hermes gateways restart on the next server start because the tool list changed (existing `toolsStamp` mechanism).
