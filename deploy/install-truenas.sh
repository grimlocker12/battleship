#!/bin/sh
# Run this INSIDE the jail, as root, from the extracted battleship folder:
#   sh deploy/install-truenas.sh
#
# It will:
#   1. Install Node.js via pkg (if not already installed)
#   2. Copy the app to /usr/local/battleship
#   3. Install its npm dependency (ws)
#   4. Install the rc.d service script
#   5. Enable and start the service (auto-starts on jail boot,
#      auto-restarts if it ever crashes)

set -e

if [ "$(id -u)" != "0" ]; then
  echo "This must be run as root inside the jail." >&2
  exit 1
fi

APP_DIR="/usr/local/battleship"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

echo "==> Installing Node.js (skips if already installed)..."
pkg install -y node || {
  echo "!! 'pkg install -y node' failed. Try 'pkg update' first, or run"
  echo "!! 'pkg search node' to find the exact package name on your release,"
  echo "!! then re-run this script with NODE_PKG=<name> sh deploy/install-truenas.sh"
  exit 1
}

echo "==> Deploying app files to ${APP_DIR}..."
mkdir -p "${APP_DIR}"
cp -R "${SCRIPT_DIR}/server.js" "${SCRIPT_DIR}/package.json" "${SCRIPT_DIR}/public" "${APP_DIR}/"

echo "==> Installing the 'ws' dependency..."
cd "${APP_DIR}"
npm install --omit=dev

echo "==> Installing the rc.d service script..."
cp "${SCRIPT_DIR}/deploy/battleship.rc" /usr/local/etc/rc.d/battleship
chmod +x /usr/local/etc/rc.d/battleship

echo "==> Enabling and starting the battleship service..."
sysrc battleship_enable="YES"
sysrc battleship_dir="${APP_DIR}"
service battleship start
sleep 1
service battleship status

echo ""
echo "============================================================"
echo " Done! Battleship is now running as a permanent service:"
echo "   - Starts automatically when this jail boots"
echo "   - Restarts automatically within a couple seconds if the"
echo "     node process ever crashes"
echo ""
echo " Find this jail's IP with: ifconfig"
echo " Then browse to: http://<jail-ip>:3000"
echo ""
echo " Logs:   tail -f /var/log/battleship.log"
echo " Status: service battleship status"
echo " Stop:   service battleship stop"
echo " Start:  service battleship start"
echo "============================================================"
