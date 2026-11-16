# durable-queue

Objective: work queued for a bot survives a server restart, and a run that was cut off is reported, never repeated (R4 of `docs/requirements-superbot-ideas.md`).
Branch: `feat/durable-queue`, stacked on `feat/shared-user-facts` (`fd547ac`). Delivery: `ask-on-risk`, to the fork (`origin`) only. Test runner: `npm test`; `npm run typecheck`.

## Specs

- S1. User (verbatim): "sigue con las tareas pendientes". Pending requirements: R3 (done) and R4. R4 as written: "Queued work survives a server restart; a run that was cut off is reported, never repeated".
- S2. (R4.1) A turn that was queued but not started when the server stopped runs after it starts again, in the original order.
- S3. (R4.2) A turn that was running when the server stopped is not run again. Its chat shows that it was interrupted, and tool calls left as running or awaiting approval are closed with that status.
- S4. (R4.3) R4.2 holds for every trigger: user messages, routines, event triggers, check-ins and bot-to-bot messages.
- S5. (R4.4) After a restart no bot is left shown as running when nothing is running.
- S6. Done when (from R4): "With two messages queued for one bot, the server is killed during the first: after the restart the first shows as interrupted and is not repeated, and the second runs. A `gmail_send` that was in flight is not sent a second time."
- Assumption: a turn counts as running from the moment its run starts, before anything is sent to the engine, so a crash can never leave a started turn marked as waiting.
- Assumption: a question asked with `ask_bot` that was still queued is run after the restart as an ordinary message from that bot: nobody is waiting for the answer any more (who waits for whom is kept in memory), so the asked bot replies with `send_to_bot`.
- Assumption: a server started with `GROKBOT_NO_SCHEDULER=1` (an extra dev or test server on a copy of the database) does not pick up queued turns, as it does not run routines either.
- Assumption: queued turns are run however long the server was down; no age limit is applied.

## Tasks

- [x] T1 (S2,S3,S4) inline: what to do with each stored turn at start, as a pure function with tests (`server/src/agent/queue-recovery.ts`). Risk: item 4 (ordering).
- [x] T2 (S2,S3,S4,S5) inline: table `turn_queue`; turns stored when queued, marked when they start, removed when they end; `recoverTurns` at start; docs.
- [x] T3 (S6) inline: end-to-end check that kills and restarts a server (L4).
All three are in one commit, the one that adds this document.

Route: inline (one behavior; T2 depends on T1).

## Log

- L1 (2026-11-16) User: "sigue con las tareas pendientes".
- L2 (2026-11-16) Evidence: a bot's queue is a chain of promises in memory (`server/src/agent/loop.ts`, `enqueue`); every trigger passed to it is plain data (`user`, `routine`, `bot`, `system`), from `routes.ts`, `voice.ts`, `agent/rooms.ts`, `routines.ts`, `triggers.ts`, `proactive.ts` and the loop itself. Live state ("running") is kept in memory only (`store.ts`), so it is already empty after a restart; what stays behind in the database are tool-call rows with status `running` or `awaiting-approval` and assistant messages still marked `streaming`. Pending approvals are already expired at start (`expireStaleApprovals`). The table `pending_turns` exists but holds one row per bot and nothing writes to it.
- L3 (2026-11-16) RED/GREEN: `queue-recovery.test.ts` (7 tests) failed first (module missing), then passed. Suite: 124 tests, 123 pass, 0 fail, 1 skipped; `npm run typecheck -w server` clean. Storing, marking and removing rows and `recoverTurns` itself have no unit test (they need the database); they are covered by L4.
- L4 (2026-11-16) End-to-end, isolated server (`mktemp -d` data, port 8799, no `.env`), one bot on a stand-in CLI through `CLAUDE_BIN` (no model turns):
  - Three messages sent; the first turn streamed "Working on it", announced a `gmail_send` tool call and hung. `turn_queue` then held `1 running`, `2 queued`, `3 queued`.
  - Server killed with `kill -9`, the stand-in CLI too, then started again on the same database. Log: "after the restart: 1 turn(s) interrupted, 2 queued turn(s) picked up".
  - Chat after the restart: the streamed message closed, the `gmail_send` row with status error and summary "Interrupted", the notice "Interrupted: the server restarted while this was running. It was not run again.", then the replies to the second and third messages in that order.
  - The engine was given the first message once, then the second and the third, once each. `turn_queue` empty; the bot not shown as running.
  - Not checked: a real `gmail_send` in flight (the stand-in only announces the call), routine, check-in, event and bot-to-bot triggers end to end (their shape is covered by the unit test; they enter through the same `enqueue`), a Hermes bot (no gateway here), a graceful stop (SIGTERM) as opposed to a kill, `GROKBOT_NO_SCHEDULER=1`.
- L5 (2026-11-16) Changes to existing behavior, intended: every queued turn now writes a row and removes it when it ends; after a restart, turns that were waiting run instead of being lost, and a chat whose turn was cut off gets the "Interrupted" notice.
