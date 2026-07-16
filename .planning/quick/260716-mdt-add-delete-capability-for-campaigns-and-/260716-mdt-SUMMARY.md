---
phase: quick-260716-mdt
plan: 01
subsystem: ui
tags: [nextjs, drizzle, sqlite, server-actions, alert-dialog, cascade-delete, idor]

# Dependency graph
requires:
  - phase: 01-foundation-db-crypto-core-engine
    provides: userId-scoped DAL, traversal-guarded storage modules, three-file action pattern
  - phase: 06.1
    provides: soft-delete + in-use guard precedent (softDeleteConfigCore / server-list AlertDialog)
provides:
  - deleteCampaignForUser transactional FK-ordered cascade (send_records -> attachments -> campaign), status-guarded + owner-scoped
  - countCampaignsForRecipientSet (all-status list delete-guard) + deleteRecipientSetForUser
  - deleteUpload / deleteAttachment traversal-guarded, ENOENT-tolerant file unlink
  - deleteCampaign / deleteList server actions with tested core seams
  - DeleteCampaignButton + ListDelete AlertDialog confirm islands
affects: [campaigns, lists, recipients, attachments]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Transactional manual cascade in FK order with a sentinel-throw rollback (mirrors setDefaultSmtpConfig); affected-row count is the allow/deny signal"
    - "Row-first delete: collect storage paths inside the txn, unlink files best-effort POST-commit (mirrors worker maintenance sweep)"
    - "In-use delete guard: block when a dependent (queued/running campaign, or any campaign referencing a list) exists — no cascade on the FK"

key-files:
  created:
    - components/campaign/delete-campaign-button.tsx
    - components/recipients/list-delete.tsx
  modified:
    - lib/data/campaigns.ts
    - lib/data/recipients.ts
    - lib/csv/storage.ts
    - lib/attachments/storage.ts
    - lib/campaign/actions-core.ts
    - lib/campaign/actions.ts
    - lib/csv/actions-core.ts
    - lib/csv/actions.ts
    - app/(app)/campaigns/[id]/page.tsx
    - app/(app)/lists/page.tsx
    - app/(app)/lists/[id]/page.tsx
    - components/recipients/csv-uploader.tsx

key-decisions:
  - "Campaign delete blocked while queued/running (TOCTOU-guarded inside the txn); draft/completed/failed are deletable"
  - "List delete blocked when ANY campaign (all statuses) references it — recipient_set_id is NOT NULL with no cascade, so blocking is the only history-preserving option"
  - "Attachment/CSV files unlinked best-effort post-commit; a failed unlink leaves only a harmless disk-only file, never an orphaned row"

patterns-established:
  - "Delete core seams return a closed message-only error union (not_found | in_use | ...) following softDeleteConfigCore"
  - "AlertDialog delete island: deleting in-flight guard, e.preventDefault() so in_use keeps the dialog open, sonner toast + router.refresh()/push"

requirements-completed: [QUICK-260716-mdt]

# Metrics
duration: ~40min
completed: 2026-07-16
---

# Quick Task 260716-mdt: Delete Campaigns + Lists Summary

**Operator-facing delete for campaigns (detail page) and uploaded lists (Lists page + detail), each behind a shadcn AlertDialog confirm, owner-scoped, with a transactional dependent-row cascade and safe on-disk file cleanup.**

## Performance

- **Duration:** ~40 min
- **Completed:** 2026-07-16
- **Tasks:** 3
- **Files created:** 2 · **Files modified:** 17 (incl. tests)

## Accomplishments
- `deleteCampaignForUser` DAL: single-transaction cascade in FK order (send_records -> attachments -> campaign), status-guarded (`notInArray(status, ['queued','running'])`) and owner-scoped; a sentinel throw rolls the whole cascade back on a blocked/cross-tenant id, and the removed attachments' storage paths come back for post-commit unlink.
- `countCampaignsForRecipientSet` (all-status guard) + `deleteRecipientSetForUser`; `deleteUpload` / `deleteAttachment` traversal-guarded, ENOENT-tolerant unlink helpers.
- `deleteCampaign` / `deleteList` server actions over tested core seams (`deleteCampaignCore`, `deleteRecipientSetCore`) — auth re-derivation, id coercion, `not_found`/`in_use` classification, `revalidatePath`.
- `DeleteCampaignButton` + `ListDelete` AlertDialog islands wired into the campaign detail page, the Lists rows, and the list detail header; in-flight guard, in-use inline alert, `router.push('/campaigns')` / `router.refresh()` on success.
- +19 tests (341 -> 360), full `tsc --noEmit` clean, production `npm run build` succeeds.

## Task Commits

