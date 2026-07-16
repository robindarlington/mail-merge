---
phase: 07-per-row-attachments
plan: 04
subsystem: worker-send
tags: [worker, nodemailer, attachments, inverted-fk, poison-pill, tdd, send-path]

# Dependency graph
requires:
  - phase: 07-per-row-attachments
    plan: 01
    provides: "send_records.attachment_id inverted FK; attachments table; lib/attachments/storage (resolveAttachmentPath / attachmentExists); detectAttachmentColumn"
  - phase: 07-per-row-attachments
    plan: 02
    provides: "listAttachmentsForCampaign / getAttachmentByIdForCampaign (inverted-link resolver); computeAttachmentMatch matcher; setAttachmentColumnForUser"
  - phase: 06-background-worker-live-send-progress-history
    plan: 02
    provides: "runCampaign per-row fenced state machine (pending→sending→sent|failed); materializeSendRecords; verify-once; poison-pill / counter-fence invariants preserved here"
provides:
  - "lib/core/send.ts — additive optional attachments on MailTransport message + SendArgs; sendOne forwards ONLY when set (no-attachment send byte-for-byte unchanged)"
  - "lib/core SendAttachment type (barrel export)"
  - "lib/worker/materialize.ts — stamps send_records.attachment_id per matched row via the inverted FK (a shared file links EVERY referencing row)"
  - "lib/worker/process.ts — per-row attachment resolve via send_record FK + on-disk presence check + fenced 'rejected: attachment missing' fail that never aborts the batch"
affects: [worker send loop, campaign send-time attachment delivery]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Additive-optional forward: attachments spread onto the nodemailer call ONLY when set (copies the SmtpConfig `...(x !== undefined && { x })` idiom) so the default send is unchanged"
    - "Inverted-FK linkage at materialize: stamp send_records.attachment_id per address so a file referenced by many rows links every one (never last-stamped-wins)"
    - "Poison-pill graceful fail: a missing on-disk attachment takes the EXISTING fenced 'sending'→'failed' transaction (bump failed_count) + continue — sendOne never called, nothing thrown"
    - "Resolve-by-FK only: worker attaches strictly via rec.attachment_id → opaque storage_path, never a CSV-provided path (traversal-guarded resolveAttachmentPath)"

key-files:
  created: []
  modified:
    - lib/core/send.ts
    - lib/core/index.ts
    - lib/worker/materialize.ts
    - lib/worker/materialize.test.ts
    - lib/worker/process.ts
    - lib/worker/process.test.ts

key-decisions:
  - "Materialize stamps the inverted FK by (campaign_id, to_addr) — the UNIQUE send_record key — so every distinct address referencing a shared file is linked; the user-confirmed attachment_column wins, detection is only the fallback (mirrors emailColumn)."
  - "Missing-file failure reuses the existing fenced 'sending'→'failed' transaction with a new ATTACHMENT_MISSING_ERROR constant, then heartbeats + throttles like any processed row before continue — preserving the 'onHeartbeat once per row' invariant."
  - "Worker imports resolveAttachmentPath/attachmentExists from the @/lib/attachments barrel (pure helpers + types only; no 'use server' actions re-exported), so no server module is dragged into the worker."
  - "Added the Task-1 materialize linkage test to lib/worker/materialize.test.ts (its natural harness) rather than process.test.ts — the plan named no Task-1 test file but a TDD plan needs a RED test for the linkage truth."

requirements-completed: [ATCH-01, ATCH-02]

# Metrics
duration: 18min
completed: 2026-07-16
---

# Phase 7 Plan 04: Send-Path Attachment Wiring Summary

**The worker now attaches the right file per recipient — resolved strictly by the send_record's own `attachment_id` → opaque storage path, verified present on disk, and failing a single row `rejected: attachment missing` through the existing fenced transaction (never a throw that aborts the batch) — while a no-attachment send stays byte-for-byte unchanged and a file shared by many CSV rows links every one of them.**

## Performance

- **Duration:** ~18 min
- **Tasks:** 2 (both TDD: RED test commit → GREEN implementation commit)
- **Files modified:** 6 | **created:** 0
- **Tests:** 3 new (1 materialize linkage + 2 worker attach/miss); full suite 312 pass, `npx tsc --noEmit` 0 errors

## Accomplishments

- **Additive send surface** (`lib/core/send.ts`): `MailTransport.sendMail`'s message and `SendArgs` each gained an OPTIONAL `attachments?: SendAttachment[]`; `sendOne` spreads it onto the nodemailer call ONLY when set, so a row with no attachment produces a byte-for-byte identical call. New `SendAttachment` type exported from the `@/lib/core` barrel.
- **Inverted-FK linkage at materialize** (`lib/worker/materialize.ts`): after inserting a campaign's send_records, resolves `attachment_column = set.attachment_column ?? detectAttachmentColumn(...)`, loads `listAttachmentsForCampaign` into a `name.trim().toLowerCase()` → id map, and for each row with a non-empty matching cell stamps `send_records.attachment_id` on the row for that address. A file shared by many rows links EVERY referencing row; a blank cell / non-matching cell leaves `attachment_id` null. The existing dedup, `onConflictDoNothing` idempotency, and counter-reconcile transaction are untouched.
- **Per-row resolve + presence check + graceful fail** (`lib/worker/process.ts`): after the fenced `status='sending'` claim, resolves `att = rec.attachment_id != null ? getAttachmentByIdForCampaign(campaign.id, rec.attachment_id) : null` (never a CSV path). If the linked file is absent (`attachmentExists` false) the row fails `rejected: attachment missing` through the EXISTING fenced `'sending'→'failed'` transaction (bumping `failed_count`), then heartbeats + throttles and continues — `sendOne` is never called and nothing throws. A present attachment forwards `{ filename: att.filename, path: resolveAttachmentPath(att.storage_path) }`; a null link sends exactly as before.

