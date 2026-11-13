# local-docker-screens

Objective: run the bots' screens in a local Linux container (Colima or any Docker-compatible runtime) instead of an Orgo computer.
Branch: `feat/local-docker-screens`. Delivery: `single-pr` on the user's fork (`origin`), no upstream. Test runner: `npx tsx --test server/src/*.test.ts` (added by this feature; the repo had none).

## Specs

- S1. User request (verbatim): "adapta las pantallas a macOS"; chosen approach (verbatim): "sigue con colima, es caro para tener un bot 24/7". The app works without an Orgo account: with `HQ_BOX=docker`, `ORGO_API_KEY` and `ORGO_COMPUTER_ID` are not required.
- S2. One screen per bot, up to four, inside one local container: each screen is its own X display with a window manager, dressed by the existing `server/box/` scripts (unchanged behavior on Orgo).
- S3. The live viewer (watch and control) works against a container screen through the existing relay; the VNC password never reaches the browser.
- S4. The screen preview (`GET /api/bots/:id/screenshot`) works against a container screen.
- S5. A managed bot's Hermes (running on the host) drives the Chromium on its container screen through its DevTools port.
- S6. Library files (list, download) work against the container.
- S7. Orgo mode behaves as before (no change when `HQ_BOX` is unset).
- Assumption: container ports are published on `127.0.0.1` only. Assumption: Chromium replaces Chrome (no Chrome for Linux arm64).

## Tasks

- [x] T1 (S1,S2,S6,S7) inline, commit ea77001: `HQ_BOX=docker` env, container image and lifecycle, `box` over `docker exec`.
- [x] T2 (S2,S3,S4,S5,S7) inline, commit ea77001: screens, screenshot, VNC relay upstream, CDP reachability, engine config.
- [x] T3 (S1) inline, docs commit: docs (`README.md`, `.env.example`, `docs/ARCHITECTURE.md`).

Route: inline for all tasks (no Writer trigger: the units share `computer.ts`/`box.ts` and depend on each other).

## Log

- L1 (2026-11-13) User: "adapta las pantallas a macOS". Asked which kind of screen; user asked for a lighter Docker alternative, then: "sigue con colima, es caro para tener un bot 24/7".
- L2 (2026-11-13) Evidence: `desk.ts` reaches the computer only through `box.*`; the scripts accept Chromium and run without xfce. Orgo is used directly in `computer.ts`, `vnc.ts`, `routes.ts` (screenshot), `routes-config.ts` (file export).
- L3 (2026-11-13) Evidence, observed against a live Colima container: RED then GREEN for `server/src/lib/screens.test.ts` (4 tests); `npm run typecheck` clean; viewer relay completes the RFB handshake and returns a framebuffer update in watch and control mode on `default` and `screen-100`; `GET /api/bots/:id/screenshot` returns a dressed 1440x900 JPEG; a managed bot browsed https://example.com on its own Chromium (tab confirmed on DevTools port 9300); Library list and download work, a symlink pointing outside the library returns 404; after an image change the server rebuilt and replaced the container, re-leased `screen-100`, and the volume kept the files.
- L4 (2026-11-13) Not verified: Orgo mode at runtime (no Orgo account here); it is covered only by typecheck and by the unchanged code paths behind `env.dockerBox`. The viewer's Orgo upstream was refactored behind the same interface as the TCP one.
- L5 (2026-11-13) Known limits: agents run on the host, so only browser work is contained; the primary bot's own Hermes config is not touched, so it does not browse on its screen unless the user sets its `browser.cdp_url`; subscription sign-in from the Engine panel stays unavailable in this mode.
