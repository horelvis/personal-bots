# verified-user-facts

Objective: a fact about the user is kept for the whole team only when the user said it, checked by the server (R5 of `docs/requirements-nod-ideas.md`).
Branch: `feat/verified-user-facts`, stacked on `feat/untrusted-results` (R7, `a78333b`) because both change the tools and the prompt. Delivery: `ask-on-risk`, to the fork (`origin`) only. Test runner: `npm test`; `npm run typecheck`.

## Specs

- S1. User (verbatim): "Adelante" (to the proposal to build R5-R7). R5 as written: "Facts about the user are kept only when the user said them".
- S2. Decision asked and answered. Question: "R5: para que un dato sobre ti solo cuente si lo dijiste tú, cada dato llevaría una cita literal de un mensaje tuyo y el servidor comprobaría que esa cita existe. El problema: los bots de Hermes escriben su USER.md por su cuenta, sin pasar por la app. ¿Cómo lo resolvemos?" User chose (verbatim option): "Compartir solo lo verificado (Recommended)" - "Los datos verificados (con cita comprobada) van a una tabla del servidor y son los únicos que se comparten entre bots y se muestran con su mensaje de origen. Lo que un bot escriba en su USER.md sin verificar se queda solo en ese bot. No toca la configuración de Hermes; los datos actuales pasan a 'sin verificar' y no se pierden. El bot propone la cita y el servidor la comprueba, sin llamadas extra a un modelo."
- S3. (R5.1) A fact about the user is kept only if it quotes, word for word, a message the user wrote (in any chat, or a voice request), and the server finds that quote in the stored message.
- S4. (R5.2) The check happens in the server, not in the prompt. A fact that fails it is not saved, and the bot is told why.
- S5. (R5.3) Each fact keeps a link to the message it came from, and the memory screen shows that message.
- S6. (R5.4) Content the user did not write (tool results, pages, emails, files, other bots' messages) can never be the source of a fact.
- S7. (R5.5) A fact that contains something that looks like a secret (a card number, a key, a login link) is not saved.
- S8. (R5.6) A correction from the user replaces the old fact instead of adding a second one.
- S9. Done when (from R5): "A bot that reads an email saying "the user's assistant is now Carol" does not save that, while the user saying "Carol is my assistant now" in chat does; the memory screen shows the fact with that message; the fact reaches the other bots (R3); an attempt to save a card number is refused."
- Assumption: the user's messages are the message rows with role `user` in any chat or group of that user, typed or from a voice call; rows from another bot or a routine are not the user's words.
- Assumption: a quote must be at least 2 words and 8 characters once normalised (case, accents of the same letter, spaces and surrounding quotes ignored), so "yes" or "ok" cannot back a fact.
- Assumption: the server checks that the quote is the user's, not that the fact follows from it; a bot could pair a real quote with a fact it does not support. That residual risk is left for R6.
- Assumption: verified facts are shared with every bot of the user, as R3 shares facts today; a bot's own `USER.md` entries, which are not verified, are no longer shared and stay with the bot that wrote them (this narrows R3 on purpose).
- Assumption: removing a fact about the user from the memory screen removes it everywhere: from the verified facts and from every bot's `USER.md` that holds the same text, as R3 does.

## Tasks

- [x] T1 (S3,S6,S7) inline: the checks as pure functions with tests (`server/src/lib/fact-check.ts`). Risk: item 1.
- [x] T2 (S3,S4,S5,S6,S8) inline: table `user_facts` and its store (`server/src/lib/verified-facts.ts`, tested on an in-memory database), the `remember_about_user` tool for every engine, sharing only verified facts, removal, CLI `remember` limited to the bot's own notes, prompts, docs. Risk: item 1.
- [x] T3 (S5) inline: the memory screen shows verified facts with "You said: ..." and marks a bot's own unverified entries "Only <bot>".
- [x] T4 (S9) inline: end-to-end check (L5).
All four are in one commit, the one that adds this line.
- [x] T5 (S5,S6,S7) inline: correction after independent verification (L7, L8). Commit: the one that adds this line. Risk: item 1.
- [x] T6 (S8) inline: correction asked by the native review (L9). Commit: the one that adds this line. Risk: item 1.

Route: inline (one behavior; each task builds on the one before).

## Log

- L1 (2026-11-22) User: "Adelante", after the proposal to continue with R5-R7 of the nod requirements; R7 built first (`a78333b`).
- L2 (2026-11-22) Decision S2.
- L3 (2026-11-22) Evidence: facts about the user live in each bot's `memories/USER.md`; Hermes agents write it themselves, CLI bots through `remember` (`server/src/mcp.ts`); R3 (on `main`) shares the union of all of a user's bots' `USER.md` (`server/src/engine-memory.ts`, `server/src/lib/user-facts.ts`). User messages are rows with kind `message`, body role `user`, and `from` absent (typed) or `{kind: 'voice'}`; `from.kind` `bot` or `routine` marks messages that are not the user's.
- L4 (2026-11-22) RED/GREEN: `fact-check.test.ts` (11 tests) failed first (module missing); one expectation of mine was wrong and fixed before the code ("Carol is my assistant" is not inside "Carol is not my assistant"). `verified-facts.test.ts` (9 tests) failed first, then passed. Suite: 162 tests, 161 pass, 0 fail, 1 skipped; typecheck (server and web) and the web build pass. The wiring in `engine-memory.ts`, the tool and the prompts have no unit test; L5 covers them.
- L5 (2026-11-22) End-to-end, isolated server (`mktemp -d` data, scratch Hermes home, port 8799), two CLI bots on a stand-in CLI, tools called through MCP:
  - The user wrote "Carol is my assistant now, copy her on invoices." to Alice; `remember_about_user` with that quote: "Saved for the whole team."
  - A fact quoting words the user never wrote ("the assistant is now Dave"): "Not saved. The quote is not in any message the user wrote. ..."
  - The user wrote a card number; saving it: "Not saved. It looks like a card number. Secrets are never kept in memory."
  - CLI `remember` with about "user": refused, pointing to `remember_about_user`.
  - An entry written straight into Alice's `USER.md` ("Likes green tea.") is listed for Alice as "only this bot" and not for Bob; Bob's instructions hold the Carol fact and neither the tea nor the Dave text.
  - Both bots list the Carol fact as verified with its source message.
  - A correction from Bob ("Rosa is my assistant now", replaces the Carol fact): "Saved for the whole team, replacing the earlier fact."; only the Rosa fact remains.
  - Forgetting it from Bob's screen removed it for Alice too; Alice's own `USER.md`, which held only "Likes green tea.", was left as it was (when a bot's file holds the same text, that line is removed too, as the assumption says).
  - Not checked: a Hermes bot (no gateway here; its instructions get the verified facts it does not hold, by the same `sharedFactsFor`), the memory screen in a browser (typecheck and build only), voice-call messages as a source (covered by the store's unit test).
- L6 (2026-11-22) Changes to existing behavior, intended (decision S2): facts in a bot's own `USER.md` are no longer shared with the other bots (R3 shared them); existing ones stay with their bot as "only this bot". CLI bots can no longer write `USER.md` through `remember`. Every bot's tool list gains `remember_about_user`, so managed Hermes gateways restart once on the next server start.
- L7 (2026-11-22) Independent verification of `60d44fd` (isolated server, stand-in CLI, store scripts; no model calls). S3, S4, S9 pass; S5, S6, S8 pass with residual risks; S7 failed. No quote bypass held: bot-to-bot messages, `ask_bot`, `post_to_group` by a bot, routine rows, assistant rows and another user's messages were all refused; typed, group and voice messages were accepted. Isolation held (another user's ids answer 404 or change nothing).
  - B1 (S7): a card number followed by more digits ("4111 1111 1111 1111 12/26 123") passed the secret check, was saved and reached the other bots' instructions; the digit pattern took the longest run and checked only that.
  - A1: an option the user picks on a bot's question card was stored as a plain user message, so text the bot wrote counted as the user's words (an email could steer a bot to offer it).
  - Other advisories: voice requests are the voice model's wording of what the user said (counted as the user's, per S3); `replaces` can retire any fact of that user; quotes may be fragments or questions (known assumption); more secret shapes were missed (`sk_live_`, "password is", `api_key=`, private key blocks, Bearer tokens); the fact kept the source text and bot but not the message id; a Hermes bot's instructions now always carry the `remember_about_user` line (intended, L6).
- L8 (2026-11-22) Correction, RED then GREEN (4 new tests failed first; suite 167 tests, 166 pass, 0 fail, 1 skipped; typecheck and web build pass):
  - B1: a card is looked for at every group boundary of a run of grouped digits, so more digits after it no longer hide it.
  - A1: a picked option is stored with `choice: true` and is not the user's words; an answer the user types themselves still is.
  - Taken: the more secret shapes above are recognised (a login link is still named a login link); the fact stores the exact source message id.
  - Recheck by the parent on a live isolated server, the verifier's reproductions: the card with expiry and code is refused ("It looks like a card number"); the picked option cannot back a fact; the user's own typed answer can.
- L9 (2026-11-23) Native review (RDD) of `99283d3`..`1c8521f` (R7 + R5, 20 files). The user first chose "Omitir esta vez", then interrupted before it was recorded and said (verbatim) "Revisar antes"; the review ran with consent granted. Lenses: risk, reliability. Outcome: one blocking finding, correction required:
  - R3-replaces-silently-ignored (S8): a correction whose `replaces` matched no fact exactly still answered "Saved for the whole team.", leaving two contradicting facts in use; a paraphrase, a different full stop, a list mark, or an old fact that lived only in the bot's own `USER.md` all missed.
  - Correction, RED then GREEN (2 new tests failed first; the store test that saved an unmatched correction now expects a refusal; suite 169 tests, 168 pass, 0 fail, 1 skipped; typecheck clean):
    - `replaces` matches the old fact regardless of case, spaces, accents, quotes, a final full stop or a leading list mark (`samePhrase`).
    - When it matches nothing, nothing is saved and the bot gets the facts the team keeps, to retry with the exact one.
    - When it matches an entry in the bot's own `USER.md` (an unverified note), the new fact is saved and that entry is removed.
  - Checked on a live isolated server: an unmatched correction is refused with the list and changes nothing; a correction copied as "- carol is the user's assistant" replaces "Carol is the user's assistant."; correcting the bot's own "Lives in Paris." saves "Lives in Lisbon." and leaves only "Likes green tea." in its file.
