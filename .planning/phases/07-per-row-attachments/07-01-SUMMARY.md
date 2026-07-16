---
phase: 07-per-row-attachments
plan: 01
subsystem: database
tags: [drizzle, sqlite, migration, zod, storage, traversal, attachments]

# Dependency graph
requires:
  - phase: 03-csv-recipients
    provides: "lib/csv/storage.ts opaque-id traversal-proof writer + detectEmailColumn two-stage heuristic (the analogs this plan mirrors)"
  - phase: 01-foundation-db-crypto-core-engine
    provides: "lib/db/schema.ts entity model + drizzle migration pipeline"
provides:
  - "attachments table re-keyed for the pre-campaign upload window (user_id owner scope, nullable campaign_id, size_bytes; send_record_id dropped)"
  - "send_records.attachment_id nullable FK — inverted many-rows-to-one-file link"
  - "recipient_sets.attachment_column nullable column (user-confirmed filename column)"
  - "lib/attachments/storage.ts — writeAttachment / resolveAttachmentPath / attachmentExists (opaque-id, traversal-checked)"
  - "lib/attachments/schema.ts — MAX_ATTACHMENT_BYTES (10MB) / MAX_MESSAGE_BYTES (15MB) env-tunable + uploadAttachmentSchema"
  - "lib/core/detectAttachmentColumn — filename-column auto-detector"
affects: [attachments DAL, attachments actions, compose upload UI, confirm gate, worker materialize, worker send loop]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pre-campaign upload window: nullable campaign_id stamped later at prepare, direct user_id owner scope for the pre-campaign period"
    - "Link inversion: FK on the many-side (send_records.attachment_id) so a shared file links every referencing row"
    - "Opaque-id traversal-proof storage returning an absolute PATH (not bytes) for nodemailer streaming"

key-files:
  created:
    - lib/attachments/storage.ts
    - lib/attachments/storage.test.ts
    - lib/attachments/schema.ts
    - lib/core/attachment-column.ts
    - lib/core/attachment-column.test.ts
    - drizzle/0006_attachments_per_row.sql
    - drizzle/meta/0006_snapshot.json
  modified:
    - lib/db/schema.ts
    - lib/core/index.ts
    - drizzle/meta/_journal.json

key-decisions:
  - "attachments carries a direct user_id owner column (not tenancy-via-campaign-only) so the DAL can scope reads during the pre-campaign upload window"
  - "Fixed drizzle's table-recreate INSERT...SELECT to copy only pre-existing columns (empty table) so the migration applies cleanly"

patterns-established:
  - "Pre-campaign nullable-FK + owner-column window for uploads that precede their parent row"
  - "Many-side FK inversion for shared resources referenced by many rows"

requirements-completed: [ATCH-01, ATCH-03]

# Metrics
duration: 30min
completed: 2026-07-16
---

# Phase 7 Plan 01: Attachments Persistence + Safety Foundation Summary

**Re-keyed the attachments table for pre-campaign uploads, inverted the row-attachment link onto send_records.attachment_id, and added the traversal-proof opaque-id storage module + filename-column auto-detector — all green under 284 tests.**

## Performance

- **Duration:** ~30 min
- **Started:** 2026-07-16T07:20:00Z (approx)
- **Completed:** 2026-07-16T07:48:09Z
- **Tasks:** 3
- **Files modified/created:** 10

## Accomplishments
- Migration `0006_attachments_per_row` recreates `attachments` with `user_id` (owner scope), nullable `campaign_id` (stamped at prepare), and `size_bytes`; drops `send_record_id`.
- Inverted the row-attachment link: added nullable `send_records.attachment_id` FK so a file referenced by many CSV rows links every one of them (many send_records -> one attachment).
- Added nullable `recipient_sets.attachment_column` mirroring the `email_column` "save-path always writes it" contract.
- Built `lib/attachments/storage.ts` — opaque `<uuid>.bin` writer, absolute-path resolver, and presence check, all traversal-guarded (ATCH-03 / T-07-01 / T-07-02).
- Centralized `MAX_ATTACHMENT_BYTES` (10MB) / `MAX_MESSAGE_BYTES` (15MB) as env-tunable constants + `uploadAttachmentSchema` (T-07-03).
- Added `detectAttachmentColumn` two-stage heuristic (header hints then filename-shape content sampling) and re-exported it from `lib/core`.

## Task Commits

Each task was committed atomically:

1. **Task 1: Re-key attachments + invert link + recipient_sets.attachment_column (migration 0006)** - `331a980` (feat)
2. **Task 2: Traversal-proof storage writer/resolver + limit constants** - `a8ee8b2` (test RED) -> `21216ee` (feat GREEN)
3. **Task 3: Attachment-column auto-detector** - `36732de` (test RED) -> `139bf54` (feat GREEN)

_TDD tasks 2 and 3 each have a RED test commit followed by a GREEN implementation commit._

