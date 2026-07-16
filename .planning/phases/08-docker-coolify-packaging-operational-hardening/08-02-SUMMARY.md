---
phase: 08-docker-coolify-packaging-operational-hardening
plan: 02
subsystem: deployment
tags: [docker, compose, coolify, env-contract, signals, hardening]
requires:
  - "docker/web-entrypoint.sh (plan 08-01) — referenced by path in web command"
  - "worker.js bundle (plan 08-01) — referenced by path in worker command"
provides:
  - "Production-hardened docker-compose.yml: init:true, stop_grace_period, exec-form node commands, worker maintenance tunables"
  - "Complete .env.example runtime + build-time var contract with Coolify literal/rebuild/plaintext caveats"
affects:
  - "lib/worker (plan 08-03) consumes WAL_CHECKPOINT_MS/ORPHAN_SWEEP_MS/ATTACHMENT_ORPHAN_DAYS"
  - "acceptance test (plan 08-04) exercises the compose signal path"
  - "Coolify grace value set at plan 08-05 checkpoint"
tech-stack:
  added: []
  patterns:
    - "exec-form container commands under init:true (tini PID1) for clean SIGTERM forwarding"
    - "${VAR:-default} compose interpolation so worker tunables are safe to omit"
key-files:
  created: []
  modified:
    - docker-compose.yml
    - .env.example
decisions:
  - "Kept stop_grace_period in compose despite Coolify overriding it on redeploy — costs nothing, protects local ops + acceptance test"
  - "Used image tag mail-merge:latest (was mail-merge:skeleton) to reflect production shape"
  - "web command set explicitly to /app/web-entrypoint.sh rather than relying on image default CMD"
metrics:
  duration: ~10m
  completed: 2026-07-16
  tasks: 2
  files: 2
---

# Phase 8 Plan 02: Compose Hardening & Env Contract Summary

Production-hardened `docker-compose.yml` (init:true PID-1 signal forwarding, 5m/1m
stop_grace_period, exec-form `node worker.js`, worker maintenance tunables) plus a
complete `.env.example` documenting every interpolated var with Coolify
literal/rebuild/plaintext caveats.

## What Was Built

### Task 1 — Hardened the two compose services (commit b22ee7c)
- Rewrote the SKELETON header to describe the now-production-hardened compose and
  the specific hardening applied.
- Added `init: true` to both `web` and `worker` so Docker's tini becomes PID 1,
  forwards SIGTERM to node, and reaps zombies (mitigates T-08-04).
- Replaced npx/sh entrypoints with exec-form commands: web →
  `["/app/web-entrypoint.sh"]`, worker → `["node", "worker.js"]`. No `npx` remains
  as an entrypoint (npx swallows SIGTERM and would kill the Phase-6 drain).
- Set `stop_grace_period: 1m` (web) and `5m` (worker) for a graceful between-rows
  drain even against a hung SMTP connection.
- Declared the new worker maintenance tunables on the worker service using
  `${VAR:-default}` interpolation so they are safe to omit:
  `WAL_CHECKPOINT_MS:-3600000`, `ORPHAN_SWEEP_MS:-3600000`, `ATTACHMENT_ORPHAN_DAYS:-7`.
- Preserved the shared `appdata:/data` volume on both services, `UPLOADS_PATH`,
  `DATABASE_PATH`, `HOSTNAME=0.0.0.0` on web, runtime-only secret injection
  (`CREDENTIAL_ENC_KEY`, `CLERK_SECRET_KEY`), the `web.build.args` Clerk block, and
  `depends_on: [web]` on the worker (only web migrates — T-08-06).
- Bumped image tag `mail-merge:skeleton` → `mail-merge:latest` to reflect the
  production shape (both services stay on one image).

### Task 2 — Completed .env.example wiring contract (commit 303ceb2)
- Added a header explaining the BUILD-TIME vs RUNTIME var split and the Coolify
  plaintext-at-`/data/coolify/applications/<id>/.env` caveat (the lock icon only
  hides in the UI; it is not encryption).
- Documented the `NEXT_PUBLIC_CLERK_*` set as build-time (inlined by `next build`
  via `build.args`; a change needs a REBUILD, not a restart; the Coolify "Build
  Variable" toggle is a no-op for compose apps).
- Marked `CREDENTIAL_ENC_KEY` and `CLERK_SECRET_KEY` as runtime-only secrets with a
  Coolify "Is Literal?" note (base64 can contain `$`/`@`).
- Added a background-worker section documenting the existing knobs
  (`SEND_DELAY_MS`, `WORKER_POLL_MS`, `WORKER_LEASE_SEC`) and the new maintenance
  tunables (`WAL_CHECKPOINT_MS`, `ORPHAN_SWEEP_MS`, `ATTACHMENT_ORPHAN_DAYS`) with
  one-line explanations, noting compose supplies the same defaults.

## Verification

- `docker compose config` (Docker Compose v2.35.1) resolves cleanly with the
  required interpolated secrets supplied via env.
- Automated token check confirmed the resolved compose contains `init: true`,
  `stop_grace_period`, `worker.js`, all three maintenance tunables, and `/data`,
  with no `npx` entrypoint.
- Automated key check confirmed `.env.example` contains all 9 required keys
  (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CREDENTIAL_ENC_KEY`, `CLERK_SECRET_KEY`,
  `DATABASE_PATH`, `UPLOADS_PATH`, `HOSTNAME`, `WAL_CHECKPOINT_MS`,
  `ORPHAN_SWEEP_MS`, `ATTACHMENT_ORPHAN_DAYS`).

## Deviations from Plan

None — plan executed exactly as written.

## Notes for Downstream Plans

- `worker.js` and `docker/web-entrypoint.sh` are authored by plan 08-01; compose
  only references them by path. They are exercised together in plan 08-04.
- `lib/worker` (plan 08-03) must read the three new tunables from the environment;
  compose already provides safe defaults.
- The Coolify UI grace value is set at the plan 08-05 checkpoint (Coolify's
  redeploy uses its own `docker stop --time`, not the compose key).

## Self-Check: PASSED
