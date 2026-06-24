# Architecture Research

**Domain:** Multi-tenant BYO-SMTP CSV mail-merge web app (Next.js + SQLite + persistent Node worker, Coolify/Docker on VPS)
**Researched:** 2026-06-24
**Confidence:** HIGH (stack is pre-decided; SQLite concurrency + job-claim patterns verified against better-sqlite3 docs and multiple production write-ups)

## Standard Architecture

### System Overview

```
                          ┌───────────── Browser (React / shadcn) ─────────────┐
                          │  Onboarding · CSV upload · Editor+preview · Campaign │
                          │  run view (live progress) · History                  │
                          └───────┬───────────────────────────────┬─────────────┘
                                  │ HTTPS (Clerk session)          │ SSE / poll (progress)
                                  ▼                                ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          WEB CONTAINER  (Next.js, Node)                            │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ Clerk auth    │  │ Route Handlers│  │ Server       │  │ Progress endpoint    │  │
│  │ middleware    │  │ /api/* (REST) │  │ Actions      │  │ /api/campaigns/:id/  │  │
│  │ (userId)      │  │ upload,smtp,  │  │ (mutations)  │  │ stream  (SSE)        │  │
│  └──────┬───────┘  │ campaign,test)│  └──────┬───────┘  └─────────┬────────────┘  │
│         │          └──────┬────────┘         │                    │ reads          │
│         └─────────────────┴──────────────────┴────────────────────┘                │
│                                  │ data-access module (shared lib)                  │
└──────────────────────────────────┼────────────────────────────────────────────────┘
                                    │ writes job row + reads progress
                                    ▼
                    ┌───────────────────────────────────┐
                    │   SQLite file (WAL mode)           │◄──── shared host volume
                    │   app.db  +  app.db-wal / -shm     │
                    └───────────────────────────────────┘
                                    ▲ claims jobs, writes per-row progress
┌──────────────────────────────────┼────────────────────────────────────────────────┐
│                       WORKER CONTAINER  (long-running Node process)                  │
│  ┌────────────────┐  ┌──────────────────┐  ┌───────────────────────────────────┐    │
│  │ Poll loop      │→ │ Job claimer      │→ │ Send engine (reused CLI core)     │    │
│  │ (every ~1s)    │  │ BEGIN IMMEDIATE  │  │ decrypt SMTP → verify() →          │    │
│  │                │  │ UPDATE RETURNING │  │ fill() per row → sendMail()→delay  │    │
│  └────────────────┘  └──────────────────┘  └───────────────────────────────────┘    │
└──────────────────────────────────┬────────────────────────────────────────────────┘
                                    │ reads
                                    ▼
                    ┌───────────────────────────────────┐
                    │  Shared volume:  /data             │
                    │   app.db  ·  uploads/<csv>         │
                    │   attachments/<campaign>/<row>     │
                    └───────────────────────────────────┘
```

The web and worker are **two containers sharing one host volume**. They do not talk over HTTP. They communicate exclusively through the SQLite database (job rows + status columns) and the shared filesystem (CSV + attachment files). This is the central architectural decision and it keeps the system simple: no message broker, no internal API surface, one source of truth.

### Component Responsibilities

| Component | Responsibility | Typical Implementation |
|-----------|----------------|------------------------|
| **Clerk middleware** | Authenticate every request, attach `userId`; scope all queries to that user | `clerkMiddleware()` in `middleware.ts`; `auth()` in handlers |
| **Route Handlers / Server Actions** | Validate input, enforce ownership, write/read SQLite, write CSV + attachment files, enqueue campaigns | Next.js App Router `route.ts` + server actions |
| **Data-access module** | The only code that opens the DB; exposes typed functions (`createCampaign`, `claimJob`, `recordSend`…) | Shared TS lib imported by both web and worker; `better-sqlite3` |
| **Crypto module** | Encrypt/decrypt SMTP passwords at rest (AES-256-GCM, key from env) | Node `crypto`; shared by web (write on onboard, verify) and worker (decrypt on send) |
| **Progress endpoint** | Stream per-recipient status to the run view | SSE route reading `send_records` for a campaign, or short polling |
| **Worker poll loop** | Wake periodically, look for queued/stalled jobs | `setInterval`/loop in a standalone `worker.ts` process |
| **Job claimer** | Atomically take one job so exactly one worker run owns it | `BEGIN IMMEDIATE` + `UPDATE … RETURNING` |
| **Send engine** | The reused CLI core: decrypt SMTP, `verify()`, loop rows, `fill()`, `sendMail()`, throttle, record each result | nodemailer; lifted from `send-credentials.ts` |

