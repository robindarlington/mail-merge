# Phase 1: Foundation — DB, Crypto, Core Engine - Context

**Gathered:** 2026-06-26
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 1 delivers the shared foundation every later phase builds on — and nothing user-facing. In scope:

- The SQLite data layer: a single shared DB client (WAL + `busy_timeout`) and the full v1 Drizzle schema + migrations.
- Credential encryption: an AES-256-GCM encrypt/decrypt helper using a runtime-injected key.
- The lifted CLI engine: `fill()` (generalized `{{column}}` substitution over subject AND body), CSV parse, and `verify + sendMail + throttle` send functions — as pure, reusable modules.
- A Docker Compose skeleton mounting a shared `/data` volume for web + worker.

Out of scope (later phases): auth/Clerk, SMTP onboarding UI, CSV upload UI, editor, sending campaigns, progress, history, attachments, production packaging/hardening (Phase 8).
</domain>

<decisions>
## Implementation Decisions

### Repo Structure
- **D-01:** Single Next.js application (NOT a workspace monorepo). One `package.json`. Keeps it simple per the user's stated preference.
- **D-02:** The standalone worker lives at `worker/index.ts` and is run as its own process/container (separate entrypoint, same codebase/image).
- **D-03:** Shared code lives in a `lib/` folder imported by both the web app and the worker: `lib/db` (schema + client + typed queries), `lib/core` (lifted CLI engine: fill/csv/send), `lib/crypto` (AES-256-GCM helpers).
- **D-04:** `lib/db` is the ONLY module that opens SQLite. It sets `journal_mode=WAL`, `busy_timeout=5000`, `synchronous=NORMAL`, `foreign_keys=ON` in exactly one place, so both web and worker inherit identical pragmas. This is the structural enforcement of the "no SQLITE_BUSY" success criterion.

### Schema Scope
- **D-05:** Define the FULL v1 Drizzle schema in Phase 1 — all entities up front: `smtp_configs` (encrypted creds, explicit `secure` boolean), `recipient_sets` (columns_json, row count, storage path), `campaigns`, `send_records` (the per-recipient state machine: `pending → sending → sent|failed`, error reason, timestamps), `templates`, `attachments`. Every table carries an owner `userId` (Clerk) for multi-tenant scoping.
- **D-06:** Tables unused until their phase are fine; the schema evolves via Drizzle migrations rather than being reshaped. Rationale: the `send_record` linchpin and its relationships are well-understood from research, so a coherent model now avoids rework later.

### Worker Build / Run
- **D-07:** Run the worker with `tsx` in development; bundle it to a single `worker.js` with esbuild/tsup for the production Docker image. (Web is built by Next.js standalone output.)
- **D-08:** Next.js `output: 'standalone'` for the web build so the production image stays small and the two entrypoints (web `server.js`, worker `worker.js`) share one image.

### Dev Environment
- **D-09:** Develop natively: `next dev` and `tsx worker/index.ts` as two local processes against a local SQLite file on disk. Fastest iteration.
- **D-10:** Phase 1 ships only a Docker Compose SKELETON (web + worker services sharing a named `/data` volume) to satisfy the success criterion; full production packaging/hardening is Phase 8.

### Claude's Discretion
- Encryption key delivery: `CREDENTIAL_ENC_KEY` env var (32-byte key, base64/hex) — from `.env` in dev, a Coolify secret in prod. Helper must fail loudly if absent or wrong length.
- Migrations: a `db:migrate` script via drizzle-kit; applied explicitly (and on container start in later packaging). Drizzle migration files committed to the repo.
- Add a committed `.env.example` enumerating all required vars (addresses a known gap from the CLI codebase concerns: no `.env.example`).
- Add an `engines` pin / `.nvmrc` for the required Node version (better-sqlite3 native bindings + tsx).
- `lib/core` keeps the CLI's proven logic but: generalizes `{{email}}/{{password}}` → arbitrary `{{column}}`, applies fill to subject AND body (fixes CLI bug), swaps the naive CSV split for papaparse, and takes an explicit `secure` boolean instead of inferring from `port === 465`.
- Exact table/column names, indexes, and TypeScript types are the planner's/executor's call within the entity set above.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project & Requirements
- `.planning/PROJECT.md` — scope, constraints, key decisions (stack, BYO-SMTP, plain-text, Coolify/VPS)
- `.planning/REQUIREMENTS.md` — v1 requirements; Phase 1 underpins AUTH-02 (tenant isolation), SMTP-04 (encrypted creds), SEND-06 (idempotent/resumable sends)
- `.planning/ROADMAP.md` § Phase 1 — goal and 4 success criteria

