---
phase: 05-test-send-confirmation-gate
plan: 04
subsystem: ui
tags: [test-send, confirmation-gate, compose, dialog, client-driver, shadcn]

# Dependency graph
requires:
  - phase: 05-test-send-confirmation-gate
    plan: 02
    provides: "sendTestBatchChunk action + TestSendResult cursor ({nextOffset, done, total}) + schema constants (TEST_SEND_DELAY_MS, testAddressSchema)"
  - phase: 05-test-send-confirmation-gate
    plan: 03
    provides: "prepareCampaign / buildConfirmSummary / enqueueCampaign actions + ConfirmSummary type + already_queued benign path"
  - phase: 04-compose-editor
    provides: "ComposeEditor client shell (selectedId, activeSet.row_count, onSave→saveTemplate{id}) + compose RSC"
  - phase: 02-smtp-onboarding
    provides: "getSmtpConfigForUser DAL + step-test-send.tsx voice/structure"
provides:
  - "components/campaign/test-send-panel.tsx — client chunk-loop driver for the whole-batch test-send"
  - "components/campaign/confirm-send-dialog.tsx — undismissable server-authoritative confirm gate"
  - "components/campaign/send-card.tsx — gated Send card wiring test-send + confirm gate"
  - "compose page + editor wired to pass SMTP presence + default test email"
affects: [06-background-worker]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Client chunk-loop driver: a while-loop over sendTestBatchChunk follows the server {nextOffset, done, total} cursor to drive the whole batch across bounded requests — no client-side row limit"
    - "Undismissable Dialog gate: showCloseButton={false} + preventDefault on onInteractOutside/onEscapeKeyDown makes the confirm modal closable only via Cancel or successful enqueue"
    - "Stale-summary guard: two effects (open-transition + [recipientSetId, templateId]) reset campaignId/summary so a review never renders a summary from a prior selection"

key-files:
  created:
    - components/campaign/test-send-panel.tsx
    - components/campaign/confirm-send-dialog.tsx
    - components/campaign/send-card.tsx
  modified:
    - components/compose/compose-editor.tsx
    - app/(app)/compose/page.tsx

key-decisions:
  - "Large-set soft-warning threshold set to recipientCount > 50 (no numeric threshold in the spec) — prominence only, never a hard block (Assumption U2)"
  - "TestSendPanel is rendered only when a template is saved (its templateId prop is a number); the no-template gate shows help text + a disabled Review-and-send button instead"
  - "ConfirmSendDialog is mounted only when templateId !== null && hasSmtpConfig so TS narrows templateId to number and a stale draft is never prepared while gated"

metrics:
  duration: ~7min
  completed: 2026-07-13
  tasks: 3
  files: 5
requirements: [TEST-01, TEST-02, TEST-03]
---

# Phase 5 Plan 04: Test-Send Panel + Confirmation Gate UI Summary

The user-facing Phase-5 slice: a gated "Send" card on `/compose` that (a) drives the whole personalized batch to one test address by looping the chunked Server Action client-side with live sent/total progress and a soft duration note (no row limit), and (b) gates a live send behind an undismissable confirmation modal that renders the server-authoritative count / sender / merged sample / warnings and enqueues exactly once — a second confirm is the benign already-queued toast. TEST-01/02/03 are now reachable end-to-end in the browser.

## Performance

- **Duration:** ~7 min
- **Completed:** 2026-07-13
- **Tasks:** 3
- **Files:** 3 created, 2 modified

## Accomplishments

- **`test-send-panel.tsx`** — `"use client"` panel mirroring `step-test-send.tsx` (address Input → outline/secondary Send/Loader2 CTA → destructive total-failure Alert → Collapsible technical details). A `while` loop calls `sendTestBatchChunk` over the `offset`/`nextOffset` cursor until `done`, accumulating `{sent, failed, errors}`, showing live `Sent X of Y…` progress, an all-sent (`CheckCircle2`/`text-success`) or partial-failure (`AlertCircle` per-message) summary, and a soft duration note that turns prominent (`AlertTriangle`) for large sets — with NO client-side truncation.
- **`confirm-send-dialog.tsx`** — `"use client"` undismissable gate. On every open transition (and on `[recipientSetId, templateId]` change) it resets prior state, `prepareCampaign` → `buildConfirmSummary`, showing `Skeleton` rows while loading. Renders the count row (with muted "N skipped — invalid email"), sender identity, an escaped merged sample (`whitespace-pre-wrap`, never raw HTML), and the exact warning classification (`AlertTriangle` unknown-token / `AlertCircle`(muted) / `CheckCircle2`(text-success)). Footer: `outline` Cancel + single accent "Send to {sendableCount} recipients" confirm, disabled while loading / zero-sendable / queuing. Confirm `enqueueCampaign`s; `already_queued` is a neutral toast, other errors a destructive Alert (modal stays open).
- **`send-card.tsx`** — `"use client"` `Card` titled "Send"; gates on `templateId !== null && hasSmtpConfig` with the exact disabled-state help copy (no-template / settings-link). "Review and send" is the sole accent button; the test-send button is `outline`.
- **`compose-editor.tsx`** — captures `savedTemplateId` from `saveTemplate`'s `res.data.id` on save success, accepts `hasSmtpConfig`/`defaultTestEmail` props, and renders `<SendCard>` below `<PreviewStepper>`. Save/preview/autocomplete behavior unchanged.
- **`compose/page.tsx`** — reads SMTP presence via `getSmtpConfigForUser` (boolean only) and the Clerk primary email as the default test address, passing only the boolean + email string to the client (never the encrypted triple).

