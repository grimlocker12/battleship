# Battleship — Local Network Multiplayer

A simple 2-player Battleship game your kids can play from two separate PCs
on the same home WiFi/network.

> **Using Claude Code (or another AI coding tool) on this project?** Read
> **[HANDOFF.md](HANDOFF.md)** first — it covers the project history,
> the reasoning behind some non-obvious decisions, and a real crash that
> was found and fixed, none of which is otherwise visible just from
> reading the code.

## Two ways to run this

**Option A — Permanent install on TrueNAS CORE (recommended if you have it):**
Runs as a real always-on service in a jail — starts automatically when your
NAS boots, and restarts itself automatically if it ever crashes. Nobody
ever has to start a server. See **[deploy/TRUENAS-SETUP.md](deploy/TRUENAS-SETUP.md)**.

**Option B — Manual run on any Windows/Mac PC:** Good for trying it out, or
if you don't have a NAS. One PC has to run the server each time you want to
play. Instructions below.

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
4. **On the other kid's PC**, open a browser and go to
   `http://192.168.1.23:3000` (using the actual IP from step 2, port `3000`).
5. Whoever connects first is Player 1, the second is Player 2. Once both
   are connected, ship placement starts automatically.

Both PCs need to be on the **same WiFi/network** for this to work. If the
second PC can't connect, it's almost always a firewall prompt on the host
PC — click "Allow" if Windows/Mac asks whether Node.js can accept network
connections.

## How to play

1. **Enter your name:** Each kid types their name on their own PC first.
   This is remembered by their browser, so next time they play it's
   already filled in.
2. **Placement:** Each player places 5 ships (Carrier, Battleship, Cruiser,
   Submarine, Destroyer) by clicking a starting cell on their own grid.
   Use the "Rotate" button to switch between horizontal/vertical before
   placing. Or just hit "Random placement" to skip straight to battle.
3. Click **Ready** once all 5 ships are placed.
4. **Battle:** Players take turns clicking cells on the enemy grid to fire.
   Hits, misses, and sunk ships are shown live to both players, with sound
   effects and explosion/splash animations.
5. First to sink all 5 of the opponent's ships wins — confetti and a
   victory jingle included. Hit **Play again** for a rematch — no need to
   restart the server, and names/scores carry over automatically.

## Scoreboard & names

- The scoreboard at the top tracks total wins per name and updates live.
- Win counts are saved to a `scores.json` file next to `server.js` on the
  host PC, so they survive server restarts — if the kids play again
  tomorrow, their tally from last time is still there.
- Each PC also remembers the name typed into it (via the browser), so kids
  won't need to retype their name every session — just confirm it.
- Names are shared across the whole household network, so make sure each
  kid always uses the same name if you want their win count to keep
  accumulating correctly.

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
  which is exactly what you want for two kids playing each other.
- **Option B only:** to stop the server, click into the terminal window and
  press `Ctrl+C`. (On the TrueNAS setup, use `service battleship stop`
  instead — see the deploy guide.)
- Only two players can be connected at once; a third browser tab will just
  see "Game is full."
- If you ever want to wipe the scoreboard clean, just delete `scores.json`
  (next to `server.js`) and restart the server — it'll start a fresh one
  automatically.
- If one kid's browser refreshes, closes, or briefly loses WiFi mid-game,
  the other kid will see a "Reload page" prompt — that's expected, since a
  2-player game can't continue without both players. Just have both kids
  reload and reconnect to start a fresh game.
