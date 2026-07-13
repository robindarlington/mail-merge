# Phase 6: Background Worker + Live Send + Progress + History - Pattern Map

**Mapped:** 2026-07-13
**Files analyzed:** 21 new/modified files
**Analogs found:** 20 / 21 (one net-new role: GET route handler)

> Source of file list: `06-RESEARCH.md` "Recommended Project Structure" (lines 106-131) + the Wave 0 test-gap list (lines 424-432). No CONTEXT.md exists — file list is extracted from RESEARCH alone.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `lib/worker/claim.ts` | worker-seam | event-driven (poll/claim) | `lib/data/campaigns.ts` `enqueueCampaign` (atomic UPDATE) + `lib/db` raw `connection` | role-match (raw stmt is new) |
| `lib/worker/claim.test.ts` | test | — | `lib/data/campaigns.test.ts` | exact |
| `lib/worker/recover.ts` | worker-seam | batch (state sweep) | `lib/data/campaigns.ts` `enqueueCampaign` (single scoped UPDATE) | role-match |
| `lib/worker/materialize.ts` | worker-seam | transform (CSV→rows→insert) | `lib/campaign/actions-core.ts` `buildConfirmSummaryCore` (read set/tpl → parseCsv → fillMessage) | role-match |
| `lib/worker/materialize.test.ts` | test | — | `lib/data/campaigns.test.ts` (temp DB + migrate + seed) | exact |
| `lib/worker/process.ts` | worker-seam | streaming (per-row send loop) | `lib/campaign/actions-core.ts` `sendTestBatchChunkCore` (verify→loop→sendOne→throttle) | exact (same send primitives) |
| `lib/worker/process.test.ts` | test | — | `lib/campaign/actions-core.test.ts` (stub transport) + `lib/data/campaigns.test.ts` (temp DB) | exact |
| `lib/worker/finalize.ts` | worker-seam | CRUD (terminal UPDATE) | `lib/data/campaigns.ts` `enqueueCampaign` | role-match |
| `lib/worker/loop.ts` | worker-seam | event-driven (compose tick) | `lib/campaign/actions.ts` (thin composition wrapper) | role-match |
| `lib/worker/loop.test.ts` | test | — | `lib/data/campaigns.test.ts` | exact |
| `worker/index.ts` (REPLACE) | entrypoint | event-driven (poll loop + signals) | current `worker/index.ts` skeleton (structure) + `lib/campaign/actions.ts` (composition-root role) | role-match |
| `lib/data/campaigns.ts` (EXTEND) | dal | CRUD / read (progress, list, drill-down) | `lib/data/campaigns.ts` existing `getCampaignForUser` (in-file) | exact |
| `lib/data/campaigns.test.ts` (EXTEND) | test | — | itself (in-file) | exact |
| `lib/data/index.ts` (EXTEND) | barrel | — | itself | exact |
| `lib/campaign/actions-core.ts` (EXTEND) | service-seam | request-response (read) | `buildConfirmSummaryCore` (in-file, auth-scoped read) | exact |
| `lib/campaign/actions.ts` (EXTEND) | service | request-response | `buildConfirmSummary` (in-file, auth→core) | exact |
| `lib/campaign/actions-core.test.ts` (EXTEND) | test | — | itself | exact |
| `app/(app)/campaigns/page.tsx` | page (RSC) | request-response (read) | `app/(app)/recipients/page.tsx` | exact |
| `app/(app)/campaigns/[id]/page.tsx` | page (RSC) | request-response (read) | `app/(app)/recipients/page.tsx` | role-match (dynamic param is new) |
| `app/(app)/campaigns/[id]/export/route.ts` | route handler | file-I/O (CSV stream) | RESEARCH Code Example (lines 311-328); no in-repo route handler exists | **no analog** |
| `components/campaign/progress-panel.tsx` | component (client) | polling (request-response) | `components/campaign/test-send-panel.tsx` (client loop over action) | exact |
| `components/campaign/recipient-results-table.tsx` | component | request-response (render) | `app/(app)/recipients/page.tsx` list render + `components/ui/table.tsx` | role-match |
| `components/campaign/campaign-list.tsx` | component | request-response (render) | `app/(app)/recipients/page.tsx` list render | role-match |
| `components/app-sidebar.tsx` (EXTEND) | component (client) | — | itself (documented future slots, lines 64-69) | exact |

