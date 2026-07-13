# Phase 5: Test-Send + Confirmation Gate - Research

**Researched:** 2026-07-13
**Domain:** Next.js 16 Server Actions orchestrating a synchronous batch email operation over BYO-SMTP; SQLite atomic state-machine transition; shadcn Dialog confirmation gate.
**Confidence:** HIGH (codebase groundwork is directly verified; the two genuinely open decisions — test-send throttle/cap and campaign-creation timing — are flagged `[ASSUMED]` for discuss-phase).

## Summary

Phase 5 has almost no new external surface: every primitive it needs already exists and is verified in the codebase. `fillMessage` (both subject+body), `sendOne` (structured never-throws result), `createSmtpTransport`, `verifyTransport`, the AES-256-GCM `decrypt`, the `campaigns`/`send_records` schema with its `draft|queued|running|completed|failed` status column, the userId-first DAL pattern, the `actions.ts`/`actions-core.ts` split, and the shadcn `Dialog` (with `DialogFooter`) are all present. Phase 5 is therefore primarily a **composition and wiring** phase, not a discovery phase. `[VERIFIED: codebase]`

The three requirements decompose cleanly. **TEST-01** (batch-to-one-address) is a new `sendTestBatchCore` seam that mirrors the existing `sendTestVia` decrypt→verify→send pattern but loops `fillMessage` over every recipient row and directs each personalized message to a single test address, returning a synchronous summary. **TEST-02** (confirm gate) is a shadcn `Dialog` fed a **server-authoritative** review payload (recipient count, sender identity via the redacted SMTP DTO, one merged sample recipient, and the Phase-4 validation warnings). **TEST-03** (single draft→queued transition) is a one-statement atomic `UPDATE ... WHERE status='draft'` guarded by checking the affected-row count — SQLite's single-writer model makes this the idempotency primitive, exactly as `ARCHITECTURE.md` Pattern 2 describes for the worker's claim.

Two design decisions are genuinely open (no CONTEXT.md exists) and must be resolved before or during planning: (1) **when the `campaigns` draft row is created** — the schema requires `template_id`, `recipient_set_id`, and `smtp_config_id` to be non-null, so a draft can only exist once all three are chosen; and (2) **the test-send throttle/cap** — the CLI sent ALL rows with a 3-second delay, which for a 1000-row set is ~50 minutes of synchronous work and will exceed the Coolify/Traefik reverse-proxy timeout. Both are flagged in the Assumptions Log.

**Primary recommendation:** Add a new `lib/campaign/` feature module (`actions.ts` + `actions-core.ts`) plus a `lib/data/campaigns.ts` userId-scoped DAL. Reuse `fillMessage` + `sendOne` + `decrypt` + `createSmtpTransport` verbatim for the test-send loop. Implement the enqueue guard as a single atomic `UPDATE campaigns SET status='queued' WHERE id=? AND user_id=? AND status='draft'` and treat `changes !== 1` / empty `.returning()` as "already queued". Keep Phase 5 strictly to enqueue-safely — do NOT materialize `send_records` (that is Phase 6, per the STATE.md decision).

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Batch test-send execution (decrypt→verify→fill→send loop) | API/Backend (Server Action core) | — | Requires the SMTP password (server-only secret) and nodemailer (Node). Never client. Synchronous per phase scope. |
| Merged "sample recipient" for the modal | API/Backend | — | Must be server-authoritative so a tampered client payload can't hide warnings; uses the same `fillMessage` the send path uses. |
| Validation-warning summary for the gate | API/Backend | Browser (display only) | Server recomputes invalid-email count + merge gaps at confirm time (PREV-03) so the gate can't be bypassed client-side. |
| Confirmation modal rendering + explicit confirm click | Browser/Client | — | Pure interaction; shadcn Dialog. Disables its confirm button in-flight (first line of double-submit defense). |
| Draft→queued atomic transition (TEST-03) | Database (atomic UPDATE) | API/Backend (orchestration) | SQLite single-writer makes `UPDATE ... WHERE status='draft'` the true idempotency guard; the button-disable is only cosmetic. |
| Draft campaign persistence | Database | API/Backend (DAL) | New `campaigns` row linking template + recipient set + smtp config, userId-scoped. |

## Standard Stack

No new external packages are required for this phase. Every dependency is already installed and verified in `package.json`.

