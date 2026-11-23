# CLI bots run in a container (R8)

Objective: run each Claude Code bot turn in a container that sees only its folder, with network limits, and keep model credentials on the host. Branch `feat/cli-container`; delivery: work-unit commits, pushed to `main` when the user says so. Test runner: `cd server && npm test` (node:test via tsx); container checks need Docker (colima on the dev machine).

## Specs

- S1 (R8.1) "Each CLI bot's turns run inside a container that sees only that bot's folder, as an unprivileged user, with limits on memory, CPU and processes."
- S2 (R8.2) "From inside, the bot can reach the app's MCP endpoint and the model provider, and the public internet if allowed, but not the host's private network, other bots' containers or cloud metadata addresses." Decision (L3): public internet is on by default.
- S3 (R8.3) "Model credentials never enter the container; requests to the provider go through a proxy that adds them." Decision (L2): the proxy uses the user's subscription token (`claude setup-token`), held by the server.
- S4 (R8.4) "A container that is stopped or killed leaves no process behind on the host."
- S5 (R8.5) "Hermes bots and the existing per-bot screens are not affected."
- S6 Done when: "From a CLI bot, reading a file outside its folder, reaching `127.0.0.1` or a private address, and printing the environment show nothing of the host; the bot still answers, uses the app's tools and keeps its session."
- S7 (assumption, design) The container is used only when the server is set to (`CLI_SANDBOX=docker`); then a CLI turn never falls back to the host. Unset keeps today's behaviour. One container per turn; one internal network per bot whose only other member is a gate container that relays to the app and to the public internet and refuses private, loopback, link-local and metadata addresses. The gate holds no secrets.

## Tasks

- T1 [S1, S2, S4, S5] Image and gate: `server/box/cli/` (Dockerfile with Claude Code, unprivileged user; gate script: relay to the app's port, HTTP/CONNECT proxy that refuses non-public addresses) with tests of the address filter. Route: delegated (parallel with T2, disjoint files). Status: open.
- T2 [S3] Model proxy route on the server: `/cli-model/<botId>/...` checks the bot's placeholder token and forwards to the provider with the real token; only the provider paths Claude Code uses. Route: inline. Status: open.
- T3 [S1, S4, S7] Sandbox runner: per-bot network, gate, `docker run --rm` per turn with mounts, limits and container paths; kill on abort; stale containers removed at start; engine detection. Route: inline. Status: open.
- T4 [S6] End-to-end in Docker: the done-when probes; docs (`docs/ARCHITECTURE.md`, `.env.example`, README, requirements status). Route: inline. Status: open.

## Log

- L1 (2026-11-23) User: "sigue con R8".
- L2 (2026-11-23) Decision: "Token de suscripción (Recommended)". Evidence: with `ANTHROPIC_BASE_URL` set to a local proxy and `CLAUDE_CODE_OAUTH_TOKEN` set to a placeholder, Claude Code 2.1.325 sent `POST /v1/messages?beta=true` with `Authorization: Bearer <placeholder>` and `anthropic-beta` including `oauth-2025-04-20`, plus `HEAD /api/hello`; so a proxy that swaps the token works.
- L3 (2026-11-23) Decision: "Sí, por defecto (Recommended)" (public internet on by default).
- L4 (2026-11-23) Map: the CLI is spawned in `server/src/agent/cli/run.ts:25` with the adapter's args (`claude.ts:29-61`), MCP URL `${env.mcpBaseUrl}/mcp/<botId>` (`loop.ts:497`, default `http://127.0.0.1:$PORT`); abort signals only the direct child (`run.ts:37-41`); Claude Code uses the server user's `~/.claude` (no `CLAUDE_CONFIG_DIR`); the screens' box image (`server/box/docker`) has no Node and runs as root; the server listens on all interfaces (`index.ts:48`).
- L5 (2026-11-23) T1 (delegated writer): `server/box/cli/Dockerfile` (node:22-bookworm-slim, Claude Code 2.1.325, user `bot` uid 10001), `gate.mjs` (app relay for `/mcp/` and `/cli-model/` only; HTTP/CONNECT proxy that refuses non-public addresses and connects to the checked address), `server/src/box-cli-gate.test.ts`. RED (module missing), then GREEN 4/4; the image built, `claude --version` gave 2.1.325, `id` gave uid 10001. Commit 2b9c9f7.
- L6 (2026-11-23) T2 inline: `lib/model-proxy.ts` (placeholder token per bot, allowed paths, real token added, credentials and cookies dropped, streaming), route `cli-model.ts`, `env.ts` (`CLI_SANDBOX`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLI_MODEL_UPSTREAM`). RED, then GREEN 4/4. Commit 5ce6155.
- L7 (2026-11-23) T3 inline: `sandbox-plan.ts` (pure `docker run` plan), `sandbox.ts` (image, networks, gate, runner, version, stale-turn cleanup, network removal with the bot), a runner hook in `runCli`; `loop.ts`, `engine.ts`, `index.ts` wired. RED, then GREEN. Suite: 208 tests, 208 pass; typecheck passes. Commit c3d0430.
- L8 (2026-11-23) T4 end-to-end, isolated server (`CLI_SANDBOX=docker`, a stand-in provider on the host as `CLI_MODEL_UPSTREAM`, real Claude Code in the container, colima):
  - The first try failed with "Append system prompt file not found: /hq/system.md": the bot folders were in `/var/folders`, which colima does not share with its VM. With `ENGINES_DIR` inside the home folder it worked; documented.
  - The bot answered, the shell command card appeared and was approved, and the second turn resumed the session (it saw the earlier messages).
  - From inside: `id` gave the host user's uid 501. `/etc/passwd` was the image's own. `/` had no host folders (`/Users` was missing). `/hq` held only the bot's home. The environment had the placeholder setup (`ANTHROPIC_BASE_URL` via the gate, proxy variables) and no real token or host variable.
  - Direct connections to `127.0.0.1:8799`, `host.docker.internal`, `169.254.169.254`, `192.168.5.2`, `10.0.0.1` and even `1.1.1.1` were refused.
  - Through the proxy: `host.docker.internal`, `127.0.0.1`, `169.254.169.254`, `192.168.5.2` and the gate itself got 403; `example.com:443` got 200; `git ls-remote https://github.com/git/git` worked.
  - Through the relay: `/api/health` and `/api/auth/dev` got 403; `/mcp/...` reached the app.
  - The stand-in provider received only `Authorization: Bearer <real token>`.
  - S4: during a long command its container was running; after interrupting the turn it was gone. After a SIGKILL of the server the container stayed; after the restart it was removed and the chat said the turn was interrupted and not run again.
  - Not checked: a real answer with a real subscription token (needs `claude setup-token`); WebFetch through the proxy (git was); the server running as root (the chown path); a Linux host; Hermes bots and screens beyond the unchanged suite.
