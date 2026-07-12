---
phase: 03-csv-upload-parsing-recipient-mapping
plan: 02
subsystem: database
tags: [drizzle, sqlite, dal, multi-tenant, idor, csv, recipient-sets]

# Dependency graph
requires:
  - phase: 01-foundation-db-crypto-core-engine
    provides: recipient_sets table + RecipientSet/NewRecipientSet types, shared db opener (D-04), committed migrations
  - phase: 02-auth-smtp-onboarding
    provides: lib/data/smtp.ts userId-first DAL pattern + IDOR test harness (analog)
provides:
  - userId-first recipient_sets DAL (createRecipientSet, listRecipientSetsForUser, getRecipientSetForUser)
  - two-tenant IDOR isolation test proving cross-tenant reads return undefined
  - lib/data barrel re-export of the recipients DAL
affects: [03-03 csv Server-Action seam, app/(app)/recipients page, campaigns]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "userId-first DAL: every function takes userId as required first param and filters on it (no fetch-by-id-alone)"
    - "Server-injected ownership via Pick<> that omits userId + spread { userId, ...values }"

key-files:
  created:
    - lib/data/recipients.ts
    - lib/data/recipients.test.ts
  modified:
    - lib/data/index.ts

key-decisions:
  - "Mirrored lib/data/smtp.ts verbatim as the userId-first analog — no new patterns invented"
  - "Formatted the two drizzle queries with the userId filter on the same line as findFirst/findMany to satisfy the plan's line-based AUTH-02 grep gate (behavior identical)"

patterns-established:
  - "recipient_sets access is owner-scoped behind the lib/data barrel; a client-supplied id is never trusted"

requirements-completed: [CSV-05, AUTH-02]

# Metrics
duration: 12min
completed: 2026-07-13
---

# Phase 3 Plan 02: Recipient-Sets DAL Summary

**userId-first `recipient_sets` data-access layer (create/list/get) with structural IDOR defense — `getRecipientSetForUser` filters on `and(eq(id), eq(userId))`, proven by a two-tenant test where User B reading User A's id returns undefined.**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-07-13
- **Completed:** 2026-07-13
- **Tasks:** 1 (TDD: RED → GREEN, no refactor needed)
- **Files modified:** 3

## Accomplishments
- `createRecipientSet(userId, values)` server-injects `userId` (the `Pick<NewRecipientSet, ...>` values type omits it, so ownership cannot be spoofed) and returns the created row with its generated id.
- `listRecipientSetsForUser(userId)` returns only the caller's sets, newest-first (`desc(created_at)`); another tenant's set never appears.
- `getRecipientSetForUser(userId, id)` uses `and(eq(id), eq(userId))` — there is no fetch-by-id-alone path, so cross-tenant reads structurally return undefined (AUTH-02 / T-3-IDOR).
- Two-tenant IDOR harness (6 tests) proves scoping, newest-first ordering, server-set userId, and the USER_B→USER_A undefined read.
- DAL re-exported through the `@/lib/data` barrel.

## Task Commits

Each task was committed atomically:

1. **Task 1 (RED): failing IDOR isolation tests** - `f6d30d0` (test)
2. **Task 1 (GREEN): userId-first DAL + barrel** - `ca6c8dc` (feat)

_TDD task: test → feat. No refactor commit — implementation matched the analog with no cleanup needed._

## Files Created/Modified
- `lib/data/recipients.ts` - userId-first recipient_sets DAL: `createRecipientSet`, `listRecipientSetsForUser`, `getRecipientSetForUser`, `PersistableRecipientSet` type.
- `lib/data/recipients.test.ts` - two-tenant (USER_A/USER_B) IDOR harness: env-before-import tmp DB, committed migrations in `before()`, cleanup in `after()`.
- `lib/data/index.ts` - barrel extended to re-export the recipients DAL beside the smtp DAL.

## Decisions Made
- Followed `lib/data/smtp.ts` as the exact analog per the pattern map — userId-first, `Pick<>` value typing, docblocked "no fetch-by-id without owner filter".
- The plan's `<verification>` grep gate (`grep -nE "findFirst|findMany" ... | grep -v userId | grep -c .` returns 0) is line-based. Drizzle's default multi-line query style puts `findFirst`/`findMany` on a separate line from the `userId` filter, which would trip the gate even though the query is scoped. Formatted both queries so the `userId` filter sits on the same line as the query call — identical behavior, gate now returns 0.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Provisioned node_modules in the worktree**
- **Found during:** Task 1 (verification setup)
- **Issue:** The parallel-execution worktree had no `node_modules`, so `tsx` (test runner) and `tsc` were unavailable — the plan's automated verification could not run.
- **Fix:** Symlinked `node_modules` from the main checkout (`ln -s <main>/node_modules node_modules`). No package install of any new package was performed — this only hydrated the existing, already-installed dependency tree into the worktree.
- **Files modified:** none tracked (`node_modules` is gitignored; the symlink is never staged).
- **Verification:** `node_modules/.bin/tsx` resolves; test suite and `tsc --noEmit` both run.
- **Committed in:** n/a (no tracked file change).

---

**Total deviations:** 1 auto-fixed (1 blocking).
**Impact on plan:** Necessary to run the plan's own verification gates. No scope creep, no product-code change.

## Issues Encountered
None beyond the worktree node_modules setup noted above.

## Verification Evidence
- `node --import tsx --test lib/data/recipients.test.ts` — 6 pass, 0 fail (exit 0).
- IDOR grep gate — `grep -nE "findFirst|findMany" lib/data/recipients.ts | grep -v userId | grep -c .` returns 0.
- `npx --no-install tsc --noEmit` — exit 0.
- Pattern checks — `and(` present (3), `NewRecipientSet` present (2), `eq(recipient_sets.userId` present (2).

## Known Stubs
None — the DAL is fully wired to the `recipient_sets` table and covered by tests.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- 03-03 (CSV Server-Action seam) can import `createRecipientSet`, `listRecipientSetsForUser`, `getRecipientSetForUser` from `@/lib/data`.
- No blockers.

## Self-Check: PASSED

All created files exist on disk and all task commits (`f6d30d0`, `ca6c8dc`, `7343fe5`) are present in git history.

---
*Phase: 03-csv-upload-parsing-recipient-mapping*
*Completed: 2026-07-13*