### Core (all already present)
| Library | Version (installed) | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `nodemailer` | ^9 | SMTP transport for the test-send loop | Already the sole transport; reused via `lib/core/send.ts`. `[VERIFIED: package.json]` |
| `drizzle-orm` | ^0.45 | Atomic enqueue UPDATE + campaign DAL | Already the ORM over better-sqlite3. `[VERIFIED: package.json]` |
| `better-sqlite3` | ^12.11 | Synchronous single-writer engine that makes the atomic guard work | Single-writer semantics ARE the TEST-03 primitive. `[VERIFIED: package.json]` |
| `radix-ui` / shadcn `Dialog` | ^1.6 | Confirmation modal | `components/ui/dialog.tsx` already exports `Dialog`, `DialogContent`, `DialogFooter`, `DialogTitle`, `DialogDescription`, `DialogClose`. `[VERIFIED: codebase]` |
| `zod` | ^4.4 | Validate campaign id + test address in the action seams | Established shared-schema idiom. `[VERIFIED: package.json]` |
| `@clerk/nextjs` | ^7.5 | `auth()` in the action wrappers to derive userId | Established pattern. `[VERIFIED: package.json]` |
| `sonner` | ^2.0.7 | Toast on test-send success/failure | Established feedback idiom. `[VERIFIED: package.json]` |

### Supporting (internal modules to reuse verbatim)
| Module | Purpose | When to Use |
|--------|---------|-------------|
| `lib/core/fill.ts` → `fillMessage(tpl, row)` | Fills `{{col}}` in BOTH subject and body (EDIT-03 fix) | Per-recipient in the test-send loop AND for the modal's sample recipient. `[VERIFIED: codebase]` |
| `lib/core/send.ts` → `sendOne`, `createSmtpTransport`, `verifyTransport`, `throttle` | Never-throws structured send; transport factory; pre-send verify; configurable delay | The entire test-send send path. `[VERIFIED: codebase]` |
| `lib/crypto` → `decrypt` | Server-only AES-256-GCM decrypt of the stored password | Exactly as `lib/smtp/actions.ts::sendTestEmail` does it. `[VERIFIED: codebase]` |
| `lib/data/smtp.ts` → `getSmtpConfigForUser`, `toSmtpConfigDto` | Load config; redact to client-safe DTO (no password triple) for the modal's sender identity | Modal sender identity + test-send config load. `[VERIFIED: codebase]` |
| `lib/data/recipients.ts` → `getRecipientSetForUser` | userId-scoped recipient set + `storage_path` + `email_column` | Resolve rows for the batch. `[VERIFIED: codebase]` |
| `lib/data/templates.ts` → `getTemplateForUser`, `createTemplate` | userId-scoped subject/body | Draft campaign's template. `[VERIFIED: codebase]` |
| `lib/csv/storage.ts` → `readUpload` + `lib/core/csv.ts` → `parseCsv` | Traversal-safe read + parse of the stored CSV into rows | Materialize rows for both test-send and the confirm summary. `[VERIFIED: codebase]` |
| `lib/core/merge.ts` → `analyzeMerge`, `extractTokens` + `lib/core/csv.ts` → `countInvalidEmails` | Validation-warning aggregates (empty/unknown tokens; invalid emails) | Server-authoritative confirm-gate warnings (PREV-03). `[VERIFIED: codebase]` |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Synchronous Server Action for test-send | A one-off worker job (Phase 6 infra) | Phase scope explicitly keeps the worker in Phase 6; synchronous is correct for MVP but forces the throttle/cap decision (see Assumptions). |
| shadcn `Dialog` | `AlertDialog` | `AlertDialog` is purpose-built for destructive confirmations (traps focus, no click-outside dismiss). It is NOT currently installed. `Dialog` IS installed and sufficient; adding `AlertDialog` is a reasonable option but costs a shadcn add. `[VERIFIED: codebase — only dialog.tsx present]` |
| Atomic `UPDATE ... WHERE status='draft'` | `SELECT` status then `UPDATE` | The select-then-update is a TOCTOU race that a double-submit can slip through; the single-statement guard is the whole point of TEST-03. |

**Installation:** None. (If the team prefers `AlertDialog` semantics for the gate: `npx shadcn@latest add alert-dialog` — verify against the already-initialized `components.json` radix-nova preset first.)

## Package Legitimacy Audit

> No external packages are installed in this phase. All libraries used are already present in `package.json` and were vetted in prior phases. Slopcheck / registry verification is therefore N/A for Phase 5.

| Package | Registry | Disposition |
|---------|----------|-------------|
| *(none — phase adds no dependencies)* | — | N/A |

