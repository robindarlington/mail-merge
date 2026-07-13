---
phase: 05-test-send-confirmation-gate
plan: 03
subsystem: api
tags: [confirmation-gate, server-actions, idempotency, idor, tdd, zod, campaigns]

# Dependency graph
requires:
  - phase: 05-test-send-confirmation-gate
    plan: 01
    provides: "lib/data/campaigns DAL — createDraftCampaign, getCampaignForUser, atomic enqueueCampaign guard"
  - phase: 05-test-send-confirmation-gate
    plan: 02
    provides: "lib/campaign actions/actions-core split + ActionError union + shared schema (campaignIdSchema, recipientSetIdSchema, templateIdSchema)"
  - phase: 04-compose-editor
    provides: "lib/compose actions-core resolve->read->parse pattern; lib/data/templates DAL"
  - phase: 01-foundation-db-crypto-core-engine
    provides: "lib/core pure primitives — fillMessage, analyzeMerge, extractTokens, countInvalidEmails, detectEmailColumn, parseCsv"
provides:
  - "lib/campaign/actions-core.ts — prepareCampaignCore + buildConfirmSummaryCore + enqueueCampaignCore seams + ConfirmSummary/PrepareResult/SummaryResult/EnqueueResult types"
  - "lib/campaign/actions.ts — prepareCampaign / buildConfirmSummary / enqueueCampaign \"use server\" wrappers"
affects: [05-04-confirm-gate-ui, 06-background-worker]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Server-authoritative confirm summary: every gate aggregate (count, invalid, gaps, unknown tokens, sendable, sample) recomputed server-side from the campaign's OWN stored FKs; the client passes only a campaignId"
    - "Prepare-at-review timing (A1/U7): the draft campaign is created at the review-and-send moment from all three NOT NULL FKs, not at template save"
    - "Atomic-guard result mapping: DAL enqueue's 0-row result maps to a benign already_queued (double-submit AND cross-tenant), never a duplicate transition"

key-files:
  created: []
  modified:
    - lib/campaign/actions-core.ts
    - lib/campaign/actions.ts
    - lib/campaign/actions-core.test.ts

key-decisions:
  - "buildConfirmSummaryCore resolves the campaign's SMTP config via getSmtpConfigForUser(userId) (single-row-per-user) rather than a by-id lookup — matches the plan interface and the DAL's single-config model"
  - "unknownTokens computed once from the column set (row-independent) via extractTokens+filter rather than a per-row analyzeMerge union — same result, cheaper"
  - "DAL enqueueCampaign imported into actions-core aliased as enqueueCampaignDal so the client-facing action enqueueCampaign (actions.ts) never shadows it"

metrics:
  duration: ~12min
  completed: 2026-07-13
  tasks: 3
  files: 3
requirements: [TEST-02, TEST-03]
---

# Phase 5 Plan 03: Confirmation Gate + Single Draft→Queued Transition Summary

Three server-side seams wire the un-bypassable live-send confirmation gate (TEST-02) and the single draft→queued transition (TEST-03) over the campaigns DAL: `prepareCampaignCore` creates the draft at the review-and-send moment from the caller's three FKs, `buildConfirmSummaryCore` returns a fully server-recomputed review payload (count, redacted sender, one merged sample, and every warning aggregate) that a tampered client cannot weaken, and `enqueueCampaignCore` maps the atomic DAL guard's 0-row result to a benign `already_queued` — all owner-scoped and proven RED→GREEN.

## Performance

- **Duration:** ~12 min
- **Completed:** 2026-07-13
- **Tasks:** 3
- **Files modified:** 3 (all extend Plan-02 seam files)

## Accomplishments

- **`prepareCampaignCore(userId, {recipientSetId, templateId})`** — validates the selected ids, resolves the recipient set + template through the userId-scoped DAL (cross-tenant/bogus id → `not_found`, nothing created) and the saved SMTP config (none → `no_smtp_config`), then `createDraftCampaign` wiring all three NOT NULL FKs. This is the A1/U7 timing: the draft is created at the review-and-send moment, not at template save.
- **`buildConfirmSummaryCore(userId, {campaignId})`** — the server-authoritative gate. Owner-scoped `getCampaignForUser`, then resolves the campaign's OWN FKs and recomputes every number server-side from the stored CSV + template: `recipientCount`, `invalidEmailCount` (`countInvalidEmails` over the resolved email column), `rowsWithGaps` (per-row `analyzeMerge().empty`), `unknownTokens` (row-independent `extractTokens` minus columns), `sendableCount`, one merged `sample` for row 1, and the redacted `senderIdentity` from `toSmtpConfigDto`. The client passes ONLY a campaignId.
- **`enqueueCampaignCore(userId, {campaignId})`** — calls the DAL's atomic `enqueueCampaign`; a `length !== 1` result (double-submit on an already-queued row OR a cross-tenant/not-draft caller) maps to the benign `already_queued`, never a second transition.
- **Three `"use server"` wrappers** (`prepareCampaign`, `buildConfirmSummary`, `enqueueCampaign`) — each `auth() → delegate to *Core(userId, input)`, mirroring the existing `sendTestBatchChunk` shape; erased type re-exports for the UI's contract.
- **9 new seam tests** extend the Plan-02 harness with a second tenant (USER_B, no SMTP config) and a non-trivial 3-row fixture (one bad email + one blank merge value + a `{{typo}}` unknown token), covering prepare (create/no_smtp_config/IDOR-no-row), summary (server-recomputed aggregates + sample + redaction + IDOR), and enqueue (once/already_queued/cross-tenant-refused-status-unchanged).

