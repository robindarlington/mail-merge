# Stack Research

**Domain:** Self-serve BYO-SMTP CSV mail-merge web app (multi-tenant, persistent VPS via Coolify/Docker)
**Researched:** 2026-06-24
**Confidence:** HIGH for decided stack and versions; HIGH for queue/SQLite-concurrency recommendation; MEDIUM for editor choice (genuine tradeoff)

> The framework, auth, styling, DB engine, transport, and deploy target are **already decided** (see PROJECT.md Constraints). This document validates those, pins current versions, and makes prescriptive calls on the **open questions**: SQLite access layer, background queue, live progress transport, CSV parsing, credential encryption, merge-field editor, per-row attachments, and Docker packaging.

---

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Next.js (App Router) | `16.2.x` | Full-stack React app: UI, Route Handlers, Server Actions | Decided. App Router + Route Handlers/Server Actions give one codebase for UI and API. Runs as a long-lived `node server.js` on the VPS (NOT serverless) — no function-timeout constraints. |
| React | `19.2.x` | UI runtime | Pulled by Next 16. Server Components reduce client JS for the dashboard/campaign views. |
| TypeScript | `5.9.x` (pin) | Type safety across web + worker + shared merge logic | **Do NOT jump to TS 6.0** yet (see What NOT to Use). Reuses the CLI's existing types (`Recipient`, `Template`). |
| Node.js | `24.x LTS` | Runtime for web server and worker | Matches the CLI host (24.9.0). Required by nodemailer 9 and Next 16. Native `--env-file` available but use a real config loader in prod. |
| Clerk (`@clerk/nextjs`) | `7.5.x` | Auth / multi-tenant user identity | Decided. `auth()` in Route Handlers + middleware gives per-user scoping. Every DB row keys off `userId` from Clerk. |
| Tailwind CSS | `4.3.x` | Styling | Decided. v4 uses the new Oxide engine + CSS-first config (`@theme` in CSS, no `tailwind.config.js` required). shadcn/ui supports v4. |
| shadcn/ui | latest (CLI-pinned) | Component layer (forms, tables, dialogs, toasts) | Decided. Not a dependency — copies Radix-based components into the repo. Use for the SMTP onboarding form, CSV preview table, send-confirmation dialog, progress UI. |
| SQLite | (via better-sqlite3 `12.11.x`) | Single-file relational store for users' SMTP config, campaigns, recipients, send-log | Decided. Persistent VPS volume makes on-disk SQLite ideal. One file, no DB server to operate. |
| Drizzle ORM | `0.45.x` + drizzle-kit `0.31.x` | Typed SQLite access layer for BOTH web and worker | **Open-question call: use Drizzle over better-sqlite3, on top of the better-sqlite3 driver.** See "SQLite access layer" decision below. |
| nodemailer | `9.0.x` | SMTP transport (reused merge/send core) | Decided. v9 keeps the exact `createTransport` / `verify()` / `sendMail()` API the CLI already uses — migration from the CLI's v6 is effectively a no-op for this code (changes are Node-version floors + internal hardening, not API breaks). |

### The background-job decision (the most important open question)

**Recommendation: a SQLite-backed DB queue using `plainjob` (`better-sqlite3` driver), run from a separate long-lived worker process. Confidence: HIGH.**

| Library | Version | Purpose | Why |
|---------|---------|---------|-----|
| plainjob | latest (`^1`) | SQLite-backed job queue: enqueue from web, dequeue in worker | Purpose-built on `better-sqlite3`. Web enqueues a `send-campaign` job in a Route Handler; the separate worker process polls and runs it. Supports multi-process enqueue/dequeue, retries (re-queues jobs if a worker dies), delayed/cron jobs, and graceful shutdown — exactly the "simple robust DB-backed queue without heavy infra" the brief asks for. Single SQLite file, **no Redis**. |

