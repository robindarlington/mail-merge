---
phase: 06-background-worker-live-send-progress-history
plan: 02
subsystem: worker
tags: [worker, send-loop, idempotency, crash-safety, smtp, tdd]
requires:
  - lib/core (sendOne/verifyTransport/createSmtpTransport/throttle/fillMessage/parseCsv/detectEmailColumn)
  - lib/crypto (decrypt)
  - lib/csv (readUpload)
  - lib/data (getRecipientSetForUser/getTemplateForUser/getSmtpConfigByIdForUser/createDraftCampaign)
  - lib/db (db, connection, send_records, campaigns, Campaign)
provides:
  - materializeSendRecords(campaign) — CSV→fill→INSERT ON CONFLICT DO NOTHING + campaign.total reconcile
  - runCampaign(campaign, opts) — verify-once then the pending-row send loop with per-row commit
affects:
  - lib/worker/loop.ts (Plan later — composes claim→recover→materialize→run→finalize)
  - worker/index.ts (thin entrypoint that will call the loop)
tech-stack:
  added: []
  patterns:
    - "materialize-once idempotent insert (onConflictDoNothing over UNIQUE(campaign_id,to_addr))"
    - "per-row synchronous commit around a non-transactional SMTP await (better-sqlite3)"
    - "verify-once-per-run before the send loop"
    - "transient-decrypt SMTP password used only to build the transport"
key-files:
  created:
    - lib/worker/materialize.ts
    - lib/worker/materialize.test.ts
    - lib/worker/process.ts
    - lib/worker/process.test.ts
  modified: []
decisions:
  - "campaigns.total reconciled to the materialized send_records count (dedup-honest), not the raw CSV row count (A3)"
  - "verify failure or missing/unknown SMTP config aborts the whole run with a reason string; no rows sent (A5 / Open Question 2)"
  - "orphaned-'sending' recovery is out of this plan's scope — Plan 01 owns the sweep; this plan writes 'sending' before the await so orphans are detectable"
metrics:
  tasks_completed: 2
  files_created: 4
  files_modified: 0
  tests_added: 12
  commits: 4
  completed: 2026-07-15
requirements: [SEND-02, SEND-03, SEND-04, SEND-06]
---

# Phase 6 Plan 02: Per-Recipient Send Core (materialize + process) Summary

The two per-recipient correctness seams of the background worker: `materializeSendRecords` turns a claimed campaign's stored CSV + template into one `pending` `send_record` per unique recipient (idempotent on resume, duplicate addresses collapsed, `campaigns.total` reconciled), and `runCampaign` verifies SMTP once then walks the `pending` rows sending one personalized email each, committing every outcome immediately — surviving per-row failure, resuming without double-send, and never leaking the SMTP password.

## What Was Built

### Task 1 — `materializeSendRecords` (lib/worker/materialize.ts)
- Resolves the campaign's OWN recipient set + template owner-scoped from `campaign.userId` (worker tenancy exception — no Clerk session).
- Reads + parses the stored CSV via the tested `readUpload` + `parseCsv` primitives; resolves the email column as `set.email_column ?? detectEmailColumn(...)` (the user-confirmed column wins).
- Inserts one `send_record` per row with `fillMessage`-personalized subject + body, using `.onConflictDoNothing()` against `UNIQUE(campaign_id, to_addr)` so a duplicate address (or a re-claimed campaign) is a silent no-op — `.returning()` length is the "did I insert?" signal.
- Reconciles `campaigns.total` to `count(*)` over the campaign's send_records so progress math stays honest after dedup, and returns `{ inserted, total }`.

