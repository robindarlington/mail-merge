# Roadmap: Mail Merge Web App

## Overview

This roadmap turns an existing single-file Node.js CLI (`send-credentials.ts`) into a multi-tenant, self-serve mail-merge web app. The journey is dependency-driven: first lay the shared foundation (one WAL'd SQLite file, AES-256-GCM crypto, and the lifted CLI merge/send engine), then build the first end-to-end vertical slice (Clerk auth + live-verified SMTP onboarding). With identity and a validated transport in place, we add CSV upload and parsing (which supplies merge-field columns), then the editor + preview that prove merge logic against real data, then the test-send and confirmation gate that exercise the full synchronous send path. Only then do we tackle the highest-risk phase — the background worker with idempotent per-recipient sending, live progress, and campaign history — built on the `send_record` state machine that is the architectural linchpin. Per-row attachments extend the proven pipeline, and final Docker/Coolify packaging hardens the system for the VPS. The result: a signed-in user can reliably send a personalized email to every CSV row, using their own validated SMTP, with confidence and a durable record of exactly what was sent.

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Foundation — DB, Crypto, Core Engine** - Shared WAL'd SQLite layer, AES-256-GCM crypto, lifted CLI merge/send engine, Compose skeleton (completed 2026-06-27)
- [ ] **Phase 2: Auth + SMTP Onboarding** - Clerk auth, per-user isolation, and live-verified encrypted SMTP onboarding
- [ ] **Phase 3: CSV Upload + Parsing + Recipient Mapping** - Robust CSV upload, header/email-column detection, recipient set persistence
- [ ] **Phase 4: Editor + Preview + Template Save** - Merge-field autocomplete editor, live merged preview, pre-send validation report
- [ ] **Phase 5: Test-Send + Confirmation Gate** - Whole-batch test-send to one address and a hard confirm-before-live gate
- [ ] **Phase 6: Background Worker + Live Send + Progress + History** - Idempotent background sending with live progress and campaign history
- [ ] **Phase 7: Per-Row Attachments** - Per-CSV-row file attachments with path-traversal and size safety
- [ ] **Phase 8: Docker / Coolify Packaging + Operational Hardening** - Production containers, volume persistence, redeploy-safe sends

## Phase Details

### Phase 1: Foundation — DB, Crypto, Core Engine

**Goal**: Establish the shared foundation every later phase builds on — one correctly configured SQLite layer, encryption for credentials, and the lifted CLI merge/send engine.
**Mode:** mvp
**Depends on**: Nothing (first phase)
**Requirements**: (infrastructure — no exclusive v1 REQ-IDs; underpins AUTH-02, SMTP-04, SEND-06)
**Success Criteria** (what must be TRUE):

  1. Both the web and worker processes can open the same WAL'd SQLite file concurrently with no `SQLITE_BUSY` errors (WAL + `busy_timeout=5000` set once in a single shared `packages/db` client).
  2. A value encrypted with the AES-256-GCM helper round-trips back to plaintext using a runtime-injected key, and the key is not present in the repo or on the DB volume.
  3. The lifted `packages/core` engine performs `{{field}}` substitution over arbitrary columns in BOTH subject and body, and exposes `csv` parse and `verify+sendMail+throttle` send functions reused from the CLI.
  4. A Docker Compose skeleton mounts a named `/data` volume shared by both web and worker services.

**Plans**: 5 plans
Plans:
**Wave 1**

- [x] 01-01-PLAN.md — Scaffold single Next.js 16 app: pinned deps, scripts, .env.example, .nvmrc, standalone config, drizzle/shadcn init

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 01-02-PLAN.md — Full v1 Drizzle schema (6 entities, userId-scoped) + single WAL'd SQLite client (4 pragmas, sole opener)
- [x] 01-03-PLAN.md — AES-256-GCM credential crypto: fail-closed key loader + round-trip encrypt/decrypt (TDD)
- [x] 01-04-PLAN.md — Lift lib/core from CLI: generalized {{column}} fill (subject+body), papaparse CSV, explicit-secure send (TDD)

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 01-05-PLAN.md — [BLOCKING] migrate schema to disk + concurrency smoke test (no SQLITE_BUSY) + Docker Compose skeleton

### Phase 2: Auth + SMTP Onboarding

**Goal**: A signed-in user can onboard and persist their own SMTP server, proven functional by a live connection check, with credentials encrypted at rest and never exposed.
**Mode:** mvp
**Depends on**: Phase 1
**Requirements**: AUTH-01, AUTH-02, AUTH-03, SMTP-01, SMTP-02, SMTP-03, SMTP-04, SMTP-05
**Success Criteria** (what must be TRUE):

  1. User can sign up and sign in via Clerk, and any unauthenticated request to an app route is redirected to sign-in.
  2. Every data access is scoped to the signed-in user's `userId`, so one user can never read or mutate another user's records.
  3. User enters SMTP host/port/username/password/from-name/from-address and an explicit TLS mode (implicit SSL vs STARTTLS, not inferred from port), and onboarding completes only after a live `transport.verify()` succeeds — with errors distinguishing auth vs host/port vs TLS failure.
  4. SMTP credentials are stored AES-256-GCM-encrypted and reused across sessions; the password never appears in any client response or log line.
  5. The final onboarding step offers a test-send to the user's own address, confirming the saved transport actually delivers mail.

**Plans**: TBD
**UI hint**: yes

### Phase 3: CSV Upload + Parsing + Recipient Mapping

**Goal**: A user can upload a CSV and get a correctly parsed, validated recipient set with a confirmed email column and known merge-field columns.
**Mode:** mvp
**Depends on**: Phase 2
**Requirements**: CSV-01, CSV-02, CSV-03, CSV-04, CSV-05
**Success Criteria** (what must be TRUE):

  1. User can upload a CSV through the browser and the app parses it robustly (quoted fields, BOM stripped, Windows line endings, encoding handled) with the header row detected.
  2. The app auto-detects the recipient (email) column and the user can confirm or override the choice.
  3. The app validates recipient email addresses at upload and reports the count of invalid rows.
  4. Parsed recipients and detected columns are saved as a per-user recipient set (with `columns_json`, row count, storage path) that later phases read for merge fields.

**Plans**: TBD
**UI hint**: yes

### Phase 4: Editor + Preview + Template Save

**Goal**: A user can compose a personalized plain-text email with merge-field autocomplete, preview it against real CSV rows, and see a pre-send validation report — proving merge logic before any email is sent.
**Mode:** mvp
**Depends on**: Phase 3
**Requirements**: EDIT-01, EDIT-02, EDIT-03, EDIT-04, PREV-01, PREV-02, PREV-03
**Success Criteria** (what must be TRUE):

  1. User composes a plain-text subject and body in an in-browser editor that offers click-to-insert / autocomplete merge fields drawn from the uploaded CSV's columns, triggered on `{{`.
  2. Merge fields apply to BOTH subject and body (fixing the CLI's subject-not-personalized gap), and the composed subject + body can be saved as a template for the campaign.
  3. User can step through individual merged rows rendered against real CSV data, with rows that would send an empty merge value highlighted.
  4. The app produces a pre-send validation report aggregating invalid emails and missing merge values for the recipient set.

**Plans**: TBD
**UI hint**: yes

### Phase 5: Test-Send + Confirmation Gate

**Goal**: A user can route the whole personalized batch to a single test address and must clear a hard confirmation gate before any live send — closing the CLI's most dangerous "no confirm-before-send" gap.
**Mode:** mvp
**Depends on**: Phase 4
**Requirements**: TEST-01, TEST-02, TEST-03
**Success Criteria** (what must be TRUE):

  1. User can send the whole batch to a single test address with each recipient's real subject/body fill preserved (CLI `--test` parity), running the full decrypt → verify → fill → sendMail path synchronously.
  2. Before a live send, the user must pass a confirmation modal showing recipient count, sender identity, a sample recipient, and validation warnings.
  3. A campaign can transition from draft to queued only once, so double-submission cannot enqueue a duplicate send.

**Plans**: TBD
**UI hint**: yes

### Phase 6: Background Worker + Live Send + Progress + History

**Goal**: A live send runs as a crash-safe background job that sends one personalized email per recipient, shows live progress, persists per-recipient outcomes, and is fully resumable — backed by the `send_record` state machine.
**Mode:** mvp
**Depends on**: Phase 5
**Requirements**: SEND-01, SEND-02, SEND-03, SEND-04, SEND-05, SEND-06, HIST-01, HIST-02
**Success Criteria** (what must be TRUE):

  1. A live send survives the HTTP request lifecycle and a worker restart: the worker claims a campaign atomically, materializes one `pending` `send_record` per row, then sends one personalized email per recipient over the user's SMTP with a configurable throttle.
  2. Each recipient's state is persisted (`pending → sending → sent`/`failed`) with error reason and timestamp; per-recipient failures are logged, do not abort the batch, and the failed count is surfaced at the end.
  3. User sees live per-recipient progress (sent / failed / remaining + current recipient) during a send.
  4. After a crash or restart, only `pending` recipients are processed — no recipient is ever double-sent (resume sends to no already-sent recipient).
  5. User can view a list of past campaigns and drill into any one to see per-recipient success/fail status and error reasons.

**Plans**: TBD
**Research flag**: NEEDS phase-specific research before planning. Atomic `BEGIN IMMEDIATE` claim, lease/heartbeat sizing, SIGTERM + Docker init interaction, SSE-vs-polling under WAL multi-process contention, plainjob API maturity, and 4xx/5xx SMTP backoff all have non-obvious failure modes. Run `/gsd:plan-phase --research-phase 6`.
**UI hint**: yes

### Phase 7: Per-Row Attachments

**Goal**: A user can attach a different file per CSV row, with attachments resolved safely and validated as present before any send.
**Mode:** mvp
**Depends on**: Phase 6
**Requirements**: ATCH-01, ATCH-02, ATCH-03
**Success Criteria** (what must be TRUE):

  1. User can attach a different file per CSV row via a filename column plus uploaded files, and the worker attaches the correct file per recipient at send time.
  2. The app validates that every referenced attachment file is present before allowing a send; a missing file is a blocking validation error.
  3. Attachment resolution is safe against path traversal (opaque upload IDs, never CSV-provided paths) and enforces per-file and per-message size limits.

**Plans**: TBD
**UI hint**: yes

### Phase 8: Docker / Coolify Packaging + Operational Hardening

**Goal**: The full system is packaged for the Coolify VPS so data survives redeploys and an in-flight send resumes cleanly with no duplicates.
**Mode:** mvp
**Depends on**: Phase 7
**Requirements**: (operational — no exclusive v1 REQ-IDs; hardens SEND-01/SEND-06 durability and AUTH-02 isolation in production)
**Success Criteria** (what must be TRUE):

  1. Production Dockerfile(s) build web and worker from one image with two entrypoints, with the Node ABI pinned for better-sqlite3 native bindings, and the final docker-compose.yml shares the `/data` volume with a raised `stop_grace_period`.
  2. Coolify env/secrets are wired (`CREDENTIAL_ENC_KEY`, `DATABASE_PATH=/data/app.db`, Clerk keys) and `HOSTNAME=0.0.0.0` is set.
  3. A redeploy acceptance test passes: all data survives a redeploy, and a send interrupted by the redeploy resumes cleanly with no recipient double-sent (worker traps SIGTERM, flushes writes, and exits cleanly).
  4. WAL checkpointing and attachment-orphan cleanup run as defined operational routines.

**Plans**: TBD
**Research flag**: Mostly standard; verify the exact Coolify `stop_grace_period` Compose field behavior in the target Coolify version (community-verified, version-dependent).

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation — DB, Crypto, Core Engine | 5/5 | Complete   | 2026-06-27 |
| 2. Auth + SMTP Onboarding | 0/TBD | Not started | - |
| 3. CSV Upload + Parsing + Recipient Mapping | 0/TBD | Not started | - |
| 4. Editor + Preview + Template Save | 0/TBD | Not started | - |
| 5. Test-Send + Confirmation Gate | 0/TBD | Not started | - |
| 6. Background Worker + Live Send + Progress + History | 0/TBD | Not started | - |
| 7. Per-Row Attachments | 0/TBD | Not started | - |
| 8. Docker / Coolify Packaging + Operational Hardening | 0/TBD | Not started | - |
