# Pitfalls Research

**Domain:** Self-serve, multi-tenant, BYO-SMTP CSV mail-merge web app (Next.js + Clerk + SQLite + persistent Node worker, Coolify/Docker on a VPS)
**Researched:** 2026-06-24
**Confidence:** HIGH on SQLite concurrency, nodemailer TLS/pooling, and credential-encryption mechanics (verified against better-sqlite3 and Nodemailer official docs via Context7). MEDIUM on deliverability/rate-limit specifics (BYO-SMTP varies by provider) and Coolify graceful-shutdown behavior (community-verified, version-dependent).

Many of these carry directly forward from the existing CLI's known issues (`.planning/codebase/CONCERNS.md`): no idempotency/resume, `secure` inferred from `port===465`, no confirm-before-send, plaintext credentials, no input validation, no audit trail.

---

## Critical Pitfalls

### Pitfall 1: SMTP credentials stored in plaintext (or "encrypted" but recoverable in practice)

**What goes wrong:**
User SMTP passwords are written to SQLite as plaintext, or "encrypted" with a key that lives next to the database (same volume, same `.env`, or hardcoded). A database leak, backup copy, or volume snapshot then exposes every tenant's mail credentials in bulk — which often double as the credentials to the user's whole mailbox (Gmail/Outlook app passwords, provider master creds).

**Why it happens:**
The CLI stored the password in `process.env`/`.env` (CONCERNS.md), so the web app inherits a "it's just a config value" mindset. Teams reach for base64 or a reversible scheme and call it encryption, or store the AES key in the same place as the ciphertext, which provides no real protection against the realistic threat (DB/volume exfiltration).

**How to avoid:**
- Encrypt with authenticated symmetric encryption: AES-256-GCM via Node's `crypto`, storing `{iv, authTag, ciphertext}` per credential. Never ECB, never a homemade XOR/base64 scheme.
- Keep the master key OUT of the database and OUT of the app's bundled code. Inject via a runtime secret (Coolify env var / Docker secret) that is not on the same logical artifact as the DB volume. Document a key-rotation path (versioned keys: store a `key_id` alongside each ciphertext).
- Decrypt only in the worker process at send time; never decrypt in the Next.js request path unless strictly needed (e.g. the onboarding `verify()` call).
- Consider storing only what's needed and treating the password as write-only from the UI (you can re-enter but never read it back).

**Warning signs:**
A `SELECT smtp_pass FROM ...` returns readable text. The decryption key is grep-able in the repo or appears in the same `.env` that's committed to the deploy. No `authTag` column (means no integrity, likely not GCM).

**Phase to address:**
Onboarding / SMTP-credential phase (the phase that first persists credentials). Block any later phase from reading credentials in plaintext.

---

### Pitfall 2: SMTP secrets leaking into logs, error traces, or client responses

**What goes wrong:**
The SMTP password (or full transport config) ends up in application logs, Nodemailer debug output, an unhandled-error stack trace, a Sentry/console breadcrumb, or a JSON API response sent to the browser. Logs are typically far less protected than the DB and are often shipped to third parties.

**Why it happens:**
Nodemailer's `logger: true` / `debug: true` and verbose error objects can echo connection config. Developers `console.log(transportConfig)` while debugging onboarding and forget to remove it. Next.js server actions/route handlers serialize an error object containing `auth.pass` straight back to the client. The CLI already had no log hygiene around `SMTP_PASS` (CONCERNS.md).

**How to avoid:**
- Centralize a `redact()` helper; never log the transport object or `auth`. Maintain a denylist of keys (`pass`, `password`, `smtp_pass`, `authorization`).
- Keep Nodemailer `debug`/`logger` off in production; if needed, pipe through a redacting logger.
- On the client boundary, return typed error codes (see Nodemailer codes: `EAUTH`, `ETIMEDOUT`, `ECONNECTION`, `ETLS`) and human messages — never the raw `err`.
- Add a test that asserts the password string never appears in serialized error/log output.

**Warning signs:**
Searching logs for a known test password finds hits. Onboarding failures show a stack trace in the browser network tab. Error responses include `config` or `auth` fields.

**Phase to address:**
Cross-cutting; establish logging/error conventions in the foundation phase, enforce in onboarding and worker phases.

---

### Pitfall 3: `secure` flag inferred from port — wrong TLS mode → onboarding false negatives/positives

**What goes wrong:**
The CLI sets `secure: port === 465` (CONCERNS.md). Carried forward, this misconfigures real-world servers: a server on port 465 that actually wants STARTTLS fails; a server using implicit TLS on a non-465 port fails; and providers like Office365/Gmail expect `secure:false` + STARTTLS on 587. Users get "your SMTP doesn't work" during onboarding when their server is fine — or the connection silently succeeds in a weaker mode than intended.