### Task 2 — `runCampaign` (lib/worker/process.ts)
- Resolves the campaign's OWN stamped SMTP config owner-scoped by id (06.1 multi-server); an unknown/deleted/cross-tenant id → `{ ok:false, reason:'no SMTP config' }`.
- Decrypts the AES-256-GCM triple into a transient local used ONLY to build the transport (skipped when a test injects one); `from` is `from_name ? "Name <addr>" : addr`.
- `verifyTransport` runs once before the first send; a throw aborts the run with a reason string (no rows sent) after the `close()` guard.
- Selects `status='pending'` rows `ORDER BY id`; per row: commits `'sending'` BEFORE the `await sendOne` (crash-orphan detectable), then commits `'sent'`(+message_id,+sent_at)+bump `sent_count` or `'failed'`(+error string,+attempts)+bump `failed_count`. The SMTP await is never wrapped in a transaction (better-sqlite3 is synchronous).
- A per-row failure never aborts the batch (`sendOne` returns a structured value); `throttle(delayMs)` is applied between sends only; `onHeartbeat(campaignId)` fires per row. Returns `{ ok:true, sent, failed }`.

## Tests

TDD RED→GREEN per task. `npm test` full suite green: **224 passing, 0 failing**.

- `lib/worker/materialize.test.ts` (4 tests): dup-address collapse (4 raw rows → 3 unique send_records), `total` reconciled to the materialized count (not raw rows), idempotent resume (second call inserts 0), per-row merged subject/body snapshot with `pending` default.
- `lib/worker/process.test.ts` (8 tests): verify-once + all-sent transitions; per-row failure continues the batch (SEND-04) with `failed_count`=1 and `error` as the message string; resume sends only pending rows (SEND-06); verify-failure and missing-SMTP-config whole-run aborts; password redaction on the error path; throttle-between-only (timing); heartbeat-per-row.

## Verification Evidence

- `node --import tsx --test lib/worker/materialize.test.ts` → 4/4 pass.
- `node --import tsx --test lib/worker/process.test.ts` → 8/8 pass.
- `npm test` → 224/224 pass.
- Grep gates: `materialize.ts` contains `.onConflictDoNothing(` + a `count(*)` reconcile, imports `fillMessage/parseCsv/detectEmailColumn` from `@/lib/core`, and has no `.split(",")` / `.replace(/{{`. `process.ts` writes `status: "sending"` (line 136) before `await sendOne` (line 142), stores `res.error.message` (string, not a raw Error), and is not wrapped in `db.transaction(`.
- Phase grep gate: `grep -rn "new Database|nodemailer.createTransport|require('crypto')|node:crypto" lib/worker/` → nothing (no re-implemented transport/crypto).
- `lib/db/schema.ts`, `drizzle/`, and `lib/core/*` unmodified.

## Threat Mitigations Applied

- **T-06-04 (password disclosure):** password decrypted into a transient local used only to build the transport; redaction test asserts the marker password is absent from `JSON.stringify(result)` and every `send_record` (including the error path).
- **T-06-05 (error-reason leakage):** `send_records.error` stores `res.error.message` (string) only.
- **T-06-06 (double-send on resume):** process `status='pending'` only; `'sending'` written before the attempt; resume test asserts an already-`sent` row is never re-sent.
- **T-06-07 (partial-batch abort):** `sendOne` never throws; per-row continue; `failed_count` surfaced.

## Deviations from Plan

None — plan executed exactly as written. The plan's suggested `detectEmailColumn` return type was `string | undefined`; the actual signature returns `string | null`, handled with a truthy `if (!emailColumn)` guard (no behavior change).

## Known Stubs

None. Both seams are fully wired to real primitives; tests inject a stub transport only (the standard socket-free test seam), not a stub in production code.

## Notes for Downstream Plans

- `lib/worker/loop.ts` (composition) should call `materializeSendRecords` immediately after claim, then `runCampaign`; a `runCampaign` `{ ok:false, reason }` maps to `markFailed`, and `{ ok:true }` after draining pending maps to `markCompleted` (A5 terminal rule).
- Orphaned-`'sending'` recovery is intentionally not here — Plan 01's recovery sweep should run before `runCampaign` on a re-claim. `runCampaign` deliberately writes `'sending'` before each attempt to make those orphans detectable.
- `runCampaign` accepts `delayMs` (env-sourced `SEND_DELAY_MS` at the entrypoint, A6) and `onHeartbeat` (lease bump, Pattern 4) — both injected by the loop.

## Self-Check: PASSED

All 4 source/test files exist on disk; all 4 task commits (2e43043, 272895d, f7afcbc, 67333ee) exist in git history.