## Recommended Project Structure

```
mail-merge/
├── apps/
│   ├── web/                     # Next.js app (web container)
│   │   ├── app/
│   │   │   ├── (auth)/onboarding/      # SMTP setup + live validate
│   │   │   ├── campaigns/[id]/         # run view (live progress) + history
│   │   │   └── api/
│   │   │       ├── smtp/verify/        # POST: test SMTP creds live
│   │   │       ├── csv/                # POST upload, parse headers
│   │   │       ├── campaigns/          # POST create+enqueue, GET list
│   │   │       ├── campaigns/[id]/test/   # POST whole-batch-to-one
│   │   │       └── campaigns/[id]/stream/ # GET SSE progress
│   │   └── components/            # editor (merge-field autocomplete), preview
│   └── worker/                   # worker container
│       └── src/worker.ts         # poll → claim → send loop
├── packages/
│   ├── db/                       # shared data-access (THE only DB owner)
│   │   ├── schema.sql            # migrations
│   │   ├── client.ts             # opens DB, sets WAL + busy_timeout pragmas
│   │   └── queries.ts            # createCampaign, claimJob, recordSend, ...
│   ├── core/                     # reused merge/send engine from the CLI
│   │   ├── fill.ts               # {{field}} substitution (generalized columns)
│   │   ├── csv.ts                # parse / validate
│   │   └── send.ts               # transport.verify + sendMail + throttle
│   └── crypto/                   # encrypt/decrypt SMTP secrets
├── data/                         # host volume mount (gitignored)
│   ├── app.db
│   ├── uploads/
│   └── attachments/
├── docker-compose.yml           # web + worker, shared volume (Coolify reads this)
└── Dockerfile(s)                # one image, two start commands (or two images)
```

### Structure Rationale

- **`packages/db` is the single DB owner.** Both web and worker import it. This guarantees identical pragmas (WAL, `busy_timeout`) and one place for the claim query. Two independently-written DB layers is how you get inconsistent locking behavior.
- **`packages/core` is the lift target for the existing CLI.** `loadRecipients → fill → verify → send-loop-with-delay` moves here almost verbatim; the generalization is `fill()` accepting arbitrary column keys instead of hard-coded `{{email}}`/`{{password}}`.
- **`apps/web` and `apps/worker` are separate entry points, one shared codebase.** A monorepo (npm/pnpm workspaces) lets the worker import `core`, `db`, and `crypto` without duplication, while building two container images/commands.

## Architectural Patterns

### Pattern 1: Shared-SQLite, no broker (web ↔ worker handoff)

**What:** Web and worker never call each other. The web process inserts a `campaign` row in `queued` status; the worker polls for it, claims it, and updates status as it sends. All coordination is rows in SQLite + files on the shared volume.

**When to use:** Single-host deployments at medium scale (here: 100–1,000 emails/send), where a persistent host removes serverless timeout pressure and a Redis broker would be premature.

**Trade-offs:** + No broker to run, deploy, or reason about; one source of truth; trivially inspectable. − One host only (WAL needs shared memory, does not work over NFS); single writer at a time (fine — sends are inherently serial with a throttle); polling adds ~1s latency to job pickup (irrelevant for batch email).

**Critical config (set once, in `packages/db/client.ts`):**
```typescript
const db = new Database('/data/app.db');
db.pragma('journal_mode = WAL');     // many readers + 1 writer across processes
db.pragma('busy_timeout = 5000');    // wait, don't throw, on a held write lock
db.pragma('synchronous = NORMAL');   // safe with WAL, faster commits
db.pragma('foreign_keys = ON');
```

### Pattern 2: Atomic job claim via `BEGIN IMMEDIATE` + `UPDATE … RETURNING`

