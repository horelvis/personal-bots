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
