---
phase: 01-foundation-db-crypto-core-engine
plan: 02
subsystem: data-layer
tags: [drizzle, sqlite, schema, wal, multi-tenant, encryption]
requires:
  - "01-01 (scaffolded Next.js app, deps, drizzle.config.ts pointing at lib/db/schema.ts)"
provides:
  - "lib/db/schema.ts — full v1 Drizzle schema (6 entities, userId-scoped)"
  - "lib/db/client.ts — the single WAL-configured SQLite opener (D-04)"
  - "lib/db/index.ts — barrel exporting db client + raw connection + schema/types"
  - "InferSelect/InferInsert row types for all six tables"
affects:
  - "01-05 (migration generation reads this schema; uses raw connection)"
  - "Phase 2 SMTP onboarding (smtp_configs encrypted creds + secure)"
  - "Phase 6 worker (send_records state machine, campaigns claim)"
  - "every later phase reads/writes through these typed tables"
tech-stack:
  added: []
  patterns:
    - "Single-opener: only lib/db/client.ts constructs better-sqlite3 (D-04)"
    - "Four mandatory pragmas set once on open (WAL/busy_timeout/synchronous/foreign_keys)"
    - "Encrypted-only credential triple (no plaintext password column)"
    - "userId on every tenant-owned table; child tables scope via campaign_id FK"
    - "INTEGER unixepoch timestamps; TEXT status state machines"
key-files:
  created:
    - lib/db/schema.ts
    - lib/db/schema.test.ts
    - lib/db/client.ts
    - lib/db/index.ts
  modified: []
decisions:
  - "send_records and attachments carry NO userId column by design — tenancy is inherited through campaign_id FK (matches ARCHITECTURE.md entity model)"
  - "secure stored as integer-backed boolean (mode: boolean), explicit per SMTP-04/PITFALLS #3"
  - "password stored ONLY as AES-256-GCM triple (password_enc/_iv/_tag) as blob columns"
  - "HMR-safe globalThis singleton in client.ts so Next.js dev reloads don't leak a second handle"
metrics:
  duration: 9
  completed: 2026-06-27
  tasks: 2
  files: 4
---

# Phase 1 Plan 02: DB Schema + Single WAL Client Summary

The full v1 Drizzle schema (six userId-scoped entities, encrypted-only SMTP credentials, and the per-recipient `send_records` state machine with an idempotency guard) plus the single WAL-configured better-sqlite3 client that is the only module permitted to open the database — the structural mechanism behind Phase 1's no-SQLITE_BUSY criterion.

## What Was Built

### Task 1 — Full v1 Drizzle schema (TDD)
`lib/db/schema.ts` defines all six entities exactly per ARCHITECTURE.md:
- **smtp_configs** — `userId`, host, port, explicit `secure` boolean (not inferred from port, SMTP-04), username, the AES-256-GCM credential triple `password_enc`/`password_iv`/`password_tag` (blob, no plaintext password column, PITFALLS #1/#2), from_addr/from_name, verified_at, created_at.
- **recipient_sets** — `userId`, filename, columns_json, row_count, storage_path, created_at.
- **templates** — `userId`, subject, body, created_at.
- **campaigns** — `userId`, FKs to recipient_sets/templates/smtp_configs, status (draft|queued|running|completed|failed), worker_id, lease_expires_at, total/sent_count/failed_count, timestamps.
- **send_records** — campaign_id FK, to_addr, merged_subject/merged_body snapshots, status (pending|sending|sent|failed), message_id, error, attempts, sent_at, plus `UNIQUE(campaign_id, to_addr)` for idempotent materialization (SEND-06).
- **attachments** — campaign_id + send_record_id FKs, filename, storage_path, created_at.

All six tables export `InferSelectModel`/`InferInsertModel` row types. Timestamps are INTEGER unixepoch; status columns are TEXT.

`lib/db/schema.test.ts` introspects the exported table objects (no DB connection) and asserts: exactly six tables, userId on every tenant-owned table, the encrypted-only credential triple + explicit secure with no plaintext password column, send_records audit fields, and the UNIQUE(campaign_id, to_addr) guard. 5/5 tests pass.

### Task 2 — Single WAL-configured SQLite client (D-04)
`lib/db/client.ts` is the only module that constructs a better-sqlite3 Database. It resolves `DATABASE_PATH` (fallback `./data/app.db`, D-09), ensures the parent directory exists, opens once per process (HMR-safe singleton), and applies the four mandatory pragmas in one place: `journal_mode = WAL`, `busy_timeout = 5000`, `synchronous = NORMAL`, `foreign_keys = ON`. It exports the typed Drizzle `db` and the raw `connection`. `lib/db/index.ts` re-exports `db`, `connection`, and `* from ./schema` so web and worker import everything from `@/lib/db`.

## Verification

| Check | Result |
|-------|--------|
| `grep -c 'sqliteTable(' lib/db/schema.ts` (6 entities) | 6 ✓ |
| Four pragma strings in client.ts (comment-filtered) | all 4 ✓ |
| No lib/ file but client.ts imports better-sqlite3 (D-04) | empty ✓ |
| `lib/db/index.ts` re-exports db + schema | ✓ |
| `npx tsc --noEmit` | 0 errors ✓ |
| `node --import tsx --test lib/db/schema.test.ts` | 5 pass / 0 fail ✓ |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test file failed tsc on `.ts` import extension and over-narrow type predicate**
- **Found during:** Task 1 GREEN verification (`tsc --noEmit`).
- **Issue:** The RED test imported `./schema.ts` (rejected by tsc without `allowImportingTsExtensions`), and a unique-index introspection used a type predicate `(c): c is { name: string }` not assignable to Drizzle's `IndexColumn`.
- **Fix:** Changed the import to extensionless `./schema` (tsx still resolves it); replaced the predicate with a defensive `.name` read + string filter.
- **Files modified:** lib/db/schema.test.ts
- **Commit:** f25c808 (folded into the GREEN commit, since the test is co-authored with the schema).

Note on the V1 acceptance heuristic: `grep -c "sqliteTable"` counts 7 (6 table definitions + 1 import statement). The precise definition count is `grep -c "sqliteTable("` == 6, and the schema-shape test authoritatively asserts exactly six tables. No code was contorted to game the proxy grep.

## TDD Gate Compliance

Task 1 followed RED → GREEN:
- RED: `test(01-02)` commit df182f8 — failing schema-shape test (ERR_MODULE_NOT_FOUND, no schema yet).
- GREEN: `feat(01-02)` commit f25c808 — schema authored, 5/5 tests pass, tsc clean.
No separate REFACTOR commit was needed.

## Known Stubs

None. All columns are real definitions; no placeholder/empty data sources were introduced. (Migration generation and a real DB connection are intentionally deferred to plan 01-05 per the plan's environment notes.)

## Threat Surface Scan

No new security surface beyond the plan's `<threat_model>`. The schema implements the registered mitigations:
- T-01-02a (creds): only password_enc/_iv/_tag exist; test asserts no plaintext password column.
- T-01-02b (cross-tenant): userId on every tenant-owned table; child tables scope via campaign_id FK.
- T-01-02c (concurrent writers): single client sets WAL + busy_timeout + foreign_keys in one place.
- T-01-02d (audit): send_records carries status/error/message_id/sent_at.

## Self-Check: PASSED

- lib/db/schema.ts — FOUND
- lib/db/schema.test.ts — FOUND
- lib/db/client.ts — FOUND
- lib/db/index.ts — FOUND
- Commit df182f8 (RED test) — FOUND
- Commit f25c808 (schema GREEN) — FOUND
- Commit 4412249 (client + barrel) — FOUND