**Why it happens:**
Port→security inference is a common shortcut and is "usually right" for 465/587, which masks the edge cases until a real user hits them. Per Nodemailer docs: `secure:true` = implicit TLS from the start (port 465 convention); `secure:false` = plaintext start that upgrades via STARTTLS (587 convention). These are conventions, not guarantees.

**How to avoid:**
- Store an explicit `secure` boolean (and optionally `requireTLS`) per user; don't infer it. Default sensibly from port but let the user override, and surface the choice during onboarding.
- For `secure:false`, set `requireTLS: true` so a server that *can't* do STARTTLS is rejected rather than silently sending in cleartext (deliverability + security).
- During onboarding, if `verify()` fails on the inferred mode, automatically retry the alternate mode and report which one worked, rather than a flat failure.

**Warning signs:**
Onboarding rejects credentials that work in a standalone mail client. Logs show `ETLS`/`ESOCKET`/wrong-version-number TLS errors. Office365/Gmail users can't onboard.

**Phase to address:**
SMTP onboarding/validation phase.

---

### Pitfall 4: SMTP validation that hangs, false-positives, or blocks the request thread

**What goes wrong:**
`transport.verify()` at onboarding hangs for 30–120s on an unreachable host (no timeout), making onboarding feel broken; or it passes `verify()` but later sends fail (verify checks connect+auth, not send/relay permissions, recipient acceptance, or rate posture); or a slow verify ties up a Next.js server-action worker.

**Why it happens:**
Nodemailer's default connection/greeting timeouts are generous, and a typo'd host or a firewalled port stalls until socket timeout. `verify()` is necessary but not sufficient — it does not prove the server will accept the user's intended `From`, won't rate-limit, or won't quarantine.

**How to avoid:**
- Set explicit short timeouts for onboarding verify: `connectionTimeout` (e.g. 8–10s), `greetingTimeout`, `socketTimeout`. Treat timeout as a distinct, actionable error ("couldn't reach host:port — check firewall/port").
- Do verification off the hot path or with a hard wall-clock cap; show a spinner with a cancel.
- Treat `verify()` as necessary-not-sufficient: also send a real test email to the user's own address as part of onboarding (the CLI already had a test-send concept — reuse it).
- Map Nodemailer error codes to friendly guidance: `EAUTH`→wrong user/pass or app-password needed; `ETIMEDOUT`/`ECONNECTION`→host/port/firewall; `ETLS`→secure/STARTTLS mismatch (ties to Pitfall 3).

**Warning signs:**
Onboarding requests take 30s+ or time out at the proxy. Users report "it said connected but no email arrived." Verify passes but first real campaign 100% fails with `EAUTH`/relay-denied.

**Phase to address:**
SMTP onboarding/validation phase.

---

### Pitfall 5: "database is locked" — web + worker contending on one SQLite file

**What goes wrong:**
Two processes (Next.js server and the persistent worker) open the same SQLite file. Under concurrent writes you get `SQLITE_BUSY` / "database is locked" errors, which surface as random campaign-write failures, lost progress updates, or 500s in the UI — intermittent and hard to reproduce.

**Why it happens:**
Default rollback-journal mode permits only one writer and blocks readers during writes; with two processes this collides constantly. Teams test with a single process locally and only hit it once the worker runs alongside the web app in production. (Confirmed via better-sqlite3 docs: concurrent read+write is "a common bottleneck"; WAL is the recommended fix.)

