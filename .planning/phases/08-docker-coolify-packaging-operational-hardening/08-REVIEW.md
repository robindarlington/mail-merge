---
phase: 08-docker-coolify-packaging-operational-hardening
reviewed: 2026-07-16T10:29:08Z
depth: standard
files_reviewed: 14
files_reviewed_list:
  - .dockerignore
  - .env.example
  - .gitignore
  - docker-compose.yml
  - docker/web-entrypoint.sh
  - Dockerfile
  - lib/worker/maintenance.test.ts
  - lib/worker/maintenance.ts
  - next.config.ts
  - package.json
  - scripts/acceptance-harness.ts
  - scripts/redeploy-acceptance.sh
  - scripts/stub-smtp.ts
  - worker/index.ts
findings:
  critical: 2
  warning: 7
  info: 4
  total: 13
status: fixed
fixed_at: 2026-07-16
fix_scope: critical+warning
fixed: 9
remaining: 4 info (out of fix scope)
---

# Phase 8: Code Review Report

**Reviewed:** 2026-07-16T10:29:08Z
**Depth:** standard
**Files Reviewed:** 14
**Status:** issues_found

## Summary

Reviewed the Phase 8 packaging + operational-hardening surface: the multi-stage
Dockerfile, hardened docker-compose, web entrypoint, worker maintenance routines
(WAL checkpoint + orphan sweep) and their wiring into the poll loop, and the
redeploy acceptance harness (stub SMTP sink, seed/assert, orchestration script).
Cross-referenced the maintenance code against `lib/attachments/storage.ts`,
`lib/csv/storage.ts`, `lib/db`, and the schema to verify path and unit contracts.

The signal-handling, secret-hygiene, and no-double-send design is genuinely solid
(exec-form commands, `init: true`, runtime-only secrets, count-only logging all
check out). However, two Critical defects were found: the orphan sweep never
actually deletes files in production (relative `storage_path` unlinked against
the wrong directory — a permanent, untracked disk leak that defeats SC-4), and
the compose file builds the shared image twice with divergent build args, racing
for the `mail-merge:latest` tag (the winning image can have an empty Clerk
publishable key inlined). Several deployment-robustness warnings follow
(startup migration race the team's own acceptance script works around, no
restart policy, build toolchain shipped in the "hardened" runtime image, web
port published on all host interfaces).

## Narrative Findings (AI reviewer)

## Critical Issues

### CR-01: Orphan sweep unlinks a relative `storage_path` against the process CWD — files are never deleted, producing a permanent, untracked disk leak

**Status:** FIXED — commit `2917e45` (unlink routes through `resolveAttachmentPath`; tests use relative paths + real-file integration tests incl. traversal rejection)
**File:** `worker/index.ts:113` (root cause), `lib/worker/maintenance.ts:139` (call site)
**Severity:** BLOCKER
**Issue:** Attachment rows store `storage_path` as a **relative** opaque name
(`<uuid>.bin`) — see `lib/attachments/storage.ts:58` (`return { storagePath: name }; // store RELATIVE; resolve at read time`).
Every other consumer resolves it via `resolveAttachmentPath()` before touching
disk (e.g. `lib/attachments/actions-core.ts:229`:
`unlinkSync(resolveAttachmentPath(row.storage_path))`). The maintenance wiring
does not:

```ts
// worker/index.ts:113
unlink: unlinkSync,
// lib/worker/maintenance.ts:139
unlink(c.storage_path);   // c.storage_path === "<uuid>.bin"
```

`unlinkSync("<uuid>.bin")` resolves against the worker's CWD (`/app` in the
container), not `/data/uploads`, so **every** production unlink throws ENOENT.
Because the sweep deletes the DB row FIRST (by design), the row is gone before
the unlink fails — the file on `/data/uploads` is now permanently untracked and
can never be swept by any future run. The stated purpose of the sweep (bound
disk usage on `/data`) silently fails 100% of the time; the only symptom is a
non-zero `unlinkFailures` count with (deliberately) no path logged, so an
operator cannot diagnose it. The unit tests mask this: they inject a fake
`unlink` and use absolute test paths (`maintenance.test.ts:137`), so the
resolution bug is never exercised.
**Fix:**
```ts
// worker/index.ts
import { resolveAttachmentPath } from "@/lib/attachments/storage";
...
unlink: (p) => unlinkSync(resolveAttachmentPath(p)),
```
This also restores the traversal guard (defense-in-depth: the worker deletes
files based on DB content, so a corrupted/hostile `storage_path` like
`../../app.db` must be rejected — `guardedResolve` does exactly that). Add one
integration test that seeds a real file under a temp `UPLOADS_PATH` and asserts
the file is actually gone after the sweep with the production `unlink` wiring.

