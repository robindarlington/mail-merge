#!/bin/sh
# Web service entrypoint (08-01, ownership repair added at the 08-05 checkpoint).
#
# OWNERSHIP REPAIR (root → drop to node). The container starts as root so this
# entrypoint can fix /data ownership before any DB write, then re-execs itself
# as the unprivileged `node` user (same PID — the tini signal path is intact).
# Why: a /data volume that predates the hardened image (the pre-phase-8 staging
# skeleton ran as root) carries root-owned app.db/-wal/uploads; named volumes
# only inherit image ownership on FIRST mount, so migrate.js hit
# SQLITE_READONLY on the standing staging volume. `find ! -user node` makes the
# repair idempotent and near-free when ownership is already correct. The worker
# service never runs as root at all — compose pins `user: node` and gates it on
# web's healthcheck, which only passes after this repair + migrations.
set -e

if [ "$(id -u)" = "0" ]; then
  echo "[web-entrypoint] repairing /data ownership (root, pre-drop)"
  find /data ! -user node -exec chown node:node {} +
  echo "[web-entrypoint] dropping privileges (setpriv -> node)"
  exec setpriv --reuid node --regid node --clear-groups "$0" "$@"
fi

# Only the WEB service migrates — the worker never races migrations (RESEARCH
# Pitfall 10; drizzle tracks applied migrations so this is idempotent). We run
# the bundled migrate.js, then `exec` the standalone server so `node server.js`
# becomes the container's PID-1-relevant process with a clean signal path
# (SIGTERM reaches node directly, not a shell wrapper — RESEARCH Pitfall 3).

echo "[web-entrypoint] applying migrations (node migrate.js)"
node migrate.js

echo "[web-entrypoint] starting standalone server (exec node server.js)"
exec node server.js
