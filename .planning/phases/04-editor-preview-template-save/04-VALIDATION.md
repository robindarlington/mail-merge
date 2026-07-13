---
phase: 4
slug: editor-preview-template-save
status: planned
nyquist_compliant: true
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
| **Quick run command** | phase-scoped: `node --import tsx --test lib/core/merge.test.ts lib/csv/storage.test.ts lib/data/templates.test.ts lib/compose/schema.test.ts lib/compose/actions-core.test.ts` |
| **Full suite command** | `npm test` (123 existing tests + new) |
| **UI compile gate** | `npm run build` (typechecks the new /compose route + client components) |
| **Estimated runtime** | ~6 seconds (unit) + build |

---

## Sampling Rate

- **After every task commit:** Run the phase-scoped quick command (unit) or `npm run build` (UI tasks)
- **After every plan wave:** Run `npm test`
- **Before `/gsd:verify-work`:** Full suite must be green + `npm run build` clean
- **Max feedback latency:** 30 seconds (unit)

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 01-T1 | 04-01 | 1 | PREV-01/02/03 | — | pure engine, zero imports | unit | `node --import tsx --test lib/core/merge.test.ts` | ❌ W0 | ⬜ pending |
| 01-T2 | 04-01 | 1 | PREV-01/03 | T-4-TRAVERSAL | traversal-safe read-back | unit | `node --import tsx --test lib/csv/storage.test.ts` | ❌ W0 | ⬜ pending |
| 02-T1 | 04-02 | 1 | EDIT-04 | T-4-IDOR-TPL, T-4-TAMPER-OWNER | userId-first DAL, cross-tenant undefined | unit | `node --import tsx --test lib/data/templates.test.ts` | ❌ W0 | ⬜ pending |
| 02-T2 | 04-02 | 1 | EDIT-01 | T-4-SIZE | subject/body caps + non-empty | unit | `node --import tsx --test lib/compose/schema.test.ts` | ❌ W0 | ⬜ pending |
| 03-T1 | 04-03 | 2 | EDIT-04, PREV-01/02/03 | T-4-IDOR, T-4-LOG | server-authoritative counts, no content logging | unit | `node --import tsx --test lib/compose/actions-core.test.ts` | ❌ W0 | ⬜ pending |
| 03-T2 | 04-03 | 2 | EDIT-04, PREV-03 | T-4-ENDPOINT | only actions.ts is "use server" | unit+build | `npm test && npm run build` | ❌ W0 | ⬜ pending |
| 04-T1 | 04-04 | 3 | EDIT-01 | T-4-SC | official-shadcn-only, no npm dep | build+human | `npm run build` + browser harness | ❌ UI | ⬜ pending |
| 04-T2 | 04-04 | 3 | EDIT-01/02/04 | T-4-XSS-CHIP, T-4-CLIENTVAL | escaped chips, server re-validates | build+human | `npm run build` + browser harness | ❌ UI | ⬜ pending |
| 05-T1 | 04-05 | 4 | PREV-01/02/03, EDIT-03 | T-4-XSS, T-4-DIVERGE | escaped merged render, server aggregates | build+human | `npm run build` + browser harness | ❌ UI | ⬜ pending |
| 05-T2 | 04-05 | 4 | PREV-01/03 | T-4-IDOR | fetch-once, recipientSetId only | build+human | `npm run build` + browser harness | ❌ UI | ⬜ pending |
| 06-T1 | 04-06 | 5 | SC5 | T-4-PERSIST | deploy config unchanged/complete | automated | `docker compose config && npm run build` | ✅ | ⬜ pending |
| 06-T2 | 04-06 | 5 | EDIT/PREV all | T-4-AUTHZ, T-4-PERSIST | staging walkthrough + persistence | manual | Coolify redeploy + browser | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] Merge-gap pure helper tests (`analyzeMerge`/`extractTokens` — empty vs unknown token distinction, PREV-02/03) → `lib/core/merge.test.ts` (Plan 04-01 T1)
- [ ] `readUpload` read-seam tests (traversal-safe read-back of stored CSVs) → `lib/csv/storage.test.ts` (Plan 04-01 T2)
- [ ] Templates DAL tests (userId-first, two-tenant IDOR harness — EDIT-04) → `lib/data/templates.test.ts` (Plan 04-02 T1)
- [ ] Compose schema tests (subject/body caps + anchored messages) → `lib/compose/schema.test.ts` (Plan 04-02 T2)
- [ ] Compose actions-core seam tests (preview aggregate + not_found + save paths) → `lib/compose/actions-core.test.ts` (Plan 04-03 T1)

Wave 0 scaffolds are authored RED-first inside their owning TDD tasks (Plans 04-01/02/03), consistent with Phases 1–3.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| `{{`-triggered autocomplete popover + click-to-insert in a real browser | EDIT-01, EDIT-02 | Caret/keyboard interaction needs a live browser | Browser harness: compose against a saved set, type `{{`, confirm suggestions insert into subject AND body; click a chip inserts at caret |
| Row stepping + empty-value highlight rendering | PREV-01, PREV-02 | Visual state | Step rows of the fixture set; a row with an empty column value shows the neutral highlight note; subject renders personalized |
| Validation report counts + unknown-token warning | PREV-03 | Visual state | Confirm invalid-email + missing-value lines match server counts; a deliberate `{{typo}}` surfaces the AlertTriangle warning |
| Staging deploy works (success criterion 5) + persistence | SC5 | Requires user's Coolify dashboard | Redeploy on Coolify, repeat compose/preview/save on staging URL, restart container, confirm data survives |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 30s (unit)
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** planned
