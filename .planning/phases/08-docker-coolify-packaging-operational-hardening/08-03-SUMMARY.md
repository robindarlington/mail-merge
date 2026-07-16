---
phase: 08-docker-coolify-packaging-operational-hardening
plan: 03
subsystem: infra
tags: [sqlite, wal, better-sqlite3, drizzle, worker, maintenance, cleanup]

# Dependency graph
requires:
  - phase: 06-background-send-worker
    provides: standalone worker poll loop with envInt, stopping/inFlight flags, SIGTERM drain
  - phase: 01-foundation-db-crypto-core-engine
    provides: single-opener SQLite client (connection + drizzle db), WAL pragmas
provides:
  - "lib/worker/maintenance.ts — checkpointWal + sweepOrphanAttachments + isDue (loop-free, injectable)"
  - "idle-aware wal_checkpoint(TRUNCATE) on an env-tunable cadence, busy:1 handled"
  - "attachment-orphan sweep deleting aged unstamped/draft-stamped attachments, count-only logging"
  - "worker env knobs WAL_CHECKPOINT_MS, ORPHAN_SWEEP_MS, ATTACHMENT_ORPHAN_DAYS"
affects: [08-docker-compose-env, ops-docs, deploy-checkpoint]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Loop-free maintenance module: connection/db/now/unlink/logger all injected so routines are unit-tested against a temp DB without spinning the poll loop"
    - "Idle branch runs synchronous maintenance BEFORE claiming a campaign so it never overlaps a send tick (single-writer discipline)"
    - "Row-first deletion: DB row committed (source of truth for quota) then file unlinked; unlink failure counted, not fatal"
    - "Count-only logging at trust boundary (never filename/path/userId)"

key-files:
  created:
    - lib/worker/maintenance.ts
    - lib/worker/maintenance.test.ts
  modified:
    - worker/index.ts

key-decisions:
  - "Maintenance stamps start at 0 so a freshly-started worker runs one checkpoint + sweep on its first idle poll — keeps routines effective under frequent redeploys (the exact unbounded-WAL-between-restarts case)"
  - "Maintenance runs synchronously in the idle branch before the tick, wrapped in try/catch that logs message-only so a failure never crashes the poll loop"
  - "Orphan query uses drizzle inArray(campaign_id, <draft-campaign subquery>) OR isNull(campaign_id), gated by created_at < now - orphanDays*86400"

patterns-established:
  - "Operational routines belong in a testable module, scheduled by the worker — not inline logic and not cron"

requirements-completed: [SC-4]

# Metrics
duration: ~15min
completed: 2026-07-16
---

# Phase 8 Plan 3: Worker Operational Routines Summary

**Idle-aware `wal_checkpoint(TRUNCATE)` and a 7-day attachment-orphan sweep, built as a loop-free unit-tested `lib/worker/maintenance.ts` module and wired into the worker's idle branch on env-tunable cadences — no cron, no new deps.**

## Performance

- **Duration:** ~15 min
- **Tasks:** 2
- **Files modified:** 3 (2 created, 1 modified)
- **Tests:** 6 new (maintenance) — full suite 338 passing

