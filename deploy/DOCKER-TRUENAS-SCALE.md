# Running Battleship as a Docker app on TrueNAS SCALE

This is the current recommended way to run the game permanently — it
replaces the old iocage-jail setup in `TRUENAS-SETUP.md` (kept only for
reference; SCALE doesn't use iocage jails). SCALE's "Apps" system runs
containers under the hood via k3s/containerd, and has a "Custom App" UI for
running an arbitrary Docker image — that's what this uses.

Once set up: the container starts automatically when the NAS boots, and
Kubernetes restarts it automatically if it ever crashes. Nobody ever starts
a server manually.

## Two ways to get the image onto your NAS

You were given (or can build) a `battleship-image.tar.gz` file — this is
the whole app as a self-contained Docker image. There are two ways to use
it, pick whichever you prefer:

**Option A — Import the image directly (recommended: no accounts, nothing
leaves your network).** Copy the tar file onto the NAS and load it straight
into SCALE's local image store. Covered in step 2 below.

**Option B — Push to Docker Hub first.** If you'd rather pull the image
from a registry (e.g. so you can update it by just re-pulling a tag), build
and push it from your own PC:
```
docker build -t <your-dockerhub-username>/battleship:latest .
docker push <your-dockerhub-username>/battleship:latest
```
Then in step 4 below, use `docker.io/<your-dockerhub-username>/battleship`
as the image repository instead of importing a tar.

The rest of this guide assumes Option A.

## 1. Get `battleship-image.tar.gz` onto the NAS

Upload it to any dataset over SMB/SFTP, e.g. into
`/mnt/<your-pool>/apps/battleship/`. (If you don't have the tar file and
want to build it yourself instead: unzip the project source and run
`docker build -t battleship:latest .` in that folder on any machine with
Docker installed, then `docker save battleship:latest | gzip > battleship-image.tar.gz`.)

## 2. Import the image into SCALE

Open a shell on the TrueNAS host itself (System Settings → Shell in the UI,
or SSH), then:
```sh
k3s ctr -n k8s.io images import /mnt/<your-pool>/apps/battleship/battleship-image.tar.gz
```
This loads the image into the same containerd store the Apps system pulls
from, tagged `battleship:1.1.0` and `battleship:latest` — no registry, no
internet access needed. Confirm it's there:
```sh
k3s ctr -n k8s.io images ls | grep battleship
```

## 3. Create a dataset for the persistent scoreboard

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

## 4. Create the Custom App

TrueNAS UI → **Apps** → **Discover Apps** → **Custom App** (top right).

- **Application Name:** `battleship`
- **Image repository:** `battleship`  **Image tag:** `1.1.0` (or `latest`)
  **Image pull policy:** `IfNotPresent` — this is important: it tells
  Kubernetes to use the image you just imported instead of trying to pull
  from Docker Hub (there is no public `battleship` image).
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
it locally).

## 5. Connect from your kids' PCs

Find your NAS's IP (or hostname, if you have one set up), then browse to:
```
http://<nas-ip>:<the node port you chose, e.g. 30300>
```
Bookmark it on both PCs.

## 6. Confirm crash-recovery and reboot behavior

Worth testing once so you trust it, same idea as the old jail setup:
- **Crash recovery:** Apps → battleship → stop the pod (or `k3s kubectl
  delete pod -n ix-battleship <pod-name>`) and confirm Kubernetes brings a
  new one back up within a few seconds, and the scoreboard is unchanged.
- **Reboot recovery:** reboot the NAS and confirm the app is reachable
  again once it's back up, no manual steps.

## Notes

- **Updating the game later:** build a new image, import it under a new
  tag (e.g. `1.2.0`), then edit the Custom App and bump the image tag.
  `scores.json` lives on the separate dataset, untouched by app updates.
- **Migrating your old TrueNAS CORE scoreboard:** if you have a
  `scores.json` from the old jail setup, copy it into the new dataset
  before first start — the server auto-detects and upgrades the old
  flat `{name: count}` format to the new one (which also tracks recent
  match history) the first time it loads.
- **Changing the port later:** edit the Custom App's Node Port setting and
  update the bookmarked URL on both kids' PCs.
- This all stays LAN-only by design — the Node Port is only reachable on
  your local network, same as the old setup.