## Task Commits

1. **Task 1: additive send attachments + materialize inverted-FK linkage** — `5ecfada` (test RED) → `2d84b2f` (feat GREEN)
2. **Task 2: worker per-row resolve + presence check + graceful missing-file fail** — `54b5fec` (test RED) → `a5015c9` (feat GREEN)

Each TDD task has a `test(...)` RED commit before its `feat(...)` GREEN commit.

## Files Created/Modified

- `lib/core/send.ts` — `SendAttachment` interface; optional `attachments` on the transport message + `SendArgs`; `sendOne` forwards only when set.
- `lib/core/index.ts` — export the `SendAttachment` type from the barrel.
- `lib/worker/materialize.ts` — attachment-column resolve + per-row `send_records.attachment_id` stamp (inverted FK); imports `and`, `listAttachmentsForCampaign`, `detectAttachmentColumn`.
- `lib/worker/materialize.test.ts` — new test: a shared file links every referencing row; blank/no-match leaves null.
- `lib/worker/process.ts` — `ATTACHMENT_MISSING_ERROR` constant; per-row resolve via `getAttachmentByIdForCampaign`; presence-gated fenced fail; attachment forwarded to `sendOne` when present.
- `lib/worker/process.test.ts` — UPLOADS_PATH harness + `seedAttachment`/`linkAttachment` helpers + stub-transport attachments recording; two cases (happy attach records filename/path; missing-on-disk fails one row and campaign continues).

## Decisions Made

- **Stamp by (campaign_id, to_addr).** The inverted FK is stamped on the UNIQUE send_record key rather than by captured insert-id, so it works uniformly for freshly-inserted and resumed (`onConflictDoNothing`) rows, and every distinct address sharing a file is linked.
- **Reuse the fenced failed branch.** The missing-file failure uses the same `db.transaction` fenced on `status='sending'` as an SMTP failure (with a distinct error string), so counters never tear and a stolen-lease double-write is impossible.
- **Heartbeat/throttle on the missing-file path.** The graceful-fail branch heartbeats and throttles before `continue`, so the "onHeartbeat fires once per processed row" invariant (and the lease bump) holds for missing-file rows too.

## Deviations from Plan

### Auto-fixed / structural

**1. Task-1 RED test placed in `materialize.test.ts`**
- **Found during:** Task 1 (TDD requires a RED test; the plan listed no Task-1 test file, only `process.test.ts` as the verify command).
- **Change:** Added the send_record→attachment linkage RED test to `lib/worker/materialize.test.ts` (its natural harness with a CSV-fixture + uploads dir), since Task 1's behavior is materialize stamping. Task 1's plan verify (`process.test.ts` still green) is also satisfied.
- **Files modified:** `lib/worker/materialize.test.ts`
- **Impact:** None on scope — every planned artifact shipped; extra coverage for the "shared file links every row" truth.

No other deviations — send.ts and process.ts changed exactly as specified; every Phase 6 invariant (fenced per-row transactions, poison-pill continue, verify-once, no-double-send) preserved.

## Known Stubs

None. All three artifacts are fully wired and tested. No UI is in this plan's scope.

## Threat Flags

None — no new security surface beyond the plan's `<threat_model>`. T-07-11 (path traversal: attachment resolved only via the DB-sourced opaque path through `resolveAttachmentPath`, CSV cells never touch the filesystem), T-07-12 (poison pill: per-row fenced fail + continue, never a throw), and T-07-13 (counter tear: terminal write + `failed_count` bump in one synchronous transaction fenced on `status='sending'`) are all implemented and tested. Zero new packages.

## Next Phase Readiness

- **Send-time attach is complete (ATCH-01)** and the send-time half of ATCH-02/ATCH-03 (safe resolution + graceful per-row failure) is met. A confirm-gate pre-send validation surface (Plan 03) blocks missing files before the campaign is queued; this plan is the defense-in-depth at send time.
- The materialize stamp assumes attachments are already stamped to the campaign (`stampCampaignOnPendingAttachments` at prepare) — the prepare/queue path must run that before the worker claims the campaign.

---
*Phase: 07-per-row-attachments*
*Completed: 2026-07-16*

## Self-Check: PASSED

All modified files present on disk; all 4 task commits (5ecfada, 2d84b2f, 54b5fec, a5015c9) present in git history. Full suite: 312 tests pass; `npx tsc --noEmit` reports 0 errors.

## TDD Gate Compliance

Both `tdd="true"` tasks show a `test(...)` RED commit before their `feat(...)` GREEN commit (Task 1: 5ecfada→2d84b2f; Task 2: 54b5fec→a5015c9). RED runs confirmed a genuine failure before implementation.
