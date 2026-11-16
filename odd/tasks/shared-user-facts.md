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
- Assumption: the facts a bot gets from other bots are capped (40 facts, 4000 characters, the latest kept), so a long history cannot crowd the prompt. A bot's own facts are never capped by this.

## Tasks

- [x] T1 (S2,S4,S5) inline: merging, capping and removing facts as pure functions with tests (`server/src/lib/user-facts.ts`). Risk: item 1 (removal now deletes stored entries in several bots' files).
- [x] T2 (S2,S3,S4,S5,S6) inline: memory listing and removal across a user's bots, facts in every bot's instructions, the "From the team" mark on the memory screen, docs.
- [x] T3 (S7) inline: end-to-end check with two bots (L4).
All three are in one commit, the one that adds this document.
- [x] T4 (S2) inline: correction after independent verification (B1 in L6). Commit: the one that adds this line.

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
- L6 (2026-11-16) Independent verification of `040a61e` (isolated server, stand-in CLI, scratch primary home, no model turns). S3-S6 pass; S2 pass with one blocker; S7 not run with a model (L4 covers it).
  - B1: the cap was applied to every fact a CLI bot is told, its own included. With 30 own facts and 33 from another bot it was told 7 of its own (30 before this change); three long facts from another bot removed its own two; one entry over 4000 characters ended the list, so every bot was told nothing.
  - Held: removal takes out exactly the named fact in every bot of that user and nothing else (multi-paragraph entries, an inline "§", padded duplicates, a file without a trailing newline, a missing file, a note in `MEMORY.md` with the same text); crafted ids change nothing; another user's files stay byte-identical and their ids answer 404; only one bot on the server can be `primary`, so two users cannot share that home; listing and building instructions write no file; Hermes instructions are byte-identical to `dc6c770` while no other bot holds a fact the bot lacks; the format written by removal matches baseline.
  - Advisories, not changed: a fact saved through one bot now reaches every bot of that user, so a poisoned fact has a wider reach than before; a `USER.md` with CRLF line ends is read as one entry (as before) and is now shared as one fact; removal rewrites other bots' files by read-modify-write and can race with an agent writing its own file; `DELETE /memories/:id` answers ok when nothing was removed (as before); another bot's open memory list does not refresh after a shared removal.
- L7 (2026-11-16) Correction, RED then GREEN (4 new tests failed first; suite 117 tests, 116 pass, 0 fail, 1 skipped; typecheck clean):
  - B1: a bot whose memory the app sends in full gets all of its own facts, then the capped facts of the others. A fact too long to send is skipped instead of ending the list.
  - Advisory taken: a fact is written on one line whatever line break it holds (`\r`, `\n`, U+2028, U+2029), in both places that list facts.
  - Advisory taken: the memory list puts a bot's own facts before the team's, so the voice prompt, which takes the first 12, still starts with the bot's own.
- L8 (2026-11-16) Recheck by the same verifier, limited to B1, at `0aee897`: fixed. With 30 own facts and 33 from another bot, the bot is told all 30 of its own (7 before) plus the others; with three 1990-character facts from another bot its own two are kept; with one 4500-character entry the other facts are still told to every bot and the entry is skipped for the bots that do not own it. A fact with a bare `\r` appears as one line. A Hermes bot's instructions are still byte-identical to `dc6c770` while no other bot holds a fact it lacks. The memory list shows a bot's own facts first. Scratch removed by the parent.