---

## Pattern Assignments

### `lib/worker/claim.ts` (worker-seam, atomic claim)

**Analog:** `lib/data/campaigns.ts` `enqueueCampaign` (the atomic single-statement UPDATE idiom) + raw `connection` from `lib/db`.

**Why raw, not drizzle:** `lib/db/index.ts:8` already exports `connection` "the worker may need the raw handle." RESEARCH Pattern 1 (lines 133-156) mandates the exact `UPDATE…WHERE id=(subquery)…RETURNING *` shape.

**Import the raw handle** (`lib/db/index.ts:8`):
```typescript
export { db, connection, type Db } from "./client";
```
So the seam does:
```typescript
import { connection } from "@/lib/db";
```

**Atomic-claim shape to copy** (RESEARCH Pattern 1, lines 140-154):
```typescript
const claimStmt = connection.prepare(`
  UPDATE campaigns
     SET status='running',
         lease_expires_at = unixepoch() + @leaseSec,
         worker_id = @workerId,
         started_at = COALESCE(started_at, unixepoch())
   WHERE id = (
     SELECT id FROM campaigns
      WHERE status='queued'
         OR (status='running' AND lease_expires_at < unixepoch())
      ORDER BY created_at LIMIT 1
   )
  RETURNING *;
`);
const claimed = claimStmt.get({ workerId, leaseSec: 300 }); // one row or undefined
```

**Idempotency-signal pattern to mirror** — `enqueueCampaign` proves "affected-row count IS the win signal" (`lib/data/campaigns.ts:83-95`). Here the returned row (or `undefined`) is the win signal. Same single-writer reasoning as `campaigns.ts:78-82`.

**Column names are authoritative** in `lib/db/schema.ts:105-126` (`worker_id`, `lease_expires_at`, `started_at`, `finished_at`, `total`, `sent_count`, `failed_count`). Note drizzle column names are snake_case in SQL but the Drizzle model uses these keys directly.

---

### `lib/worker/materialize.ts` (worker-seam, transform)

**Analog:** `lib/campaign/actions-core.ts` `buildConfirmSummaryCore` (lines 372-465) — the exact "resolve campaign FKs → read stored CSV → parseCsv → fillMessage" chain.

**Read-the-campaign's-own-FKs pattern** (`actions-core.ts:387-410`) — copy verbatim, minus the userId (worker derives tenancy from `campaign.userId`, RESEARCH line 222):
```typescript
const set = await getRecipientSetForUser(campaign.userId, campaign.recipient_set_id);
const template = await getTemplateForUser(campaign.userId, campaign.template_id);
const parsed = parseCsv(readUpload(set.storage_path));   // lib/csv + lib/core
const emailColumn = set.email_column ?? detectEmailColumn(parsed.columns, parsed.rows);
```

**Email-column resolution** — copy `actions-core.ts:414`:
```typescript
const emailColumn = set.email_column ?? detectEmailColumn(columns, rows);
```

**Merge each row** — copy `actions-core.ts:426-429`:
```typescript
const merged = fillMessage({ subject: template.subject, body: template.body }, firstRow);
```

**Idempotent insert (NEW pattern — RESEARCH Pattern 2, lines 158-176):** use drizzle `.onConflictDoNothing()` against `UNIQUE(campaign_id, to_addr)` (declared `lib/db/schema.ts:151`):
```typescript
db.insert(send_records).values({
  campaign_id: campaign.id, to_addr: row[emailColumn],
  merged_subject: subject, merged_body: body,
}).onConflictDoNothing();
// then reconcile: UPDATE campaigns SET total=(SELECT count(*) FROM send_records WHERE campaign_id=?)
```

**Imports to copy** (`actions-core.ts:35-58` — path-alias + barrel convention):
```typescript
import { detectEmailColumn, fillMessage, parseCsv } from "@/lib/core";
import { getRecipientSetForUser, getTemplateForUser } from "@/lib/data";
import { readUpload } from "@/lib/csv";
```

