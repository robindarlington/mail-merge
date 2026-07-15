---
phase: 06-background-worker-live-send-progress-history
plan: 03
subsystem: database
tags: [drizzle, sqlite, next-server-actions, clerk, idor, multi-tenant, tdd]

# Dependency graph
requires:
  - phase: 05 (test-send / confirmation-gate)
    provides: getCampaignForUser IDOR idiom, campaigns DAL, actions-core service-seam split, campaignIdSchema
  - phase: 01 (db + schema)
    provides: campaigns + send_records tables (send_records tenancy via campaign_id)
provides:
  - "listCampaignsForUser(userId) — caller-scoped campaign history, newest first"
  - "getSendRecordsForCampaign(userId, campaignId) — per-recipient drill-down gated behind ownership; cross-tenant → []"
  - "getCampaignProgressRow(userId, campaignId) — counters + current 'sending' recipient; cross-tenant → undefined"
  - "getCampaignProgressCore(userId, input) — non-'use server' progress service seam (validation → not_found → data)"
  - "getCampaignProgress(input) — auth-guarded 'use server' action (SEND-05 live poll)"
  - "ProgressData / ProgressResult types re-exported for the UI contract"
affects: [06-05 history-and-progress-ui, 06-06 csv-export-route, 06-04 worker]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "userId-FIRST DAL reads: send_records reads gated behind getCampaignForUser (no fetch-by-campaign_id-alone path)"
    - "Deterministic newest-first ordering: [desc(created_at), desc(id)] tiebreaks same-second unixepoch rows"
    - "Service-seam split reused for a read: core in non-'use server' module, auth wrapper in actions.ts"

key-files:
  created: []
  modified:
    - lib/data/campaigns.ts
    - lib/data/campaigns.test.ts
    - lib/data/index.ts
    - lib/campaign/actions-core.ts
    - lib/campaign/actions-core.test.ts
    - lib/campaign/actions.ts

key-decisions:
  - "Ordered listCampaignsForUser by [desc(created_at), desc(id)] rather than created_at alone, so newest-first is deterministic when rows share a unixepoch second"
  - "getCampaignProgressRow returns raw schema counter names (sent_count/failed_count); the core maps them to the client contract (sent/failed) and derives remaining server-side"
  - "Progress payload carries counts + current recipient only — never a send_record.error body — so nothing sensitive rides the wire (T-06-10)"

patterns-established:
  - "Read-side IDOR defense: ownership guard (getCampaignForUser) precedes every send_records query"
  - "remaining is computed server-side (total − sent − failed), never trusted from the client"

requirements-completed: [SEND-05, HIST-01, HIST-02]

# Metrics
duration: ~15min
completed: 2026-07-15
---

# Phase 6 Plan 03: Campaign Read/Progress Service Layer Summary

**userId-scoped Drizzle reads for the campaign history list, per-recipient drill-down, and live-progress counts, plus a `getCampaignProgress` auth-guarded server action — every read IDOR-safe end-to-end and proven cross-tenant-exclusive by tests.**

## Performance

- **Duration:** ~15 min
- **Tasks:** 2 (both TDD: RED → GREEN)
- **Files modified:** 6
- **Tests:** full suite 220/220 green

## Accomplishments
- Three userId-scoped DAL reads on `lib/data/campaigns.ts`: `listCampaignsForUser` (history list, newest first), `getSendRecordsForCampaign` (drill-down, ownership-gated), `getCampaignProgressRow` (counters + current recipient) — all exported from the `@/lib/data` barrel.
- `getCampaignProgressCore` service seam in the non-`use server` module (validation → not_found → data with server-derived `remaining`) plus the `getCampaignProgress` `use server` action that derives `userId` via `auth()` and delegates — the T-06-09 endpoint-isolation split reused for a read.
- Cross-tenant exclusion proven structurally: `getSendRecordsForCampaign(USER_B, aCampaignOfA)` → `[]`, `getCampaignProgressRow`/`getCampaignProgressCore(USER_B, …)` → `undefined`/`not_found`.

## Task Commits

