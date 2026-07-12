---
phase: 3
slug: csv-upload-parsing-recipient-mapping
status: draft
nyquist_compliant: true
wave_0_complete: true
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
| **Quick run command** | `node --import tsx --test lib/core/csv.test.ts lib/csv/schema.test.ts lib/csv/storage.test.ts lib/csv/actions-core.test.ts lib/data/recipients.test.ts` (phase-scoped) |
| **Full suite command** | `node --import tsx --test "lib/**/*.test.ts"` (also wired as `npm test` by 03-01) |
| **Estimated runtime** | ~5 seconds (87 existing tests + new) |

---

## Sampling Rate

- **After every task commit:** Run the phase-scoped quick command
- **After every plan wave:** Run the full suite command
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

*(Task IDs are `{plan}-T{n}`. Files/commands taken from the plan `<verify>` blocks; manual-only rows carry the browser/staging harness.)*

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 03-01-T1 | 03-01 | 1 | CSV-03, CSV-04 | — | detect + count on arbitrary column (pure) | unit | `node --import tsx --test lib/core/csv.test.ts` | ✅ lib/core/csv.test.ts (extended) | ⬜ pending |
| 03-01-T2 | 03-01 | 1 | CSV-01 | T-3-TRAV, T-3-DOS | UUID-pathed storage + upload zod guard | unit | `node --import tsx --test lib/csv/schema.test.ts lib/csv/storage.test.ts` | ✅ lib/csv/schema.test.ts, lib/csv/storage.test.ts | ⬜ pending |
| 03-02-T1 | 03-02 | 1 | CSV-05, AUTH-02 | T-3-IDOR | userId-first DAL, cross-tenant read blocked | integration (DAL) | `node --import tsx --test lib/data/recipients.test.ts` | ✅ lib/data/recipients.test.ts | ⬜ pending |
| 03-03-T1 | 03-03 | 2 | CSV-01..05 | T-3-IDOR, T-3-MISPARSE, T-3-ORPHAN | parse+save seams: userId inject, row-cap at parse, per-column invalidCounts, override, orphan-avoid | integration (action) | `node --import tsx --test lib/csv/actions-core.test.ts` | ✅ lib/csv/actions-core.test.ts | ⬜ pending |
| 03-03-T2 | 03-03 | 2 | CSV-01 | T-3-DOS | auth() wrappers + bodySizeLimit; no new test file | typecheck + full suite | `npx --no-install tsc --noEmit && node --import tsx --test "lib/**/*.test.ts"` | ✅ (existing suite) | ⬜ pending |
| 03-04-T1 | 03-04 | 3 | CSV-01, CSV-03, CSV-04 | T-3-XSS, T-3-DBLSUBMIT, T-3-COUNT | uploader UI: override recomputes from invalidCounts, informational count coloring | typecheck + manual | `npx --no-install tsc --noEmit` (+ manual browser harness) | ✅ (tsc) / manual | ⬜ pending |
| 03-04-T2 | 03-04 | 3 | CSV-05 | T-3-IDOR | /recipients RSC scoped list + nav slot | typecheck + build | `npx --no-install tsc --noEmit && npm run build` | ✅ (build) | ⬜ pending |
| 03-05-T2/T3 | 03-05 | 4 | CSV-01, CSV-05 | T-3-PERSIST, T-3-STAGING | staging deploy + durable-volume persistence | manual smoke | manual — Coolify staging URL + restart check | manual-only (VPS) | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

*(Synced to the actual plan file locations — detection lives in `lib/core/csv.ts`/`csv.test.ts`, not a separate `detect.test.ts`.)*

- [ ] Add `"test": "node --import tsx --test \"lib/**/*.test.ts\""` script to package.json (03-01 Task 1 — no test script exists yet; regression/post-merge gates rely on `npm test`)
- [ ] `lib/core/csv.test.ts` — EXTEND with `detectEmailColumn` (name match, `Work Email` normalized, `mailing_city` substring reject, content-sampling fallback, no-email→null) + `countInvalidEmails` (arbitrary column) cases (03-01 Task 1 — CSV-03/CSV-04)
- [ ] `lib/csv/schema.test.ts` — upload guard accept/reject + `confirmColumnSchema` (03-01 Task 2 — CSV-01/V5)
- [ ] `lib/csv/storage.test.ts` — `writeUpload` returns relative uuid path, never the user filename, creates dir (03-01 Task 2 — CSV-04 / V12 traversal safety)
- [ ] `lib/data/recipients.test.ts` — create/list/get scoped to userId; two-tenant IDOR (03-02 Task 1 — CSV-05/AUTH-02)
- [ ] `lib/csv/actions-core.test.ts` — parse+save seams incl. per-column `invalidCounts`, parse-time `too_many_rows`, override, end-to-end persistence (03-03 Task 1 — CSV-01..05)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Upload flow renders and completes in a real browser (incl. override recomputes the invalid count) | CSV-01, CSV-04 | File-input + Server Action FormData path needs a live browser | Sign in on local dev, upload a fixture CSV, confirm the parse summary renders, override the email column and confirm the invalid/valid line updates to the new column's count |
| Staging deploy works (success criterion 5) | CSV-05 | Requires user's Coolify dashboard/VPS | Redeploy on Coolify, repeat upload on staging URL, confirm the saved set survives a container restart |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies (03-04 UI + 03-05 deploy carry documented manual-only harnesses)
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references (synced to real file paths)
- [x] No watch-mode flags
- [x] Feedback latency < 30s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved (planner — revision pass 2026-07-13)
