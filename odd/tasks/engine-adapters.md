# engine-adapters

Objective: let a bot run on the Claude Code CLI as well as on Hermes, with the app's tools and approval cards working the same (R1 of `docs/requirements-superbot-ideas.md`).
Branch: `feat/engine-adapters` (from `636cb9d`). Delivery: `ask-on-risk`, to the fork (`origin`) only. Test runner: `npm test` (server, `tsx --test`); `npm run typecheck`.
Forecast: about 700 authored lines, over the 400-line slice size; slices follow the tasks below.

## Specs

- S1. User (verbatim): "empezar con R1 usando odd". R1 as written in `docs/requirements-superbot-ideas.md`: "Run a bot on a coding-agent CLI (Claude Code, Codex, Pi) as well as Hermes".
- S2. (R1.1) A bot has an engine type. Hermes stays the default, and existing bots keep working with no migration step by the user.
- S3. (R1.2) Claude Code is the CLI engine supported now. Codex and Pi are not installed on this machine and are not built here; the adapter boundary must let them be added as one file each.
- S4. (R1.3) An adapter does only four things: start or resume the bot's session, send a turn in, map the CLI's output to the events the loop already handles (text delta, text, tool call, error), and pass in the bot's persona and memory.
- S5. (R1.4) A CLI engine uses the CLI already installed and signed in on the machine that runs the bot. The app stores no credentials for it.
- S6. (R1.5) The user picks the engine when creating a bot and can see which engine a bot uses. Only engines whose CLI is installed are offered.
- S7. (R1.6) The app's own tools (routines, tasks, bot messaging, Gmail, Calendar, connected apps) reach a CLI-engine bot, and tools that write still wait for the user's approval card.
- S8. (R1.7, decided by the user) Question asked: "¿cómo se controlan las herramientas propias del CLI (shell, editar archivos, web) cuando un bot las usa?" User chose (verbatim option): "Tarjetas de aprobación (Recommended)" - "Leer y buscar archivos y web va sin preguntar. Ejecutar comandos de shell o escribir/editar archivos espera tu OK en la misma tarjeta (Allow / Always allow / Don't allow) que ya usan Gmail y Composio."
- S9. Done when (from R1): "A bot created on Claude Code answers in chat with streaming text, shows its tool activity, keeps its session between turns, can call `create_routine` and `gmail_send`, and `gmail_send` stops at an approval card. A Hermes bot created before the change behaves as before."
- Assumption: the CLI runs on the server host, in a folder of the bot's own under `ENGINES_DIR/<botId>/work` (the only place `claude` is installed and signed in).
- Assumption: a Claude Code bot has no screen of its own in this version; it does not drive the desktop the app shows. The app does not start a screen for it.
- Assumption: the child process gets a minimal environment (no app secrets) and loads none of the host user's Claude settings, hooks, plugins, memory files or MCP servers.
- Assumption: what the CLI itself treats as safe (reading inside the bot's folder, read-only shell commands such as `ls`) runs without a card; anything the CLI would prompt for (writes, other shell commands, reads outside the folder) gets a card. Web search and fetch run without a card.
- Assumption: "Always allow" on a card applies per CLI tool (all shell commands, or all file writes) for that user, the same grain as today's per-tool policy.
- Assumption: memory for a Claude Code bot uses the same `memories/MEMORY.md` and `memories/USER.md` files and "§" format under its own home, written through an app tool, so the memory screen works unchanged.

## Tasks

- [x] T1 (S2,S3,S4,S5) inline: engine type `claude`, the adapter (command line, stream parsing, session), and the loop running a turn through it. Commits: `d037e1e` (adapter, runner, permission rules, tests), `47dcfc4` (engine type, session, loop, prompt, routes).
- [x] T2 (S7,S8) inline: MCP for a CLI bot: permission prompt wired to approval cards, memory tool, tool naming and activity labels. Commit: `f429e1c`. Risk: item 2 (security: permission guard).
- [x] T3 (S6) inline: pick the engine when creating a bot; show it in the details panel; offer only installed CLIs. Commit: `842e7e3`.
- [x] T4 (S1,S9) inline: docs (`docs/ARCHITECTURE.md`, `.env.example`) and end-to-end check against the real CLI (L7). Commit: the one that adds this document.
- [x] T5 (S8) inline: correction after independent verification (B1-B3 in L10). Commit: the one that adds this line. Risk: item 2.

Route: inline for all tasks (no Writer trigger: T2 and T3 depend on T1; one seam, `runTurn`).

## Log

- L1 (2026-11-16) User: "empezar con R1 usando odd".
- L2 (2026-11-16) Decision asked and answered: built-in CLI tools go through approval cards (see S8).
- L3 (2026-11-16) Evidence, probes against Claude Code 2.1.325 with a throwaway MCP server (scratch dir, not committed):
  - `claude -p --output-format stream-json --verbose --include-partial-messages` emits `system/init` (session id, tools), `stream_event` (`content_block_delta` with `text_delta`), `assistant` (full `tool_use` blocks with input), `user` (`tool_result` by `tool_use_id`, `is_error`), `result` (`subtype`, `is_error`, `result`).
  - `--mcp-config` with `{"type":"http","url",...,"headers":{"Authorization":"Bearer ..."}}` connects; tools appear as `mcp__hq__<name>`. The CLI first calls `server/discover` and falls back to `initialize` (protocol `2025-11-25`).
  - `--permission-prompt-tool mcp__hq__<tool>` is called with `{tool_name, input, tool_use_id}` and expects text JSON `{"behavior":"allow","updatedInput":input}` or `{"behavior":"deny","message":...}`. A deny reaches the model as an error tool result and the turn continues.
  - Prompted: `touch x`, `cat a > b`, `env | grep`, Write, Read and `cat` outside the cwd, and MCP tools not in `--allowedTools`. Not prompted: `echo`, Read inside the cwd.
  - `--session-id <uuid>` then `--resume <uuid>` keeps the conversation. `--setting-sources ""` and `--strict-mcp-config` work. `env -i PATH HOME USER` still authenticates (subscription sign-in).
  - stdin must be closed (`< /dev/null`), or the CLI waits 3 s for input.
- L4 (2026-11-16) Evidence: the only engine seam is `engineFor()` at `server/src/agent/loop.ts:355`; `bots.engine` already exists ('primary' | 'managed'); `mcpToken(botId)` and `/mcp/<botId>` work for any bot row; `engineHome()` returns null for unknown kinds, which empties the memory screen.
- L5 (2026-11-16) State: working tree carried the uncommitted project rename (`personal-bots`) from `main`; it is not part of this feature and is left unstaged.
- L6 (2026-11-16) RED/GREEN: `claude.test.ts` failed first (module missing), then passed; `tools.test.ts` (permission rules) failed first, then passed. `run.test.ts` was written together with `run.ts` (no RED observed). Suite after the change: 86 tests, 85 pass, 0 fail, 1 skipped. `npm run typecheck` (server and web) and `npm run build -w web` pass.
- L7 (2026-11-16) End-to-end, isolated server (`mktemp -d` database and engines dir, port 8799, no `.env`) against the real Claude Code CLI, model `haiku`:
  - A bot created with `engine: "claude"` answered with streaming text; `codex` was refused with "That engine is not installed on this machine."
  - `create_routine` ran and the routine was listed. `touch made.txt` showed the card "Allow Cody to run a command?" with the command; Allow created the file. `ls` ran without a card.
  - Second turn: the bot recalled the code word from the first turn (session resumed); `touch denied.txt` was denied on the card, the file was not created, the tool row shows "denied".
  - `remember` saved "Tester's time zone is Europe/Madrid." and the memory screen's API listed it; a fourth turn answered the time zone from memory.
  - Write asked with "Allow Cody to write a file?"; "Always allow" stored policy `cli_write` and the next Write ran without a card.
  - Deleting the bot removed its home. Browser check: the create dialog shows the Engine choice (Hermes / Claude Code) and a Claude Code bot's engine panel shows Model and "Claude Code · ready".
  - Not checked end to end: `gmail_send` stopping at an approval card for a CLI bot (needs a connected Google account; the path is the unchanged `callTool` code shared with Hermes), and an approval that waits longer than a few seconds (`MCP_TOOL_TIMEOUT` is set to 30 minutes but its effect was not measured).
- L8 (2026-11-16) Review (RDD on by default): `gentle-ai review assess --base-ref 636cb9d --committed-only` could not assess while the tree had untracked files; per-commit assessment was not run before the next commits were added. Deviation recorded; the branch is assessed at the end.
- L9 (2026-11-16) Hermes path: `runTurn` returns early for a CLI bot and is otherwise unchanged; `instructionsFor` keeps the Hermes text through the else branch of two conditionals (read in the diff, not compared by running both versions). No Hermes gateway was available on this machine to run a Hermes turn.
- L10 (2026-11-16) Independent verification (in-repo clone, 4 real CLI turns). S2-S7 pass; S9 pass except `gmail_send` (not run); S8 failed with three blockers:
  - B1: the MCP bearer token was in argv (`--mcp-config` JSON); `ps auxww` runs without a card and showed a live token of any bot mid-turn.
  - B2: with the work folder inside the app repository, read-only git (`git show HEAD:file`, `git log --format=%ae`, `git ls-files --others`) read the repository without a card.
  - B3: the card showed only the first 1200 characters of a command; a tail such as `; rm -rf ~/important` was approved unseen.
  - Held (carded and denied, no side effects): reads outside the folder by Read/Grep/Glob/cat/symlink/`cd ..`/`$(...)`; `find -exec`, redirects, `sed -i`, `git branch`/`tag`, `python3 -c`; `printenv`, `ps eww`; repo `CLAUDE.md` and `.claude/settings.json` ignored; permission endpoint denies on missing tool name, a Hermes bot, another bot's token, interrupt.
  - Hermes: `instructionsFor` hashes identically on `636cb9d` and HEAD for a primary and a managed bot.
  - Advisories, not changed: WebFetch runs without a card (documented assumption; it can reach local services and carry out what the bot may read); "Always allow" on one outside read allows every outside read (documented grain); model credentials set in the server's environment reach the child; an unknown tool name from a Hermes bot opens a card (existing Composio path).
- L11 (2026-11-16) Correction batch for B1-B3, RED then GREEN (6 failing tests first; suite now 90 tests, 89 pass, 0 fail, 1 skipped):
  - B1: prompt on stdin; persona and MCP config in `<home>/system.md` and `<home>/mcp.json` (mode 600, home 700, outside the work folder); nothing private in argv. Probe: `cat ../mcp.json` is carded.
  - B2: `GIT_CEILING_DIRECTORIES=<home>`. Probe in an in-repo folder: `git status` and `git log` answer "not a git repository"; `git -C <repo>` and `git --git-dir=` are carded.
  - B3: a command or path over 2000 characters is refused without a card; shorter ones are shown whole.
  - Advisory taken: the bot home is now mode 700.
- L12 (2026-11-16) Recheck by the same verifier, limited to B1-B3, at `4bcceaa` (in-repo clone, 2 real CLI turns): all three fixed.
  - B1: the running `claude` process shows only file paths; `ps auxww` has no token; Read and `cat` of `<home>/mcp.json` and `<home>/system.md` are carded; home is 700, both files 600. The `ps | grep Bearer` line was run from the host, not by the bot (the model declined to run it).
  - B2: the six git commands answer "fatal: not a git repository" from the in-repo work folder.
  - B3: a 2126-character command is refused without a card; the original 1326-character reproduction now gets a card showing the whole command, tail included; a short command gets a full card; a denied `touch` leaves no file.
  - Still unverified: `gmail_send` (or any write-tool card) for a CLI bot, a real Hermes turn after the change, approvals that wait minutes, a `blocked` policy (code reading only).
- L13 (2026-11-16) Scratch removed by the parent: the verifier's `/tmp/verify-engine.wSOYz3` and a Hermes gateway its test server had started for a scratch bot (confirmed by its HERMES_HOME before stopping it).
- L14 (2026-11-16) Native review (RDD), consent asked and granted by the user ("Revisar este cambio"). Candidate: the committed branch from `636cb9d` (24 files; whole branch, not per-commit slices, see L8). Lenses: risk, resilience, reliability. Outcome: approved, acknowledged (lineage `review-47846af62893bbed`). No blocker and no correction. Non-blocking findings, left as later work:
  - Risk: WebFetch/WebSearch without a card (egress and loopback reach); model credentials in the child's environment; an approved shell command runs as the server's user on the host; a Write card shows the path, not the content.
  - Reliability: the CLI turn mapping in `loop.ts` and the permission wiring in `mcp.ts` have no automated test (only the pure rules and the adapter do); model and effort values are passed to the CLI unvalidated; a bot row can be left behind if assigning a CLI engine fails after the insert.
  - Resilience: `cliVersion` runs a synchronous `--version` (up to 8 s) on the server's thread; a turn ends only when the CLI's stdout closes; the session id is saved before the CLI has stored the conversation; memory files grow without a bound and are not written atomically.
