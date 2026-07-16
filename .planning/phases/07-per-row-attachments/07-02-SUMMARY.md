---
phase: 07-per-row-attachments
plan: 02
subsystem: attachments
tags: [drizzle, sqlite, auth-02, idor, server-actions, zod, matcher, tenancy]

# Dependency graph
requires:
  - phase: 07-per-row-attachments
    plan: 01
    provides: "attachments table (userId owner scope, nullable campaign_id, size_bytes) + send_records.attachment_id + recipient_sets.attachment_column; lib/attachments/{storage,schema}.ts; detectAttachmentColumn"
  - phase: 03-csv-recipients
    provides: "lib/data/recipients.ts DAL shape + lib/csv actions-core/actions split + readUpload + lib/compose previewCampaignCore CSV re-read seam (the analogs mirrored here)"
provides:
  - "lib/data/attachments.ts — userId-scoped DAL: createAttachment / listPendingAttachmentsForUser / deleteAttachmentForUser / listAttachmentsForCampaign / stampCampaignOnPendingAttachments (idempotent) / getAttachmentByIdForCampaign (inverted-link resolver)"
  - "lib/data/recipients.ts setAttachmentColumnForUser — owner-scoped attachment-column setter"
  - "lib/attachments/match.ts computeAttachmentMatch — the SINGLE shared server-side matcher"
  - "lib/attachments/actions-core.ts — uploadAttachmentCore / listAttachmentsCore / deleteAttachmentCore / confirmAttachmentColumnCore / matchAttachmentsCore + closed ActionError union"
  - "lib/attachments/actions.ts — 'use server' wrappers (upload/list/delete/confirmColumn/matchAttachments) with lazy Clerk auth"
  - "next.config.ts bodySizeLimit 11mb — lets one 10 MB attachment traverse the Server Action"
affects: [compose upload UI, confirm gate, worker send loop]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pre-campaign owner-scoped DAL: every by-id path filters AND(id, userId); no fetch/delete/update-by-id-alone"
    - "Idempotent campaign stamp: claim unstamped OR still-draft-owned rows via or(isNull, inArray(user's draft campaigns)); never a queued campaign's"
    - "Single shared pure matcher (computeAttachmentMatch) runs on both compose card and confirm gate — zero divergence"
    - "Orphan-safe upload: guards-pass-THEN-write bytes + insert row together"

key-files:
  created:
    - lib/data/attachments.ts
    - lib/data/attachments.test.ts
    - lib/attachments/match.ts
    - lib/attachments/match.test.ts
    - lib/attachments/actions-core.ts
    - lib/attachments/actions-core.test.ts
    - lib/attachments/actions.ts
    - lib/attachments/index.ts
  modified:
    - lib/data/recipients.ts
    - lib/data/index.ts
    - next.config.ts

key-decisions:
  - "Idempotent stamp claims unstamped OR still-draft-owned rows (userId-scoped subquery) so re-opening the confirm dialog re-claims a prior draft's attachments instead of stranding them; a queued/running campaign's attachments are never re-claimed (BLOCKER-1 / T-07-17)."
  - "matchAttachmentsCore matches against PENDING uploads (campaign_id IS NULL) because /compose has no campaign yet; it reuses the exact same computeAttachmentMatch the confirm gate (Plan 03) will run against stamped rows, so the two surfaces can never diverge."
  - "bodySizeLimit raised to 11mb (looser of the two per-file caps); the zod guards (MAX_UPLOAD_BYTES 4 MB for CSV, MAX_ATTACHMENT_BYTES 10 MB for attachments) remain the authoritative per-file caps so each surface rejects oversize with a clear message before the platform limit bites."

requirements-completed: [ATCH-01, ATCH-03]

# Metrics
duration: 35min
completed: 2026-07-16
---

# Phase 7 Plan 02: Attachments Tenancy Backbone + Upload Endpoint + Compose Match Seam Summary

**Built the userId-scoped, IDOR-safe attachments DAL with an idempotent re-prepare-safe campaign stamp and the inverted-link worker resolver, the orphan-safe upload/list/delete/confirm-column Server-Action seams, and the single shared computeAttachmentMatch matcher powering a compose-time match seam — all green under 309 tests, 0 tsc errors.**

## Performance

