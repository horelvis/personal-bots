# Spending is recorded and capped (R9)

Objective: record what each turn and the server's own model calls cost, show it per month, bot and routine, and stop unattended work at a monthly limit the user sets. Branch `feat/spending`; delivery: work-unit commits, pushed to `main` when the user says so. Test runner: `cd server && npm test`.

## Specs

- S1 (R9.1) "Each turn records the model, tokens and estimated cost, per bot and per user, when the engine reports them; "unknown" when it does not." Decision (L2): cost in US dollars at list price; Claude Code's own `total_cost_usd` when it gives one, otherwise tokens × a price table in the app (overridable with `MODEL_PRICES`); with a subscription it is shown as the API equivalent. Assumption: the server's own model calls (the action check, `x_search`) and voice calls are recorded too, attributed to the bot.
- S2 (R9.2) "The app shows spending per month, per bot and per routine."
- S3 (R9.3) "The user can set a monthly limit. At the limit, routines, check-ins and other unattended work stop and the user is told; a chat message gets an answer offering to raise the limit." Decision (L3): no limit by default.
- S4 (R9.4) "A run that would clearly pass the limit is not started." Assumption: "clearly" = this month's spending plus the median cost of the last five runs of the same routine (or the same bot) passes the limit.
- S5 Done when: "After a few turns the spending page shows them with their cost; with a limit lowered below the month's spending, the next routine does not run and the user sees why."
- S6 (assumption) Months are calendar months in UTC. Costs that are unknown count as zero toward the limit and are shown as unknown.

## Tasks

- T1 [S1, S6] Recording: `spending` table, `lib/prices.ts`, usage from Claude Code's result line and Hermes' `response.completed`, rows for turns, checks, searches and voice calls. Route: inline. Status: open.
- T2 [S2, S3, S4, S5] Limit and page: `users.spend_limit_usd`, the check before a turn starts, the answer or notice, `GET /api/spending` and `PUT /api/spending-limit`, a Spending section in Settings, docs. Route: inline. Status: open.

## Log

- L1 (2026-11-25) User: "si" (to "¿Sigo con R9?").
- L2 (2026-11-25) Decision: "Dólares a precio de lista (Recommended)".
- L3 (2026-11-25) Decision: "Sin límite (Recommended)".
- L4 (2026-11-25) Evidence: Claude Code 2.1.325, run against a stand-in provider, ends with a `result` line carrying `total_cost_usd`, `usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`) and `modelUsage` keyed by model with `costUSD` and `costBasis: "list"`; its `init` line carries `model`. Hermes (`~/.hermes/hermes-agent`, API server) ends a `/v1/responses` stream with `response.completed` whose `response.usage` holds `input_tokens`, `output_tokens`, `total_tokens`, and `response.model` (likely the requested name); no cost. The app ignores both today (`loop.ts` has no `response.completed` case; `claude.ts` reads only `is_error`, `subtype`, `result`). The action check (`trust.ts`) and `x_search` (`agent/tools.ts`) get `usage` back and ignore it; voice calls keep an estimated cost only inside their chat row.
- L5 (2026-11-25) Prices: Anthropic list prices from the bundled Claude API reference (cached 2026-11-03); other providers' prices are not built in (unknown unless set in `MODEL_PRICES`).
- L6 (2026-11-25) T1 inline (b61458a): `lib/prices.ts`, `lib/spend-limit.ts`, `spend.ts`, the `spending` table and `users.spend_limit_usd`; usage from Claude Code's result line (a new `usage` event) and from Hermes' `response.completed`; one row per turn (written in `runTurn`'s `finally`, so also for failed turns), and rows for the action check, X search and voice calls. RED: the prices, limit and Claude Code usage tests failed first (modules missing, parse returned no usage). One test of mine was wrong (exact float equality for a median of 0.2 and 0.4) and was corrected to a tolerance. GREEN. Suite: 222 tests, 222 pass; typecheck passes.
- L7 (2026-11-25) T2 inline: the limit check at the start of `runTurn`, the answer or notice, `GET /api/spending` and `PUT /api/spending-limit`, Settings → Spending (`AppSettings.tsx`), docs (ARCHITECTURE, `.env.example`). End-to-end, isolated server with a stand-in Claude Code that reports US$0.25 per turn:
  - After three chat turns the report showed a total of US$0.75, Alice with 3 turns, and kind "turn"; after one routine run, US$1.00 and the routine "Daily digest" with 1 run and US$0.25.
  - A limit of -1 was refused with 400. With a limit of US$0.50, the routine did not run and its chat got: "This month's spending (US$1.00) has reached your limit (US$0.50), so the routine "Daily digest" did not run. Raise the limit in Settings → Spending to let it run again." A chat message got: "This month's spending (US$1.00) has reached your limit (US$0.50), so I did not answer. Raise the limit in Settings → Spending and send your message again." The total did not change.
  - With a limit of US$1.20 the routine (typical US$0.25) did not start (`would-pass` in the log), but no notice appeared, because notices were limited to one an hour per bot. Fixed: once an hour for each bot, reason and routine.
  - With no limit the routine ran again. A past month with nothing recorded returned an empty report.
  - Not checked: a real Hermes turn's `response.completed` (code reading of Hermes' API server only), the page in a browser (typecheck and build only), a real xAI action check's `usage`.
- L8 (2026-11-25) Rerun of the notices after the fix: at the limit (US$1.00 of US$1.00) the routine got its notice; a second run in the same hour got none; with US$1.20 the would-pass case got its own notice ("This month's spending is US$1.00 of your US$1.20 limit, and a run like this one would likely pass it, so the routine …"). Risk: none (without a limit `mayStart` always allows and the turn runs as before; recording is wrapped so a failure never breaks a turn).
- L9 (2026-11-26) Found in the first UI test with the user's real data (QA Local, a managed Hermes bot whose model comes from its Hermes config, not from the bot): its turn was recorded with 64196 input and 329 output tokens but no model, because Hermes names the requested model ("hermes-agent") and the bot names none, so the cost was unknown. Fixed: a Hermes turn without a model on the bot takes the engine's configured default (`engineDefaultModel`, the same `/api/model/options` the engine panel shows). Next real turn: "turn|claude-opus-5-5|21833|4|0.0874|price-table", and Settings → Spending showed US$0.09 for QA Local. Also the month name now follows the app's language (English) instead of the browser's.