### CR-02: docker-compose builds the shared image twice with divergent build args — the `mail-merge:latest` tag race can ship a web image with an empty Clerk publishable key

**Status:** FIXED — commit `6a7bf21` (worker `build:` block removed; web is the single build owner)
**File:** `docker-compose.yml:75-79` (worker `build:` block), cf. lines 29-45 (web)
**Severity:** BLOCKER
**Issue:** Both services declare `build:` AND `image: mail-merge:latest`, but
only the web service passes the `NEXT_PUBLIC_CLERK_*` build args. `docker
compose build` / `up --build` builds **each** service with a build key —
compose does not dedupe builds whose args differ. The worker's build runs the
same `next build` with `ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` **unset**
(empty), producing a second, different image whose client bundle has an empty
publishable key inlined. Both builds tag `mail-merge:latest`; with parallel
builds, whichever finishes last wins the tag, and **both** services then run
that image. Outcomes: nondeterministically broken Clerk auth in the deployed
web app (whenever the arg-less worker build wins the tag), plus a guaranteed
doubled build time (two full `next build` runs) and doubled exposure to the
documented SQLITE_BUSY build flake the acceptance script retries around.
**Fix:** Give exactly one service the `build:` block. Simplest:
```yaml
  worker:
    image: mail-merge:latest
    # no build: — reuses the image built by web
    depends_on:
      - web
```
(Compose will warn the image must exist; since `depends_on: web` already forces
web's build first under `up --build`, this is safe. Alternatively keep `build:`
on the worker but duplicate the exact `args:` block — worse, still two builds.)

## Warnings

### WR-01: TOCTOU race in `sweepOrphanAttachments` — a draft campaign enqueued between the candidate SELECT and the per-row DELETE loses its attachment

**Status:** FIXED — commit `b0aa5fa` (full orphan predicate re-asserted in the DELETE; unlink/count only when `changes === 1`; deterministic regression test added)
**File:** `lib/worker/maintenance.ts:111-146`
**Issue:** Candidates are selected once (unstamped OR draft-stamped, aged), then
deleted one-by-one with an **unconditional** `DELETE ... WHERE id = ?`
(`maintenance.ts:134`). The web process is a separate writer on the same DB: it
can flip a campaign `draft → queued` (user clicks Send) after the SELECT but
before that row's DELETE. The sweep then deletes the attachment row (and, once
CR-01 is fixed, the file) of a now-queued campaign — the campaign proceeds and
the send path "tolerates missing files", so every email in that campaign is
silently delivered **without its attachment**. Precondition (a ≥7-day-old
draft enqueued in the sweep window) is narrow but the loop window grows with
candidate count and unlink I/O, and the failure is silent user data loss.
**Fix:** Re-assert the orphan predicate inside the delete, e.g.:
```ts
tx.delete(attachments)
  .where(and(
    eq(attachments.id, c.id),
    lt(attachments.created_at, cutoff),
    or(isNull(attachments.campaign_id),
       inArray(attachments.campaign_id, draftCampaignIds)),
  ))
  .run();
```
and only count/unlink when `changes === 1`.

### WR-02: Production `compose up` has the exact web-migrate vs worker-startup race the acceptance script had to serialize around