**How to avoid:**
- Enable WAL on every connection: `db.pragma('journal_mode = WAL')`. WAL lets readers and a writer proceed concurrently (still single-writer, but readers don't block).
- Set a busy timeout so a blocked writer waits instead of throwing: better-sqlite3's constructor `timeout` option (default 5000ms) — keep or raise it. (`PRAGMA busy_timeout` for the raw driver.)
- Keep writes short and serialized in the worker; batch progress updates (see Pitfall 6) rather than one write per recipient hammering the file.
- Both processes must share the *same* file on the *same* volume (no NFS/networked FS — SQLite locking is unreliable over network filesystems).
- Monitor WAL file growth; trigger `wal_checkpoint(RESTART)` if `db-wal` exceeds a threshold (better-sqlite3 docs call out "checkpoint starvation" specifically for multi-process access).

**Warning signs:**
Intermittent `SQLITE_BUSY`/"database is locked" in logs. A growing `*.db-wal` file that never shrinks. Progress bar stalls or jumps. Errors appear only when a campaign is actively sending (worker writing) while the user refreshes (web reading).

**Phase to address:**
Foundation/data-layer phase (set WAL + busy_timeout once, centrally). Re-verify in the background-worker phase under real concurrency.

---

### Pitfall 6: No idempotency / duplicate sends on crash, retry, or double-click

**What goes wrong:**
The worker crashes (or the container restarts mid-batch), and on restart the job re-runs from the top, re-emailing everyone already contacted — exactly the CLI's documented failure (CONCERNS.md: "Re-running re-sends to all recipients"). Or the user double-clicks "Send," or the job system retries a "failed" job that actually succeeded, producing duplicates. For real recipients this is a credibility-damaging, irreversible mistake.

**Why it happens:**
Progress is tracked in memory, not persisted per-recipient before the send. Without a per-recipient state row written transactionally, there's no way to know who already received the email after a crash. "At-least-once" job systems retry, and naive code re-sends.

**How to avoid:**
- Persist a per-recipient row with a status state machine (`pending → sending → sent|failed`) and a unique idempotency key per (campaign, recipient). Mark `sent` immediately after a successful `sendMail` — and design so that re-running only processes rows still `pending`/`failed`.
- On worker startup/resume, never restart a campaign from row 0 — query for un-sent rows only.
- Make the send loop resumable: claim → send → record outcome, one recipient at a time, so a crash loses at most one in-flight send (and you record `sending` first so you can detect "unknown" in-flight rows and either resume-safely or flag for manual review rather than blind re-send).
- Guard the API: dedupe the "start send" action (a campaign can only transition `draft → sending` once); ignore double submits.
- Accept the inherent at-least-once reality of SMTP (a crash *after* the server accepted but *before* you recorded `sent` can duplicate one message) — minimize the window and record `sending` first so it's one message, not the whole batch.

**Warning signs:**
A recipient reports receiving the same email twice. Restarting the worker resends. No per-recipient status table — only a campaign-level "done/not done" flag. Job retries are enabled with no idempotency key.

**Phase to address:**
Background-send / campaign-persistence phase. This is the single highest-stakes correctness pitfall — design the per-recipient state machine before writing the send loop.

---

### Pitfall 7: Job claiming race — two workers (or a restarted worker) grab the same job/recipient

**What goes wrong:**
If you ever run more than one worker, or a worker restarts while an old one is still draining, two processes claim the same campaign or recipient rows and send twice. Even single-worker, a restart during shutdown can overlap with the new instance.

**Why it happens:**
Naive "find pending job, then update it" has a read-then-write gap. With SQLite + multiple processes this is a classic race. Coolify/Docker restarts can briefly run old+new containers concurrently.

**How to avoid:**
- Claim atomically: a single `UPDATE ... SET status='sending', worker_id=?, claimed_at=? WHERE id=? AND status='pending'` and check `changes === 1` to confirm *you* won the claim. SQLite's single-writer guarantee makes this atomic.
- Add a lease/heartbeat (`claimed_at`) so a crashed claim can be reclaimed after a timeout — but reclaim into a "needs review" state, not blind resend (ties to Pitfall 6).
- For v1, intentionally constrain to a single worker process and document it; if Redis/BullMQ is added later, it provides atomic claiming out of the box.

**Warning signs:**
Duplicate sends correlated with deploys/restarts. Two `worker_id`s on the same recipient row. Logs show two "starting campaign X" within seconds.

**Phase to address:**
Background-worker phase; revisit if/when scaling beyond one worker.

---

### Pitfall 8: Graceful shutdown ignored — Coolify/Docker kills the worker mid-batch

**What goes wrong:**
A deploy or restart sends `SIGTERM`; the worker doesn't handle it, Docker waits ~10s then `SIGKILL`s it mid-send. In-flight state is lost, a recipient may be half-processed, the SMTP connection is dropped uncleanly, and (without Pitfall 6's per-recipient persistence) the resumed job may duplicate or skip.

**Why it happens:**
Default Node processes don't trap `SIGTERM`. Docker's default stop grace period (~10s) is short for a batch that throttles between sends. Coolify redeploys restart the container by design. Teams test the happy path and never test "deploy while sending."

**How to avoid:**
- Trap `SIGTERM`/`SIGINT` in the worker: stop claiming new recipients, finish (or cleanly abandon-and-record) the current in-flight send, flush DB writes, close the Nodemailer transport/pool, then exit 0.
- Raise Docker's `stop_grace_period` (compose) / Coolify stop timeout to comfortably exceed one inter-send delay + one send.
- Rely on Pitfall 6's resumability so even an ungraceful kill is recoverable without duplicates.
- Ensure the worker is PID 1 or run with an init (`tini`/`docker --init`) so signals actually reach Node (a shell-wrapped CMD can swallow `SIGTERM`).