---

### `lib/worker/process.ts` (worker-seam, per-row send loop) — THE core new pattern

**Analog:** `lib/campaign/actions-core.ts` `sendTestBatchChunkCore` (lines 130-257) — same primitives (`decrypt` → `createSmtpTransport` → `verifyTransport` → `sendOne` → `throttle`), same injectable `transportOverride` + `delayMs` seam shape.

**Decrypt + build transport** — copy `actions-core.ts:193-209`:
```typescript
const password = decrypt({
  enc: cfg.password_enc as Buffer, iv: cfg.password_iv as Buffer, tag: cfg.password_tag as Buffer,
});
const transport: MailTransport =
  transportOverride ??
  (createSmtpTransport({
    host: cfg.host, port: cfg.port, secure: cfg.secure,
    auth: { user: cfg.username, pass: password },
  }) as unknown as MailTransport);
const from = cfg.from_name ? `${cfg.from_name} <${cfg.from_addr}>` : cfg.from_addr;
```

**verify() once before sending** — copy `actions-core.ts:219-228` (the CLAUDE.md carry-forward: verify before any send).

**Send loop with per-row commit** (RESEARCH Pattern 3, lines 179-192 — mirrors the `actions-core.ts:230-245` loop but commits state each row):
```typescript
for (const rec of pendingRows) {              // status='pending' ORDER BY id → resumable
  setStatusSending.run(rec.id);               // committed BEFORE the await (orphan-detectable)
  const res = await sendOne({ transport, from, to: rec.to_addr, subject: rec.merged_subject, body: rec.merged_body });
  if (res.ok) { markSent.run(res.messageId, rec.id); bumpSent.run(campaign.id); }
  else        { markFailed.run(res.error.message, rec.id); bumpFailed.run(campaign.id); } // message-only (D-06)
  bumpLease.run(campaign.id);                  // heartbeat
  await throttle(delayMs);                     // between-sends only
}
```

**SendResult contract** the loop consumes — `lib/core/send.ts:74-77`:
```typescript
export type SendResult =
  | { ok: true; messageId: string }
  | { ok: false; error: { message: string; code?: string } };
```

**Critical constraint (RESEARCH line 181, 221):** better-sqlite3 is synchronous; a transaction **cannot span an `await`**. Each per-row write is its own statement — NEVER wrap the `await sendOne` in a transaction.

**Error-string discipline** — copy `actions-core.ts:239-241`: push/store `res.error.message` ONLY, never the raw Error (D-06). See also `send.ts:130-139`.

**close() guard** — copy `actions-core.ts:246-250` (stub transports have no `close()`).

---

### `lib/worker/recover.ts` + `lib/worker/finalize.ts` (worker-seams, CRUD)

**Analog:** `lib/data/campaigns.ts` `enqueueCampaign` (lines 83-95) — single scoped UPDATE.

- **recover.ts** (RESEARCH Pattern 5, lines 198-202): `UPDATE send_records SET status='failed', error='interrupted: delivery status unknown' WHERE campaign_id=? AND status='sending'` + bump `failed_count`. Terminal, never auto-resent.
- **finalize.ts** (RESEARCH Pitfall 5, lines 265-268): after loop drains, `UPDATE campaigns SET status='completed', finished_at=unixepoch()` (partial failures still = completed run); reserve `failed` for whole-campaign aborts (verify fail / decrypt error / no config).

Status string values are the schema's documented state machine — `campaigns` `draft|queued|running|completed|failed` (`schema.ts:104`), `send_records` `pending|sending|sent|failed` (`schema.ts:129`).

---

### `lib/worker/loop.ts` (worker-seam, compose tick)

**Analog:** `lib/campaign/actions.ts` (the thin composition wrapper) — `loop.tick()` composes `claim → recover → materialize → run → finalize`, each injected for testability (RESEARCH Pattern 6, lines 204-206). Accept injected deps (`db`/`connection`, optional `MailTransport`, `delayMs`, heartbeat clock) exactly as `sendTestBatchChunkCore` accepts `transportOverride` + `delayMs` (`actions-core.ts:130-135`).

