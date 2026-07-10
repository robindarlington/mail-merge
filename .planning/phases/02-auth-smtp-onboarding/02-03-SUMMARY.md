---
phase: 02-auth-smtp-onboarding
plan: 03
subsystem: database
tags: [drizzle, sqlite, multi-tenant, dal, dto, aes-256-gcm, redaction]

# Dependency graph
requires:
  - phase: 01-foundation-db-crypto-core-engine
    provides: "lib/db (sole SQLite opener + smtp_configs schema/types), lib/crypto encrypt() AES-256-GCM triple"
provides:
  - "userId-scoped SMTP data-access layer (lib/data/smtp.ts): getSmtpConfigForUser, upsertSmtpConfig, updateFromFields, toSmtpConfigDto"
  - "toSmtpConfigDto — the single server→client redaction boundary that structurally omits the encrypted password triple"
  - "smtp_configs.user_id UNIQUE index (smtp_configs_user_uq) on disk — race-safe single-config-per-user upsert conflict target"
  - "lib/data barrel (@/lib/data) — the import surface for tenant-scoped reads/writes"
affects: [02-04-smtp-verify, 02-05-server-actions, 02-06-onboarding-ui, campaigns, worker]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "userId-required-first-param DAL: no unscoped query path exists (AUTH-02)"
    - "Explicit-pick DTO redaction boundary: encrypted triple absent by construction, not by filtering (SMTP-04)"
    - "Additive UNIQUE index as onConflictDoUpdate target for single-row-per-user upsert (D-09)"

key-files:
  created:
    - lib/data/smtp.ts
    - lib/data/index.ts
    - lib/data/smtp.test.ts
    - lib/data/dto.test.ts
    - drizzle/0001_shiny_stature.sql
    - drizzle/meta/0001_snapshot.json
  modified:
    - lib/db/schema.ts
    - drizzle/meta/_journal.json

key-decisions:
  - "toSmtpConfigDto enumerates safe fields explicitly so the encrypted triple cannot leak by omission (RESEARCH Code Example 5 / D-07)"
  - "updateFromFields writes ONLY from_addr/from_name and never touches verified_at — changing display identity does not invalidate a proven connection (D-08)"
  - "PersistableConfig derived via Pick<NewSmtpConfig, ...> so the write shape stays in lockstep with the schema"
  - "Tests provision a temp DATABASE_PATH + apply committed migrations, plus an idempotent CREATE UNIQUE INDEX IF NOT EXISTS so the DAL test is independent of migration-generation order"

patterns-established:
  - "Pattern: every tenant-owned DAL function takes userId as its required first parameter and filters on it"
  - "Pattern: a single toXxxDto() function is the only shape permitted across the server→client boundary"

requirements-completed: [AUTH-02, SMTP-04]

# Metrics
duration: 18min
completed: 2026-07-10
---

# Phase 2 Plan 03: userId-scoped SMTP Data-Access Layer + DTO Redaction Summary

**Established the tenancy + secrecy backbone of the SMTP phase: a userId-scoped DAL where no unscoped query path exists, a single explicit-pick DTO that structurally cannot leak the encrypted password, and an on-disk UNIQUE index making the single-config-per-user upsert race-safe.**

## Performance

- **Duration:** ~18 min
- **Tasks:** 2 completed
- **Files modified/created:** 8

## Accomplishments
- `lib/data/smtp.ts` — `getSmtpConfigForUser`, `upsertSmtpConfig`, `updateFromFields`, `toSmtpConfigDto`, each with `userId` as its required first parameter; imports `db` from `@/lib/db` only (never `new Database`).
- `toSmtpConfigDto` is the sole server→client redaction boundary: it explicitly picks `host, port, secure, username, from_addr, from_name, verified_at` and structurally cannot reference `password_enc/_iv/_tag` (SMTP-04 / T-2-CRED).
- Added the `smtp_configs_user_uq` UNIQUE index on `user_id` in `lib/db/schema.ts`, generated committed migration `drizzle/0001_shiny_stature.sql`, and applied it — the index is physically present in `sqlite_master`, giving `upsertSmtpConfig`'s `onConflictDoUpdate({ target: userId })` a real conflict target (T-2-DUPE race-safe).
- 11 tests pass: cross-tenant read/write isolation (User A can never read or mutate User B), single-row-per-user invariant, `updateFromFields` leaves `verified_at` untouched, and marker-password redaction (plaintext + ciphertext bytes absent from the DTO JSON).

## Task Commits

Each task was committed atomically:

1. **Task 1: userId-scoped DAL + DTO redaction + tests** - `da0adca` (feat)
2. **Task 2: [BLOCKING] Add unique index to schema, generate + apply migration** - `3b3498f` (feat)

## Files Created/Modified
- `lib/data/smtp.ts` - userId-scoped DAL + `toSmtpConfigDto` redaction boundary (AUTH-02 / SMTP-04).
- `lib/data/index.ts` - barrel exporting the DAL functions and `PersistableConfig`/`SmtpConfigDto` types.
- `lib/data/smtp.test.ts` - cross-tenant isolation + single-row-per-user + `updateFromFields` tests against a temp DB.
- `lib/data/dto.test.ts` - DTO redaction assertions (no `password_*` keys; marker plaintext/ciphertext never in JSON).
- `lib/db/schema.ts` - added table-level `unique("smtp_configs_user_uq").on(t.userId)`.
- `drizzle/0001_shiny_stature.sql` - `CREATE UNIQUE INDEX smtp_configs_user_uq ON smtp_configs (user_id)`.
- `drizzle/meta/_journal.json` + `drizzle/meta/0001_snapshot.json` - migration journal/snapshot for idx 1.

## Decisions Made
- Derived `PersistableConfig` from `Pick<NewSmtpConfig, ...>` so the persistable write shape cannot drift from the schema.
- Tests apply the committed migrations to a throwaway temp DB and additionally run an idempotent `CREATE UNIQUE INDEX IF NOT EXISTS`, so Task 1's test suite passes independently of whether Task 2's migration has been generated yet (the plan explicitly anticipated this ordering).

## Deviations from Plan

None - plan executed exactly as written. The one implementation nuance (idempotent index creation in test setup) was explicitly sanctioned by the Task 1 action note ("if run before Task 2, ... only the conflict-target upsert needs the index").

**Total deviations:** 0
**Impact on plan:** None.

## Issues Encountered
- `tsc` initially flagged `Buffer.from(row.password_enc)` in the isolation test because Drizzle infers the untyped `blob()` column loosely; resolved by casting the blob to `Uint8Array` at the comparison site (test-only, no production-code change).
- `node_modules` is not shared into the worktree; ran `npm install` before executing.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- The DAL and DTO boundary are ready for plan 02-04/02-05 (SMTP verify + Server Actions): `verifyAndSave` calls `encrypt()` then `upsertSmtpConfig(userId, …)`; edit-identity calls `updateFromFields`; any client response passes through `toSmtpConfigDto`.
- The UNIQUE index is committed as a migration and present on disk, so the upsert conflict target is enforced in dev and (after `db:migrate`) in prod.

## Threat Flags
None - no security surface beyond the plan's threat model was introduced.

## Self-Check: PASSED

All 8 created/modified files exist on disk; all 3 commits (da0adca, 3b3498f, 3a412d0) are present in git history.

---
*Phase: 02-auth-smtp-onboarding*
*Completed: 2026-07-10*