**Warning signs:**
After every deploy, the active campaign shows a gap or duplicate. Worker logs end abruptly with no "shutting down" message. `docker stop` always takes the full grace period then force-kills.

**Phase to address:**
Background-worker phase + deployment/Coolify phase (jointly).

---

### Pitfall 9: SQLite volume not persisted — data lost on redeploy

**What goes wrong:**
The SQLite file (and the `*.db-wal`/`*.db-shm` sidecars, and uploaded attachments) live inside the container's writable layer instead of a named volume. A Coolify redeploy or `docker compose up` with a fresh image wipes every user's campaigns, credentials, and history.

**Why it happens:**
Easy to forget that containers are ephemeral; works fine until the first redeploy. The WAL/SHM sidecar files are easy to overlook — persisting only `app.db` but not its WAL can corrupt on restart.

**How to avoid:**
- Mount a named Docker volume / Coolify persistent volume for the entire SQLite directory (so `.db`, `.db-wal`, `.db-shm` all persist together) and for the attachment storage directory.
- Both web and worker containers must mount the *same* volume at the *same* path (and it must be local disk, not networked — see Pitfall 5).
- Back up the volume; for SQLite use the online backup API or `VACUUM INTO` rather than copying a live WAL'd file.
- Verify persistence explicitly: create data → redeploy → confirm data survives, as an acceptance check.

**Warning signs:**
Data disappears after a deploy. `docker inspect` shows no volume mount for the DB path. Only `app.db` is in the volume, not its WAL sidecars. Web and worker point at different paths.

**Phase to address:**
Deployment/Coolify phase; data-layer phase defines the on-disk layout.

---

### Pitfall 10: Per-row attachment path traversal & arbitrary file read

