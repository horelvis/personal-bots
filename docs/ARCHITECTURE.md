# Architecture

A web app (`web/`) and a Node server (`server/`) sit in front of Hermes agents. Hermes owns each Bot's agent loop, history, memory and model. The server adds the things Hermes does not have: the chat interface, one screen per Bot on a shared Orgo computer, connected apps with approvals, routines, the Library, and voice.

```text
browser ── HTTP + SSE ──► server ── POST /v1/responses ──► Hermes gateway (one per Bot)
   │                        ▲                                   │
   └── WebSocket (VNC) ─────┤◄──────── MCP: POST /mcp/<bot> ────┘
                            └── Orgo computer: one X screen per Bot
```

## Components

| Piece | Where | What it does |
|---|---|---|
| API + realtime | `server/src/routes*.ts`, `lib/hub.ts` | JSON over HTTP, plus one Server-Sent Events stream per user (`GET /api/events`) carrying row updates, live state, roster changes and computer state |
| Turns | `server/src/agent/loop.ts` | Per-Bot serial queue. A turn posts the message to the Bot's Hermes gateway (`/v1/responses`, streaming) and turns the event stream into rows (messages, tool calls) and live state (what the Bot is doing now). Before each turn it makes sure the Bot's screen is ready. A Bot on a CLI engine gets the same turn from a child process (see CLI engines). Every queued turn is also a row in `turn_queue`: `queued` while it waits, `running` from the moment its run starts, removed when it ends. When the server starts, what is left there was cut off by a stop: a `running` turn is closed in its chat ("Interrupted", open tool calls marked so) and never run again, since what it was doing may already have happened; `queued` turns run in their order (`agent/queue-recovery.ts`), after a single wait per Bot of up to two minutes for its engine when that is the primary Hermes gateway, which may still be coming up (the Bot is shown as waiting meanwhile). The writes are guarded (`agent/turn-store.ts`): a turn whose start cannot be recorded is forgotten before it runs, so a stop can lose it but never repeat it; if it can be neither recorded nor forgotten it is tried again in its place for about two minutes, and then left queued for the next start, with a notice that it need not be sent again; an interrupted turn is forgotten in the same transaction that closes its chat, or kept for the next start. Recovery runs only in a process that got the port, and a failure there does not stop the schedulers. A server started with `GROKBOT_NO_SCHEDULER=1` leaves them alone |
| Engines | `server/src/engine.ts` | Which Hermes runs which Bot. The **primary** engine is the gateway that already runs on the computer; the app only calls its API. A **managed** engine is a Hermes home under `ENGINES_DIR/<botId>` with its own `hermes gateway run`, its own port (from 8650), credentials, model and browser helper (`BH_HOME`). Also: model and provider settings, and opening Hermes' subscription sign-in in a terminal on the Bot's screen |
| App tools | `server/src/mcp.ts`, `agent/tools.ts` | An MCP endpoint per Bot (`POST /mcp/<botId>`, `POST /mcp/primary`; bearer token derived from `SESSION_SECRET`). Tools: `x_search`, `save_file`, routines, tasks, check-ins, `send_to_bot`, group chats, `ask_user`, `request_app_connection`, plus the user's Composio tools |
| Memory | `server/src/engine-memory.ts` | Memory lives in each Bot's home (`memories/MEMORY.md`, `USER.md`), private to that Bot. Facts about the user that the whole team shares are **verified**: a Bot saves one with the `remember_about_user` tool, giving the fact and the user's exact words; the server keeps it only if those words are in a message the user wrote (typed or spoken, in any of their chats, never another Bot's or a routine's message) and it holds no secret (`lib/fact-check.ts`, table `user_facts` in `lib/verified-facts.ts`). A correction names the fact it replaces. Verified facts reach every Bot of that user (Hermes: the ones not in its own file are added to its instructions; CLI Bots: in their memory section) and the memory screen shows the message each came from. What a Bot writes in its own `USER.md` is marked "Only <Bot>" and not shared. Removing a fact about the user removes it from the verified facts and from every Bot's file |
| Screens | `server/src/computer.ts`, `desk.ts`, `box.ts`, `server/box/*` | One Orgo Linux computer; the primary Bot uses the default screen, every other Bot leases an Orgo screen (four per computer). `desk.ts` installs the scripts in `server/box/` under `/opt/hq` and calls them to dress a screen: wallpaper, dock, light theme, a Chrome with its own profile and DevTools port (9200 + display number), and a home screen as the new tab page. `box.ts` runs commands locally (`HQ_LOCAL=1`), in the local container (`HQ_BOX=docker`), or through Orgo's API |
| Local box | `server/src/dockerbox.ts`, `server/box/docker/*` | With `HQ_BOX=docker`, one Linux container on the server's machine stands in for the Orgo computer: `hq-display` starts an X server, window manager, VNC server and DevTools forwarder per screen. The server builds the image, starts the container, and reaches it with `docker exec` and two published port ranges on `127.0.0.1` (VNC 59000+display, DevTools 9200+display). The VNC password goes in over stdin after start, and the container has its own network |
| Viewer | `server/src/vnc.ts` | WebSocket relay between the browser (noVNC) and the screen's VNC server (Orgo's websockify, or a TCP socket to the local container). The server does the VNC auth, so the computer's password never reaches the browser. In *watch* mode, keyboard, pointer and clipboard messages are dropped on the server |
| Apps | `server/src/composio.ts`, `triggers.ts` | Optional (`COMPOSIO_API_KEY`). Catalog, per-user sessions, connect links, tool execution, and triggers for event routines. Without a key these are off and the rest of the app works |
| Sign-in | `server/src/oauth/providers.ts`, `routes.ts` | OAuth with the operator's own client: one generic flow (`/api/auth/<provider>/start` and `/callback`, state kept in a cookie) over a registry of providers, each with its sign-in scopes and its services. Google is defined; without a Google client the older Composio-managed Gmail sign-in is used |
| Provider services | `server/src/oauth/connections.ts`, `server/src/google/*`, `agent/google-tools.ts` | A person's connection to a provider's services (Gmail, Google Calendar): the same OAuth flow with the service's scopes, tokens sealed with a key derived from `SESSION_SECRET` (`lib/secretbox.ts`) and renewed on use. The tools built on them are served to the bots over MCP like the app's other tools; those that send or change something carry `approval` and wait for the user's card |
| Scheduling | `server/src/routines.ts`, `proactive.ts` | Cron routines, event routines, and check-ins for the primary Bot. Each run is a turn |
| Voice | `server/src/voice.ts`, `web/src/voice/*` | Mints short-lived xAI realtime client secrets; the browser connects to xAI directly. The voice agent hands real work to the Bot's turn queue and speaks the result. Also proxies TTS previews and dictation |
| UI | `web/src` | React + zustand. Sidebar, chat with a "thinking" chip that follows the Bot's activity, details panel (screen preview, activity, tasks, Library, engine), settings, viewer, voice call bar |

