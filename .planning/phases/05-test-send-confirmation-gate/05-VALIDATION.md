---
phase: 5
slug: test-send-confirmation-gate
status: planned
nyquist_compliant: true
wave_0_complete: false
created: 2026-07-13
---

# Phase 5 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | node:test via tsx loader (established Phases 1–4) |
| **Config file** | none — tests colocated as `lib/**/*.test.ts` |
| **Quick run command** | phase-scoped (paths per plans): `node --import tsx --test lib/data/campaigns.test.ts lib/campaign/actions-core.test.ts` |
| **Full suite command** | `npm test` (159 existing tests + new) |
| **UI compile gate** | `npm run build` |
| **Estimated runtime** | ~7 seconds (unit) + build |

---

## Sampling Rate

- **After every task commit:** Run the phase-scoped quick command (unit) or `npm run build` (UI tasks)
- **After every plan wave:** Run `npm test`
- **Before `/gsd:verify-work`:** Full suite green + build clean
- **Max feedback latency:** 30 seconds (unit)

---

## Per-Task Verification Map

*(Filled by planner at planning time from RESEARCH.md §Validation Architecture.)*

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 01-T1 | 05-01 | 1 | TEST-03 | T-5-IDOR | userId-first campaigns DAL, cross-tenant undefined | unit | `node --import tsx --test lib/data/campaigns.test.ts` | ❌ W0 | ⬜ pending |
| 01-T2 | 05-01 | 1 | TEST-03 | T-5-DUPE | atomic draft→queued, affected-rows guard | unit | `node --import tsx --test lib/data/campaigns.test.ts` | ❌ W0 | ⬜ pending |
| 02-T1/T2/T3 | 05-02 | 1 | TEST-01 | T-5-CRED, T-5-DOS | chunked whole-batch send seam, injected fake transport, verify on chunk 0, throttle between sends | unit | `node --import tsx --test lib/campaign/actions-core.test.ts` | ❌ W0 | ⬜ pending |
| 03-T1/T2/T3 | 05-03 | 2 | TEST-02, TEST-03 | T-5-TAMPER, T-5-IDOR | prepare/summary/enqueue seams, server-recomputed counts, campaignId-only client chain | unit | `node --import tsx --test lib/campaign/actions-core.test.ts` | ❌ W0 | ⬜ pending |
| 04-T1/T2/T3 | 05-04 | 3 | TEST-01/02/03 | T-5-XSS, T-5-DUPE | Send card + undismissable confirm modal, escaped sample render, stale-summary reset, disable-while-pending | build+human | `npm run build` + browser harness | ❌ UI | ⬜ pending |
| 05-T1/T2 | 05-05 | 4 | all + SC4 | T-5-PERSIST | staging deploy + real test-send to user inbox + confirm-gate walkthrough | manual | Coolify + user inbox | manual-only | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] Campaigns DAL tests (userId-first, draft creation with 3 FKs, two-tenant IDOR — TEST-03 surface)
- [ ] Atomic draft→queued transition tests (`UPDATE ... WHERE status='draft'` affected-rows guard; double-submit returns already-queued — TEST-03)
- [ ] Test-send seam tests with INJECTED fake transport (whole-batch fill preserved per-row, single test address, throttle honored, per-row failure doesn't abort batch — TEST-01; NO real SMTP in automated tests)
- [ ] Confirm-gate seam tests (server-recomputed counts/warnings — TEST-02; client-supplied aggregates must not be trusted)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Real test-send arrives in an inbox with per-row personalization | TEST-01 | Requires firing real email via the user's SMTP — user-authorized only | User (or user-approved run): compose → test-send to own address → confirm N personalized emails arrive |
| Confirmation modal content + double-submit UX | TEST-02, TEST-03 | Visual/interaction state | Browser harness: open confirm modal, check count/sender/sample/warnings render; hammer the confirm button — exactly one queued transition |
| Staging deploy works (success criterion 4) | SC4 | Requires user's Coolify dashboard | Redeploy on Coolify, repeat the flow on staging |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 30s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved (orchestrator sync after plan-checker pass, 2026-07-13)
