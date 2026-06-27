---
phase: 01-foundation-db-crypto-core-engine
reviewed: 2026-06-27T00:00:00Z
depth: standard
files_reviewed: 16
files_reviewed_list:
  - lib/db/schema.ts
  - lib/db/client.ts
  - lib/db/index.ts
  - lib/crypto/key.ts
  - lib/crypto/index.ts
  - lib/core/fill.ts
  - lib/core/csv.ts
  - lib/core/send.ts
  - lib/core/index.ts
  - scripts/migrate.ts
  - scripts/concurrency-smoke.ts
  - worker/index.ts
  - next.config.ts
  - drizzle.config.ts
  - Dockerfile
  - docker-compose.yml
findings:
  critical: 2
  warning: 4
  info: 2
  total: 8
status: issues_found
---

# Phase 01: Code Review Report

**Reviewed:** 2026-06-27T00:00:00Z
**Depth:** standard
**Files Reviewed:** 16
**Status:** issues_found

## Summary

Phase 1 establishes the SQLite data layer, AES-256-GCM credential crypto, the lifted merge/send engine, a migration runner, a two-process concurrency proof, a worker skeleton, and Docker topology. The security-critical properties — no plaintext password column, explicit `secure` boolean, unique IV per encrypt, GCM auth tag verified on decrypt, fail-closed key loading — are all correctly implemented. The WAL/busy_timeout single-opener pattern is sound.

Two blockers exist: `tsx` (a devDependency) is the production worker entrypoint in docker-compose, making the production deployment inoperable if `npm ci --omit=dev` is ever used; and the concurrency smoke test silently discards the pass-1 parent error when pass-2 also errors, meaning a lock error in pass-1 can go unreported. Four warnings cover papaparse error silencing, the `ParsedCsv.rows` `Row` type being unreachable via the barrel, `db.client.ts`'s globalThis guard being skipped in production (leaving a latent dev/HMR correctness gap), and migrate.ts leaking an unclosed handle on failure. Two info items address a worker startup DB reachability proof that does nothing, and missing `depends_on` healthcheck for migration ordering.

---

## Critical Issues

### CR-01: `tsx` is a devDependency but is the sole production worker entrypoint

**File:** `docker-compose.yml:45` / `package.json:51`

**Issue:** The worker service command is `npx tsx worker/index.ts`. `tsx` is declared only in `devDependencies`. The current Dockerfile copies `node_modules` from the `build` stage (which ran bare `npm ci`, including devDeps), so `tsx` happens to be present now. But any future hardening that runs `npm ci --omit=dev` or `npm prune --omit=dev` in the runtime stage — the standard practice for production images — will remove `tsx`, silently breaking the worker at startup with a `MODULE_NOT_FOUND` error. The worker is the only process that actually performs sends; its absence is a silent data-loss-adjacent failure (campaigns remain stuck in `queued` forever).

**Fix:** Either move `tsx` to `dependencies` (simplest, at cost of a larger image), or build the worker to a standalone JS bundle at build time (the D-07 plan already calls for this in Phase 8). For Phase 1, the immediate safe fix is to move `tsx` to `dependencies` so `npm ci --omit=dev` can never silently break it:

```json
// package.json — move tsx from devDependencies to dependencies
"dependencies": {
  ...
  "tsx": "^4.22"
},
"devDependencies": {
  // remove tsx from here
}
```

---

### CR-02: Concurrency smoke test silently discards pass-1 parent error when pass-2 also errors

**File:** `scripts/concurrency-smoke.ts:135-175`

**Issue:** `parentError` is a single `string | null` variable. It is set inside both the pass-1 `catch` (line 144) and the pass-2 `catch` (line 152). If the parent process throws in pass-1 (e.g., an `SQLITE_BUSY` from `runReader`) AND also throws in pass-2, the pass-2 error overwrites `parentError`. The pass-1 error is then completely unreachable — it is never evaluated in the assertions block (lines 171-176). A lock error in pass-1 would go unreported and the test would silently pass even if the WAL/busy_timeout config is broken for the reader-writer scenario.

