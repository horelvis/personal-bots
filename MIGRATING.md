# Migrating from personal-bots to Hermes Agent

personal-bots is **deprecated** as of 2026-11-26 and no longer maintained. [Hermes Agent](https://github.com/NousResearch/hermes-agent) now covers what this project was built for. It runs several agents, gives each bot its own screen, and connects to the chat apps you already use. The safety features that were unique here can be rebuilt as Hermes plugins.

This guide maps what personal-bots did to where it lives in Hermes. It reflects Hermes at commit `8fc0374` (2026-11-23); check the [Hermes docs](https://hermes-agent.nousresearch.com/docs/) for anything newer.

## The platform

| personal-bots | Hermes |
|---|---|
| A team of bots, each with its own persona and memory | Profiles: one Hermes home per agent (`~/.hermes/profiles/<name>`), and bot mode / multi-profile gateways to run them together |
| One screen per bot, live view and **Take control** | Bot Screen: each bot gets its own desktop on the gateway host, streamed into Hermes Desktop, with take-over for logins and 2FA |
| Web app to chat with the bots | Hermes Desktop, the TUI, and the web dashboard |
| Telegram (R11) | The gateway: Telegram, Discord, Slack, WhatsApp, Signal and CLI from one process, approval prompts included |
| Routines and check-ins | The built-in cron scheduler, with delivery to any platform |
| Bots asking each other (`ask_bot`, `send_to_bot`) | Subagents (delegation) and the Kanban board shared by profiles |
| Voice calls, X research | Voice mode, X search |
| Claude Code bots in a container (R1, R8) | Terminal backends (local, Docker, SSH and others) and the Codex/app-server runtimes; give the agent a sandboxed `terminal.backend` |

## The safety layer

Hermes exposes plugin hooks that cover these. A plugin is a folder in `~/.hermes/plugins/<name>/` with a `plugin.yaml` and a `register(ctx)` function, enabled per profile in `config.yaml` under `plugins.enabled`.

| personal-bots | In Hermes |
|---|---|
| **Action check (R6)**: every action is checked against the user's own words and rules; otherwise an approval card | Write a plugin on `pre_tool_call`, which sees every tool call (terminal, files, browser, MCP and connector tools). It can return `block`, `approve` (the existing approval prompt, also in messaging gateways) or `modify`. Cache the user's messages from `pre_llm_call`, and use `ctx.llm.complete` as the judge. **Note:** in YOLO mode, with `approvals.mode: off`, or in `hermes -z` runs, an `approve` passes without asking, so a strict check must return `block` when nobody is there to answer. |
| **Outside content is data (R7)** | Built in for web, browser and MCP results (`<untrusted_tool_result>`). Use `transform_tool_result` for connectors and terminal output. |
| **Verified memory (R5)**: facts about the user are kept only when the user said them | The `provenance-gate` plugin in the Hermes plugin catalog; or `pre_tool_call` on the `memory` tool. `memory.write_approval: true` asks before every write. |
| **Spending recorded and capped (R9)** | Catalog plugins `budget-leash`, `cost-sentinel`, `costguard`, `cron-budget`. Sessions already store `estimated_cost_usd`; `post_api_request` gives usage per call, and `pre_llm_call` can stop a turn, cron included. |
| **Evals (R10)** | No general harness yet. The approach in `evals/` here (a stateful stand-in for Gmail and Calendar, attack and false-memory scenarios, a careful user that allows only the expected card) carries over: register fake tools with `ctx.register_tool` and run against an isolated `HERMES_HOME`. |

## Your data

- **Memories**: each bot's `memories/MEMORY.md` and `USER.md` under `ENGINES_DIR/<botId>/` use Hermes' own format; copy them into the matching profile's `memories/`.
- **Routines**: listed in the `routines` table of the app's database (`DB_PATH`); recreate them with Hermes cron, in natural language.
- **Connected apps**: reconnect them in Hermes (MCP servers or connectors); tokens stored here are sealed with this app's `SESSION_SECRET` and are not portable.
