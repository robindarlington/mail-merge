# Project Research Summary

**Project:** Mail Merge Web App (BYO-SMTP CSV mail merge)
**Domain:** Multi-tenant self-serve mail merge — web app generalizing an existing CLI
**Researched:** 2026-06-24
**Confidence:** HIGH

## Executive Summary

This is a multi-tenant web application that generalizes an existing single-file Node.js CLI (`send-credentials.ts`) into a self-serve product. The architecture all four researchers converged on has one defining structural choice: two containers (Next.js web server + long-lived Node worker) communicating exclusively through a shared SQLite file on a named Docker volume — no message broker, no internal HTTP, one source of truth. The web process enqueues a campaign by writing a row; the worker polls, claims atomically, and sends. This "SQLite-as-queue" approach is the right call for this scale (100–1,000 recipients), this host (single Coolify VPS), and this dependency budget (no Redis). It is well-understood, crash-safe with WAL + `busy_timeout`, and keeps the system trivially inspectable.

The single architectural linchpin all researchers independently reached is the **persisted per-recipient `send_record` state machine** (`pending → sent|failed`). This one table is the source of truth for live progress (count rows by status), campaign history (query after send), idempotency (skip non-pending rows on resume), and the confirmation modal (show counts before send). Build it first and the remaining features are views or behaviors over it. The stack is almost entirely pre-decided by PROJECT.md constraints; the meaningful open-question calls are: Drizzle ORM over raw better-sqlite3 (adopt it — typed queries, one migrations path), `plainjob` for the queue (adopt it with a maturity flag), CodeMirror 6 for the plain-text editor (preferred over textarea-plus-popover but a genuine tradeoff), and SSE for progress (with polling as an equally valid v1 fallback).

The highest-risk phase is the background send: idempotent per-row claiming, atomic `BEGIN IMMEDIATE` claim, graceful SIGTERM shutdown, lease/heartbeat, and throttle all must be correct together before the first live campaign. Every other phase has well-documented patterns. The CLI carried forward several explicit gaps (no confirm-before-send, no sent-log, no idempotency, `secure` inferred from port, no subject personalization, naive CSV parsing) — these are not nice-to-haves; they are primary design goals of the web app. Security non-negotiables: AES-256-GCM credential encryption with a runtime-injected key, SMTP password never in logs or client responses, and per-row Clerk `userId` ownership checks on every data access.

## Key Findings

### Recommended Stack

The stack is pre-decided for the core framework, auth, styling, and transport. Research validated those choices, pinned current versions, and resolved the open questions. See `.planning/research/STACK.md` for full rationale and compatibility matrix.

**Core technologies:**
- Next.js `16.2.x` (App Router) — full-stack host; runs as persistent `node server.js`, not serverless; required by the long-lived SSE and worker model
- React `19.2.x` / TypeScript `5.9.x` (pinned, NOT 6.0 — ecosystem still settling) — pulled by Next 16
- Clerk `@clerk/nextjs 7.5.x` — auth and per-user identity; every DB row keys off `userId`
- Tailwind CSS `4.3.x` + shadcn/ui — CSS-first Oxide config; shadcn copies Radix components into repo
- SQLite via better-sqlite3 `12.11.x` + Drizzle ORM `0.45.x` — typed access layer shared by web and worker; drizzle-kit `0.31.x` for migrations
- nodemailer `9.0.x` — identical `createTransport`/`verify`/`sendMail` API to the CLI; drop-in reuse
- plainjob (latest `^1`) — SQLite-backed queue on better-sqlite3; web enqueues, worker dequeues; no Redis; **flag maturity before committing to it**
- papaparse `5.5.x` — RFC 4180 CSV parsing replacing the CLI's naive split; runs in browser and Node
- zod `4.4.x` — runtime validation of CSV rows, SMTP form, Server Action inputs
- p-queue `9.3.x` — in-worker SMTP concurrency limiter (NOT the durable queue; used inside the worker to bound concurrent sends)
- pino `10.3.x` — structured logging in the worker with secret redaction
- CodeMirror `6.0.x` + `@codemirror/autocomplete 6.20.x` — plain-text editor with `{{`-triggered merge-field autocomplete; preferred over textarea-plus-popover, but that is a valid lower-dependency alternative
- Node `crypto` AES-256-GCM — credential encryption; no third-party library needed
- SSE via Next.js Route Handler `ReadableStream` — one-directional progress; polling every ~1-2s is an equally robust v1 fallback
- Docker Compose (one image, two entrypoints) on Coolify — web + worker share a named volume at `/data`

