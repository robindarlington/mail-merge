---
phase: 07-per-row-attachments
verified: 2026-07-16T00:00:00Z
status: human_needed
score: 3/4 roadmap success criteria verified (SC4 = staging walkthrough, queued human checkpoint 07-06)
overrides_applied: 0
human_verification:
  - test: "Coolify staging redeploy + per-row attachment walkthrough (plan 07-06, queued checkpoint): deploy the Phase 7 slice to the standing staging URL, upload files on /compose, run a real send over BYO SMTP"
    expected: "Both containers healthy; each recipient receives the correct per-row file; UPLOADS_PATH volume shared so the worker reads files the web wrote"
    why_human: "SC4 requires the deployed two-container VPS topology (shared /data volume, web→worker file handoff) — not verifiable from the codebase"
  - test: "On staging, reference a filename in the CSV that was never uploaded, then open the confirm-send dialog"
    expected: "Missing-attachments alert renders, Confirm button disabled, and enqueue is refused server-side (attachments_blocked) — nothing sends"
    why_human: "Blocking behavior is code-verified; the rendered UX on the real deployment needs eyes"
  - test: "On staging, delete an attachment file from the /data/uploads volume mid-run (after enqueue, before that row sends)"
    expected: "Only that row fails with 'rejected: attachment missing' (friendly reason in results table); the campaign continues and other rows send"
    why_human: "Requires a live worker run against the real volume; unit tests stub the transport"
  - test: "On /compose with a list selected: upload two files, confirm/override the auto-detected attachment column, verify the match summary + blocking states render per 07-UI-SPEC (deferred human-check from plan 07-05)"
    expected: "Server-computed match summary (matched / missing / oversize / unreferenced) renders and updates after each upload/delete/column change"
    why_human: "Visual layout and interaction quality per 07-UI-SPEC cannot be grep-verified"
---

# Phase 7: Per-Row Attachments — Verification Report

**Phase Goal:** A user can attach a different file per CSV row, with attachments resolved safely and validated as present before any send.
**Verified:** 2026-07-16
**Status:** human_needed
**Re-verification:** No — initial verification

**Mode note:** ROADMAP marks this phase `mode: mvp`, but the goal is not in User Story format (`gsd-sdk query user-story.validate` → false). Standard goal-backward verification was performed against the ROADMAP Success Criteria per orchestrator direction. If MVP-mode user-flow framing is wanted, run `/gsd mvp-phase 7` to reformat the goal. Discrepancy surfaced, not blocking.

## Goal Achievement