## The primary engine

The first Bot is bound to a Hermes gateway the app did not start. The rules:

- The app never restarts it, stops it, or writes its `config.yaml`. Giving it the app's tools is a separate, explicit step (`scripts/add-hq-to-hermes.py`), which adds one `mcp_servers.hq` entry and keeps a copy of the file. Hermes loads the change without a restart.
- If that agent already has its own Chrome (`PRIMARY_CDP_URL`), the app never starts, stops or reconfigures it. The home screen still arrives there, through a Chrome policy that installs the home-screen extension.
- Its other sessions (iMessage, Telegram, cron) see the same tools. When one of those sessions calls a tool that needs approval, the card shows up in the app.

## Screens and browsers

Each managed Bot's Chrome is started by the app on that Bot's screen and its Hermes config points at that Chrome's DevTools port, so browsing is visible in the viewer. Two details matter:

- Hermes' browser tool finds its helper process under `BH_HOME`. Every managed gateway gets its own, otherwise all agents on the computer would drive one browser.
- A screen is dressed before the Bot's first turn (`screenForWork`), so the agent never finds an empty screen and starts a stray browser.

Hermes can also run a private "Bot Desktop" for an agent. While it is on, that agent's desktop work happens there and not on the screen the app shows; the engine panel reports this and offers a button to switch it off.

## Transcript model

A conversation is an append-mostly list of **rows**: `seq` (position), `updatedSeq` (a per-Bot revision counter), `kind` and a JSON `body`. A streaming reply is the same row rewritten with a higher `updatedSeq`, so clients upsert by `seq`. A per-Bot `generation` counter starts a new conversation (and a new Hermes session).

Row kinds: `message` (user or assistant, optionally from another Bot or a voice call), `tool-call` (shown as an activity line and a collapsible step list), `card` (approval, question, connect, draft), `event`, `notice`.

The model's own history is Hermes' business; the app keeps only what it shows.