**Why NOT the alternatives (all rejected for this project):**
- **BullMQ (`5.79.x`)** — excellent, but **requires Redis**. The brief explicitly wants the simplest robust option without heavy infra; adding a Redis container for ~100–1,000-email batches is over-provisioning. Keep as the documented upgrade path if scale grows.
- **Graphile Worker / pg-boss** — **Postgres-only**. The DB is SQLite. Not applicable.
- **Hand-rolled `setInterval` poller over a `jobs` table** — viable and only ~100 lines, but you'd re-implement leasing, retries, crash-recovery, and graceful shutdown that plainjob already gives you. Choose the hand-rolled version *only* if you want zero queue dependency and accept writing the leasing logic; otherwise plainjob is strictly less work.
- **p-queue (`9.3.x`)** — in-memory concurrency limiter, **not durable**. A process restart loses in-flight batches. Use it *inside* the worker to bound SMTP concurrency per campaign, but it is not the persistence layer.

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| papaparse | `5.5.x` | CSV parsing (browser + Node) | **Recommended CSV parser.** Handles quoted fields, embedded commas/newlines, header row → objects, streaming for large files, and runs the same in browser and worker. Fixes the CLI's naive "split at first comma" hack. Pair with `@types/papaparse`. |
| better-sqlite3 | `12.11.x` | Synchronous SQLite driver under Drizzle + plainjob | Both Drizzle and plainjob sit on this one driver/connection model. Synchronous API is a feature here: simple, fast, no callback churn. Needs native build in Docker (see Packaging). |
| zod | `4.4.x` | Runtime validation of CSV rows, SMTP onboarding form, Server Action inputs | Validate the SMTP config form and parsed CSV shape before persisting. Pairs with shadcn/ui forms. |
| p-queue | `9.3.x` | Bound concurrent SMTP sends *within* a running campaign | Inside the worker, cap simultaneous `sendMail` calls (e.g. 1–3) and keep the CLI's inter-send throttle to stay friendly with the user's SMTP. |
| pino | `10.3.x` | Structured logging in the worker (replaces CLI `console.log`) | Per-recipient send results as structured JSON; far better than the CLI's plain `console.log` for an auditable batch. |
| @inquirer/password | `5.1.x` | (Optional) only if a CLI seed/admin script is kept | Replaces the CLI's private-`readline` echo-suppression hack. Not needed by the web app itself. |

### Live send progress to the browser

**Recommendation: Server-Sent Events (SSE) via a Next.js Route Handler streaming from the campaign's send-log rows. Confidence: HIGH.**

- Progress is **one-directional** (server → browser), which is exactly SSE's model. No need for WebSocket bidirectionality.
- A long-lived Route Handler returning a `ReadableStream` works because the app is a **persistent Node server**, not serverless (serverless function timeouts would kill SSE — not a constraint here).
- The worker writes per-recipient status rows to SQLite as it sends; the SSE handler polls those rows (cheap, WAL read) and emits `progress` events. Browser uses `EventSource`.
- **Fallback / simplest option:** plain client-side polling of a `GET /api/campaigns/:id/progress` endpoint every ~1–2s. Equally robust for 100–1,000 rows, trivially debuggable, and a fine v1 if SSE wiring is deferred. **Do NOT reach for WebSockets** (`socket.io`/`ws`) — bidirectional infra is unjustified for one-way progress.

### Merge-field editor (plain-text body + column autocomplete)

**Recommendation: CodeMirror 6 with `@codemirror/autocomplete`. Confidence: MEDIUM (genuine tradeoff with a plain-textarea approach).**

| Library | Version | Purpose |
|---------|---------|---------|
| codemirror | `6.0.x` | Editor host for the plain-text body |
| @codemirror/autocomplete | `6.20.x` | `{{` → autocomplete menu of CSV column names |
| @codemirror/view / @codemirror/state | `6.x` | Core (pulled in transitively) |

**Rationale:** The body is **plain text only** — so a rich-text/HTML editor is the wrong tool. CodeMirror 6 is a plain-text-first editor with a first-class, lightweight autocompletion API. Wire a completion source that triggers on `{{` and offers the uploaded CSV's column headers, then highlight `{{token}}` spans. Output is the raw string the existing `fill()` logic already consumes.

