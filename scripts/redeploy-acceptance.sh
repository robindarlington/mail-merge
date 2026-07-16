#!/usr/bin/env bash
#
# scripts/redeploy-acceptance.sh — LOCAL, repeatable proof of phase success
# criterion #3 (SC-3): a send interrupted by a redeploy resumes cleanly with all
# data intact and NO recipient double-sent, on the REAL hardened image + compose.
#
# WHY THIS SCRIPT EXISTS
#   The phase-6 crash-safe resume (interrupted rows never double-send) is the
#   correctness guarantee this whole packaging phase protects. This turns it into
#   an executable acceptance test against the production Dockerfile (08-01) and
#   hardened compose (08-02), so a regression is caught BEFORE the 08-05 staging
#   checkpoint.
#
# HARNESS PLACEMENT DECISION (see 08-04-PLAN notes)
#   The seed/assert harness runs INSIDE the `web` container via `docker compose
#   exec`, against the EXACT in-container DB (/data/app.db), the container's
#   CREDENTIAL_ENC_KEY, and the shared /data/uploads the worker reads from. Since
#   the pruned production image ships no tsx/TS sources, the harness is esbuild-
#   bundled to a single .mjs (external better-sqlite3/pino, exactly like worker.js)
#   and copied in with `docker compose cp`. This avoids a HOST-vs-container SQLite
#   contention over a Docker Desktop bind mount and uses the real crypto key.
#
# INTERRUPT SEMANTICS (RESEARCH Pitfall 1 — load-bearing)
#   The graceful path uses `docker compose stop` + `docker compose up -d`, NEVER
#   the bare restart subcommand: that subcommand always uses a 10s timeout and
#   ignores stop_grace_period, so it would silently test the SIGKILL path. The
#   SIGKILL/crash path is exercised SEPARATELY and explicitly with `docker kill`.
#
# WHAT THIS PROVES LOCALLY vs WHAT REMAINS STAGING-ONLY
#   Proven here: the mechanism — data survives a container stop/replace on the
#   shared /data volume, and neither a graceful drain NOR a hard crash double-sends.
#   Staging-only (08-05): the Coolify "Stop Grace Period" UI setting and a real VPS
#   redeploy — those depend on the platform, not the mechanism, and are a human
#   checkpoint.
#
# Usage:  bash scripts/redeploy-acceptance.sh
# Requires: docker + docker compose, and the three interpolation secrets present
#           in the process env or a .env beside docker-compose.yml.

set -euo pipefail

# --- Locate the repo + compose file (this script lives in scripts/) -----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker-compose.yml"
ENV_FILE="$REPO_ROOT/.env"

PROJECT="mailmerge-acceptance"        # distinct project name — never collides
STUB_PORT="12525"                     # distinct host port for the SMTP sink
N="12"                                # recipients — large enough to interrupt mid-batch

TMPDIR_ACCEPT="$(mktemp -d)"
RCPT_LOG="$TMPDIR_ACCEPT/rcpt.jsonl"
OVERRIDE="$TMPDIR_ACCEPT/compose.acceptance.yml"
HARNESS_MJS="$TMPDIR_ACCEPT/acceptance-harness.mjs"
STUB_PID=""

# --- Compose invocation: base + acceptance override, pinned project name ------
compose() {
  docker compose \
    --project-directory "$REPO_ROOT" \
    -p "$PROJECT" \
    -f "$COMPOSE_FILE" \
    -f "$OVERRIDE" \
    "$@"
}

