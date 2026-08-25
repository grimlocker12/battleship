# Handoff notes — Battleship project

This project was built across a conversation with Claude in the claude.ai
chat interface (not Claude Code), for Andreas Andersson to build a local
network multiplayer Battleship game for his two kids to play against each
other, PC to PC, on their home network.

If you're Claude Code picking this up: everything below is context that
shaped the code but isn't necessarily obvious just from reading the files.
The code itself is the source of truth — this is the "why," not a spec to
re-derive from scratch.

## What this is

A 2-player Battleship game. One machine runs `server.js` (Node + the `ws`
package), which serves the client (`public/index.html`, a single-file
vanilla JS/HTML/CSS app — no build step, no framework) and relays game state
over WebSockets. Each kid opens a browser on their own PC and connects to
the host machine's LAN IP on port 3000.

## How it evolved (in order)

1. **v1 — basic game.** Server-authoritative Battleship: manual ship
   placement (click + rotate, or random), turn-based firing, win detection.
   Kept deliberately simple since the audience is two kids.

2. **v2 — names, scoreboard, sound, visuals.** Added: a name-entry step
   before the first game; a persistent scoreboard keyed by player name,
   saved to `scores.json` next to `server.js` (survives server restarts —
   this was an explicit requirement, not just "nice to have"); a
   Web-Audio-API sound engine generated entirely in-browser (no audio
   files, so it works fully offline — deliberate choice); CSS animations
   for hits/misses/sinks and a confetti win celebration.

3. **Crash fix.** Andreas hit a real crash in production (`TypeError:
   Cannot read properties of null (reading '4')` in `validPlacement`,
   `server.js:132`). Root cause: when one player's browser disconnected
   (tab close/refresh/WiFi blip) mid-game, the `ws.on('close', ...)`
   handler did `game = freshGame()`, wiping the *other* (still-connected)
   player's board too — but that player's client didn't know anything had
   happened, so their next click sent a `place`/`fire` message against a
   now-null board and crashed the whole Node process, killing the game for
   both kids.

   Fix, in `server.js`:
   - Every message handler now checks `game.players[myIdx] !== ws` first
     and replies with `{type: 'sessionExpired'}` instead of touching stale
     state — this is the primary fix.
   - The whole `ws.on('message', ...)` body is wrapped in try/catch as a
     defense-in-depth net (logs and recovers instead of crashing on any
     *future* unforeseen bug too).
   - Client: `opponentDisconnected` and the new `sessionExpired` message
     both now call a `lockGame()` helper that hides *all* phases
     (placement AND battle — the original bug was that only the battle
     grid got disabled) and shows a "Reload page" button.

   This was verified with actual test scripts simulating the exact crash
   scenario (two real WebSocket clients, one killed mid-placement) — not
   just reasoned about. If you're extending the game logic, it's worth
   writing similar throwaway simulation scripts against a running
   `node server.js` rather than trusting static analysis alone; that's how
   the original bug was confirmed fixed.

4. **Permanent deployment + hardening.** Andreas runs TrueNAS CORE and
   wanted this permanently installed in a FreeBSD jail (iocage), auto-
   starting on boot and auto-recovering from crashes, rather than someone
   manually running `npm start` every time. Added:
   - `deploy/battleship.rc` — a FreeBSD rc.d script using
     `/usr/sbin/daemon -r -f -P <pidfile> -t battleship -u <user> -o
     <logfile>` — the `-r` flag gives crash auto-restart natively, no
     pm2/forever/etc. needed. `-P` (not `-p`) is important: it's what makes
     `service battleship stop` cleanly stop the supervisor+child rather
     than the `-r` restart logic fighting the stop command.
   - `deploy/install-truenas.sh` — run once inside the jail to install
     Node via pkg, deploy the app to `/usr/local/battleship`, `npm
     install`, install the rc.d script, and enable+start the service.
   - `deploy/TRUENAS-SETUP.md` — the human walkthrough for creating the
     jail itself in the TrueNAS UI and getting files into it.
   - `server.js` changes for unattended 24/7 operation: `PORT` and
     `BATTLESHIP_SCORES_FILE` are now overridable via environment
     variables (the rc.d script sets these); added
     `process.on('uncaughtException'/'unhandledRejection')` handlers that
     log instead of crashing; added graceful `SIGTERM`/`SIGINT` handling
     so `service battleship stop`/restart shuts down cleanly.

   Caveat: none of the FreeBSD/iocage/rc.d specifics have been tested
   against a real TrueNAS box — there's no FreeBSD environment available
   in the chat sandbox this was built in. The shell scripts are
   syntax-checked (`sh -n`) but not execution-tested. If something in
   `deploy/` needs adjusting for Andreas's specific TrueNAS version, that's
   expected and fine — just fix it in place.