**Status:** FIXED — commit `7b9f6c2` (web healthcheck probes the `campaigns` table read-only; worker gated with `depends_on: { web: { condition: service_healthy } }`)
**File:** `docker-compose.yml:109-110`; cf. `scripts/redeploy-acceptance.sh:263-275`
**Issue:** `depends_on: [web]` only orders container **start**, not readiness.
On a fresh volume, the worker's `lib/db` opens `/data/app.db` at import and sets
`journal_mode=WAL` concurrently with web's `migrate.js` doing the same. The
acceptance script explicitly documents this race ("Bringing both up at once
lets web-migrate and the worker's poll race to initialize WAL and can lose the
lock (SQLITE_BUSY)") and works around it by starting web alone and polling for
the `campaigns` table — but production Coolify/compose deploys get no such
serialization. A lost race can crash the worker at import (SQLITE_BUSY throw
before `busy_timeout` is set), and per WR-03 there is no restart policy to
recover it.
**Fix:** Add a healthcheck to web that passes only after migration (e.g. a tiny
`node -e` table probe or an HTTP readiness route) and gate the worker with
`depends_on: { web: { condition: service_healthy } }`; or make the worker's DB
open retry with backoff on SQLITE_BUSY.

### WR-03: No `restart:` policy on either service — a crashed worker silently halts all sending

**Status:** FIXED — commit `740114b` (`restart: unless-stopped` on both services)
**File:** `docker-compose.yml:28-110`
**Issue:** Compose's default restart policy is `no`. The worker deliberately
`process.exit(1)`s on a malformed env var (`worker/index.ts:53`), can lose the
WR-02 startup race, or can die on any unhandled crash — and then stays down
indefinitely. Queued campaigns simply never send, with no visible failure in
the web UI. The web service has the same gap (a migrate.js crash-loop is at
least visible; a dead worker is not).
**Fix:** Add `restart: unless-stopped` to both services (Coolify honors compose
restart policies; `init: true` and the drain path are unaffected).

### WR-04: The "hardened" runtime image ships the C/C++ build toolchain

**Status:** FIXED — commit `ab9d608` (runtime stage now `FROM node:24-bookworm-slim` directly; toolchain'd `base` used only by deps/prod-deps/build stages)
**File:** `Dockerfile:18-23`, `Dockerfile:72`
**Issue:** `base` installs `python3 make g++` (needed only for `npm ci`'s
native builds), and the `runtime` stage is `FROM base` — so the production
image for a multi-tenant, internet-facing app ships compilers and Python. This
contradicts the phase's hardening goal (header comment: "Phase 8 HARDENED
Dockerfile"): it materially widens the attack surface for post-exploit
payload compilation and adds ~250-300 MB.
**Fix:**
```dockerfile
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
...
```
Only `deps`/`prod-deps`/`build` need the toolchain (keep those `FROM base`).

### WR-05: Web port published on all host interfaces — bypasses the Coolify proxy/TLS on the VPS

**Status:** FIXED — commit `f733ce5` (`ports:` removed; `expose: ["3000"]` for the Coolify proxy network; acceptance override verified to still compose)
**File:** `docker-compose.yml:70-71`
**Issue:** `ports: ["3000:3000"]` binds 0.0.0.0:3000 on the host. Deployed via
Coolify on a public VPS, this exposes the app as plaintext HTTP directly on
port 3000, bypassing the reverse proxy, TLS, and any proxy-level protections —
an unauthenticated-transport path to a multi-tenant app that handles SMTP
credentials. (The acceptance script already strips ports with `!override [] `,
so nothing in this repo needs the host binding.)
**Fix:** Bind loopback for local dev (`"127.0.0.1:3000:3000"`) or remove
`ports:` entirely for the Coolify deployment and let its proxy attach over the
Docker network (`expose: ["3000"]` if documentation of the port is wanted).

### WR-06: One try/catch couples the two maintenance routines — a persistently failing checkpoint starves the orphan sweep and retries at poll cadence

**Status:** FIXED — commit `f8fb532` (per-routine try/catch; stamps advanced in `finally` so failures retry at their interval, not per poll)
**File:** `worker/index.ts:102-124`
**Issue:** `checkpointWal` and `sweepOrphanAttachments` share a single `try`
block, and the `lastCheckpointAt`/`lastSweepAt` stamps are advanced only after
success. If `checkpointWal` throws (e.g. transient I/O or a future regression):
(a) the sweep in the same block is skipped, and (b) `lastCheckpointAt` never
advances, so the failing checkpoint is retried on **every** poll (default every
2 s) — log spam at poll cadence and indefinite sweep starvation, instead of the
intended hourly cadence.
**Fix:** Wrap each routine in its own try/catch and advance its stamp in a
`finally` (retry next interval, not next poll):
```ts
if (isDue(lastCheckpointAt, WAL_CHECKPOINT_MS, nowMs)) {
  try { checkpointWal(connection, logger); }
  catch (err) { logger.error({ err: msg(err) }, "checkpoint error"); }
  finally { lastCheckpointAt = nowMs; }
}
```

### WR-07: Acceptance build retry loop discards all build output and misreports the attempt count

**Status:** FIXED — commit `8ef8dc8` (each attempt logged to `$TMPDIR_ACCEPT/build.log`; tail printed on final failure; attempt count derived from `$BUILD_ATTEMPTS`)
**File:** `scripts/redeploy-acceptance.sh:251-261`
**Issue:** `compose build >/dev/null 2>&1` swallows stdout AND stderr for all 8
attempts. The retry exists for one specific transient flake (SQLITE_BUSY page
data race), but it blindly retries **every** failure — a genuine build break
(bad Dockerfile edit, npm failure) costs 8 full silent builds and ends with
zero diagnostics. The final error message also says "after 4 attempts" while
the loop runs 8 (`for attempt in 1..8`).
**Fix:** Capture each attempt to a log file (`compose build >"$TMPDIR_ACCEPT/build.log" 2>&1`),
print the tail on final failure, and fix the count in the message (or derive it
from the loop variable).

## Info

### IN-01: `envInt` accepts non-integers despite its "positive-integer" contract

**File:** `worker/index.ts:44-56`
**Issue:** The doc comment and error message promise positive-integer parsing,
but `Number(raw)` accepts `"1.5"`, `"1e3"`, `"0.5"` (e.g. a fractional
`WORKER_LEASE_SEC`). Not currently harmful, but the validation doesn't match
the contract.
**Fix:** `if (!Number.isInteger(n) || n <= 0)` (keep `Number(raw)` for `1e3`
rejection or accept it explicitly — just make the check match the docs).

### IN-02: Harness `seed` does not validate `--stub-port`

**File:** `scripts/acceptance-harness.ts:77`
**Issue:** `Number(flags["stub-port"] ?? ... ?? 2525)` can be NaN (typo'd flag)
and flows into `createSmtpConfig` / the printed banner; `--count` gets a proper
integer guard two lines above but the port does not.
**Fix:** Mirror the count guard: `if (!Number.isInteger(stubPort) || stubPort <= 0 || stubPort > 65535) fail(...)`.

### IN-03: Cleanup trap re-enters itself on INT/TERM

**File:** `scripts/redeploy-acceptance.sh:69-78`
**Issue:** `trap cleanup EXIT INT TERM` — on INT/TERM, `cleanup` runs and its
`exit $code` fires the EXIT trap, running `cleanup` a second time against the
already-deleted `$TMPDIR_ACCEPT` (compose is invoked with a now-missing
override file). Harmless today only because every line is `|| true`-guarded.
**Fix:** First line of `cleanup`: `trap - EXIT INT TERM` (or trap EXIT only —
bash runs the EXIT trap on signal-induced exits too).

### IN-04: `sh` entrypoint does not forward SIGTERM during the migrate step

**File:** `docker/web-entrypoint.sh:12`
**Issue:** Until `exec node server.js` runs, PID-1-adjacent `sh` receives the
tini-forwarded SIGTERM and exits without signaling the foreground
`node migrate.js`, which is left to be SIGKILLed at the grace-period end. The
window is small and drizzle migrations are transactional/idempotent, so this is
informational — but a stop landing mid-migration relies on SQLite's rollback
journal rather than a clean exit.
**Fix:** Optional: `trap 'kill $MIGRATE_PID' TERM` with `node migrate.js & wait`,
or accept the risk with a comment noting migrations are transaction-wrapped.

---

_Reviewed: 2026-07-16T10:29:08Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
