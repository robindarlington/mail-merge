---
phase: 07-per-row-attachments
plan: 03
subsystem: campaign
tags: [confirm-gate, attachments, server-authoritative, idempotent-stamp, tdd, matcher, tenancy]

# Dependency graph
requires:
  - phase: 07-per-row-attachments
    plan: 02
    provides: "computeAttachmentMatch (shared matcher); listAttachmentsForCampaign / stampCampaignOnPendingAttachments (idempotent) DAL; detectAttachmentColumn; MAX_MESSAGE_BYTES"
  - phase: 05-confirm-send
    provides: "buildConfirmSummaryCore / prepareCampaignCore / enqueueCampaignCore server-authoritative confirm gate + ConfirmSummary type + closed ActionError union"
provides:
  - "ConfirmSummary extended additively with attachmentColumn / rowsWithAttachment / attachmentTotal / missingAttachmentFilenames / missingAttachmentCount / oversizeRowCount + sample.attachment"
  - "prepareCampaignCore idempotently stamps the user's uploads onto the fresh draft (BLOCKER-1: re-prepare never strands attachments)"
  - "enqueueCampaignCore server-side block (attachments_blocked) when a referenced file is missing or a row is oversize"
affects: [confirm-send dialog UI (Plan 04), worker send loop (Plan 04)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Send gate reuses the SINGLE shared computeAttachmentMatch (no hand-recompute) — confirm-gate numbers can never diverge from the compose card"
    - "Idempotent prepare-time stamp on every dialog re-open re-claims a prior draft's attachments onto the new draft"
    - "Attachment block only fires on a successfully-summarized owned campaign; cross-tenant/not_found falls through to the atomic 0-row flip (canonical already_queued)"
    - "Send gate honors the user's persisted attachment column and never auto-selects the email column (email values are filename-shaped)"

key-files:
  created: []
  modified:
    - lib/campaign/actions-core.ts
    - lib/campaign/actions-core.test.ts

key-decisions:
  - "The send gate resolves the attachment column as set.attachment_column ?? auto-detect, but auto-detect is BLOCKED from co-opting the email column: email values end in a TLD (\".com\") which is filename-shaped, so detectAttachmentColumn false-positives on the email column; combined with the user-global attachment stamp leaking uploads onto unrelated drafts, an unguarded auto-detect would flag every row of a plain no-attachment send as a missing file and wrongly block enqueue (Rule 1 bug fix)."
  - "The attachment block only fires when buildConfirmSummaryCore succeeds (owner-scoped, parseable CSV); a not_found (cross-tenant/bogus id) or parse_error deliberately falls through to enqueueCampaignDal so its atomic 0-row guard yields the canonical already_queued, preserving the Phase 5 IDOR/idempotency contract."

requirements-completed: [ATCH-01, ATCH-02]

# Metrics
duration: 25min
completed: 2026-07-16
---

# Phase 7 Plan 03: Attachments in the Server-Authoritative Confirm Gate Summary

**Made per-row attachments a first-class part of the server-authoritative send gate — prepare idempotently stamps the user's uploads onto the fresh draft (BLOCKER-1: re-opening the dialog never strands files), the confirm summary recomputes presence/size via the SHARED computeAttachmentMatch, and enqueue is BLOCKED server-side when any referenced file is missing or any row is oversize — all green under 314 tests, 0 tsc errors.**

## Performance

- **Duration:** ~25 min
- **Tasks:** 2 (both TDD: RED test commit → GREEN implementation commit)
- **Files modified:** 2 (0 created)
- **Tests:** 5 new (3 confirm-gate aggregates + re-prepare + no-column; 2 enqueue-block missing/oversize); full suite 314 pass

## Accomplishments

- **Idempotent prepare-time stamp** (`prepareCampaignCore`): after `createDraftCampaign`, calls `stampCampaignOnPendingAttachments(userId, created.id)`. Because that DAL claims unstamped OR still-draft-owned rows, re-opening the send dialog (which mints a NEW draft on every open) re-claims the prior draft's attachments onto the current one — nothing is stranded (BLOCKER-1 / T-07-10 / T-07-17).
- **Server-authoritative attachment aggregates** in `buildConfirmSummaryCore`: resolves the attachment column (persisted choice, else guarded auto-detect), loads `listAttachmentsForCampaign(userId, campaign.id)`, and runs the SHARED `computeAttachmentMatch` against the campaign's OWN stamped attachments — spreading `rowsWithAttachment / attachmentTotal / missingAttachmentFilenames (cap 5) / missingAttachmentCount / oversizeRowCount` and setting `sample.attachment` for row 1. No attachment number is computed by hand, so the confirm gate can never diverge from the compose card (T-07-09).
- **ConfirmSummary extended additively** with the six attachment fields + optional `sample.attachment`; every prior Phase-5 field/test is untouched.
- **Server-side enqueue block** (`enqueueCampaignCore`): re-runs the attachment gate via `buildConfirmSummaryCore` BEFORE `enqueueCampaignDal`; when `missingAttachmentCount > 0` or `oversizeRowCount > 0` it returns the new `attachments_blocked` ActionError WITHOUT flipping status. A clean (or no-attachment) campaign enqueues exactly as before; a cross-tenant/not_found id falls through to the atomic 0-row flip (canonical `already_queued`).

## Task Commits

1. **Task 1: idempotent prepare stamp + attachment aggregates in the confirm summary** — `7a0eb4b` (test RED) → `46e8d3d` (feat GREEN)
2. **Task 2: block enqueue on missing / oversize attachments** — `bb0a2ec` (test RED) → `4a39b25` (feat GREEN)

Each TDD task has a `test(...)` RED commit before its `feat(...)` GREEN commit.

## Files Created/Modified

- `lib/campaign/actions-core.ts` — imported `detectAttachmentColumn` / `computeAttachmentMatch` / `listAttachmentsForCampaign` / `stampCampaignOnPendingAttachments`; extended the `ConfirmSummary` type and `ActionError` union; added the prepare-time stamp, the confirm-gate attachment computation (with the email-column auto-detect guard), and the enqueue block.
- `lib/campaign/actions-core.test.ts` — 5 new assertions: confirm-summary aggregates via the shared matcher, re-prepare re-claim (BLOCKER-1), no-attachment-column zero case, enqueue blocked on a missing file (then unblocked after upload + re-prepare), enqueue blocked on an oversize row. Added three CSV fixtures + `createAttachment` / `writeAttachment` / `MAX_MESSAGE_BYTES` test imports.

## Decisions Made

- **Email column is never auto-selected as the attachment column.** `detectAttachmentColumn`'s content-sampling scores email values as filename-shaped (they end in `.com`), so an unguarded `set.attachment_column ?? detectAttachmentColumn(...)` at the send gate false-positives on the email column. Because the attachment stamp is user-global (it claims all of the user's pending/still-draft uploads onto whatever draft is being prepared), those uploads leak onto plain no-attachment campaigns; the false-positive would then flag every row as a missing file and wrongly BLOCK enqueue. The gate now guards the auto-detect (`detected === emailColumn ? null : detected`), keeping the plan's fallback while honoring recipients.ts's documented principle that the send path uses the user's chosen column and never re-guesses in a way that silently changes behavior.
- **Block only a successfully-summarized owned campaign.** The enqueue gate fires only when `summary.ok` is true and a real missing/oversize count exists. A `not_found` (cross-tenant/bogus id) or `parse_error` is not short-circuited — it falls through to `enqueueCampaignDal`, whose atomic 0-row guard yields the canonical `already_queued`, preserving the exact Phase 5 IDOR/idempotency contract (the cross-tenant enqueue test still asserts `already_queued`, unchanged).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Send gate must not auto-detect the email column as the attachment column**
- **Found during:** Task 2 (the enqueue recheck broke two pre-existing enqueue tests — "flips a draft to queued" and the cross-tenant case — that use an email-bearing CSV with no attachment column).
- **Issue:** The plan specifies `set.attachment_column ?? detectAttachmentColumn(columns, rows)` at the gate. `detectAttachmentColumn` false-positives on the email column (email values end in `.com`, matching its filename-extension heuristic). Combined with the user-global attachment stamp leaking uploads onto unrelated drafts, the gate auto-selected "email", flagged every row as a missing file, and wrongly blocked a plain no-attachment send.
- **Fix:** Guard the auto-detect so it can never pick the email column (`detected === emailColumn ? null : detected`); an explicit persisted choice is still honored as-is. This keeps the plan's fallback for genuine attachment columns while restoring the correct no-attachment behavior.
- **Files modified:** `lib/campaign/actions-core.ts`
- **Verification:** Full suite 314 pass, `npx tsc --noEmit` 0 errors.
- **Committed in:** `4a39b25` (Task 2 GREEN).