**Mandatory SQLite settings (both processes, set once in `packages/db/client.ts`):**
`journal_mode = WAL`, `busy_timeout = 5000`, `synchronous = NORMAL`, `foreign_keys = ON`

### Expected Features

See `.planning/research/FEATURES.md` for full feature dependency graph and competitor analysis.

**Must have (table stakes — v1):**
- Clerk sign-in / multi-tenant gate
- SMTP onboarding with live `transport.verify()`, explicit `secure` toggle (NOT inferred from port), friendly error codes (`EAUTH`, `ETLS`, `ETIMEDOUT`)
- AES-256-GCM credential encryption at rest; password never returned to client or logged
- CSV upload with papaparse (BOM strip, encoding detection, quoted-field support); auto-detect recipient column
- Merge-field autocomplete on `{{` in subject AND body (fixes CLI subject-personalization gap)
- Live preview of merged rows with missing-value highlighting
- Recipient email validation at upload time
- Pre-send validation report: invalid emails + missing merge fields + missing attachment files
- Test-send (whole batch routed to one address) — CLI `--test` parity
- Confirmation-before-live-send modal — hard gate; fixes CLI's most dangerous gap
- Background send with per-recipient throttle (configurable, not hardcoded 3s)
- Live per-recipient progress backed by persisted `send_records`
- Per-recipient `sent|failed` status persisted, viewable in campaign history
- Idempotency / resume-after-failure: process only `pending` rows on restart

**Should have (differentiators — v1.x after core loop validated):**
- Per-row attachments: filename column in CSV, user uploads matching files, nodemailer `attachments[].path` per recipient
- Downloadable send report CSV (derives cheaply from persisted `send_records`)
- Saved/reusable templates

**Defer (v2+):**
- Scheduling / send-later
- Rich HTML email / WYSIWYG (out of scope per PROJECT.md)
- Email compliance features — unsubscribe, CAN-SPAM footer
- Multiple saved SMTP profiles per user
- Contact/list management (the CSV per campaign IS the list)
- Open/click/reply tracking (anti-feature for this use case)

### Architecture Approach

Two containers on one VPS share one SQLite file and one named volume. They do not communicate over HTTP — the database is the queue and the status store. The web container handles auth, file uploads, template composition, preview, campaign enqueue, and progress streaming. The worker polls for queued campaigns, claims one atomically via `BEGIN IMMEDIATE + UPDATE … RETURNING`, decrypts SMTP creds, verifies the connection, materializes `send_records` (one per CSV row, `pending`), then loops: `fill() → sendMail() → commit result → sleep(delay)`. On any crash the worker re-claims stalled jobs (lease expired) and resumes from the first `pending` row only. See `.planning/research/ARCHITECTURE.md` for full schema, data flows, and component diagram.

**Major components:**
1. `packages/db` — the only code that opens SQLite; sets WAL + busy_timeout; exports typed query functions used by both web and worker; single owner prevents inconsistent pragma configuration
2. `packages/core` — lifted CLI merge/send engine: `fill.ts` (generalized `{{col}}` substitution), `csv.ts` (papaparse wrapper), `send.ts` (verify + sendMail + throttle)
3. `packages/crypto` — AES-256-GCM encrypt/decrypt with runtime-injected key; used at SMTP onboarding (encrypt) and worker send (decrypt)
4. `apps/web` — Next.js App Router: Clerk middleware, Route Handlers for upload/smtp/campaigns, Server Actions for mutations, SSE progress endpoint, all UI
5. `apps/worker` — long-lived Node process: poll loop → atomic job claimer → send engine → lease heartbeat → graceful SIGTERM shutdown
6. Shared `/data` volume — `app.db` + `-wal`/`-shm` + `uploads/` + `attachments/`; local disk only (never NFS)

### Critical Pitfalls

See `.planning/research/PITFALLS.md` for full pitfall catalog, "looks done but isn't" checklist, and recovery costs.