### Observable Truths (roadmap Success Criteria + merged plan must-haves)

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | User can attach a different file per CSV row via a filename column + uploads; worker attaches the correct file per recipient at send time | ✓ VERIFIED | Upload: `lib/attachments/actions-core.ts` (uploadAttachmentCore, one file per call, quota-guarded) → `writeAttachment` opaque `<uuid>.bin`. Column: `lib/core/attachment-column.ts` (`detectAttachmentColumn` + shared `resolveAttachmentColumn`), persisted on `recipient_sets.attachment_column`. Link: `lib/worker/materialize.ts:134-196` stamps `send_records.attachment_id` per row (inverted FK — a shared file links EVERY referencing row). Send: `lib/worker/process.ts:193-257` resolves strictly via `rec.attachment_id → getAttachmentByIdForCampaign → resolveAttachmentPath`, forwards `{filename, path}` to `sendOne`; null attachment_id sends byte-for-byte unchanged. Tests: "a linked, on-disk attachment is forwarded to sendMail... (ATCH-01)" passes |
| 2 | Every referenced attachment is validated as present before any send; a missing file is a blocking validation error | ✓ VERIFIED | Server-authoritative gate in `lib/campaign/actions-core.ts` enqueueCampaignCore: recomputes `buildConfirmSummaryCore` (shared `computeAttachmentMatch`) and returns `attachments_blocked` when `missingAttachmentCount > 0 || oversizeRowCount > 0`; WR-04 hardening also blocks on `parse_error`/`unknown` summary failures (line ~576). UI mirror: `confirm-send-dialog.tsx:146-150` disables Confirm + destructive alerts. Defense-in-depth: materialize terminal-fails unmatched non-empty cells (CR-01, `materialize.ts:161-183`); process.ts fails dangling/vanished attachments per-row without aborting the batch |
| 3 | Attachment resolution is safe against path traversal (opaque IDs, never CSV paths) and enforces per-file + per-message size limits | ✓ VERIFIED | `lib/attachments/storage.ts`: files written as `randomUUID().bin` — user filename never a path component; `guardedResolve` prefix-checks against UPLOADS_DIR before any disk access (resolver + presence check share the guard). Worker resolves only DB-sourced `storage_path` from userId/campaign-scoped rows, never CSV values (`process.ts:193-195`). Limits: `lib/attachments/schema.ts` MAX_ATTACHMENT_BYTES 10MB (enforced at upload via `uploadAttachmentSchema` → `too_large`) + MAX_MESSAGE_BYTES 15MB (enforced per-row in `computeAttachmentMatch` → `oversizeRowCount`, gates enqueue). Filename sanitized before MIME headers (WR-06, commit 41d7ce4). Per-user pending quota (WR-02, 479d6be) |
| 4 | The phase's slice is deployed to the standing staging URL (Coolify) and works there | ? UNCERTAIN → HUMAN | Plan 07-06 is the deliberately queued staging checkpoint (unchecked in ROADMAP). Not verifiable from code — routed to human verification, per operator's queued-checkpoint preference. Not a code gap |

