---
phase: 06-background-worker-live-send-progress-history
plan: 01
subsystem: database
tags: [sqlite, better-sqlite3, drizzle, worker, job-queue, crash-recovery, node-test, tdd]

# Dependency graph
requires:
  - phase: 01-foundation-db-crypto-core-engine
    provides: "campaigns + send_records schema (status columns, lease_expires_at, worker_id, failed_count), shared db/connection single opener (D-04), node:test temp-DB harness"
  - phase: 05 (campaigns DAL)
    provides: "enqueueCampaign atomic-UPDATE-as-signal idiom copied for the claim; createDraftCampaign/createRecipientSet/createTemplate/createSmtpConfig seeding helpers"
provides:
  - "claimNextCampaign(workerId, leaseSec) — atomic single-UPDATE campaign claim (queued or stalled-lease) returning a typed Campaign"
  - "recoverOrphanedSending(campaignId) — sending→failed(interrupted) crash sweep + failed_count bump, returns swept count"
  - "markCompleted(campaignId) / markFailed(campaignId, reason) — campaign terminal transitions that stamp finished_at and release the lease"
affects: [06-02 send loop + materialize, worker/index.ts composition root, progress/history UI]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "DB-as-queue atomic claim: single UPDATE...WHERE id=(subquery)...RETURNING id — the returned row IS the win signal, never SELECT-then-UPDATE"
    - "Lease + stalled-reclaim branch for crash resume; started_at preserved via COALESCE"
    - "Orphan sweep makes in-flight 'sending' rows terminal (never reset to pending) — the no-double-send guarantee"
    - "Lazy-memoized prepared statement so better-sqlite3 compile-time table validation defers past test-harness migration"

key-files:
  created:
    - lib/worker/claim.ts
    - lib/worker/claim.test.ts
    - lib/worker/recover.ts
    - lib/worker/recover.test.ts
    - lib/worker/finalize.ts
    - lib/worker/finalize.test.ts
  modified: []

key-decisions:
  - "Claim uses a raw connection prepared statement (exact UPDATE...RETURNING shape); recover/finalize use drizzle db.update — both allowed by the plan, no new Database opener (D-04)"
  - "recoverOrphanedSending derives the swept count from RETURNING on the same UPDATE, so return value and failed_count bump can never disagree (tighter than count-then-update)"
  - "claim prepared statement is lazy-memoized (not module-load) so better-sqlite3's table validation runs after the migration"

patterns-established:
  - "Worker seams live under lib/worker/*.ts so the lib/**/*.test.ts glob auto-runs them; each is a pure-ish function over the shared db/connection"
  - "Worker-only non-userId-scoped read: claim loads the full typed Campaign by id alone; tenancy derives from campaign.userId downstream"

requirements-completed: [SEND-01, SEND-06]

# Metrics
duration: 7min
completed: 2026-07-15
---

# Phase 6 Plan 01: Worker State-Machine Seams Summary

**Crash-safe DB-as-queue seams for the background sender: an atomic single-UPDATE campaign claim with stalled-lease reclaim, an orphaned-`sending` sweep that makes in-flight rows terminal (no double-send), and completed/failed terminal transitions that release the lease — all green under `npm test`.**

## Performance

- **Duration:** 7 min
- **Started:** 2026-07-15T20:46:23Z
- **Completed:** 2026-07-15T20:50:55Z
- **Tasks:** 2
- **Files modified:** 6 (all created)

## Accomplishments
- `claimNextCampaign` — one atomic `UPDATE campaigns ... WHERE id=(SELECT ... status='queued' OR stalled ORDER BY created_at LIMIT 1) RETURNING id`; the returned row is the only win signal. Reclaims stalled (expired-lease) `running` campaigns, skips future-lease ones, preserves `started_at` via COALESCE, and returns the full typed row.
- `recoverOrphanedSending` — single sweep of `sending`→`failed` with error `interrupted: delivery status unknown`, bumps `failed_count` by exactly the swept count, never resets to `pending`, scoped to the target campaign.
- `markCompleted` / `markFailed` — terminal campaign transitions that stamp `finished_at` and clear `worker_id`/`lease_expires_at`; `completed` holds even with `failed_count > 0`.
- 10 new node:test subtests; full suite 222 pass / 0 fail. No schema/migration/client change.

