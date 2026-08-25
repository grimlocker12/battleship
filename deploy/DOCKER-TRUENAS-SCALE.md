# Running Battleship as a Docker app on TrueNAS SCALE

This is the current recommended way to run the game permanently — it
replaces the old iocage-jail setup in `TRUENAS-SETUP.md` (kept only for
reference; SCALE doesn't use iocage jails). SCALE's "Apps" system runs
containers under the hood via k3s/containerd, and has a "Custom App" UI for
running an arbitrary Docker image — that's what this uses.

Once set up: the container starts automatically when the NAS boots, and
Kubernetes restarts it automatically if it ever crashes. Nobody ever starts
a server manually.

## The image lives on GitHub Container Registry

The built image is pushed to `ghcr.io/grimlocker12/battleship`, tagged
both `1.1.0` and `latest`. SCALE pulls it directly — no file transfer to
the NAS needed for a normal update.

**Before SCALE can pull it: make the package public (one-time).** GHCR
packages are private by default, and a private package needs a registry
pull secret configured in SCALE, which is extra setup for no real benefit
here — there's nothing sensitive in this image, it's just the game. On
GitHub: your profile → **Packages** → **battleship** → **Package settings**
(bottom right) → **Change visibility** → **Public**. If you'd rather keep
it private instead, SCALE's Custom App form has a "Container Registry
Credentials" section where you can add a GitHub Personal Access Token
(scope `read:packages`) — mentioned here for completeness, but public is
simpler and is what the rest of this guide assumes.

**Alternative, if you'd rather not use a registry at all:** you can still
build the image yourself and import it directly into SCALE's local
containerd store with no registry involved —
`docker save battleship:latest | gzip > battleship-image.tar.gz`, copy that
onto the NAS, then from a host shell:
```sh
k3s ctr -n k8s.io images import /path/to/battleship-image.tar.gz
```
If you go this route, use `battleship` (not `ghcr.io/...`) as the image
repository in step 4 below.

## 1. Create a dataset for the persistent scoreboard

In the TrueNAS UI: **Datasets** → create a new dataset under a pool of your
choice, e.g. `<your-pool>/apps/battleship-data`. This is where
`scores.json` (win totals + recent match history) will live, so it survives
container restarts, updates, and crashes.

The container runs as a non-root user (uid 1000, gid 1000) for security, so
that dataset needs to be writable by uid 1000. From a host shell:
```sh
chown -R 1000:1000 /mnt/<your-pool>/apps/battleship-data
```
(If you'd rather not do this, the Custom App form below also has a
"Run As" UID/GID override you can set to `1000:1000` — or `0:0` to just run
the container as root and skip the chown, which is fine for a
home/LAN-only, two-kids setup if you'd prefer the simplicity.)

## 2. Create the Custom App

TrueNAS UI → **Apps** → **Discover Apps** → **Custom App** (top right).

- **Application Name:** `battleship`
- **Image repository:** `ghcr.io/grimlocker12/battleship`  **Image tag:**
  `1.1.0` (or `latest`)
  **Image pull policy:** `IfNotPresent` (pulls once, reuses it after that —
  switch to `Always` if you want it to check for a newer `latest` on every
  restart instead).
- **Container Port:** `3000`, protocol TCP → **Node Port**: pick a free
  port in the range the UI shows you (e.g. `30300`). This is the port
  you'll actually browse to.
- **Storage → Host Path Volumes:** add one — Host Path =
  `/mnt/<your-pool>/apps/battleship-data`, Mount Path = `/data`.
- Leave everything else at its default (no extra environment variables are
  needed — the image already defaults `BATTLESHIP_SCORES_FILE` to
  `/data/scores.json`).

Click **Install**. Give it a minute; check **Apps → Installed Apps →
battleship** for status, and the **Logs** tab there if it doesn't come up
(look for the same "Battleship server running!" banner you'd see running
it locally). If it fails to pull the image, double check the package was
made public in the step above.

## 3. Connect from your kids' PCs

Find your NAS's IP (or hostname, if you have one set up), then browse to:
```
http://<nas-ip>:<the node port you chose, e.g. 30300>
```
Bookmark it on both PCs.

## 4. Confirm crash-recovery and reboot behavior

Worth testing once so you trust it, same idea as the old jail setup:
- **Crash recovery:** Apps → battleship → stop the pod (or `k3s kubectl
  delete pod -n ix-battleship <pod-name>`) and confirm Kubernetes brings a
  new one back up within a few seconds, and the scoreboard is unchanged.
- **Reboot recovery:** reboot the NAS and confirm the app is reachable
  again once it's back up, no manual steps.

## Notes

- **Updating the game later:** build and push a new image tag (e.g.
  `docker build -t ghcr.io/grimlocker12/battleship:1.2.0 . && docker push
  ghcr.io/grimlocker12/battleship:1.2.0`), then edit the Custom App and
  bump the image tag to match. `scores.json` lives on the separate dataset,
  untouched by app updates.
- **Migrating your old TrueNAS CORE scoreboard:** if you have a
  `scores.json` from the old jail setup, copy it into the new dataset
  before first start — the server auto-detects and upgrades the old
  flat `{name: count}` format to the new one (which also tracks recent
  match history) the first time it loads.
- **Changing the port later:** edit the Custom App's Node Port setting and
  update the bookmarked URL on both kids' PCs.
- This all stays LAN-only by design — the Node Port is only reachable on
  your local network, same as the old setup.