**Total deviations:** 1 auto-fixed (Rule 1). No scope change — every planned artifact (idempotent stamp, shared-matcher confirm aggregates, server-side enqueue block) shipped as specified.

## TDD Gate Compliance

Both tasks followed RED → GREEN: `test(07-03)` commits (`7a0eb4b`, `bb0a2ec`) precede their `feat(07-03)` GREEN commits (`46e8d3d`, `4a39b25`). No test passed unexpectedly during RED (all new assertions failed on undefined fields / missing block before implementation).

## Known Stubs

None. `buildConfirmSummaryCore` and `enqueueCampaignCore` are fully wired to the real shared matcher and the campaign's stamped attachments; no UI is in scope for this plan (Plan 04 renders the summary + surfaces the `attachments_blocked` error).

## Threat Flags

None — no new security surface beyond the plan's `<threat_model>`. T-07-08 (enqueue bypass) and T-07-09 (spoofed counts) are mitigated server-side via the recompute + block; T-07-10 (cross-tenant stamp) is inherited from the userId-scoped idempotent DAL. The email-column auto-detect guard closes a correctness hole (wrongful block), not a security one.

## Next Phase Readiness

- **Plan 04 (confirm dialog UI):** render `attachmentColumn / rowsWithAttachment / attachmentTotal / missingAttachmentFilenames / missingAttachmentCount / oversizeRowCount` and `sample.attachment`; disable the send button (as a hint) when counts are non-zero, and surface the `attachments_blocked` ActionError when the server refuses enqueue.
- **Plan 04 (worker):** attachments are stamped to the campaign at prepare, so the worker resolves them via `getAttachmentByIdForCampaign` at send time (inverted link).

---
*Phase: 07-per-row-attachments*
*Completed: 2026-07-16*

## Self-Check: PASSED

Modified file `lib/campaign/actions-core.ts` present; SUMMARY present. All four task commits (7a0eb4b, 46e8d3d, bb0a2ec, 4a39b25) present in git history. Full suite: 314 tests pass, `npx tsc --noEmit` reports 0 errors.
