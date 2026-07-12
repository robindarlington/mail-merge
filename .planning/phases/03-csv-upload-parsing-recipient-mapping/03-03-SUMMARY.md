---
phase: 03-csv-upload-parsing-recipient-mapping
plan: 03
subsystem: csv
tags: [csv, server-actions, zod, multi-tenant, idor, auth, parsing]

# Dependency graph
requires:
  - plan: 03-01
    provides: parseCsv/detectEmailColumn/countInvalidEmails, uploadFileSchema, confirmColumnSchema, MAX_UPLOAD_BYTES, MAX_ROWS, writeUpload
  - plan: 03-02
    provides: createRecipientSet, listRecipientSetsForUser (userId-first recipient_sets DAL)
provides:
  - parseUploadedCsvCore / saveRecipientSetCore — userId-injectable seams (no server-action directive)
  - parseUploadedCsv / saveRecipientSet — auth()-gated Server Actions (client-invocable surface)
  - typed ParseSummary/ParseResult/SaveResult/ActionError contract (consumed by 03-04 uploader UI)
  - lib/csv barrel (@/lib/csv) + @/lib/core export of detectEmailColumn/countInvalidEmails
  - next.config.ts serverActions.bodySizeLimit = 4mb
affects: [03-04 csv-uploader UI, campaigns]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "actions.ts (use-server, auth()-gated) ⇄ actions-core.ts (userId-injectable, no directive) seam split"
    - "closed discriminated-union ActionResult: raw is always a string, invalidCounts is a column→number map"
    - "per-column invalidCounts map so the UI recomputes an override's count with no client re-parse"
    - "orphan avoidance: bytes written only after every guard passes, in the same call that inserts the row"

key-files:
  created:
    - lib/csv/actions-core.ts
    - lib/csv/actions-core.test.ts
    - lib/csv/actions.ts
    - lib/csv/index.ts
  modified:
    - next.config.ts
    - lib/core/index.ts

key-decisions:
  - "Filtered papaparse's benign UndetectableDelimiter out of the misparse gate: a legitimate single-column CSV emits it and the parse SUCCEEDS, so treating any parseError as parse_error would reject valid single-column uploads AND make the empty-file branch unreachable. Genuine structural errors (MissingQuotes/TooFewFields/…) still surface as parse_error (Rule 1 fix)."
  - "Exported detectEmailColumn/countInvalidEmails from the @/lib/core barrel — 03-01 added the functions to lib/core/csv.ts but omitted them from the barrel the plan's import surface (@/lib/core) mandates (Rule 3 fix)."
  - "guardFile reuses the shared uploadFileSchema and maps a size failure to too_large and any other metadata failure (or a non-File value) to wrong_type, so the typed union distinguishes the two DoS/type kinds without a second schema."
  - "saveRecipientSetCore verifies the confirmed emailColumn is one of the actual headers before counting/inserting — a client cannot pin the persisted set to a column the file lacks."

requirements-completed: [CSV-01, CSV-02, CSV-03, CSV-04, CSV-05]

# Metrics
duration: ~20min
completed: 2026-07-13
tasks: 2
files: 6
---

# Phase 3 Plan 03: CSV Server-Action Seam Summary

**The phase's end-to-end backend happy path: `parseUploadedCsv` (FormData → robust parse → auto-detect email column → per-column invalid-count summary, persisting nothing) and `saveRecipientSet` (re-validate on the CONFIRMED column → write bytes → insert the userId-scoped recipient_sets row), both behind auth()-gated Server Actions delegating to userId-injectable, fully-tested core seams.**

## What Was Built

### Task 1 — actions-core seams (parse + save), end-to-end tested (TDD)
- `lib/csv/actions-core.ts` (NO server-action directive): `parseUploadedCsvCore(userId, formData)` and `saveRecipientSetCore(userId, formData)` plus the closed-union `ParseSummary`/`ActionError`/`ParseResult`/`SaveResult` types.
  - **parse:** `guardFile` (shared `uploadFileSchema`) → `parseCsv(bytes)` → filter benign `UndetectableDelimiter`, else `parse_error` → `empty` on no columns → `too_many_rows` at PARSE time (over `MAX_ROWS`) → `detectEmailColumn` → build `invalidCounts` with `countInvalidEmails(rows, col)` for EVERY column → `invalidCount` = detected column's entry (or 0). Never calls `writeUpload`/`createRecipientSet`.
  - **save:** `confirmColumnSchema.safeParse` the confirmed `emailColumn` → re-guard + re-parse the re-sent file → re-enforce `MAX_ROWS` → verify the confirmed column ∈ headers → `countInvalidEmails` on the CONFIRMED column → `writeUpload(bytes)` → `createRecipientSet(userId, …)`. Bytes are written ONLY after every guard passes (orphan avoidance).
- `lib/csv/actions-core.test.ts` — 12 seam tests against a temp DATABASE_PATH + UPLOADS_PATH with committed migrations: detection + per-column `invalidCounts` (Name count 3 > Email count 0), wrong_type / non-File / empty / parse_error / single-column-accepted / too_many_rows-at-parse, end-to-end parse→save persistence (columns_json round-trips), confirmed-column override drives the persisted `invalidCount` (matches parse-step `invalidCounts[Y]`, differs from auto-detect), and too_many_rows at save inserts nothing / writes nothing.