## Task Commits

Each task was committed atomically (TDD RED → GREEN):

1. **Task 1: Atomic claim seam** — `8dc262f` (test) → `646ff01` (feat)
2. **Task 2: Orphan-recovery + finalize seams** — `d836a73` (test) → `1569f1c` (feat)

## Files Created/Modified
- `lib/worker/claim.ts` - `claimNextCampaign`: lazy-prepared atomic claim UPDATE...RETURNING + worker-only typed read
- `lib/worker/claim.test.ts` - single-winner, stalled reclaim, future-lease skip, FIFO ordering, lease/started_at stamping
- `lib/worker/recover.ts` - `recoverOrphanedSending`: sending→failed(interrupted) sweep + failed_count bump
- `lib/worker/recover.test.ts` - sweep transitions, untouched sent/pending, counter math, campaign isolation, no-op case
- `lib/worker/finalize.ts` - `markCompleted` / `markFailed`: terminal transitions + lease release
- `lib/worker/finalize.test.ts` - completed-with-failures, failed abort, finished_at + lease-cleared assertions

## Decisions Made
- Claim uses the raw `connection` prepared statement to guarantee the exact `UPDATE...WHERE id=(subquery)...RETURNING` shape (06-RESEARCH Pattern 1); recover/finalize use drizzle `db.update` for readability. Both are explicitly permitted by the plan and neither opens a second `Database` (D-04 respected).
- `recoverOrphanedSending` gets its swept count from `RETURNING` on the sweep UPDATE rather than a separate `SELECT count(*)`, so the return value and the `failed_count` bump derive from one statement and cannot diverge.
- `markFailed` accepts `reason` for the caller's structured log; there is no campaign-level error column in the v1 schema and no schema change was in scope this phase.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Lazy-memoized the claim prepared statement instead of preparing at module load**
- **Found during:** Task 1 (claim GREEN)
- **Issue:** The plan/06-RESEARCH Pattern 1 shows `connection.prepare(...)` at module top level. better-sqlite3 validates the target table at prepare time, but the temp-DB test harness runs its migration inside `before()` — which executes AFTER the test's top-level `await import("./claim")`. Preparing at module load therefore threw `SqliteError: no such table: campaigns`.
- **Fix:** Deferred the `connection.prepare` to first call via a memoized `getClaimStmt()`. In production the worker migrates before its first tick, so behavior is identical; in tests the prepare now runs after migration.
- **Files modified:** lib/worker/claim.ts
- **Verification:** `node --import tsx --test lib/worker/claim.test.ts` → 5/5 pass; full suite 222/222.
- **Committed in:** `646ff01` (Task 1 feat commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Necessary for the seam to load under the mandated temp-DB harness; the atomic-UPDATE shape and single-statement semantics are unchanged. No scope creep.

## Issues Encountered
- `db.query.campaigns.findFirst(...)` is Promise-typed in drizzle's cross-dialect API but the plan's claim signature is synchronous. Resolved by calling `.sync()` (the better-sqlite3 `SQLiteSyncRelationalQuery` synchronous executor), keeping `claimNextCampaign` a synchronous `Campaign | undefined`.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- The three crash-safety seams (claim, recover, finalize) are green and ready for Plan 02 to compose the materialize + send loop over them.
- Interrupted rows are terminal `failed`; Plan 02's send loop must process `pending` only (never re-send swept rows).
- No schema, migration, or `lib/db/client.ts` change — the state machine runs entirely on the Phase 1 columns.

## Self-Check: PASSED

---
*Phase: 06-background-worker-live-send-progress-history*
*Completed: 2026-07-15*