**Packages removed due to slopcheck [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Architecture Patterns

### System Architecture Diagram

```
                                COMPOSE PAGE (existing, Phase 4)
                                        │  user has: recipient set + subject/body + saved SMTP
                                        ▼
                    ┌───────────────────────────────────────────────┐
                    │  "Prepare to send" / draft-campaign creation   │  ← [ASSUMED] new step
                    │  createDraftCampaign(userId,{recipSetId,        │     (timing = open decision)
                    │     templateId, smtpConfigId}) → campaignId     │
                    └───────────────────┬───────────────────────────┘
                                        │ campaignId (status='draft')
                     ┌──────────────────┼───────────────────────────────┐
                     ▼                                                    ▼
        ┌────────────────────────┐                        ┌──────────────────────────────┐
        │  TEST-SEND (TEST-01)   │                        │  CONFIRM GATE (TEST-02)        │
        │  sendTestBatchCore     │                        │  buildConfirmSummaryCore       │
        │  1 decrypt smtp pass   │                        │  (server-authoritative)        │
        │  2 build transport     │                        │  → recipientCount              │
        │  3 verifyTransport()   │  ◄── CLAUDE.md: verify  │  → sender identity (DTO,       │
        │  4 for each row:       │      BEFORE any send    │     NO password)               │
        │    fillMessage(tpl,row)│                        │  → 1 merged sample recipient   │
        │    sendOne(→TEST ADDR) │                        │  → warnings: invalidEmails,    │
        │    throttle(?)  [OPEN] │                        │     empty/unknown merge tokens │
        │  5 transport.close()   │                        └───────────────┬──────────────┘
        │  → {sent,failed,errors}│                                        │ user clicks CONFIRM
        └───────────┬────────────┘                                        ▼
                    │ summary                              ┌──────────────────────────────┐
                    ▼                                      │  ENQUEUE (TEST-03)             │
        toast + summary panel                              │  UPDATE campaigns              │
        (NO live progress — Phase 6)                       │   SET status='queued'          │
                                                           │   WHERE id=? AND user_id=?     │
                                                           │     AND status='draft'         │
                                                           │  changes===1 ? ok : already_q  │
                                                           └───────────────┬──────────────┘
                                                                           ▼
                                                        campaign row now 'queued'
                                                        (Phase 6 worker claims it later —
                                                         send_records materialized THERE, not here)
```

### Recommended Project Structure
```
lib/
├── campaign/                 # NEW feature module (mirrors lib/compose, lib/smtp)
│   ├── actions.ts            # "use server" wrappers: auth() → delegate. ONLY public surface.
│   ├── actions-core.ts       # userId-accepting seams (NO "use server"): testable, never wire-callable
│   ├── schema.ts             # shared zod: campaignId, test address, create-draft input
│   ├── actions-core.test.ts  # node:test via tsx — inject stub transport, temp DB
│   └── index.ts              # barrel
├── data/
│   └── campaigns.ts          # NEW userId-scoped DAL: createDraftCampaign, getCampaignForUser, enqueueCampaign
components/
└── campaign/                 # NEW client components
    ├── confirm-send-dialog.tsx   # shadcn Dialog fed the server summary
    └── test-send-panel.tsx       # trigger + spinner + result summary
app/(app)/
└── ...                       # wire into the compose flow (or a new review route) — see Assumptions A1
```

### Pattern 1: The actions.ts / actions-core.ts split (MANDATORY — established seam)
**What:** Every runtime export of a `"use server"` module becomes a client-invocable endpoint. So the `"use server"` file (`actions.ts`) exports ONLY thin wrappers that re-derive `userId` via Clerk `auth()`; all userId-accepting logic lives in `actions-core.ts` (no directive), importable by tests but never wire-callable.
**When to use:** Every Phase 5 action. This is non-negotiable project convention (T-*-IDOR / AUTH-02).
**Example:**
```typescript
// Source: lib/smtp/actions.ts + lib/compose/actions.ts (verbatim established pattern)
// actions.ts
"use server";
export async function sendTestBatch(formData: FormData): Promise<TestSendResult> {
  const { auth } = await import("@clerk/nextjs/server"); // lazy: keeps module loadable under tsx test runner
  const { userId } = await auth();
  if (!userId) return { ok: false, error: { kind: "unauthenticated" } };
  return sendTestBatchCore(userId, formData);
}
// actions-core.ts  (NO "use server")
export async function sendTestBatchCore(userId: string, formData: FormData): Promise<TestSendResult> { /* ... */ }
```

### Pattern 2: Atomic single-transition enqueue guard (TEST-03)
**What:** One statement flips `draft`→`queued` only if it is still `draft`; the affected-row count tells you whether YOU won the transition. This is the same idiom `ARCHITECTURE.md` Pattern 2 prescribes for the worker's job claim.
**When to use:** The confirm gate's enqueue step. Never `SELECT` then `UPDATE`.
**Example:**
```typescript
// Source: ARCHITECTURE.md Pattern 2 (claim) adapted to draft→queued; drizzle over better-sqlite3
// better-sqlite3 is synchronous; drizzle .run() surfaces { changes } from the driver. [VERIFIED: WebSearch — orm.drizzle.team + better-sqlite3 docs]
import { and, eq } from "drizzle-orm";
const flipped = await db
  .update(campaigns)
  .set({ status: "queued" })
  .where(and(eq(campaigns.id, id), eq(campaigns.userId, userId), eq(campaigns.status, "draft")))
  .returning({ id: campaigns.id });          // returning() length is the cross-checkable signal
if (flipped.length !== 1) {
  return { ok: false, error: { kind: "already_queued" } }; // double-submit or wrong owner/state
}
```
Note: including `eq(campaigns.userId, userId)` in the WHERE makes the guard simultaneously the IDOR defense — a campaign owned by another tenant can never be enqueued. `[CITED: ARCHITECTURE.md Pattern 2]`

### Pattern 3: Verify-before-send test loop (reuses sendTestVia shape)
**What:** Decrypt server-side → `createSmtpTransport` → `verifyTransport()` ONCE before the loop → `for each row: fillMessage → sendOne(to = testAddr)` → `transport.close()` in `finally`. Mirrors `lib/smtp/actions.ts::sendTestEmail` + `sendTestVia`, but batches and redirects every message to the one test address.
**When to use:** TEST-01.
**Example:**
```typescript
// Source: composed from lib/smtp/actions.ts::sendTestEmail + lib/core/send.ts + lib/core/fill.ts [VERIFIED: codebase]
const password = decrypt({ enc: row.password_enc as Buffer, iv: row.password_iv as Buffer, tag: row.password_tag as Buffer });
const transport = createSmtpTransport({ host: row.host, port: row.port, secure: row.secure, auth: { user: row.username, pass: password } });
try {
  await verifyTransport(transport);          // CLAUDE.md constraint: verify BEFORE any send
  const from = row.from_name ? `${row.from_name} <${row.from_addr}>` : row.from_addr;
  let sent = 0, failed = 0; const errors: string[] = [];
  for (const r of rows) {                    // rows capped/throttled — see Assumptions A2
    const { subject, body } = fillMessage({ subject: tplSubject, body: tplBody }, r);
    const res = await sendOne({ transport, from, to: testAddr, subject, body });
    res.ok ? sent++ : (failed++, errors.push(res.error.message)); // message-only, never raw Error (D-06)
    await throttle(TEST_SEND_DELAY_MS);      // value is an open decision (A2)
  }
  return { ok: true, data: { sent, failed, errors } };
} finally {
  transport.close();                          // never leak the socket, even on a hung verify
}
```

### Anti-Patterns to Avoid
- **Materializing `send_records` in Phase 5.** The STATE.md decision explicitly assigns the per-recipient state machine to Phase 6 ("Build it in Phase 6"). Phase 5's confirm gate ONLY flips `draft`→`queued`. The worker materializes `send_records` when it claims the job (ARCHITECTURE Pattern 3). Doing it here duplicates Phase-6 logic and risks divergence.
- **SELECT-then-UPDATE for the enqueue guard.** A TOCTOU race a double-click can slip through. Use the single atomic UPDATE.
- **Trusting a client-supplied storage path / campaign id.** Always resolve via the userId-scoped DAL (`getCampaignForUser(userId, id)`), never `eq(id)` alone.
- **Client-computed confirm-gate warnings as the source of truth.** The modal may render client values for responsiveness, but the enqueue action must recompute warnings server-side (or at least the counts) so a tampered payload can't suppress the gate.
- **Logging the decrypted password, the sample recipient's cell values, or a raw nodemailer Error.** `raw` fields are always message strings (D-06); no `console.*` of secrets or CSV cell values (T-*-LOG).
- **A multi-minute synchronous test-send.** Will trip the Coolify/Traefik reverse-proxy read timeout and the browser fetch timeout. Cap/parallelize/reduce delay (A2).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Merge substitution | A fresh `{{}}` replacer | `fillMessage` (`lib/core/fill.ts`) | Already handles subject+body, `$`-literal insertion, whitespace-in-braces, pass-through of unknown tokens. `[VERIFIED: codebase]` |
| Per-send error handling | try/catch around `sendMail` | `sendOne` (`lib/core/send.ts`) | Never-throws structured `{ok}` result — the batch continues past a bad send by design. `[VERIFIED: codebase]` |
| SMTP transport creation | `nodemailer.createTransport` inline | `createSmtpTransport` | Explicit `secure`, no `port===465` inference (PITFALLS #3). `[VERIFIED: codebase]` |
| Credential decryption | node:crypto GCM inline | `decrypt` (`lib/crypto`) | Auth-tag-verified; single audited path. `[VERIFIED: codebase]` |
| Confirm modal primitive | A custom overlay | shadcn `Dialog` (installed) | Focus trap, portal, a11y, `DialogFooter` already there. `[VERIFIED: codebase]` |
| Idempotent enqueue | A lock / in-memory flag | Atomic `UPDATE ... WHERE status='draft'` | SQLite single-writer makes it correct and crash-safe. `[CITED: ARCHITECTURE.md Pattern 2]` |
| Client-safe sender identity | Hand-picking fields | `toSmtpConfigDto` | Structurally cannot reference the password triple (SMTP-04). `[VERIFIED: codebase]` |
| Validation aggregates | New gap analyzer | `analyzeMerge` + `countInvalidEmails` | PREV-02/03 engines already exist and are pure. `[VERIFIED: codebase]` |

**Key insight:** Phase 5 is the payoff for Phases 1–4's seam discipline. If a Phase-5 task writes new merge, send, crypto, or transport code, it is almost certainly re-inventing a verified primitive — treat that as a review flag.

## Common Pitfalls

### Pitfall 1: Synchronous test-send exceeds the reverse-proxy / browser timeout
**What goes wrong:** The CLI sent ALL rows with a 3s delay. A 500-row test-send synchronously = ~25 minutes. Self-hosted Next.js (Coolify container behind Traefik) has NO Vercel-style `maxDuration`, but Traefik and the browser fetch impose their own read/idle timeouts (commonly 60s), producing a 504 or a hung UI mid-send. `[VERIFIED: WebSearch — maxDuration is a serverless/Vercel concept; self-hosted relies on the reverse proxy]`
**Why it happens:** "Whole batch to one address" + "synchronous Server Action" + "3s throttle" cannot all hold for large CSVs.
**How to avoid:** Decide the test-send throttle/cap (A2). Recommended MVP: a small-or-zero inter-send delay for the test path (all messages go to ONE inbox — the 3s delay existed for distinct-recipient deliverability, not this) PLUS a configurable row cap that keeps worst-case wall time comfortably under ~30s. Surface the cap in the UI ("Testing the first N of M rows").
**Warning signs:** A test-send that "spins forever"; a Traefik 504 in staging (success criterion #4 exercises staging, so this WILL surface there).

### Pitfall 2: The campaign draft can't be created until all three FKs exist
**What goes wrong:** `campaigns.template_id`, `.recipient_set_id`, `.smtp_config_id` are all `NOT NULL`. A "create draft early" design will hit a constraint if the user hasn't saved a template or SMTP config yet. `[VERIFIED: lib/db/schema.ts]`
**Why it happens:** The current compose flow saves templates STANDALONE and never creates a campaign; Phase 5 is where the three entities first converge.
**How to avoid:** Create the draft campaign only at the "prepare to send" moment, after ensuring a template row exists (create-or-reuse) and the user has a verified SMTP config. Gate the whole Phase-5 surface behind "has SMTP config" and "has a saved/creatable template". Decide timing in A1.
**Warning signs:** A NOT NULL / FK constraint error on `INSERT INTO campaigns`.

### Pitfall 3: Double-submit enqueues twice
**What goes wrong:** A fast double-click (or a retried request) fires two enqueue actions; without the atomic guard both flip the row and — in Phase 6 — the worker could double-process.
**Why it happens:** Client button-disable is cosmetic and racy; the real guard must be at the DB.
**How to avoid:** The atomic `UPDATE ... WHERE status='draft'` + `changes===1` check (Pattern 2). The second submission sees 0 rows affected → `already_queued`, surfaced as a benign "already sending" message, not an error.
**Warning signs:** Two `queued` transitions logged; a test that fires the enqueue twice and expects the second to be a no-op should FAIL if the guard is missing.

### Pitfall 4: Confirm-gate warnings computed only on the client
**What goes wrong:** If the modal's warnings are client-derived and the enqueue action doesn't recheck, a tampered request bypasses the safety gate entirely — defeating the phase's whole purpose.
**Why it happens:** The Phase-4 preview intentionally computes template-dependent aggregates client-side (to stay live as the user types). Reusing that directly for the gate leaks the trust boundary.
**How to avoid:** The confirm-summary action recomputes counts server-side from the stored CSV + template (`countInvalidEmails`, `analyzeMerge`). The modal DISPLAYS them; the server OWNS them.
**Warning signs:** No server-side warning recomputation in the enqueue path.

### Pitfall 5: Test-send to one address still trips the user's provider rate limit
**What goes wrong:** Firing dozens/hundreds of messages rapidly at one inbox over the user's own SMTP can trigger `421`/`454` throttling or temporary blocks (PITFALLS #14), making a legitimate test look broken.
**Why it happens:** Zero delay + high row count against a rate-limited provider (Gmail/Workspace caps).
**How to avoid:** Keep a modest delay and/or the row cap (A2); surface `sendOne`'s per-message failure reasons in the summary so a `421` is explained, not silent.
**Warning signs:** A cluster of `failed` results with 4xx SMTP codes late in the test run.

## Runtime State Inventory

> This phase is greenfield feature work (new module + new DAL + new campaign rows), not a rename/refactor/migration. Section included for completeness; no pre-existing runtime state is being renamed or migrated.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None — the `campaigns` table already exists (Phase 1 migration `drizzle/0000`); Phase 5 only INSERTs new draft rows and UPDATEs `status`. No schema change anticipated. | None (verify no new column is needed for the confirm summary; if a "queued_at"/timestamp is wanted, it's an additive migration). |
| Live service config | None — no external service configuration embeds a Phase-5 string. | None. |
| OS-registered state | None. | None. |
| Secrets/env vars | Reuses `CREDENTIAL_ENC_KEY` (decrypt) and `UPLOADS_PATH`/`DATABASE_PATH` — all already established. No new secret. | None. |
| Build artifacts | None. | None. |

**Nothing found in any category — verified by inspecting `lib/db/schema.ts` (all six tables pre-exist) and `package.json` (no new deps).**

## Code Examples

### Sender identity for the modal (redacted DTO — never the password)
```typescript
// Source: lib/data/smtp.ts::toSmtpConfigDto [VERIFIED: codebase]
const row = await getSmtpConfigForUser(userId);      // userId-scoped; undefined if none
if (!row) return { ok: false, error: { kind: "no_smtp_config" } };
const dto = toSmtpConfigDto(row);                    // { host, port, secure, username, from_addr, from_name, verified_at }
const senderIdentity = dto.from_name ? `${dto.from_name} <${dto.from_addr}>` : dto.from_addr;
// dto structurally cannot carry password_enc/_iv/_tag — safe to ship to the client.
```

### Server-authoritative confirm summary (TEST-02 payload)
```typescript
// Source: composed from lib/csv/storage.ts + lib/core/csv.ts + lib/core/merge.ts + lib/core/fill.ts [VERIFIED: codebase]
const set = await getRecipientSetForUser(userId, recipientSetId);          // IDOR-safe
const { columns, rows } = parseCsv(readUpload(set.storage_path));          // server-side only
const emailColumn = set.email_column ?? detectEmailColumn(columns, rows);
const invalidEmailCount = emailColumn ? countInvalidEmails(rows, emailColumn) : 0;
// merge gaps aggregated across rows for subject+body:
const summary = {
  recipientCount: rows.length,
  senderIdentity,                                                          // from DTO above
  sample: fillMessage({ subject, body }, rows[0]),                         // one merged sample (subject+body)
  invalidEmailCount,
  emptyTokenRows: rows.filter(r => analyzeMerge(subject + "\n" + body, r, columns).empty.length > 0).length,
  unknownTokens: [...new Set(rows.flatMap(r => analyzeMerge(subject + "\n" + body, r, columns).unknown))],
};
```

### node:test seam test (mirrors lib/smtp/actions.test.ts)
```typescript
// Source: lib/smtp/actions.test.ts harness [VERIFIED: codebase]
// 1. set DATABASE_PATH + CREDENTIAL_ENC_KEY to temp values BEFORE any DB import
// 2. dynamic-import the module + drizzle migrator; migrate onto the throwaway file
// 3. inject a stub MailTransport whose sendMail records calls → assert every row filled + all `to` === testAddr
// 4. call enqueueCampaignCore twice → assert 1st ok, 2nd { already_queued } (the atomic guard)
```

## State of the Art

| Old Approach (CLI) | Current Approach (Phase 5) | Impact |
|--------------------|----------------------------|--------|
| `--test ADDR` sent ALL rows to one address, body-only fill, 3s delay, no confirm | Batch test-send with subject+body fill, throttle/cap decision, then a hard confirm gate before live | Closes the "no confirm-before-send" gap (PITFALLS: the CLI's most dangerous behavior) |
| Live send fired immediately on `--send` | `draft`→`queued` atomic single transition; worker (Phase 6) picks up | Idempotent, double-submit-proof enqueue |
| No campaign concept | A `campaigns` draft row links template + recipient set + SMTP config | The durable unit of work the worker + history build on |

**Deprecated/outdated:** The CLI `port===465`-infers-TLS shortcut is already gone (explicit `secure`); do not reintroduce it in the test-send transport build.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The `campaigns` draft row is created at a new "prepare to send" step (after a template row exists and a verified SMTP config exists), not when the standalone template is saved. Both test-send and the confirm gate operate against that draft campaign id. | Architecture / Pitfall 2 | If the intended model is "campaign created at template save" or "campaign created only at confirm," the DAL surface and where test-send gets its inputs both change. HIGH-impact structural decision — resolve in discuss-phase. |
| A2 | Test-send sends every recipient's merged message to the one test address but with a small/zero inter-send delay AND a configurable row cap (default kept well under the reverse-proxy timeout), since all messages hit ONE inbox. | Summary / Pitfall 1 / Pattern 3 | If the product wants literal CLI parity (ALL rows, 3s delay, no cap), a synchronous Server Action is infeasible for large sets and the phase would need a one-off worker path (which the roadmap defers to Phase 6). MEDIUM-HIGH — resolve before planning. |
| A3 | Phase 5 does NOT materialize `send_records`; it only flips `draft`→`queued`. Materialization is Phase 6 (worker-on-claim). | Anti-Patterns | Aligned with the STATE.md decision, so low risk — but if planning wants web-side materialization, that overlaps Phase 6 scope. |
| A4 | The confirm gate uses the already-installed shadcn `Dialog` rather than adding `AlertDialog`. | Standard Stack | Low — cosmetic/UX; `AlertDialog` gives stricter focus/dismiss semantics if desired (one shadcn add). |
| A5 | A single test address is entered by the user at test-send time (validated as an email), defaulting to their Clerk primary email as `sendTestEmail` already does. | TEST-01 | Low — mirrors existing onboarding test-send behavior. |
| A6 | The Phase-5 surface is reachable from the existing compose flow (or a thin new "review" route), not a full new top-level nav destination. | Project Structure | Low — routing detail; UI-SPEC/planner can place it. |

## Open Questions

1. **When is the `campaigns` draft row created, and does saving a template still create a standalone template row?** (A1)
   - What we know: schema requires all three FKs non-null; compose currently saves standalone templates.
   - What's unclear: whether Phase 5 introduces "create-or-reuse template + create draft campaign" as one action, or keeps template-save separate and creates the campaign at confirm.
   - Recommendation: One "prepare to send" action that ensures a template row and inserts the draft campaign, returning its id — resolve in discuss-phase.

2. **Test-send throttle and row cap.** (A2)
   - What we know: CLI = all rows + 3s delay; self-hosted has proxy/browser timeouts.
   - What's unclear: acceptable wall-time and whether "whole batch" must be literal.
   - Recommendation: small/zero delay + configurable cap surfaced in UI; confirm the exact number with the user.

3. **Does the confirm summary need a new persisted column (e.g., `queued_at`)?**
   - What we know: `campaigns` has `created_at`, `started_at`, `finished_at` but no `queued_at`.
   - What's unclear: whether history/UX wants an explicit enqueue timestamp.
   - Recommendation: default to reusing existing columns; add `queued_at` only if history (Phase 6) needs it — additive migration if so.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Server Actions + test-send | ✓ | 24.9.0 (host, pinned `>=24`) | — |
| better-sqlite3 native | atomic enqueue + campaign DAL | ✓ | ^12.11 installed | — |
| nodemailer | test-send loop | ✓ | ^9 installed | — |
| `smtp-server` (dev) | seam tests could use a local SMTP sink | ✓ | ^3.19.2 devDep | Inject a stub transport instead (preferred; no live socket) |
| Coolify / Traefik staging URL | Success criterion #4 (deploy + works on staging) | ✗ (not verifiable from this workspace) | — | Verify the reverse-proxy read timeout on the target Coolify version; it bounds the synchronous test-send (Pitfall 1) |

**Missing dependencies with no fallback:** None for local build/test.
**Missing dependencies with fallback:** Live SMTP for tests → use an injected stub `MailTransport` (the established test pattern) or the `smtp-server` dev dependency.

**Note on success criterion #4:** The staging deployment is operational, not a code dependency, but it interacts with Pitfall 1 — the synchronous test-send must complete within the Coolify/Traefik proxy timeout. This is the concrete reason A2 must be resolved.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `node:test` (built-in) run via `tsx` |
| Config file | none — driven by the `test` npm script |
| Quick run command | `npm test` (`node --import tsx --test "lib/**/*.test.ts"`) |
| Full suite command | `npm test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| TEST-01 | Batch test-send fills subject+body per row and sends every message to the ONE test address; returns `{sent,failed,errors}`; verify runs before the loop | unit (injected stub transport) | `npm test` (`lib/campaign/actions-core.test.ts::test-send`) | ❌ Wave 0 |
| TEST-01 | Decrypted password / CSV cell values never appear in the result or logs | unit (redaction grep on result) | `npm test` | ❌ Wave 0 |
| TEST-02 | Confirm summary is server-authoritative: correct recipient count, redacted sender identity (no password), one merged sample, warning aggregates | unit | `npm test` (`::confirm-summary`) | ❌ Wave 0 |
| TEST-03 | `enqueueCampaignCore` flips draft→queued once; a second call returns `already_queued`; a non-owner id is refused | unit (temp DB) | `npm test` (`lib/data/campaigns.test.ts` + core) | ❌ Wave 0 |
| AUTH-02 | Every new DAL fn is userId-scoped; no fetch-by-id-alone path | unit | `npm test` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npm test` (whole suite is fast; no isolated quick subset configured).
- **Per wave merge:** `npm test`.
- **Phase gate:** Full suite green before `/gsd:verify-work`; plus a manual staging test-send + confirm-gate walkthrough (success criterion #4).

### Wave 0 Gaps
- [ ] `lib/campaign/actions-core.test.ts` — TEST-01 fill+redirect+verify-order + redaction; TEST-02 summary.
- [ ] `lib/data/campaigns.test.ts` — createDraftCampaign, getCampaignForUser IDOR, atomic enqueue double-call.
- [ ] Shared temp-DB + `CREDENTIAL_ENC_KEY` harness — copy the header from `lib/smtp/actions.test.ts` (set env BEFORE dynamic imports, migrate onto a throwaway file).
- [ ] Stub `MailTransport` factory (records `sendMail` calls) — reuse the shape from the existing smtp tests.

## Security Domain

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Clerk `auth()` in every `actions.ts` wrapper before any work (established). |
| V3 Session Management | no (delegated to Clerk) | — |
| V4 Access Control | yes | userId-scoped DAL for campaigns; `getCampaignForUser(userId,id)` never `eq(id)` alone; the enqueue WHERE includes `user_id` (IDOR = state guard). |
| V5 Input Validation | yes | zod on campaign id (coerce positive int), test address (email), create-draft input — mirrors `recipientSetIdSchema`. |
| V6 Cryptography | yes | Reuse `lib/crypto` `decrypt` only; password decrypted transiently in-memory at send time, never returned/logged (SMTP-04). |
| V7 Error/Logging | yes | `raw` fields are message strings only (D-06); no `console.*` of password, sample cell values, or raw nodemailer Error (T-*-LOG). |

### Known Threat Patterns for {Next.js Server Actions + BYO-SMTP + SQLite}
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| IDOR on campaign id (enqueue/test another tenant's campaign) | Elevation of Privilege | userId in the DAL WHERE and the atomic guard WHERE. |
| Double-submit duplicate enqueue | Tampering / (repudiation of "sent once") | Atomic `UPDATE ... WHERE status='draft'` + `changes===1`. |
| Client-forged confirm payload suppressing warnings | Tampering | Server recomputes warnings/counts at confirm time. |
| Credential leak via decrypted password in result/log | Information Disclosure | `decrypt` transient-only; DTO redaction; grep gate on secret logging. |
| `actions-core` exported from a `"use server"` module → client bypasses auth | Elevation of Privilege | Keep userId-accepting seams OUT of `"use server"` files (established split). |
| Test-send as an outbound-mail abuse vector (arbitrary recipient over user's SMTP) | Spoofing / abuse | It is the user's own SMTP + own quota (same surface as live send); still validate the test address as an email and consider a lightweight per-user rate limit like the existing `underVerifyRateLimit`. |
| Long synchronous action ties up the Node server | Denial of Service | Throttle/cap (A2); bound wall time under the proxy timeout. |

## Sources

### Primary (HIGH confidence)
- Codebase (direct read): `lib/db/schema.ts`, `lib/core/{send,fill,merge,csv}.ts`, `lib/crypto`, `lib/data/{smtp,recipients,templates}.ts`, `lib/smtp/{actions,actions-core}.ts`, `lib/compose/{actions,actions-core,schema}.ts`, `lib/csv/storage.ts`, `components/ui/dialog.tsx`, `components/compose/compose-editor.tsx`, `package.json`, `next.config.ts`. — the entire reusable substrate.
- `.planning/research/ARCHITECTURE.md` — campaign lifecycle state machine, atomic claim Pattern 2, per-row materialization Pattern 3, test-send flow step 4/5.
- `.planning/research/PITFALLS.md` — no-confirm-before-send gap, verify-not-sufficient, BYO-SMTP rate limits, SQLite concurrency.
- `.planning/STATE.md` — "send_record state machine built in Phase 6" decision; two-container DB-as-queue architecture.
- `.planning/REQUIREMENTS.md` — TEST-01/02/03 wording.

### Secondary (MEDIUM confidence)
- [Next.js maxDuration / route segment config](https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config/maxDuration) + [vercel/next.js #64437 server action timeout](https://github.com/vercel/next.js/discussions/64437) — confirmed `maxDuration` is a serverless/Vercel concept; self-hosted execution length is bounded by the reverse proxy, not Next itself.
- [Drizzle ORM Update docs](https://orm.drizzle.team/docs/update) + [Drizzle SQLite docs](https://orm.drizzle.team/docs/sqlite/get-started-sqlite) — `.returning()` on update; better-sqlite3 synchronous driver surfaces `changes` for the affected-row guard.

### Tertiary (LOW confidence)
- None — no claim in this research rests on an unverified single web source. Exact Coolify/Traefik proxy timeout value is environment-specific and must be checked on the target host (flagged in Environment Availability + A2).

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — every library is already installed and every reused module was read directly.
- Architecture: HIGH for the reusable seams and the atomic-guard pattern; the two open decisions (A1 campaign timing, A2 throttle/cap) are correctly flagged as decisions, not gaps.
- Pitfalls: HIGH — derived from the project's own PITFALLS.md plus a verified understanding of self-hosted Server Action timeout behavior.

**Research date:** 2026-07-13
**Valid until:** 2026-08-12 (stable stack; re-check only if Next.js major or Drizzle major changes, or if the Coolify proxy timeout on the target host is altered).
