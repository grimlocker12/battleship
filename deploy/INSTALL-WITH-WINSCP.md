# Installing Battleship on TrueNAS CORE using WinSCP (Windows, no terminal experience needed)

This walks through getting the game running permanently on your TrueNAS box,
using only:
- **WinSCP** (which you already have) to copy files over
- **TrueNAS's own web interface** for everything else — including a built-in
  "Shell" button, so you don't need a separate SSH/terminal program

You'll type exactly **two commands**, both given to you below as copy-paste
blocks into that web Shell — nothing else.

---

## What you'll need before starting

- Your TrueNAS box's IP address (e.g. `192.168.1.10`) — this is what you use
  to reach the TrueNAS web UI in your browser.
- Your TrueNAS **root password** (the one you use to log into the TrueNAS web
  UI). WinSCP will ask for this — nobody else needs it, and you type it
  directly into WinSCP yourself.
- The `battleship.zip` file (provided alongside this guide).

---

## Step 1 — Create the jail (a lightweight sandboxed app environment)

1. Open the TrueNAS web UI in your browser (`http://<your-NAS-IP>`) and log in.
2. Go to **Jails → Add Jail**.
3. Name it `battleship`.
4. Leave the FreeBSD release at whatever default is offered.
5. Under **Networking**, either give it a static IP on your home network
   (recommended — e.g. `192.168.1.50`, with your router as gateway) or leave
   it on DHCP if that's simpler for you.
6. Make sure **Boot** ("start on boot") is checked.
7. Click **Save**. If the jail doesn't start by itself, select it in the list
   and click **Start**.

## Step 2 — Turn on SSH so WinSCP can connect

WinSCP needs a way in. TrueNAS CORE has this built in but it's off by default:

1. In the TrueNAS web UI, go to **Services**.
2. Find **SSH** in the list. Click the **pencil/edit** icon next to it.
3. Turn on **"Log in as Root with Password"** and click Save.
4. Toggle the **SSH service switch to ON** (running), and also enable
   **"Start Automatically"** if you'd like it to stay available (you can turn
   it back off later once you're done, if you'd rather not leave it on
   permanently — it's your call, and this only matters on your home network).

## Step 3 — Connect WinSCP and copy the game files in

1. Open **WinSCP**.
2. New site:
   - **File protocol:** SFTP
   - **Host name:** your TrueNAS IP (e.g. `192.168.1.10`)
   - **Port:** 22
   - **User name:** `root`
   - **Password:** your TrueNAS root password
3. Click **Login**. You may get a warning about an unknown host key the first
   time — that's normal for a first connection to your own NAS; click Yes/Continue.
4. In the right-hand file panel (the NAS side), navigate to:
   ```
   /mnt/<your-pool-name>/iocage/jails/battleship/root/usr/local/
   ```
   Replace `<your-pool-name>` with your actual ZFS pool's name — if you're not
   sure what it's called, go to **Storage** in the TrueNAS web UI, or just
   look at the top-level folder names shown when you navigate to `/mnt/` in
   WinSCP; there'll be exactly one that isn't `.system`.
5. In the left-hand panel (your PC), navigate to wherever you saved
   `battleship.zip` and unzip it locally first (right-click → Extract All in
   Windows Explorer). You should end up with a folder called `battleship`
   containing `server.js`, `public`, `deploy`, etc.
6. Drag that local `battleship` folder from the left panel into the
   `.../usr/local/` folder on the right panel. WinSCP will upload the whole
   thing. When it's done, rename it on the NAS side (right-click → Rename in
   WinSCP) from `battleship` to `battleship-src`.

## Step 4 — Run the installer inside the jail

This is the only part that needs typed commands, and it's just copy-paste:

1. Back in the TrueNAS web UI, go to **Jails**, click on `battleship`, and
   click the **Shell** button (opens a terminal right in your browser — no
   extra software needed).
2. Copy-paste this, press Enter:
   ```
   cd /usr/local/battleship-src
   ```
3. Then copy-paste this, press Enter, and wait — it installs Node.js and sets
   everything up, so it can take a minute or two the first time:
   ```
   sh deploy/install-truenas.sh
   ```
4. You should see a "Done!" message at the end with a summary of what to do
   next. If anything prints in red/looks like an error, copy the text and
   share it — that's the only troubleshooting signal needed.

## Step 5 — Play!

1. Still in that Shell, run `ifconfig` and note the jail's IP address (or
   check the IP shown next to `battleship` in the Jails list in the web UI).
2. On each kid's PC, open a browser to:
   ```
   http://<jail-ip>:3000
   ```
3. Bookmark it. From now on the game is just always there — no server to
   start, ever.

---

## Afterwards: turning SSH back off (optional)

If you'd rather not leave root-password SSH login enabled on your NAS
long-term, go back to **Services → SSH**, turn "Log in as Root with Password"
back off, and stop the service — you only needed it for this one file
transfer. You can always turn it back on the same way if you need to update
the game later.

## Updating the game later

Repeat Steps 3–4 with a new `battleship.zip` (upload to `battleship-src`
again, overwriting the old copy — WinSCP will ask about each file, choose
"Yes to all" — but do **not** overwrite `scores.json` if WinSCP shows it,
since that's the kids' saved win history), then inside the jail run:
```
service battleship restart
```

## If something goes wrong

- **WinSCP can't connect:** double check SSH is toggled on in step 2, and
  that you're using the TrueNAS box's IP, not the jail's IP, for the WinSCP
  connection (WinSCP talks to the NAS host; the jail's IP is only used later,
  in your browser, to play the game).
- **The install script errors on `pkg install -y node`:** run `pkg update`
  first in the same Shell, then re-run the install script.
- **Browser can't reach `http://<jail-ip>:3000`:** confirm the jail is
  running (Jails list in the web UI) and that you used the *jail's* IP, not
  the NAS's own IP, for this step.
