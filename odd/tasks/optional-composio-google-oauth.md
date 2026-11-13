# optional-composio-google-oauth

Objective: let the app run without Composio, and sign in with Google through the user's own OAuth client.
Branch: `main` (the user asked for direct commits: "si, hazlo y sube a main"). Delivery: `single-pr`-sized, pushed to `origin` (the fork). Test runner: `npm test`.

## Specs

- S1. User (verbatim): "soy un desarrollador con experiencia el uso de composio vale para personas que no saben crear proyectos en google". Accepted proposal (verbatim, mine): "¿Hago Composio opcional y cambio el login a OAuth directo de Google (puntos 1 y 2)?" Answer (verbatim): "si, hazlo y sube a main".
- S2. Point 1 (verbatim): "Que el servidor arranque sin `COMPOSIO_API_KEY`, con el catálogo de apps desactivado en lugar de dar errores 500."
- S3. Point 2 (verbatim): "Login con Google por OAuth directo, con tu propio proyecto de Google Cloud."
- S4. Assumption: with `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` unset and Composio configured, the existing Composio-based sign-in keeps working unchanged, so current deployments do not break.
- S5. Assumption: the direct sign-in asks only for `openid email profile`, binds the flow to the browser that started it (state cookie), and accepts only a verified email.
- S6. Assumption: when Composio is configured but fails (bad key, missing permission), the apps routes answer with the reason instead of a bare 500 (the "bug en app connect" the user reported).
- S7. User (verbatim, sent while the work was under way): "debes hacerloo de tal manera que podamos ir añadiendo mas servios de google y otros proveedores". The sign-in is one generic flow over a registry of providers; a provider declares its services and their scopes. Assumption: this asks for the structure, not for any new service or provider now; none besides Google sign-in is added, and no tokens are stored.

## Tasks

- [x] T1 (S2,S6) inline: Composio optional; apps routes degrade with a message.
- [x] T2 (S3,S4,S5) inline: direct Google OAuth sign-in; web sign-in screen follows what is configured.
- [x] T3 (S2,S3) inline: docs (`README.md`, `.env.example`, `docs/ARCHITECTURE.md`).

Route: inline (one understood change per task, shared files `routes.ts` and `env.ts`).

## Log

- L1 (2026-11-13) User: "soy un desarrollador con experiencia el uso de composio vale para personas que no saben crear proyectos en google". Then, to the proposal above: "si, hazlo y sube a main".
- L2 (2026-11-13) Evidence before the change: with a scoped `ak_` key, `GET /api/apps` 200 but `POST /api/apps/gmail/connect` and `GET /api/auth/google/start` 500 (`APIKey_InsufficientPermissions`, `session_management` write). Composio is used in `composio.ts`, `triggers.ts`, `mcp.ts`, `agent/tools.ts`, `agent/loop.ts`, `routes.ts`.
- L3 (2026-11-13) User: "debes hacerloo de tal manera que podamos ir añadiendo mas servios de google y otros proveedores". Replaced the Google-only helper with `server/src/oauth/providers.ts` (registry, `scopesFor`, `authUrl`, `sameState`, `exchangeCode`, `fetchProfile`) and generic routes `/api/auth/:provider/start|callback`.
- L4 (2026-11-13) Evidence: RED then GREEN for `oauth/providers.test.ts` (6 tests, including a second made-up provider with services); `npm test` 15 pass; typecheck clean for server and web. Throwaway server on port 8799 with a scratch database. Without Composio or Google: boots, `/api/auth/me` gives `providers: []`, `apps: false`; `/api/apps` 200 with `available: false`; connect 409 with the reason; Google start redirects to `?login=unavailable`. With a fake Google client: start redirects to accounts.google.com with `scope=openid email profile`, the state and a state cookie; the callback redirects to `?login=failed` and sets no session cookie when the cookie is missing, the state differs, Google reports an error, or the code is bogus (Google answered `401 invalid_client`); an unknown provider is 404. On the main dev server with the user's scoped Composio key: `/api/apps` 200, connect 502 with Composio's reason (was a bare 500), Composio sign-in start redirects to `?login=failed` (was a bare 500).
- L5 (2026-11-13) Not verified: a successful Google sign-in end to end (no real OAuth client here); the web sign-in screen and apps dialog were typechecked, not looked at in a browser. Not changed: `ALLOWED_EMAILS` still applies only when an account is created.
- L6 (2026-11-13) My test script's cleanup killed the wrapper shells of the dev server, web server and gateway; the web server and gateway processes survived, the dev server was restarted.