## Task Commits

1. **Task 1: Whole-batch test-send panel** — `659bb5e` (feat)
2. **Task 2: Undismissable confirm-send gate** — `b8fcdce` (feat)
3. **Task 3: Send card + compose wire-in/gating** — `c113587` (feat)

## How It Was Verified

- `npx tsc --noEmit` → clean (exit 0).
- `npm run build` → compiles clean, all 7 routes generated (`/compose` dynamic).
- `npm test` → full suite green, **183/183**, no regression.
- Grep gates: `sendTestBatchChunk` + `while` + `nextOffset` present, no `cap`/`slice(0,` truncation in the panel; `buildConfirmSummary` + `whitespace-pre-wrap` + `showCloseButton` + `preventDefault` + `already_queued` present in the dialog, `dangerouslySetInnerHTML` and client aggregate fns (`countInvalidEmails`/`analyzeMerge`) ABSENT; `getSmtpConfigForUser` in the page with no `password_enc`/`decrypt`; `SendCard`/`savedTemplateId` in the editor.

## Decisions Made

- **Large-set threshold `recipientCount > 50`:** the spec specifies a soft prominent warning for "large sets" without a number; 50 surfaces the `AlertTriangle` note early while remaining purely informational (no hard block, Assumption U2).
- **Panel rendered only with a saved template:** `TestSendPanel`'s `templateId` prop is a `number`, so it mounts only once `savedTemplateId !== null`; the no-template gate shows help + a disabled Review-and-send button rather than a second stubbed disabled test-send button.
- **Dialog mounted only when ready:** `ConfirmSendDialog` renders only under `templateId !== null && hasSmtpConfig`, which both narrows `templateId` to `number` for TS and avoids preparing a draft campaign while the card is gated.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed the settings help link to the real route**
- **Found during:** Task 3
- **Issue:** 05-UI-SPEC copy says the no-SMTP help "links to `/settings`", but no bare `/settings` route exists — the SMTP settings page is `/settings/smtp` (confirmed via the build route list and the existing `/settings/smtp` links in `dashboard/page.tsx`). A `/settings` link would 404.
- **Fix:** Pointed the `<Link>` in `send-card.tsx` at `/settings/smtp`, matching the actual route and the established dashboard convention.
- **Files modified:** components/campaign/send-card.tsx
- **Commit:** c113587

**Total deviations:** 1 auto-fixed (Rule 1 broken-link bug). Everything else executed as written.

## Threat Surface

All six Plan-04 threat-register dispositions are `mitigate` and satisfied:
- **T-5-XSS** — merged sample renders as escaped JSX text via `whitespace-pre-wrap`; no raw-HTML injection API used (grep-verified absent).
- **T-5-CRED** — the page passes only `hasSmtpConfig` (boolean) + the default email; no `password_enc`/`decrypt` in the page (grep-verified).
- **T-5-DUPE** — confirm disables in-flight (cosmetic); the real guard is the server atomic transition — a second confirm shows the benign already-queued toast.
- **T-5-TAMPER** — every count/sample/warning comes from `buildConfirmSummary`; the client computes no aggregates (grep-verified).
- **T-5-DOS** — the test-send loops bounded chunks; each request is short.
- **T-5-SC** — zero new shadcn components, zero new npm deps.

No new security surface beyond the plan's threat model.

## Known Stubs

None.

## Next Phase Readiness

- The full TEST-01/02/03 user story is reachable in the browser: gated Send card → whole-batch test-send with progress → undismissable confirm gate → single queued transition.
- The confirm flow ends at the campaign being `queued`; per-recipient live progress and the send-record state machine remain Phase 6. The Phase-6 worker can reuse the same `sendTestBatchChunk` primitives and the `enqueueCampaign` seam unchanged.

## Self-Check: PASSED

- FOUND: components/campaign/test-send-panel.tsx
- FOUND: components/campaign/confirm-send-dialog.tsx
- FOUND: components/campaign/send-card.tsx
- FOUND: components/compose/compose-editor.tsx (modified)
- FOUND: app/(app)/compose/page.tsx (modified)
- FOUND commit: 659bb5e (Task 1)
- FOUND commit: b8fcdce (Task 2)
- FOUND commit: c113587 (Task 3)

---
*Phase: 05-test-send-confirmation-gate*
*Completed: 2026-07-13*