**Alternatives:**
- **Tiptap (`@tiptap/react` 3.27.x) + `@tiptap/suggestion`** — great mention/suggestion UX, but it is a **ProseMirror rich-text** editor. You'd fight it to keep output plain text and to serialize `{{tokens}}` cleanly. Over-tooled for a plain-text body. Choose only if the product later wants rich formatting (explicitly out of scope for v1).
- **Plain `<textarea>` + a custom `{{`-triggered dropdown** — zero editor dependency, simplest possible. Viable v1 if you want to avoid CodeMirror; you implement caret tracking and the popover yourself (shadcn `Command`/`Popover` help). Pick this if minimizing dependencies beats editor polish.
- **Lexical (`0.45.x`)** — also rich-text-oriented; same mismatch as Tiptap.

### Encrypting SMTP credentials at rest

**Recommendation: Node built-in `crypto` AES-256-GCM. No third-party library. Confidence: HIGH.**

- Use `node:crypto` `createCipheriv('aes-256-gcm', key, iv)` with a random 12-byte IV per record and store `iv | authTag | ciphertext`. GCM gives authenticated encryption (tamper detection) out of the box.
- **Master key**: 32 bytes from an env var / Coolify secret (e.g. `CREDENTIAL_ENC_KEY`, base64). Never commit; never log. Carry forward the CLI's discipline of never logging `SMTP_PASS`.
- Encrypt only the SMTP password (and optionally username); store host/port/from in plaintext for display.
- **Do NOT** hand-roll with the deprecated `createCipher` (no IV), and **do NOT** pull a heavy crypto wrapper — Node core is sufficient, audited, and dependency-free. (`libsodium`/`@noble/ciphers` are fine if you prefer XChaCha20-Poly1305, but AES-GCM in core is the standard, lower-friction call here.)

### Per-row file attachments

**Recommendation: store uploaded files on the VPS volume (same persistent mount as SQLite), reference them by path/key in a DB table joined to recipient rows; nodemailer reads them at send time. Confidence: HIGH (pattern), MEDIUM (UX of row↔file mapping).**

- **Storage:** a per-campaign directory on the Docker volume, e.g. `/data/attachments/<campaignId>/<file>`. Persistent host → local disk is fine; no S3 needed for v1 (keep it as a future swap behind a small storage interface).
- **Mapping CSV rows → files:** add an attachment-reference **column in the CSV** (e.g. a `attachment` column holding a filename), and have the user upload a matching set of files (or a zip). The worker resolves `row.attachment` → a path under the campaign dir. This is the most explicit, debuggable mapping and mirrors the merge-field model.
- **Sending:** nodemailer's `attachments: [{ filename, path }]` — pass the resolved file path per recipient. Validate existence before the batch (carry forward the CLI's "verify before send" instinct).
- Enforce per-file and per-campaign size limits and an allowlist of paths under the campaign dir (prevent path traversal from CSV-supplied filenames).

### Packaging for Coolify / Docker

**Recommendation: one image, two entrypoints, one shared volume. Confidence: HIGH.**