**Score:** 3/4 roadmap SCs code-verified; SC4 is the queued human checkpoint. All 23 plan-level must-have truths across 07-01..07-05 verified (no failures).

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `drizzle/0006_attachments_per_row.sql` | attachments recreate + send_records.attachment_id + recipient_sets.attachment_column | ✓ VERIFIED | Exists, contains `attachment_id`; registered in `drizzle/meta/_journal.json` (tag 0006_attachments_per_row); WR-05 NOT-NULL copy fix landed (bb20d02) |
| `lib/attachments/storage.ts` | opaque-id, traversal-checked write/resolve/exists | ✓ VERIFIED | 83 lines; writeAttachment / resolveAttachmentPath / attachmentExists all share guardedResolve |
| `lib/attachments/schema.ts` | size constants + upload schema | ✓ VERIFIED | 73 lines; env-tunable 10MB/15MB, control-char sanitizing schema |
| `lib/core/attachment-column.ts` | detect + shared resolve helper | ✓ VERIFIED | 81 lines; barrel-exported from `lib/core/index.ts`; resolveAttachmentColumn shared by confirm gate, compose matcher, materialize (WR-03) |
| `lib/data/attachments.ts` | userId-scoped DAL, idempotent stamp, inverted-link resolver | ✓ VERIFIED | 182 lines; `and(eq(id), eq(userId))` on every by-id path (IDOR); stamp claims unstamped OR still-draft rows (WR-01) |
| `lib/attachments/match.ts` | shared computeAttachmentMatch | ✓ VERIFIED | 157 lines; rowsWithAttachment / missing / oversize / unreferenced |
| `lib/attachments/actions-core.ts` + `actions.ts` | core seams + 'use server' auth wrappers incl. matchAttachments | ✓ VERIFIED | 338 + 99 lines; closed ActionError union incl. quota_exceeded / in_use |
| `lib/campaign/actions-core.ts` | prepare-time stamp + confirm summary + enqueue block | ✓ VERIFIED | stampCampaignOnPendingAttachments at :399; computeAttachmentMatch at :479; attachments_blocked gate before DAL flip |
| `lib/core/send.ts` | additive optional attachments on MailTransport | ✓ VERIFIED | contains `attachments`; forwarded only when set |
| `lib/worker/materialize.ts` + `process.ts` | per-row linkage + fenced missing-attachment fail | ✓ VERIFIED | Both terminal-fail paths use fenced status transitions with counter bump in one synchronous transaction |
| `components/compose/attachments-card.tsx` | upload island + column select + server match summary | ✓ VERIFIED | 408 lines; renders match strictly from `matchAttachments` action data (never client-derived) |
| `components/campaign/confirm-send-dialog.tsx` | attachment lines + blocking disable | ✓ VERIFIED | 333 lines; attachmentsBlocked → confirmDisabled + destructive alerts |
| Results table + CSV export | attachment filename column + friendly reason | ✓ VERIFIED | `recipient-results-table.tsx` (ATTACHMENT_MISSING_PREFIX mapping, attachmentNames map, escaped JSX text); `results-csv.ts` + export route resolve attachment_id → filename |
| `next.config.ts` | bodySizeLimit bump | ✓ VERIFIED | SDK pattern check passed |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| storage.ts | UPLOADS_PATH | env-dir resolver | ✓ WIRED | SDK verified |
| lib/core/index.ts | attachment-column.ts | barrel re-export | ✓ WIRED | SDK verified |
| lib/data/attachments.ts | attachments table | and(eq(id), eq(userId)) | ✓ WIRED | Manual (SDK regex error): lines 104, 116 |
| stampCampaignOnPendingAttachments | draft-campaign claim window | isNull OR still-draft inArray | ✓ WIRED | Manual: lines 143-151 |
| matchAttachmentsCore | computeAttachmentMatch | CSV re-read → shared matcher | ✓ WIRED | Manual: actions-core.ts:333 |
| next.config.ts | bodySizeLimit | 10MB+overhead bump | ✓ WIRED | SDK verified |
| prepareCampaignCore | stampCampaignOnPendingAttachments | post-draft stamp | ✓ WIRED | Manual: campaign/actions-core.ts:399 |
| buildConfirmSummaryCore | computeAttachmentMatch | stamped attachments vs stored CSV | ✓ WIRED | Manual: campaign/actions-core.ts:479, 534-535 |
| enqueueCampaignCore | presence/size recheck | server-side block pre-DAL | ✓ WIRED | Manual: attachments_blocked branch before enqueueCampaignDal |
| worker/process.ts | getAttachmentByIdForCampaign / resolveAttachmentPath / attachmentExists | attachment_id → opaque path | ✓ WIRED | SDK verified |
| worker/process.ts | fenced failed branch | 'sending'→'failed' one transaction | ✓ WIRED | SDK verified |
| attachments-card.tsx | lib/attachments/actions | upload/delete/confirm/match | ✓ WIRED | SDK verified; matchAttachments invoked from compose-editor.tsx:226 (parent host) |
| confirm-send-dialog.tsx | missingAttachmentCount / oversizeRowCount | confirmDisabled extended | ✓ WIRED | SDK verified |
| export route | listAttachmentsForCampaign | per-record filename | ✓ WIRED | SDK verified |

Note: SDK reported 6 key-link "failures" for plans 07-02/07-03 — all were tool artifacts (`from` fields are function names, not file paths; one invalid escaped regex). Every one verified manually against source.

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| attachments-card.tsx | `match` (AttachmentMatch) | compose-editor.tsx:226 `matchAttachments(setId)` → matchAttachmentsCore → CSV re-read + pending DAL query | Yes (DB + disk) | ✓ FLOWING |
| confirm-send-dialog.tsx | `summary` | buildConfirmSummary server action → stamped-attachment DB query + shared matcher | Yes | ✓ FLOWING |
| recipient-results-table.tsx | `attachmentNames` | campaigns/[id]/page.tsx:71 `listAttachmentsForCampaign` DB query → Map built at :79-83 | Yes | ✓ FLOWING |
| CSV export route | `attachment` field | attachmentById map from DB rows (route.ts:44-55) | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Typecheck clean | `npx tsc --noEmit` | exit 0, no errors | ✓ PASS |
| Full test suite | `npm test` | 332 pass / 0 fail (incl. ATCH-01/02 worker attachment tests, CR-01 dangling-FK test) | ✓ PASS |
| Review-fix commits exist | `gsd-sdk query verify.commits 8f68823 2a64759 479d6be e17da86 159a261 bb20d02 41d7ce4 3909bd1` | all_valid: true (8/8) | ✓ PASS |

