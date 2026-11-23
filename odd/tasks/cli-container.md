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
