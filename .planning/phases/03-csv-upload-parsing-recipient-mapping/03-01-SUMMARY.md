---
phase: 03-csv-upload-parsing-recipient-mapping
plan: 01
subsystem: csv
tags: [csv, validation, storage, zod, security, pure-functions]
requires:
  - lib/core/csv.ts (parseCsv, EMAIL_RE, Row) — Phase 1
  - lib/db/client.ts (env-path resolver pattern) — Phase 1
  - lib/smtp/schema.ts (zod-4 idioms) — Phase 2
provides:
  - detectEmailColumn(columns, rows) — email-column heuristic (CSV-03)
  - countInvalidEmails(rows, column) — invalid count over an arbitrary column (CSV-04)
  - writeUpload(bytes) — traversal-proof UUID-named CSV persistence (V12/T-3-TRAV)
  - uploadFileSchema + MAX_UPLOAD_BYTES + MAX_ROWS — upload guard (CSV-01/T-3-DOS)
  - confirmColumnSchema — column-confirm form schema
  - npm test script
affects:
  - 03-03 actions-core (imports these proven contracts)
tech-stack:
  added: []
  patterns:
    - env-path resolver + mkdirSync (mirrors lib/db/client.ts) for UPLOADS_DIR
    - zod-4 exported-schema + z.infer type (mirrors lib/smtp/schema.ts)
    - two-stage detection heuristic (header-name match, content-sampling fallback)
key-files:
  created:
    - lib/csv/schema.ts
    - lib/csv/schema.test.ts
    - lib/csv/storage.ts
    - lib/csv/storage.test.ts
  modified:
    - lib/core/csv.ts
    - lib/core/csv.test.ts
    - package.json
decisions:
  - "On-disk CSV name is crypto.randomUUID() + '.csv'; the user filename never enters the path (traversal-proof by construction, V12/T-3-TRAV)."
  - "storagePath is stored RELATIVE (<uuid>.csv); read-time join to UPLOADS_DIR is a later-phase concern (Pitfall 4 — absolute paths don't survive dev→container)."
  - "detectEmailColumn is a HINT only; the 0.7 content-sampling threshold and header-hint list default the field, but human confirm/override downstream is the real gate."
  - "detectEmailColumn/countInvalidEmails are ADDITIVE — parseCsv's signature and its literal-'email' invalidEmailCount are untouched so the 9 existing tests stay green."
  - "uploadFileSchema validates the {name,type,size} triple so it works on both a real Server-Action File and a plain client descriptor; accepts text/csv and application/vnd.ms-excel."
metrics:
  duration: ~15m
  completed: 2026-07-13
  tasks: 2
  files: 7
---

# Phase 3 Plan 01: CSV Primitives (detection, storage, upload guard) Summary

Built the pure, filesystem, and validation primitives the rest of Phase 3 composes: two additive email-column functions in `lib/core/csv.ts` (`detectEmailColumn` two-stage header/content heuristic and `countInvalidEmails` over an arbitrary confirmed column), a traversal-proof UUID-named CSV writer (`lib/csv/storage.ts`), and a shared zod-4 upload guard (`lib/csv/schema.ts`) — plus the previously-missing `npm test` script. All 105 lib tests pass; tsc is clean.

## What Was Built

### Task 1 — Email-column detection + invalid-count (CSV-03/CSV-04)
- `detectEmailColumn(columns, rows): string | null` — normalized header-name match against `["email","e-mail","mail","email address","recipient"]`, then a `.includes("email")` fallback (so `Work Email` matches, `mailing_city` does not), then content-sampling over the first 50 rows returning the best EMAIL_RE hit-rate column only when `score > 0.7`, else null.
- `countInvalidEmails(rows, column): number` — counts rows failing EMAIL_RE in any confirmed column (blank counts invalid).
- Both reuse the module's existing `EMAIL_RE` and `Row` (no redeclaration — `grep -c "const EMAIL_RE"` returns 1). `parseCsv` is untouched.
- Added `"test": "node --import tsx --test \"lib/**/*.test.ts\""` to `package.json` (VALIDATION.md Wave 0 gap).

### Task 2 — Upload guard + traversal-proof storage (CSV-01/V12)
- `writeUpload(bytes): { storagePath }` — `mkdirSync(UPLOADS_DIR, { recursive: true })`, writes to `resolve(UPLOADS_DIR, \`${randomUUID()}.csv\`)`, returns the relative `<uuid>.csv`. UPLOADS_DIR resolves `process.env.UPLOADS_PATH ?? "./data/uploads"` at module load (mirrors `lib/db/client.ts`).
- `lib/csv/schema.ts` — `MAX_UPLOAD_BYTES = 4 MB`, `MAX_ROWS = 5000`, `uploadFileSchema` (validates `.csv` extension + `text/csv`/`application/vnd.ms-excel` mime + `size <= MAX_UPLOAD_BYTES` with UI-SPEC messages), `confirmColumnSchema` (`emailColumn` min 1). Each schema exports its `z.infer` type.

## TDD Gate Compliance
Both tasks followed RED → GREEN:
- Task 1: `test(03-01)` 87bc439 (RED) → `feat(03-01)` 52cc158 (GREEN)
- Task 2: `test(03-01)` d147bb9 (RED) → `feat(03-01)` e97eea8 (GREEN)
RED runs confirmed the new tests failed (functions/modules absent) before implementation; no REFACTOR pass was needed.

## Verification
- `node --import tsx --test lib/core/csv.test.ts` → 16 pass (9 pre-existing + 7 new).
- `node --import tsx --test lib/csv/schema.test.ts lib/csv/storage.test.ts` → 11 pass.
- Full suite `node --import tsx --test "lib/**/*.test.ts"` → 105 pass, 0 fail.
- `npx --no-install tsc --noEmit` → exit 0.
- Purity gate: `grep -nE 'from "node:fs"|@clerk|next/' lib/core/csv.ts` → nothing (csv.ts stays pure).
- `grep -c randomUUID lib/csv/storage.ts` → 3 (function + 2 doc references); `writeUpload` has no filename parameter, so a user filename cannot reach the path.

## Threat Mitigations Applied
- **T-3-TRAV (mitigate):** on-disk name is `randomUUID() + ".csv"`; test asserts the returned path matches `/^[0-9a-f-]{36}\.csv$/`, contains no `..`/`/`, and omits the user filename.
- **T-3-DOS (mitigate):** `MAX_UPLOAD_BYTES` enforced in the zod guard; oversized files reject with a clear message before parse/write. `MAX_ROWS` published for the downstream row-cap.
- **T-3-SLOP (accept):** no new npm packages installed.

## Deviations from Plan
None — plan executed exactly as written. The plan named the upload guard generically ("an upload-file guard schema"); it is exported as `uploadFileSchema` with an inferred `UploadFile` type, following the `lib/smtp/schema.ts` naming convention.

## Known Stubs
None.

## Self-Check: PASSED
All 7 source/config files and the SUMMARY exist on disk; all 5 commits (87bc439, 52cc158, d147bb9, e97eea8, 61d6596) are present in git history.