### Task 2 — Server-Action wrappers + barrel + body limit
- `lib/csv/actions.ts` (`"use server"`): exports exactly `parseUploadedCsv` and `saveRecipientSet` as runtime values, each lazy-importing `@clerk/nextjs/server`, re-deriving `userId` via `auth()`, returning `{ kind: "unauthenticated" }` when absent, then delegating to the core. Result types are `export type` only (erased, not endpoints).
- `lib/csv/index.ts` — barrel re-exporting the schema guards (`uploadFileSchema`, `confirmColumnSchema`, `MAX_UPLOAD_BYTES`, `MAX_ROWS`), `writeUpload`, and the action result types. The two Server Actions are deliberately NOT re-exported through the barrel (the UI imports them directly from `@/lib/csv/actions`).
- `next.config.ts` — added `experimental.serverActions.bodySizeLimit: "4mb"`, matched to `MAX_UPLOAD_BYTES`.

## Task Commits
1. Task 1 (RED): failing parse+save seam tests — `260ee95` (test)
2. Task 1 (GREEN): actions-core seams + @/lib/core barrel export — `709daa9` (feat)
3. Task 2: use-server wrappers + barrel + bodySizeLimit — `493c869` (feat)

_TDD task: test → feat. No refactor commit needed._

## TDD Gate Compliance
Task 1 followed RED → GREEN: `test(03-03)` `260ee95` (RED run confirmed the module was absent → `ERR_MODULE_NOT_FOUND`) → `feat(03-03)` `709daa9` (GREEN, 12/12 pass). Task 2 is wiring/config (auth wrappers, barrel, next config) — no behavior-adding source to drive via RED beyond the tested core it delegates to.

## Verification Evidence
- `node --import tsx --test lib/csv/actions-core.test.ts` → 12 pass, 0 fail (exit 0).
- Full suite `node --import tsx --test "lib/**/*.test.ts"` → 123 pass, 0 fail.
- `npx --no-install tsc --noEmit` → exit 0.
- No-server-directive gate: `grep -c '"use server"' lib/csv/actions-core.ts` → 0; `grep -c '"use server"' lib/csv/actions.ts` → 1.
- Per-column-count gate: `grep -c invalidCounts lib/csv/actions-core.ts` → 5.
- Orphan gate: `writeUpload` appears only in `saveRecipientSetCore` (+ its docblock); `parseUploadedCsvCore` never references it (manual read confirmed).
- Body-limit gate: `grep -c 'bodySizeLimit: "4mb"' next.config.ts` → 1.

## Threat Mitigations Applied
- **T-3-IDOR (mitigate):** both actions re-derive `userId` via `auth()` and pass it to the userId-scoped DAL; the userId-accepting core seams live in `actions-core.ts` with no server-action directive, so a client cannot bypass `auth()`.
- **T-3-DOS (mitigate):** `bodySizeLimit: "4mb"` caps the request body; the zod guard enforces `MAX_UPLOAD_BYTES` (`too_large`) and `MAX_ROWS` (`too_many_rows`) with typed errors, and `MAX_ROWS` is enforced at PARSE time so an oversized file never enters the review cycle.
- **T-3-MISPARSE (mitigate):** genuine papaparse structural errors return `parse_error`; the benign `UndetectableDelimiter` is excluded so a valid single-column CSV parses; the confirmed column is validated against the actual header set before the invalid-count and insert.
- **T-3-ORPHAN (mitigate):** bytes are written only in `saveRecipientSetCore` after every guard passes, in the same call that inserts the row; the parse/preview step persists nothing (test proves a too_many_rows save writes no file and inserts no row).
- **T-3-CRED (mitigate):** results are a closed union — `raw` is a message string only and `invalidCounts` is a column→count number map; no CSV cell value, byte, or DB row crosses outward.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Filtered benign `UndetectableDelimiter` from the misparse gate**
- **Found during:** Task 1 (RED fixture design + papaparse probe).
- **Issue:** The plan's literal "if `parseErrors.length` return `parse_error`" would reject a legitimate single-column CSV (papaparse emits `UndetectableDelimiter` even though the parse succeeds with correct columns/rows) and would make the plan's own `empty`-file branch unreachable (an empty file also emits `UndetectableDelimiter`).
- **Fix:** `hasStructuralParseError` filters out `UndetectableDelimiter`; genuine structural errors (`MissingQuotes`, `TooFewFields`, …) still return `parse_error`. This aligns with T-3-MISPARSE's intent (catch misparses, not benign single-column warnings). Added tests for both a valid single-column CSV and the empty→`empty` path.
- **Files modified:** lib/csv/actions-core.ts, lib/csv/actions-core.test.ts.
- **Commit:** 709daa9 / 260ee95.

**2. [Rule 3 - Blocking] Exported detect/count helpers from the `@/lib/core` barrel**
- **Found during:** Task 1 (implementing the mandated `import … from "@/lib/core"`).
- **Issue:** The plan's interface block imports `detectEmailColumn`/`countInvalidEmails` from `@/lib/core`, but 03-01 added them to `lib/core/csv.ts` without re-exporting them through the `@/lib/core` barrel — so the mandated import surface did not resolve them.
- **Fix:** Added `detectEmailColumn, countInvalidEmails` to `lib/core/index.ts`'s `export { … } from "./csv"` line (additive, one line). No behavior change to `lib/core/csv.ts`.
- **Files modified:** lib/core/index.ts.
- **Commit:** 709daa9.

**Total deviations:** 2 auto-fixed (1 bug, 1 blocking). No architectural changes, no scope creep.

## Known Stubs
None — both actions are fully wired end-to-end (FormData bytes → parsed summary / persisted recipient_sets row) and covered by seam tests.

## Threat Flags
None — no new security surface beyond the plan's threat model was introduced.

## Next Phase Readiness
- 03-04 (CSV uploader UI) can import `parseUploadedCsv`/`saveRecipientSet` from `@/lib/csv/actions` and the `ParseSummary`/`ParseResult`/`SaveResult`/`ActionError` types from `@/lib/csv`. The per-column `invalidCounts` map lets the UI surface an override's invalid count without shipping papaparse to the browser.
- No blockers.

## Self-Check: PASSED