### Probe Execution

No `scripts/*/tests/probe-*.sh` probes exist in this project and no plan declares any. SKIPPED (not applicable).

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| ATCH-01 | 07-01..05 | Different file per CSV row via filename column + uploads | ✓ SATISFIED | SC1 evidence chain; test "forwarded to sendMail (ATCH-01)" passes |
| ATCH-02 | 07-03, 07-04 | Presence validated before send; missing file = blocking error | ✓ SATISFIED | SC2 evidence chain; enqueue gate + materialize/worker terminal-fail tests pass |
| ATCH-03 | 07-01, 07-02, 07-05 | Traversal-safe resolution + per-file/per-message limits | ✓ SATISFIED | SC3 evidence chain; guardedResolve + schema limits + matcher oversize gate |

No orphaned requirements: REQUIREMENTS.md maps exactly ATCH-01/02/03 to Phase 7 and all three are claimed by plans.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| — | — | No TBD/FIXME/XXX debt markers, no placeholder text, no stub returns in any phase-modified file | — | None |

All 8 review findings marked fixed (CR-01, WR-01..07) have real commits in history; IN-01..05 are informational (review's own classification) and remain non-blocking.

### Human Verification Required

#### 1. Coolify staging deploy + per-row attachment walkthrough (plan 07-06 — queued checkpoint)

**Test:** Redeploy the Phase 7 slice to the standing Coolify staging URL; confirm both containers healthy and UPLOADS_PATH volume shared; run a real send with per-row attachments over BYO SMTP.
**Expected:** Each recipient receives the correct per-row file; worker reads files the web container wrote.
**Why human:** SC4 requires the deployed two-container VPS topology — not verifiable from code.

#### 2. Blocking validation on staging

**Test:** Reference a filename in the CSV that was never uploaded; open the confirm-send dialog and attempt to send.
**Expected:** Missing-attachments alert, Confirm disabled, server refuses enqueue; nothing sends.
**Why human:** Rendered UX on the real deployment.

#### 3. Mid-run vanished-file graceful failure

**Test:** After enqueue, delete one attachment file from /data/uploads before its row sends.
**Expected:** Only that row fails with the friendly "attachment missing" reason; campaign completes for other rows.
**Why human:** Requires a live worker against the real volume.

#### 4. Compose attachments card per 07-UI-SPEC (deferred human-check from plan 07-05)

**Test:** On /compose with a list selected: upload two files, confirm/override the detected column, watch the match summary and blocking states.
**Expected:** Server-computed summary renders and updates after each upload/delete/column change.
**Why human:** Visual/interaction quality per UI spec.

### Gaps Summary

No code gaps. All three code-verifiable success criteria (SC1-SC3) and all 23 plan-level must-have truths are verified against the actual source with passing tests (332/332) and a clean typecheck. Post-review hardening (CR-01 terminal-fail on unmatched/dangling attachments, WR-01 idempotent re-claim, WR-02 quotas, WR-03 shared resolver, WR-04 enqueue-gate hardening, WR-05 migration copy, WR-06 filename sanitization, WR-07 column validation) is present in code with real commits. SC4 (staging deployment works) is the deliberately queued 07-06 human checkpoint — Phase 7 is not shipped until it passes, but it is not a code gap.

---

_Verified: 2026-07-16_
_Verifier: Claude (gsd-verifier)_
