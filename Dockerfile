# Battleship LAN server — container image
#
# Single small image: Node + the one dependency (ws) + the app. No build
# step for the client (public/index.html is plain HTML/CSS/JS, served as-is).
#
# The scoreboard (scores.json) is written to /data, which you should mount
# as a persistent volume — otherwise win counts and match history reset
# every time the container restarts.

FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public

ENV PORT=3000
ENV BATTLESHIP_SCORES_FILE=/data/scores.json

# /data is owned by the built-in non-root "node" user (uid 1000, from the
# official node:alpine image) so the container doesn't need to run as root.
# If you bind-mount a host directory here, chown it to 1000:1000 on the
# host first (see deploy/DOCKER-TRUENAS-SCALE.md), or override the
# container's UID/GID to 0 in the TrueNAS SCALE app config instead.
RUN mkdir -p /data && chown -R node:node /data
USER node

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/ > /dev/null || exit 1

CMD ["node", "server.js"]