- **Duration:** ~35 min
- **Tasks:** 3 (all TDD: RED test commit → GREEN implementation commit)
- **Files created:** 8 | **modified:** 3
- **Tests:** 25 new (9 DAL + 9 actions-core + 7 matcher); full suite 309 pass

## Accomplishments

- **userId-scoped attachments DAL** (`lib/data/attachments.ts`): `createAttachment` (userId spread LAST, `campaign_id` stamped later), `listPendingAttachmentsForUser` (campaign_id IS NULL, newest first), `deleteAttachmentForUser` / `listAttachmentsForCampaign` (owner-scoped by AND), `getAttachmentByIdForCampaign` (worker inverted-link resolver scoped by campaign_id).
- **Idempotent stamp** `stampCampaignOnPendingAttachments`: `or(isNull(campaign_id), inArray(campaign_id, <user's still-draft campaigns>))` so re-opening the confirm dialog (fresh draft) re-claims the prior draft's attachments; a queued campaign's rows are never re-claimed (T-07-17).
- **Attachment-column setter** `setAttachmentColumnForUser` on `recipient_sets` (copies renameRecipientSet's owner-filter), so send time uses the chosen column, never a re-detect.
- **Orphan-safe upload endpoint** (`lib/attachments/actions-core.ts`): `guardFile` (instanceof File + `uploadAttachmentSchema`) → case-insensitive duplicate-name gate → **guards-pass-THEN-write** bytes + insert row together. Closed `ActionError` union (`unauthenticated | wrong_type | too_large | duplicate_filename | not_found | unknown`).
- **`'use server'` wrappers** (`lib/attachments/actions.ts`) with lazy Clerk `auth()`: `uploadAttachment` / `listAttachments` / `deleteAttachment` / `confirmAttachmentColumn` / `matchAttachments`.
- **Single shared matcher** (`lib/attachments/match.ts`): `computeAttachmentMatch(columns, rows, attachmentColumn, attachments)` → `rowsWithAttachment / attachmentTotal / missingAttachmentFilenames (deduped, cap 5) / missingAttachmentCount / oversizeRowCount / sampleAttachment`. Empty cell is not a miss; shared filename counts each row; DB-present-but-off-disk is a blocking miss.
- **Compose-time seam** `matchAttachmentsCore`: mirrors `previewCampaignCore` (validate id → userId-scoped resolve → readUpload → parseCsv → `attachment_column ?? detectAttachmentColumn`) then matches against PENDING uploads — no campaign required.
- **`next.config.ts`** bodySizeLimit `4mb → 11mb`; the CSV 4 MB `MAX_UPLOAD_BYTES` guard is untouched.

## Task Commits

1. **Task 1: userId-scoped DAL + idempotent stamp + column setter + two-tenant IDOR test** — `482e5e8` (test RED) → `8d248d6` (feat GREEN)
2. **Task 2: upload/list/delete/confirm-column seams + wrappers + bodySizeLimit** — `46c4ede` (test RED) → `d814a14` (feat GREEN)
3. **Task 3: shared computeAttachmentMatch + compose-time matchAttachments seam** — `149754e` (test RED) → `a0814e3` (feat GREEN)
4. **Cross-task type fixes** — `58ddc0c` (fix)

Each TDD task has a `test(...)` RED commit before its `feat(...)` GREEN commit.

## Files Created/Modified

- `lib/data/attachments.ts` — the pre-campaign, userId-scoped DAL (create/list-pending/delete/list-for-campaign/idempotent-stamp/inverted-link resolver).
- `lib/data/attachments.test.ts` — 9 assertions: create ownership + nullable campaign_id, pending isolation, cross-tenant delete no-op, stamp isolation, idempotent re-prepare re-claim, queued-campaign never re-claimed, inverted-link resolver, column-setter owner + IDOR.
- `lib/data/recipients.ts` — added `setAttachmentColumnForUser`.
- `lib/data/index.ts` — barrel re-exports for both new modules.
- `lib/attachments/match.ts` — the shared pure matcher + `AttachmentMatch` / `MatchableAttachment` types.
- `lib/attachments/match.test.ts` — 7 assertions over the pure matcher (real on-disk presence via UPLOADS_PATH temp dir).
- `lib/attachments/actions-core.ts` — the five userId-accepting seams + closed `ActionError` union + `matchAttachmentsCore`.
- `lib/attachments/actions-core.test.ts` — 9 assertions: happy upload, too_large, wrong_type, duplicate, no-orphan, delete no-op, confirm-column persist + not_found, matchAttachmentsCore integration + cross-tenant not_found.
- `lib/attachments/actions.ts` — the five `'use server'` wrappers.
- `lib/attachments/index.ts` — barrel (pure helpers + erased types only; actions imported directly).
- `next.config.ts` — bodySizeLimit `11mb` with the updated dual-cap comment.

## Decisions Made

- **Idempotent stamp scope.** The subquery is `campaigns.userId = userId AND status = 'draft'` — the re-claim window is strictly the caller's own still-draft campaigns, so a second draft only re-claims the SAME user's rows (never USER_B's) and a queued/running campaign's committed attachments stay put (T-07-17).
- **Match against pending, not campaign.** `/compose` has no campaign, so `matchAttachmentsCore` matches against `listPendingAttachmentsForUser`; Plan 03's confirm gate runs the identical `computeAttachmentMatch` against the campaign's stamped rows — one matcher, zero divergence.
- **Zod guards stay authoritative.** Raising the platform body limit to 11mb keeps the app-level `MAX_UPLOAD_BYTES` (4 MB, CSV) and `MAX_ATTACHMENT_BYTES` (10 MB, attachments) as the per-file caps that produce clear rejection messages before the platform limit bites.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Test env + File-constructor type corrections**
- **Found during:** Tasks 1 & 3 (test compile/run).
- **Issue:** (a) `createSmtpConfig` seeding needs `CREDENTIAL_ENC_KEY`, which the attachments DAL test didn't set → `encrypt` threw at seed time; (b) `lib/core` exports the CSV row type as `CsvRow` (aliased `Row as CsvRow`), not `Row`, so `match.ts`'s `import type { Row }` didn't resolve; (c) under strict TS the `File` constructor rejects a `Buffer` `BlobPart` and `PersistableRecipientSet` (a `Pick<>`) has no `attachment_column`, so the match test set the column via `confirmAttachmentColumnCore` instead.
- **Fix:** set `CREDENTIAL_ENC_KEY` in the DAL test harness (copying campaigns.test.ts); import `CsvRow`; wrap test bytes in `new Uint8Array(...)`; persist the column through the confirm seam.
- **Files modified:** `lib/data/attachments.test.ts`, `lib/attachments/match.ts`, `lib/attachments/actions-core.test.ts`
- **Verification:** `npx tsc --noEmit` → 0 errors; all 25 new tests green.
- **Committed in:** `8d248d6` (Task 1) and `58ddc0c` (type fixes).

**Total deviations:** 1 auto-fixed (blocking test-harness/type corrections). No scope change — every planned artifact shipped exactly as specified.

## Known Stubs

None. All modules are fully wired and tested. The upload/list/delete/confirm/match Server Actions are ready for the compose UI (Plan 04); `stampCampaignOnPendingAttachments` and `getAttachmentByIdForCampaign` are ready for the prepare + worker paths (Plan 04+). No UI is in scope for this plan, so there are no data-source stubs.

## Threat Flags

None — no new security surface beyond the plan's `<threat_model>`. T-07-04 (IDOR), T-07-05 (ownership spoof), T-07-06 (DoS/oversize), T-07-07 (auth gate), and T-07-17 (cross-tenant stamp claim) are all implemented and tested.

## Next Phase Readiness

- **Plan 03 (confirm gate):** import `computeAttachmentMatch` and run it against the campaign's stamped attachments; the numbers will match the compose card exactly.
- **Plan 04 (prepare + worker):** call `stampCampaignOnPendingAttachments(userId, campaignId)` at prepare (idempotent across re-opens), then `getAttachmentByIdForCampaign(campaignId, attachmentId)` in the worker to resolve the inverted link.
- **Plan 04/05 (compose UI):** import `uploadAttachment` / `listAttachments` / `deleteAttachment` / `confirmAttachmentColumn` / `matchAttachments` directly from `@/lib/attachments/actions`; a 10 MB file now traverses the Server Action.

---
*Phase: 07-per-row-attachments*
*Completed: 2026-07-16*

## Self-Check: PASSED

All 8 created files present on disk; all 7 task commits (482e5e8, 8d248d6, 46c4ede, d814a14, 149754e, a0814e3, 58ddc0c) present in git history. Full suite: 309 tests pass, `npx tsc --noEmit` reports 0 errors.