- **Build:** Next.js `output: 'standalone'` → small `node server.js` runtime image. Multi-stage Dockerfile; rebuild `better-sqlite3` native bindings in the runtime stage (it ships prebuilds, but pin the Node version to avoid ABI mismatch).
- **Two processes from one image:**
  - Web container: `CMD ["node", "server.js"]`
  - Worker container: `CMD ["node", "worker.js"]` (a `tsx`/compiled entrypoint that boots plainjob's `defineWorker(...).start()`)
  - In Coolify, model this as a **Docker Compose** stack: two services from the same build, both mounting the same named volume at `/data`.
- **Shared volume:** one named volume mounted at `/data` in *both* services holds `app.db` (+ `-wal`/`-shm`) and `attachments/`. This is what makes web-enqueue / worker-dequeue over one SQLite file work.
- Set `HOSTNAME=0.0.0.0` for the standalone server. Pass `CREDENTIAL_ENC_KEY`, Clerk keys, and `DATABASE_PATH=/data/app.db` as Coolify secrets/env.

---

## Web + worker sharing ONE SQLite file (concurrency — required deep-dive)

This is the load-bearing architectural risk. **It works, but only with the right pragmas.** Confidence: HIGH.

**The model:** two OS processes (web `server.js`, worker `worker.js`) each open their own `better-sqlite3` connection to the *same* `/data/app.db` file on the shared volume.

**Why it's safe with WAL:**
- Enable **WAL mode** (`PRAGMA journal_mode = WAL`) once at startup in both processes. WAL lets **many readers proceed concurrently with one writer** — so the web server's SSE/progress reads never block the worker's status writes, and vice versa. WAL is the standard choice for any multi-process SQLite web app.
- SQLite still allows **only a single writer at a time** (writes are serialized). For this workload that's fine: the worker is the dominant writer (per-recipient status updates), and web writes are infrequent (create campaign, save SMTP config). They rarely collide.

**Mandatory settings (set in BOTH processes on every connection):**
- `PRAGMA journal_mode = WAL;`
- `PRAGMA busy_timeout = 5000;` — **critical.** Default busy-timeout is 0, meaning a process that hits a momentary write lock gets an instant `SQLITE_BUSY` error. Setting a few-seconds timeout makes SQLite **wait and retry** instead of failing — this is what prevents the occasional web-vs-worker write collision from surfacing as an error.
- `PRAGMA synchronous = NORMAL;` — safe with WAL, much faster.
- `PRAGMA foreign_keys = ON;`

**Operational watch-items:**
- **Checkpoint growth:** under constant reads the `-wal` file can grow ("checkpoint starvation"). better-sqlite3 auto-checkpoints, but for long-running campaigns consider an occasional `PRAGMA wal_checkpoint(TRUNCATE)` from the worker between campaigns.
- **Keep write transactions short** (the worker updates one recipient row per send) so the single-writer slot is held briefly.
- **Same volume, same host:** WAL requires shared-memory (`-shm`) coordination, which only works when all processes are on the **same machine/volume** (true here — both containers mount `/data` on one VPS). Do **not** put the SQLite file on a network filesystem.

This is exactly why a SQLite *DB-backed queue* (plainjob) fits: enqueue is one short web write, the worker dequeues and does the long work, and all coordination is the same WAL file already in use — no second datastore.

---

## Installation

```bash
# Core (web)
npm install next@^16.2 react@^19.2 react-dom@^19.2 @clerk/nextjs@^7.5

# Data layer + queue
npm install drizzle-orm@^0.45 better-sqlite3@^12.11 plainjob

# Transport + CSV + validation + concurrency + logging
npm install nodemailer@^9 papaparse@^5.5 zod@^4.4 p-queue@^9.3 pino@^10.3

# Editor (plain-text body + merge-field autocomplete)
npm install codemirror@^6 @codemirror/autocomplete@^6 @codemirror/view@^6 @codemirror/state@^6

# Dev dependencies
npm install -D typescript@~5.9 drizzle-kit@^0.31 \
  @types/node@^24 @types/better-sqlite3@^7.6 @types/papaparse@^5 @types/nodemailer@^6.4 \
  tailwindcss@^4.3 tsx@^4.22

# shadcn/ui (scaffolds components into the repo, not a runtime dep)
npx shadcn@latest init
```

> Native build note: `better-sqlite3` compiles native bindings. In Docker, install build tooling in the build stage (or rely on prebuilds) and pin Node to the runtime version to avoid ABI mismatch.

---

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| Drizzle ORM | Prisma `7.8.x` | Prisma 7 is excellent and now ships a lighter client, but Drizzle is closer to SQL, lighter to run in a separate worker, and has zero codegen daemon — better for a small two-process app. Use Prisma if the team strongly prefers its DX/migrations and accepts the heavier client in the worker. |
| Drizzle ORM | better-sqlite3 *raw* | Skip the ORM entirely if the schema stays tiny (~4 tables) and you prefer hand-written SQL. Drizzle's typed queries pay off as campaigns/recipients/send-log relations grow. |
| plainjob (SQLite queue) | BullMQ `5.79.x` + Redis | Choose BullMQ if you outgrow medium scale, need priorities/rate-limiting/repeatable jobs across many workers, and are willing to run Redis. Documented upgrade path. |
| plainjob | Hand-rolled SQLite poller | Choose if you want zero queue dependency and will write leasing/retry/shutdown yourself (~100 lines). plainjob just gives you that for free. |
| SSE progress | Client polling | Polling is simpler and just as robust at this scale; use it as the v1 default if SSE wiring is deferred. |
| CodeMirror 6 | Plain `<textarea>` + custom popover | Use the textarea approach to drop the editor dependency entirely; you implement caret/popover yourself with shadcn `Command`. |
| Node `crypto` AES-GCM | `@noble/ciphers` / libsodium | Use if you specifically want XChaCha20-Poly1305 or a vetted JS crypto lib; not necessary — Node core AES-GCM is the standard call. |
| Local volume attachments | S3 / MinIO | Move to object storage only if you need multi-node scaling or off-host durability; local volume is correct for a single VPS v1. |

---

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| Serverless / Edge function patterns | The app is a **persistent VPS host**. Serverless function timeouts would kill long SSE streams and background sends; the worker model assumes a long-lived process. | Standalone `node server.js` + separate long-lived worker container. |
| BullMQ + Redis (for v1) | Adds a Redis container and ops burden for 100–1,000-email batches. Over-infra for the stated scale. | plainjob (SQLite-backed). Keep BullMQ as the scale-up path. |
| Graphile Worker / pg-boss | **Postgres-only.** The database is SQLite. | plainjob. |
| HTML-email tooling (react-email, mjml, Tiptap-as-HTML) | Body is **plain text only** (explicit out-of-scope). HTML email tooling is wasted complexity. | CodeMirror 6 plain-text editor for token insertion + a plain-text preview. |
| Tiptap / Lexical / ProseMirror as the body editor | Rich-text engines fight a plain-text-only requirement and complicate `{{token}}` serialization. | CodeMirror 6 (plain-text-first) or a textarea + custom autocomplete. |
| Deprecated `crypto.createCipher` (no IV) | Insecure (no IV, weak key derivation), deprecated in Node. | `crypto.createCipheriv('aes-256-gcm', key, iv)` with random IV + auth tag. |
| WebSockets (socket.io / ws) for progress | Progress is one-directional server→browser; bidirectional infra is unjustified complexity. | SSE (`EventSource`) or plain polling. |
| TypeScript 6.0 (just released) | Brand-new major; toolchain (Next, drizzle-kit, type defs) ecosystem still settling. | Pin TypeScript `~5.9` for v1; revisit 6.x after the ecosystem catches up. |
| SQLite file on a network/NFS volume | WAL's `-shm` shared-memory coordination requires a local filesystem; NFS causes corruption/locking failures. | A local Docker named volume on the same VPS host, mounted by both containers. |
| The CLI's naive "split at first comma" CSV parsing | Breaks on quoted fields, embedded commas/newlines, BOM. | papaparse with header mode. |
| The CLI's private `readline._writeToOutput` echo hack | Undocumented Node internal; the web app doesn't need terminal prompts anyway. | Web form for SMTP creds (Clerk-gated); `@inquirer/password` only if a CLI admin script remains. |

---

## Stack Patterns by Variant

**If you want the absolute minimum-dependency v1:**
- Use raw better-sqlite3 + a hand-rolled SQLite poller + a plain `<textarea>` + client polling for progress.
- Because: removes Drizzle, plainjob, CodeMirror, and SSE wiring. More hand-written code, fewer deps. Reasonable for a first cut.

**If you expect to grow past ~1,000-email batches or add multiple workers:**
- Swap plainjob → BullMQ + a Redis container; keep the same worker entrypoint shape.
- Because: BullMQ's rate-limiting, priorities, and multi-worker coordination scale further than a single-writer SQLite queue.

**If rich-text email becomes in-scope later (currently out of scope):**
- Swap CodeMirror → Tiptap + `@tiptap/suggestion`; add react-email/mjml for rendering.
- Because: at that point you need a rich-text model and HTML output, which CodeMirror isn't for.

---

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| next@16.2 | react@19.2 / react-dom@19.2 | Next 16 requires React 19. |
| next@16.2 | node@24 LTS | Next 16 dropped older Node; use 24 LTS (matches CLI host). |
| @clerk/nextjs@7.5 | next@16 App Router | Use middleware + `auth()` in Route Handlers/Server Actions. |
| tailwindcss@4.3 | shadcn/ui (latest) | shadcn supports Tailwind v4; init scaffolds v4-compatible components. CSS-first config (`@theme`), no JS config file required. |
| drizzle-orm@0.45 | better-sqlite3@12.11 | Drizzle's `better-sqlite3` driver adapter; run `drizzle-kit@0.31` for migrations. |
| plainjob | better-sqlite3@12.11 | Shares the same driver; can share or use a sibling connection to the same WAL file. |
| nodemailer@9 | node@24 | v9 raised the Node floor and hardened internals; `createTransport`/`verify`/`sendMail` API used by the CLI is unchanged — drop-in for the reused logic. |
| typescript@5.9 | next@16 / drizzle-kit@0.31 | Stay on 5.9; avoid TS 6.0 until toolchain settles. |
| better-sqlite3 native build | node@24 ABI | Pin the Node version across Docker build + runtime stages to avoid native ABI mismatch. |

---

## Sources

- npm registry (`npm view <pkg> version`, 2026-06-24) — current versions for next (16.2.9), react (19.2.7), @clerk/nextjs (7.5.8), tailwindcss (4.3.1), drizzle-orm (0.45.2), drizzle-kit (0.31.10), better-sqlite3 (12.11.1), nodemailer (9.0.1), papaparse (5.5.4), zod (4.4.3), p-queue (9.3.0), pino (10.3.1), codemirror (6.0.2), @codemirror/autocomplete (6.20.3), bullmq (5.79.1), prisma (7.8.0), tiptap/@tiptap/react (3.27.1), typescript (6.0.3 latest / 5.9 recommended), tsx (4.22.4). **HIGH confidence.**
- better-sqlite3 performance/WAL docs + SQLite WAL spec (sqlite.org/wal.html) — WAL multi-reader/single-writer model, `busy_timeout` necessity, checkpoint starvation. **HIGH confidence.**
- plainjob (github.com/justplainstuff/plainjob) — SQLite-backed queue on better-sqlite3, multi-process enqueue/dequeue, retries, scheduling, graceful shutdown. **HIGH confidence** (verified API via repo).
- Next.js standalone output + Coolify deploy guides (nextjs.org/docs, coolify.io/docs) — `output: 'standalone'`, `node server.js`, `HOSTNAME=0.0.0.0`, Compose for multi-service + shared volume. **MEDIUM-HIGH confidence** (multi-entrypoint/shared-volume pattern is general Docker, not a single official Coolify doc).
- nodemailer CHANGELOG (github.com/nodemailer/nodemailer) — v6→v9 keeps `createTransport`/`verify`/`sendMail` API; changes are Node floor + internal. **MEDIUM-HIGH confidence.**
- Existing CLI map (`.planning/codebase/STACK.md`, `ARCHITECTURE.md`) — reused merge/send logic, nodemailer usage, anti-patterns to fix (CSV split, readline hack, hard-coded path). **HIGH confidence.**

---
*Stack research for: BYO-SMTP CSV mail-merge web app (Next.js + SQLite + persistent worker on Coolify/VPS)*
*Researched: 2026-06-24*
