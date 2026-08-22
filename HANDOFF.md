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
   `⚓ Built by Andreas Andersson — with a little help from Claude AI`.
   This was a deliberate, requested addition — not something to remove or
   "clean up" as boilerplate.

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
