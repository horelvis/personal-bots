# Telegram (R11)

Objective: talk to the bots from Telegram, approvals included, through one Telegram bot the user creates. Branch `feat/telegram`; delivery: work-unit commits, pushed to `main` when the user says so. Test runner: `cd server && npm test`.

## Specs

- S1 (R11.1) "The user can link a Telegram account to their user; only that account can talk to their bots there." Design: Settings → Telegram gives a one-time code (10 minutes) as a `t.me/<bot>?start=<code>` link; `/start <code>` in a private chat links that Telegram account; any other chat gets a short refusal.
- S2 (R11.2) "A message there reaches the main bot (or a named bot) like a chat message, and the reply comes back there." Design: "@Name message" or "Name: message" picks a bot by name; otherwise the main bot. The bot's finished replies and error notices of that turn are sent back.
- S3 (R11.3) "An approval card appears in Telegram with buttons, tied to that exact approval; answering there or in the app resolves it once." Design: every pending approval card of the linked user is sent with Allow / Deny buttons (Always allow where the app offers it); the buttons name the approval id; answering goes through the same `resolveApproval`; when the card is answered anywhere, the Telegram message is edited to show the outcome and loses its buttons.
- S4 (R11.4) "Anything that needs a secret (a sign-in) sends the user to the web app instead."
- S5 Done when: "From Telegram the user asks the main bot to email someone, gets the approval with buttons, taps Allow, and sees the same card resolved in the web app."
- S6 Decision (L2): long polling (`getUpdates`), no public address. Config: `TELEGRAM_BOT_TOKEN`; `TELEGRAM_API_URL` (default `https://api.telegram.org`) for a stand-in in tests.

## Tasks

- T1 [S1-S4, S6] Server: storage, the Telegram client and poller, routing, reply and card forwarding, link routes. Route: inline. Status: open.
- T2 [S1] Web: Settings → Telegram. Route: inline. Status: open.
- T3 [S5] End-to-end with a stand-in Telegram API, docs. Route: inline. Status: open.

## Log

- L1 (2026-11-25) User: "sigue con R11".
- L2 (2026-11-25) Decision: "Long polling (Recommended)".
- L3 (2026-11-25) Evidence: rows are published through `hub.emit(userId, ...)` (`server/src/store.ts` `appendRow`/`updateRow`, `server/src/lib/hub.ts`); approvals are answered with `resolveApproval(userId, approvalId, decision)` (`agent/loop.ts`), which ignores an approval that is no longer pending; the web route `POST /api/bots/:id/messages` appends the user row and calls `enqueue`. `hub.isOnline` is unused, but a Telegram listener is kept out of the per-user listeners anyway (a separate tap).
- L4 (2026-11-25) T1, T2 inline (03ce952 and the next commit): `telegram/route.ts` (pure: which bot, the card message and its buttons, reading a button back; RED then GREEN, 3 tests), `telegram/bot.ts` (client, poller, linking, forwarding), `hub.tap`, `users.telegram_*`, `telegram_links`, `telegram_cards`, `GET/POST/DELETE /api/telegram`, Settings → Telegram. Suite: 226 tests, 226 pass; typecheck passes.
- L5 (2026-11-25) End-to-end with a stand-in Telegram API (queued updates, recorded calls), the evals' Google stand-in with a seeded connection, and a stand-in Claude Code that calls `gmail_send` through MCP:
  - A stranger's "hello" got "This bot is private…". The link was `https://t.me/hq_test_bot?start=<code>`; `/start <code>` linked; the same code from another account was refused.
  - "Eve: Please email ana that the report is ready" from Telegram produced a card there: "Eve asks: Allow Eve to send an email? To: ana@example.com Subject: Hi The report is ready. …", with buttons `ap:<id>:allow`, `ap:<id>:deny`, `ap:<id>:always`.
  - A stranger tapping Allow got "Not available." The owner tapping Allow got "Done.". The Telegram message was edited to "Allowed", the card in the app was `approval:allowed`, the email reached the stand-in (to ana@example.com, subject Hi), and Eve's reply came back to Telegram. A second tap got "Already answered.".
  - A card denied in the app edited its Telegram message to "Not allowed". "Alice: hi there" reached Alice and her reply came back. After unlinking, messages got the refusal again.
  - Found and fixed on the way: (1) a message without a name went to the main Bot, which on the test server was the Hermes bot (by design; the test then named the bot). (2) If Telegram was unreachable at startup the poller never started; now it retries (5 s doubling to 5 min). (3) Waiting for an approval shows as not running, which ended the reply forwarding early, so the reply after Allow did not come back; now the turn ends only when nothing waits.
  - Not checked: the real Telegram API, a real model's turn, the Settings page in a browser (typecheck only). Risk: item 2 (security: a new channel that can approve actions; identity is the Telegram account id).
