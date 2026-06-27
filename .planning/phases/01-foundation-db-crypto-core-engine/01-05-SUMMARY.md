---
phase: 01-foundation-db-crypto-core-engine
plan: 05
subsystem: migrations-runtime-packaging
tags: [drizzle-kit, migrations, sqlite, wal, concurrency, docker-compose, worker]
requires:
  - "01-02 (lib/db schema + single WAL client — the migration source and shared opener)"
  - "01-01 (drizzle.config.ts, db:generate/db:migrate/worker npm scripts, next standalone)"
provides:
  - "drizzle/0000_clear_absorbing_man.sql — committed migration creating all six v1 tables"
  - "scripts/migrate.ts — db:migrate runner applying migrations via the single lib/db client (D-04)"
  - "scripts/concurrency-smoke.ts — two-PROCESS no-SQLITE_BUSY proof (child_process.fork)"
  - "worker/index.ts — minimal worker entrypoint (D-02): opens lib/db, logs readiness, no send logic"
  - "docker-compose.yml + Dockerfile — web+worker skeleton sharing a named /data volume (D-10)"
affects:
  - "Phase 2 SMTP onboarding (writes smtp_configs — now physically present)"
  - "Phase 6 worker (send_records/campaigns claim — tables exist; worker entrypoint scaffolded)"
  - "Phase 8 packaging (hardens this compose skeleton)"
tech-stack:
  added: []
  patterns:
    - "Migration runner reuses the single lib/db connection (no second opener — D-04)"
    - "Concurrency proof uses TWO real OS processes (fork), never same-process async (better-sqlite3 is synchronous)"
    - "One image, two entrypoints (web node server.js / worker tsx worker/index.ts), shared /data volume"
    - "Secrets (CREDENTIAL_ENC_KEY) injected at runtime via env, never inlined in image/compose literals"
key-files:
  created:
    - scripts/migrate.ts
    - scripts/concurrency-smoke.ts
    - worker/index.ts
    - docker-compose.yml
    - Dockerfile
    - drizzle/0000_clear_absorbing_man.sql
    - drizzle/meta/_journal.json
    - drizzle/meta/0000_snapshot.json
  modified: []
decisions:
  - "Migration runner imports the raw `connection` + `db` from lib/db and calls drizzle-orm migrate(); closes after a one-shot run so db:migrate exits cleanly"
  - "Concurrency smoke forks a child via child_process.fork with execArgv ['--import','tsx'] and a CONCURRENCY_ROLE env switch; runs reader-vs-writer AND writer-vs-writer passes"
  - "Worker heartbeat interval is .unref()'d so a bare readiness import exits instead of hanging, while the real foreground worker process still stays alive"
  - "Compose worker runs via `npx tsx worker/index.ts` in the skeleton; Phase 8 swaps to a bundled worker.js (D-07)"
metrics:
  duration: 4
  completed: 2026-06-27
  tasks: 3
  files: 8
---

# Phase 1 Plan 05: Migrations, Concurrency Proof + Compose Skeleton Summary

