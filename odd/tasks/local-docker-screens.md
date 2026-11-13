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
- S8. User request (verbatim): "corrige las advertencias de la verificación". A changed `SESSION_SECRET` must not break the viewer: the password reaches the running VNC servers on the next start check.
- S9. The VNC password is not part of the container's configuration (`docker inspect`), and other containers cannot reach the box's VNC or DevTools servers. Accepted limit, documented: DevTools on `127.0.0.1` has no authentication.
- S10. A Library download checks and reads the file in one command in the container, streams it, and does not depend on stderr.
- S11. VNC host ports are outside the X11 range (59000 + display).
- S12. Deleting a bot stops its display in the local box; a container that just started gets its screens dressed again on next use.
- S13. User request (verbatim): "si, corrige y sube a main". Display changes in the box are serialized (two starts of one display, or a stop followed at once by a start, leave exactly one X server); a container that restarted without the server gets its screens dressed again; a Library download that does not answer is given up after 15 seconds; the download checks the file it has opened, not the path.
- Assumption: container ports are published on `127.0.0.1` only. Assumption: Chromium replaces Chrome (no Chrome for Linux arm64).

## Tasks

- [x] T1 (S1,S2,S6,S7) inline, commit ea77001: `HQ_BOX=docker` env, container image and lifecycle, `box` over `docker exec`.
- [x] T2 (S2,S3,S4,S5,S7) inline, commit ea77001: screens, screenshot, VNC relay upstream, CDP reachability, engine config.
- [x] T3 (S1) inline, docs commit: docs (`README.md`, `.env.example`, `docs/ARCHITECTURE.md`).

Route: inline for all tasks (no Writer trigger: the units share `computer.ts`/`box.ts` and depend on each other).
- [x] T4 (S3,S6,S8-S12) inline: fix the independent verification's advisories.
- [x] T5 (S10,S12,S13) inline: fix the recheck's partial and new advisories.

## Log

- L1 (2026-11-13) User: "adapta las pantallas a macOS". Asked which kind of screen; user asked for a lighter Docker alternative, then: "sigue con colima, es caro para tener un bot 24/7".
- L2 (2026-11-13) Evidence: `desk.ts` reaches the computer only through `box.*`; the scripts accept Chromium and run without xfce. Orgo is used directly in `computer.ts`, `vnc.ts`, `routes.ts` (screenshot), `routes-config.ts` (file export).
- L3 (2026-11-13) Evidence, observed against a live Colima container: RED then GREEN for `server/src/lib/screens.test.ts` (4 tests); `npm run typecheck` clean; viewer relay completes the RFB handshake and returns a framebuffer update in watch and control mode on `default` and `screen-100`; `GET /api/bots/:id/screenshot` returns a dressed 1440x900 JPEG; a managed bot browsed https://example.com on its own Chromium (tab confirmed on DevTools port 9300); Library list and download work, a symlink pointing outside the library returns 404; after an image change the server rebuilt and replaced the container, re-leased `screen-100`, and the volume kept the files.
- L4 (2026-11-13) Not verified: Orgo mode at runtime (no Orgo account here); it is covered only by typecheck and by the unchanged code paths behind `env.dockerBox`. The viewer's Orgo upstream was refactored behind the same interface as the TCP one.
- L5 (2026-11-13) Known limits: agents run on the host, so only browser work is contained; the primary bot's own Hermes config is not touched, so it does not browse on its screen unless the user sets its `browser.cdp_url`; subscription sign-in from the Engine panel stays unavailable in this mode.
- L6 (2026-11-13) User: "corrige las advertencias de la verificación". The independent verifier had reported no blockers and these advisories: secret rotation breaks the viewer; weak isolation (short password visible in `docker inspect`, servers reachable from other containers, unauthenticated DevTools on loopback); check-then-read gap and full buffering in the download route; stderr could corrupt the resolved path; host ports 6000-6002 are the X11 range; the default screen stays bare after a recreate; `hq-display stop` is never called; tests cover only `lib/screens.ts`.
- L7 (2026-11-13) Evidence for T4, observed live: RED then GREEN for `lib/rfb.test.ts` (3), `lib/library.test.ts` (2, the containment script runs in a throwaway `debian:bookworm-slim` container) and the new port assertions; `npm test` 9 pass; typecheck clean. Container recreated on `hq-box-net` with ports 59099-59102, no VNC variable in its env; downloads: file 200, symlink to `/etc/passwd` 404, missing 404, empty file 200 with 0 bytes, 60 MB file 200 with 60000000 bytes; default screen dressed again after the recreate (DevTools 9299 answers, 3 windows); after setting a different password by hand the viewer worked again on the next start check; a container on the default bridge could not connect to the box's DevTools port; deleting a bot removed its display from `hq-display list`.
- L8 (2026-11-13) Not changed: `dockerBox.bash` still returns stdout and stderr together, like the other two `box` backends; the download route no longer parses it. The download still resolves the path and opens it by name within one shell process, so a file swapped inside the container in that instant is not excluded.
- L9 (2026-11-13) Recheck by the independent verifier of cc92214: no blockers; partly fixed: download not atomic, default screen bare when the container restarts without the server; new advisories (read only): double `start 99` after a restart, `stop N` then `start N`, no timeout in `openLibraryFile`. User: "si, corrige y sube a main".
- L10 (2026-11-13) Two defects of my own found while testing T5 and fixed before commit: `test || helper &` backgrounded a shell that kept the new lock for the helper's lifetime, so the next `hq-display` call hung; unanchored `pgrep -f`/`pkill -f` patterns also matched (and `stop` killed) any process that mentioned a helper in its arguments. Helpers now start as plain background commands with the lock descriptor closed, and every pattern is anchored.
- L11 (2026-11-13) Evidence for T5, observed live: `npm test` 9 pass (the read-script test now also refuses a FIFO), typecheck clean; two simultaneous `start 101` leave one Xvfb; `stop 101` then `start 101` leaves one Xvfb and one x11vnc and the display answers; downloads: file 200, symlink to `/etc/passwd` 404, FIFO 404 in 0.02 s, missing 404, empty 200; after `docker restart hq-box` with the server running, display 99 had 0 windows and after the next viewer connection 3 windows and DevTools 9299 answering, and `screen-100` was leased again. Not reproduced by test: the swap race the open-then-check closes, and the 15 s timeout (no way to make the command hang on demand).
