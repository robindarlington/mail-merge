---
phase: 01-foundation-db-crypto-core-engine
verified: 2026-06-27T21:50:00Z
status: passed
score: 4/4 must-haves verified
overrides_applied: 0
---

# Phase 1: Foundation — DB, Crypto, Core Engine Verification Report

**Phase Goal:** Establish the shared foundation every later phase builds on — one correctly configured SQLite layer, encryption for credentials, and the lifted CLI merge/send engine.
**Verified:** 2026-06-27T21:50:00Z
**Status:** passed
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Web + worker can open the same WAL'd SQLite file concurrently with no SQLITE_BUSY — single shared opener (lib/db/client.ts) sets journal_mode=WAL, busy_timeout=5000, synchronous=NORMAL, foreign_keys=ON in one place; two-process smoke test exits 0 | ✓ VERIFIED | `node --import tsx scripts/concurrency-smoke.ts` → exit 0: "PASSED — two real OS processes ran overlapping read+write against the WAL'd app.db with NO SQLITE_BUSY (criterion #1)." WAL mode confirmed on disk: `pragma('journal_mode')` returns `"wal"`. All four pragmas on lines 42-45 of client.ts (non-comment). D-04 single-opener rule holds: no file outside lib/db/client.ts imports better-sqlite3 Database constructor (only `drizzle-orm/better-sqlite3/migrator` in migrate.ts — not a direct opener). |
| 2 | AES-256-GCM round-trips with a runtime-injected key; key is NOT in repo or DB volume; helper fails closed when key is missing/wrong-length; no secret leaks into serialized output | ✓ VERIFIED | 39/39 tests pass including: round-trip ASCII/unicode/empty (✓), unique IV per call (✓), auth-tag tamper throws (✓), fails closed when CREDENTIAL_ENC_KEY unset (subprocess exits 0 by catching the throw) (✓), wrong-length key throws (✓), no key/plaintext in payload or error messages (✓). CREDENTIAL_ENC_KEY is `${CREDENTIAL_ENC_KEY}` runtime env in compose — not inlined in Dockerfile or compose literals. .env.example holds placeholder only. Key absent from Dockerfile (grep returns nothing). |
| 3 | lib/core does {{column}} substitution over arbitrary columns in BOTH subject and body (fixes CLI subject bug), exposes csv parse (papaparse) + verify+sendMail+throttle with explicit secure boolean (not port===465), no credential logging | ✓ VERIFIED | 39/39 tests pass including: arbitrary-column fill (✓), fillMessage applies to both subject and body (✓), BOM/CRLF/quoted-comma CSV (✓), sendOne mock-transport returns {ok:true,messageId}/{ok:false,error} (✓). grep of send.ts: `secure` present on line 35/74; `=== 465` absent; no console/pino call references pass/auth/password. lib/core imports only nodemailer+papaparse — no lib/db, no lib/crypto, no @clerk/next. |
| 4 | Docker Compose skeleton mounts a named /data volume shared by web + worker; DATABASE_PATH=/data/app.db; CREDENTIAL_ENC_KEY injected at runtime (not inlined); two services from one image | ✓ VERIFIED | `docker compose config` output confirmed: both `web` and `worker` services mount `appdata:/data`, `DATABASE_PATH: /data/app.db`, `CREDENTIAL_ENC_KEY: ""` (runtime-injected via `${CREDENTIAL_ENC_KEY}`), both use `image: mail-merge:skeleton` built from the single Dockerfile. HOSTNAME=0.0.0.0 set on web service. |

**Score:** 4/4 truths verified

---

## Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `lib/db/client.ts` | Single SQLite opener with 4 pragmas (D-04) | ✓ VERIFIED | All four pragma statements present on lines 42-45. `globalForDb` guard unconditional (WR-03 fix applied — `if (NODE_ENV !== 'production')` condition removed). |
| `lib/db/schema.ts` | Full v1 Drizzle schema, 6 entities, userId-scoped | ✓ VERIFIED | 6 `sqliteTable` calls (import + 6 exports = 7 grep hits; import line is not a table def). All four tenant tables carry `user_id` column. `smtp_configs` has `password_enc/iv/tag` blob columns + `secure` integer-boolean — no plaintext password column. `send_records` has `UNIQUE(campaign_id, to_addr)` constraint. All InferSelectModel/InferInsertModel types exported. |
| `lib/db/index.ts` | Barrel re-exporting db + connection + schema | ✓ VERIFIED | Exports `db`, `connection`, `Db` from client; `* from './schema'`. |
| `lib/crypto/key.ts` | Fail-closed CREDENTIAL_ENC_KEY loader (32-byte validation) | ✓ VERIFIED | Throws "CREDENTIAL_ENC_KEY is missing" when unset; throws "must decode to 32 bytes (got N)" on wrong length; error messages contain no key material. |
| `lib/crypto/index.ts` | AES-256-GCM encrypt/decrypt with unique IV per call | ✓ VERIFIED | `createCipheriv('aes-256-gcm', ...)` with `randomBytes(12)` IV; `setAuthTag` on decrypt; `toBuffer` normalizer for Drizzle blob returns. No logging. |
| `lib/core/fill.ts` | Arbitrary {{column}} substitution, subject+body (EDIT-03) | ✓ VERIFIED | `fill()` uses regex `/\{\{\s*([\w.-]+)\s*\}\}/g` over arbitrary keys; `fillMessage()` fills both subject and body. Unmatched token pass-through documented and tested. |
| `lib/core/csv.ts` | papaparse CSV parse, BOM strip, email validation, parseErrors | ✓ VERIFIED | `Papa.parse` with `{header:true,skipEmptyLines:true}`; BOM stripped before parse; `EMAIL_RE` check; `parseErrors: result.errors` in return (WR-01 fix). |
| `lib/core/send.ts` | verify + sendMail + throttle with explicit secure boolean, no credential logging | ✓ VERIFIED | `createSmtpTransport` takes `secure: boolean` directly; no `=== 465` anywhere; `sendOne` returns `{ok,messageId}/{ok:false,error}` never throws; `throttle(ms)` configurable; zero console/pino calls referencing pass/auth/password. |
| `lib/core/index.ts` | Barrel exporting fill/csv/send + CsvRow type (WR-02 fix) | ✓ VERIFIED | Exports `fill`, `fillMessage`, `FillRow`, `MessageTemplate`, `parseCsv`, `ParsedCsv`, `CsvRow`, all send exports including `SmtpConfig`, `MailTransport`, `SendArgs`, `SendResult`. |
| `scripts/migrate.ts` | db:migrate runner, reuses lib/db client, try/finally close (WR-04 fix) | ✓ VERIFIED | Imports `db, connection` from `../lib/db`; `try/finally` with `connection.close()` in finally. Module-level WARNING comment guards against import-as-module misuse. |
| `scripts/concurrency-smoke.ts` | Two-process smoke test via child_process.fork (CR-02 fix) | ✓ VERIFIED | `fork()` with `execArgv: ['--import','tsx']`; `parentErrors: string[]` array (not single variable, CR-02 fix applied); two passes (reader-vs-writer and writer-vs-writer). Exits 0 empirically. |
| `worker/index.ts` | Minimal worker skeleton (D-02), no send logic | ✓ VERIFIED | Imports `db` from `@/lib/db`; logs JSON readiness line; `.unref()`'d heartbeat; no send/claim logic. Intentional skeleton per D-02 and D-10. |
| `docker-compose.yml` | Two services from one image, shared /data volume, runtime-injected key | ✓ VERIFIED | `docker compose config` validated. Both services use `appdata:/data`; `CREDENTIAL_ENC_KEY: ${CREDENTIAL_ENC_KEY}` in both. |
| `Dockerfile` | Multi-stage build, Node 24 ABI pin, one runtime image | ✓ VERIFIED | `FROM node:24-bookworm-slim`; three stages (base/deps/build/runtime); copies standalone output + worker lib/ deps; no secrets in file. |
| `drizzle/0000_clear_absorbing_man.sql` | SQL migration creating all 6 tables | ✓ VERIFIED | SQL file defines all 6 tables with correct columns including UNIQUE index on send_records(campaign_id, to_addr). |
| `.env.example` | Committed, placeholder-only, covers all required vars | ✓ VERIFIED | `CREDENTIAL_ENC_KEY=replace-with-openssl-rand-base64-32`, `DATABASE_PATH=./data/app.db`, Clerk keys, HOSTNAME, PORT, SMTP vars — all placeholders, no real values. |
| `.nvmrc` | Node 24 pin | ✓ VERIFIED | Contains `24`. |
| `next.config.ts` | `output: 'standalone'` + better-sqlite3 as server external | ✓ VERIFIED | `output: "standalone"`, `serverExternalPackages: ["better-sqlite3"]`. |
| `package.json` | Single app (no workspaces), tsx in dependencies (CR-01 fix), all 5 scripts | ✓ VERIFIED | No `workspaces` key; `tsx: "^4.22"` in `dependencies` (not devDependencies); scripts: dev, build, start, worker, db:generate, db:migrate all present. |

---

## Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `lib/db/client.ts` | better-sqlite3 Database | 4 PRAGMA statements on open | ✓ WIRED | Pragmas on lines 42-45; globalThis guard unconditional |
| `lib/db/index.ts` | `lib/db/client.ts` + `lib/db/schema.ts` | barrel re-export | ✓ WIRED | `export { db, connection } from './client'; export * from './schema'` |
| `lib/crypto/index.ts` | `lib/crypto/key.ts` | `loadKey()` called in encrypt/decrypt | ✓ WIRED | `import { loadKey } from './key'`; called on line 50 and 68 |
| `lib/crypto/index.ts` | `node:crypto createCipheriv` | AES-256-GCM with random 12-byte IV | ✓ WIRED | `createCipheriv("aes-256-gcm", key, iv)` lines 53, 70 |
| `lib/core/send.ts` | nodemailer createTransport | explicit `secure` boolean (not port===465) | ✓ WIRED | `secure: config.secure` on line 74; grep confirms `=== 465` absent |
| `scripts/concurrency-smoke.ts` | `@/lib/db` | child_process.fork with --import tsx | ✓ WIRED | `fork(selfPath, [], { execArgv: ['--import', 'tsx'], env: {..., CONCURRENCY_ROLE: role} })` |
| `scripts/migrate.ts` | `../lib/db` (not a second opener) | `migrate(db, { migrationsFolder })` | ✓ WIRED | Imports `db, connection` from lib/db; `drizzle-orm/better-sqlite3/migrator` (not a raw Database constructor) |
| docker-compose.yml `web` + `worker` | named volume `appdata` at `/data` | `volumes: - appdata:/data` | ✓ WIRED | `docker compose config` shows both services mount `appdata:/data` |

---

## Database Verification (Empirical)

Migration run `npm run db:migrate` against a fresh data directory:

```
[migrate] applying drizzle migrations to ./data/app.db
[migrate] migrations applied
[migrate] tables on disk: attachments, campaigns, recipient_sets, send_records, smtp_configs, templates
```

**6/6 tables present on disk.** SQLite `pragma('journal_mode')` = `"wal"` confirmed on the actual database file.

---

## Data-Flow Trace (Level 4)

lib/core and lib/crypto are pure utility modules — they don't render dynamic data from a database; they transform inputs. lib/db/client.ts is the data layer with no rendering surface. Level 4 data-flow tracing (component → state → API → DB query) does not apply to this infrastructure phase — there are no user-facing components or API routes in Phase 1 scope.

---

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Two-process no-SQLITE_BUSY proof | `node --import tsx scripts/concurrency-smoke.ts` | exit 0, "PASSED — ... NO SQLITE_BUSY" | ✓ PASS |
| All 39 lib tests pass | `node --import tsx --test lib/db/schema.test.ts lib/crypto/crypto.test.ts lib/core/fill.test.ts lib/core/csv.test.ts lib/core/send.test.ts` | 39 pass, 0 fail, 0 skip | ✓ PASS |
| db:migrate creates 6 tables on fresh db | `npm run db:migrate` | 6 tables listed: attachments, campaigns, recipient_sets, send_records, smtp_configs, templates | ✓ PASS |
| docker compose topology valid | `docker compose config` | Both services mount appdata:/data; DATABASE_PATH=/data/app.db; CREDENTIAL_ENC_KEY runtime-injected | ✓ PASS |
| TypeScript type check | `npx tsc --noEmit` | No output (clean) | ✓ PASS |
| WAL mode confirmed on disk | `pragma('journal_mode')` on app.db | `"wal"` | ✓ PASS |

---

## Requirements Coverage

Phase 1 has no exclusive v1 REQ-IDs. It seeds the foundation for:

| Requirement | Seeded In Phase 1 | Evidence |
|-------------|------------------|----------|
| AUTH-02 (tenant isolation) | `userId` column on smtp_configs, recipient_sets, templates, campaigns; child tables inherit via FK | schema.ts lines 43, 67, 81, 95; schema.test.ts "every tenant-owned table carries a userId column" ✓ |
| SMTP-04 (encrypted creds at rest) | password_enc/iv/tag blob columns (no plaintext password); explicit `secure` boolean; AES-256-GCM encrypt/decrypt | schema.ts lines 51-53, 47; lib/crypto/index.ts; schema.test.ts "smtp_configs stores only the encrypted credential triple" ✓ |
| SEND-06 (idempotent/resumable sends) | UNIQUE(campaign_id, to_addr) on send_records; pending→sending→sent|failed status machine | schema.ts lines 138, 132; drizzle SQL `CREATE UNIQUE INDEX send_records_campaign_addr_uq`; schema.test.ts "enforces UNIQUE(campaign_id, to_addr)" ✓ |
| EDIT-03 (fill applies to subject+body) | `fillMessage()` applies fill to both subject and body | fill.ts `fillMessage`; fill.test.ts "applies fill to BOTH subject and body (EDIT-03)" ✓ |
| CSV-02 (robust CSV parse) | papaparse with header mode, BOM strip, quoted-field handling, CRLF | csv.ts; csv.test.ts BOM/CRLF/quoted-comma tests ✓ |
| SEND-02 (verify+sendMail+throttle) | `verifyTransport`, `sendOne`, `throttle` in lib/core/send.ts | send.ts; send.test.ts mock-transport contract tests ✓ |

---

## Anti-Patterns Found

Scanned all files modified by Phase 1.

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `worker/index.ts` | 23 | `void db` — comment says "proves DB reachable" but this is acknowledged as misleading (IN-01 from review) | Info | Intentional skeleton (D-02); no blocking impact; Phase 6 replaces with real dequeue loop. Accepted as known. |
| `docker-compose.yml` | 53-54 | No migration step; `depends_on: web` does not guarantee schema exists (IN-02 from review) | Info | Documented in docker-compose.yml comment block and SUMMARY.md; full migration automation is Phase 8 scope (D-10). Not a blocker for skeleton. |

No `TBD`, `FIXME`, or `XXX` markers found in any Phase 1 source files.
No placeholder/stub implementations that block phase goals.
No credential logging found in send.ts, crypto/index.ts, or worker/index.ts.

All critical (CR-01, CR-02) and warning (WR-01, WR-02, WR-03, WR-04) findings from 01-REVIEW.md are confirmed fixed in the codebase:
- **CR-01**: `tsx` is in `dependencies`, not `devDependencies` (confirmed in package.json).
- **CR-02**: `parentErrors: string[]` array collects errors from both passes (confirmed in concurrency-smoke.ts lines 135, 144, 151).
- **WR-01**: `parseErrors: Papa.ParseError[]` field present in ParsedCsv and populated (confirmed in csv.ts line 27, 67).
- **WR-02**: `Row as CsvRow` exported from lib/core barrel (confirmed in index.ts line 13).
- **WR-03**: `globalForDb.__mailMergeDbConnection = connection` unconditional (confirmed in client.ts line 68 — no `NODE_ENV` condition).
- **WR-04**: `try/finally { connection.close() }` in migrate.ts (confirmed lines 29-50).

---

## Single-Opener Rule Verification (D-04)

`grep -rl "better-sqlite3" lib/ | grep -v client.ts` → empty (no output).

Files referencing better-sqlite3 outside lib/db/client.ts:
- `next.config.ts` — serverExternalPackages config string, not an import
- `scripts/migrate.ts` — imports `drizzle-orm/better-sqlite3/migrator` (the Drizzle migrator adapter, NOT `new Database()`)
- `scripts/concurrency-smoke.ts` — comments only
- `lib/db/client.ts` — the sole permitted opener (correct)

**D-04 single-opener rule: HOLDS.**

---

## Human Verification Required

None. All Phase 1 deliverables are infrastructure (no user-facing UI, no auth, no live SMTP connections). All four success criteria are verifiable empirically via command-line and have been verified above.

---

## Gaps Summary

No gaps. All four ROADMAP success criteria are empirically verified:

1. Concurrency smoke test exits 0 with two real OS processes and no SQLITE_BUSY.
2. Crypto tests pass 39/39 including round-trip, fail-closed, unique-IV, auth-tag tamper, and no-leak assertions.
3. Core tests pass 39/39 including fill over arbitrary columns in both subject+body, papaparse CSV, explicit-secure send with no port===465.
4. docker compose config confirms two services from one image sharing a named /data volume with runtime-injected CREDENTIAL_ENC_KEY.

Migration created all 6 tables on disk. Single-opener rule verified. All review findings (CR-01, CR-02, WR-01 through WR-04) confirmed fixed. TypeScript type-checks clean.

---

_Verified: 2026-06-27T21:50:00Z_
_Verifier: Claude (gsd-verifier)_