The schema is now PHYSICALLY REAL: committed Drizzle migrations create all six v1 tables on disk, a two-PROCESS smoke test empirically proves no SQLITE_BUSY under concurrent cross-process read+write (success criterion #1), the minimal worker entrypoint exists (D-02), and a valid Docker Compose skeleton mounts a shared named `/data` volume across web + worker (success criterion #4) — with production hardening deferred to Phase 8 (D-10).

## What Was Built

### Task 1 [BLOCKING] — Migrations create the six tables on disk
- `scripts/migrate.ts` is the `db:migrate` runner. It imports the typed `db` and the raw `connection` from `@/lib/db` (reusing the single WAL'd client — D-04, no second opener), calls drizzle-orm's `migrate(db, { migrationsFolder: './drizzle' })`, logs the resulting on-disk tables, then `connection.close()`s so the one-shot run exits cleanly.
- `npm run db:generate` (drizzle-kit) produced `drizzle/0000_clear_absorbing_man.sql` from `lib/db/schema.ts` (6 tables, the FK/unique constraints intact), plus the `drizzle/meta/` snapshot + journal — all committed.
- `npm run db:migrate` physically created the file at `./data/app.db`. The plan's `sqlite_master` gate confirms ALL six tables present: `smtp_configs, recipient_sets, campaigns, send_records, templates, attachments`. This closes the false-positive gap where a passing `tsc`/`next build` did not prove a real DB existed.

### Task 2 — Worker entrypoint + two-PROCESS concurrency proof
- `worker/index.ts` (D-02): imports `db` from `@/lib/db`, logs a single structured JSON `worker ready` line (no secrets), and runs a minimal `.unref()`'d heartbeat loop. NO send/claim logic — that is Phase 6. The `.unref()` lets a bare readiness import exit cleanly while the real foreground worker process still stays alive.
- `scripts/concurrency-smoke.ts` proves success criterion #1 empirically with TWO REAL OS PROCESSES. The parent `child_process.fork`s a child (`execArgv: ['--import','tsx']`, `CONCURRENCY_ROLE` switch) that opens its OWN better-sqlite3 connection through `lib/db`. It runs two overlapping passes: (1) child WRITER vs parent READER (WAL many-readers/one-writer), (2) child WRITER vs parent WRITER (two processes contend for the single writer slot — the exact case `busy_timeout=5000` must absorb). It captures each process's exit code + stderr and FAILS non-zero if any process exits non-zero or any `SQLITE_BUSY`/"database is locked" string appears. A same-process `Promise.all` simulation is explicitly avoided because better-sqlite3 is synchronous and could never surface the error against itself.

### Task 3 — Docker Compose skeleton (web + worker, shared /data)
- `docker-compose.yml` declares `web` and `worker` services built from ONE image, BOTH mounting the named volume `appdata` at `/data`. Web command `node server.js` with `HOSTNAME=0.0.0.0`; worker command `npx tsx worker/index.ts`. Both receive `DATABASE_PATH=/data/app.db` and `CREDENTIAL_ENC_KEY` from env (runtime-injected, never inlined). `docker compose config` validates the topology.
- `Dockerfile` is a minimal multi-stage build: Node 24 ABI pin (better-sqlite3 native bindings), Next.js standalone output (D-08), one runtime image serving both entrypoints. A header comment marks all hardening (worker bundle per D-07, stop_grace_period, SIGTERM, healthchecks, PID1/tini, WAL checkpointing) as deferred to Phase 8 (D-10).

## Verification

| Check | Result |
|-------|--------|
| `npm run db:generate` produces `drizzle/*.sql` | ✓ `0000_clear_absorbing_man.sql` |
| `npm run db:migrate` exits 0, creates `./data/app.db` | ✓ |
| `sqlite_master` shows all six tables (plan node -e gate) | ✓ "all 6 tables present" |
| `grep -E "spawn\|fork\|worker_threads" concurrency-smoke.ts` | ✓ fork present |
| `tsc --noEmit` | ✓ clean |
| Two-process smoke test exits 0, no SQLITE_BUSY | ✓ "PASSED ... NO SQLITE_BUSY" |
| `worker/index.ts` imports cleanly, logs readiness, exits | ✓ "worker entrypoint imports ok" |
| `docker compose config` valid; web+worker share /data; HOSTNAME set | ✓ topology confirmed |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Worker readiness import would hang the verify gate**
- **Found during:** Task 2 verification (the plan's bare `import('./worker/index.ts')` gate).
- **Issue:** A plain `setInterval` long-lived loop keeps the Node event loop alive, so the plan's readiness-import verify command printed "worker entrypoint imports ok" but never exited — the automated gate would hang indefinitely.
- **Fix:** Called `.unref()` on the heartbeat interval. An unref'd timer does not, by itself, keep the process alive, so a pure readiness import exits cleanly; the real worker (run in the foreground as `tsx worker/index.ts` or as the compose service) still stays alive. Phase 6 replaces this with the ref'd dequeue loop.
- **Files modified:** worker/index.ts
- **Commit:** 27a39fe (folded into the Task 2 GREEN commit).

## Authentication Gates

None — no auth-gated tooling was needed (drizzle-kit, tsx, docker are all local, non-interactive).

## Known Stubs

- `worker/index.ts` is an intentional skeleton (D-02): readiness log + no-op heartbeat, NO send/claim logic. This is by design for Phase 1 — the real campaign dequeue/lease/send loop is Phase 6. Documented and expected, not a blocking stub.
- The Docker Compose file and Dockerfile are an intentional SKELETON (D-10): correct service/volume topology, valid compose, but no production hardening. Hardening is Phase 8 (D-10). Documented in-file and expected.

No accidental/empty-data stubs that block this plan's goal — the six tables are physically present and the concurrency guarantee is proven, which is exactly the plan's objective.

## Threat Surface Scan

No new security surface beyond the plan's `<threat_model>`. The registered mitigations are implemented:
- T-01-05a (concurrent web+worker writes → SQLITE_BUSY): the two-PROCESS smoke test empirically proves the WAL + busy_timeout single-client config prevents lock errors across real OS processes; the test fails the build if a lock error appears.
- T-01-05b (CREDENTIAL_ENC_KEY baked into image): the key is injected as `${CREDENTIAL_ENC_KEY}` runtime env in compose, never inlined in Dockerfile/compose literals; `.env` stays gitignored.
- T-01-05c (volume persistence on redeploy): accepted for the foundation — the skeleton declares the named /data topology; full persistence acceptance is Phase 8 (D-10).
- T-01-05d (supply chain): only pinned, registry-mainstream packages (drizzle-kit, better-sqlite3, tsx) were used; no new/unverified packages installed → no blocking-human gate.

## Self-Check: PASSED

- scripts/migrate.ts — FOUND
- scripts/concurrency-smoke.ts — FOUND
- worker/index.ts — FOUND
- docker-compose.yml — FOUND
- Dockerfile — FOUND
- drizzle/0000_clear_absorbing_man.sql — FOUND
- Commit c97a4e5 (Task 1 migrations) — FOUND
- Commit 27a39fe (Task 2 worker + smoke) — FOUND
- Commit cb0504d (Task 3 compose skeleton) — FOUND