### Research (authoritative for this phase)
- `.planning/research/STACK.md` — pinned versions; mandatory SQLite pragmas; better-sqlite3 + Drizzle; AES-256-GCM via Node crypto; esbuild/tsx worker build; Next standalone
- `.planning/research/ARCHITECTURE.md` — component boundaries, the SQLite data model, `send_record` state machine, build order, broker-free web↔worker handoff
- `.planning/research/PITFALLS.md` — #1/#2 (credential encryption & secret-leak), #5 (SQLITE_BUSY / WAL / shared local volume), #9 (volume persistence); foundation must establish WAL + busy_timeout + logging/redaction conventions
- `.planning/research/SUMMARY.md` § "Phase 1: Foundation" — consolidated foundation guidance

### Existing CLI (logic to lift into lib/core)
- `send-credentials.ts` — `fill()` (line 54), `loadRecipients()` (line 30), `loadTemplate()` (line 47), SMTP `verify+sendMail` block (lines 129–144), throttle (`DELAY_MS`)
- `.planning/codebase/ARCHITECTURE.md` — CLI data flow and the secure-from-port anti-pattern to fix
- `.planning/codebase/CONCERNS.md` — carry-forward gaps (no `.env.example`, no Node pin, `secure` inferred from port, plaintext-credential handling)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `send-credentials.ts::fill()` — pure `{{token}}` replacement; lift and generalize to arbitrary columns + apply to subject and body.
- `send-credentials.ts::loadTemplate()` — `Subject:` first-line + body extraction; reusable for template handling, but body becomes editor-sourced in later phases.
- `send-credentials.ts` SMTP block — `nodemailer.createTransport` + `verify()` + `sendMail()` is a drop-in for `lib/core/send` (nodemailer API unchanged in v9).
- `DELAY_MS` throttle pattern — carry forward as a configurable inter-send delay.

### Established Patterns
- Throw-early validation with human-readable messages (CLI loaders) — keep this style in `lib/core`.
- Per-recipient try/catch that logs and continues without aborting — this becomes the worker's send-loop behavior (Phase 6); `lib/core/send` should surface per-send success/failure cleanly.

### Integration Points
- `lib/db` is consumed by every later phase (web Server Actions/Route Handlers and the worker).
- `lib/crypto` is called at SMTP onboarding (encrypt, Phase 2) and at send time in the worker (decrypt, Phase 6).
- `lib/core` is called by test-send (Phase 5) and the background worker (Phase 6).
- The Docker Compose skeleton is finalized/hardened in Phase 8.

</code_context>

<specifics>
## Specific Ideas

- "Keep the backend simple" drove the single-app (no workspace) decision and native-dev choice.
- The single-`lib/db`-opens-SQLite rule is a deliberate structural mechanism to prevent the WAL/busy-timeout misconfiguration that causes intermittent `SQLITE_BUSY` (PITFALLS #5).
- Fix-by-design from the CLI: subject personalization, explicit `secure` boolean, robust CSV parsing, committed `.env.example`, Node version pin.

</specifics>

<deferred>
## Deferred Ideas

- `plainjob` vs a hand-rolled SQLite poller for the queue — decide in Phase 6 (flagged for phase-specific research). Phase 1 only needs the `send_records`/`campaigns` tables to exist, not the claim/lease logic.
- SSE vs polling for live progress — Phase 6 decision.
- WAL checkpoint strategy, graceful SIGTERM shutdown, `stop_grace_period`, orphan cleanup — Phase 8 (operational hardening).
- Per-row attachment storage layout and path-traversal guards — Phase 7 (the `attachments` table exists in the schema now, but its handling is later).

None of these are scope creep into Phase 1 — they're acknowledged downstream decisions.

</deferred>

---

*Phase: 1-Foundation — DB, Crypto, Core Engine*
*Context gathered: 2026-06-26*