**What:** SQLite has no `SKIP LOCKED`, but its single-writer model makes a claim atomic if you take the write lock up front. One statement selects a queued (or stalled) job, flips it to `running`, stamps a lease, and returns it.

**When to use:** Every worker poll tick. Works correctly even if you later run a second worker for resilience.

**Trade-offs:** + Race-free with zero extra infrastructure. − Workers serialize on the write lock (a non-issue at this scale and job count).

**Example:**
```typescript
// inside packages/db: claim the next runnable job atomically
const claim = db.transaction(() => {
  const job = db.prepare(`
    UPDATE campaigns
       SET status = 'running',
           lease_expires_at = unixepoch() + 300,
           worker_id = @workerId,
           started_at = COALESCE(started_at, unixepoch())
     WHERE id = (
       SELECT id FROM campaigns
        WHERE status = 'queued'
           OR (status = 'running' AND lease_expires_at < unixepoch())  -- stalled
        ORDER BY created_at
        LIMIT 1
     )
    RETURNING *;
  `).get({ workerId });
  return job;
});
// db.transaction() runs as BEGIN IMMEDIATE → takes the write lock before the subquery
```

### Pattern 3: Idempotent, resumable sends via per-recipient send records

**What:** Before the campaign runs, the worker materializes one `send_record` row per CSV row in `pending` status. The send loop processes only `pending` rows, and flips each to `sent`/`failed` **in its own committed transaction immediately after** the SMTP `sendMail` returns. Resuming a crashed campaign = "process rows still `pending`." No row is ever sent twice because a `sent` row is skipped.

**When to use:** Always. This is the design answer to the CLI's "re-running re-sends everyone" gap.

**Trade-offs:** + Crash/restart safe; gives the live progress view for free (count rows by status); per-row audit trail is the campaign history. − One small write per recipient (negligible; sends are already throttled seconds apart).

**Example:**
```typescript
for (const rec of db.prepare(
  `SELECT * FROM send_records WHERE campaign_id=? AND status='pending' ORDER BY id`
).all(campaignId)) {
  try {
    const info = await transport.sendMail(buildMessage(rec, template, attachments));
    db.prepare(`UPDATE send_records SET status='sent', message_id=?, sent_at=unixepoch() WHERE id=?`)
      .run(info.messageId, rec.id);            // committed before next iteration
  } catch (err) {
    db.prepare(`UPDATE send_records SET status='failed', error=?, attempts=attempts+1 WHERE id=?`)
      .run(String(err), rec.id);               // failure logged, loop continues (CLI parity)
  }
  await sleep(DELAY_MS);                         // carry-forward throttle
}
```

### Pattern 4: Lease + heartbeat for crash recovery

**What:** A claimed campaign carries `lease_expires_at`. The running worker periodically bumps it (heartbeat). If the worker dies, the lease expires and the next poll re-claims the campaign — which safely continues because only `pending` rows are processed (Pattern 3).

**When to use:** Needed for "resumable" guarantee across worker restarts/redeploys (Coolify redeploy kills and restarts the worker container mid-send).

**Trade-offs:** + Survives redeploys and crashes with no manual intervention. − Pick a lease longer than `DELAY_MS × in-flight-buffer`; too short and a slow send could be double-claimed (still safe per-row, but wasteful). Bound it by heartbeating every ~30s with a 5-min lease.

## Data Flow

### Entities (SQLite data model)