## Task Commits

1. **Task 1: Failing TEST-02/TEST-03 seam tests (RED)** — `eb86f73` (test)
2. **Task 2: Implement prepare + confirm-summary + enqueue seams (GREEN)** — `76107e6` (feat)
3. **Task 3: "use server" wrappers for prepare, summary, enqueue** — `99f7fa9` (feat)

_TDD: RED (`eb86f73`) → GREEN (`76107e6`). No separate refactor commit needed._

## Files Modified

- `lib/campaign/actions-core.ts` — added `ConfirmSummary` type, the `PrepareResult`/`SummaryResult`/`EnqueueResult` unions, and the three seams. No `"use server"` directive (verified). New imports of the reused pure primitives (`analyzeMerge`, `extractTokens`, `countInvalidEmails`, `detectEmailColumn`) and the campaigns DAL (`createDraftCampaign`, `getCampaignForUser`, `enqueueCampaign as enqueueCampaignDal`, `toSmtpConfigDto`).
- `lib/campaign/actions.ts` — three thin auth wrappers + erased type re-exports.
- `lib/campaign/actions-core.test.ts` — summary fixture + USER_B seed + 9 seam assertions.

## How It Was Verified

- `node --import tsx --test lib/campaign/actions-core.test.ts` → 18/18 pass (RED confirmed first: the three seams were `not a function`).
- `npm test` → full suite green, **183/183**, no regression.
- `npm run build` → clean (the `"use server"` module compiles under the Next server build; all 7 routes generated).
- `tsc --noEmit` → exit 0.
- Grep gates: `already_queued`, `toSmtpConfigDto`/`analyzeMerge`/`countInvalidEmails`, `flipped.length !== 1` all present in `actions-core.ts`; NO `"use server"` directive in `actions-core.ts`; all four wrappers export as functions and `actions.ts` carries the directive.

## Decisions Made

- **SMTP config resolved by user, not by id:** `buildConfirmSummaryCore` uses `getSmtpConfigForUser(userId)` (the single-row-per-user model) rather than a by-id lookup off `campaign.smtp_config_id`. This matches the plan's interface block and the DAL's single-config design; the campaign's `smtp_config_id` FK equals that row's id by construction.
- **`unknownTokens` computed once from columns:** an unknown token is unknown iff it is not a column (row-independent), so a single `extractTokens(mergeSource).filter(...)` pass replaces a per-row `analyzeMerge().unknown` union — same result, cheaper. `rowsWithGaps` still runs per-row (`.empty` IS row-dependent).
- **DAL enqueue aliased:** imported as `enqueueCampaignDal` in `actions-core.ts` so the client-facing action `enqueueCampaign` in `actions.ts` (which delegates to `enqueueCampaignCore`) can never shadow the DAL function.

## Deviations from Plan

None — plan executed exactly as written.

## Threat Surface

All seven Plan-03 threat-register dispositions are `mitigate` and covered:
- **T-5-IDOR** — prepare/summary resolve every FK via userId-scoped DALs; enqueue's WHERE carries `user_id`. Cross-tenant ids → `not_found` (prepare/summary) or `already_queued` (enqueue, 0-row), with no row created / status unchanged (tested).
- **T-5-TAMPER** — every summary aggregate recomputed server-side from the stored CSV + template; the client passes only a campaignId (a known-bad-email fixture yields `invalidEmailCount >= 1` from the id alone — tested).
- **T-5-DUPE** — enqueue maps the atomic DAL guard's 0-row result to `already_queued`; the second confirm is benign (tested).
- **T-5-CRED** — `senderIdentity` comes from `toSmtpConfigDto` (structurally omits the password); `JSON.stringify(summary)` grep asserts absence of the marker (tested).
- **T-5-ENDPOINT** — the three cores live in a non-`"use server"` module; only the auth wrappers are wire-callable (grep-verified).
- **T-5-XSS** — the merged sample is returned as plain strings; the UI (Plan 04) renders them as escaped text (contract noted).
- **T-5-SC** — no packages added.

No new security surface beyond the plan's threat model.

## Known Stubs

None.

## Next Phase Readiness

- The confirm-gate contract (`ConfirmSummary` + `PrepareResult`/`SummaryResult`/`EnqueueResult`) is ready for Plan 05-04's confirm-send dialog to consume directly from `@/lib/campaign/actions`: `prepareCampaign` on "Review and send" open, `buildConfirmSummary` to render the modal, `enqueueCampaign` on confirm (mapping `already_queued` to the benign "already sending" toast).
- Enqueuing ends at the campaign being `queued`; the live send + per-recipient send_records state machine remain Phase 6.

## Self-Check: PASSED

- FOUND: lib/campaign/actions-core.ts (modified)
- FOUND: lib/campaign/actions.ts (modified)
- FOUND: lib/campaign/actions-core.test.ts (modified)
- FOUND commit: eb86f73 (RED)
- FOUND commit: 76107e6 (GREEN)
- FOUND commit: 99f7fa9 (wrappers)

---
*Phase: 05-test-send-confirmation-gate*
*Completed: 2026-07-13*