---

### `worker/index.ts` (REPLACE skeleton) (entrypoint)

**Analog:** current `worker/index.ts` (the skeleton — keep its readiness-log + `.unref()` shape and no-secret-log discipline) + `lib/campaign/actions.ts` (composition-root role: build deps, call the seam).

**Keep from skeleton** (`worker/index.ts:20-45`): the structured readiness log; the single `db` import from `@/lib/db`; the poll interval. **Replace** the no-op heartbeat body with `loop.tick()` and make the interval `ref`'d (skeleton comment at line 41 says so). Swap `console.log` for pino (RESEARCH line 40; skeleton comment line 25-26 notes "pino is wired in Phase 6").

**Add SIGTERM/SIGINT handler** (RESEARCH Pattern 7, lines 208-214):
```typescript
let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"] as const)
  process.on(sig, () => { stopping = true; }); // loop checks `stopping` between rows
```

**Logging discipline (carry the skeleton's rule, lines 11-12):** never log secrets — readiness/liveness/result only.

---

### `lib/data/campaigns.ts` (EXTEND) (dal, read)

**Analog:** in-file `getCampaignForUser` (lines 68-73) — the `and(eq(id), eq(userId))` IDOR-safe read.

Add: `listCampaignsForUser(userId)`, `getSendRecordsForCampaign(userId, campaignId)` (scoped via campaign ownership), `getCampaignProgress` reads. Every function takes `userId` as required FIRST param (file docstring lines 6-14). Copy the filter idiom verbatim:
```typescript
return db.query.campaigns.findFirst({
  where: and(eq(campaigns.id, id), eq(campaigns.userId, userId)),
});
```
For send_records drill-down (no userId column — tenancy via campaign_id, `schema.ts:132`): first resolve the campaign with `getCampaignForUser`, THEN query `send_records WHERE campaign_id = campaign.id`. Never fetch send_records by campaign id without first proving campaign ownership (RESEARCH Pitfall 6, line 272).

**Export from barrel** — extend `lib/data/index.ts:34-39` (same block).

---

### `lib/campaign/actions-core.ts` + `actions.ts` (EXTEND) (service-seam + service)

**Analog (core):** `buildConfirmSummaryCore` (`actions-core.ts:372-465`) — validate id → `getCampaignForUser` (IDOR) → derive data → typed result. Add `getCampaignProgressCore(userId, input)` per RESEARCH Code Example (lines 279-292):
```typescript
const id = campaignIdSchema.safeParse(input.campaignId);
if (!id.success) return { ok: false, error: { kind: "validation", issues: id.error.issues } };
const c = await getCampaignForUser(userId, id.data);
if (!c) return { ok: false, error: { kind: "not_found" } };
return { ok: true, data: { status: c.status, total: c.total, sent: c.sent_count,
  failed: c.failed_count, remaining: c.total - c.sent_count - c.failed_count, current: /* sending row */ } };
```
Reuse `campaignIdSchema` from `./schema` (already imported, `actions-core.ts:59-66`; defined `schema.ts:29`). Reuse the `ActionError` union (`actions-core.ts:73-81`).

**Analog (action wrapper):** `buildConfirmSummary` (`actions.ts:90-97`) — the auth→core three-liner. Copy exactly for `getCampaignProgress`:
```typescript
const { auth } = await import("@clerk/nextjs/server");   // lazy import (actions.ts:64 note)
const { userId } = await auth();
if (!userId) return { ok: false, error: { kind: "unauthenticated" } };
return getCampaignProgressCore(userId, input);
```

**CSV export helper `toResultsCsv`** (NEW — RESEARCH "Don't Hand-Roll" line 237, Pitfall/Threat lines 455): a minimal RFC-4180 field quoter + formula-injection prefix for leading `= + - @ \t \r`. No existing analog in repo; build the small helper (place in `lib/campaign/` and unit-test it — Wave 0 gap line 430).

---

### `app/(app)/campaigns/page.tsx` + `[id]/page.tsx` (page, RSC)

**Analog:** `app/(app)/recipients/page.tsx` (exact) — `async` RSC that re-derives userId and lists via userId-scoped DAL.

**Auth + scoped-list pattern** — copy `recipients/page.tsx:39-41`:
```typescript
export default async function CampaignsPage() {
  const { userId } = await auth();
  const campaigns = userId ? await listCampaignsForUser(userId) : [];
```
**Empty-state + Card list render** — copy `recipients/page.tsx:43-77` structure (Card / CardContent / divide-y row map). **Relative-date helper** — copy `recipients/page.tsx:17-37` `formatRelativeDate` verbatim (unixepoch-seconds → Intl.RelativeTimeFormat).

For `[id]/page.tsx` the dynamic param is new: Next 16 async params (`{ params }: { params: Promise<{ id: string }> }`, seen in the RESEARCH route example line 315) → `const { id } = await params` → `getCampaignForUser(userId, Number(id))` → 404/notFound if undefined. Render `<ProgressPanel>` when status is `running`/`queued`, else the results table.

---

### `app/(app)/campaigns/[id]/export/route.ts` (route handler) — NO in-repo analog

**No existing GET route handler in the repo.** Use the RESEARCH Code Example verbatim (lines 311-328) as the pattern source:
```typescript
import { auth } from "@clerk/nextjs/server";
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;
  const campaign = await getCampaignForUser(userId, Number(id));   // IDOR-safe (campaigns.ts:68)
  if (!campaign) return new Response("Not found", { status: 404 });
  const rows = await getSendRecordsForCampaign(userId, campaign.id);
  const csv = toResultsCsv(rows);
  return new Response(csv, { headers: {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="campaign-${campaign.id}-results.csv"` } });
}
```
The `auth()` call here is a DIRECT import (not lazy) — route handlers run only under the Next server runtime, unlike the `actions.ts` lazy-import workaround (`actions.ts:62-64`, needed for the plain test runner).

---

### `components/campaign/progress-panel.tsx` (component, client polling)

**Analog:** `components/campaign/test-send-panel.tsx` (exact) — `"use client"` component that drives a Server Action in a loop and renders progress + typed-failure Alert.

**Poll pattern** — RESEARCH Code Example (lines 296-308):
```tsx
"use client";
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
**Reuse from test-send-panel.tsx:** the `failureFor(error)` ActionError→human-reason mapper (lines 50-71), the destructive `<Alert>` + `<Collapsible>` "technical details" block (lines 239-264), the `Loader2`/`CheckCircle2`/`AlertCircle` lucide icon vocabulary (lines 5-12), the "Sent X of Y…" progress line (lines 207-211). Same import surface (`@/lib/campaign/actions`, `@/components/ui/*`).