```
users (mirror of Clerk userId)
  id TEXT PK (= Clerk user id)
  created_at INTEGER

smtp_credentials            -- one active set per user (BYO SMTP)
  id INTEGER PK
  user_id TEXT FK → users
  host TEXT, port INTEGER, secure INTEGER
  username TEXT
  password_enc BLOB         -- AES-256-GCM ciphertext, NEVER plaintext/logged
  password_iv BLOB, password_tag BLOB
  from_addr TEXT, from_name TEXT
  verified_at INTEGER        -- set when transport.verify() succeeded
  created_at INTEGER

recipient_sets              -- an uploaded CSV
  id INTEGER PK
  user_id TEXT FK → users
  filename TEXT
  columns_json TEXT          -- header names → drives editor autocomplete
  row_count INTEGER
  storage_path TEXT          -- /data/uploads/<uuid>.csv
  created_at INTEGER

templates                   -- composed email (plain text)
  id INTEGER PK
  user_id TEXT FK → users
  subject TEXT               -- may itself contain {{fields}} (fixes CLI gap)
  body TEXT                  -- {{field}} tokens
  created_at INTEGER

campaigns                   -- the unit of work / the job
  id INTEGER PK
  user_id TEXT FK → users
  recipient_set_id FK → recipient_sets
  template_id FK → templates
  smtp_credential_id FK → smtp_credentials
  status TEXT                -- draft|queued|running|paused|completed|failed
  worker_id TEXT, lease_expires_at INTEGER
  total INTEGER, sent_count INTEGER, failed_count INTEGER
  created_at, started_at, finished_at INTEGER

send_records                -- one row PER recipient PER campaign (idempotency unit)
  id INTEGER PK
  campaign_id FK → campaigns
  to_addr TEXT
  merged_subject TEXT, merged_body TEXT   -- snapshot of what was/will-be sent
  status TEXT                -- pending|sent|failed
  message_id TEXT, error TEXT, attempts INTEGER
  sent_at INTEGER
  UNIQUE(campaign_id, to_addr)  -- guard against duplicate materialization

attachments                 -- per-row files (different file per CSV row)
  id INTEGER PK
  campaign_id FK → campaigns
  send_record_id FK → send_records   -- which row this file belongs to
  filename TEXT
  storage_path TEXT          -- /data/attachments/<campaign_id>/<row>/<file>
  created_at INTEGER
```

**Why files live on disk, not in SQLite:** CSVs and per-row attachments are stored on the shared `/data` volume; the DB holds only paths. Blobs in SQLite bloat the file, slow WAL checkpoints, and complicate the worker's streaming reads. The worker reads attachments by `storage_path` when building each message.

### Key Data Flows

1. **Onboarding + SMTP validate:** Browser → `POST /api/smtp/verify` → handler builds a nodemailer transport from submitted creds → `transport.verify()` (reused CLI step) → on success, encrypt password (crypto module) → insert `smtp_credentials` with `verified_at`. No send happens; this is the connectivity gate that mirrors the CLI's pre-send `verify()`.

2. **Upload + map CSV:** Browser uploads file → handler streams it to `/data/uploads/<uuid>.csv`, parses header row + counts rows (reused `loadRecipients`/`csv.ts`) → insert `recipient_sets` with `columns_json`. Columns feed the editor's merge-field autocomplete.

3. **Compose + preview:** Editor reads `columns_json` for autocomplete. Preview is a **server action** that runs `fill()` (reused) over the first N rows with the draft subject/body and returns merged samples. No persistence required until the user saves a `template`/`campaign` draft.

4. **Test-send (whole batch to one address):** `POST /api/campaigns/[id]/test` with a target address → handler runs the same send engine synchronously (or as a one-off worker job) sending every personalized message to the single test address. This is CLI `--test` parity and does **not** write `send_records` for the real recipients.

5. **Live background send with progress:** User confirms → handler materializes `send_records` (one per row, `pending`) + writes any attachments, sets campaign `status='queued'` → returns immediately. Worker poll loop **claims** the campaign (Pattern 2), decrypts SMTP, `verify()`, then loops `pending` rows calling `fill()` + `sendMail()` + throttle, committing each result (Pattern 3) and updating campaign counters. Browser opens `GET /api/campaigns/[id]/stream` (SSE) which reads `send_records`/counters and pushes progress. On completion worker sets `status='completed'`.

6. **View history:** `campaigns` list scoped to `userId`; drilling in reads `send_records` for per-recipient sent/failed status, error messages, and message IDs — the durable audit trail the CLI lacked.

### State Management (campaign lifecycle)