## Files Created/Modified
- `lib/db/schema.ts` - Re-keyed `attachments`; added `send_records.attachment_id` FK and `recipient_sets.attachment_column`.
- `drizzle/0006_attachments_per_row.sql` - Table-recreate + two additive ALTERs (generated, then INSERT line corrected).
- `drizzle/meta/0006_snapshot.json` + `drizzle/meta/_journal.json` - drizzle snapshot/journal (journal tag renamed to match file).
- `lib/attachments/storage.ts` - Opaque-id write, absolute-path resolve, presence check, traversal guard.
- `lib/attachments/schema.ts` - Size-limit constants + `uploadAttachmentSchema`.
- `lib/attachments/storage.test.ts` - 12 storage + schema assertions.
- `lib/core/attachment-column.ts` - `detectAttachmentColumn` two-stage heuristic.
- `lib/core/attachment-column.test.ts` - 7 detection assertions.
- `lib/core/index.ts` - Barrel re-export of `detectAttachmentColumn`.

## Decisions Made
- **Direct `user_id` on attachments.** AUTH-02 tenancy-via-campaign only works once `campaign_id` is stamped; the pre-campaign upload window (files land on /compose before `prepareCampaignCore`) requires a direct owner column so the DAL can scope reads. Chose PATTERNS option (a).
- **Migration INSERT correction (see Deviations).** The empty-table recreate lets us copy only pre-existing columns safely.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Corrected drizzle-generated INSERT...SELECT in migration 0006**
- **Found during:** Task 1 (migration generation)
- **Issue:** drizzle-kit's table-recreate emitted `INSERT INTO __new_attachments(..., "user_id", ..., "size_bytes", ...) SELECT ..., "user_id", ..., "size_bytes", ... FROM attachments` — but those columns do not exist on the OLD table, so SQLite throws `no such column: user_id` at prepare time (even with zero rows). Verified the failure by applying the migration to a throwaway DB.
- **Fix:** Since the `attachments` table is provably empty (confirmed `count(*) = 0` on the dev DB before the recreate, and the feature has never shipped), rewrote the data-copy to select only the columns common to both shapes (`id`, `campaign_id`, `filename`, `storage_path`, `created_at`). Zero rows are copied, so the new NOT NULL `user_id`/`size_bytes` are never violated. Re-applied to a temp DB: migration succeeds and produces the exact target schema.
- **Files modified:** `drizzle/0006_attachments_per_row.sql`
- **Verification:** `migrate(...)` against a fresh temp DB now reports OK with `attachments: id!,user_id!,campaign_id,filename!,storage_path!,size_bytes!,created_at!`; `npm run db:generate` reports "No schema changes".
- **Committed in:** `331a980` (Task 1 commit)

**2. [Rule 3 - Blocking] Drove drizzle-kit's interactive column-conflict prompt via a pseudo-TTY**
- **Found during:** Task 1 (migration generation)
- **Issue:** `npm run db:generate` requires a TTY to resolve the rename-vs-create ambiguity when `attachments` simultaneously drops `send_record_id` and adds `user_id`/`size_bytes`; it aborted non-interactively.
- **Fix:** Ran generation through `expect`, accepting the default "create column" (index 0) for each of the two conflict prompts — the correct answer (both are new columns; `send_record_id` is deleted).
- **Files modified:** (generation tooling only; output is `0006_attachments_per_row.sql` + snapshot)
- **Verification:** Generated snapshot shows `attachments 7 columns 1 fks`; both new columns created, `send_record_id` gone.
- **Committed in:** `331a980` (Task 1 commit)

---

**Total deviations:** 2 auto-fixed (1 bug, 1 blocking)
**Impact on plan:** Both were required to produce a migration that actually applies. No scope creep — the schema shape and file are exactly as planned.

## Issues Encountered
- **cwd drift into the main checkout.** Several exploratory Bash commands ran with `cd` into the shared checkout instead of the worktree, so an early migrate test read the main repo's (0006-less) migrations and appeared to skip 0006. Corrected by pinning every subsequent command to the worktree root; all file writes and commits were always in the worktree. No incorrect artifacts were committed.

## Known Stubs
None — all three modules are fully wired and tested. `campaign_id` on attachments is intentionally nullable and stamped by a later plan (Plan 04, prepare-time); `send_records.attachment_id` is intentionally null until materialize (Plan 04). These are planned downstream stamps, not stubs.

## User Setup Required
None - no external service configuration required. `MAX_ATTACHMENT_BYTES` / `MAX_MESSAGE_BYTES` / `UPLOADS_PATH` all have working literal fallbacks; ops may tune via env later.

## Next Phase Readiness
- Persistence + safety spine is in place for the rest of Phase 7: DAL (Plan 02+) can scope on `attachments.user_id`; upload actions can use `writeAttachment` + `uploadAttachmentSchema`; the confirm gate can sum `size_bytes` against `MAX_MESSAGE_BYTES` and check presence via `attachmentExists`; the worker can resolve absolute paths via `resolveAttachmentPath` and stamp `send_records.attachment_id`.
- Threat register mitigations T-07-01/02/03 are implemented and tested.

---
*Phase: 07-per-row-attachments*
*Completed: 2026-07-16*

## Self-Check: PASSED

All 8 created files present on disk; all 5 task commits (331a980, a8ee8b2, 21216ee, 36732de, 139bf54) present in git history. Full suite: 284 tests pass.