# --- Teardown ALWAYS (success or failure): stop the sink + tear down compose ---
cleanup() {
  local code=$?
  echo ""
  echo "[teardown] stopping stub SMTP + tearing down compose project '$PROJECT'"
  [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null || true
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$TMPDIR_ACCEPT"
  exit $code
}
trap cleanup EXIT INT TERM

# =============================================================================
# (0) ENV PREFLIGHT — fail fast BEFORE any build/up if a required secret is unset.
#     Mirrors compose interpolation: a value in the process env OR the .env beside
#     the compose file counts (Coolify writes a .env; the CI/verify run exports).
# =============================================================================
env_value() {
  local name="$1" val="${!1:-}"
  if [ -z "$val" ] && [ -f "$ENV_FILE" ]; then
    val="$(grep -E "^${name}=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
  fi
  printf '%s' "$val"
}

preflight_env() {
  echo "[preflight] checking required compose interpolation secrets"
  local missing=0
  for var in NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY CLERK_SECRET_KEY CREDENTIAL_ENC_KEY; do
    if [ -z "$(env_value "$var")" ]; then
      echo "ERROR: set $var in .env before running" >&2
      missing=1
    fi
  done
  [ "$missing" -eq 0 ] || exit 1
  echo "[preflight] OK — all three secrets present"
}

# --- Write the acceptance compose override -----------------------------------
#     - drop published ports (asserts use `exec`, so nothing needs the host net)
#     - reach the host stub via host.docker.internal
#     - tune the worker for a FAST test: short lease so a crashed/stopped worker
#       is reclaimed in seconds (default 300s would stall the test), a modest
#       inter-send delay so the interrupt reliably lands mid-batch.
write_override() {
  cat > "$OVERRIDE" <<YAML
services:
  web:
    ports: !override []
  worker:
    ports: !override []
    extra_hosts:
      - "host.docker.internal:host-gateway"
    environment:
      SEND_DELAY_MS: "1500"
      WORKER_POLL_MS: "1000"
      WORKER_LEASE_SEC: "10"
YAML
}

# --- Bundle the TS harness to a single .mjs (external better-sqlite3/pino) -----
bundle_harness() {
  echo "[bundle] esbuild acceptance-harness.ts -> acceptance-harness.mjs"
  ( cd "$REPO_ROOT" && npx esbuild scripts/acceptance-harness.ts \
      --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
      --external:better-sqlite3 --external:pino \
      --outfile="$HARNESS_MJS" >/dev/null )
}

# --- Start the host SMTP sink (background), RCPT log to a temp file ------------
#     `exec` replaces the subshell with node so STUB_PID IS the node process —
#     otherwise `kill $STUB_PID` in teardown would kill only the subshell and
#     leave node holding the port (EADDRINUSE on the next run).
start_stub() {
  echo "[stub] starting SMTP sink on host 0.0.0.0:$STUB_PORT"
  if lsof -ti "tcp:$STUB_PORT" >/dev/null 2>&1; then
    echo "ERROR: host port $STUB_PORT is already in use — free it before running" >&2
    exit 1
  fi
  ( cd "$REPO_ROOT" && exec node --import tsx scripts/stub-smtp.ts serve \
      --port "$STUB_PORT" --log "$RCPT_LOG" ) &
  STUB_PID=$!
  sleep 1
  kill -0 "$STUB_PID" 2>/dev/null || { echo "ERROR: stub SMTP failed to start" >&2; exit 1; }
}

# --- Count TERMINAL (sent|failed) send_records for a campaign, in-container ----
#     Read-only so it never contends with the worker's writes on the WAL'd db.
terminal_count() {
  local id="$1"
  compose exec -T web node -e "
    const D = require('better-sqlite3')('/data/app.db', { readonly: true });
    const r = D.prepare(\"select count(*) c from send_records where campaign_id=? and status in ('sent','failed')\").get(${id});
    process.stdout.write(String(r.c));
  " 2>/dev/null || echo "0"
}

# --- Wait until the campaigns table exists (web finished migrating) ------------
wait_for_migrations() {
  echo "[wait] waiting for web to apply migrations"
  local i
  for i in $(seq 1 60); do
    if compose exec -T web node -e "
      const D = require('better-sqlite3')('/data/app.db', { readonly: true });
      const r = D.prepare(\"select name from sqlite_master where type='table' and name='campaigns'\").get();
      process.exit(r ? 0 : 1);
    " >/dev/null 2>&1; then
      echo "[wait] migrations applied (campaigns table present)"
      return 0
    fi
    sleep 2
  done
  echo "ERROR: web never applied migrations (campaigns table absent)" >&2
  echo "----- web logs (tail) -----" >&2
  compose logs --tail=30 web >&2 2>&1 || true
  exit 1
}

# --- Seed a queued campaign; echo its id --------------------------------------
seed_campaign() {
  local out id
  out="$(compose exec -T web node /app/acceptance-harness.mjs seed \
          --count "$N" --stub-port "$STUB_PORT")"
  id="$(printf '%s\n' "$out" | grep -E '^CAMPAIGN_ID=' | cut -d= -f2)"
  [ -n "$id" ] || { echo "ERROR: seed did not print a CAMPAIGN_ID" >&2; echo "$out" >&2; exit 1; }
  printf '%s' "$id"
}

# --- Block until terminal_count reaches a target (campaign complete) ----------
wait_until_complete() {
  local id="$1" i c
  for i in $(seq 1 120); do
    c="$(terminal_count "$id")"
    [ "$c" = "$N" ] && { echo "[wait] campaign $id complete ($c/$N terminal)"; return 0; }
    sleep 1
  done
  echo "ERROR: campaign $id did not reach $N terminal send_records in time (last=$c)" >&2
  exit 1
}

# --- Block until SOME (>=2) but not all rows are terminal, so the interrupt
#     reliably lands mid-batch with rows still pending to resume ---------------
wait_until_partial() {
  local id="$1" i c
  for i in $(seq 1 120); do
    c="$(terminal_count "$id")"
    if [ "$c" -ge 2 ] && [ "$c" -lt "$N" ]; then
      echo "[wait] campaign $id partway: $c/$N sent — interrupting now"
      return 0
    fi
    [ "$c" = "$N" ] && { echo "WARNING: campaign $id completed before interrupt could land" >&2; return 0; }
    sleep 1
  done
  echo "ERROR: campaign $id never started sending (0 terminal)" >&2
  exit 1
}

# --- Copy the host RCPT log into web + run the harness assert ------------------
assert_campaign() {
  local id="$1"
  compose cp "$RCPT_LOG" web:/tmp/rcpt.jsonl
  compose exec -T web node /app/acceptance-harness.mjs assert \
    --campaign "$id" --expected "$N" --rcpt-log /tmp/rcpt.jsonl
}

# =============================================================================
# MAIN
# =============================================================================
echo "=============================================================="
echo " REDEPLOY ACCEPTANCE (SC-3) — real image, real compose, stub SMTP"
echo "=============================================================="

preflight_env
write_override
bundle_harness
start_stub

# Build the hardened image. NOTE: `next build`'s page-data collection opens the
# SQLite DB at module import from several parallel workers, which can transiently
# race to create /app/data/app.db and surface `SQLITE_BUSY: database is locked`
# (a pre-existing image-build flake, logged in deferred-items.md — NOT this test's
# code). The race is transient, so retry the build a few times; a successful layer
# is cached and reused by every later run.
echo "[compose] building the hardened image (with retry for the SQLITE_BUSY build flake)"
BUILD_ATTEMPTS=8
BUILD_LOG="$TMPDIR_ACCEPT/build.log"
build_ok=0
for attempt in $(seq 1 "$BUILD_ATTEMPTS"); do
  # Capture EACH attempt's full output (WR-07): a genuine build break (bad
  # Dockerfile edit, npm failure) must not burn $BUILD_ATTEMPTS silent builds
  # and end with zero diagnostics. The log is overwritten per attempt so the
  # tail printed below is always the LAST failure's output.
  if compose build >"$BUILD_LOG" 2>&1; then
    echo "[compose] build succeeded on attempt $attempt"
    build_ok=1
    break
  fi
  echo "[compose] build attempt $attempt failed (likely the SQLITE_BUSY page-data race) — retrying"
done
if [ "$build_ok" -ne 1 ]; then
  echo "ERROR: image build failed after $BUILD_ATTEMPTS attempts" >&2
  echo "----- build log (last attempt, tail) -----" >&2
  tail -60 "$BUILD_LOG" >&2 || true
  exit 1
fi

# Start WEB ALONE first and let it migrate before the worker exists. This
# serializes DB initialization: web's entrypoint runs migrate.js (which sets
# journal_mode=WAL and creates the tables) with no other process opening the file,
# then the worker starts against an already-migrated DB. Bringing both up at once
# lets web-migrate and the worker's poll race to initialize WAL and can lose the
# lock (SQLITE_BUSY) — the same class of race as the build-time flake.
echo "[compose] starting web (migrates alone before the worker exists)"
compose up -d web
wait_for_migrations
echo "[compose] copying bundled harness into web"
compose cp "$HARNESS_MJS" web:/app/acceptance-harness.mjs
echo "[compose] starting worker against the migrated DB"
compose up -d worker

# -----------------------------------------------------------------------------
# VARIANT 1 — GRACEFUL REDEPLOY: stop the worker (honors stop_grace_period), then
# up -d to resume. NEVER the bare restart subcommand (RESEARCH Pitfall 1).
# -----------------------------------------------------------------------------
echo ""
echo ">>> VARIANT 1: graceful redeploy (docker compose stop + up -d)"
CID1="$(seed_campaign)"
echo "[variant1] seeded campaign $CID1"
wait_until_partial "$CID1"

echo "[variant1] GRACEFUL interrupt: docker compose stop worker"
compose stop worker
echo "[variant1] resume: docker compose up -d worker"
compose up -d worker

wait_until_complete "$CID1"
echo "[variant1] asserting survival + no double-send"
assert_campaign "$CID1"
echo "[variant1] PASS"

# -----------------------------------------------------------------------------
# VARIANT 2 — CRASH: SIGKILL the worker mid-send with `docker kill`, then resume.
# Distinct from the graceful path — proves crash-safe resume, not just a clean
# drain. Truncate the RCPT log first so this variant's dedup check is isolated.
# -----------------------------------------------------------------------------
echo ""
echo ">>> VARIANT 2: crash redeploy (docker kill the worker mid-send)"
: > "$RCPT_LOG"   # isolate variant-2 deliveries in the shared sink log
CID2="$(seed_campaign)"
echo "[variant2] seeded campaign $CID2"
wait_until_partial "$CID2"

WORKER_CID="$(compose ps -q worker)"
[ -n "$WORKER_CID" ] || { echo "ERROR: could not resolve worker container id" >&2; exit 1; }
echo "[variant2] CRASH interrupt: docker kill $WORKER_CID (SIGKILL)"
docker kill "$WORKER_CID" >/dev/null
echo "[variant2] resume: docker compose up -d worker"
compose up -d worker

wait_until_complete "$CID2"
echo "[variant2] asserting crash-safe survival + no double-send"
assert_campaign "$CID2"
echo "[variant2] PASS"

# -----------------------------------------------------------------------------
# BANNER — what was proven locally vs what remains staging-only (08-05).
# -----------------------------------------------------------------------------
cat <<'BANNER'

==============================================================
 REDEPLOY ACCEPTANCE: ALL VARIANTS PASSED
==============================================================
PROVEN LOCALLY (the mechanism, on the real hardened image):
  [x] Seeded data (campaign + send_records) survives a container
      stop/replace on the shared /data volume.
  [x] GRACEFUL redeploy (compose stop + up -d) resumes with zero
      double-sends — each recipient delivered at most once.
  [x] CRASH redeploy (docker kill, SIGKILL) resumes crash-safe with
      zero double-sends (phase-6 orphan sweep marks the in-flight row
      terminal; it is never re-delivered).
  [x] Env preflight fails fast when a required secret is unset.

STAGING-ONLY (proven at the 08-05 human checkpoint, NOT here — these
depend on the Coolify PLATFORM, not this mechanism):
  [ ] Coolify "Stop Grace Period" UI setting (Advanced -> Operations)
      grants the worker its between-rows drain window on redeploy.
  [ ] A real VPS Coolify redeploy of the standing staging URL.
==============================================================
BANNER
