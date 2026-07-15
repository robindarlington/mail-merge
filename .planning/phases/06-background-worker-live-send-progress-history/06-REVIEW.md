---
phase: 06-background-worker-live-send-progress-history
reviewed: 2026-07-15T21:09:26Z
depth: standard
files_reviewed: 30
files_reviewed_list:
  - app/(app)/campaigns/[id]/export/route.ts
  - app/(app)/campaigns/[id]/page.tsx
  - app/(app)/campaigns/page.tsx
  - components/app-sidebar.tsx
  - components/campaign/campaign-status-badge.tsx
  - components/campaign/campaign-summary-line.tsx
  - components/campaign/progress-panel.tsx
  - components/campaign/recipient-results-table.tsx
  - components/ui/progress.tsx
  - lib/campaign/actions-core.test.ts
  - lib/campaign/actions-core.ts
  - lib/campaign/actions.ts
  - lib/campaign/results-csv.test.ts
  - lib/campaign/results-csv.ts
  - lib/data/campaigns.test.ts
  - lib/data/campaigns.ts
  - lib/data/index.ts
  - lib/worker/claim.test.ts
  - lib/worker/claim.ts
  - lib/worker/finalize.test.ts
  - lib/worker/finalize.ts
  - lib/worker/loop.test.ts
  - lib/worker/loop.ts
  - lib/worker/materialize.test.ts
  - lib/worker/materialize.ts
  - lib/worker/process.test.ts
  - lib/worker/process.ts
  - lib/worker/recover.test.ts
  - lib/worker/recover.ts
  - worker/index.ts
findings:
  critical: 2
  warning: 6
  info: 8
  total: 16
status: issues_found
---

# Phase 06: Code Review Report

**Reviewed:** 2026-07-15T21:09:26Z
**Depth:** standard
**Files Reviewed:** 30
**Status:** issues_found

## Summary

Reviewed the Phase 6 background-worker pipeline (claim → recover → materialize → send → finalize), the web read layer (history list, detail page, live-progress polling action), the CSV export route, and their tests. Tenant isolation is solid: every web read path is userId-scoped, the export route and progress action are IDOR-safe, and the tests prove cross-tenant refusal on prepare/summary/enqueue/progress/records. The results CSV serializer is RFC-4180-correct and formula-injection-safe. The atomic claim, the sending→failed(interrupted) orphan sweep (never →pending), and the pending-only send loop are correctly built for the crash case they were designed for.

Two critical gaps remain. First, the no-double-send guarantee holds only when the original worker is actually dead: nothing fences a *live-but-slow* worker out after its lease is stolen — per-row writes, the heartbeat, and finalize are all unguarded by `worker_id`/status, and the worker's transport uses nodemailer's default 600s socket timeout, which exceeds the default 300s lease. Second, `tick()` has no error handling around materialize/recover, so a materialize failure (deleted CSV, blank email cell) leaves the campaign in a permanent claim→throw→reclaim loop with the UI spinning "Sending" forever.

## Narrative Findings (AI reviewer)

## Critical Issues

### CR-01: Lease-steal by a live worker breaks the no-double-send guarantee — per-row writes, heartbeat, and finalize have no ownership fence

**File:** `lib/worker/process.ts:130-183`, `lib/worker/loop.ts:102-107`, `lib/worker/finalize.ts:31-60`, `lib/worker/claim.ts:46-52`
**Fixed:** 9af7bed
**Issue:** The stalled-reclaim branch of `claimNextCampaign` assumes an expired lease means a dead worker. But the lease heartbeat only fires *once per processed row* (`process.ts:182`), and the worker builds its transport with **no timeouts** (`process.ts:95-100`), so nodemailer defaults apply: `connectionTimeout` 120s, `socketTimeout` 600s. A single hung SMTP dial can exceed the default `WORKER_LEASE_SEC=300` without a heartbeat. Worker B then legitimately reclaims the campaign while Worker A is still alive and mid-send. From that point every guard is absent:

- `process.ts:134-137` flips a row to `sending` with `WHERE id = ?` only — no `AND status = 'pending'`. A stale Worker A walking its pre-claim `pending` snapshot will flip a row Worker B already delivered (`status='sent'`) back to `sending` and **re-send it**. Both workers also race the same still-pending rows — each selects them as `pending`, each sends → duplicate delivery.
- `loop.ts:102-107` `bumpLease` is `WHERE id = ?` with no `worker_id` check — the stale worker silently extends the *new* owner's lease and never learns it lost the claim.
- `process.ts:150-178` the `sent`/`failed` row updates and counter bumps are unconditional, so both workers increment counters for the same rows (`sent_count + failed_count > total`, negative "remaining" in the UI).
- `finalize.ts:31-60` `markCompleted`/`markFailed` are `WHERE id = ?` only — the stale worker's terminal write stomps the new owner's `running` state mid-send.