**What goes wrong:**
The CSV references an attachment per row (a filename or path). If the app resolves that value against the filesystem without sanitizing, a crafted value (`../../etc/passwd`, absolute path, or a path pointing at another tenant's upload) reads files it shouldn't and attaches them to outgoing mail — cross-tenant data exfiltration or server-file leakage.

**Why it happens:**
Mail-merge attachments naturally come from user-controlled CSV cells. Developers `path.join(uploadsDir, row.attachment)` assuming the value is a bare filename, but `join` happily resolves `..`. Nodemailer's `attachments[].path` will read whatever path you give it.

**How to avoid:**
- Never let a CSV cell name a server path directly. Attachments should be *uploaded* and referenced by an opaque ID that maps (in the DB, scoped to the tenant) to a stored file — the CSV value indexes a per-campaign upload set, not a filesystem path.
- If you must resolve names: `path.resolve` then assert the result `startsWith(tenantUploadDir + sep)`; reject otherwise. Strip directory components; allow a strict filename charset.
- Store uploads under a per-tenant (and ideally per-campaign) directory; the resolver can only ever look inside the current tenant's scope.
- Prefer attaching by `content` (Buffer) from a validated store over `path` to avoid filesystem reads entirely.

**Warning signs:**
Attachment field accepts `/` or `..` without rejection. A campaign can attach a file uploaded by another user. `attachments[].path` is built from raw CSV input.

**Phase to address:**
Attachment-handling phase (depends on multi-tenant isolation foundations, Pitfall 13).

---

### Pitfall 11: Attachment storage — unbounded size, total-message limits, and no cleanup

**What goes wrong:**
Large attachments cause OOM (loaded into memory) or get rejected by the SMTP server (most cap message size at ~10–25MB *including* base64 overhead, which inflates by ~33%). Disk fills with orphaned uploads from abandoned/deleted campaigns. A 100-row campaign with a 5MB attachment each is fine to store but each *message* must stay under the provider limit.

**Why it happens:**
No per-file and per-message size caps. Base64 encoding overhead is forgotten when reasoning about the provider's MB limit. No lifecycle policy ties uploaded files to campaign deletion, so storage leaks indefinitely on a small VPS disk.

**How to avoid:**
- Enforce per-file and per-message size limits at upload time; reject early with a clear error. Budget for the ~33% base64 inflation when comparing to the provider's stated max.
- Stream attachments from disk rather than buffering all in memory; cap concurrent sends to bound memory.
- Implement cleanup: delete attachment files when a campaign is deleted, and run a periodic sweep for orphans (uploads with no referencing campaign). Monitor VPS disk usage.
- Validate declared MIME/extension; don't trust the CSV-provided filename for content type.

**Warning signs:**
Worker memory spikes on big attachments. SMTP returns "message too large" / `552`. Disk usage climbs steadily; `du` on the uploads dir exceeds active campaigns' footprint. Deleting a campaign leaves files behind.

**Phase to address:**
Attachment-handling phase; disk monitoring in deployment phase.

---

### Pitfall 12: CSV parsing edge cases — encodings, quoting, and formula injection

**What goes wrong:**
- **Encoding:** A UTF-8 BOM (the invisible U+FEFF byte some editors prepend to a file) gets glued onto the first header, so the parsed header is "\uFEFFemail" rather than "email" and {{email}} never matches. Non-UTF-8 (Windows-1252/Latin-1) files mangle accented names. CRLF vs LF splits rows wrong.
- **Quoting:** Naive `split(',')` breaks on quoted fields containing commas, embedded newlines, or escaped quotes — shifting every column and merging the wrong data into the wrong field (e.g. sending Person A's content to Person B).
- **CSV injection:** A cell starting with `=`, `+`, `-`, `@`, tab, or CR is a formula-injection payload if the campaign log is ever exported to CSV and opened in Excel.

**Why it happens:**
The existing CLI uses a hand-rolled reader with no quoted-field/encoding handling (CONCERNS.md flags "trailing commas, quoted fields, Windows line endings" as untested). Mail-merge data is messy real-world spreadsheet exports. Mis-parsing is *silent* — it produces a plausible-looking but wrong merge.

**How to avoid:**
- Use a battle-tested parser (e.g. `papaparse` / `csv-parse`) with proper RFC 4180 quoting, configurable delimiter, and newline handling. Do not hand-roll.
- Strip the UTF-8 BOM; detect/declare encoding and transcode to UTF-8. Reject or warn on undecodable bytes rather than silently mangling.
- Show the parsed result in the preview (header detection + first rows) so the user *sees* a misparse before sending — make the preview a real safety gate, not decoration.
- Validate every recipient email at load time (the CLI lacked this — CONCERNS.md); reject/flag malformed addresses before any SMTP connection.
- If exporting campaign history to CSV later, prefix risky leading characters to neutralize formula injection.

**Warning signs:**
Merge fields render literally (`{{email}}`) because the header has a hidden BOM. Names with accents show mojibake. A row with a comma-in-quotes shifts columns. Preview "looks fine" but a specific row is wrong.

**Phase to address:**
CSV-upload/parsing phase and preview phase (preview is the human safety net).

---

### Pitfall 13: Broken multi-tenant isolation with Clerk — IDOR across users' data

**What goes wrong:**
A query fetches a campaign/CSV/credential/attachment by ID without also filtering by the authenticated user's Clerk ID, so user A can read or send user B's campaign by guessing/iterating an ID. Or the worker, running outside the request context, sends with the wrong tenant's SMTP credentials.

**Why it happens:**
Clerk authenticates ("who are you") but does not authorize ("can you touch *this row*"). Developers trust the signed-in session and forget the per-row ownership check. The background worker has no Clerk session at all, so tenant scoping must be carried in the job/data, not derived from a request.

**How to avoid:**
- Every data access is scoped by `owner_user_id = auth().userId` (server-side, from Clerk's verified session) — enforce in a data-access layer, not ad hoc per route.
- Store `owner_user_id` on every tenant-owned row (campaigns, recipients, credentials, attachments) and filter on it for *reads and writes*, including deletes.
- The worker derives the tenant from the campaign row's `owner_user_id` and loads *that* user's credentials — never an ambient/global SMTP config.
- Verify the Clerk session server-side on every request (middleware + per-action check); never trust a client-supplied user ID.
- Test cross-tenant access explicitly: as user A, attempt to fetch/start user B's campaign by ID → must 404/403.

**Warning signs:**
Any query by primary key without an owner filter. A route accepts a `userId`/`campaignId` from the client and uses it directly. The worker reads SMTP creds from env/global rather than per-campaign owner. No automated cross-tenant access test.

**Phase to address:**
Auth/foundation phase (define the tenant-scoping convention) and every feature phase (apply it). This underpins Pitfalls 1 and 10.

---

### Pitfall 14: BYO-SMTP rate limits & deliverability — the user's provider throttles or blocks the batch

**What goes wrong:**
Even at 100–1,000 recipients, the user's own provider enforces sending caps and rate limits (e.g. Gmail/Workspace daily caps; many SMTP relays throttle per-minute). Sending too fast triggers `421`/`454` "too many connections/rate exceeded," temporary blocks, or silent deferral. Opening too many pooled connections, or reusing one connection for the whole batch, can both backfire. Plain-text mail from a misconfigured domain (no SPF/DKIM alignment on the user's side) lands in spam — and the app can't fix the user's DNS.

**Why it happens:**
The app sends as fast as it can; the CLI's fixed 3s delay (CONCERNS.md) was a crude friendliness measure, not provider-aware. BYO-SMTP means every user's limits differ and are unknown to the app. Deliverability depends on the *user's* domain reputation/SPF/DKIM, which is outside the app's control but inside the user's expectations.

**How to avoid:**
- Throttle conservatively and make it configurable per user/campaign (carry forward the inter-send delay, but expose it). Default to a gentle rate.
- Use Nodemailer pooling with sane bounds (`pool:true`, `maxConnections`, `maxMessages`, and `rateDelta`/`rateLimit`) rather than one connection per message *or* one connection forever. Reuse one transporter per campaign.
- Treat `4xx` SMTP responses as *retryable with backoff* (deferral), `5xx` as permanent failures — don't hammer on a `421`.
- Detect provider hints (e.g. Gmail host) and warn about known daily caps; set expectations that deliverability/SPF/DKIM is the sender's responsibility (already Out of Scope in PROJECT.md — surface it in UI/onboarding).
- Record per-recipient SMTP response so users can see deferrals/bounces, not just "sent."

**Warning signs:**
A batch fails partway with `421`/`454`/temporary blocks. Provider temporarily suspends the account after a campaign. Recipients report mail in spam. "Sent" count is high but actual inbox delivery is low.

**Phase to address:**
Background-send phase (throttling/pooling/backoff); onboarding phase (set deliverability expectations).

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Store SMTP password reversible/plaintext | Skip crypto plumbing | Bulk credential leak on any DB/volume copy; trust-destroying | **Never** |
| Infer `secure` from `port===465` | One less onboarding field | Office365/Gmail/non-standard servers fail or send weaker TLS | Never — store explicit `secure` |
| Track progress in memory only | Simple loop, no schema | Crash/restart = duplicate or lost sends; no resume; no history | Never (history + idempotency are core requirements) |
| Single worker, no atomic claim | Avoid queue infra | Breaks the instant a second worker or overlapping restart appears | MVP only, if single-worker is enforced *and documented* and claims are still atomic |
| Hand-rolled CSV split | No dependency | Silent misparse → wrong person gets wrong data | Never — use a real parser |
| Default Docker stop grace + no SIGTERM handler | Less code | Every deploy can corrupt/duplicate an in-flight batch | Never for a sending worker |
| CSV cell as attachment path | Trivial mapping | Path traversal / cross-tenant file read | Never — use opaque upload IDs |
| `rejectUnauthorized:false` for TLS | Makes flaky servers "work" | MITM exposure of credentials + mail | Only as an explicit, per-user, clearly-labeled opt-in for self-signed internal servers |
| No per-message size cap on attachments | Faster to ship | OOM + provider `552` rejections mid-batch | Never — cap at upload |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Nodemailer TLS | `secure: port===465`; trusting verify() as proof of working sending | Explicit `secure`+`requireTLS`; verify() *and* a real test-send; map error codes (`EAUTH`/`ETIMEDOUT`/`ETLS`) to guidance |
| Nodemailer sending | New transporter per message, or one connection for an entire batch | One pooled transporter per campaign with `maxConnections`/`maxMessages`/`rateDelta` |
| better-sqlite3 (2 processes) | Default journal mode → "database is locked" | `journal_mode=WAL` + `busy_timeout`/constructor `timeout`; same local volume; checkpoint monitoring |
| Clerk | Authenticate but not authorize; worker has no session | Per-row `owner_user_id` checks in a data layer; worker scopes tenant from the campaign row |
| Coolify/Docker | DB in container layer; default stop grace; CMD swallows signals | Persistent volume for `.db`+WAL+SHM+uploads; raised stop timeout; init/PID-1 so `SIGTERM` reaches Node |
| CSV parser | `split(',')`, ignore BOM/encoding | RFC-4180 parser, BOM strip, encoding detection, preview as safety gate |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| One progress-row write per recipient under WAL contention | UI stalls; `SQLITE_BUSY`; growing WAL | Batch/debounce progress writes; keep worker writes short | Noticeable when web reads collide with worker writes during any active campaign |
| Whole CSV + all attachments loaded into memory | Worker RSS spikes; OOM kill | Stream rows; stream attachments from disk; bound concurrency | Large CSVs or several MB-scale attachments (well within the 100–1,000 target) |
| Sending as fast as possible | Provider `421`/`454`, temp blocks | Per-campaign throttle + pooled rate limit + backoff on 4xx | Often *below* 1,000 depending on the user's provider caps |
| WAL never checkpointed (multi-process) | `*.db-wal` grows unbounded; slow reads | Monitor WAL size; `wal_checkpoint(RESTART)` on threshold | Long-lived processes with continuous reads (the worker + web) |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Plaintext / reversible-with-colocated-key credentials | Bulk SMTP/mailbox credential theft | AES-256-GCM; master key injected at runtime, separate from DB volume; key rotation via `key_id` |
| Secrets in logs/errors/client responses | Credential leakage via observability/UI | Redacting logger; Nodemailer debug off; typed error codes to client; test that password never serializes |
| CSV-cell-controlled attachment path | Path traversal / cross-tenant file read | Opaque upload IDs scoped per tenant; `resolve`+`startsWith` boundary check; attach by validated content |
| Missing per-row ownership checks (Clerk) | IDOR: read/send another user's campaign | `owner_user_id` filter on every read/write/delete; cross-tenant access test |
| `rejectUnauthorized:false` by default | MITM on SMTP, credential+mail exposure | Default strict TLS; opt-in only for labeled self-signed internal servers |
| No email validation before send | Injection-y `to` values, wasted SMTP errors | Validate addresses at CSV load; reject/flag before connecting |
| CSV-export formula injection | Payload runs when user opens export in Excel | Prefix leading `= + - @`/tab/CR on export |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| No confirm-before-live-send (CLI gap) | One misclick blasts real recipients irreversibly | Explicit confirm showing recipient count + first/sample recipient + subject; require it to go live |
| Preview that doesn't reflect real parsing/merge | User trusts it, sends wrong data to wrong people | Preview from the *actual* parser output; show merged sample rows + any unmatched `{{fields}}` |
| Onboarding "connected!" but mail never arrives | User loses trust before first campaign | verify() *plus* a real test-send to the user's own inbox as the success criterion |
| Silent partial failures | User thinks 1,000 sent; 300 deferred/bounced | Per-recipient status with SMTP response; clear sent/failed/deferred breakdown |
| Unmatched merge fields render literally | Recipients receive `{{firstName}}` | Detect template fields not present in CSV headers; warn before send |
| No progress / can't tell if a long batch is alive | User refreshes, double-sends, or kills it | Live per-recipient progress backed by persisted state; resumable view |

## "Looks Done But Isn't" Checklist

- [ ] **SMTP onboarding:** Often missing alternate-mode retry and timeouts — verify Office365 (587/STARTTLS) *and* an implicit-TLS 465 server both onboard, and that an unreachable host fails fast (<10s) with a clear message.
- [ ] **Credential storage:** Often missing real at-rest protection — verify ciphertext is AES-GCM with `authTag`, the key is not in the DB/repo, and the password can't be read back to the client.
- [ ] **Background send:** Often missing crash-resume — verify killing the worker mid-batch and restarting resumes *only un-sent* rows with zero duplicates.
- [ ] **Duplicate prevention:** Often missing double-submit + retry guards — verify double-clicking "Send" and a job retry both produce no extra emails.
- [ ] **SQLite concurrency:** Often missing WAL/busy_timeout — verify a campaign sends (worker writing) while the UI is refreshed (web reading) with no `SQLITE_BUSY`.
- [ ] **Graceful shutdown:** Often missing SIGTERM handling/init — verify a deploy *during* an active send doesn't lose/duplicate, and the worker logs a clean shutdown.
- [ ] **Volume persistence:** Often missing WAL/SHM + uploads in the volume — verify data (incl. attachments) survives a redeploy, and web+worker share the same path.
- [ ] **Attachments:** Often missing traversal + size guards — verify `../` and absolute paths are rejected, cross-tenant files are unreachable, and oversize files are rejected at upload.
- [ ] **CSV parsing:** Often missing BOM/encoding/quoting — verify a BOM'd, Windows-1252, quoted-comma, embedded-newline CSV parses correctly and the preview shows it.
- [ ] **Multi-tenant isolation:** Often missing per-row checks — verify user A cannot fetch/start/delete user B's campaign by ID.
- [ ] **Secret hygiene:** Often missing redaction — verify a known test password appears in no log line and no client error response.

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Duplicate sends (no idempotency) | HIGH | Can't unsend; add per-recipient state + idempotency key, audit who got duplicates, notify affected users; treat as a sev incident |
| Plaintext credentials already stored | HIGH | Rotate the encryption design, force all users to re-enter SMTP creds, invalidate old rows, assume prior data compromised if any leak suspected |
| "database is locked" in prod | LOW | Enable WAL + busy_timeout, restart processes; add checkpoint monitoring |
| Worker killed mid-batch | LOW–MEDIUM | With per-recipient state: resume un-sent rows; without it: manual reconciliation from SMTP logs before any resend |
| Volume not persisted (data lost) | HIGH | Often unrecoverable without backups; restore from volume backup if any; institute backups + persistence test going forward |
| CSV misparse sent wrong data | HIGH | Irreversible for sent mail; add real parser + preview gate; for future, block send on unmatched fields |
| Attachment path traversal exploited | HIGH | Patch resolver, audit access logs for cross-tenant reads, notify/rotate any exposed data |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Credential encryption at rest (1) | Onboarding / credential phase | DB row shows GCM ciphertext+authTag; key absent from repo/DB; password not readable to client |
| Secrets in logs/client (2) | Foundation (conventions) + onboarding/worker | Test asserts password absent from logs and error responses |
| `secure` inferred from port (3) | SMTP onboarding/validation | 465-implicit and 587-STARTTLS servers both onboard; explicit `secure` stored |
| Validation hang/false-positive (4) | SMTP onboarding/validation | Unreachable host fails <10s; verify()+test-send both required to pass |
| SQLite "database is locked" (5) | Data-layer foundation (re-check in worker) | WAL+busy_timeout set; concurrent send+refresh has no `SQLITE_BUSY` |
| Idempotency / duplicate sends (6) | Background-send / campaign-persistence | Crash+restart resumes un-sent only; double-submit/retry = no duplicates |
| Job-claim race (7) | Background-worker | Atomic claim (`changes===1`); single-worker enforced/documented for v1 |
| Graceful shutdown (8) | Worker + deployment | Deploy mid-send loses/duplicates nothing; clean shutdown log; init/PID-1 |
| Volume persistence (9) | Deployment / Coolify | Data+attachments survive redeploy; web+worker same path; WAL/SHM in volume |
| Attachment path traversal (10) | Attachment-handling (after tenant isolation) | `../`/absolute rejected; cross-tenant file unreachable |
| Attachment size/cleanup (11) | Attachment-handling | Oversize rejected at upload; deleting a campaign removes files; orphan sweep exists |
| CSV parsing edge cases (12) | CSV-upload/parsing + preview | BOM/Win-1252/quoted-comma/embedded-newline CSV parses right; preview reflects it |
| Multi-tenant isolation (13) | Auth/foundation + every feature phase | Cross-tenant fetch/start/delete by ID returns 403/404 |
| BYO-SMTP rate/deliverability (14) | Background-send + onboarding | Throttle/pool/backoff configured; 4xx retried, 5xx permanent; per-recipient SMTP response recorded |

## Sources

- Better SQLite3 official docs — WAL mode, checkpoint starvation, constructor `timeout`/busy behavior (via Context7 `/wiselibs/better-sqlite3`, `docs/performance.md`, `lib/database.js`). HIGH confidence.
- Nodemailer official docs — `secure`/STARTTLS/`requireTLS` semantics, port 465/587 conventions, pooled transport (`maxConnections`/`maxMessages`/`rateDelta`), TLS `rejectUnauthorized`, error codes (`EAUTH`/`ETIMEDOUT`/`ETLS`/`EENVELOPE`/`ECONNECTION`) (via Context7 `/nodemailer/nodemailer-homepage`, `docs/smtp/*`, `docs/errors.md`, `docs/extras/smtp-connection.md`). HIGH confidence.
- Existing CLI concerns audit — `.planning/codebase/CONCERNS.md` (no idempotency/resume, `secure: port===465`, no confirm-before-send, plaintext credentials, no email validation, hand-rolled CSV reader untested on quoting/encoding/CRLF, no audit trail). HIGH confidence (direct codebase analysis).
- Project context — `.planning/PROJECT.md` (BYO-SMTP, 100–1,000 scale, plain-text, per-row attachments, Coolify/VPS, compliance/SPF-DKIM out of scope). HIGH confidence.
- Node.js `crypto` AES-256-GCM and SIGTERM/process-signal handling; Docker stop-grace/init (`tini`) and named-volume persistence — established platform behavior. MEDIUM–HIGH confidence (general training; standard, well-documented mechanics).
- BYO-SMTP provider rate-limit/deliverability behavior (Gmail/Workspace caps, `421`/`454` deferrals, base64 ~33% size overhead) — provider-dependent, not app-controlled. MEDIUM confidence; surface as user-facing expectations rather than guarantees.

---
*Pitfalls research for: self-serve BYO-SMTP CSV mail-merge web app*
*Researched: 2026-06-24*
