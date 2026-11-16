# shared-user-facts

Objective: what one bot learns about the user is known to all of that user's bots (R3 of `docs/requirements-superbot-ideas.md`).
Branch: `feat/shared-user-facts`, stacked on `feat/ask-bot` (`dc6c770`). Delivery: `ask-on-risk`, to the fork (`origin`) only. Test runner: `npm test`; `npm run typecheck`.

## Specs

- S1. User (verbatim): "sigue con las tareas pendientes". Pending requirements: R3 and R4. R3 as written: "Facts about the user are shared by all bots".
- S2. (R3.1) Facts about the user are kept once per user and read by all of that user's bots.
- S3. (R3.2) A bot's own notes (`MEMORY.md`: its job, rules, work log) stay private to that bot.
- S4. (R3.3) The memory screen shows shared facts once, not once per bot, and removing one removes it for every bot.
- S5. (R3.4) Facts are never shared between different users of the same server.
- S6. (R3.5) The primary Hermes agent's own files are not rewritten by the app, in line with the rule in `engine.ts` that its home is left alone.
- S7. Done when (from R3): "The user tells one bot their time zone, and a different bot answers a question that depends on it without being told again."
- Assumption (R3's first open decision, how homes share one file): no file is shared or copied. Each bot keeps writing its own `USER.md`; the shared view is read from all of the user's bots when a turn starts, and the facts a bot does not have itself are added to its instructions. This writes nothing into any Hermes home.
- Assumption (R3's second open decision, existing entries): entries already in each bot's `USER.md` stay where they are and become shared by being read; nothing is migrated.
- Assumption: "kept once" is met by showing and sending each fact once (same text in two bots is one fact); the files may still hold it twice.
- Assumption: removing a shared fact from the memory screen removes that text from every bot of the user that has it, the primary agent's file included. That is the user's own action, which the app already performs today for a bot's own entries; the app still never writes that file by itself.
- Assumption: the facts added to a bot's instructions are capped (40 facts, 4000 characters), newest file order kept, so a long history cannot crowd the prompt.

## Tasks

- [x] T1 (S2,S4,S5) inline: merging, capping and removing facts as pure functions with tests (`server/src/lib/user-facts.ts`). Risk: item 1 (removal now deletes stored entries in several bots' files).
- [x] T2 (S2,S3,S4,S5,S6) inline: memory listing and removal across a user's bots, facts in every bot's instructions, the "From the team" mark on the memory screen, docs.
- [x] T3 (S7) inline: end-to-end check with two bots (L4).
All three are in one commit, the one that adds this document.

Route: inline (one behavior; T2 depends on T1).

## Log

- L1 (2026-11-16) User: "sigue con las tareas pendientes".
- L2 (2026-11-16) Evidence: memory is per bot in its home (`memories/MEMORY.md`, `memories/USER.md`, entries split by a "§" line; `server/src/engine-memory.ts`). `listMemories(botId)` and `deleteMemory(id)` read and write one bot's files; `deleteMemory` already rewrites the primary agent's file when the user removes one of its entries. A Hermes agent writes `USER.md` itself; a CLI bot writes it through the `remember` tool. The `mode` of a bot ('personal' | 'teammate') is stored but changes no behavior on the server.
- L3 (2026-11-16) RED/GREEN: `user-facts.test.ts` (8 tests) failed first (module missing), then passed. Suite: 113 tests, 112 pass, 0 fail, 1 skipped; `npm run typecheck` (server and web) clean. The wiring in `engine-memory.ts` and `prompt.ts` has no unit test (both need the database); it is covered by L4.
- L4 (2026-11-16) End-to-end, isolated server (`mktemp -d` data, port 8799, no `.env`), two Claude Code bots of one user (Alice, Bob), facts saved through the `remember` tool by direct MCP calls, one real turn (model `haiku`):
  - Alice saved "Their time zone is Europe/Madrid." and a note of her own; Bob saved the same time zone fact and "They have two dogs.".
  - Alice's memory list: her note, the time zone fact once, and the dogs fact marked shared. Bob's list: the two facts, not Alice's note.
  - Asked "How many dogs do I have, and what time zone am I in?", Alice answered "You have two dogs, and your time zone is Europe/Madrid." The dogs fact was saved only by Bob.
  - A bot of another user with its own `USER.md` (inserted straight into the database): its fact appeared neither in Alice's memory list nor in her instructions, and its file was untouched.
  - Removing the time zone fact from Bob's list removed it from Alice's and Bob's `USER.md`; "They have two dogs." and Alice's `MEMORY.md` were left as they were.
  - Not checked: a Hermes bot (no gateway here): the section "What the team knows about ..." added to its instructions, and removal reaching the primary agent's `USER.md`; the "From the team" chip in the browser (typecheck only); the 40-fact and 4000-character cap beyond its unit test.
- L5 (2026-11-16) Changes to existing behavior, intended: a bot's memory list now also holds the facts other bots of the same user saved; removing a user fact reaches every bot of that user. For a Hermes bot the instructions are unchanged while no other bot holds a fact it lacks.
