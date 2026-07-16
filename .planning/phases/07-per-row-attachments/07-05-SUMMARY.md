---
phase: 07-per-row-attachments
plan: 05
subsystem: compose-ui
tags: [attachments, compose, confirm-gate, results-table, csv-export, server-authoritative, xss, formula-injection]

# Dependency graph
requires:
  - phase: 07-per-row-attachments
    plan: 02
    provides: "uploadAttachment / listAttachments / deleteAttachment / confirmAttachmentColumn / matchAttachments Server Actions; computeAttachmentMatch shared matcher; listPendingAttachmentsForUser / listAttachmentsForCampaign DAL; uploadAttachmentSchema"
  - phase: 07-per-row-attachments
    plan: 03
    provides: "ConfirmSummary attachment aggregates (attachmentColumn / rowsWithAttachment / missingAttachmentCount / oversizeRowCount / sample.attachment) recomputed via the shared matcher + server enqueue block"
  - phase: 07-per-row-attachments
    plan: 04
    provides: "worker stamps send_records.attachment_id + fails a missing-file row 'rejected: attachment missing'"
provides:
  - "components/compose/attachments-card.tsx — multi-file upload island + attachment-column Select + server AttachmentMatch summary (display-only)"
  - "ComposeEditor lifts attachment state and re-fetches matchAttachments after every upload/delete/column-change; compose/page threads pending uploads + attachment_column"
  - "confirm-send dialog attachment count line + sample attachment + all-clear check + destructive missing/oversize Alerts + confirm-disable mirror"
  - "recipient-results-table Attachment column + attachment-missing reason mapping; results-csv formula-injection-safe Attachment column"
  - "computeAttachmentMatch gains additive unreferencedUploadCount"
affects: [compose page, confirm-send gate, campaign detail, results CSV export]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Attachment state lifts to ComposeEditor; the card is a controlled component that reports refreshed lists up and the parent owns every matchAttachments call (single source of truth)"
    - "Match summary + confirm-gate lines DISPLAY the server AttachmentMatch/ConfirmSummary strictly — never derived from cosmetic sample rows (T-07-18)"
    - "Client confirm-disable mirrors the server-authoritative enqueue block (Plan 03) — a visible hint, never the gate"
    - "Untrusted filenames render as escaped JSX text everywhere (T-07-14) and run through the export formula-injection guard (T-07-15)"

key-files:
  created:
    - components/compose/attachments-card.tsx
  modified:
    - lib/attachments/match.ts
    - components/compose/compose-editor.tsx
    - app/(app)/compose/page.tsx
    - components/campaign/confirm-send-dialog.tsx
    - components/campaign/recipient-results-table.tsx
    - lib/campaign/results-csv.ts
    - lib/campaign/results-csv.test.ts
    - app/(app)/campaigns/[id]/page.tsx
    - app/(app)/campaigns/[id]/export/route.ts

key-decisions:
  - "Added an additive unreferencedUploadCount to the shared computeAttachmentMatch so the compose card can render the UI-SPEC 'unreferenced uploads' line server-authoritatively — the card has the uploaded-files list but NOT the CSV rows, so this count is not derivable client-side without violating the display-only discipline. The field is additive; every existing per-field matcher/confirm-gate assertion is untouched and ConfirmSummary picks specific fields (not the whole object), so nothing downstream breaks."
  - "The confirm dialog needs NO attachment props from ComposeEditor: the send gate is server-authoritative (Plan 03 recomputes via the shared matcher against the campaign's stamped attachments), so the dialog reads its own ConfirmSummary. The lifted state exists so the compose card works and the chosen column is persisted (confirmAttachmentColumn) before prepare stamps the uploads onto the campaign."
  - "The export CSV appends Attachment as the trailing column rather than inserting it 2nd (the on-screen table's W7 position). The UI-SPEC locks the TABLE column position; the CSV order is unspecified, and appending keeps the Recipient-first assertions intact with minimal test churn while still delivering a congruent Attachment column."
  - "matchAttachments syncs the card's displayed column to res.data.attachmentColumn (the server-resolved persisted-or-detected column), so auto-detect on first upload and confirmed-column persistence both flow through one server-authoritative path."