---

### `components/campaign/recipient-results-table.tsx` + `campaign-list.tsx` (component, render)

**Analog:** `app/(app)/recipients/page.tsx` list render (lines 60-77) + `components/ui/table.tsx` (shadcn Table primitives). Render per-recipient `to_addr`/`status`/`error`/`sent_at` in a Table; status badge via `components/ui/badge.tsx`. Keep server-rendered where possible (RESEARCH structure note, line 127). Never render a merged body/cell value as HTML (test-send-panel security note, line 36).

---

### `components/app-sidebar.tsx` (EXTEND) (component)

**Analog:** itself — the file already documents the exact insertion point (lines 64-69: "Future nav slots (D-11): 'Campaigns' and 'History'"). Add `SidebarMenuItem`s to `NAV_ITEMS` (lines 30-35) following the existing `{ title, href, icon }` shape; `isActive` detection (lines 50-52) already handles nested `/campaigns/[id]` via `startsWith`. Pick lucide icons (e.g. `Send`/`History`).

---

## Shared Patterns

### Multi-tenant scoping (AUTH-02 / IDOR)
**Source:** `lib/data/campaigns.ts:68-73` (`and(eq(id), eq(userId))`)
**Apply to:** every web-side DAL read/write (campaigns list, drill-down, progress, export). Worker is the ONLY exception — it derives `userId` from `campaign.userId` (RESEARCH line 222), never a session.
```typescript
where: and(eq(campaigns.id, id), eq(campaigns.userId, userId)),
```

