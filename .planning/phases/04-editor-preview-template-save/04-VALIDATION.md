---
phase: 4
slug: editor-preview-template-save
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-13
---

# Phase 4 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | node:test via tsx loader (established Phases 1–3) |
| **Config file** | none — tests colocated as `lib/**/*.test.ts` |
| **Quick run command** | phase-scoped: `node --import tsx --test lib/core/merge-gaps.test.ts lib/csv/storage.test.ts lib/data/templates.test.ts lib/compose/actions-core.test.ts` (paths per plans) |
| **Full suite command** | `npm test` (123 existing tests + new) |
| **Estimated runtime** | ~6 seconds |

---

## Sampling Rate

- **After every task commit:** Run the phase-scoped quick command
- **After every plan wave:** Run `npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

*(Filled by planner at planning time from RESEARCH.md §Validation Architecture.)*

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| — | — | — | EDIT-01..04, PREV-01..03 | T-4-* | see plans | unit | see quick command | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] Merge-gap pure helper tests (`analyzeMerge`/`extractTokens` — empty vs unknown token distinction, PREV-02/03)
- [ ] `readUpload` read-seam tests (traversal-safe read-back of stored CSVs)
- [ ] Templates DAL tests (userId-first, two-tenant IDOR harness — EDIT-04)
- [ ] Compose actions-core seam tests (preview + save template paths)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| `{{`-triggered autocomplete popover + click-to-insert in a real browser | EDIT-01, EDIT-02 | Caret/keyboard interaction needs a live browser | Local dev browser harness: compose against a saved recipient set, type `{{`, confirm column suggestions insert correctly into subject and body |
| Row stepping + empty-value highlight rendering | PREV-01, PREV-02 | Visual state | Step through rows of the fixture set; row with empty column value shows highlight |
| Staging deploy works (success criterion 5) | PREV-03 + SC5 | Requires user's Coolify dashboard | Redeploy on Coolify, repeat compose/preview on staging URL |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