requirements-completed: [ATCH-01, ATCH-02, ATCH-03]

# Metrics
duration: 40min
completed: 2026-07-16
---

# Phase 7 Plan 05: User-Facing Attachment Surfaces Summary

**Shipped the compose→confirm→history attachment experience per 07-UI-SPEC: the "Attachments (optional)" card on /compose (multi-file upload → confirm/override the auto-detected column → server-computed match summary via matchAttachments), the confirm-send dialog's attachment count/sample/all-clear lines + blocking missing/oversize Alerts with a mirrored confirm-disable, and the Attachment column in the campaign-detail results table and the formula-injection-safe results CSV — all numbers server-computed, every filename escaped, 318 tests green, 0 tsc errors.**

## Performance

- **Duration:** ~40 min
- **Tasks:** 3 (all `type="auto"`)
- **Files created:** 1 | **modified:** 9
- **Tests:** full suite 318 pass (10 results-csv, +1 new attachment case); `npx tsc --noEmit` 0 errors

## Accomplishments

- **Attachments card** (`components/compose/attachments-card.tsx`): a controlled `"use client"` island — `Card` titled "Attachments (optional)" with the verbatim description; a `Form`/`FormField` wrapping `Input type="file" multiple` + accent "Upload files" button (`Loader2` "Uploading…" while in flight). Uploads ONE `uploadAttachment(fd)` call per file, client-pre-checking each with the shared `uploadAttachmentSchema` and field-anchoring per-file too-large/duplicate errors while valid files still upload (W11). Exhaustively maps the closed `ActionError` union to field errors vs destructive `Alert` (upload-failed / session-expired). Renders the uploaded files as a `divide-y` row stack (`Paperclip` + escaped filename + muted size + ghost `X` with `aria-label`), the attachment-column `Select` (no "none" item, W4), and the server `AttachmentMatch` summary lines STRICTLY from the prop.
- **ComposeEditor host wiring**: lifts attachment state (files, chosen column, server `AttachmentMatch`); renders `<AttachmentsCard>` between the compose card and the `PreviewStepper` ONLY when a list is selected (W2); a `runMatch` callback re-fetches `matchAttachments(selectedId)` after every upload/delete/column-change and on list switch; switching the list keeps files but resets + re-detects the column (W3). `compose/page` lists the user's pending uploads and threads each set's `attachment_column`.
- **Confirm-send dialog**: DISPLAYS the Plan-03 `ConfirmSummary` attachment fields only when a column is active — the "Attachments: {m} of {n} rows include one" top line, "Attachment: {filename}" in the sample block, the "Every attachment matched an uploaded file." all-clear check, and the destructive "Missing attachments" / "Attachments too large" Alerts. `confirmDisabled` extends to mirror the server block (`missingAttachmentCount > 0 || oversizeRowCount > 0`). When no column is active, nothing new renders.
- **Results table + CSV** (`recipient-results-table.tsx`, `results-csv.ts`): a new "Attachment" `TableHead` between Recipient and Status with the escaped filename or an em dash; `ATTACHMENT_MISSING_PREFIX` maps the worker's `rejected: attachment missing` to the friendly destructive "Failed" reason. The export CSV gains a trailing Attachment column, run through the SAME formula-injection guard as every cell. The detail page RSC and export route resolve each `send_record.attachment_id` → filename via `listAttachmentsForCampaign` (owner-scoped; a shared file links every referencing row).
- **Shared matcher** (`match.ts`): additive `unreferencedUploadCount` so the card's non-blocking "won't be sent" line is server-authoritative.

## Task Commits

1. **Task 1: attachments card + server match-summary display (+ additive matcher field)** — `285d0d3`
2. **Task 2: host attachments card + confirm-dialog attachment gate** — `ff7a53b`
3. **Task 3: attachment column in results table + CSV export** — `d15d3a0`

## Files Created/Modified

