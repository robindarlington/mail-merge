---
phase: 04-editor-preview-template-save
plan: 02
subsystem: database
tags: [drizzle, sqlite, zod, tenancy, idor, templates]

# Dependency graph
requires:
  - phase: 03-csv-upload
    provides: userId-first DAL pattern (recipients.ts), shared-zod idiom (csv/schema.ts), test-isolation harness (temp DATABASE_PATH before dynamic import)
provides:
  - userId-first templates DAL (createTemplate / getTemplateForUser / listTemplatesForUser + PersistableTemplate)
  - structural IDOR defense on template reads (and(eq(id), eq(userId)))
  - shared composeFormSchema (subject/body required + length caps) parsed on both client resolver and server guard
  - ComposeFormValues inferred type
affects: [04-03-save-template-action, 04-04-compose-editor, compose, preview]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "userId-first DAL: userId is the required first param on every function; single-row reads use and(eq(id), eq(userId)), never eq(id) alone"
    - "Server-injected ownership: PersistableTemplate Pick omits userId; DAL spreads { userId, ...values }"
    - "Shared zod schema: one object parsed by both client RHF resolver and server action-core so validation cannot diverge"

key-files:
  created:
    - lib/data/templates.ts
    - lib/data/templates.test.ts
    - lib/compose/schema.ts
    - lib/compose/schema.test.ts
  modified:
    - lib/data/index.ts

key-decisions:
  - "Copied lib/data/recipients.ts shape verbatim against the pre-existing templates table — no schema migration added"
  - "Subject capped at 998 chars (RFC 5322 single-line limit); body capped at 50000 chars (T-4-SIZE)"
  - "Did NOT create lib/compose/index.ts — Plan 03 owns that barrel"

patterns-established:
  - "templates DAL mirrors recipients DAL exactly — tenancy invariant is structural, not conventional"
  - "compose schema uses .trim().min(1) so whitespace-only input fails the emptiness guard"

requirements-completed: [EDIT-01, EDIT-04]

# Metrics
duration: 12min
completed: 2026-07-13
---

# Phase 4 Plan 02: Templates DAL + Shared Compose Schema Summary

**userId-first templates DAL with structural IDOR defense, plus a shared composeFormSchema (subject/body required + RFC 5322 length caps) parsed identically on client and server.**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-07-13
- **Completed:** 2026-07-13
- **Tasks:** 2 (both TDD, RED→GREEN)
- **Files modified:** 5 (4 created, 1 modified)

## Accomplishments
- `lib/data/templates.ts` — tenant-owned create/get/list against the existing `templates` table, with `and(eq(id), eq(userId))` as the only single-row read path (cross-tenant get returns undefined)
- `lib/compose/schema.ts` — one `composeFormSchema` for both the client resolver and the server guard, with UI-SPEC-exact required messages and length caps
- 13 new tests (6 DAL incl. the EDIT-04 cross-tenant IDOR assertion, 7 schema); full suite 136/136 green
- No schema migration and no new npm dependency

## Task Commits

Each task was committed atomically (TDD: test → feat):

1. **Task 1 (RED): failing templates DAL IDOR tests** - `ffd6a4c` (test)
2. **Task 1 (GREEN): userId-first templates DAL** - `ee31f7a` (feat)
3. **Task 2 (RED): failing compose schema tests** - `752bd7f` (test)
4. **Task 2 (GREEN): shared compose zod schema** - `a74bc01` (feat)

_No REFACTOR commits needed — GREEN implementations were clean copies of established analogs._

## Files Created/Modified
- `lib/data/templates.ts` - userId-first templates DAL; PersistableTemplate omits userId; IDOR-safe reads
- `lib/data/templates.test.ts` - two-tenant create/list/get isolation incl. cross-tenant `getTemplateForUser(USER_B, idOwnedByA) === undefined`
- `lib/data/index.ts` - barrel: added templates export block mirroring the recipients block
- `lib/compose/schema.ts` - composeFormSchema (subject ≤998, body ≤50000, required messages) + ComposeFormValues
- `lib/compose/schema.test.ts` - safeParse coverage for each behavior bullet (blank/whitespace/over-cap)

## Decisions Made
- Copied `recipients.ts`/`recipients.test.ts` shape verbatim — the templates table already existed, so no migration was authored.
- Used `.trim().min(1)` so whitespace-only subject/body fails emptiness rather than passing as "non-empty".
- Left `lib/compose/index.ts` uncreated per plan (Plan 03 owns the barrel).

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- Worktree lacked `node_modules`; symlinked it from the main repo per the parallel-execution instructions (not staged). No other issues.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Plan 03's `saveTemplateCore` now has a tenant-safe `createTemplate(userId, {subject, body})` write path.
- Plan 04's editor has `composeFormSchema` for its RHF `zodResolver`, guaranteed to match the server guard.
- No blockers.

## Threat Flags

None - no new security surface beyond the plan's threat model (all mitigations T-4-TAMPER-OWNER, T-4-IDOR-TPL, T-4-SIZE implemented and tested).

## Self-Check: PASSED

All 4 created source files + SUMMARY.md exist on disk; all 4 task commits (ffd6a4c, ee31f7a, 752bd7f, a74bc01) present in git history.

---
*Phase: 04-editor-preview-template-save*
*Completed: 2026-07-13*