This directly violates the phase's hard invariant ("two workers must never send to the same recipient"). It is reachable with a single hung socket even in a one-worker deployment across a redeploy overlap (old container draining while new container polls).
**Fix:**
```ts
// process.ts — fence every row transition on its expected prior state and skip on loss:
const claimedRow = await db.update(send_records)
  .set({ status: "sending" })
  .where(and(eq(send_records.id, rec.id), eq(send_records.status, "pending")))
  .returning({ id: send_records.id });
if (claimedRow.length === 0) continue; // row taken by another worker — do NOT send

// terminal row writes: WHERE id = ? AND status = 'sending'

// loop.ts — heartbeat proves ownership; abort the run when the lease was lost:
const bumped = db.update(campaigns)
  .set({ lease_expires_at: sql`unixepoch() + ${leaseSec}` })
  .where(and(eq(campaigns.id, campaignId), eq(campaigns.worker_id, workerId)))
  .returning({ id: campaigns.id }).all();
if (bumped.length === 0) throw new LeaseLostError();

// finalize.ts — markCompleted/markFailed take workerId and add eq(campaigns.worker_id, workerId)

// process.ts — cap transport timeouts BELOW the lease:
createSmtpTransport({ ...cfg, connectionTimeout: 30_000, greetingTimeout: 30_000, socketTimeout: 120_000 })
```

### CR-02: A materialize failure poisons the queue — campaign loops claim→throw→reclaim forever, never reaching a terminal state