## CLI engines

A Bot can run on a coding-agent CLI instead of Hermes. Claude Code is supported; the user picks the engine when creating the Bot, and only engines whose command is installed on the server are offered. `bots.engine` holds the adapter id (`claude`); `primary` and `managed` are the Hermes kinds.

- **Adapter** (`server/src/agent/cli/`): one file per CLI. It builds the command for a turn and maps the CLI's JSON lines to the loop's events (session, text delta, text, tool call, tool result, error). `run.ts` starts the process and stops it when the turn is interrupted. To add a CLI, write one adapter and list it in `index.ts`.
- **A turn** is one process: `claude -p --output-format stream-json`. The first turn of a chat starts a session with an id the app chooses; later turns resume it. "New chat" starts a new session. Nothing runs between turns.
- **Where it runs**: on the server host, in `ENGINES_DIR/<botId>/work`, unless the server is set to run it in a container (below). The CLI is the one installed and signed in there; the app stores no credentials for it. The process gets a minimal environment (no app secrets) and none of the host user's Claude settings, hooks, plugins, memory files or MCP servers. Nothing private is on its command line, which any process on the machine can read: the prompt goes in through stdin, and the persona and the token for the app's tools are files in the Bot's home (mode 600, home 700), outside the work folder. `GIT_CEILING_DIRECTORIES` stops git at the Bot's home, so read-only git commands cannot read the repository the folder may sit in.
- **In a container** (`CLI_SANDBOX=docker`, R8): each turn is a fresh `docker run --rm` of the image in `server/box/cli` (Claude Code, pinned by `CLAUDE_CODE_VERSION`), built on first use. Then a turn never falls back to the host.
  - It runs as the server's user (as the image's unprivileged user 10001 when the server runs as root), with no capabilities, `no-new-privileges`, 2 GB of memory, 2 CPUs and 512 processes.
  - It sees only the Bot's home at `/hq`: read-only, except `work` (its folder) and `claude` (the CLI's own files and sessions, so resuming works).
  - Its only network is the Bot's own internal one (`hq-cli-net-<botId>`). The only other member is the gate (`hq-cli-gate`, the same image running `gate.mjs`, with no secrets). The gate relays two paths to the app, `/mcp/...` and `/cli-model/...`, and nothing else. It is also an HTTP/CONNECT proxy to the public internet that refuses loopback, private, link-local, CGNAT and metadata addresses after resolving the name, then connects to the address it checked. Bots cannot reach each other: each one shares a network only with the gate.
  - No model credential enters. The container gets a placeholder token per Bot. The model proxy (`/cli-model/<botId>`, `server/src/lib/model-proxy.ts`) checks it and sends the request to the provider with the user's subscription token (`CLAUDE_CODE_OAUTH_TOKEN`, made with `claude setup-token`), which stays on the host. Only the provider paths Claude Code uses are passed on.
  - Interrupting a turn removes its container, so nothing it started lives on. On start, the server removes turn containers left by a crash.
  - Programs that ignore the proxy settings have no internet at all.
  - On macOS (Colima, Docker Desktop), `ENGINES_DIR` must be inside a folder shared with the Docker VM (the home folder by default), or the container sees an empty `/hq`.
- **Tools**: the app's MCP endpoint is the only MCP server the CLI gets, so routines, tasks, Bot messaging, Gmail, Calendar and connected apps work as for Hermes, with the same approval cards.
- **Permissions**: the CLI never runs with its permission prompts switched off. Whatever it would ask a person (a shell command that changes something, writing or editing a file, reading outside the Bot's folder) it asks the app through the `permission_prompt` tool, which shows an approval card. "Always allow" is stored per CLI tool (`cli_bash`, `cli_write`, `cli_edit`, `cli_read`), so allowing shell commands once and for all allows every shell command. What the CLI itself treats as safe (reading inside the Bot's folder, read-only commands such as `ls`) and web search and fetch run without a card. A command or path longer than 2000 characters is refused without a card, because the card could not show all of it. If the check fails for any reason, the action is refused.
- **Persona and memory**: both are sent on every turn. Memory uses the same `memories/MEMORY.md` and `USER.md` files under the Bot's home, written through the `remember` tool, so the memory screen works unchanged.
- **Not there yet**: a CLI Bot has no screen or browser of its own, and Codex and Pi have no adapter.

## Outside content is data

