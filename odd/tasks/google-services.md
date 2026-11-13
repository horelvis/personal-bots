# google-services

Objective: let bots use the user's Gmail and Google Calendar through the user's own Google OAuth client, with approval for anything that writes.
Branch: `feat/google-services`. Delivery: `ask-on-risk`, to the fork (`origin`) only. Test runner: `npm test`.

## Specs

- S1. User (verbatim): "añade gmail y calendar como servicios de google". Scope chosen by the user from the options offered (verbatim option): "Leer y escribir con aprobación (Recommended)" - "Los bots pueden buscar y leer correos y eventos sin preguntar, y enviar correos o crear/modificar eventos solo tras tu OK en una tarjeta de aprobación, igual que hoy con Composio. Pide a Google permisos de lectura y envío de Gmail y de eventos de Calendar."
- S2. Gmail and Calendar are services of the Google provider in `server/src/oauth/providers.ts`; connecting one asks Google for that service's scopes on top of what is already granted.
- S3. A signed-in user can connect and disconnect each service from the app. Connecting is bound to the browser and the signed-in user that started it.
- S4. Tokens are stored encrypted at rest and refreshed when they expire; they are never sent to the browser or to the agents.
- S5. Bots get tools to search and read mail and to list events without asking, and tools to send mail and to create, change or delete events that wait for the user's approval card (Allow / Always allow / Don't allow), like connected-app writes today.
- S6. Without a Google client configured, or without the service connected, nothing changes for the user except that the tools answer that the service is not connected.
- Assumption: Gmail scopes `gmail.readonly` and `gmail.send`; Calendar scope `calendar.events` on the primary calendar. Assumption: the connected Google account may differ from the one used to sign in. Assumption: the same redirect URI as sign-in is used, so nothing new has to be registered in Google Cloud.

## Tasks

- [x] T1 (S2,S4) inline: service entries, encrypted token storage, refresh.
- [x] T2 (S3,S6) inline: connect and disconnect routes, and the app's screen for them.
- [x] T3 (S5,S6) inline: Gmail and Calendar tools with approvals.
- [x] T4 (S1) inline: docs.

Route: inline (the units build on each other: T2 needs T1's storage, T3 needs T2's connections).

## Log

- L1 (2026-11-13) User: "añade gmail y calendar como servicios de google". Asked what bots may do; user chose "Leer y escribir con aprobación (Recommended)".
- L2 (2026-11-13) Evidence: own tools bypass approvals today (`policyFor` returns allow for anything in `toolMap`); `requestApproval` takes `{ key, toolkit, title }` and the `policies` table is keyed by tool name, so own write tools can reuse both.
- L3 (2026-11-13) Evidence: RED then GREEN for `lib/secretbox.test.ts` (2), `google/gmail.test.ts` (5), `google/calendar.test.ts` (3) and 5 new tests in `oauth/providers.test.ts`; `npm test` 36 pass; typecheck clean for server and web. Live on the dev server with the user's real Google client: `/api/connections` lists Gmail and Google Calendar as not connected; without a session the list and the connect link are 401; unknown service or provider 404; the connect link redirects to Google with `access_type=offline`, `include_granted_scopes=true`, `prompt=consent` and the Gmail scopes, and sets the state and connect cookies; the callback returns `?connect=cancelled` on a provider error and `?connect=failed` on a wrong state, a bogus code (Google: `400 invalid_grant`) or no session, never setting a session cookie; starting a sign-in clears the connect cookie. Through a bot's MCP endpoint: the seven tools are listed; reads answer "not connected"; with a seeded connection `gmail_send` posted the card "Allow QA Local to send an email?" and returned the declined text after Don't allow; a seeded connection is stored sealed (no plaintext token in the row) and `/api/connections` returns no token field; with an expired access token and a refresh token Google rejects, the tool answers "not connected" and the row is gone; a write tool whose service is not connected asks for no approval; disconnect removes the connection.
- L4 (2026-11-13) Not verified: a real connection and any real Gmail or Calendar call (they need the user to go through Google's consent screen in a browser); the new section of the Connect Apps dialog was typechecked, not looked at in a browser. Not done: the app shows no notice when it returns from Google with `?connect=...`; the user sees the result by opening Connect Apps.
- L5 (2026-11-13) Test leftovers on the dev database: two approval cards in the chat of the test bot "QA Local".
