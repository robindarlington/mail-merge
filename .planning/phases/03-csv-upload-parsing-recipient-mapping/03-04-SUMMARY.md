---
phase: 03-csv-upload-parsing-recipient-mapping
plan: 04
subsystem: recipients-ui
tags: [csv, ui, react-hook-form, zod, shadcn, server-actions, multi-tenant, rsc]

# Dependency graph
requires:
  - plan: 03-03
    provides: parseUploadedCsv/saveRecipientSet Server Actions, ParseSummary/ParseResult/SaveResult/ActionError types, per-column invalidCounts map
  - plan: 03-02
    provides: listRecipientSetsForUser (userId-scoped recipient_sets DAL)
  - plan: 03-01
    provides: uploadFileSchema, confirmColumnSchema, MAX_UPLOAD_BYTES, MAX_ROWS
provides:
  - /recipients route (RSC) — auth() → scoped set list + empty-state vs saved-set list, hosts the uploader
  - components/recipients/csv-uploader.tsx — client upload→review→save flow (CSV-01/03/04/05 UI)
  - components/ui/select.tsx + components/ui/table.tsx — shadcn primitives (radix-nova style, radix-ui unified import)
  - Recipients sidebar nav slot (Users icon, /recipients)
affects: [campaigns, editor/merge-field autocomplete]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "override invalid-count reads server-computed invalidCounts[selectedColumn] on every Select change — no client re-parse, papaparse stays off the browser bundle"
    - "value schema imported from @/lib/csv/schema (zod-only) not the @/lib/csv barrel — the barrel re-exports storage.writeUpload (node:fs) which would break the client bundle; types imported type-only from @/lib/csv"
    - "cosmetic sample preview parsed client-side with a bounded quote-aware reader (never the invalid-count source)"

key-files:
  created:
    - components/ui/select.tsx
    - components/ui/table.tsx
    - components/recipients/csv-uploader.tsx
    - app/(app)/recipients/page.tsx
  modified:
    - components/app-sidebar.tsx

key-decisions:
  - "Hand-authored select.tsx/table.tsx instead of running `npx shadcn@latest add` — the isolated worktree has no node_modules (symlinked read-only from the main checkout) and `shadcn add` would mutate the shared node_modules + package.json. Both files follow the repo's existing radix-nova conventions verbatim (radix-ui@1.6.0 unified `import { Select as SelectPrimitive } from \"radix-ui\"`, data-slot attributes, double-quote/no-semicolon style) — functionally identical official scaffolds. Sanctioned by the orchestrator's worktree guidance."
  - "Imported the VALUE `uploadFileSchema` directly from @/lib/csv/schema, not the @/lib/csv barrel: the barrel re-exports `writeUpload` from storage.ts (node:fs), so a value import of the barrel into a client component would pull node:fs into the browser bundle and fail the build. Result types are imported type-only from @/lib/csv (erased)."
  - "Sample-preview rows are read client-side with a small bounded quote-aware CSV reader (header + 5 records max) purely for the cosmetic table; the authoritative invalid count always comes from the server's per-column invalidCounts map (CSV-04 / T-3-COUNT)."

requirements-completed: [CSV-01, CSV-03, CSV-04, CSV-05]

# Metrics
duration: ~15min
completed: 2026-07-13
tasks: 2
files: 5
---

# Phase 03 Plan 04: Recipients Upload UI Summary

**The user-facing slice that turns the tested CSV backend into a real capability: a `/recipients` page where a signed-in user picks a CSV, sees a parse summary, confirms or overrides the auto-detected email column (with the invalid/valid count recomputing from the server-supplied per-column map on every override), and saves a userId-scoped recipient set that then appears newest-first in their list — built on the Phase-2 RHF+zod / Card / sonner design seam.**

## What Was Built