Results of the app's tools that carry content someone else wrote (Gmail searches and reads, Calendar events, X posts, every Composio app's answer, another Bot's reply to `ask_bot`) reach the Bot inside an `<untrusted_tool_result source="...">` block that says it is data, not instructions (`server/src/lib/untrusted.ts`). Text inside cannot close the block early. A tool marks its result with `untrusted` (the source's name); the app's own messages ("Saved", errors, "Not allowed") stay plain. The Bots' instructions say that only the user, outside such blocks, tells them what to do. Not covered: the CLI's own web and file tools, whose results the app never sees.

## The action check

Before an action that changes something, a check in the server decides from the user's own words whether it runs or the user is asked (`server/src/lib/trust-check.ts`, wired in `server/src/trust.ts` and `server/src/mcp.ts`). It sits in front of every approval card: app tools that write (Gmail, Calendar), Composio writes, changes to a Bot's routines and check-ins, and every shell command and file read or write of a CLI Bot (Claude Code is started with a settings rule that sends all of them to the app, not only what it deems risky).

- The check is one call to a model (the app's xAI model; `TRUST_MODEL` and `TRUST_MODEL_URL` can point it at another OpenAI-compatible API). It sees the user's messages of the last day in any of their chats, the user's rules, for a routine's turn that routine's instruction, and the exact action with its arguments. It never sees tool results, pages, emails or files.
- The model may let an action run only by quoting the user's words; the server runs it only if that quote is really in the message, rule or routine instruction it names. A read runs without a quote; something that changes anything never counts as a read.
- Otherwise the user gets the approval card, with the reason. If the check fails or takes more than 15 seconds, the user is asked. In a routine's turn, which nobody watches, the action is not done and the chat gets a notice instead.
- The user's rules are free text in Settings → Permissions; only the user edits them. A rule to ask always wins.
- Shell commands and reads are never allowed for good: their cards have no "Always allow", and a saved "always" for them no longer applies. A file-write card shows what will be written.

## Approvals

Approvals happen inside the MCP call, so they work the same for every engine:

- Composio tools that only read run at once.
- Anything else posts an **approval card** and the tool call waits. **Allow** runs it once, **Always allow** stores a per-tool policy, **Don't allow** returns a refusal that tells the agent not to retry.
- A new user message, or no answer in time, closes the card and the call returns "skipped".

Not covered for Hermes Bots: what a Bot does through its browser or shell, and Hermes' own prompts for risky commands. A Bot on a CLI engine is covered there too: its shell commands and file writes get the same card (see CLI engines).

## Bots working together

- **`send_to_bot`** delivers a message to another Bot's queue; the reply comes back the same way.
- **`ask_bot`** puts a question in another Bot's chat and holds the tool call until that Bot's turn ends; what the Bot wrote in that turn is the tool's result, so the asker can use it in the same reply. The asked Bot answers in its own chat, in a turn queued like any other. After `ASK_BOT_WAIT_SECONDS` (9 minutes by default) the call returns "still working" and the answer arrives later as a message, as with `send_to_bot`; the same happens when the asker's turn ends first. If the asked Bot then finishes without saying anything, the asker gets a notice that no answer will come. The limit is capped at 25 minutes, under the engines' 30-minute tool-call limit. A question that would close a circle (A waits for B, B asks A) is refused at once. Who waits for whom is kept in memory (`server/src/agent/asks.ts`): after a restart nobody is waiting, and an answer to a question from before it is not delivered.
- **Group chats** are a Bot row with `kind='room'` and a member list. A user message goes to the @mentioned members, or to all of them (up to 3).
- For work inside one task, Hermes' own delegation is used.

## Data

SQLite (`DB_PATH`, WAL): users and sessions, Bots, rows, approvals and policies, routines, tasks, skills, screen leases, Composio session ids. Each managed Bot's Hermes home is under `ENGINES_DIR`. On the computer: Chrome profiles in `/root/grokbot/profiles/<botId>`, Library files in `/root/grokbot/files/<botId>`. Deleting a Bot removes its gateway, home, profile, files and screen.

Secrets live in `.env` on the server and in each Hermes home.

## External services

| Service | Used for |
|---|---|
| Hermes Agent | The agent loop, tools, memory and model access for every Bot (API keys or subscription sign-ins) |
| Orgo | The computer, its screens, VNC, and a public URL for the app |
| Composio | Optional: connectors, triggers, and sign-in when no OAuth client is configured |
| Google (OAuth) | Optional: sign-in with your own OAuth client |
| xAI | Research on X (`x_search`), realtime voice, TTS, dictation |
