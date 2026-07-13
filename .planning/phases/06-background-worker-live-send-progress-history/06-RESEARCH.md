# Phase 6: Background Worker + Live Send + Progress + History - Research

**Researched:** 2026-07-13
**Domain:** Crash-safe background job worker over a shared WAL'd SQLite queue; per-recipient send state machine; live progress; campaign history + CSV export (Next.js 16 + better-sqlite3 + nodemailer, Docker/Coolify)
**Confidence:** HIGH — the stack is pre-decided and the core worker patterns (atomic claim, materialize-then-process, lease/heartbeat, resumability) were already researched to HIGH confidence in Phase 1 (`.planning/research/ARCHITECTURE.md` Patterns 2-4, `.planning/research/PITFALLS.md` #5-8/#14) and the send/merge/crypto primitives already exist and are unit-tested in `lib/core`. The only genuinely open items are design decisions (crash-recovery semantics for in-flight rows, throttle source, duplicate-address handling, progress transport) — flagged in the Assumptions Log for confirmation.

## Summary

Phase 6 is a **composition + one hard correctness problem**, not a greenfield build. Almost every primitive it needs already exists and is tested: the atomic-claim pattern (designed in Phase 1 ARCHITECTURE Pattern 2, and already implemented in miniature as `enqueueCampaign`'s atomic UPDATE), the `campaigns` job-row state machine and the `send_records` per-recipient state machine (both on disk since Phase 1 migration `0000`, with `UNIQUE(campaign_id, to_addr)` already present), the WAL'd single-opener DB proven concurrent-safe across two processes, the pure send engine (`sendOne`/`createSmtpTransport`/`verifyTransport`/`throttle` in `lib/core/send.ts`, returning the structured `SendResult` designed explicitly "for the Phase 6 worker"), the merge engine (`fillMessage`), the CSV reader (`parseCsv`/`readUpload`), the crypto (`decrypt`), and the userId-scoped DAL convention. The worker skeleton (`worker/index.ts`) and the docker-compose `worker` service already exist.

The work is therefore: (1) replace the worker skeleton's no-op heartbeat with a **poll → claim → recover → materialize → send-loop → finalize** cycle, built as *testable seams in `lib/worker/`* plus a thin `worker/index.ts` composition root (mirroring the mandatory `actions.ts`/`actions-core.ts` split); (2) add campaign DAL functions for progress reads, history lists, drill-down, and CSV export; (3) add polling-based progress UI and history/drill-down pages + a userId-scoped CSV export route handler. **No new npm packages are required** — and the flagged `plainjob` queue should be **rejected** (still 0.0.14, unchanged since Oct 2024; the DB-as-queue decision is already made and is simpler).

The single high-stakes design decision is the **crash-recovery semantic for a row that was mid-SMTP when the worker died**: success criterion #4 says "no double-send ever" and "only pending recipients processed." That mandates writing `sending` (committed) *before* the SMTP attempt and treating any orphaned `sending` row found on restart as **terminal, never auto-resent** (its delivery is genuinely unknown — it may have been accepted before the crash). Everything else — progress, history, idempotency, resumability — falls out of the `send_records` state machine for free.

**Primary recommendation:** Build the worker as a single-process poll loop using a **raw prepared-statement atomic claim** (`connection` is already exported from `@/lib/db` for exactly this), materialize `send_records` idempotently via `INSERT ... ON CONFLICT DO NOTHING`, process only `status='pending'` rows committing each outcome in its own synchronous statement immediately after the `await sendMail`, write `sending` before each attempt so orphans are detectable, and surface progress by **polling** a userId-scoped read action every ~2s (not SSE). Put all logic in testable `lib/worker/*` seams; keep `worker/index.ts` a thin wiring + signal-handling shell.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Claim a queued campaign atomically | Worker process | DB (single-writer lock) | The worker is the only sender; the claim is a single UPDATE the DB serializes (Pattern 2). No web involvement. |
| Materialize one `send_record` per row | Worker process | DB (`UNIQUE` constraint) | Worker reads CSV + template, fills, inserts idempotently. Web never writes send_records. |
| Send one personalized email + record outcome | Worker process | — | Worker owns nodemailer transport + per-row state transitions. Web has no SMTP path in the send flow. |
| Lease / heartbeat / crash recovery | Worker process | DB | Liveness + reclaim of stalled campaigns is a worker-loop concern. |
| Graceful shutdown (SIGTERM) | Worker process | Docker/Coolify (stop grace) | Signal handling is in the worker; the grace-period tuning is Phase 8 infra. |
| Enqueue (draft→queued) | Web / API (Server Action) | DB | Already shipped in Phase 5 (`enqueueCampaign`). Web-side only. |
| Live progress read (counts + current) | Web / API (RSC + poll action) | DB (read) | Browser polls a userId-scoped read; worker never pushes. DB is the single source of truth. |
| History list + drill-down | Web / API (RSC pages) | DB (read) | Pure userId-scoped reads over campaigns + send_records. |
| CSV export of results | Web / API (Route Handler) | DB (read) | A `GET` route handler streams a userId-scoped CSV; auth via Clerk in the handler. |
| SMTP credential decryption at send time | Worker process | lib/crypto | Decrypt happens only in the worker (per PITFALLS #1 guidance), never in the request path here. |

## Standard Stack

### Core (all already installed — no new dependencies)
| Library | Version (installed) | Purpose | Why Standard |
|---------|--------------------|---------|--------------|
| `better-sqlite3` | 12.11.1 | Synchronous SQLite driver; the queue + state store | Already the sole opener (`lib/db/client.ts`), WAL + busy_timeout=5000 set once; proven concurrent-safe across web+worker in Phase 1. `[VERIFIED: node require + package.json]` |
| `drizzle-orm` | ^0.45 | Typed queries for DAL reads/writes | Established DAL convention (`lib/data/*`). `[VERIFIED: package.json]` |
| `nodemailer` | 9.0.3 | SMTP transport per campaign | Wrapped by `lib/core/send.ts` (`createSmtpTransport`/`sendOne`/`verifyTransport`). `[VERIFIED: node require]` |
| `pino` | 10.3.1 | Structured worker logging (readiness/liveness/results) | Installed for the worker; STATE notes "pino wired in Phase 6 when the worker actually does work." `[VERIFIED: node require]` |
| `papaparse` | ^5.5 | CSV parse in the worker's materialization step | Wrapped by `parseCsv` in `lib/core/csv.ts`. `[VERIFIED: package.json]` |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `tsx` | ^4.22 | Runs `worker/index.ts` in dev + the compose `worker` service | Already the `worker` npm script and compose command. `[VERIFIED: package.json]` |
| node:test + `--import tsx` | built-in | Worker seam unit tests | Same harness as every existing `lib/**/*.test.ts` (`npm test`). `[VERIFIED: package.json scripts]` |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| DB-as-queue + raw atomic claim | `plainjob` (0.0.14) | **REJECT.** Still pre-1.0, unchanged since 2024-10-13, single release line — fails the "maturity check before Phase 6" from STATE. The DB-as-queue decision is locked (STATE Decisions: "the DB is the queue; no Redis for v1"). Adopting a queue lib would add a second source of truth for a handoff SQLite already does durably (ARCHITECTURE Anti-Pattern 2). `[VERIFIED: npm view plainjob]` |
| Polling for progress | SSE (route handler streaming) | SSE works on Next.js standalone but adds proxy-buffering risk behind Traefik/Coolify and connection-lifecycle complexity. Bias is "simplest thing that satisfies live progress" — polling a read action wins for v1. `[ASSUMED]` — see Assumptions Log. |
| `nodemailer` one-transport-per-campaign, sequential | `pool:true` + `rateDelta`/`rateLimit`/`maxMessages` | Pooling helps throughput at scale; at 100-1,000 sequential-with-throttle sends it adds config surface for no benefit and complicates the "throttle between sends" carry-forward. Keep the CLI's proven sequential model; revisit pooling only if throughput becomes the bottleneck (ARCHITECTURE Scaling note). `[CITED: .planning/research/PITFALLS.md #14]` |
| `p-queue` (installed) | — | Not needed: sends are sequential by design (throttle between each). Do not introduce concurrency into the send loop. `[VERIFIED: package.json — installed but unused]` |

**Installation:** None. Phase 6 introduces no new packages.

## Package Legitimacy Audit

> Phase 6 installs **no new external packages**. Every library it uses was vetted and installed in Phases 1-5. No slopcheck run is required for new installs. The one flagged package (`plainjob`) is being **rejected**, not installed.

| Package | Registry | Age / Last publish | Source Repo | Disposition |
|---------|----------|-----|-------------|-------------|
| `plainjob` | npm | 0.0.14, published 2024-10-13 (unchanged ~21 mo) | (job lib) | **REJECTED** — pre-1.0, stale, fails maturity gate; DB-as-queue chosen instead |
| all others | npm | already installed & in use | — | Approved (in-use since Phase 1) |

**Packages removed due to slopcheck [SLOP] verdict:** none (no new installs).
**Packages flagged as suspicious [SUS]:** none.

## Architecture Patterns

### System Architecture Diagram

```
  WEB CONTAINER (Next.js)                         WORKER CONTAINER (tsx worker/index.ts)
  ┌───────────────────────────┐                  ┌──────────────────────────────────────────┐
  │ Phase 5: enqueueCampaign   │                  │  poll loop (setInterval, ref'd)            │
  │  draft ─atomic UPDATE→ queued                 │      │                                     │
  └───────────┬───────────────┘                  │      ▼                                     │
              │ writes queued row                 │  claimNextCampaign()  ── raw prepared stmt │
              ▼                                    │   UPDATE campaigns SET status='running',   │
  ┌───────────────────────────────────────────┐  │   lease, worker_id WHERE queued OR stalled │
  │        SHARED WAL'd SQLite  (/data/app.db) │◄─┤      │ (won == returned row)               │
  │  campaigns:  status machine + counters     │  │      ▼                                     │
  │  send_records: per-recipient state machine │  │  recoverOrphans()  sending→failed(unknown) │
  │   UNIQUE(campaign_id,to_addr)              │  │      ▼                                     │
  └───────────▲───────────────────────────────┘  │  materializeRecords()  INSERT..ON CONFLICT │
              │ reads (poll every ~2s)            │   DO NOTHING, one pending row per CSV row   │
  ┌───────────┴───────────────┐                  │      ▼                                     │
  │ progress action (RSC/poll)│                  │  decrypt SMTP → createSmtpTransport → verify│
  │  sent/failed/remaining +  │                  │      ▼                                     │
  │  current recipient        │                  │  for each pending send_record (ORDER BY id):│
  ├───────────────────────────┤                  │    UPDATE ..status='sending'  (committed)   │
  │ history list + drill-down │                  │    await sendOne(...)                       │
  │  (RSC pages, userId-scoped)│                 │    UPDATE ..sent|failed + bump campaign cnts │
  ├───────────────────────────┤                  │    heartbeat lease; throttle(delayMs)       │
  │ CSV export (route handler)│                  │      ▼                                     │
  └───────────────────────────┘                  │  finalize: campaign→completed (or failed)   │
                                                  │  SIGTERM: stop claiming, finish/abandon row,│
  Data flow: web WRITES queued rows; worker       │  flush, transport.close(), exit 0           │
  CLAIMS + WRITES progress; web READS progress.   └──────────────────────────────────────────┘
  They never talk over HTTP — the DB is the queue.
```

### Recommended Project Structure
```
lib/worker/                    # NEW — testable worker seams (picked up by `lib/**/*.test.ts`)
├── claim.ts                   # claimNextCampaign(workerId): raw prepared atomic UPDATE..RETURNING
├── claim.test.ts
├── recover.ts                 # recoverOrphanedSending(campaignId): sending → failed(unknown)
├── materialize.ts             # materializeSendRecords(campaign): CSV→fill→INSERT ON CONFLICT DO NOTHING; set campaign.total
├── materialize.test.ts
├── process.ts                 # runCampaign(campaign, {transport?, delayMs, onHeartbeat}): the pending-row send loop
├── process.test.ts            # inject stub transport (no live socket), temp DB
├── finalize.ts                # markCompleted/markFailed + lease release
├── loop.ts                    # tick(): claim → recover → materialize → run → finalize (composed, injectable)
└── loop.test.ts
lib/data/campaigns.ts          # EXTEND — add progress + history reads (below)
worker/index.ts                # REPLACE skeleton: pino logger + poll interval calling loop.tick() + SIGTERM handler
app/(app)/campaigns/           # NEW — history list
│   ├── page.tsx               # listCampaignsForUser → table
│   └── [id]/page.tsx          # drill-down: campaign + send_records, live progress if running
app/(app)/campaigns/[id]/export/route.ts  # NEW — userId-scoped CSV export (GET route handler)
components/campaign/           # EXTEND
│   ├── progress-panel.tsx     # "use client" — polls progress action every ~2s
│   ├── campaign-list.tsx      # (or render server-side in page.tsx)
│   └── recipient-results-table.tsx
lib/campaign/actions.ts        # EXTEND — add getCampaignProgress action (auth → core)
lib/campaign/actions-core.ts   # EXTEND — getCampaignProgressCore(userId, id)
```

### Pattern 1: Atomic job claim (raw prepared statement) — ARCHITECTURE Pattern 2
**What:** A single `UPDATE campaigns SET status='running', lease_expires_at=…, worker_id=… WHERE id=(SELECT id … WHERE status='queued' OR stalled ORDER BY created_at LIMIT 1) RETURNING *`. SQLite's single-writer model makes this atomic; the returned row IS proof you won the claim.
**When to use:** Every poll tick.
**Why raw, not drizzle:** `lib/db/index.ts` already exports the raw `connection` "the worker may need the raw handle." A raw prepared statement guarantees the exact `UPDATE…WHERE id=(subquery)…RETURNING` shape from ARCHITECTURE without fighting the query builder. Everything else in the worker can use `db` (drizzle).
```typescript
// Source: .planning/research/ARCHITECTURE.md Pattern 2 (adapted; connection from @/lib/db)
import { connection } from "@/lib/db";
const claimStmt = connection.prepare(`
  UPDATE campaigns
     SET status='running',
         lease_expires_at = unixepoch() + @leaseSec,
         worker_id = @workerId,
         started_at = COALESCE(started_at, unixepoch())
   WHERE id = (
     SELECT id FROM campaigns
      WHERE status='queued'
         OR (status='running' AND lease_expires_at < unixepoch())  -- stalled reclaim
      ORDER BY created_at LIMIT 1
   )
  RETURNING *;
`);
const claimed = claimStmt.get({ workerId, leaseSec: 300 }); // one row or undefined
```
**Note:** A single UPDATE is atomic on its own; no explicit `BEGIN IMMEDIATE` wrapper is needed for correctness here (that only matters for multi-statement claims). SQLite's `busy_timeout=5000` (already set) covers writer contention.

### Pattern 2: Materialize once, idempotently — ARCHITECTURE Pattern 3
**What:** After claiming, insert one `pending` `send_record` per CSV row. On resume (campaign re-claimed after a crash) the rows already exist, so use `INSERT … ON CONFLICT DO NOTHING` against the existing `UNIQUE(campaign_id, to_addr)` — new rows only, never a duplicate.
**When to use:** Immediately after claim, before the send loop, every time (idempotent on resume).
```typescript
// Worker reads the campaign's OWN FKs (never client input), composes existing primitives:
const set = /* recipient_sets row via campaign.recipient_set_id */;
const tpl = /* templates row via campaign.template_id */;
const { columns, rows } = parseCsv(readUpload(set.storage_path));           // lib/core + lib/csv
const emailCol = set.email_column ?? detectEmailColumn(columns, rows);      // lib/core/csv.ts
for (const row of rows) {
  const { subject, body } = fillMessage({ subject: tpl.subject, body: tpl.body }, row); // lib/core/fill.ts
  // INSERT OR IGNORE / ON CONFLICT DO NOTHING on (campaign_id, to_addr)
  db.insert(send_records).values({
    campaign_id: campaign.id, to_addr: row[emailCol], merged_subject: subject, merged_body: body,
  }).onConflictDoNothing();
}
// Reconcile the counter so "remaining" math is honest even if addresses de-duplicated:
// UPDATE campaigns SET total = (SELECT count(*) FROM send_records WHERE campaign_id=?) WHERE id=?
```
**Anti-pattern avoided:** re-materializing from row 0 on resend (ARCHITECTURE Anti-Pattern 3).

### Pattern 3: Process pending rows, commit each outcome immediately — ARCHITECTURE Pattern 3
**What:** Select `status='pending'` rows `ORDER BY id`. For each: write `sending` (committed), `await sendOne(...)`, then in a single synchronous statement write `sent` (+message_id, sent_at) or `failed` (+error, attempts+1) and bump the campaign counter. A failure never aborts the batch (carry-forward CLI behavior, already the `SendResult` contract).
**Critical better-sqlite3 note:** better-sqlite3 is **synchronous** and a transaction **cannot span an `await`**. So each per-row DB write is its own statement immediately before/after the `await` — never a transaction wrapping the SMTP call.
```typescript
// Source: .planning/research/ARCHITECTURE.md Pattern 3 + lib/core/send.ts SendResult contract
for (const rec of pendingRows) {                       // pending only → resumable, no double-send
  setStatusSending.run(rec.id);                        // committed BEFORE the attempt (orphan-detectable)
  const res = await sendOne({ transport, from, to: rec.to_addr, subject: rec.merged_subject, body: rec.merged_body });
  if (res.ok) { markSent.run(res.messageId, rec.id); bumpSent.run(campaign.id); }
  else        { markFailed.run(res.error.message, rec.id); bumpFailed.run(campaign.id); } // message-only, never raw Error (D-06)
  bumpLease.run(campaign.id);                           // heartbeat (Pattern 4)
  await throttle(delayMs);                              // configurable inter-send delay (lib/core/send.ts)
}
```

### Pattern 4: Lease + heartbeat for crash recovery — ARCHITECTURE Pattern 4
**What:** The claimed campaign carries `lease_expires_at` (already a column). Bump it every row (or every ~30s) during the loop. If the worker dies, the lease expires and the next tick's claim query re-selects it via the `status='running' AND lease_expires_at < unixepoch()` branch. Because only `pending` rows are processed, resumption is safe.
**Trade-off:** lease must exceed one send + one throttle comfortably; a 5-min lease with per-row heartbeat is safe at this scale (ARCHITECTURE guidance: heartbeat ~30s, 5-min lease).

### Pattern 5: Crash-recovery semantic for orphaned `sending` rows — THE key design decision
**What goes wrong if ignored:** A row mid-`sendMail` when the worker died is in `sending`. Its delivery is **genuinely unknown** — the SMTP server may have accepted it before the crash. Success criterion #4 is "no double-send ever" and "only pending recipients processed."
**Recommended semantic (satisfies #4):** On claim/resume, run a recovery sweep: transition any `status='sending'` row for the claimed campaign to a **terminal** state — `failed` with `error='interrupted: delivery status unknown'` (and bump `failed_count`) — and **never auto-resend it**. This trades a possible false-negative (an email that actually delivered is recorded failed) for the hard, non-negotiable guarantee of zero duplicates. Surface these in the drill-down so the user can manually re-target if needed.
**Why not "reset sending→pending":** that would re-send a possibly-already-delivered message → violates "no double-send ever." Rejected.
**This is an ASSUMED design decision** (no CONTEXT.md) — see Assumptions Log A2. The alternative (dedicated `interrupted` status instead of overloading `failed`) is viable but adds a status value the history UI must render; `failed` + distinct error string is simpler.

### Pattern 6: Worker split — testable seams + thin entrypoint (MANDATORY, mirrors actions/actions-core)
**What:** All claim/recover/materialize/process/finalize logic lives in `lib/worker/*` as pure-ish functions that accept injected dependencies (`db`/`connection`, an optional `MailTransport` override, `delayMs`, a clock/heartbeat callback) — exactly like `lib/campaign/actions-core.ts` accepts a `transportOverride`. `worker/index.ts` is the composition root: it builds the pino logger, sets the poll interval, wires signal handlers, and calls `loop.tick()`. This keeps every send/claim behavior unit-testable with a temp DB + stub transport (no live socket), and placed under `lib/` so the existing `npm test` glob (`lib/**/*.test.ts`) picks them up automatically.
**Why:** The whole codebase tests through injectable seams (see `lib/campaign/actions-core.test.ts` injecting `stubTransport`). A monolithic `worker/index.ts` with inline logic would be untestable and break the established convention.

### Pattern 7: Graceful shutdown (SIGTERM/SIGINT) — PITFALLS #8
**What:** Trap `SIGTERM`/`SIGINT`: set a `stopping` flag so the loop stops *claiming new* campaigns, let the *current* row's `await sendOne` finish (or record it and stop), flush DB writes (synchronous — already durable per row), `transport.close()`, exit 0.
```typescript
let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"] as const)
  process.on(sig, () => { stopping = true; /* loop checks `stopping` between rows */ });
```
**Note:** Docker `stop_grace_period` tuning and PID-1/init (`tini`) so signals reach Node are **Phase 8** infra concerns (docker-compose is a skeleton). Phase 6 owns the in-process handler; Phase 8 owns the grace period. Because every row is committed synchronously, even an ungraceful `SIGKILL` is recoverable (Pattern 5).

### Anti-Patterns to Avoid
- **Coordinating web↔worker over HTTP** — the DB is the queue (ARCHITECTURE Anti-Pattern 2).
- **In-memory progress** — every count is a `send_records` query; progress/history/idempotency are all views over the persisted state (ARCHITECTURE Anti-Pattern 3).
- **Re-implementing merge/send/crypto/transport/CSV** — all exist in `lib/core` + `lib/crypto` + `lib/csv`; new such code in Phase 6 is a review flag (Phase 5 PATTERNS "Reused pure primitives").
- **Wrapping the SMTP `await` in a better-sqlite3 transaction** — transactions can't span awaits; commit per row instead.
- **Fetching any campaign/send_record by id without a `userId` filter** on the web side (IDOR / AUTH-02). The worker is the *only* code that reads by campaign id without a Clerk session — it derives tenancy from `campaign.userId` and loads *that* user's SMTP config.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Job queue / handoff | A queue lib (`plainjob`) or Redis or an HTTP trigger | The `campaigns` status column + atomic claim (DB-as-queue) | Locked decision; SQLite already does durable handoff; second source of truth is the anti-pattern |
| Atomic claim | `SELECT` then `UPDATE` | Single `UPDATE…WHERE(subquery)…RETURNING` | TOCTOU race; single statement is atomic under SQLite single-writer |
| Send one email | New nodemailer call | `sendOne` (`lib/core/send.ts`) | Already returns the structured `{ok,messageId}`/`{ok,error}` contract designed for this worker; never throws-and-aborts |
| Build transport | `nodemailer.createTransport` inline | `createSmtpTransport` (`lib/core/send.ts`) | Explicit `secure` (no port inference), timeout options, single factory |
| Merge fields | String replace | `fillMessage` (`lib/core/fill.ts`) | Personalizes subject AND body (EDIT-03), token semantics already tested |
| Parse CSV | `split(',')` | `parseCsv` + `readUpload` (`lib/core/csv.ts`, `lib/csv/storage.ts`) | BOM/quoting/CRLF handled; storage path traversal boundary enforced |
| Decrypt SMTP password | `crypto` inline | `decrypt` (`lib/crypto`) | AES-256-GCM triple, auth-tag verified, key loader fails closed |
| Throttle | `setTimeout` inline | `throttle(ms)` (`lib/core/send.ts`) | Carry-forward of `DELAY_MS`, 0-safe |
| userId-scoped reads | ad-hoc `db.query` in a page | DAL functions in `lib/data/campaigns.ts` | AUTH-02 invariant lives behind one import surface; no fetch-by-id-alone path |
| CSV export escaping | `join(',')` | A minimal RFC-4180 field quoter + formula-injection prefix | Embedded commas/quotes/newlines corrupt columns; leading `= + - @`/tab/CR is a spreadsheet formula-injection payload (PITFALLS #12) |

**Key insight:** Phase 6 is ~80% wiring of already-tested primitives around one new correctness pattern (the send loop + crash recovery). The linchpin `send_records` state machine and the `SendResult` contract were *designed for this phase* in Phase 1 — the worker consumes them, it does not reinvent them.

## Common Pitfalls

### Pitfall 1: Double-send after crash (the highest-stakes correctness bug) — PITFALLS #6
**What goes wrong:** Worker restarts mid-batch and re-emails people already contacted.
**How to avoid:** Materialize `send_records` up front; process only `pending`; commit each outcome immediately; write `sending` before the attempt; treat orphaned `sending` as terminal-never-resend (Pattern 5). Never restart from row 0.
**Warning signs:** A recipient reports a duplicate; restarting the worker resends; no per-recipient status; resend logic keyed on campaign-level "done" flag.
**Verification:** Kill the worker mid-batch (SIGKILL) and restart → only un-sent rows send; zero duplicates. (PITFALLS "Looks Done But Isn't" checklist.)

### Pitfall 2: Duplicate recipient addresses collapse silently — NEW, phase-specific
**What goes wrong:** `UNIQUE(campaign_id, to_addr)` means two CSV rows with the same email (but different merge data) materialize as **one** `send_record` — the second row's personalization is silently dropped, and one recipient gets one email instead of two.
**Why it happens:** The unique key that makes materialization idempotent (Pattern 2) also de-duplicates by address.
**How to avoid / decide:** For the credential-delivery-style target use case, one-email-per-address is usually *desirable*. Recommendation: keep the constraint, **reconcile `campaign.total` to the materialized count** (Pattern 2) so progress math stays honest, and surface a pre-send/summary note when the CSV contains duplicate addresses (the Phase 5 confirm summary already computes counts — a duplicate-address count could be added there or here). Do **not** silently let `total` (row count) diverge from `send_records` count, or "remaining" never reaches zero. **Flag for confirmation** — Assumptions A3.
**Warning signs:** Progress bar stalls just short of 100%; `total` > `count(send_records)`.

### Pitfall 3: `SQLITE_BUSY` under web-read + worker-write — PITFALLS #5
**What goes wrong:** Progress polling (web reads) collides with the worker's per-row writes.
**How to avoid:** WAL + `busy_timeout=5000` are already set once in `lib/db/client.ts` — both processes inherit them (single opener, D-04). Keep worker writes short (single statements, already the plan). This was proven concurrent-safe in Phase 1's two-process smoke test. **Re-verify under real send load** (PITFALLS mapping: "re-check in worker"). Watch WAL growth over a long campaign; `wal_checkpoint(RESTART)` between campaigns is a Phase 8 concern.
**Warning signs:** Intermittent "database is locked"; a `*.db-wal` that never shrinks.

### Pitfall 4: BYO-SMTP rate limits / 4xx vs 5xx — PITFALLS #14
**What goes wrong:** The user's provider throttles the batch (`421`/`454`), or a transient error is treated as permanent (or vice-versa).
**How to avoid (v1 scope):** Throttle conservatively (configurable delay). Record the per-recipient SMTP error message + code (`sendOne` already returns `error.code`). **Full 4xx-retry-with-backoff is a judgment call for v1**: the `attempts` column and `SendResult.error.code` exist to support it, but the MVP can record a 4xx as `failed` (surfaced, not silently lost) without an automatic retry loop. Recommendation: MVP = no automatic retry; record code so the user sees deferrals; leave backoff as a documented future enhancement. **Flag** — Assumptions A4.
**Warning signs:** A batch fails partway with `421`; "sent" high but inbox delivery low (deliverability is the sender's responsibility — Out of Scope).

### Pitfall 5: Progress "current recipient" and terminal-status derivation — NEW, phase-specific
**What goes wrong:** Ambiguity over what "current recipient" means and when a campaign is `completed` vs `failed`.
**How to avoid:** "Current recipient" = the single row currently in `status='sending'` (there is at most one, since sends are sequential); if none, the campaign is between rows or done. Campaign terminal rule: after the loop drains all `pending`, set `completed` (even if some rows `failed` — partial failure is still a completed *run*; success criterion #2 says "failures don't abort the batch"). Reserve campaign `status='failed'` for a whole-campaign abort (e.g. `verify()` failed before any send, or SMTP config missing/decrypt error). **Flag** — Assumptions A5.
**Warning signs:** A campaign with 3 failed / 97 sent shown as "failed"; UI can't tell running from stalled.

### Pitfall 6: Worker has no Clerk session — tenancy from the row — PITFALLS #13
**What goes wrong:** The worker sends with the wrong tenant's SMTP creds, or web-side history/export leaks across tenants.
**How to avoid:** Worker derives `userId` from `campaign.userId` and loads *that* user's SMTP config + recipient set + template by their FKs — never an ambient/global config. Every web-side read (progress, list, drill-down, export) goes through a userId-scoped DAL function with `and(eq(id), eq(userId))` — the CSV export route handler must re-derive `userId` via `auth()` and scope the query, or a guessed campaign id leaks another tenant's results.
**Verification:** As user B, `GET /campaigns/{A's id}/export` → 404; B cannot see A's campaign in the list or drill-down.

## Code Examples

### Progress read action (userId-scoped) — extends lib/campaign
```typescript
// lib/campaign/actions-core.ts (NO "use server") — add:
// Source pattern: buildConfirmSummaryCore (lib/campaign/actions-core.ts:372) — auth-scoped read
export async function getCampaignProgressCore(userId: string, input: { campaignId: unknown }) {
  const id = campaignIdSchema.safeParse(input.campaignId);
  if (!id.success) return { ok: false, error: { kind: "validation", issues: id.error.issues } };
  const c = await getCampaignForUser(userId, id.data);          // IDOR-safe (and(eq(id),eq(userId)))
  if (!c) return { ok: false, error: { kind: "not_found" } };
  // current recipient: the lone row in 'sending', if any
  return { ok: true, data: {
    status: c.status, total: c.total, sent: c.sent_count, failed: c.failed_count,
    remaining: c.total - c.sent_count - c.failed_count,
    current: /* SELECT to_addr FROM send_records WHERE campaign_id=? AND status='sending' LIMIT 1 */,
  }};
}
// lib/campaign/actions.ts ("use server") — thin wrapper: auth() → getCampaignProgressCore(userId, input)
```

### Progress polling component (client)
```tsx
// components/campaign/progress-panel.tsx  "use client"
// Poll every ~2s while running; stop when status is completed/failed.
import { getCampaignProgress } from "@/lib/campaign/actions";
useEffect(() => {
  if (status === "completed" || status === "failed") return;
  const t = setInterval(async () => {
    const r = await getCampaignProgress({ campaignId });
    if (r.ok) setProgress(r.data);
  }, 2000);
  return () => clearInterval(t);
}, [status, campaignId]);
```

### CSV export route handler (userId-scoped, formula-injection-safe)
```typescript
// app/(app)/campaigns/[id]/export/route.ts
import { auth } from "@clerk/nextjs/server";
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;
  const campaign = await getCampaignForUser(userId, Number(id));   // IDOR-safe
  if (!campaign) return new Response("Not found", { status: 404 });
  const rows = await getSendRecordsForCampaign(userId, campaign.id); // scoped via campaign ownership
  const csv = toResultsCsv(rows);   // quote fields; prefix leading = + - @ \t \r (PITFALLS #12)
  return new Response(csv, {
    headers: { "Content-Type": "text/csv; charset=utf-8",
               "Content-Disposition": `attachment; filename="campaign-${campaign.id}-results.csv"` },
  });
}
```

### Worker seam test shape (temp DB + stub transport, no live socket)
```typescript
// lib/worker/process.test.ts — mirrors lib/campaign/actions-core.test.ts harness
// set DATABASE_PATH + CREDENTIAL_ENC_KEY to temp BEFORE dynamic imports; migrate() a throwaway DB;
// inject a stubTransport that counts verify()/sendMail() and can be told to fail row N;
// assert: only 'pending' rows sent, each flips to sent/failed, campaign counts bump,
// a mid-loop "crash" (throw) leaves committed rows intact and re-run sends only remaining pending.
```

## State of the Art

| Old Approach (CLI) | Current Approach (Phase 6) | When Changed | Impact |
|--------------------|----------------------------|--------------|--------|
| In-memory `sent` counter, re-run re-sends all | Persisted `send_records` state machine; process pending only | Designed Phase 1, built Phase 6 | Crash-safe, resumable, no double-send |
| Single process, synchronous CLI | Web + long-lived worker over shared WAL'd SQLite | Phase 1 | Background send survives HTTP lifecycle (SEND-01) |
| `DELAY_MS` compile-time constant | `throttle(ms)` param, worker-sourced delay | Phase 1 (`lib/core/send.ts`) | Configurable throttle (SEND-02) |
| No audit trail | Per-recipient row = history + export | Phase 6 | HIST-01/02/03 fall out of the state machine |

**Deprecated/outdated:**
- `plainjob` as a queue: rejected (see Alternatives). The DB-as-queue is the current design.
- SSE-first progress: deprioritized in favor of polling for a self-hosted Traefik/Coolify deploy (simplicity over push).

## Assumptions Log

> No CONTEXT.md exists (autonomous run). These are design decisions the planner/discuss-phase should confirm before locking.

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Progress uses **polling** (~2s) a userId-scoped read action, not SSE/websockets | Alternatives / Pattern examples | Low — polling is a safe default; if real-time push is required, swap to SSE later. Wasted work risk is small. |
| A2 | Orphaned `sending` rows on crash → marked **`failed('interrupted: delivery unknown')`, never auto-resent** (guarantees no double-send) | Pattern 5 | Medium — the alternative (dedicated `interrupted` status) changes the history UI; and this records a possibly-delivered mail as failed. But it is the only semantic that satisfies "no double-send ever." |
| A3 | Duplicate recipient addresses in one CSV **collapse to one send** (per `UNIQUE(campaign_id,to_addr)`); `campaign.total` reconciled to materialized count | Pitfall 2 | Medium — if per-row (not per-address) sends are required, the unique key / materialization strategy must change (e.g. include row index). Affects schema semantics. |
| A4 | MVP records SMTP `4xx` as `failed` (with code) **without automatic retry/backoff**; `attempts` column reserved for future | Pitfall 4 | Medium — a provider that soft-defers (`421`) will show failures the user might expect to auto-retry. `attempts`/`code` are captured so a retry loop can be added without schema change. |
| A5 | Campaign → **`completed`** when all rows drained even with partial failures; **`failed`** reserved for whole-campaign aborts (verify fail / no config / decrypt error) | Pitfall 5 | Low-Medium — a different definition (e.g. "failed if any row failed") would mislabel normal partial-failure runs. |
| A6 | Throttle sourced from an **env var** (e.g. `SEND_DELAY_MS`, default ~1000-3000ms); no per-campaign throttle column exists in the schema | Pattern 3 | Low-Medium — if per-campaign throttle is desired, a `campaigns` column + migration is needed. Env default is simplest for v1. |
| A7 | Worker logic lives in **`lib/worker/*`** (so `npm test`'s `lib/**/*.test.ts` glob covers it); `worker/index.ts` is the thin entrypoint | Pattern 6 / structure | Low — if placed elsewhere, the test glob (`lib/**/*.test.ts`) must be extended or tests won't run. |
| A8 | Phase 6 worker sends **text-only, no attachments** (attachments are Phase 7); `attachments` table untouched here | scope | Low — matches roadmap (ATCH-* = Phase 7). |
| A9 | New nav slots **"Campaigns"/"History"** added to `components/app-sidebar.tsx` (the file already documents these as future slots) | structure | Low — cosmetic/navigation. |

## Open Questions

1. **Duplicate-address policy (ties to A3).**
   - What we know: `UNIQUE(campaign_id, to_addr)` de-duplicates; target use case (credential delivery) is one-per-address.
   - What's unclear: whether any real campaign needs two emails to the same address with different merge data.
   - Recommendation: keep the constraint, reconcile `total`, surface a duplicate count in the confirm/summary; revisit only if a use case appears.

2. **Whole-campaign `verify()` on resume.**
   - What we know: Phase 5 test-send runs `verify()` once on chunk 0. The worker should `verify()` before the first send of a run.
   - What's unclear: on a *resumed* run (re-claim after crash) should it re-`verify()`? 
   - Recommendation: `verify()` once per worker *run* of a campaign (i.e. after each claim), before processing pending rows — cheap and catches a now-broken SMTP config. A verify failure → campaign `failed` (A5), no rows sent this run.

3. **Poll interval + stop condition tuning (ties to A1).**
   - Recommendation: 2s while `running`/`queued`; stop polling on `completed`/`failed`. Confirm acceptable UI latency.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | worker + web | ✓ | 24.9.0 (host) | — |
| better-sqlite3 (native) | queue/state | ✓ | 12.11.1 installed | — |
| nodemailer | send | ✓ | 9.0.3 installed | — |
| pino | worker logging | ✓ | 10.3.1 installed | console (skeleton uses console) |
| A real SMTP server for live-send tests | manual/integration test | ✗ (per-user BYO) | — | `smtp-server` (devDep, installed) as a local capture server for tests; unit tests use a stub transport (no socket) |

**Missing dependencies with no fallback:** none — all runtime deps are installed.
**Missing dependencies with fallback:** live SMTP for end-to-end verification — use the installed `smtp-server` devDependency (already used in `lib/smtp/verify.test.ts` patterns) or a stub transport for automated tests.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | node:test (built-in) run via `node --import tsx --test` |
| Config file | none — glob in package.json `test` script |
| Quick run command | `npm test` (globs `lib/**/*.test.ts`) — worker seams under `lib/worker/` are covered automatically |
| Full suite command | `npm test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SEND-01 | Send survives HTTP lifecycle (runs in worker process) | unit (seam) | `npm test` → `lib/worker/loop.test.ts` (claim + run without a request) | ❌ Wave 0 |
| SEND-02 | One personalized email per recipient, configurable throttle | unit | `lib/worker/process.test.ts` (stub transport counts one send/row; delayMs injected=0) | ❌ Wave 0 |
| SEND-03 | Per-recipient `pending→sending→sent/failed` + error + timestamp | unit | `lib/worker/process.test.ts` (assert status transitions + fields) | ❌ Wave 0 |
| SEND-04 | Failures don't abort; failed count surfaced | unit | `lib/worker/process.test.ts` (stub fails row N; loop continues; campaign.failed_count bumps) | ❌ Wave 0 |
| SEND-05 | Live progress read (sent/failed/remaining/current) | unit | `lib/campaign/actions-core.test.ts` (getCampaignProgressCore, IDOR-scoped) | ❌ Wave 0 (extend) |
| SEND-06 | Idempotent/resumable; no double-send; only pending processed | unit | `lib/worker/process.test.ts` + `materialize.test.ts` (re-run sends only remaining; ON CONFLICT DO NOTHING; orphan sweep) | ❌ Wave 0 |
| HIST-01 | Campaign list (userId-scoped) | unit | `lib/data/campaigns.test.ts` (listCampaignsForUser; cross-tenant excluded) | ❌ Wave 0 (extend) |
| HIST-02 | Drill-down per-recipient status/error | unit | `lib/data/campaigns.test.ts` (getSendRecordsForCampaign; IDOR) | ❌ Wave 0 |
| HIST-03 | CSV export of results, userId-scoped, injection-safe | unit | `lib/campaign/*.test.ts` (toResultsCsv quoting + formula-prefix; route auth is manual/integration) | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npm test` (fast — all seams are stubbed, no sockets)
- **Per wave merge:** `npm test` (full suite)
- **Phase gate:** Full suite green + a manual crash-resume check (kill worker mid-batch, restart, assert no duplicate) before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `lib/worker/claim.test.ts` — atomic claim wins once; stalled reclaim; concurrent-claim safety (SEND-01/06)
- [ ] `lib/worker/materialize.test.ts` — one pending row per CSV row; ON CONFLICT DO NOTHING on resume; total reconciled (SEND-06)
- [ ] `lib/worker/process.test.ts` — send loop transitions, partial failure, resumability, orphan sweep, throttle-between-only (SEND-02/03/04/06)
- [ ] `lib/worker/loop.test.ts` — tick() composes claim→recover→materialize→run→finalize; SIGTERM stop flag honored (SEND-01)
- [ ] `lib/data/campaigns.test.ts` (extend) — listCampaignsForUser, getSendRecordsForCampaign, getCampaignProgress reads with cross-tenant exclusion (HIST-01/02, SEND-05)
- [ ] `lib/campaign/actions-core.test.ts` (extend) — getCampaignProgressCore IDOR + shape; toResultsCsv escaping/injection (SEND-05, HIST-03)
- [ ] Shared fixtures: reuse the existing temp-DB + `stubTransport` harness from `lib/campaign/actions-core.test.ts` / `lib/smtp/actions.test.ts` (no new fixture framework)
- [ ] Framework install: none — node:test + tsx already present

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (web surfaces) | Clerk `auth()` in every action + the export route handler; worker has no session (derives tenant from row) |
| V3 Session Management | no (Clerk-managed) | — |
| V4 Access Control | **yes (critical)** | Every web read/write userId-scoped via DAL `and(eq(id), eq(userId))`; export route re-derives userId; worker scopes SMTP creds from `campaign.userId` (PITFALLS #13 / AUTH-02) |
| V5 Input Validation | yes | zod id/coercion schemas (`campaignIdSchema`) on every untrusted id; CSV parsed with `parseCsv`; export escapes fields + neutralizes formula injection (PITFALLS #12) |
| V6 Cryptography | yes | SMTP password only via `decrypt` (AES-256-GCM, `lib/crypto`), decrypted transiently in the worker, never logged/returned (PITFALLS #1/#2, SMTP-04) |
| V7 Error/Logging | yes | pino worker logs are readiness/result only; never the password/auth/transport config; per-row errors stored as message strings, never raw Error (D-06) |

### Known Threat Patterns for {worker + SQLite + SMTP + Next.js}

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| IDOR: guess another tenant's campaign id (progress/history/export) | Information Disclosure / Elevation | userId-scoped DAL on every read; export route `auth()` + owner filter; cross-tenant test returns 404 |
| Worker sends with wrong tenant's SMTP creds | Spoofing / Info Disclosure | Tenant derived from `campaign.userId`; load *that* user's config only — never ambient/global |
| SMTP password leaks to logs / error / client | Information Disclosure | Redacting discipline (PITFALLS #2); `sendOne` returns message-only errors; pino never logs auth/transport; test asserts password absent from serialized output |
| Double-send on crash/restart | Tampering (duplicate side effect) | Persisted per-recipient state machine + process-pending-only + orphan-sweep (Pattern 5); "no double-send ever" |
| CSV export formula injection | Tampering (client-side code exec in Excel) | Prefix leading `= + - @` / tab / CR on export fields (PITFALLS #12) |
| `SQLITE_BUSY` DoS under contention | Denial of Service | WAL + busy_timeout=5000 (single opener); short worker writes |
| Ungraceful kill mid-batch corrupts state | Tampering | Per-row synchronous commit → at most one in-flight row lost; SIGTERM handler + resumability |

## Sources

### Primary (HIGH confidence)
- `.planning/research/ARCHITECTURE.md` — Patterns 1-4 (shared-SQLite no-broker, atomic claim, idempotent resumable sends, lease/heartbeat), entity model, state machine, scaling notes, anti-patterns. The authoritative design for this phase.
- `.planning/research/PITFALLS.md` — #5 (SQLITE_BUSY), #6 (idempotency/duplicate sends), #7 (claim race), #8 (graceful shutdown), #14 (BYO-SMTP rate/deliverability), plus the "Looks Done But Isn't" checklist.
- Codebase (read in full): `lib/db/schema.ts` (campaigns + send_records state machines, `UNIQUE(campaign_id,to_addr)`), `lib/db/client.ts` + `index.ts` (single opener, WAL, raw `connection` exported for the worker), `lib/core/send.ts` (`sendOne`/`createSmtpTransport`/`verifyTransport`/`throttle`, the `SendResult` contract designed for this worker), `lib/campaign/actions.ts` + `actions-core.ts` (auth split, IDOR-scoped seams, decrypt/redact patterns, atomic enqueue), `lib/data/campaigns.ts` (userId-scoped DAL + atomic UPDATE), `worker/index.ts` (skeleton to replace), `docker-compose.yml` (worker service topology).
- `.planning/phases/05-test-send-confirmation-gate/05-PATTERNS.md` — the mandatory actions/actions-core split, reused-primitives rule, node:test harness convention, DAL ownership rules.
- `.planning/REQUIREMENTS.md` + `.planning/STATE.md` — SEND-01..06 / HIST-01..03 definitions; locked decisions (DB-as-queue, no Redis, plainjob maturity check, per-recipient state machine as the linchpin, Phase 6 = highest-risk).

### Secondary (MEDIUM confidence)
- `npm view plainjob` — version 0.0.14, last modified 2024-10-13, dist-tag latest=0.0.14 (confirms immaturity → reject).
- Installed versions confirmed via `node -e require(...package.json)`: nodemailer 9.0.3, better-sqlite3 12.11.1, pino 10.3.1, plainjob 0.0.14, next 16.2.9.

### Tertiary (LOW confidence)
- SSE-vs-polling behavior behind Traefik/Coolify — general platform knowledge; polling chosen to avoid proxy-buffering uncertainty (flagged A1, not verified against this specific deploy).

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — everything is already installed and in use; no new packages; plainjob rejection verified against the registry.
- Architecture: HIGH — the four core worker patterns were researched to HIGH confidence in Phase 1 and the consuming primitives already exist and are tested.
- Pitfalls: HIGH — carried forward from Phase 1's HIGH-confidence PITFALLS doc plus two phase-specific ones (duplicate-address collapse, terminal-status derivation) derived directly from the on-disk schema.
- Open design decisions: flagged as ASSUMED (A1-A9) — these need confirmation (crash-recovery semantic, duplicate policy, retry policy, terminal-status rule, throttle source) because no CONTEXT.md exists.

**Research date:** 2026-07-13
**Valid until:** 2026-08-13 (stable stack; re-verify only if package versions or the deploy target change)