- `components/compose/attachments-card.tsx` — the new controlled upload/column/match card.
- `lib/attachments/match.ts` — additive `unreferencedUploadCount` on `AttachmentMatch` + `computeAttachmentMatch`.
- `components/compose/compose-editor.tsx` — lifts attachment state, renders the card, orchestrates `matchAttachments` + `confirmAttachmentColumn`.
- `app/(app)/compose/page.tsx` — lists pending uploads + threads `attachment_column`.
- `components/campaign/confirm-send-dialog.tsx` — attachment count/sample/all-clear lines + destructive Alerts + extended `confirmDisabled`.
- `components/campaign/recipient-results-table.tsx` — Attachment column + attachment-missing reason mapping + optional `attachmentNames` prop.
- `lib/campaign/results-csv.ts` — trailing formula-injection-safe Attachment column.
- `lib/campaign/results-csv.test.ts` — updated header/positional assertions + new injection-safe attachment case.
- `app/(app)/campaigns/[id]/page.tsx` — resolves send_record→filename map, passes to the table.
- `app/(app)/campaigns/[id]/export/route.ts` — resolves the same map, spreads `attachment` onto each CSV row.

## Decisions Made

- **Additive `unreferencedUploadCount`.** The card holds the uploaded-files list but not the CSV rows, so the UI-SPEC "unreferenced uploads" line is not derivable client-side without breaking the display-only rule. Adding a server-computed count to the shared matcher keeps the discipline intact; the field is additive (per-field tests unaffected, `ConfirmSummary` cherry-picks fields), so no downstream breakage.
- **Dialog reads its own summary.** The confirm gate is server-authoritative (Plan 03 recomputes and blocks enqueue), so the dialog needs no props from ComposeEditor — it displays `ConfirmSummary`. The lifted state exists to drive the card and persist the chosen column before prepare stamps the uploads.
- **CSV Attachment appended.** The table's Attachment column sits between Recipient and Status (W7, UI-locked); the CSV appends it as the trailing column (order unspecified), delivering congruence with minimal test churn.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Added `unreferencedUploadCount` to the shared matcher**
- **Found during:** Task 1.
- **Issue:** The UI-SPEC lists an "unreferenced uploads" match-summary state, but `AttachmentMatch` (Plan 02) exposed no field for it, and the card cannot derive it without the CSV rows — which would violate the display-only discipline the plan mandates.
- **Fix:** Added an additive `unreferencedUploadCount` to `AttachmentMatch` + `computeAttachmentMatch` (counts uploads no row names). Additive only; all 7 matcher tests + the confirm-gate aggregates still pass.
- **Files modified:** `lib/attachments/match.ts`
- **Commit:** `285d0d3`

**2. [Rule 3 - Blocking] Updated results-csv tests for the mandated Attachment column**
- **Found during:** Task 3.
- **Issue:** `results-csv.test.ts` pins the exact header string and field positions; adding the plan-mandated Attachment column shifts them.
- **Fix:** Updated the HEADER constant, the sent-at trailing-field assertion, and the empty-reason positional assertion; added a new test asserting the Attachment field renders trailing and is formula-injection-safe.
- **Files modified:** `lib/campaign/results-csv.test.ts`
- **Commit:** `d15d3a0`

**Total deviations:** 2 auto-fixed. No scope change — every planned artifact shipped as specified.

## Known Stubs

None. The card, dialog, and results/export surfaces are all wired to real Server Actions and DAL reads. The over-size (15 MB/message) states are implemented but likely unreachable in v1 (W10: one ≤10 MB file per row can't exceed 15 MB) — specified for contract completeness, not a stub.

## Threat Flags

None — no new security surface beyond the plan's `<threat_model>`. T-07-14 (filenames render as escaped JSX text everywhere), T-07-15 (CSV Attachment cell runs the formula-injection guard), T-07-16 (detail page + export attachment lookups are `listAttachmentsForCampaign` userId-scoped), and T-07-18 (the card DISPLAYS the server matchAttachments result, never client-derives) are all satisfied. Zero new packages/components (T-07-SC).

## Self-Check: PASSED

`components/compose/attachments-card.tsx` present on disk; all three task commits (285d0d3, ff7a53b, d15d3a0) present in git history. Full suite: 318 tests pass, `npx tsc --noEmit` reports 0 errors.

---
*Phase: 07-per-row-attachments*
*Completed: 2026-07-16*