1. **Task 1 (RED): failing DAL read tests** - `1f0831f` (test)
2. **Task 1 (GREEN): userId-scoped campaign reads** - `ccae736` (feat)
3. **Task 2 (RED): failing getCampaignProgressCore tests** - `7dfccc6` (test)
4. **Task 2 (GREEN): progress seam + auth-guarded action** - `c724a0f` (feat)

## Files Created/Modified
- `lib/data/campaigns.ts` - Added `listCampaignsForUser`, `getSendRecordsForCampaign`, `getCampaignProgressRow`; imported `asc`, `desc`, `send_records`.
- `lib/data/campaigns.test.ts` - Seeded USER_A/USER_B campaigns + send_records; assert ordering, cross-tenant exclusion, current-recipient derivation.
- `lib/data/index.ts` - Re-exported the three new reads from the campaigns barrel block.
- `lib/campaign/actions-core.ts` - Added `ProgressData`/`ProgressResult` types + `getCampaignProgressCore`; imported `getCampaignProgressRow`.
- `lib/campaign/actions-core.test.ts` - Validation rejects 0/-1/NaN/non-numeric; remaining arithmetic + current recipient; cross-tenant → not_found.
- `lib/campaign/actions.ts` - Added `getCampaignProgress` action + type-only re-export of `ProgressData`/`ProgressResult`.

## Decisions Made
- Ordered `listCampaignsForUser` by `[desc(created_at), desc(id)]` (not `created_at` alone) so "newest first" is deterministic when campaigns share a unixepoch second — matters for the test harness and for two campaigns created in the same request.
- `getCampaignProgressRow` returns the schema's own counter names (`sent_count`/`failed_count`); the core translates to the client contract (`sent`/`failed`) and derives `remaining` there, keeping the DAL a thin row read and the arithmetic in one place.

## Deviations from Plan
None - plan executed exactly as written.

## Issues Encountered
None. There was no existing DAL helper to insert `send_records`, so the tests seed them directly via `db.insert(send_records)` (test-only seeding, not production code) — consistent with the plan's "seed campaigns/send_records" test-harness instruction.

## Threat Model Compliance
- **T-06-08 (IDOR on progress + drill-down):** every read filters by `userId`; `send_records` reads gated behind `getCampaignForUser`; `getCampaignProgress` derives `userId` via `auth()`. Cross-tenant tests assert `[]`/`not_found`.
- **T-06-09 (client-invocable core bypassing auth):** `getCampaignProgressCore` lives in the non-`use server` module; `actions.ts` exports only the auth-guarded wrapper. Grep gate confirms `getCampaignProgressCore` appears in `actions.ts` only as an import + delegating call, never a re-export.
- **T-06-10 (error body leak):** progress payload carries counts + current recipient only, never a `send_record.error`.
- No new packages (T-06-SC accept).

## Verification
- `node --import tsx --test lib/data/campaigns.test.ts` → 10/10 green.
- `node --import tsx --test lib/campaign/actions-core.test.ts` → 24/24 green.
- `npm test` full suite → 220/220 green.
- `lib/db/schema.ts` unmodified (git diff empty).
- Grep gate: `grep -n "getCampaignProgressCore" lib/campaign/actions.ts` → import (line 29) + delegating call (line 131) only.

## Next Phase Readiness
- Read/service layer is ready for Plan 05 (history + live-progress UI) and Plan 06 (CSV export route) to consume via `@/lib/data` and `getCampaignProgress`.
- No blockers.

---
*Phase: 06-background-worker-live-send-progress-history*
*Completed: 2026-07-15*

## Self-Check: PASSED
All modified files exist on disk; all four task commits (1f0831f, ccae736, 7dfccc6, c724a0f) are present in git history.

## TDD Gate Compliance
Both tasks followed RED → GREEN: a `test(...)` commit precedes each `feat(...)` commit (Task 1: 1f0831f → ccae736; Task 2: 7dfccc6 → c724a0f). No unexpected passes during RED (functions were absent — TypeError). No REFACTOR gate needed.
