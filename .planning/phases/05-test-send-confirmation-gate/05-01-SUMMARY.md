---
phase: 05-test-send-confirmation-gate
plan: 01
subsystem: data-access
tags: [dal, campaigns, tenancy, idempotency, tdd]
requires:
  - "campaigns table (Phase 1 migration drizzle/0000)"
  - "lib/db (sole SQLite opener)"
  - "seed DALs: recipients, templates, smtp"
provides:
  - "lib/data/campaigns.ts: createDraftCampaign, getCampaignForUser, enqueueCampaign, PersistableCampaign"
  - "atomic draft→queued enqueue guard (TEST-03 idempotency primitive)"
affects:
  - "Plan 05-03 (confirm gate) wires enqueueCampaign into the send surface"
tech-stack:
  added: []
  patterns:
    - "userId-scoped DAL (userId FIRST param, filtered; userId LAST on insert)"
    - "single-statement UPDATE ... WHERE status='draft' AND user_id=? as idempotency + IDOR signal"
key-files:
  created:
    - lib/data/campaigns.ts
    - lib/data/campaigns.test.ts
  modified:
    - lib/data/index.ts
decisions:
  - "No schema change — campaigns table already exists on disk; this plan adds only DAL functions"
  - "enqueueCampaign returns .returning({id}) so the affected-row count is the authoritative did-I-win signal — never SELECT-then-UPDATE"
metrics:
  duration: ~10m
  completed: 2026-07-13
  tasks: 2
  files: 3
requirements: [TEST-03]
---

# Phase 5 Plan 01: Campaigns DAL Summary

userId-scoped `campaigns` data-access layer with the atomic draft→queued enqueue guard that makes TEST-03 double-submit-proof — built TDD (RED test file, then GREEN implementation), no schema change.

## What Was Built

- **`lib/data/campaigns.ts`** — three functions mirroring the templates/recipients DAL shape:
  - `createDraftCampaign(userId, values)` — inserts a draft with `{ ...values, userId }` (userId LAST, so a smuggled owner key can never win — the a906a8f ownership-wins convention). `PersistableCampaign` is a `Pick<NewCampaign, "recipient_set_id" | "template_id" | "smtp_config_id">` that structurally omits `userId`.
  - `getCampaignForUser(userId, id)` — `findFirst` filtered by `and(eq(id), eq(userId))`; no fetch-by-id-alone path (IDOR defense, T-5-IDOR).
  - `enqueueCampaign(userId, id)` — single-statement `db.update(campaigns).set({ status: "queued" }).where(and(eq(id), eq(userId), eq(status, "draft"))).returning({ id })`. The returned row count IS the idempotency + IDOR signal: 1 on the first transition, 0 on any subsequent call, 0 for a cross-tenant caller.
- **`lib/data/campaigns.test.ts`** — six two-tenant assertions on a throwaway migrated temp DB. SMTP config seeded as encrypted bytes only (via `encrypt()` on a marker password), never logged.
- **`lib/data/index.ts`** — barrel re-export block for the campaigns DAL, matching the templates block.

## How It Was Verified

- `node --import tsx --test lib/data/campaigns.test.ts` → all 6 pass (RED confirmed first: `Cannot find module ./campaigns`).
- `npm test` → full suite green, **165/165** (159 prior + 6 new), no regression.
- Grep gates: `from "@/lib/db"` present in campaigns.ts; no `new Database`; `enqueueCampaign` uses a single `.update().set().where(and(...status='draft'))` with no `findFirst`/SELECT before it; `lib/data/index.ts` re-exports `createDraftCampaign`.

## Deviations from Plan

None — plan executed exactly as written.

## TDD Gate Compliance

- RED: `test(05-01): add failing two-tenant + atomic-enqueue tests for campaigns DAL` (d5bdce9) — file failed because `./campaigns` did not exist.
- GREEN: `feat(05-01): implement userId-scoped campaigns DAL with atomic enqueue guard` (69bcb6f) — all 6 assertions pass.
- REFACTOR: none needed; the DAL mirrors its verbatim analogs (templates.ts create/get, smtp.ts update shape).

## Threat Surface

All three threat-register dispositions for this plan are `mitigate` and are covered by tests:
- **T-5-IDOR** — `and(eq(id), eq(userId))` on read; `user_id` in the atomic enqueue WHERE. Cross-tenant read returns undefined; cross-tenant enqueue affects 0 rows (both tested).
- **T-5-DUPE** — single-statement `UPDATE ... WHERE status='draft'`; second call is a 0-row no-op (tested).
- **T-5-TAMPER-OWNER** — `PersistableCampaign` omits `userId`; `{ ...values, userId }` spreads userId LAST; the smuggled-owner test asserts the arg wins.

No new security surface introduced beyond the plan's threat model.

## Known Stubs

None.

## Self-Check: PASSED

- FOUND: lib/data/campaigns.ts
- FOUND: lib/data/campaigns.test.ts
- FOUND: lib/data/index.ts (modified)
- FOUND commit: d5bdce9 (RED)
- FOUND commit: 69bcb6f (GREEN)
