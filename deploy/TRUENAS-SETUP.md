# Running Battleship as a permanent service on TrueNAS CORE

This turns the game into something that's just always there — it starts when
your NAS boots, and if the process ever crashes, it comes back on its own
within a couple seconds. Your kids never need to start a server manually.

TrueNAS CORE runs jails via **iocage**, a lightweight FreeBSD container
system. Everything below happens either in the TrueNAS web UI or in a
terminal on the jail — no changes to your NAS's main storage/network setup
beyond creating one jail.

## 1. Create the jail

In the TrueNAS web UI:

1. Go to **Jails → Add Jail**.
2. Name it something like `battleship`.
3. Pick the newest available FreeBSD release (whatever iocage offers by
   default is fine — this app has no special OS version requirements).
4. Under **Networking**: give it a **static IP** on your LAN if you can
   (e.g. `192.168.1.50/24` with your router as the gateway) — this makes it
   easy for the kids to bookmark the same address every time. DHCP works
   too if that's easier for your setup.
5. Make sure **Boot** (or "start automatically") is checked — this is what
   makes the jail itself come up when your NAS reboots. (The service inside
   it auto-starts too, via steps below — you need both.)
6. Save, then start the jail if it doesn't start automatically.

## 2. Get the game files into the jail

The simplest way, from a **TrueNAS host shell** (System Settings → Shell in
the UI, or SSH into the NAS itself) — copy the extracted `battleship` folder
directly into the jail's filesystem:

```sh
cp -R /path/to/extracted/battleship /mnt/<your-pool>/iocage/jails/battleship/root/usr/local/battleship-src
```

Replace `<your-pool>` with your actual pool name, and `/path/to/extracted/battleship`
with wherever you unzipped `battleship.zip` on the NAS (e.g. after uploading
it to a dataset over SMB). If you're not sure of your pool name, check
**Storage** in the TrueNAS UI, or run `zfs list | grep iocage`.

*(Prefer not to touch the host shell? Alternative: use the **Storage** tab
to mount a dataset you already share over SMB into the jail — Jails →
`battleship` → Storage → Add Mount Point — then drag the extracted folder
into that share from any PC, and reference that path instead in step 3.)*

## 3. Install and start the game

Get a shell **inside the jail**:

```sh
iocage console battleship
```

Then, inside the jail:

```sh
cd /usr/local/battleship-src
sh deploy/install-truenas.sh
```

This installs Node.js, copies the app to `/usr/local/battleship`, installs
its one dependency, registers it as a proper FreeBSD service, and starts it.
You'll see a confirmation with the commands to check its status, view logs,
or stop/start it later.

## 4. Connect from your kids' PCs

Find the jail's IP address (shown in the TrueNAS Jails list, or run
`ifconfig` inside the jail). Then each kid opens a browser to:

```
http://<jail-ip>:3000
```

Bookmark it on both PCs and you're done — no server to start, ever again.

## 5. Confirm the crash-recovery and reboot behavior actually work

Worth testing once so you trust it:

**Crash recovery** — from inside the jail:
```sh
kill -9 $(cat /var/run/battleship.pid)
sleep 2
service battleship status
```
You should see it running again with a new PID within a couple seconds.

**Reboot recovery** — restart the jail (`iocage restart battleship` from the
TrueNAS host, or reboot the whole NAS) and confirm the game is reachable
again a minute or two later, with no manual steps.

## Notes

- **Scoreboard persistence:** `scores.json` lives inside the jail's own ZFS
  storage at `/usr/local/battleship/scores.json`, so it survives crashes and
  reboots automatically. It would only be lost if you later destroy and
  recreate the jail itself — if you ever do that, copy that file out first.
- **Logs:** `tail -f /var/log/battleship.log` inside the jail, if you ever
  want to see what happened around a restart.
- **Changing the port:** `iocage exec battleship sysrc battleship_port=4000`
  then `iocage exec battleship service battleship restart` (also update the
  bookmarked URL on both kids' PCs).
- **Updating the game later:** copy new files over the ones in
  `/usr/local/battleship` (leave `scores.json` alone) and run
  `service battleship restart` inside the jail.
- This all stays LAN-only — the jail isn't exposed to the internet, which is
  exactly what you want here.
