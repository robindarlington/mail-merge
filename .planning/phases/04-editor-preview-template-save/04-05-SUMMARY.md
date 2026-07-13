---
phase: 04-editor-preview-template-save
plan: 05
subsystem: compose-preview-ui
tags: [compose, preview, validation-report, stepper, client-merge, shadcn]

# Dependency graph
requires:
  - "04-03: previewCampaign 'use server' action + PreviewReport type (columns/rows/totalRows/emailColumn/invalidEmailCount)"
  - "04-04: compose-editor.tsx (recipient Select, RHF subject/body, columns from columns_json)"
  - "04-01: fillMessage (lib/core/fill) + analyzeMerge (lib/core/merge) — browser-safe pure engines"
provides:
  - "components/compose/preview-stepper.tsx: client row stepper + merged escaped render + per-row empty-value highlight + client-computed validation report"
  - "compose-editor.tsx wiring: previewCampaign fetched once per list-change; PreviewStepper mounted with server-resolved emailColumn + invalidEmailCount + live subject/body"
affects: [compose, preview, 05-send]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "server vs client authority: emailColumn + invalidEmailCount are server props (template-INDEPENDENT); unknownTokens + rowsWithEmptyValues computed client-side over ALL rows in a useMemo keyed on [subject, body, columns, rows]"
    - "useDeferredValue on subject/body keeps typing responsive while the missing-value aggregate iterates the FULL row set"
    - "fetch-once-per-list-change effect with an ignore flag drops stale responses on rapid list switching"
    - "deep-import lib/core/fill + lib/core/merge (NOT the @/lib/core barrel) to keep nodemailer/send.ts out of the client bundle"

key-files:
  created:
    - components/compose/preview-stepper.tsx
  modified:
    - components/compose/compose-editor.tsx

key-decisions:
  - "preview-stepper imports fillMessage from @/lib/core/fill and analyzeMerge from @/lib/core/merge directly — the @/lib/core barrel re-exports send.ts (nodemailer → child_process/dns/fs) and breaks the client build; the two pure engines are import-free and browser-safe"
  - "current-row index is clamped derived state (Math.min(step, total-1)) + reset to 0 on rows change, so switching to a shorter list can never index out of bounds"
  - "idle gate = no rows OR empty subject+body; the report + stepper appear once a list is loaded AND the template has content, matching the select-then-type flow"
  - "unknown tokens analyzed against rows[0] (template-level: a key not in columns is unknown regardless of row value); rowsWithEmptyValues iterates ALL rows via rows.filter"

requirements-completed: [EDIT-03, PREV-01, PREV-02, PREV-03]

# Metrics
duration: ~15min
completed: 2026-07-13
---

# Phase 4 Plan 05: Preview Stepper + Pre-Send Validation Report Summary

**The "prove the merge before you send" payoff: selecting a recipient list fetches all parsed rows + the template-INDEPENDENT server fields (resolved To: column + invalid-email count) once, then a new `preview-stepper.tsx` steps through the rows client-side — rendering each row's merged subject/body via `fillMessage` as escaped `whitespace-pre-wrap` text, highlighting rows with blank merge values, and computing the template-DEPENDENT report aggregates (unknown tokens + rows-with-empty-values) reactively over ALL rows so a typed `{{typo}}` surfaces the AlertTriangle warning instantly with no refetch.**

## Performance

- **Duration:** ~15 min
- **Tasks:** 2 (both `type="auto"`)
- **Files created:** 1 (+1 modified)

## Accomplishments

- **Task 1** — `components/compose/preview-stepper.tsx` (`"use client"`): props `{ subject, body, columns, rows, totalRows, invalidEmailCount, emailColumn, loading }`. Renders `Skeleton` blocks while `loading`; the idle copy ("Choose a recipient list and write your message to see a preview.") when there are no rows or the template is empty; otherwise a stepper header ("Recipient {i+1} of {total}", outline Previous/Next with `ChevronLeft`/`ChevronRight`, disabled at bounds), the merged `To:`/`Subject:` header (`To:` sourced from `rows[i][emailColumn]` via the server-resolved prop — never a client re-detection), a `Separator`, and `merged.body` inside `whitespace-pre-wrap` (escaped JSX text, no `dangerouslySetInnerHTML`). A neutral `AlertCircle` per-row note lists blank fields via `analyzeMerge`. The Validation report `Card` computes `unknownTokens` + `rowsWithEmptyValues` client-side in a `useMemo` (keyed on `[deferredSubject, deferredBody, columns, rows]`, iterating ALL rows via `rows.filter`), and shows the AlertTriangle unknown-token warning at top, the server `invalidEmailCount` line, and the client missing-values line — each with its `text-success`/`CheckCircle2` all-clear variant.
- **Task 2** — `compose-editor.tsx`: a `useEffect` keyed on `selectedId` calls `previewCampaign(fd)` with FormData carrying ONLY `recipientSetId`, guarded by `setPreviewLoading` and an `ignore` flag (drops stale responses on rapid list switching). On `res.ok` it stores the `PreviewReport`; on failure it maps `unauthenticated` → destructive `Alert`, `not_found`/other → a neutral muted note. `<PreviewStepper>` is mounted beneath the editor Card with `emailColumn={report?.emailColumn ?? null}` and `invalidEmailCount={report?.invalidEmailCount ?? 0}` threaded straight from the server result, and live `watch("subject")`/`watch("body")` for the client-side merge + report recompute. No `previewCampaign` call runs per stepper step or per keystroke — only on list change.