### Auth → core seam split (mandatory)
**Source:** `lib/campaign/actions.ts:90-97` (wrapper) + `actions-core.ts:372-383` (core)
**Apply to:** `getCampaignProgress`. The `"use server"` file exports ONLY the auth-guarded action; the userId-accepting core lives in `actions-core.ts` (no `"use server"`) so it is importable + testable but never a client-invocable endpoint (`actions.ts:14-19`, `actions-core.ts:1-9`).

### Reused pure primitives (do NOT re-implement)
**Source:** `lib/core` barrel (`lib/core/index.ts`) + `lib/crypto` + `lib/csv`
**Apply to:** worker `materialize.ts` + `process.ts`. Use `fillMessage`, `sendOne`, `createSmtpTransport`, `verifyTransport`, `throttle`, `parseCsv`, `detectEmailColumn`, `decrypt`, `readUpload` — never new merge/send/crypto/CSV code (RESEARCH lines 220, 224-239; Phase 5 "reused-primitives" review flag).

### Single SQLite opener (D-04)
**Source:** `lib/db/client.ts:37-71` + `lib/db/index.ts:8`
**Apply to:** all worker seams. Import `db` (drizzle) and/or `connection` (raw, for the atomic claim) from `@/lib/db`. NEVER `new Database(...)`. WAL + busy_timeout=5000 are inherited (RESEARCH Pitfall 3, lines 255-257).

### Error-string discipline (D-06 / SMTP-04)
**Source:** `lib/campaign/actions-core.ts:239-241`, `lib/core/send.ts:130-139`
**Apply to:** worker per-row failures + progress/export results. Store/return `res.error.message` (a STRING), never a raw Error, the config, or the decrypted password. pino logs readiness/result only (RESEARCH line 445).

### Test harness (temp DB + stub transport)
**Source:** `lib/data/campaigns.test.ts:24-106` (temp `DATABASE_PATH` + `CREDENTIAL_ENC_KEY` set BEFORE dynamic imports; `migrate(db, { migrationsFolder: "./drizzle" })`; seed FKs) + `lib/campaign/actions-core.test.ts` (injected `stubTransport`)
**Apply to:** every `lib/worker/*.test.ts`. Placed under `lib/` so the `npm test` glob (`lib/**/*.test.ts`) picks them up automatically (RESEARCH lines 205, 364, 403). Copy the `before()`/`after()` temp-dir + migrate + `connection.close()` teardown verbatim (`campaigns.test.ts:59-106`).

### Env-path config convention
**Source:** `lib/db/client.ts:27` + `lib/csv/storage.ts:25`
**Apply to:** the send throttle source (RESEARCH A6 — `SEND_DELAY_MS` env, default ~1000-3000ms) and lease/poll tuning. `resolve(process.env.X ?? "<dev-default>")` idiom.

---

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `app/(app)/campaigns/[id]/export/route.ts` | route handler | file-I/O (CSV) | No GET/POST route handler exists anywhere in the repo (only RSC pages + Server Actions + `proxy.ts` middleware). Use RESEARCH Code Example lines 311-328 as the pattern; `auth()` is a direct (not lazy) import here. |
| `toResultsCsv` helper (in `lib/campaign/`) | utility | transform | No CSV-writer/escaper exists (repo only READS CSVs via `parseCsv`). Build a minimal RFC-4180 quoter + formula-injection prefix (RESEARCH line 237). |

---

## Metadata

**Analog search scope:** `lib/worker/` (empty — net-new), `lib/data/`, `lib/campaign/`, `lib/core/`, `lib/db/`, `lib/csv/`, `app/(app)/`, `components/campaign/`, `components/`, `worker/`
**Files scanned:** 15 read in full/targeted (worker/index.ts, lib/campaign/actions.ts + actions-core.ts, lib/data/campaigns.ts + campaigns.test.ts + index.ts, lib/core/send.ts + index.ts, lib/db/index.ts + client.ts + schema.ts, lib/csv/index.ts + storage.ts, lib/campaign/schema.ts, app/(app)/recipients/page.tsx, components/campaign/test-send-panel.tsx, components/app-sidebar.tsx, lib/config.ts)
**Pattern extraction date:** 2026-07-13
