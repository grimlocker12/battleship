# Battleship — Local Network Multiplayer

A simple 2-4 player Battleship game your family can play from separate
devices on the same home WiFi/network.

> **Using Claude Code (or another AI coding tool) on this project?** Read
> **[HANDOFF.md](HANDOFF.md)** first — it covers the project history,
> the reasoning behind some non-obvious decisions, and a real crash that
> was found and fixed, none of which is otherwise visible just from
> reading the code.

## Ways to run this

**Option A — Docker on TrueNAS SCALE (recommended):** Runs as a real
always-on app — starts automatically when your NAS boots, and Kubernetes
restarts it automatically if it ever crashes. Nobody ever has to start a
server. See **[deploy/DOCKER-TRUENAS-SCALE.md](deploy/DOCKER-TRUENAS-SCALE.md)**.

**Option B — Manual run on any Windows/Mac PC:** Good for trying it out, or
if you don't have a NAS. One PC has to run the server each time you want to
play. Instructions below.

**Legacy — TrueNAS CORE (jails):** if you're still on TrueNAS CORE rather
than SCALE, the old iocage-jail setup still works —
**[deploy/INSTALL-WITH-WINSCP.md](deploy/INSTALL-WITH-WINSCP.md)** (no
terminal experience needed) or **[deploy/TRUENAS-SETUP.md](deploy/TRUENAS-SETUP.md)**
(comfortable with a host shell/SSH). Not needed if you're on SCALE — use
Option A instead.

---

## Option B: One-time setup (do this once, on ONE of the two PCs)

1. **Install Node.js** (if not already installed): https://nodejs.org — grab
   the "LTS" version, and click through the installer with default options.
2. Unzip this `battleship` folder onto that PC — anywhere is fine, e.g. the Desktop.
3. Open a terminal / command prompt **in this folder**:
   - Windows: open the `battleship` folder in File Explorer, click the address
     bar, type `cmd`, and hit Enter.
   - Mac: right-click the `battleship` folder → "New Terminal at Folder"
     (or open Terminal and `cd` into it).
4. Run:
   ```
   npm install
   ```
   This downloads one small package (`ws`) the server needs. Only needed once.

## Every time you want to play (Option B only)

1. On the host PC, in that same terminal, run:
   ```
   npm start
   ```
   You should see:
   ```
   Battleship server running!
   On THIS PC, open: http://localhost:3000
   On the OTHER PC, open: http://<this-PCs-LAN-IP>:3000
   ```
2. **Find the host PC's local IP address:**
   - Windows: open Command Prompt, run `ipconfig`, look for "IPv4 Address"
     (something like `192.168.1.23`).
   - Mac: System Settings → Wi-Fi/Network → the IP is shown there, or run
     `ifconfig` / `ip addr` in Terminal.
3. **On the host PC's own browser**, go to `http://localhost:3000`.
4. **On each other device**, open a browser and go to
   `http://192.168.1.23:3000` (using the actual IP from step 2, port `3000`).
5. Once at least 2 players have joined and named themselves, anyone can
   click **Start Game** — or wait for up to 4 to join, which starts
   automatically the moment the 4th player is in.

Every device needs to be on the **same WiFi/network** for this to work. If
a device can't connect, it's almost always a firewall prompt on the host
PC — click "Allow" if Windows/Mac asks whether Node.js can accept network
connections.

## How to play

1. **Enter your name:** Each player types their name on their own device
   first. This is remembered by their browser, so next time they play it's
   already filled in.
2. **Lobby:** Once you've named yourself, you'll see who else has joined.
   Click **Start Game** once at least 2 are in, or wait for more (up to 4)
   to join first.
3. **Placement:** Each player places 5 ships (Carrier, Battleship, Cruiser,
   Submarine, Destroyer) by clicking a starting cell on their own grid.
   Use the "Rotate" button to switch between horizontal/vertical before
   placing. Or just hit "Random placement" to skip straight to battle.
   Click **Ready** once all 5 ships are placed.
4. **Battle:** On your turn, pick which opponent to fire at (in a 2-player
   game there's only one board to click, exactly like before; in a 3-4
   player game you'll see one board per opponent — click any of them).
   Hits, misses, and sunk ships are shown live to everyone, with sound
   effects and explosion/splash animations. In a 3-player game, the turn
   order is reshuffled every round to keep things unpredictable; in 2- and
   4-player games turns rotate in a fixed order.
5. **Elimination:** Losing your whole fleet doesn't end the game for
   everyone else in a 3-4 player game — you switch to spectating and watch
   the rest of the battle live. Last player standing wins — confetti and a
   victory jingle for the winner. Hit **Play again** for a rematch with the
   same group — no need to restart the server, and names/scores carry over
   automatically.

## Scoreboard & names

- The scoreboard at the top tracks total wins per name and updates live,
  with a "Recent wins" strip underneath showing the last few game results.
- Win counts and match history are saved to a `scores.json` file next to
  `server.js` on the host PC (or in the mounted volume, if running in
  Docker), so they survive server restarts — if the kids play again
  tomorrow, their tally from last time is still there.
- Each PC also remembers the name typed into it (via the browser), so kids
  won't need to retype their name every session — just confirm it.
- Names are shared across the whole household network, so make sure each
  kid always uses the same name if you want their win count to keep
  accumulating correctly.
- During ship placement, each player sees a live "Opponent has placed X/5
  ships" indicator, so nobody's stuck wondering why the other side is quiet.

## Sound & visuals

- There's a 🔊 button in the top-right corner of the page to mute/unmute
  sound effects (each browser remembers its own mute preference).
- All sound effects are generated in the browser itself (no audio files,
  no internet needed) — firing, hits, misses, sinking ships, turn
  notifications, and win/lose jingles.
- Hits, misses, and sunk ships have animated effects, and winning a game
  triggers a confetti celebration.

## Notes

- This only works on your home network — it's not exposed to the internet,
  which is exactly what you want for family members playing each other.
- **Option B only:** to stop the server, click into the terminal window and
  press `Ctrl+C`. (On the TrueNAS setup, use `service battleship stop`
  instead — see the deploy guide.)
- Up to 4 players can be connected at once; a 5th browser tab will see
  "Game is full" (or "already in progress" if a game's mid-way through).
- If you ever want to wipe the scoreboard clean, just delete `scores.json`
  (next to `server.js`) and restart the server — it'll start a fresh one
  automatically.
- If someone's browser refreshes, closes, or briefly loses WiFi mid-game,
  they're simply eliminated (or, in a 2-player game, the remaining player
  wins) — everyone else's game continues uninterrupted. The player who
  dropped just needs to reload the page to rejoin the lobby for the next
  game.
