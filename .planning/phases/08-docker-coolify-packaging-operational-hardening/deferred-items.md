# Phase 08 — Deferred Items

Out-of-scope discoveries logged during execution (per executor SCOPE BOUNDARY).
These are NOT fixed by the discovering plan; they belong to the owning plan/verifier.

## DI-08-01 — Flaky `SQLITE_BUSY` during the Docker image build (`next build`)

- **Discovered during:** plan 08-04 (redeploy acceptance), running the real image build.
- **Symptom:** `docker build` / `docker compose build` intermittently fails at
  `RUN npm run build && npm run build:worker && npm run build:migrate` with:
  ```
  SqliteError: database is locked   (code: SQLITE_BUSY)
    Failed to collect page data for /campaigns/[id]/export
  ```
- **Root cause:** several route modules import `@/lib/db` at module scope, and
  `lib/db/client.ts` opens the SQLite connection (and sets `journal_mode=WAL`, a
  write) at import time. During `next build`'s "Collecting page data" phase, Next
  spawns multiple parallel workers that each import these route modules, so several
  processes race to create/initialize `/app/data/app.db` at once. The concurrent
  WAL-mode initialization occasionally loses the write lock and throws SQLITE_BUSY
  (the `busy_timeout=5000` does not always cover the journal-mode switch under
  heavy parallel build load). It is timing-dependent (passes on host builds and on
  a warm cache; flakes on cold parallel container builds).
- **Why deferred:** owned by the image/build layer (Dockerfile — plan 08-01) and
  the app's build-time DB-open behavior (lib/db + the route modules), NOT plan
  08-04's files. SCOPE BOUNDARY: only issues directly caused by this task's changes
  are auto-fixed here.
- **Local mitigation applied in 08-04 (this task only):** `scripts/redeploy-acceptance.sh`
  retries the image build up to 4 times; the race is transient so a retry succeeds
  and the successful layer is cached for later runs. This does not fix the root cause.
- **Suggested real fix (owning plan):** make the build deterministic — e.g. lazily
  open the DB (defer `openConnection()` until first query instead of at import),
  or serialize `next build` page-data collection to a single worker, or point
  `DATABASE_PATH` at a per-worker/unique path during build. Also note the current
  build leaks a stub `/app/data/app.db` into the image as a build artifact.