## Task Commits

1. **Task 1: preview stepper with client-computed validation report** — `1380fb0` (feat)
2. **Task 2: wire previewCampaign into compose-editor and mount stepper** — `c4a1476` (feat)

## Verification

- `npm run build` → compiled successfully; `/compose` present (ƒ dynamic).
- `npm test` (full suite) → **159 pass, 0 fail** (no backend regression).
- Task 1 grep gates: `fillMessage` ✓, `analyzeMerge` ✓ (5), `rows[i][emailColumn]` ✓, `detectEmailColumn` = 0 ✓, `rows.(filter|reduce|some|forEach|map)` ✓, `dangerouslySetInnerHTML` = 0 ✓, `whitespace-pre-wrap` ✓, `Recipient` ✓, `AlertTriangle` ✓.
- Task 2 grep gates: `previewCampaign` ✓, `PreviewStepper` ✓, `emailColumn={report` ✓, `detectEmailColumn` = 0 ✓, `unknownTokens|rowsWithEmptyValues` = 0 ✓ (the editor never computes/passes the template-dependent aggregates), `previewCampaign(` called only in the list-change effect ✓.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Deep-import the pure merge engines instead of the `@/lib/core` barrel**
- **Found during:** Task 2 (once `compose-editor` imported `preview-stepper` into the `/compose` client tree, the build ran the client bundle over it).
- **Issue:** `preview-stepper.tsx` imported `{ analyzeMerge, fillMessage }` from `@/lib/core` (per the plan's `<interfaces>`/pattern-map "browser-safe" note). That barrel re-exports `lib/core/send.ts`, which imports `nodemailer` — dragging `child_process`/`dns`/`fs` into the client bundle and failing the build with `Module not found: Can't resolve 'child_process'` (and `dns`, `fs`). Standalone (Task 1) the file was never bundled, so the error only appeared once it was mounted.
- **Fix:** Import `fillMessage` from `@/lib/core/fill` and `analyzeMerge` from `@/lib/core/merge` directly. Both submodules are import-free pure engines (verified: zero imports), so no behavior change — only the nodemailer-carrying barrel is avoided.
- **Files modified:** components/compose/preview-stepper.tsx
- **Commit:** c4a1476 (folded into the Task 2 commit, since the break only manifested at integration)

_No other deviations — the plan executed as written._

## Threat Model Coverage

- **T-4-XSS** (mitigate): merged subject/body render as escaped JSX text inside `whitespace-pre-wrap`; `grep -c dangerouslySetInnerHTML` = 0. No CSV cell value is injected as HTML.
- **T-4-IDOR** (mitigate): the editor's preview fetch sends only `recipientSetId` in FormData; the server (Plan 03) resolves the storage path via a userId-scoped lookup — no client path.
- **T-4-DIVERGE** (mitigate): `emailColumn` + `invalidEmailCount` come from the server props (resolved/computed over ALL rows); `unknownTokens` + `rowsWithEmptyValues` are computed client-side over ALL fetched rows (`rows.filter`, never a sample) and reactively track the composed template, so the report can never be stale-vs-typed. The client never re-detects the To: column.
- **T-4-LOG** (mitigate): no `console.*` of CSV cell values or merged content in either file.
- **T-4-SC** (accept): zero new npm dependencies (`fillMessage`/`analyzeMerge` are in-repo; the deep-import fix uses existing modules).

## Known Stubs

None — the preview stepper and its report are fully wired to real server data (rows + emailColumn + invalidEmailCount) and live client-side merge. No placeholder/empty-data paths remain.

## Threat Flags

None — no new security surface beyond the plan's threat model.

## Self-Check: PASSED

- components/compose/preview-stepper.tsx — FOUND
- components/compose/compose-editor.tsx (previewCampaign + PreviewStepper wiring) — FOUND
- Commits 1380fb0, c4a1476 — both present in git log.

---
*Phase: 04-editor-preview-template-save*
*Completed: 2026-07-13*
