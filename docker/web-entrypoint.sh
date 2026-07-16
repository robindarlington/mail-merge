#!/bin/sh
# Web service entrypoint (08-01).
#
# Only the WEB service migrates — the worker never races migrations (RESEARCH
# Pitfall 10; drizzle tracks applied migrations so this is idempotent). We run
# the bundled migrate.js, then `exec` the standalone server so `node server.js`
# becomes the container's PID-1-relevant process with a clean signal path
# (SIGTERM reaches node directly, not a shell wrapper — RESEARCH Pitfall 3).
set -e

echo "[web-entrypoint] applying migrations (node migrate.js)"
node migrate.js

echo "[web-entrypoint] starting standalone server (exec node server.js)"
exec node server.js