1. **Task 1: Deletion data + storage layer** - `96e41a4` (feat, tdd)
2. **Task 2: Server actions + tested core seams** - `25d1d11` (feat, tdd)
3. **Task 3: AlertDialog confirm islands + page wiring** - `b3daf3a` (feat)

_Task 1/2 followed the plan's tdd flag but were committed as single feat commits (tests + implementation together) rather than separate RED/GREEN commits — see Deviations._

## Files Created/Modified
- `lib/data/campaigns.ts` - `deleteCampaignForUser` transactional cascade + `DeleteCampaignResult` type
- `lib/data/recipients.ts` - `countCampaignsForRecipientSet` (all statuses) + `deleteRecipientSetForUser`
- `lib/data/index.ts` - barrel exports for the three new DAL functions/types
- `lib/csv/storage.ts` - `deleteUpload` traversal-guarded CSV unlink
- `lib/attachments/storage.ts` + `lib/attachments/index.ts` - `deleteAttachment` unlink + barrel export
- `lib/campaign/actions-core.ts` / `actions.ts` - `deleteCampaignCore` + `deleteCampaign` action (revalidate /campaigns)
- `lib/csv/actions-core.ts` / `actions.ts` - `deleteRecipientSetCore` + `deleteList` action (revalidate /lists); `ActionError` extended with `in_use`/`not_found`
- `components/campaign/delete-campaign-button.tsx` - campaign delete AlertDialog island
- `components/recipients/list-delete.tsx` - list delete AlertDialog island
- `app/(app)/campaigns/[id]/page.tsx`, `app/(app)/lists/page.tsx`, `app/(app)/lists/[id]/page.tsx` - delete affordance wiring
- `components/recipients/csv-uploader.tsx` - exhaustive-switch fix (see Deviations)
- Tests: `lib/data/campaigns.test.ts`, `lib/data/recipients.test.ts`, `lib/csv/storage.test.ts`, `lib/csv/actions-core.test.ts`, `lib/campaign/actions-core.test.ts`

## Decisions Made
- Followed the plan's policy decisions verbatim: campaign delete blocked in queued/running (TOCTOU re-asserted inside the txn); list delete blocked by any referencing campaign (FK has no cascade and the column is NOT NULL, so blocking preserves history).
- Reused the existing shared `ActionError` union for the csv delete seam (added `in_use` + `not_found`) rather than a bespoke type, per the plan.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Exhaustive-switch break in csv-uploader.tsx**
- **Found during:** Task 2 (extending the shared csv `ActionError` union)
- **Issue:** Adding `in_use`/`not_found` to the shared `ActionError` union made the exhaustive `switch` in `components/recipients/csv-uploader.tsx:parseFailureFor` non-exhaustive → `tsc` error TS2366 (function lacks ending return). The upload/parse/save flow never emits those kinds, but the union is shared.
- **Fix:** Added `case "in_use":` / `case "not_found":` to the switch (folded into the existing `unknown` neutral-message branch) with a comment noting they belong to the delete action.
- **Files modified:** components/recipients/csv-uploader.tsx
- **Verification:** `npx tsc --noEmit` clean; build succeeds
- **Committed in:** `25d1d11` (Task 2 commit)

**2. [Process] TDD tasks committed as single feat commits**
- **Found during:** Tasks 1 & 2 (both marked `tdd="true"`)
- **Issue:** The plan tagged Tasks 1/2 as TDD but the work was implemented-then-tested and committed atomically (tests + implementation in one commit each) rather than as separate RED→GREEN commits.
- **Fix:** N/A — no code impact; all behaviors are covered by passing tests. Noted here for gate transparency.
- **Impact:** None on correctness; the plan is not `type: tdd` at the plan level, so no gate-sequence enforcement applies.

---

**Total deviations:** 1 auto-fixed (Rule 3 blocking) + 1 process note
**Impact on plan:** The auto-fix was required to keep the project type-clean after extending a shared union; it introduced no behavior and no scope creep.

## Issues Encountered
- None beyond the shared-union exhaustiveness break above (resolved).

## User Setup Required
None - no external service configuration required.

## Manual Verification (operator smoke test — not automatable here)
- Delete a completed campaign -> it disappears from /campaigns and its attachment files are removed.
- Delete a queued/running campaign -> blocked with the in-use message; nothing removed.
- Delete an unused list -> gone with its CSV file removed.
- Delete a list referenced by a campaign -> blocked with the in-use message.

## Next Phase Readiness
- Delete capability is complete and covered by tests, typecheck, and a green production build. No blockers.

---
*Phase: quick-260716-mdt*
*Completed: 2026-07-16*

## Self-Check: PASSED
- Created files verified on disk: delete-campaign-button.tsx, list-delete.tsx
- Task commits verified in git history: 96e41a4, 25d1d11, b3daf3a
- Full suite green (360/360), `tsc --noEmit` clean, `npm run build` succeeds