```typescript
// scripts/concurrency-smoke.ts — current (buggy)
let parentError: string | null = null;
// pass-1
} catch (err) {
  parentError = err instanceof Error ? err.message : String(err);
}
// pass-2
} catch (err) {
  parentError = err instanceof Error ? err.message : String(err); // OVERWRITES pass-1
}
```

**Fix:** Collect parent errors into an array, matching how child errors are handled:

```typescript
const parentErrors: string[] = [];

// pass-1
} catch (err) {
  parentErrors.push(err instanceof Error ? err.message : String(err));
}
// pass-2
} catch (err) {
  parentErrors.push(err instanceof Error ? err.message : String(err));
}

// assertions
for (const parentError of parentErrors) {
  if (LOCK_PATTERN.test(parentError)) {
    failures.push(`parent reported a lock error: ${parentError}`);
  } else {
    failures.push(`parent errored: ${parentError}`);
  }
}
```

---

## Warnings

### WR-01: `parseCsv` silently ignores papaparse parse errors

**File:** `lib/core/csv.ts:54-55`

**Issue:** `Papa.parse` populates `result.errors` with structured error objects when it encounters field-count mismatches, quote errors, or other structural problems. The current implementation reads `result.meta.fields` and `result.data` but never inspects `result.errors`. A malformed CSV (e.g., inconsistent column counts, unclosed quotes) will silently produce a partial or corrupt `rows` array. The caller — Phase 5 test-send and Phase 6 worker — gets back data it cannot distinguish from a clean parse. This is particularly risky because the partial data may pass email validation (only `email` column is checked) while missing other merge fields, causing sends with unfilled `{{tokens}}` to go out.

**Fix:** Surface parse errors to the caller. The lightest-weight approach is to include them in `ParsedCsv` and let callers decide whether to reject:

```typescript
// lib/core/csv.ts
export interface ParsedCsv {
  columns: string[];
  rows: Row[];
  invalidEmailCount: number;
  /** Structural parse errors from papaparse (field-count mismatch, quote errors, etc.). */
  parseErrors: Papa.ParseError[];
}

// in parseCsv():
return {
  columns,
  rows,
  invalidEmailCount,
  parseErrors: result.errors,
};
```

---

### WR-02: `ParsedCsv`'s `Row` type is not exported from the `lib/core` barrel

**File:** `lib/core/index.ts:12-13` / `lib/core/csv.ts:17`

**Issue:** `fill.ts` exports `Row` and it is re-exported from the barrel as `FillRow`. `csv.ts` also exports `Row` (same shape: `Record<string, string>`), but the barrel omits it entirely — only `parseCsv` and `ParsedCsv` are re-exported. Any Phase 5 or Phase 6 caller who imports `parseCsv` from `@/lib/core` and wants to type the `rows` array must either use `import type { Row } from "@/lib/core/csv"` (breaking the barrel abstraction) or inline `Record<string, string>` (duplicating the type). Since `ParsedCsv.rows` is typed as `Row[]`, callers will hit this immediately when they try to annotate variables holding individual rows.

**Fix:** Export `csv.ts`'s `Row` as a named alias from the barrel:

```typescript
// lib/core/index.ts
export { parseCsv } from "./csv";
export type { ParsedCsv, Row as CsvRow } from "./csv";
```

---

### WR-03: `globalThis` connection guard is skipped in production, leaving a latent multi-handle risk

**File:** `lib/db/client.ts:61-63`

**Issue:** The guard that prevents a second `better-sqlite3` handle from being opened reads:

```typescript
if (process.env.NODE_ENV !== "production") {
  globalForDb.__mailMergeDbConnection = connection;
}
```

In production (`NODE_ENV=production`), `globalForDb.__mailMergeDbConnection` is never written. ESM module caching is the only guard in production. For the current Next.js standalone + single-worker topology this is safe, but the guard as written is asymmetric: it protects dev HMR but provides no protection if production code ever triggers a dynamic re-import or if Next.js's production module bundling causes a second evaluation. The intent is clearly to prevent exactly one scenario — two handles on the same SQLite file — but the guard is only half-implemented.