```
draft ──(user confirms)──▶ queued ──(worker claims)──▶ running
                                                          │
                          ┌───────────────────────────────┼─────────────┐
                          ▼                                ▼             ▼
                     completed                     (lease expires)    failed
                  (all rows terminal)             ──▶ re-queued        (fatal:
                                                      → running          SMTP verify
                                                   resumes pending       fails, etc.)
                                                      rows only
```

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| 0–1k emails/send (target) | Exactly this design. Single worker, single SQLite file, WAL. No changes needed. |
| 1k–10k / many concurrent users | Still one SQLite file (WAL handles many readers). If sends queue up behind one worker, run **2–3 worker replicas** — the atomic claim already makes this safe; per-row idempotency prevents double-sends. |
| 10k+ / high write contention | Consider moving the queue to Redis/BullMQ (the PROJECT.md "optional Redis" path) or the DB to Postgres for `SKIP LOCKED` true concurrency. Deliverability/rate-limit engineering (explicitly deferred in PROJECT.md) becomes the real bottleneck before SQLite does. |

### Scaling Priorities

1. **First bottleneck: worker throughput, not the DB.** Sends are throttled (`DELAY_MS`) and serial per campaign by design, so a long campaign holds the single worker. Fix by adding worker replicas (claim pattern is already concurrency-safe) before touching the datastore.
2. **Second bottleneck: WAL checkpoint growth** under sustained read load (e.g., many open SSE streams). Mitigate with periodic `wal_checkpoint(TRUNCATE)` and capping/aging out idle progress streams. Verified concern from better-sqlite3 + sqlite.org WAL docs.

## Anti-Patterns

### Anti-Pattern 1: Two processes each opening SQLite their own way

**What people do:** Web opens the DB with one set of pragmas; worker opens it with another (or forgets `busy_timeout`).
**Why it's wrong:** Without `journal_mode=WAL` you get reader/writer blocking and `SQLITE_BUSY` errors; without `busy_timeout` a contended write **throws instead of waiting**. Inconsistent pragmas across processes cause flaky, hard-to-reproduce lock errors.
**Do this instead:** One `packages/db/client.ts` imported by both. Set WAL + `busy_timeout` there. Both containers point at the same `/data/app.db` on the same host volume.

### Anti-Pattern 2: Coordinating via HTTP between web and worker

**What people do:** Web POSTs to a worker HTTP endpoint to "start a job."
**Why it's wrong:** Adds an internal API, service discovery, retry logic, and a second source of truth — for a handoff SQLite already does durably. If the worker is down, the HTTP call fails and the job is lost; a DB row survives the worker being offline.
**Do this instead:** Web writes a `queued` row and returns. Worker polls. The DB is the queue.

### Anti-Pattern 3: Marking the whole campaign "sent" instead of per-row

**What people do:** Send the loop, then set `campaign.status='completed'` — with no per-recipient record.
**Why it's wrong:** A crash mid-loop leaves you unable to resume safely (you don't know who got mail), and you can't show real progress or build history. This is exactly the CLI's idempotency gap.
**Do this instead:** Materialize `send_records` up front; process only `pending`; commit each result immediately. Resume = re-run pending. Progress and history fall out for free.

### Anti-Pattern 4: Storing CSVs / attachments as SQLite blobs

**What people do:** Stuff file bytes into a BLOB column.
**Why it's wrong:** Bloats the DB file, slows WAL checkpoints, and forces the worker to load full blobs to stream an attachment.
**Do this instead:** Write files to the `/data` volume; store only the path. Both containers share the volume, so the worker reads by path.

### Anti-Pattern 5: Logging or returning decrypted SMTP passwords

**What people do:** Console-log the transport config, or return creds to the client to "show what's saved."
**Why it's wrong:** Violates the PROJECT.md security constraint; leaks BYO credentials into logs/responses.
**Do this instead:** Encrypt at rest (AES-256-GCM, key from env). Decrypt only in-memory in the worker at send time. Never log the password; never send it back to the browser (show host/user/"●●●●" only).

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| Clerk | `clerkMiddleware()` + `auth()` for `userId`; mirror id into `users` | Every query scoped by `userId`; worker jobs already carry `user_id`, so the worker needs no Clerk session |
| User's SMTP (nodemailer) | `createTransport` per campaign from decrypted creds; `verify()` before loop | Reused CLI transport; one transport per campaign run, `transport.close()` at end |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| Web ↔ Worker | **SQLite rows + shared volume only** (no direct calls) | The defining boundary; broker-free handoff |
| Web/Worker ↔ DB | Via `packages/db` exclusively | Single owner guarantees consistent pragmas + claim query |
| Web/Worker ↔ Files | Read/write `/data` by path stored in DB | Shared host volume mounted into both containers |
| Browser ↔ progress | SSE (preferred) or short polling on `send_records` | SSE works fine on a persistent VPS (no serverless timeout) |