5. **The credit line.** Andreas asked for a footer crediting him as the
   creator, explicitly leaving it up to Claude's judgment whether to
   mention AI involvement. Current text in `public/index.html`:
   `⚓ Built by Andreas Andersson — with a little help from Claude AI (and a
   bug-squashing pass by Claude Code)`. This was a deliberate, requested
   addition — not something to remove or "clean up" as boilerplate.

   Between this entry and the next one, the project also picked up (outside
   any Claude Code session — likely more claude.ai chat work): server-side
   path-traversal hardening on the static file server (`server.js`, see the
   `PUBLIC_DIR` check), ship emoji on placed ships, a hit/miss quote system
   with floating text + particle bursts + screen shake, an animated wave
   footer, and `deploy/INSTALL-WITH-WINSCP.md` (a no-terminal WinSCP-based
   walkthrough of the same jail setup as `TRUENAS-SETUP.md`). None of that
   is described elsewhere in this file — worth knowing if something in
   those areas looks unfamiliar.

6. **Docker packaging + move to TrueNAS SCALE.** Andreas upgraded his NAS
   from TrueNAS CORE to SCALE (Dragonfish-24.04.2.5), which doesn't use
   iocage jails — it runs apps as containers via k3s/containerd instead.
   Added:
   - `Dockerfile` — `node:20-alpine`, runs as the built-in non-root `node`
     user (uid 1000), writes the scoreboard to `/data` (a declared volume),
     has a `wget`-based `HEALTHCHECK` against `/`. Built and
     smoke-tested locally with real `docker build`/`docker run` — confirmed
     non-root `/data` ownership, that a save survives a full container
     destroy/recreate against a named volume, and that the healthcheck
     reports healthy.
   - `docker-compose.yml` — for local testing only (`docker compose up
     --build`), not how it runs on SCALE.
   - `deploy/DOCKER-TRUENAS-SCALE.md` — the new recommended deployment
     path, superseding the iocage-jail docs for SCALE users. Defaults to
     importing a pre-built `battleship-image.tar.gz` directly into SCALE's
     containerd store via `k3s ctr -n k8s.io images import` (no Docker Hub
     account, nothing leaves the LAN — consistent with the project's
     LAN-only philosophy below), with pushing to a registry documented as
     the alternative. Walks through SCALE's "Custom App" UI: image pull
     policy `IfNotPresent` (critical — otherwise Kubernetes tries to pull
     from Docker Hub and fails, since there's no public `battleship`
     image), a host-path volume for `/data`, and chowning that host dataset
     to uid 1000 (or overriding the container's run-as UID) so the
     non-root container can write to it.
   - `server.js` — `scores.json` changed shape from a flat `{name: count}`
     map to `{ scores: {...}, history: [...] }` to support a "recent
     match history" list (see next entry). `loadScores()` auto-migrates
     the old flat format on read, so an existing scoreboard file (e.g.
     copied over from the old CORE jail) upgrades itself the first time
     the new server reads it — no manual conversion needed.
   - `server.js` — closed a validation gap in the `place` and `fire`
     handlers: `row`/`col` are now required to be actual integers (a
     crafted non-numeric value could previously reach `board[NaN][c]`,
     which throws — caught by the existing try/catch, but now rejected
     cleanly instead), and ship name/size for `place` are now taken from
     the server's own `SHIP_DEFS` by placement order rather than trusted
     from the client message, closing off a mismatched-size/"ghost ship"
     vector. Also removed a line of dead code in the connection handler
     (an unreachable fallback for player-slot assignment).

   The exact TrueNAS SCALE UI field names/paths in the deploy doc are
   written from general knowledge of Dragonfish's Apps UI, not verified
   against a live SCALE box (none available in this environment) — same
   caveat as the original CORE docs. The *goal* of each step is stated
   clearly so it's followable even if a label has shifted slightly.

7. **General polish pass (same session as #6).** Andreas asked for a few
   small, low-risk improvements alongside the Docker work — not a specific
   feature list, just "things you'd suggest." Landed:
   - **Mobile-friendly layout.** Grid cell size changed from a fixed `32px`
     to `clamp(22px, 8vw, 32px)` via a `--cell` CSS variable (used by both
     `.grid` and `.cell`), with `.boards` gap and the `h1` font-size also
     switched to `clamp()`. No JS or breakpoints involved — pure fluid
     CSS. Verified via the browser tool at 375px and 320px viewport widths
     (placement phase and battle phase, i.e. one board and two boards) with
     zero horizontal overflow (`scrollWidth === clientWidth` at both
     sizes) — a real screenshot wasn't available in this environment, so
     that DOM-measurement check was the verification method, same
     script-over-static-analysis spirit as the rest of this file.
   - **Live placement progress.** New `opponentProgress`/`clearPlacement`
     server broadcasts (`server.js`) tell the *other* player "opponent has
     placed X/5 ships" as it happens, shown in a new `#opponentProgress`
     line in the placement phase (`public/index.html`) — previously the
     only signal was silence until the opponent clicked Ready.
   - **Match history.** The `scores.json` reshape in entry #6 backs a
     "Recent wins" strip under the scoreboard, showing up to the last 5
     game results (winner names only, most recent first) via a new
     `history` field on the `scoreboard` broadcast. Capped server-side at
     `MAX_HISTORY = 10` entries.
   - Declined (Andreas's choice, not a technical constraint): a 3rd-player
     spectator queue, and a how-to-play help modal.

   All three were verified end-to-end with the browser tool against a real
   `node server.js` (two tabs: names/placement driven by simulated clicks,
   then the battle phase driven by direct `ws.send` scripting to reach a
   real game-over quickly — same "throwaway script against a running
   server" approach described below in Testing approach) — not just read
   over statically.

## Testing approach used so far

There's no permanent test suite in this repo (kept it minimal for a family
project), but every behavioral change was verified with a disposable Node
script using the `ws` package: spin up `node server.js`, connect two real
WebSocket clients, script them through the actual message protocol (place
ships, ready up, fire, disconnect, etc.), and assert on what comes back.
This caught real bugs (e.g., a test-harness counting bug that initially
looked like a game bug, and confirmed the disconnect crash both before and
after the fix). Recommended to keep doing this for any further game-logic
changes, since the WebSocket message protocol is the actual contract, not
just the code that implements it.

## Design decisions worth preserving

- **No build step, no framework, no bundler.** Single `index.html` with
  inline `<style>` and `<script>`. This is intentional for a project this
  size and for a non-professional audience running it — don't introduce
  React/webpack/etc. unless there's a real reason.
- **No external sound/image assets.** All sound is synthesized via Web
  Audio API oscillators/noise buffers at runtime. Keeps the whole thing
  self-contained and working with zero internet access on the LAN.
- **Server is authoritative.** Client never computes hit/miss/sink itself;
  it only renders what the server tells it. Keep it that way — it's what
  makes cheating-by-inspecting-devtools not a concern for two kids playing
  each other, and avoids a whole class of sync bugs.
- **Scores keyed by name, not by connection/session.** Simple and fits the
  "two known kids, same names every time" use case. Not designed for
  arbitrary/anonymous multiplayer — if this ever needs to support that,
  the scoreboard model would need rethinking.
