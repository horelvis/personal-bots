# Requirements: ideas taken from superbot

Source: a review of [davidondrej/superbot](https://github.com/davidondrej/superbot) (2026-11-16, README and docs only; it was not built or run) against this repository at commit `636cb9d`.

Status: proposed. Nothing here is scheduled or authorized for implementation. Each requirement states what personal-bots does today, what should change, and how to tell it is done. Design choices are left open on purpose and listed under each requirement.

## Summary

| ID | Requirement | Today | Priority |
|----|-------------|-------|----------|
| R1 | Run a bot on a coding-agent CLI (Claude Code, Codex, Pi) as well as Hermes | Hermes only | High |
| R2 | A bot can ask another bot and get the answer in the same turn | Reply arrives later as a new message | Medium |
| R3 | Facts about the user are shared by all bots | One `USER.md` per bot | Medium |
| R4 | Queued work survives a server restart; a run that was cut off is reported, never repeated | Queue is in memory | Medium |

## R1. Engine adapters

**Status (2026-11-16).** Built for Claude Code on branch `feat/engine-adapters`; see `odd/tasks/engine-adapters.md`. Its remaining risk is listed under [Open risks from R1](#open-risks-from-r1).

**Today.** Every bot is run by a Hermes agent (`server/src/engine.ts`). The agent loop gets a Hermes gateway from `engineFor()` at one place (`server/src/agent/loop.ts:355`) and talks to its HTTP API.

**Requirement.**

- R1.1 A bot has an engine type. Hermes stays the default, and existing bots keep working with no migration step by the user.
- R1.2 At least one CLI engine is supported: Claude Code. Codex and Pi follow the same adapter shape.
- R1.3 An adapter does only four things: start or resume the bot's session, send a turn in, map the CLI's output to the events the loop already handles (text delta, text, tool call, error), and pass in the bot's persona and memory.
- R1.4 A CLI engine uses the CLI already installed and signed in on the machine that runs the bot. The app stores no credentials for it.
- R1.5 The user picks the engine when creating a bot and can see which engine a bot uses. Only engines whose CLI is installed are offered.
- R1.6 The app's own tools (routines, tasks, bot messaging, Gmail, Calendar, connected apps) reach a CLI-engine bot, and tools that write still wait for the user's approval card.
- R1.7 A CLI engine never runs with all permission prompts switched off unless R1's open decision below is settled in favour of it. superbot runs every harness that way and has no approvals; that is not acceptable here, because these bots can reach the user's mail and calendar.

**Done when.** A bot created on Claude Code answers in chat with streaming text, shows its tool activity, keeps its session between turns, can call `create_routine` and `gmail_send`, and `gmail_send` stops at an approval card. A Hermes bot created before the change behaves as before.

**Open decisions.**

- How the CLI's built-in tools (shell, file edits, web) are governed: routed through approval cards, limited to an allowlist, or confined to the bot's computer. This decides R1.7.
- Where the CLI runs: on the server host, or inside the bot's computer (Orgo or the local Docker box).
- Whether the per-bot model and effort settings map to each CLI's own options.

## R2. Ask another bot and wait for the answer

**Today.** `send_to_bot` (`server/src/agent/tools.ts:269`) queues a message for the other bot and returns at once. The reply comes back later as a new message, so the asking bot ends its turn and starts another one. Hops are capped at 3.

**Requirement.**

- R2.1 A bot can ask another bot a question and receive the answer as the result of that tool call, inside the same turn.
- R2.2 The other bot answers in its own chat, where the user can read the exchange.
- R2.3 If the answer takes longer than a set limit, the call returns saying so and the answer arrives later as a message, as it does today.
- R2.4 The existing hop limit applies. Two bots waiting on each other must not block forever.
- R2.5 Fire-and-forget delegation (`send_to_bot` as it is) stays available.

**Done when.** Bot A asks Bot B for a fact, B answers in its own chat, and A uses that answer in the same reply to the user. A question B cannot answer in time returns the "still working" result and the late answer reaches A as a message.

**Open decision.** The waiting limit (superbot uses 9 minutes).

## R3. Shared facts about the user

**Today.** Each bot keeps `memories/MEMORY.md` and `memories/USER.md` in its own Hermes home (`server/src/engine-memory.ts`). What one bot learns about the user, the others do not know.

**Requirement.**

- R3.1 Facts about the user are kept once per user and read by all of that user's bots.
- R3.2 A bot's own notes (`MEMORY.md`: its job, rules, work log) stay private to that bot.
- R3.3 The memory screen shows shared facts once, not once per bot, and removing one removes it for every bot.
- R3.4 Facts are never shared between different users of the same server.
- R3.5 The primary Hermes agent's own files are not rewritten by the app, in line with the rule in `engine.ts` that its home is left alone.

**Done when.** The user tells one bot their time zone, and a different bot answers a question that depends on it without being told again.

**Open decisions.**

- How managed Hermes homes share one file (a link, a copy kept in sync, or injected at the start of each turn), given R3.5.
- What happens to the per-bot `USER.md` entries that already exist: merged, or left as they are.

## R4. Work survives a restart

**Today.** Each bot's queue is an in-memory chain of promises (`server/src/agent/loop.ts:29-40`). If the server stops, turns that were waiting are lost without a trace. A turn that was running is closed only when its own code path finishes.

**Requirement.**

- R4.1 A turn that was queued but not started when the server stopped runs after it starts again, in the original order.
- R4.2 A turn that was running when the server stopped is not run again. Its chat shows that it was interrupted, and tool calls left as running or awaiting approval are closed with that status.
- R4.3 R4.2 holds for every trigger: user messages, routines, event triggers, check-ins and bot-to-bot messages.
- R4.4 After a restart no bot is left shown as running when nothing is running.

**Done when.** With two messages queued for one bot, the server is killed during the first: after the restart the first shows as interrupted and is not repeated, and the second runs. A `gmail_send` that was in flight is not sent a second time.

## Open risks from R1

R1 is high risk (security): the CLI's permission prompt, turned into an approval card, is what decides whether a bot runs a command or writes a file on the server's machine. Independent verification and the native review found and closed three ways around the cards. What follows was left open on purpose, accepted by the user on 2026-11-16 and noted here so a later requirement can close it. None of it is scheduled.

| ID | Risk | What would close it |
|----|------|---------------------|
| K1 | **No isolation.** A CLI bot runs on the server host as the server's user. The card is the only barrier: an approved command can do whatever that user can | Run the CLI inside a container (the Docker box that already hosts the screens), with Claude Code installed and signed in there. Largest reduction: a bypass would stay inside the container |
| K2 | **The CLI decides what is safe.** Claude Code chooses which shell commands are read-only and need no card. Verification already found unexpected ones (`ps`, read-only git), and a CLI update can change the list without notice | K1; or pin the CLI version and re-run the verifier's probes on each upgrade; or an explicit allowlist of commands that skip the card |
| K3 | **Web reads have no card.** WebFetch and WebSearch are pre-allowed, so a bot can send out what it may read without a card (its folder, its persona and memory) and can reach services that listen only on the host | Ask for a card per new domain, or block loopback and private addresses; K1 narrows what there is to reach |
| K4 | **"Always allow" is broad.** One click on a shell card allows every shell command for all of that user's CLI bots; the same for reads outside the folder | Remember the choice per bot, or per command pattern, and never offer it for `cli_bash` and `cli_read` |
| K5 | **A Write card shows the path, not the content** | Show the content (or its first lines and size) on the card |
| K6 | **Model credentials reach the child.** `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, when set in the server's environment, are in the CLI's environment; only the card on reading the environment protects them | Prefer the CLI's own sign-in; K1 |
| K7 | **No automated test of the guard's wiring.** The permission rules and the adapter are tested; the path from the CLI's prompt to the card (`mcp.ts`, `loop.ts`) was checked by hand and by the verifier only | An integration test with a stand-in CLI and a test database |

Not verified in R1, to check when the setup allows: a write tool of the app (`gmail_send`) stopping at a card for a CLI bot, a real Hermes turn after the change, and approvals that wait for minutes.

## Considered and left out

These were listed as superbot strengths, but personal-bots already has them:

- Memory as plain files the bot edits itself (`MEMORY.md`, `USER.md`).
- Bots creating their own routines (`create_routine`, `update_routine`, `delete_routine`, `create_event_routine`).
- Bot-to-bot messaging and group chats (`send_to_bot`, `create_group`, `post_to_group`).
- Model and effort per bot.

Not applicable: superbot ships as one Rust binary. Getting that here would mean rewriting the server, which no requirement above justifies.