**Fix:** Always write the guard, not only in development. The guard is cheap and makes the invariant unconditional:

```typescript
// lib/db/client.ts
export const connection: Database.Database =
  globalForDb.__mailMergeDbConnection ?? openConnection();

// Always save, not just in dev.
globalForDb.__mailMergeDbConnection = connection;
```

---

### WR-04: `migrate.ts` closes the shared connection singleton, leaving it in a broken state if imported

**File:** `scripts/migrate.ts:40-41`

**Issue:** `migrate.ts` calls `connection.close()` on the singleton exported from `lib/db`. This is appropriate for a standalone one-shot script, but the script imports the shared `connection` from `lib/db` — the exact same object that the `globalThis` guard stores. If `migrate.ts` is ever imported as a module (e.g., programmatic migration at web startup, or if a test imports it), `connection.close()` renders the singleton unusable for all subsequent DB operations in the same process. There is no guard or comment preventing this misuse.

Additionally, if `migrate(db, ...)` throws (e.g., a migration file is malformed), `connection.close()` is never reached and the error propagates uncaught, causing the process to exit non-zero with an unformatted stack trace — fine for a CLI one-shot, but fragile if the pattern is copy-pasted into an application startup path.

**Fix:** Add an explicit comment prohibiting import-as-module usage, and wrap in try/finally to guarantee cleanup:

```typescript
// scripts/migrate.ts
function main(): void {
  const dbPath = process.env.DATABASE_PATH ?? "./data/app.db";
  console.log(`[migrate] applying drizzle migrations to ${dbPath}`);

  try {
    migrate(db, { migrationsFolder: "./drizzle" });
    console.log("[migrate] migrations applied");
    const tables = connection
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ...")
      .all() as Array<{ name: string }>;
    console.log(`[migrate] tables on disk: ${tables.map((t) => t.name).join(", ")}`);
  } finally {
    // Always close, even on failure, so the process exits cleanly.
    connection.close();
  }
}
```

---

## Info

### IN-01: `void db` in worker startup does not prove DB reachability

**File:** `worker/index.ts:23`

**Issue:** The comment says "A trivial read proves the DB is reachable at startup." `void db` does not read from the database — it merely evaluates the `db` reference, which is always defined (the import succeeds whether or not the DB file is healthy). The only thing guaranteed is that `better-sqlite3` opened the file handle and applied pragmas. If the DB file is corrupted or the migrations have not been applied, this line will not detect the problem and the worker will log "worker ready" falsely.

**Fix:** For Phase 1 skeleton this is acceptable, but the comment is misleading. Either remove the claim or perform an actual query:

```typescript
// Replace 'void db' with an actual read to truly verify reachability:
db.run(sql`SELECT 1`);
// Or for better-sqlite3 directly:
connection.prepare("SELECT 1").get();
```

---

### IN-02: No migration step in `docker-compose.yml`; worker `depends_on: web` does not guarantee schema exists

**File:** `docker-compose.yml:53-54`

**Issue:** Neither service runs `db:migrate`. The `depends_on: web` directive controls start order but does not wait for web to be healthy or for the schema to be applied. If `docker compose up` is run on a fresh volume (no `app.db`), better-sqlite3 will create an empty database file, the web service will serve 500s on any DB-touching request, and the worker will start without the required tables. The operator must know to run `docker compose run web npm run db:migrate` first — this is undocumented in the compose file.

**Fix (skeleton-appropriate):** Add a comment block to `docker-compose.yml` documenting the manual migration step required on first deploy. For a future hardening phase, a short-lived `migrate` init-container service (or an entrypoint that auto-migrates) would enforce this automatically.

```yaml
# IMPORTANT: On first deploy or after schema changes, run migrations manually:
#   docker compose run --rm web node -e "require('./scripts/migrate')"
# or add a dedicated migrate service that runs once and exits.
```

---

_Reviewed: 2026-06-27T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
