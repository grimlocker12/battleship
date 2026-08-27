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

A 2-4 player Battleship game. One machine runs `server.js` (Node + the `ws`
package), which serves the client (`public/index.html`, a single-file
vanilla JS/HTML/CSS app — no build step, no framework) and relays game state
over WebSockets. Each player opens a browser on their own device and
connects to the host machine's LAN IP on port 3000.

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

8. **2-4 player support.** Andreas wanted to "spice up" family game night:
   more than 2 players, choosing who to shoot at each turn, and a
   randomized turn order specifically for 3-player games. This was a
   near-total rewrite of the session/game state in both files — the old
   model was hardcoded around exactly 2 players (fixed 2-element arrays
   for `players`/`names`/`boards`/`ships`/`ready`, `otherIdx = myIdx===0?1:0`
   turn logic). Planned via `EnterPlanMode` given the scope; the approved
   plan is a useful reference for the design rationale beyond what's below.

   **Server (`server.js`) — new state model:** a `seats` array (length 4,
   stable index for the life of one game) replaces the parallel arrays;
   `game.phase` is `'lobby' | 'placement' | 'battle' | 'over'`;
   `game.roster` is the seat indices dealt into the current game;
   `game.turnOrder`/`turnPtr` drive whose turn it is. Key behaviors:
   - **Flexible lobby.** Up to 4 seats; auto-starts the instant all 4 are
     named, otherwise any named seat can send `startGame` once ≥2 are
     named. This applies uniformly *including 2-player games* — there's no
     special case that skips the lobby at 2, so even a 2-player game now
     sees a brief seat-list-and-Start-button screen before placement
     (a deliberate, explicit trade-off Andreas signed off on, in exchange
     for one consistent flow at every player count).
   - **Turn rotation + 3p reshuffle.** `turnOrder` is fixed seat-ascending
     for 2p/4p; for a game that *started* with exactly 3 players,
     `shuffleEachRound` is set true and the order is reshuffled at the
     start of every round (continues reshuffling even if attrition drops
     it to 2 alive players later — a deliberate, harmless simplification
     rather than a special case). See the `eliminateSeat()` function's
     comments for the turn-pointer bookkeeping when a seat is removed
     mid-rotation — it's shared between the "sunk" and "disconnected"
     removal paths specifically so they can't drift apart.
   - **Elimination = spectator, not game-end.** A sunk player's socket
     stays in `seats[]` (so `broadcast()` keeps reaching them for free) and
     they receive a `spectating` message, watching live until the game
     ends. The one exception: if a player is eliminated by the *same event*
     that ends the game (the classic 2-player case, or the second-to-last
     elimination in a larger game), they go straight to `gameOver` with no
     `spectating` message in between — there's nothing left to watch.
   - **Disconnect = elimination, unified across every player count,
     including 2p.** This intentionally *replaces* the "wipe the whole
     game on any disconnect" design from entry 3 above, which was
     explicitly a 2-player-only crash-safety choice. Andreas was asked
     directly whether 2p should keep that old special-cased behavior or
     unify with the new rule, and chose to unify — a disconnecting opponent
     now just hands the remaining player(s) the win, at every player count.
     Lobby-phase and placement-phase disconnects are handled differently
     (free the seat / bounce survivors back to the lobby if it drops below
     2) — see the phase-by-phase branches in the `ws.on('close', ...)`
     handler.
   - **Scoreboard/history generalized to N players.** `scoreData.history`
     entries changed from `{winner, loser, endedAt}` to
     `{winner, players: [...], endedAt}` since "loser" isn't well-defined
     for 3-4 players — non-breaking, since the client's
     `updateMatchHistory()` only ever reads `.winner`.

   **Client (`public/index.html`):** a new `#lobbyPhase` screen (seat list +
   Start button); `mySeatIdx` (0-based) replaces `myPlayer` and a `roster`
   map replaces the fixed 2-name array everywhere. The battle UI renders
   **one enemy board per alive opponent** rather than a single fixed enemy
   board — for a 2-player game this naturally produces exactly one board,
   so the interaction is pixel-for-pixel identical to before (no visible
   "target picker" widget exists as a separate concept; clicking a specific
   opponent's board *is* the target choice). Eliminated opponents' boards
   stay visible but permanently disabled with an "ELIMINATED" label rather
   than being removed, which is what a spectator (or the eliminated player
   themselves) sees for the rest of the game.

   **Testing:** a disposable scripted-`ws`-client test harness (matching
   the project's established approach, see below) with 21 assertions
   across lobby/auto-start, fixed 2p/4p rotation, the 3p reshuffle
   (asserted across multiple rounds, not just once), elimination →
   spectator → correct eventual winner, every disconnect phase/variant
   including the newly-unified 2p case, and the scoreboard/history shape —
   all passing before moving to real browser verification. Then two full
   real games via the browser tool: a 3-player game start-to-finish
   (including watching the elimination → spectator transition and the
   distinct "thanks for watching" vs. immediate-loss wording, then a
   rematch), and a 4-player game through placement and battle, specifically
   checked at 375px and 320px viewport widths (four boards on screen at
   once was flagged as an open layout risk in the plan; the existing
   `clamp()`/flex-wrap responsive CSS from entry 7 handled it fine with no
   changes needed).

   Same session, separately: removed the screen-shake-on-hit effect
   (`shakeScreen()`/`#app.shake`/the `shake` keyframes, added in the
   unattributed claude.ai session described in entry 5) — Andreas's kids
   found it annoying. Pure removal, no replacement effect requested.

9. **Reconnect + heartbeat + stuck-game fix.** After real family play of the
   2-4 player version, Andreas reported two bugs: a player who dropped out
   mid-game landed on a dead-end "Disconnected from server" screen, and once
   an entire 4-player game finished and someone clicked "Play again,"
   *everyone* ended up disconnected with no recovery short of restarting the
   TrueNAS pod. Both were reproduced and root-caused with scripted `ws`
   clients (same convention as always) before writing any fix:
   - `wss.on('connection', ...)` flatly rejected any connection with
     `gameInProgress` + `ws.close()` whenever `game.phase !== 'lobby'` --
     there was no way back into a game once you dropped, ever.
   - The client's `ws.onclose` unconditionally overwrote whatever message
     was just shown with a generic "Disconnected from server," so that
     rejection looked like an unexplained crash.
   - There was no WebSocket heartbeat anywhere. On the real TrueNAS SCALE
     deployment, traffic goes through a Kubernetes NodePort, and kube-proxy
     conntrack silently drops idle connections after a few minutes of no
     traffic (very plausible during slow ship placement) -- Node had no way
     to notice a socket had gone zombie, since no clean `close` event ever
     fires for one.
   - The `rematch` handler trusted `ws.readyState === OPEN` to decide who
     was still in the game, so a zombie connection could get counted as a
     real survivor, dragging a phantom seat into a placement phase that
     could never complete -- permanently wedging `game.phase` outside
     `'lobby'`, with no way for anyone (even real, still-connected players
     hitting refresh) to ever get a fresh room without a manual restart.

   **Fix, in `server.js`:** every seat gained a persistent `token` (a
   `crypto.randomUUID()`, handed back on `welcome`/`reconnected`) and a
   `graceTimer`. A placement/battle disconnect no longer tears the seat down
   immediately -- it broadcasts `opponentConnectionLost` and starts a
   `GRACE_MS` (default 30s, env-overridable) timer via the new
   `onGraceExpired(seatIdx)`, which contains exactly the cleanup logic that
   used to run immediately (roster-shrink/bounce-to-lobby for placement,
   `eliminateSeat(idx, 'disconnected')` for battle) -- **a delay, not a
   behavior change**, so it doesn't weaken entry 8's "disconnect =
   elimination, unified" decision, just gives it a grace window first. A
   reconnecting browser appends its saved token as a `?token=` query string
   on the WebSocket URL itself (read from the upgrade `req.url`, so there's
   no message-ordering race to worry about); if it matches a seat that's
   still reclaimable, the connection is restored to that exact seat and gets
   a `reconnected` message instead of `welcome`, carrying whatever state its
   phase needs to rebuild the UI (own ships in placement; both players'
   *redacted* hit/miss grids plus which ships are already sunk in battle --
   the server never leaks unsunk ship positions, even to a reconnecting
   owner, past what's needed to redraw their own board from their own known
   ship layout). A standard `ws` `isAlive`/`ping`/`pong`/`terminate`
   heartbeat now runs continuously and calls `terminate()` on anything that
   stops answering -- that fires the same `close` event a clean disconnect
   would, so zombie connections flow through the identical grace-period path
   with no special-casing. Finally, `maybeAutoResetToLobby()` runs after
   every close/grace-expiry: if the room is ever outside `'lobby'` with zero
   live connections *and* zero pending grace timers, it just resets to a
   fresh lobby -- the room can no longer get permanently stuck no matter what
   combination of drops and abandonment happens.

   **Client (`public/index.html`):** the WebSocket URL now carries a saved
   token from `sessionStorage` (**not** `localStorage` -- a real bug caught
   during manual two-tab browser testing: `localStorage` is shared across
   every tab on the same origin, so two tabs open on the same device
   collided on one shared token and broke each other's reconnect; a token
   scoped to `sessionStorage` is naturally per-tab and doesn't have this
   problem, while `battleship_name` stays on `localStorage` since a
   collision there is harmless pre-fill text, not a broken session).
   **Superseded a few hours later by entry 10 below** -- `sessionStorage`
   alone turned out to be wrong for a different reason (it doesn't survive a
   fully closed-and-reopened tab, which is the normal way to think of
   "reconnecting" on a phone). Fixed the `onclose` stomping bug via a
   `terminalMessageShown` flag so a
   `full`/`gameInProgress`/`sessionExpired` message survives instead of
   being overwritten. A new `hydrateFromReconnect()` rebuilds the UI
   silently (no sound/particle effects -- it's a replay of state the player
   already lived through) by reusing `startPlacementPhase()`/
   `startBattlePhase()` plus small DOM-only helpers factored out of the live
   incremental handlers (`paintShipOnBoard()` out of `onPlaceAccepted()`,
   `paintResultCell()` out of `applyFireResult()`) so the live and
   reconnect-replay paths can't drift apart.

   **Testing:** extended the scripted-`ws`-client convention with
   env-overridable `BATTLESHIP_GRACE_MS`/`BATTLESHIP_HEARTBEAT_MS` so timing
   assertions run in well under a second -- placement and battle reconnect
   within grace, grace expiry still eliminating correctly (regression check
   against entry 8), a fully-abandoned mid-battle room self-healing to a
   fresh lobby, a heartbeat catching a raw-socket-killed zombie connection
   (`client._socket.destroy()`, since a stock `ws` client auto-answers
   pings), and the original full-4-player-game-then-rematch report as a
   direct regression check. Then real two-tab browser verification (this is
   what caught the `sessionStorage` bug above -- the scripted tests, using
   separate process-level `ws` clients, can't catch a same-origin
   `localStorage` collision that only shows up with two actual browser tabs).

10. **Reconnect follow-up: the token needed to survive a closed tab, not
    just a refresh.** Shipped entry 9, and Andreas reported it still didn't
    work: reconnecting on his phone by force-closing and reopening the
    browser tab landed on "A game is already in progress," not a resync.
    Root cause: `sessionStorage` (chosen in entry 9 specifically to fix the
    two-tabs-on-one-device collision) is scoped to a single tab's lifetime
    -- it's wiped the moment that tab is actually closed, which is exactly
    what "force-close the app and reopen it" does. A same-tab refresh or a
    WiFi blip (tab stays alive) had always worked; a fully closed-and-reopened
    tab never could, and that turned out to be Andreas's normal mental model
    of "the player dropped and rejoined."

    Fix: read the token from `sessionStorage` first, falling back to
    `localStorage` if empty (`loadToken()`), and write it to *both* on every
    `welcome`/`reconnected` (`saveToken()`). This keeps entry 9's fix intact
    (a same-tab refresh is always exact, since `sessionStorage` is checked
    first and can't be polluted by another tab) while also surviving a full
    tab close, since `localStorage` persists across that. The remaining edge
    case -- two tabs open *concurrently* on one device, one of them closed
    and reopened -- can in theory pick up the wrong tab's token from
    `localStorage`; this was deliberately accepted rather than engineered
    around, because the failure mode is safe: `server.js`'s token match only
    ever reclaims a seat that's actually disconnected/grace-pending, never
    one with a live open socket, so a wrong-token guess just falls through
    to the normal "new connection" flow (same rejection as today, not a
    hijack of someone else's active session) instead of anything worse.

    Also bumped the default `GRACE_MS` from 30s to 60s -- realistic
    "reconnect" timing on a phone (unlock, find the tab, reload, wait for
    the page to load) is looser than a scripted test's instant retry, and
    Andreas's repro was already "within ~30s," uncomfortably close to the
    old default.

    Verified the same way as entry 9's client-side fix had to be: real
    browser testing, not scripted `ws` clients (storage behavior is entirely
    a browser-JS concern the protocol tests can't see). Specifically:
    closed a tab mid-battle, opened a **new** tab (not a reload) to the same
    origin, and confirmed it resynced correctly; separately cleared
    `sessionStorage` alone via devtools and confirmed `loadToken()` still
    recovered the token from `localStorage`, to isolate the fallback logic
    itself from any quirks of the specific test environment's tab handling.

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
  "small group of known players, same names every time" use case. Not
  designed for arbitrary/anonymous multiplayer — if this ever needs to
  support that, the scoreboard model would need rethinking.