## Accomplishments
- `checkpointWal(connection, logger)` runs `wal_checkpoint(TRUNCATE)`, returns and logs the `{busy, log, checkpointed}` row, and treats a `busy:1` result (reader held a snapshot, WAL did not shrink) as a logged-and-returned condition — never thrown (PITFALLS #7 / T-08-07).
- `sweepOrphanAttachments(opts)` deletes ONLY attachments that are unstamped (`campaign_id IS NULL`) OR stamped to a `draft` campaign, AND older than `orphanDays`; it never touches rows belonging to queued/running/completed/failed campaigns (T-08-09). Row is deleted first (quota source of truth) inside a transaction, then the file is unlinked; unlink failures are counted, not fatal.
- Sweep logs COUNTS ONLY (`{deletedRows, deletedFiles, unlinkFailures}`) — a unit test asserts no filename, storage path, or userId ever reaches a log call (T-08-08).
- Both routines run from the worker's idle branch (`!stopping && !inFlight`), synchronously and before claiming any campaign, so they never overlap a send tick or sit in the drain path (T-08-10). Cadence is env-tunable via the existing fail-closed `envInt`.

## Task Commits

Each task was committed atomically (TDD for Task 1):

1. **Task 1 (RED): failing maintenance tests** - `35c0b59` (test)
2. **Task 1 (GREEN): maintenance module** - `8dc282a` (feat)
3. **Task 2: wire routines into worker idle branch** - `fc2fbf0` (feat)

## Files Created/Modified
- `lib/worker/maintenance.ts` - `checkpointWal`, `sweepOrphanAttachments`, `isDue`; loop-free and fully injectable (connection/db/now/unlink/logger passed in).
- `lib/worker/maintenance.test.ts` - Temp-DB unit tests: checkpoint result logging (incl. fake-connection busy:1 path), sweep age/status selectivity across all five campaign statuses, row-first ordering via a throwing `unlink`, count-only logging, and the `isDue` cadence seam.
- `worker/index.ts` - Added `WAL_CHECKPOINT_MS` (1h), `ORPHAN_SWEEP_MS` (1h), `ATTACHMENT_ORPHAN_DAYS` (7) via `envInt`; `lastCheckpointAt`/`lastSweepAt` stamps; an idle-branch maintenance block gated by `isDue`, wrapped in a message-only try/catch. Existing tick/drain logic untouched.

## Decisions Made
- Cadence stamps initialize to `0` so the first idle poll runs one checkpoint + sweep immediately. This is deliberate: under frequent Coolify redeploys the worker may restart before an hour elapses, and running on first-idle guarantees the WAL is reset and orphans are swept regardless of restart frequency. A startup checkpoint on an idle single-writer is harmless and beneficial.
- Maintenance is invoked synchronously in the idle branch (before the async `tick`), so both routines fully complete before any campaign is claimed — preserving the single-writer invariant without any additional locking.
- Orphan selectivity is expressed as a drizzle predicate `created_at < cutoff AND (campaign_id IS NULL OR campaign_id IN <draft campaigns>)`, using an `inArray` subquery rather than a join (delete/select ergonomics + matches the existing DAL style).

## Deviations from Plan

None - plan executed exactly as written.

The plan's must-haves list a "due-scheduler" as part of the module; this was delivered as the small pure `isDue(lastAt, intervalMs, now)` export (unit-tested), while the two named exports required by the artifact contract (`checkpointWal`, `sweepOrphanAttachments`) remain the primary API. The worker inline-schedules via `isDue`, matching Task 2's described wiring.

## Issues Encountered
None. RED failed as expected (module not found), GREEN passed all 6 maintenance tests first try, and the full suite (338 tests) stayed green with the wiring in place. `tsc --noEmit` reports no type errors in the changed files.

## User Setup Required
None - no external service configuration required. The three new env knobs (`WAL_CHECKPOINT_MS`, `ORPHAN_SWEEP_MS`, `ATTACHMENT_ORPHAN_DAYS`) all have safe defaults and are optional; documenting them in compose/.env belongs to plans 08-01/08-02.

## Next Phase Readiness
- SC-4 (WAL checkpointing + attachment-orphan cleanup as defined routines) is satisfied and unit-tested.
- The new env knobs should be surfaced in `docker-compose.yml` / `.env.example` (owned by the concurrent 08-01/08-02 plans) so operators can tune cadence per environment.
- No blockers.

## Self-Check: PASSED

All created files exist on disk; all three task commits (`35c0b59`, `8dc282a`, `fc2fbf0`) are present in git history.

---
*Phase: 08-docker-coolify-packaging-operational-hardening*
*Completed: 2026-07-16*
