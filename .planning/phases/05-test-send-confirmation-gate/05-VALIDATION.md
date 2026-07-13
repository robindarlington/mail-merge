---
phase: 5
slug: test-send-confirmation-gate
status: draft
nyquist_compliant: false
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
| — | — | — | TEST-01..03 | T-5-* | see plans | unit | see quick command | ❌ W0 | ⬜ pending |

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

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
