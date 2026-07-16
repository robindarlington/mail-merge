# Roadmap: Mail Merge Web App

## Overview

This roadmap turns an existing single-file Node.js CLI (`send-credentials.ts`) into a multi-tenant, self-serve mail-merge web app. The journey is dependency-driven: first lay the shared foundation (one WAL'd SQLite file, AES-256-GCM crypto, and the lifted CLI merge/send engine), then build the first end-to-end vertical slice (Clerk auth + live-verified SMTP onboarding). With identity and a validated transport in place, we add CSV upload and parsing (which supplies merge-field columns), then the editor + preview that prove merge logic against real data, then the test-send and confirmation gate that exercise the full synchronous send path. Only then do we tackle the highest-risk phase — the background worker with idempotent per-recipient sending, live progress, and campaign history — built on the `send_record` state machine that is the architectural linchpin. Per-row attachments extend the proven pipeline, and final Docker/Coolify packaging hardens the system for the VPS. The result: a signed-in user can reliably send a personalized email to every CSV row, using their own validated SMTP, with confidence and a durable record of exactly what was sent.

**Standing staging environment:** The Phase-1 Compose skeleton is deployed as a standing staging environment early — during Phase 2 — and kept current with each phase's slice. This de-risks the Phase 8 packaging work and provides an always-shareable demo URL throughout the build.

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Foundation — DB, Crypto, Core Engine** - Shared WAL'd SQLite layer, AES-256-GCM crypto, lifted CLI merge/send engine, Compose skeleton (completed 2026-06-27)
- [x] **Phase 2: Auth + SMTP Onboarding** - Clerk auth, per-user isolation, and live-verified encrypted SMTP onboarding (completed 2026-07-11)
- [x] **Phase 3: CSV Upload + Parsing + Recipient Mapping** - Robust CSV upload, header/email-column detection, recipient set persistence (completed 2026-07-13)
- [ ] **Phase 4: Editor + Preview + Template Save** - Merge-field autocomplete editor, live merged preview, pre-send validation report
- [ ] **Phase 5: Test-Send + Confirmation Gate** - Whole-batch test-send to one address and a hard confirm-before-live gate
- [ ] **Phase 6: Background Worker + Live Send + Progress + History** - Idempotent background sending with live progress and campaign history
- [ ] **Phase 7: Per-Row Attachments** - Per-CSV-row file attachments with path-traversal and size safety
- [ ] **Phase 8: Docker / Coolify Packaging + Operational Hardening** - Production containers, volume persistence, redeploy-safe sends
- [ ] **Phase 9: Launch Collateral** - Public README + screenshots, niche-framed landing copy, "how it was built" write-up, and the UI attribution + hire-me link (BRAND-01)

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
  6. The phase's slice is deployed to the standing staging URL on the VPS (Coolify) and works there.

**Plans**: 9 plans (7 original + 2 gap-closure)
Plans:
**Wave 1**

- [x] 02-01-PLAN.md — Clerk auth slice (proxy.ts, ClerkProvider layout, sign-in/up pages, root redirect) + all phase deps/shadcn installs

**Wave 2** *(blocked on Wave 1)*

- [x] 02-02-PLAN.md — SMTP verify engine: shared zod schema, error classifier, verify-with-timeouts + TLS auto-retry (smtp-server fixtures)
- [x] 02-03-PLAN.md — userId-scoped DAL + DTO redaction + [BLOCKING] smtp_configs unique-index migration

**Wave 3** *(blocked on Wave 2)*

- [x] 02-04-PLAN.md — App shell (sidebar + UserButton + footer) + dashboard soft-gate / summary states
- [x] 02-05-PLAN.md — Server Actions: verifyAndSave, updateFromFields, sendTestEmail (auth-first, secret-free typed results)

**Wave 4** *(blocked on Wave 3)*

- [x] 02-06-PLAN.md — SMTP onboarding wizard UI (3 gated steps) + edit flow (RHF + zod, field-anchored errors, TLS switch, test-send)

**Wave 5** *(blocked on Wave 4)*

- [x] 02-07-PLAN.md — Staging deploy: Dockerfile Clerk build ARGs + compose runtime secret + Coolify deploy/smoke

**Wave 6** *(gap closure — CR-01 / 02-VERIFICATION.md)*

- [x] 02-08-PLAN.md — Blank-password SMTP edit: smtpEditFormSchema variant + applyVerifiedConfig stored-password merge + wizard resolver switch + tests (SMTP-04 / D-07 / D-08)

**Wave 7** *(blocked on Wave 6)*

- [x] 02-09-PLAN.md — [CHECKPOINT] live blank-password edit walkthrough against a real SMTP server
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
  5. The phase's slice is deployed to the standing staging URL on the VPS (Coolify) and works there.

**Plans**: 5 plans
Plans:
**Wave 1**

- [x] 03-01-PLAN.md — Core email-column detection + invalid-count pure fns, upload zod guard, traversal-proof storage writer, test script (TDD)
- [x] 03-02-PLAN.md — userId-first recipient_sets DAL + two-tenant IDOR isolation tests + barrel (TDD)

**Wave 2** *(blocked on Wave 1)*

- [x] 03-03-PLAN.md — Server-Action seam: parse/save actions + actions-core (auth-gated, override honored, orphan-safe) + bodySizeLimit

**Wave 3** *(blocked on Wave 2)*

- [x] 03-04-PLAN.md — UI slice: /recipients route + csv-uploader (parse → confirm column → save) + shadcn select/table + sidebar nav

**Wave 4** *(blocked on Wave 3)*

- [x] 03-05-PLAN.md — [CHECKPOINT] UPLOADS_PATH volume wiring + Coolify staging redeploy + upload-survives-restart smoke
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
  5. The phase's slice is deployed to the standing staging URL on the VPS (Coolify) and works there.

**Plans**: 6 plans
Plans:
**Wave 1**

- [x] 04-01-PLAN.md — Pure merge-gap engine (extractTokens/analyzeMerge) + traversal-safe readUpload read seam (TDD)
- [x] 04-02-PLAN.md — userId-first templates DAL (two-tenant IDOR) + shared compose subject/body zod schema (TDD)

**Wave 2** *(blocked on Wave 1)*

- [x] 04-03-PLAN.md — Compose Server Actions: previewCampaign (server-authoritative validation aggregate) + saveTemplate, actions/core split (TDD)

**Wave 3** *(blocked on Wave 2)*

- [x] 04-04-PLAN.md — Compose editor slice: /compose route + editor + {{-autocomplete/chips + save template (shadcn textarea/popover, sidebar nav)

**Wave 4** *(blocked on Wave 3)*

- [x] 04-05-PLAN.md — Live merged preview stepper + per-row empty-value highlight + validation report (PREV-01/02/03, EDIT-03)

**Wave 5** *(blocked on Wave 4)*

- [ ] 04-06-PLAN.md — [CHECKPOINT] Coolify staging redeploy + compose/preview/save walkthrough + persistence smoke
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
  4. The phase's slice is deployed to the standing staging URL on the VPS (Coolify) and works there.

**Plans**: 5 plans
Plans:
**Wave 1**

- [x] 05-01-PLAN.md — Campaigns userId-scoped DAL + atomic draft→queued enqueue guard (TDD, TEST-03 core)
- [x] 05-02-PLAN.md — Chunked whole-batch test-send seam + campaign schema/barrel (TDD, TEST-01)

**Wave 2** *(blocked on Wave 1)*

- [x] 05-03-PLAN.md — Prepare-draft + server-authoritative confirm summary + enqueue seams (TDD, TEST-02/03)

**Wave 3** *(blocked on Wave 2)*

- [x] 05-04-PLAN.md — /compose Send card: test-send panel + undismissable confirm modal + wire-in (TEST-01/02/03 UI)

**Wave 4** *(blocked on Wave 3)*

- [ ] 05-05-PLAN.md — [CHECKPOINT] Coolify staging redeploy + real test-send + confirm-gate walkthrough
**UI hint**: yes

### Phase 6: Background Worker + Live Send + Progress + History

**Goal**: A live send runs as a crash-safe background job that sends one personalized email per recipient, shows live progress, persists per-recipient outcomes, and is fully resumable — backed by the `send_record` state machine.
**Mode:** mvp
**Depends on**: Phase 5
**Requirements**: SEND-01, SEND-02, SEND-03, SEND-04, SEND-05, SEND-06, HIST-01, HIST-02, HIST-03
**Success Criteria** (what must be TRUE):

  1. A live send survives the HTTP request lifecycle and a worker restart: the worker claims a campaign atomically, materializes one `pending` `send_record` per row, then sends one personalized email per recipient over the user's SMTP with a configurable throttle.
  2. Each recipient's state is persisted (`pending → sending → sent`/`failed`) with error reason and timestamp; per-recipient failures are logged, do not abort the batch, and the failed count is surfaced at the end.
  3. User sees live per-recipient progress (sent / failed / remaining + current recipient) during a send.
  4. After a crash or restart, only `pending` recipients are processed — no recipient is ever double-sent (resume sends to no already-sent recipient).
  5. User can view a list of past campaigns and drill into any one to see per-recipient success/fail status and error reasons.
  6. User can download a CSV of per-recipient results for a completed campaign (HIST-03).
  7. The phase's slice is deployed to the standing staging URL on the VPS (Coolify) and works there.

**Plans**: 7 plans
Plans:
**Wave 1** *(foundation seams — parallel, exclusive file ownership)*

- [x] 06-01-PLAN.md — Worker campaign-lifecycle seams: atomic claim + orphan-recovery sweep + finalize (TDD)
- [x] 06-02-PLAN.md — Worker send-path seams: idempotent materialize + pending-row send loop with per-row commit (TDD)
- [x] 06-03-PLAN.md — userId-scoped read/service layer: campaigns list + drill-down + live-progress action (TDD)

**Wave 2** *(blocked on Wave 1)*

- [x] 06-04-PLAN.md — Worker composition: tick() lifecycle + worker/index.ts (pino, poll interval, SIGTERM, env config)
- [x] 06-05-PLAN.md — History + live-progress UI: Campaigns nav + list + detail + results table + polling progress panel
- [x] 06-06-PLAN.md — Downloadable results CSV: formula-injection-safe toResultsCsv + userId-scoped GET export route

**Wave 3** *(blocked on Wave 2)*

- [ ] 06-07-PLAN.md — [CHECKPOINT] Coolify staging redeploy + real live-send + crash-resume no-double-send walkthrough
**Research flag**: research complete (see 06-RESEARCH.md — plainjob rejected, DB-as-queue + polling chosen, no new packages)
**UI hint**: yes

### Phase 06.1: Multiple SMTP servers per account — register several SMTP configs, choose one per send (INSERTED)

**Goal:** A user can register several named SMTP servers on one account — each verified and encrypted independently — and pick which one a given campaign sends through, with existing single-server accounts migrating transparently.
**Requirements**: TBD (extends SMTP-01..05; feasibility sketch in .planning/todos/pending/feature-multi-smtp-per-account.md)
**Depends on:** Phase 2 (SMTP onboarding). Executes BEFORE Phase 6's worker is built; Phase 6 execution must load SMTP config via `campaign.smtp_config_id` (already stamped at campaign creation), not a lookup by userId.
**Mode:** mvp
**Success Criteria** (what must be TRUE):

  1. A user can add multiple named SMTP servers; each is verified (`transport.verify()`) before save and stores its own AES-256-GCM-encrypted password; each server row shows its verified status in settings.
  2. The compose/send flow lets the user choose which verified server a campaign uses; with a single server it is auto-selected (zero extra clicks); the chosen `smtp_config_id` is stamped on the campaign as today.
  3. Test-send (and any future send path) loads the config by the campaign's `smtp_config_id`, scoped to the owning user — a cross-tenant or unknown config id is not_found (IDOR-safe).
  4. Existing accounts migrate with zero user action: the current unique-per-user row survives the migration and remains the default server.
  5. Deleting a server never corrupts campaign history (past campaigns keep their record), and a server in use by a queued/running campaign cannot be silently removed.
**Plans:** 4/4 plans complete

Plans:
- [x] 06.1-01-PLAN.md — Data foundation: schema migration (multi-row + partial-unique default + soft-delete) + id-scoped DAL (wave 1)
- [x] 06.1-02-PLAN.md — SMTP server backend: label + create/update/set-default/soft-delete actions + WR-09 host-change gate + in-use guard (wave 2)
- [x] 06.1-03-PLAN.md — Campaign server selection: thread smtp_config_id through prepare/test-send/confirm + compose picker + Phase 6 load contract (wave 2)
- [x] 06.1-04-PLAN.md — Settings multi-server UI: per-server list, wizard label + WR-09 gate, destructive delete + no-default state, dashboard readiness (wave 3)

### Phase 7: Per-Row Attachments

**Goal**: A user can attach a different file per CSV row, with attachments resolved safely and validated as present before any send.
**Mode:** mvp
**Depends on**: Phase 6
**Requirements**: ATCH-01, ATCH-02, ATCH-03
**Success Criteria** (what must be TRUE):

  1. User can attach a different file per CSV row via a filename column plus uploaded files, and the worker attaches the correct file per recipient at send time.
  2. The app validates that every referenced attachment file is present before allowing a send; a missing file is a blocking validation error.
  3. Attachment resolution is safe against path traversal (opaque upload IDs, never CSV-provided paths) and enforces per-file and per-message size limits.
  4. The phase's slice is deployed to the standing staging URL on the VPS (Coolify) and works there.

**Plans**: 6 plans (5 + staging checkpoint)
**UI hint**: yes

Plans:
- [x] 07-01-PLAN.md — Foundation: attachments-table migration (owner + nullable campaign_id + size_bytes; drop send_record_id) + INVERTED link (send_records.attachment_id) + traversal-proof storage + limit constants + column auto-detect (wave 1)
- [x] 07-02-PLAN.md — userId-scoped attachments DAL (IDOR, idempotent re-prepare-safe stamp, inverted-link resolver) + shared match seam (matchAttachments) + upload/list/delete/confirm-column actions + attachment_column persistence + bodySizeLimit bump (wave 2)
- [x] 07-03-PLAN.md — Confirm-gate: idempotent prepare-time stamping + server-authoritative match/presence/size validation (shared matcher) + blocking enqueue (wave 3)
- [x] 07-04-PLAN.md — Worker send-path: additive transport attachments + send_records.attachment_id linkage at materialize (shared file links every row) + graceful rejected-attachment-missing per-row fail (wave 3)
- [x] 07-05-PLAN.md — UI: compose attachments card (server match summary via matchAttachments) + editor/page host wiring + confirm-dialog attachment lines/block + results table & CSV attachment column (wave 4)
- [ ] 07-06-PLAN.md — [CHECKPOINT] Coolify staging redeploy + per-row attachment walkthrough (wave 5)

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
  5. The phase's slice is deployed to the standing staging URL on the VPS (Coolify) and works there.

**Plans**: 5 plans (4 + staging checkpoint)
- [x] 08-01-PLAN.md — Hardened Dockerfile: esbuild worker/migrate bundle, prod-deps prune, exec-form node CMD, non-root, ABI pin
- [x] 08-02-PLAN.md — Production docker-compose: init:true, raised stop_grace_period, exec-form commands, env/secret contract (.env.example)
- [x] 08-03-PLAN.md — Operational routines: idle-aware WAL wal_checkpoint(TRUNCATE) + attachment-orphan sweep (TDD, wired into worker loop)
- [ ] 08-04-PLAN.md — Scripted redeploy acceptance test: compose stop/up + docker-kill, stub SMTP, no-double-send + data-survival assertions
- [ ] 08-05-PLAN.md — [CHECKPOINT] Coolify staging deploy: env/secrets + Stop Grace Period, redeploy no-double-send verification (queued human checkpoint)
**Research flag**: Mostly standard; verify the exact Coolify `stop_grace_period` Compose field behavior in the target Coolify version (community-verified, version-dependent).

### Phase 08.1: Agent access — standalone CLI + MCP server (INSERTED)

**Goal:** An AI agent or developer can run mail merges without the web UI: a npm-installable CLI (bin: `mail-merge`) that reuses lib/core directly, plus a stdio MCP server exposing the same operations as tools, so agents can discover and drive the merge engine locally.
**Mode:** mvp
**Requirements**: TBD (extends BRAND-01 reach; standalone-local decision LOCKED 2026-07-15 — no API-token layer in this phase)
**Depends on:** Phase 1 (lib/core only). Positioned after Phase 8 so Phase 9's launch collateral (README, /agents page) can document the shipped CLI/MCP.
**Success Criteria** (what must be TRUE):

  1. A npx-executable CLI (`mail-merge`) runs dry-run, `--test ADDR`, and send modes over a CSV + plain-text `{{column}}` template with user-supplied SMTP from env/flags — mirroring the original send-credentials.ts contract, with a per-send throttle.
  2. The CLI is secret-safe: SMTP password comes from env (or hidden prompt) only, never from argv, and is never logged or echoed.
  3. A stdio MCP server (same package) exposes validate-csv, preview-merge, test-send, and send tools with typed results, reusing the identical lib/core paths as the CLI.
  4. Unit tests cover merge parity with lib/core and the CLI argument contract.
  5. README documents both, including copy-paste agent-usage examples (MCP config snippet + CLI one-liners).

**Plans**: TBD

### Phase 9: Launch Collateral

**Goal**: The project is packaged as a public, niche-framed portfolio + lead-generation artifact — public marketing/docs routes in the app, a README and landing copy that speak to the target niches, a "how it was built" write-up, and an in-app attribution + hire-me link.
**Mode:** mvp
**Depends on**: Phase 8, Phase 08.1 (the /agents page documents the shipped CLI/MCP)
**Requirements**: BRAND-01
**Success Criteria** (what must be TRUE):

  1. A public README with at least one screenshot and run/deploy instructions exists at the repo root, linking the public repo (https://github.com/robindarlington/mail-merge).
  2. Public signed-out routes exist in the app (decision LOCKED 2026-07-15 — same Next.js app, not a separate site): a landing page at `/` whose copy frames the two core niches (credential delivery, per-row documents like payslips/certificates/invoices), `/docs` (usage instructions), `/self-host` (host-your-own instructions: Docker/Coolify, env vars incl. CREDENTIAL_ENC_KEY, Clerk keys), and `/agents` (CLI + MCP instructions from Phase 08.1). Signed-in users still land on the dashboard.
  3. A "how it was built" write-up draft is committed to the repo (docs/writeup.md), written to be published at https://robindarlington.com/thoughts/ — Rob publishes it manually.
  4. The app UI footer (all pages, incl. public routes) shows Robin Darlington attribution and a working "hire me / custom work" link to https://robindarlington.com/contact/ (satisfies BRAND-01).
  5. The phase's slice is deployed to the standing staging URL on the VPS (Coolify) and works there.

**Plans**: TBD
**UI hint**: yes

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6 → 6.1 → 7 → 8 → 8.1 → 9

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation — DB, Crypto, Core Engine | 5/5 | Complete   | 2026-06-27 |
| 2. Auth + SMTP Onboarding | 9/9 | Complete   | 2026-07-12 |
| 3. CSV Upload + Parsing + Recipient Mapping | 5/5 | Complete   | 2026-07-13 |
| 4. Editor + Preview + Template Save | 5/6 | In Progress|  |
| 5. Test-Send + Confirmation Gate | 4/5 | In Progress|  |
| 6. Background Worker + Live Send + Progress + History | 0/TBD | Not started | - |
| 6.1. Multiple SMTP servers per account | 4/4 | Complete   | 2026-07-15 |
| 7. Per-Row Attachments | 0/TBD | Not started | - |
| 8. Docker / Coolify Packaging + Operational Hardening | 0/TBD | Not started | - |
| 8.1. Agent access — standalone CLI + MCP server | 0/TBD | Not started | - |
| 9. Launch Collateral | 0/TBD | Not started | - |
