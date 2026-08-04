---
phase: 01-foundation-db-crypto-core-engine
fixed_at: 2026-06-27T00:00:00Z
review_path: .planning/phases/01-foundation-db-crypto-core-engine/01-REVIEW.md
iteration: 1
findings_in_scope: 6
fixed: 6
skipped: 0
status: all_fixed
---

# Phase 01: Code Review Fix Report

**Fixed at:** 2026-06-27T00:00:00Z
**Source review:** .planning/phases/01-foundation-db-crypto-core-engine/01-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 6 (2 Critical + 4 Warning)
- Fixed: 6
- Skipped: 0

## Fixed Issues

### CR-01: `tsx` moved from devDependencies to dependencies

**Files modified:** `package.json`
**Commit:** c55694f
**Applied fix:** Added `"tsx": "^4.22"` to `dependencies` and removed it from `devDependencies`. Any future `npm ci --omit=dev` or `npm prune --omit=dev` hardening of the Docker runtime image will no longer silently break the worker entrypoint (`npx tsx worker/index.ts`).

---

### CR-02: Parent errors collected into array to prevent overwrite

**Files modified:** `scripts/concurrency-smoke.ts`
**Commit:** a87c0be
**Applied fix:** Replaced `let parentError: string | null = null` with `const parentErrors: string[] = []`. Both the pass-1 catch (reader) and pass-2 catch (writer) now `push` into the array instead of assigning to a single variable. The assertions loop iterates over the array so errors from both passes are independently evaluated. A lock error in pass-1 can no longer be silently lost when pass-2 also throws.

---

### WR-01: papaparse parse errors surfaced in ParsedCsv

**Files modified:** `lib/core/csv.ts`, `lib/core/csv.test.ts`
**Commit:** e70b909
**Applied fix:** Added `parseErrors: Papa.ParseError[]` field to the `ParsedCsv` interface and populated it from `result.errors` in `parseCsv`. Callers (Phase 5 test-send, Phase 6 worker) now receive structured parse error objects and can decide whether to reject a malformed CSV. Added two new tests: one asserting `parseErrors` is empty for a well-formed CSV, and one asserting a `FieldMismatch / TooFewFields` error is surfaced for a row with fewer columns than the header declares.

---

### WR-02: `CsvRow` type exported from lib/core barrel

**Files modified:** `lib/core/index.ts`
**Commit:** 1d93aeb
**Applied fix:** Changed `export type { ParsedCsv } from "./csv"` to `export type { ParsedCsv, Row as CsvRow } from "./csv"`. Callers who want to type individual rows from `parseCsv` can now import `CsvRow` from `@/lib/core` without breaking the barrel abstraction. The alias `CsvRow` avoids a collision with the already-exported `FillRow` (fill.ts's `Row`).

---

### WR-03: globalThis connection guard made symmetric

**Files modified:** `lib/db/client.ts`
**Commit:** 18d03c7
**Applied fix:** Removed the `if (process.env.NODE_ENV !== "production")` condition. `globalForDb.__mailMergeDbConnection = connection` now runs unconditionally in all environments. Added an explanatory comment. The invariant (one handle per process) is now enforced regardless of `NODE_ENV`, closing the latent risk from dynamic re-imports or production bundler quirks. The four pragmas (WAL, busy_timeout, synchronous, foreign_keys) and the HMR-safe dev behavior are unchanged.

---

### WR-04: migrate.ts wrapped in try/finally with import-as-module guard

**Files modified:** `scripts/migrate.ts`
**Commit:** aad38f7
**Applied fix:** Wrapped the `migrate()` call and the table sanity log in a `try` block with a `finally` that always calls `connection.close()`. If `migrate()` throws (e.g., malformed migration file), the connection is now always closed and the process exits cleanly. Added a prominent `WARNING` block in the module-level JSDoc comment explaining that this script closes the shared singleton and must not be imported as a module from application code or tests — only run as a standalone one-shot via `tsx scripts/migrate.ts`.

---

## Skipped Issues

None — all findings were fixed.

---

## Verification

**`npx tsc --noEmit`:** PASSED (clean, no errors)

**`node --import tsx --test lib/**/*.test.ts`:** PASSED — 39/39 tests pass, including 2 new WR-01 tests:
- "returns empty parseErrors for a well-formed CSV (WR-01)"
- "surfaces papaparse structural errors for a malformed CSV (WR-01)"

**`node --import tsx scripts/concurrency-smoke.ts`:** PASSED — exits 0 after CR-02 change. Both child writer passes completed with no SQLITE_BUSY.

---

_Fixed: 2026-06-27T00:00:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
