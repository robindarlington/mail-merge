---
phase: 6
slug: background-worker-live-send-progress-history
status: approved
nyquist_compliant: true
wave_0_complete: false
created: 2026-07-13
---

# Phase 6 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Populated from 06-RESEARCH.md `## Validation Architecture` + the 7 approved PLAN.md files.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | node:test (built-in) run via `node --import tsx --test` |
| **Config file** | none — glob in package.json `test` script (`lib/**/*.test.ts`; worker seams under `lib/worker/` are covered automatically) |
| **Quick run command** | `npm test` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~15 seconds (all seams stubbed, no sockets) |

---

## Sampling Rate

- **After every task commit:** Run `npm test`
- **After every plan wave:** Run `npm test` (full suite)
- **Before `/gsd:verify-work`:** Full suite must be green + manual crash-resume check (kill worker mid-batch, restart, assert no duplicate send)
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 06-01-01 | 01 | 1 | SEND-01, SEND-06 | T-06-01 / T-06-03 | Atomic claim wins exactly once (no TOCTOU); stalled-lease reclaim | unit (tdd) | `npm test` → `lib/worker/claim.test.ts` | ❌ W0 | ⬜ pending |
| 06-01-02 | 01 | 1 | SEND-06 | T-06-02 | Orphan sweep `sending→failed(interrupted:)` terminal, never re-pending; finalize clears lease | unit (tdd) | `npm test` → `lib/worker/recover`/`finalize` tests | ❌ W0 | ⬜ pending |
| 06-02-01 | 02 | 1 | SEND-06 | T-06-06 | Idempotent materialize: one `pending` row per CSV row, `ON CONFLICT DO NOTHING` on resume, `total` reconciled | unit (tdd) | `npm test` → `lib/worker/materialize.test.ts` | ❌ W0 | ⬜ pending |
| 06-02-02 | 02 | 1 | SEND-02, SEND-03, SEND-04, SEND-06 | T-06-04 / T-06-05 / T-06-07 | State transitions persisted with message-only errors; partial failure continues batch; pending-only processing (no double-send); decrypted password never serialized | unit (tdd) | `npm test` → `lib/worker/process.test.ts` | ❌ W0 | ⬜ pending |
| 06-03-01 | 03 | 1 | HIST-01, HIST-02 | T-06-08 | userId-scoped list + drill-down reads; cross-tenant id → not_found/[] | unit (tdd) | `npm test` → `lib/data/campaigns.test.ts` (extend) | ✅ extend | ⬜ pending |
| 06-03-02 | 03 | 1 | SEND-05 | T-06-09 / T-06-10 | `getCampaignProgressCore` IDOR-scoped; counts only, no error bodies; auth-guarded wrapper only is wire-callable | unit (tdd) | `npm test` → `lib/campaign/actions-core.test.ts` (extend) | ✅ extend | ⬜ pending |
| 06-04-01 | 04 | 2 | SEND-01, SEND-06 | T-06-13 | `tick()` composes claim→recover→materialize→run→finalize; single in-flight tick | unit (tdd) | `npm test` → `lib/worker/loop.test.ts` | ❌ W0 | ⬜ pending |
| 06-04-02 | 04 | 2 | SEND-01 | T-06-11 / T-06-12 | SIGTERM stop flag honored (in-flight tick finishes); pino logs contain no secret | unit + grep gate | `npm test` + grep gate in plan verify | ❌ W0 | ⬜ pending |
| 06-05-01 | 05 | 2 | HIST-01 | T-06-14 | Nav + userId-scoped campaign list RSC; unknown id → notFound() | manual + regression `npm test` | see Manual-Only | — | ⬜ pending |
| 06-05-02 | 05 | 2 | HIST-02 | T-06-14 / T-06-15 / T-06-16 | Detail page + results table; escaped JSX only; redacted SMTP DTO | manual + regression `npm test` | see Manual-Only | — | ⬜ pending |
| 06-05-03 | 05 | 2 | SEND-05 | T-06-14 | Live progress panel: 2s poll while running/queued, stops on terminal status | manual + regression `npm test` | see Manual-Only | — | ⬜ pending |
| 06-06-01 | 06 | 2 | HIST-03 | T-06-18 / T-06-19 | `toResultsCsv` quoting + formula-prefix (`= + - @`/tab/CR); message-only reasons | unit (tdd) | `npm test` → results-csv test | ❌ W0 | ⬜ pending |
| 06-06-02 | 06 | 2 | HIST-03 | T-06-17 | Export route `auth()` + owner filter; cross-tenant → 404 | manual/integration | see Manual-Only | — | ⬜ pending |
| 06-07-01 | 07 | 3 | SEND-01, SEND-05, SEND-06, HIST-01..03 | T-06-22 | Coolify staging redeploy; secrets set, never recorded | manual (auto-prep) | see Manual-Only | — | ⬜ pending |
| 06-07-02 | 07 | 3 | SEND-06 + all | T-06-20 / T-06-21 | [CHECKPOINT human-verify] real live send + hard-kill crash-resume with zero duplicates; cross-tenant export → 404 | manual checkpoint | see Manual-Only | — | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `lib/worker/claim.test.ts` — atomic claim wins once; stalled reclaim; concurrent-claim safety (SEND-01/06)
- [ ] `lib/worker/materialize.test.ts` — one pending row per CSV row; ON CONFLICT DO NOTHING on resume; total reconciled (SEND-06)
- [ ] `lib/worker/process.test.ts` — send-loop transitions, partial failure, resumability, orphan sweep, throttle-between-only (SEND-02/03/04/06)
- [ ] `lib/worker/loop.test.ts` — tick() composition; SIGTERM stop flag honored (SEND-01)
- [ ] `lib/data/campaigns.test.ts` (extend) — listCampaignsForUser, getSendRecordsForCampaign with cross-tenant exclusion (HIST-01/02)
- [ ] `lib/campaign/actions-core.test.ts` (extend) — getCampaignProgressCore IDOR + shape; toResultsCsv escaping/injection (SEND-05, HIST-03)
- [ ] Shared fixtures: reuse the existing temp-DB + `stubTransport` harness from `lib/campaign/actions-core.test.ts` / `lib/smtp/actions.test.ts` (no new fixture framework)
- [ ] Framework install: none — node:test + tsx already present

(TDD plans create these RED-first during execution; `wave_0_complete` flips true when the Wave 1 TDD tasks land.)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| History list / detail / progress pages render + poll | SEND-05, HIST-01, HIST-02 | RSC + polling UI; no component test harness in repo | Browser: /campaigns list, drill into a campaign mid-send, watch counts advance every ~2s and stop at terminal status |
| Export route auth + cross-tenant 404 | HIST-03 | Route handler needs a signed-in session | GET /campaigns/{id}/export signed in (200, CSV attachment); cross-tenant id → 404 |
| Crash-resume no-double-send on staging | SEND-06 | Requires killing the deployed worker mid-batch | 06-07-PLAN.md walkthrough: hard-kill worker mid-send, restart, assert zero duplicate emails + interrupted rows recorded |
| Staging slice works end-to-end (Coolify) | all | Deployment environment | 06-07-PLAN.md checkpoint: real live send to Rob's inbox on the standing staging URL |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies (checker Dimension 8: verified across all 7 plans)
- [x] Sampling continuity: no 3 consecutive tasks without automated verify (06-05's 3 UI tasks run `npm test` regression per commit)
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 60s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-07-13 (plan-checker Dimension 8 substance pass: 0 blockers; this artifact back-filled from 06-RESEARCH.md Validation Architecture)