1. **No per-recipient state → duplicate sends on crash/restart** — Materialize one `send_record` per row BEFORE the send loop; commit each result immediately; resume = process only `pending` rows. This is the highest-stakes correctness requirement. (PITFALLS.md #6)

2. **SMTP credentials stored or logged in plaintext** — AES-256-GCM with a runtime-injected master key (not in the repo or on the DB volume); never log the transport config; never return the password to the client; add a test asserting the password never appears in serialized output. (PITFALLS.md #1, #2)

3. **SQLite `SQLITE_BUSY` under web + worker concurrency** — WAL mode + `busy_timeout = 5000` set on BOTH connections in ONE shared `packages/db/client.ts`. Both containers must mount the same local Docker volume (never NFS). Without this, intermittent lock errors appear only during active sends. (PITFALLS.md #5)

4. **`secure` inferred from port 465 (direct CLI bug carry-forward)** — Store an explicit `secure` boolean; default from port but allow override; on `verify()` failure retry the alternate TLS mode and report which worked; set `requireTLS: true` for STARTTLS to prevent silent cleartext downgrade. (PITFALLS.md #3)

5. **Worker killed mid-send by Coolify redeploy without graceful shutdown** — Trap `SIGTERM`/`SIGINT`; finish or cleanly abandon the in-flight send; flush DB writes; close nodemailer transport; exit 0. Raise Docker `stop_grace_period` beyond one send cycle. Run worker as PID 1 or use `tini`. (PITFALLS.md #8)

Additional flags: path traversal via CSV attachment filenames (#10), multi-tenant IDOR without per-row `userId` checks (#13), CSV BOM/encoding/quoted-field misparse (#12), attachment size limits + orphan cleanup (#11).

## Implications for Roadmap

All four research files converge on the same dependency-driven build order. The roadmap should follow it closely because deviations introduce integration risk: the send engine needs the DB layer and crypto before it can run; the worker needs its claim pattern proven before wiring real SMTP; progress and history are reads over state the worker writes.

### Phase 1: Foundation — DB, Crypto, Schema, WAL

**Rationale:** Everything else depends on this. `packages/db` with WAL + `busy_timeout` must exist before any other code opens SQLite. Getting pragmas wrong here causes intermittent failures that are hard to diagnose later. Crypto must be established before any credential is persisted. `packages/core` can be lifted from the CLI here too (pure functions, no DB).
**Delivers:** `packages/db` (Drizzle schema + migrations + WAL client + typed queries), `packages/crypto` (AES-256-GCM encrypt/decrypt), Docker Compose skeleton with named `/data` volume, `packages/core` (lifted CLI `fill`, `csv`, `send` with subject-fix applied)
**Avoids:** PITFALLS.md #1 (plaintext creds), #5 (SQLite busy), #9 (volume not persisted)
**Verification gate:** Both containers can open the same WAL'd DB concurrently with no `SQLITE_BUSY`.

### Phase 2: Auth + SMTP Onboarding

**Rationale:** Auth gates everything. SMTP onboarding + `verify()` is the first true vertical slice (browser → handler → nodemailer → DB write) and smoke-tests the foundation. Must be complete before any send can happen. Establishes the `userId` scoping convention all subsequent phases inherit.
**Delivers:** Clerk middleware + session scoping, SMTP onboarding form with explicit `secure` toggle and `requireTLS`, live `transport.verify()` with short timeout and per-error-code messaging (`EAUTH`/`ETLS`/`ETIMEDOUT`), AES-GCM credential write to DB, test-send-to-self as final onboarding gate
**Avoids:** PITFALLS.md #2 (secrets in logs/client), #3 (secure inference), #4 (verify hang), #13 (multi-tenant isolation)
**Research flag:** Standard patterns — skip phase research. Nodemailer docs + Clerk App Router docs are authoritative and HIGH confidence.

### Phase 3: CSV Upload + Parsing + Recipient Mapping

**Rationale:** CSV headers drive merge-field autocomplete. This must exist before the editor or preview can be built. Parsing must be correct (papaparse, BOM strip, encoding) before any preview is meaningful.
**Delivers:** CSV upload endpoint → papaparse parse → BOM/encoding handling → header detection → recipient-column auto-suggest + user override → `recipient_sets` row with `columns_json`, row count, storage path; email validation at load time; parsed-row preview in UI
**Avoids:** PITFALLS.md #12 (CSV edge cases), #13 (per-user scoping of uploaded files)

### Phase 4: Editor + Preview + Template Save

**Rationale:** Depends on Phase 3 (`columns_json` drives autocomplete). No worker or background send needed — this is pure web + `fill()` from `packages/core`. Proves merge logic is correct against real CSV data before any email is sent.
**Delivers:** CodeMirror 6 plain-text editor with `{{`-triggered column autocomplete (or textarea + custom popover as lighter alternative), subject + body composition (both personalized — fixes CLI gap), `fill()` preview over first N rows with missing-value highlighting, pre-send validation report (invalid emails + unmatched merge fields), template save to DB
**Avoids:** PITFALLS.md #12 (misparse visible in preview as safety gate)

### Phase 5: Test-Send + Confirmation Modal

**Rationale:** Test-send validates the full send path (decrypt → verify → fill → sendMail) synchronously without needing the worker or background job infrastructure. The confirmation modal is also standalone — build both as the final safety gate before live send.
**Delivers:** `POST /api/campaigns/:id/test` running the send engine synchronously to one address with real per-recipient personalization; confirmation modal with recipient count, sender identity, sample recipient, warnings from validation report; duplicate-submit guard (campaign can only transition `draft → queued` once)
**Avoids:** PITFALLS.md #6 (duplicate sends via double-submit); fixes CLI "no confirm-before-send" gap

### Phase 6: Background Worker + Live Send + Progress + History

**Rationale:** This is the highest-risk phase. The atomic job claim, per-recipient state materialization, idempotent send loop, lease/heartbeat, SIGTERM handling, SSE progress streaming, and campaign history must all be correct together. Flag for phase-specific research before planning.
**Delivers:** Worker poll loop + `BEGIN IMMEDIATE` atomic claim + lease/heartbeat, `send_records` materialization (one per row, `pending`), idempotent send loop (process only `pending`, commit each result immediately, continue on per-row failure), throttle + p-queue concurrency bound, 4xx backoff / 5xx permanent failure distinction, SSE progress endpoint + run view (or polling fallback), graceful SIGTERM shutdown, campaign history view
**Avoids:** PITFALLS.md #6 (idempotency/duplicates), #7 (claim race), #8 (graceful shutdown), #14 (rate limits + backoff)
**Research flag:** NEEDS phase-specific research. The atomic claim pattern, lease/heartbeat sizing, SIGTERM + Docker init interaction, SSE under WAL multi-process contention, and plainjob API maturity all have non-obvious failure modes not fully resolved by current research. Run `/gsd:plan-phase --research-phase 6`.

### Phase 7: Per-Row Attachments

**Rationale:** Deferred until the send pipeline is proven. Extends Phase 3 (upload infrastructure) and Phase 6 (worker message-build step). Path-traversal guard is non-negotiable before this phase ships.
**Delivers:** Attachment upload endpoint (per-campaign, opaque upload IDs — NOT CSV-provided paths), filename-column mapping in CSV, `attachments` table with `send_record_id` foreign key, pre-send validation of missing files, worker resolves opaque ID → validated storage path → nodemailer `attachments[].path`, per-file + per-message size cap (budget for ~33% base64 inflation), orphan cleanup on campaign delete
**Avoids:** PITFALLS.md #10 (path traversal), #11 (unbounded size + no cleanup)
**Research flag:** Standard patterns for file upload + nodemailer attachments — skip research.

### Phase 8: Docker / Coolify Packaging + Operational Hardening

**Rationale:** Compose skeleton started in Phase 1; finalized once both web and worker are stable. Closes out operational concerns: WAL checkpoint monitoring, volume persistence acceptance test, backup strategy, redeploy safety proof.
**Delivers:** Production Dockerfile(s) with multi-stage build + pinned Node ABI for better-sqlite3 native bindings, final docker-compose.yml (web + worker + `/data` volume + raised `stop_grace_period`), `HOSTNAME=0.0.0.0` + Coolify env/secrets wiring (`CREDENTIAL_ENC_KEY`, `DATABASE_PATH=/data/app.db`, Clerk keys), WAL checkpoint strategy, attachment cleanup job, redeploy acceptance test (data survives redeploy; send mid-deploy resumes cleanly with no duplicates)
**Avoids:** PITFALLS.md #8 (graceful shutdown + PID 1/tini), #9 (volume persistence), #11 (orphan cleanup)
**Research flag:** Mostly standard. Verify the exact Coolify `stop_grace_period` Compose field behavior in the target Coolify version — community-verified, version-dependent.

### Phase Ordering Rationale

- **Phases 1–2 before anything:** DB + crypto are the shared foundation; auth + SMTP onboarding is the first end-to-end slice that proves the foundation works and establishes the `userId` scoping pattern all phases inherit.
- **Phase 3 before Phase 4:** CSV headers are required input to the editor's autocomplete system.
- **Phase 5 before Phase 6:** Test-send validates the full send path synchronously so the async worker phase starts from a known-good send engine, not two unknowns at once.
- **Phase 6 isolated and flagged:** The background worker is the most novel component and the convergence point for all correctness requirements. De-risk it with phase research before planning.
- **Phase 7 after Phase 6:** Per-row attachments extend the worker; the send pipeline must be stable first.
- **Phase 8 last (skeleton in Phase 1):** Packaging can be started early for dev parity but finalized once the full system is working.

### Research Flags

**Phases needing deeper research during planning:**
- **Phase 6 (Background Worker + Live Send):** Atomic claim pattern, lease/heartbeat sizing, SIGTERM + Docker init interaction, SSE under WAL multi-process contention, plainjob API maturity, and 4xx SMTP backoff all have non-obvious failure modes. This is the one phase where implementation surprises are most likely. Run `/gsd:plan-phase --research-phase 6`.

**Phases with standard patterns (skip phase research):**
- **Phase 1 (Foundation):** SQLite WAL config and Drizzle migrations are well-documented.
- **Phase 2 (Auth + SMTP Onboarding):** Clerk App Router integration and nodemailer TLS semantics are fully documented; pitfall-to-mitigation mapping is explicit.
- **Phase 3 (CSV):** papaparse API is mature and straightforward.
- **Phase 4 (Editor + Preview):** CodeMirror 6 autocomplete API is documented; `fill()` is reused CLI logic.
- **Phase 5 (Test-send + Confirmation):** Simple synchronous variant of the send engine; no new patterns.
- **Phase 7 (Attachments):** nodemailer attachment API + file upload patterns are well-documented; path traversal mitigation is standard.
- **Phase 8 (Packaging):** Docker multi-stage + Coolify Compose are standard; one small Coolify-specific verification needed.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Versions verified against npm registry 2026-06-24; WAL/busy_timeout verified against better-sqlite3 and sqlite.org docs; only flag is plainjob maturity |
| Features | HIGH | Corroborated across multiple competitor tools and authoritative CLI gap analysis from codebase review |
| Architecture | HIGH | SQLite WAL + atomic claim patterns verified against better-sqlite3 docs, sqlite.org WAL spec, and multiple production write-ups |
| Pitfalls | HIGH | Nodemailer TLS and better-sqlite3 WAL/busy behavior verified via official docs. Deliverability specifics MEDIUM — BYO-SMTP varies by provider |

**Overall confidence:** HIGH

### Gaps to Address

- **plainjob maturity:** Purpose-built and correct for this use case but not widely battle-tested. Verify API stability and active maintenance before Phase 6 planning. Keep the hand-rolled SQLite poller (~100 lines: leasing + retry + shutdown) as a documented fallback — the architecture is identical either way.
- **Coolify `stop_grace_period` behavior:** Community-verified, version-dependent. Confirm the exact Compose field Coolify respects for stop timeout in the target version before Phase 8.
- **SSE vs. polling:** Both are valid for v1. Explicit decision point in Phase 6 planning — polling is simpler and equally robust at this scale; SSE is preferred UX. No research gap, just an unresolved choice.

## Sources

### Primary (HIGH confidence)
- npm registry (2026-06-24) — version pins for all libraries (see STACK.md for full table)
- better-sqlite3 `docs/performance.md` via Context7 — WAL mode, multi-process behavior, checkpoint starvation, `busy_timeout`
- Nodemailer official docs via Context7 (`docs/smtp/*`, `docs/errors.md`) — `secure`/`requireTLS`/STARTTLS semantics, error codes, pooled transport config
- sqlite.org/wal.html — WAL shared-memory requirement (local FS only, no NFS), checkpoint behavior
- `.planning/codebase/CONCERNS.md` — authoritative CLI gap analysis
- `.planning/PROJECT.md` — scope, constraints, out-of-scope boundaries

### Secondary (MEDIUM confidence)
- plainjob (github.com/justplainstuff/plainjob) — API verified via repo; production-scale maturity unconfirmed
- GMass, SecureMailMerge, YAMM, Mailmeteor, Mailchimp, Unlayer, CSVBox, Listmonk — competitor feature analysis
- Oldmoe blog, Jason Gorman — `BEGIN IMMEDIATE` atomic claim and SQLite job queue patterns
- Coolify docs + Next.js standalone output docs — Docker Compose multi-service + named volume patterns

### Tertiary (LOW confidence)
- BYO-SMTP provider rate-limit specifics (Gmail/Workspace caps, `421`/`454` behavior) — provider-dependent; surfaced as user-facing expectations rather than guarantees

---
*Research completed: 2026-06-24*
*Ready for roadmap: yes*