### Task 1 — shadcn select + table + the csv-uploader client component
- `components/ui/select.tsx` / `components/ui/table.tsx` — hand-authored official shadcn radix-nova scaffolds (the worktree can't run `shadcn add`; see Deviations). `select.tsx` uses the repo's `radix-ui` unified import + `data-slot` conventions; `table.tsx` is the standard overflow-x wrapper.
- `components/recipients/csv-uploader.tsx` (`"use client"`) — the full upload→review→save flow:
  - **UPLOAD step:** RHF `Form` + an `Input type="file"` (accept `.csv,text/csv`) guarded by the SHARED `uploadFileSchema` (client pre-check with the same schema the server uses). Submit builds a `FormData`, sets `parsing`, calls `parseUploadedCsv`. The `parseFailureFor` switch is exhaustive over every `ActionError.kind` (unauthenticated | validation | wrong_type | too_large | too_many_rows | parse_error | empty | unknown): the three blocking file-shape errors anchor to the file input via `form.setError`; parse_error/empty/unauthenticated/unknown render a destructive `Alert`. Button disables while `parsing` and swaps to "Reading your file…" + `Loader2`.
  - **REVIEW step:** a `Card` "Review recipients" with the counts line, a `Select` "Email column" prefilled to `detectedEmailColumn` (unset with "Choose the email column" placeholder + Save disabled when detection is null), the detected/not-detected help copy, the invalid/valid count line reading `data.invalidCounts[emailColumn]` recomputed on every Select change (neutral `text-muted-foreground` + `AlertCircle` when > 0, `text-success` + `CheckCircle2` when 0), a cosmetic `Table` of up to 5 client-read sample rows ("Showing the first {n} rows."), an accent "Save recipient list" (disabled while `saving`, swaps to "Saving…" + `Loader2`) and an outline "Choose a different file". On save success: `toast.success("Recipient list saved — {rowCount} recipients from {filename}.")` → `router.refresh()` → back to upload; on failure: the destructive save Alert without losing state.

### Task 2 — /recipients route (RSC) + sidebar nav slot
- `app/(app)/recipients/page.tsx` — RSC mirroring `settings/smtp/page.tsx`: `const { userId } = await auth(); const sets = userId ? await listRecipientSetsForUser(userId) : [];` inside `flex flex-col gap-8` with the single `text-[28px] font-semibold leading-[1.2]` h1 "Recipients". Empty state → dominant `Card className="py-12"` "Upload your first recipient list" + UI-SPEC body; populated → a Card listing each set newest-first as "{filename} — {rowCount} recipients · {relative date}" (relative date via a local `Intl.RelativeTimeFormat` helper over the unixepoch `created_at`). Both states render `<CsvUploader />`.
- `components/app-sidebar.tsx` — imported the `Users` lucide icon and appended `{ title: "Recipients", href: "/recipients", icon: Users }` to `NAV_ITEMS`; the existing `.map` + `isActive` logic renders it with no structural change.

## Task Commits
1. Task 1: select/table primitives + csv-uploader client — `1aa7352` (feat)
2. Task 2: /recipients route + Recipients sidebar nav slot — `429ffd7` (feat)

## Verification Evidence
- `npx --no-install tsc --noEmit` → exit 0.
- `npm run build` → ✓ Compiled successfully; the `/recipients` route is generated (ƒ dynamic). Only warning is the pre-existing "Next.js inferred your workspace root" lockfile notice, an artifact of running inside the worktree with a symlinked node_modules — not caused by this plan.
- `test -f components/ui/select.tsx && test -f components/ui/table.tsx` → both exist.
- Override-count gate: `grep -c invalidCounts components/recipients/csv-uploader.tsx` → 3.
- Non-destructive-count gate: `grep -c 'text-destructive' components/recipients/csv-uploader.tsx` → 0 (destructive appears only via `Alert variant="destructive"` on the blocking-error path).
- In-flight copy: "Reading your file…" and "Saving…" both present.
- Nav gate: `grep -c 'Recipients' components/app-sidebar.tsx` → 1.
- Page scoping gate: `grep -c 'listRecipientSetsForUser' app/(app)/recipients/page.tsx` → 3; `py-12` empty-state present.

## Threat Mitigations Applied
- **T-3-IDOR (mitigate):** the page re-derives `userId` via `auth()` and lists only via `listRecipientSetsForUser(userId)`; there is no client-supplied id path.
- **T-3-XSS (mitigate):** CSV sample cells render as React text children (auto-escaped); no `dangerouslySetInnerHTML`, no HTML/attribute sinks.
- **T-3-DBLSUBMIT (mitigate):** the Save button disables while its action is in flight, and Upload disables while parsing — no double insert.
- **T-3-COUNT (mitigate):** the displayed invalid count for any chosen column comes from the server-computed `invalidCounts` map, never from the 5 sample rows or a client re-parse.
- **T-3-SC (accept):** select/table are official shadcn code scaffolds copied into the repo (no npm runtime install, no registry-legitimacy gate).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Hand-authored select.tsx/table.tsx instead of `npx shadcn@latest add`**
- **Found during:** Task 1.
- **Issue:** The isolated worktree has no local node_modules; it is symlinked read-only from the main checkout. Running `npx shadcn@latest add select table` would attempt to write into the shared node_modules and mutate the main checkout's package.json — expressly disallowed by the worktree execution guidance.
- **Fix:** Hand-authored both components as the official shadcn radix-nova scaffolds, matching every convention already used by the repo's existing `components/ui/*` (the `radix-ui@1.6.0` unified `import { Select as SelectPrimitive } from "radix-ui"`, `data-slot`/`data-open`/`data-checked` attributes, double-quote/no-semicolon style, `cn()` helper). `radix-ui@1.6.0` already exports the full `Select` namespace; `table` needs no radix dependency. Functionally identical to what `shadcn add` would have produced.
- **Files modified:** components/ui/select.tsx, components/ui/table.tsx.
- **Commit:** 1aa7352.

**2. [Rule 3 - Blocking] Imported the value `uploadFileSchema` from `@/lib/csv/schema`, not the `@/lib/csv` barrel**
- **Found during:** Task 1.
- **Issue:** The interfaces block says to import from `@/lib/csv`. The `@/lib/csv` barrel re-exports `writeUpload` from `storage.ts`, which imports `node:fs`. A VALUE import of the barrel into a `"use client"` component would drag `node:fs` into the browser bundle and fail the build.
- **Fix:** Imported the value `uploadFileSchema` directly from `@/lib/csv/schema` (zod-only, client-safe). Result types (`ParseSummary`, `ActionError`) are imported type-only from `@/lib/csv` (erased at compile time), honoring the "type-only barrel" intent. Actions import directly from `@/lib/csv/actions` as the plan specifies.
- **Files modified:** components/recipients/csv-uploader.tsx.
- **Commit:** 1aa7352.

**Total deviations:** 2 auto-fixed (both blocking-workarounds, environment/bundling). No architectural changes, no scope creep.

## Known Stubs
None — the uploader drives the real `parseUploadedCsv`/`saveRecipientSet` actions end-to-end and the page lists real persisted sets. (The saved-set list rows are display-only this phase; selection into campaigns and set deletion are deferred to later phases per 03-UI-SPEC U6 — an intentional scope boundary, not a stub.)

## Threat Flags
None — no security surface beyond the plan's threat model was introduced.

## Manual Verification Needed (browser harness)
Automated gates cannot exercise Clerk auth or real browser interaction. A human should: sign in on local dev, visit `/recipients`, confirm the empty-state callout, upload a fixture CSV, confirm the review card + detected column render, override the column and confirm the invalid count changes to the new column's server-computed value, save, and confirm the success toast + the set appearing in the list.

## Self-Check: PASSED
