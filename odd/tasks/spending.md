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
