---
phase: 3
slug: csv-upload-parsing-recipient-mapping
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-13
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | node:test via tsx loader (established Phases 1–2) |
| **Config file** | none — no config needed; tests colocated as `lib/**/*.test.ts` |
| **Quick run command** | `npx tsx --test lib/csv/*.test.ts lib/data/recipients.test.ts` (phase-scoped) |
| **Full suite command** | `node --import tsx --test "lib/**/*.test.ts"` |
| **Estimated runtime** | ~5 seconds (87 existing tests + new) |

---

## Sampling Rate

- **After every task commit:** Run the phase-scoped quick command
- **After every plan wave:** Run the full suite command
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

*(Filled by planner — task IDs assigned at planning time. Populated from RESEARCH.md §Validation Architecture.)*

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| — | — | — | CSV-01..05 | T-3-* | see plans | unit | see quick command | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] Add `"test": "node --import tsx --test \"lib/**/*.test.ts\""` script to package.json (RESEARCH.md flagged: no test script exists — regression/post-merge gates rely on `npm test`)
- [ ] `lib/csv/detect.test.ts` — stubs for email-column detection heuristic (CSV-02)
- [ ] `lib/csv/storage.test.ts` — stubs for UUID-pathed storage writer (CSV-04 / traversal safety)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Upload flow renders and completes in a real browser | CSV-01 | File-input + Server Action FormData path needs a live browser | Sign in on local dev, upload a fixture CSV, confirm parse summary renders |
| Staging deploy works (success criterion 5) | CSV-05 | Requires user's Coolify dashboard/VPS | Redeploy on Coolify, repeat upload on staging URL |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