### Docker / Coolify packaging

- **One image, two start commands** (simplest): build a single Node image; the web container runs `next start`, the worker container runs `node apps/worker`. Or two images if build deps differ.
- **`docker-compose.yml`** declares `web` and `worker` services + one **named volume mounted at `/data`** in both. Coolify deploys from this compose file. WAL requires both containers on the **same host** (shared memory) — Coolify single-VPS satisfies this; do not move `/data` to NFS.
- **Migrations** run once on startup (web entrypoint) before either service serves traffic; worker waits for the DB file to exist.
- **Redeploy safety:** Coolify restarting the worker mid-send is handled by the lease/heartbeat (Pattern 4) — the new worker re-claims the stalled campaign and resumes `pending` rows.

## Suggested Build Order (dependency-driven)

1. **`packages/db` + `packages/crypto`** — schema, WAL client, query layer, encrypt/decrypt. Everything depends on these.
2. **`packages/core`** — lift `fill`/`csv`/`send` from the CLI; generalize `fill()` to arbitrary columns. Pure, testable, no DB.
3. **Auth + onboarding + SMTP validate** — Clerk wired; `POST /api/smtp/verify` exercises `core.send` (verify) + `crypto` + `db`. First end-to-end vertical slice.
4. **CSV upload + mapping** — file write to `/data`, header parse, `recipient_sets`. Unlocks the editor.
5. **Editor + preview + save template** — autocomplete from `columns_json`; preview via `fill()`. No worker needed yet.
6. **Worker skeleton + claim loop** — poll, `BEGIN IMMEDIATE` claim, lease/heartbeat. Prove the handoff with a no-op job before wiring real sends.
7. **Live send (materialize send_records → send loop → counters)** — the idempotent/resumable core; reuses `core.send`.
8. **Progress channel (SSE) + run view** — read `send_records`; depends on (7) producing rows.
9. **Test-send** — small variant of (7) targeting one address; can land alongside it.
10. **History view** — read-only over `campaigns`/`send_records`; last because it just renders durable state.
11. **Per-row attachments** — extends (4) upload + (7) message building; deferrable without blocking a usable send.
12. **Docker/Coolify packaging** — compose with shared `/data` volume; can be stood up early for dev parity but finalized once web+worker both exist.

**Critical path:** 1 → 2 → 6/7 (the SQLite-as-queue handoff and idempotent send loop) is the riskiest, most novel part versus the CLI and should be de-risked early with the worker skeleton in step 6.

## Sources

- [better-sqlite3 performance / WAL docs](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md) — HIGH: WAL many-readers/one-writer, `busy_timeout`, checkpoint guidance
- [SQLite Write-Ahead Logging (official)](https://sqlite.org/wal.html) — HIGH: WAL requires shared memory / same host, no network FS; checkpoint behavior
- [The Write Stuff: Concurrent Write Transactions in SQLite — Oldmoe](https://oldmoe.blog/2024/07/08/the-write-stuff-concurrent-write-transactions-in-sqlite/) — MEDIUM: `BEGIN IMMEDIATE` for atomic claim, no `SKIP LOCKED`
- [A SQLite Background Job System — Jason Gorman](https://jasongorman.uk/writing/sqlite-background-job-system/) — MEDIUM: poll + atomic claim + visibility-timeout requeue pattern
- [Why I Built a Job Queue With SQLite Instead of Redis (DEV)](https://dev.to/d_security/why-i-built-a-job-queue-with-sqlite-instead-of-redis-and-what-i-learned-4f05) — LOW/MEDIUM: corroborates single-host SQLite queue tradeoffs
- Existing CLI architecture map: `.planning/codebase/ARCHITECTURE.md` — HIGH: reused `loadRecipients → fill → verify → send-loop-with-delay` core
- Project constraints: `.planning/PROJECT.md` — HIGH: stack, BYO-SMTP, scale target, deferred scope

---
*Architecture research for: BYO-SMTP CSV mail-merge web app*
*Researched: 2026-06-24*
