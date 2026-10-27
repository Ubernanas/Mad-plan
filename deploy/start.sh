#!/bin/sh
# Container entrypoint. Runs as root just long enough to prepare the volume, then
# starts the server as the unprivileged "node" user.
set -eu

mkdir -p /data/jobdir
# A backup before the new code opens the database. A failure is logged, but the site still starts.
node src/backup.ts || true
chown -R node:node /data

exec setpriv --reuid=node --regid=node --init-groups \
  env HOME=/home/node \
  node src/server.ts
