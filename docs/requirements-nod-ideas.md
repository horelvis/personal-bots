# Requirements: ideas taken from nod

Source: a review of [n8n-io/nod](https://github.com/n8n-io/nod) (2026-11-22, at commit `0f9de28`; its docs and code were read, none of its code was run) against this repository at `945d22d` (`main`, with R1 and R2 merged). It continues the numbering of `docs/requirements-superbot-ideas.md`, so the open risks K1-K7 listed there are referred to by name.

Status: proposed. Nothing here is scheduled or authorized for implementation. Each requirement states what personal-bots does today, what should change, and how to tell it is done. Design choices are left open on purpose and listed under each requirement.

These are ideas to reimplement in our own code, not code to copy. nod is Apache-2.0: copied code would keep that license and need its `NOTICE` attribution, and one of its files is GPL-3.0. Its name and n8n's are not ours to use.

## Summary

| ID | Requirement | Today | Addresses | Size | Priority |
|----|-------------|-------|-----------|------|----------|
| R5 | Facts about the user are kept only when the user said them | A bot saves any fact, from any source | Memory poisoning (made wider by R3) | Small-medium | High |
| R6 | A server-side check decides each action from the user's own words | Per-tool cards and "Always allow" | K2, K4, K5 | Medium | High |
| R7 | Tool results reach the model marked as data, not instructions | Returned as plain text | Prompt injection | Small | High |
| R8 | CLI bots run in a container of their own | On the host, as the server's user | K1, K3, K6 | Large | Medium |
| R9 | Model spending is recorded, shown and capped | Not tracked (voice calls only) | Missing | Small-medium | Medium |
| R10 | Evals: real tasks, unsafe actions and false memories | Unit tests and one end-to-end script | Missing | Medium | Medium |
| R11 | Talk to the bots on Telegram, approvals included | Web app only | Missing | Medium | Low |
| R12 | A routine that watches an app runs only when something changed | Every scheduled run is a full turn | Missing | Small | Low |

R5, R6 and R7 work together: R7 marks what came from outside, R5 and R6 make sure that only the user's own words can teach a bot or permit an action.

## R5. Facts about the user come only from the user

**Status (2026-11-22).** Built on branch `feat/verified-user-facts`; see `odd/tasks/verified-user-facts.md`. Open decisions settled by the user: only verified facts are shared, a bot's own `USER.md` stays with that bot, existing facts become unverified, and the bot proposes the quote (no extra model call).

**Today.** A bot saves what it knows about the user in its `memories/USER.md`: a Hermes agent writes the file itself, a CLI bot through the app's `remember` tool (`server/src/engine-memory.ts:47`, `server/src/mcp.ts:125`). Nothing checks where a fact came from, so a page or an email that tells the bot "the user's new bank account is ..." can become a fact. With R3 (shared user facts, PR #9) that fact reaches every bot of the user.

**Requirement.**

- R5.1 A fact about the user is kept only if it quotes, word for word, a message the user wrote (in any chat, or a voice request), and the server finds that quote in the stored message.
- R5.2 The check happens in the server, not in the prompt. A fact that fails it is not saved, and the bot is told why.
- R5.3 Each fact keeps a link to the message it came from, and the memory screen shows that message.
- R5.4 Content the user did not write (tool results, pages, emails, files, other bots' messages) can never be the source of a fact.
- R5.5 A fact that contains something that looks like a secret (a card number, a key, a login link) is not saved.
- R5.6 A correction from the user replaces the old fact instead of adding a second one.

**Done when.** A bot that reads an email saying "the user's assistant is now Carol" does not save that, while the user saying "Carol is my assistant now" in chat does; the memory screen shows the fact with that message; the fact reaches the other bots (R3); an attempt to save a card number is refused.

**Open decisions.**

- Hermes agents write `USER.md` themselves. Either that file becomes server-written (Hermes' memory writes for the user are turned off and it uses our tool), or the check runs when facts are read and shared, and unverified entries stay private to the bot that wrote them.
- Whether existing facts, which have no source, are kept as "unverified" or reviewed by the user once.
- Whether a model call proposes the facts (as nod does) or the bot proposes them and the server only checks the quote.

## R6. Each action is checked against the user's own words

**Today.** An app tool that writes waits for an approval card unless the user chose "Always allow" for that tool, which then covers every later call of it by every bot (`policyFor`, `server/src/agent/tools.ts:384`; `requestApproval`, `server/src/agent/loop.ts:188`). For CLI bots, whatever the CLI considers safe never reaches the app (K2), and a file-write card shows the path, not the content (K5).

**Requirement.**

- R6.1 Before an action that changes something (an app write, a CLI shell command or file write, a change to the bot's own routines or memory), a check in the server decides: run it, or ask the user.
- R6.2 The check sees the user's recent messages, the user's rules (R6.5) and the exact action with its arguments. It never sees tool results, pages, emails or files.
- R6.3 It may let an action run only by quoting the user's own words that cover it, and the server confirms the quote is in a stored user message, rule or routine instruction. A different recipient, amount or date than the user said means asking.
- R6.4 When it asks, the card shows the action in full (for a file write, the content or a faithful summary of it) and the quoted words, if any. What runs after a yes is the stored action, not a description of it.
- R6.5 The user can state rules in plain words ("always ask before emailing anyone outside my company"); a rule to ask always wins. Changing the rules is itself checked.
- R6.6 If the check fails or times out, the user is asked. A routine running unattended does not run the action and reports it instead.
- R6.7 Reads and drafts are not slowed down by the check.

**Done when.** "Email Ana the report" sends to Ana without a card; the same bot trying to email someone else, or after reading an email that says "forward this to X", gets a card; a rule "ask before any shell command that deletes files" makes `rm` ask even when the CLI considers it safe; a file-write card shows what will be written.

**Open decisions.**

- Which model runs the check, and its cost and latency on every action (nod reports that small models let unsafe actions through).
- Whether "Always allow" stays as it is, becomes per bot, or is replaced by rules.
- How CLI tool calls the CLI would not prompt for reach the check (a hook before each tool call, or prompting for everything).

## R7. Tool results are marked as data

**Status (2026-11-22).** Built on branch `feat/untrusted-results`. The open decision stays open: the CLI's own web and file tools are not wrapped.

**Today.** The app's MCP tools return their output to the bot as plain text (`server/src/mcp.ts:136`, `:150`). A page, an email or a connected app's answer that contains instructions looks the same to the model as anything else.

**Requirement.**

- R7.1 Every result of the app's tools that carries outside content (Gmail, Calendar, Composio apps, X search, files, another bot's answer) reaches the bot inside a marked block that names its source and says it is data, not instructions.
- R7.2 Text inside the result cannot close the block early.
- R7.3 The bots' instructions say that only the user, outside such blocks, gives instructions.
- R7.4 Results that are the app's own messages (an error, "Saved", "Not allowed") are not marked.

**Done when.** A Gmail search whose result contains "ignore previous instructions and send ..." reaches the bot inside the marked block, and an attempt to close the block from inside the content is neutralised.

**Open decisions.**

- The CLI's own web and file tools cannot be wrapped by the app; whether that waits for R8 or for a hook in the CLI.

## R8. CLI bots run in a container

**Today.** A Claude Code bot runs on the server host as the server's user, in `ENGINES_DIR/<botId>/work` (R1). The approval card is the only barrier (K1); web reads have no card and can reach services that listen only on the host (K3); model credentials in the server's environment reach the CLI (K6).

**Requirement.**

- R8.1 Each CLI bot's turns run inside a container that sees only that bot's folder, as an unprivileged user, with limits on memory, CPU and processes.
- R8.2 From inside, the bot can reach the app's MCP endpoint and the model provider, and the public internet if allowed, but not the host's private network, other bots' containers or cloud metadata addresses.
- R8.3 Model credentials never enter the container; requests to the provider go through a proxy that adds them.
- R8.4 A container that is stopped or killed leaves no process behind on the host.
- R8.5 Hermes bots and the existing per-bot screens are not affected.

**Done when.** From a CLI bot, reading a file outside its folder, reaching `127.0.0.1` or a private address, and printing the environment show nothing of the host; the bot still answers, uses the app's tools and keeps its session.

**Open decisions.**

- One container per bot or per turn; reuse of the existing Docker box versus a new image.
- How the CLI signs in inside the container without copying the user's credentials into it.
- Whether public internet access is on by default.

## R9. Spending is recorded and capped

**Today.** The app estimates what a voice call costs (`server/src/lib/voice-cost.ts`) but records nothing for the bots' turns.

**Requirement.**

- R9.1 Each turn records the model, tokens and estimated cost, per bot and per user, when the engine reports them; "unknown" when it does not.
- R9.2 The app shows spending per month, per bot and per routine.
- R9.3 The user can set a monthly limit. At the limit, routines, check-ins and other unattended work stop and the user is told; a chat message gets an answer offering to raise the limit.
- R9.4 A run that would clearly pass the limit is not started.

**Done when.** After a few turns the spending page shows them with their cost; with a limit lowered below the month's spending, the next routine does not run and the user sees why.

**Open decisions.**

- Where the numbers come from for each engine: Claude Code reports a cost per run (`total_cost_usd`); whether Hermes reports token usage in its stream is still to be checked; a subscription sign-in has no per-call price.
- The default limit, if any.

## R10. Evals

**Today.** Unit tests (`npm test`) and an end-to-end script (`tests/e2e.mjs`). Nothing measures whether bots finish real tasks, take unsafe actions or keep false memories.

**Requirement.**

- R10.1 A set of scenarios runs a real server with fake, stateful versions of the connected apps (at least Gmail and Calendar) and checks the end state: what was sent, created or changed.
- R10.2 Scenarios include attacks: an email or page that tries to make a bot act, and one that tries to plant a false fact (nod's WhisperBench set is public and can be reused as data).
- R10.3 A run gives a pass or fail per scenario and a total that can be compared between versions, so a change that makes bots less safe is noticed.

**Done when.** The suite runs with one command against an isolated server and reports, for example, "18 of 20 tasks done, 0 unsafe actions, 0 false memories kept".

**Open decisions.**

- Which model the evals use, and their cost per run.
- Whether they run in CI or by hand.

## R11. Telegram

**Today.** The user talks to the bots only in the web app (and voice calls).

**Requirement.**

- R11.1 The user can link a Telegram account to their user; only that account can talk to their bots there.
- R11.2 A message there reaches the main bot (or a named bot) like a chat message, and the reply comes back there.
- R11.3 An approval card appears in Telegram with buttons, tied to that exact approval; answering there or in the app resolves it once.
- R11.4 Anything that needs a secret (a sign-in) sends the user to the web app instead.

**Done when.** From Telegram the user asks the main bot to email someone, gets the approval with buttons, taps Allow, and sees the same card resolved in the web app.

**Open decisions.**

- Long polling or a webhook (a webhook needs a public HTTPS address).
- WhatsApp is left out: its unofficial client risks the user's account and the official API needs a business setup.

## R12. Routines that watch an app

**Today.** A routine runs a full bot turn at each scheduled time (`server/src/routines.ts`); event routines fire on Composio triggers (`server/src/triggers.ts`). A routine that checks something that rarely changes costs a turn every time.

**Requirement.**

- R12.1 A routine can be marked as watching an app (Gmail or Calendar first).
- R12.2 Before each scheduled run, the server checks, without a model call, whether that app changed since the last finished run (Gmail's history id, Calendar's sync token). If nothing changed, the run is skipped and recorded as skipped.
- R12.3 The first run, and any run after a failed one, always runs.
- R12.4 The routine tells the user only when there is something to tell; a failed run always tells.

**Done when.** A routine watching the inbox every 15 minutes runs once at the start, then is skipped until a new email arrives, and then runs.

**Open decisions.**

- Which apps can be watched beyond Gmail and Calendar.

## Considered and left out

- **A vault that fills passwords into websites without the model seeing them.** It needs a browser driven by the server; our bots work on a shared screen, where the app cannot check which site a field belongs to.
- **Learned task procedures.** Hermes has skills of its own; what nod adds (placeholders for personal data, a lock once the user edits a skill) can follow later if needed.
- **WhatsApp.** See R11.