**File:** `lib/worker/loop.ts:62-95`, `lib/worker/materialize.ts:48-84`, `worker/index.ts:75-78`
**Fixed:** f5ba15e
**Issue:** `tick()` runs `recoverOrphanedSending` and `materializeSendRecords` with no try/catch. `materializeSendRecords` throws on: a missing/deleted CSV file (`readUpload`), an unresolvable email column (`materialize.ts:61`), a missing recipient set/template row (`:48-50`), and — subtly — any CSV row whose email cell is absent, because `to_addr: row[emailColumn]` (`:79`) binds `undefined` into a `NOT NULL` column. When that throws, the campaign has already been claimed (`status='running'`, lease stamped) but the error propagates out of `tick()` to the worker's `.catch` (`worker/index.ts:75`), which only logs it. Nothing calls `markFailed`. The campaign sits `running` until the lease expires (~300s), gets reclaimed by the stalled branch, throws again — an infinite retry loop. The user's UI shows "Sending" with the queued spinner forever, the campaign never terminates, and the worker log fills with the same error every 5 minutes for eternity (and it blocks nothing else only because a *newer* queued campaign sorts after it — but with `ORDER BY created_at` FIFO, the poisoned campaign is retried *before* any newer queued campaign once its lease expires, delaying all other tenants' sends by a reclaim cycle each loop).
**Fix:**
```ts
// loop.ts — make every post-claim failure terminal:
recoverOrphanedSending(campaign.id); // keep outside only if provably non-throwing
try {
  await materializeSendRecords(campaign);
} catch (e) {
  const reason = String((e as Error)?.message ?? e);
  markFailed(campaign.id, reason);
  return { claimed: true, campaignId: campaign.id, outcome: "failed", reason };
}
```
And in `materialize.ts`, skip rows with a blank/missing email cell instead of inserting them (see WR-05).

## Warnings

### WR-01: ProgressPanel's poll does not handle a rejected server-action call — the advertised "keeps last-known counts, retrying" behavior never fires for real network errors

**File:** `components/campaign/progress-panel.tsx:53-64`
**Fixed:** 3e8e10f
**Issue:** `poll()` only handles the structured `{ ok: false }` result. A server action invoked from the client is a network fetch: when the server restarts (every deploy), the connection drops, or the proxy times out, `getCampaignProgress(...)` **rejects** — and `poll()` has no try/catch, producing an unhandled promise rejection every 2 seconds and never setting `staleError`. This is precisely the transient failure mode the U9 copy ("Couldn't refresh progress — retrying.") was written for. Separately, a terminal `not_found`/`unauthenticated` result (session expired) keeps polling forever with the stale banner.
**Fix:**
```ts
async function poll() {
  try {
    const res = await getCampaignProgress({ campaignId });
    if (!active) return;
    if (!res.ok) { setStaleError(true); return; }
    setStaleError(false);
    setProgress(res.data);
    setStatus(res.data.status);
  } catch {
    if (active) setStaleError(true); // network hiccup — retry next tick
  }
}
```

### WR-02: Detail-page failed Alert asserts "Nothing was sent" — false after a resume verify-abort with prior deliveries

**File:** `app/(app)/campaigns/[id]/page.tsx:117-125`
**Fixed:** c22d92c
**Issue:** `markFailed` fires for any pre-send abort of a *run*, including a **resumed** run: a campaign that delivered 50 rows, crashed, and then failed `verifyTransport` on re-claim (e.g., the user rotated their SMTP password mid-campaign, or soft-deleted the config → `"no SMTP config"`) ends `status='failed'` with `sent_count > 0`. The hardcoded Alert then tells the user "Nothing was sent." while the results table directly below shows 50 `Sent` rows — contradictory and materially misleading for a mail product whose core value is "a record of exactly what was sent."
**Fix:** Branch the copy on `campaign.sent_count`:
```tsx
<AlertDescription>
  {campaign.sent_count > 0
    ? `The send stopped after ${campaign.sent_count} of ${campaign.total} messages — your SMTP server stopped accepting the connection. Delivered messages are listed below; nothing was sent twice.`
    : "Your SMTP server didn't accept the connection... Nothing was sent."}
</AlertDescription>
```

### WR-03: SIGTERM "drain" waits on a whole-campaign tick — it can essentially never complete within a container stop-grace period

**File:** `worker/index.ts:57-97`, `lib/worker/process.ts:130-184`
**Fixed:** 2e6c665
**Issue:** The drain unit is one `tick()`, and one tick runs an *entire campaign* (N rows × (`SEND_DELAY_MS` + SMTP round-trip) — minutes to hours). Docker/Coolify sends SIGTERM then SIGKILL after ~10s. So for any non-trivial in-flight campaign, the graceful path (`finally → process.exit(0)`) is unreachable; every worker redeploy SIGKILLs mid-send, orphaning one `sending` row that recovery permanently marks `failed (interrupted)` and stalling the campaign for up to `WORKER_LEASE_SEC` before another claim resumes it. Correctness survives (that's what recovery is for), but the shutdown handler as written provides a guarantee it cannot keep, and it costs one falsely-interrupted recipient plus a multi-minute stall per deploy.
**Fix:** Thread a stop signal into the row loop so drain happens *between rows* (well inside the grace window):
```ts
// TickOptions / RunCampaignOptions: shouldStop?: () => boolean
// process.ts loop head:
if (opts.shouldStop?.()) return { ok: true, sent, failed }; // lease not released; next claim resumes pending
// worker/index.ts: tick({ ..., shouldStop: () => stopping })
```
(Leave the campaign `running` with its lease; the reclaim path resumes the remaining `pending` rows.)

### WR-04: Row-state transition and counter bump are separate non-transactional statements — a crash between them permanently desynchronizes the counters

**File:** `lib/worker/recover.ts:36-57`, `lib/worker/process.ts:150-178`
**Fixed:** 0910b9b (recover.ts); the process.ts row-transition + counter-bump pair became transactional in 9af7bed (CR-01)
**Issue:** `recoverOrphanedSending` sweeps rows in one statement and bumps `failed_count` in a second; `runCampaign` likewise updates the send_record and then the campaign counter as two statements around no `await`. A crash (SIGKILL lands here on every deploy, per WR-03) between the pair leaves `sent_count`/`failed_count` disagreeing with the row states *forever* — the counters are incremented blindly, never reconciled from rows, so the progress math (`remaining = total − sent − failed`) and the history line ("97 sent / 3 failed") drift from the drill-down table. `recover.ts`'s own header comment claims the return value and bump "can never disagree", but the guarantee only covers the count *within* one call, not crash atomicity across the two writes. Both statement pairs are fully synchronous (better-sqlite3), so a transaction is trivially available.
**Fix:** Wrap each pair in a synchronous transaction (`connection.transaction(...)` / `db.transaction(...)` with no `await` inside), or better: stop maintaining incremental counters and derive `sent_count`/`failed_count` with `count(*) ... GROUP BY status` at read time (the poll is one user's page every 2s — cheap).

### WR-05: materialize inserts unvalidated email cells — `undefined` crashes the campaign (feeds CR-02), `""` becomes a send to an empty address, and `total` contradicts the confirm summary's `sendableCount`

**File:** `lib/worker/materialize.ts:75-85`
**Fixed:** 111efec
**Issue:** `to_addr: row[emailColumn]` is inserted verbatim. Three concrete failure shapes: (1) a ragged CSV row missing the email column yields `undefined` → `NOT NULL` violation → materialize throws → the CR-02 poison loop; (2) an empty-string cell materializes a send_record addressed to `""`, which the loop dutifully attempts and fails per-row (and all blank-email rows collapse into that one `""` record via the UNIQUE constraint, silently dropping the rest); (3) rows the confirm gate reported as *not sendable* (`invalidEmailCount`, `sendableCount = recipients − invalid`) are still materialized into `total`, so the user who confirmed "2 of 3 sendable" watches a campaign whose total is 3 and whose failure count includes rows they were told would be excluded.
**Fix:**
```ts
const addr = (row[emailColumn] ?? "").trim();
if (!addr) continue; // skip unaddressable rows — mirrors the confirm gate
```
And decide explicitly whether invalid-format addresses (per `countInvalidEmails`) are skipped or attempted, then make the confirm-summary copy match that decision.

### WR-06: Worker env config is unvalidated — a malformed value degrades to NaN with pathological runtime behavior

**File:** `worker/index.ts:34-37`
**Fixed:** 3ee653f
**Issue:** `Number(process.env.WORKER_POLL_MS ?? 2000)` etc. accept garbage silently. `WORKER_POLL_MS=abc` → `setInterval(cb, NaN)` → fires every ~1ms (a hot poll loop hammering the DB with claim UPDATEs). `SEND_DELAY_MS=abc` → `throttle(NaN)` → `NaN <= 0` is false → `setTimeout(..., NaN)` → zero inter-send delay (full-speed blast through the user's SMTP, the exact thing the throttle exists to prevent). `WORKER_LEASE_SEC=abc` → `NaN` bound into `unixepoch() + @leaseSec` → `lease_expires_at` becomes NULL, so a crashed worker's campaign is **never reclaimable** (NULL fails the `< unixepoch()` comparison) — permanently stuck `running`.
**Fix:**
```ts
function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(n) || n <= 0) {
    logger.warn({ name, value: process.env[name] }, "invalid env value — using default");
    return fallback;
  }
  return n;
}
```

## Info

### IN-01: pino has no `redact` configuration — secret safety is discipline-only

**File:** `worker/index.ts:27`
**Issue:** The logger relies entirely on callers never passing a config/credential object. Current call sites are clean (message strings only), but one future `logger.error({ err })` with a nodemailer error (which can embed the failing command stream) has no safety net.
**Fix:** `pino({ base: { component: "worker" }, redact: { paths: ["*.pass", "*.password", "*.auth", "err.config"], censor: "[redacted]" } })`.

### IN-02: Export download uses `<Link>` to a route handler — prefetch executes the export

**File:** `app/(app)/campaigns/[id]/page.tsx:140-145`
**Issue:** Next `<Link>` prefetches on hover/viewport with router headers; a route handler executes and generates the full CSV for a request whose body is discarded, and the eventual click goes through a failed client-navigation before falling back to the download. Wasted DB reads and CSV serialization per hover.
**Fix:** Use a plain `<a href={...} download>` for the download button (route handlers are not router destinations).

### IN-03: Unreachable return in `formatRelativeDate`

**File:** `app/(app)/campaigns/page.tsx:44-49`
**Issue:** The loop's `unit === "second"` arm makes the final `return "just now"` dead code.
**Fix:** Drop the trailing return or the `|| unit === "second"` catch-all — keep one.

### IN-04: Claim FIFO has no tiebreak on `created_at` collisions

**File:** `lib/worker/claim.ts:50`
**Issue:** `ORDER BY created_at LIMIT 1` is nondeterministic for campaigns created within the same second, while `listCampaignsForUser` deliberately tiebreaks on id for exactly this 1s-resolution reason.
**Fix:** `ORDER BY created_at, id`.

### IN-05: Misleading comment — the worker does not "share the WAL'd connection the web process uses"

**File:** `worker/index.ts:40-42`
**Issue:** The worker is a separate OS process; it opens its *own* better-sqlite3 connection to the same file. "Single opener" holds per-process only. The comment as written could mislead a future change (e.g., someone assuming in-process serialization between web and worker writes).
**Fix:** Reword: "opens this process's single shared connection (D-04) against the same WAL database file the web process uses."

### IN-06: `hasStructuralParseError` duplicated across action-core modules

**File:** `lib/campaign/actions-core.ts:122-126`
**Issue:** Verbatim copy of the helper in `compose/actions-core.ts` (its own comment says so). Divergence risk when papaparse error-code handling changes.
**Fix:** Export it once from `lib/core` (or `lib/csv`) and import in both.

### IN-07: Overlapping polls can apply out-of-order progress responses

**File:** `components/campaign/progress-panel.tsx:66-67`
**Issue:** `setInterval` fires regardless of whether the previous `poll()` resolved; a slow response landing after a faster later one regresses the displayed counts for a tick.
**Fix:** Use a self-scheduling `setTimeout` chain (schedule the next poll in `finally`), which also naturally backs off while a request is in flight.

### IN-08: "Started {date}" shown for campaigns that have not started

**File:** `app/(app)/campaigns/[id]/page.tsx:95`
**Issue:** `campaign.started_at ?? campaign.created_at` means a queued campaign displays "Started <created time>", and `formatStartedAt`'s "not started yet" branch is unreachable from this call site.
**Fix:** Pass `campaign.started_at` alone and let the "not started yet" branch render, prefixing the label accordingly ("Created ... · not started yet").

---

_Reviewed: 2026-07-15T21:09:26Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
