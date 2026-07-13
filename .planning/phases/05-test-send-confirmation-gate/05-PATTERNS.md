# Phase 5: Test-Send + Confirmation Gate - Pattern Map

**Mapped:** 2026-07-13
**Files analyzed:** 9 new files (+ 1 wiring point)
**Analogs found:** 9 / 9 (every file has a strong in-repo analog — Phase 5 is a composition phase)

This phase adds a new `lib/campaign/` feature module, a `lib/data/campaigns.ts` DAL, and two client components, all of which have exact-shape siblings already in the repo. No file here should invent new merge/send/crypto/transport logic — those primitives exist and are reused verbatim (see RESEARCH.md "Don't Hand-Roll").

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `lib/campaign/actions.ts` | controller (server-action wrappers) | request-response | `lib/smtp/actions.ts` + `lib/compose/actions.ts` | exact |
| `lib/campaign/actions-core.ts` | service (testable seams) | batch + transform | `lib/smtp/actions-core.ts` + `lib/compose/actions-core.ts` | exact |
| `lib/campaign/schema.ts` | config (shared zod) | transform/validation | `lib/compose/schema.ts` + `lib/smtp/schema.ts` | exact |
| `lib/campaign/index.ts` | config (barrel) | — | `lib/compose/index.ts` | exact |
| `lib/data/campaigns.ts` | model (userId-scoped DAL) | CRUD + atomic UPDATE | `lib/data/templates.ts` / `recipients.ts` (+`smtp.ts` for UPDATE) | exact (role) / role-match (enqueue UPDATE) |
| `lib/campaign/actions-core.test.ts` | test | batch/transform | `lib/smtp/actions.test.ts` | exact |
| `lib/data/campaigns.test.ts` | test | CRUD | `lib/data/templates.test.ts` | exact |
| `components/campaign/confirm-send-dialog.tsx` | component | request-response | `components/smtp/step-test-send.tsx` + `components/ui/dialog.tsx` | role-match |
| `components/campaign/test-send-panel.tsx` | component | request-response | `components/smtp/step-test-send.tsx` | exact |
| `app/(app)/compose/page.tsx` (wire-in, A6) | route (RSC) | request-response | `app/(app)/compose/page.tsx` (itself) | exact |

---

## Pattern Assignments

### `lib/campaign/actions.ts` (controller, request-response)

**Analog:** `lib/smtp/actions.ts` (lines 63-74, 109-161)

The `"use server"` file exports ONLY thin wrappers. Each lazily imports Clerk, re-derives `userId`, returns `{ ok:false, error:{ kind:"unauthenticated" } }` on no user, then delegates to a `*Core` seam. Type-only re-exports (`export type { ActionResult }`) are erased and safe.

**Wrapper pattern** (`lib/smtp/actions.ts:109-113`):
```typescript
export async function sendTestEmail(toAddress?: string): Promise<ActionResult> {
  const { auth } = await import("@clerk/nextjs/server"); // lazy: loadable under tsx test runner
  const { userId } = await auth();
  if (!userId) return { ok: false, error: { kind: "unauthenticated" } };
  // ...delegate to core with userId...
}
```

Phase 5 wrappers to create (all this exact shape): `createDraftCampaign(formData)`, `sendTestBatch(formData)`, `buildConfirmSummary(formData)`, `enqueueCampaign(formData)`. Each is `auth() → delegate to *Core(userId, ...)`. Do NOT put userId-accepting logic here (see Shared Pattern: actions split).

---

### `lib/campaign/actions-core.ts` (service, batch + transform)

**Analog:** `lib/smtp/actions-core.ts` (`sendTestVia` lines 156-196; `ActionError`/`ActionResult` union lines 28-41) + `lib/compose/actions-core.ts` (`previewCampaignCore` resolve→read→parse lines 103-143)

**Typed result union** (`lib/smtp/actions-core.ts:28-41`) — closed union of message-only shapes; `raw` is ALWAYS a string, never a raw Error. Copy this shape; add Phase-5 kinds (`already_queued`, `not_found`, `no_smtp_config`, `send_failed`):
```typescript
export type ActionError =
  | { kind: "unauthenticated" }
  | { kind: "validation"; issues: unknown }
  | { kind: "not_found" }
  | { kind: "already_queued" }
  | { kind: "send_failed"; raw: string };
export type ActionResult = { ok: true } | { ok: false; error: ActionError };
```

**Test-send loop seam (TEST-01)** — compose from `sendTestVia` (`lib/smtp/actions-core.ts:156-196`) verify-before-send shape + `lib/smtp/actions.ts:139-160` decrypt+transport+`finally`-close. The batch redirects EVERY personalized message to the one test address:
```typescript
// decrypt server-side only (lib/smtp/actions.ts:139-143)
const password = decrypt({ enc: row.password_enc as Buffer, iv: row.password_iv as Buffer, tag: row.password_tag as Buffer });
const transport = createSmtpTransport({ host: row.host, port: row.port, secure: row.secure, auth: { user: row.username, pass: password } });
try {
  await verifyTransport(transport);                 // CLAUDE.md: verify BEFORE any send (sendTestVia:163-164)
  const from = row.from_name ? `${row.from_name} <${row.from_addr}>` : row.from_addr; // actions-core.ts:178-180
  let sent = 0, failed = 0; const errors: string[] = [];
  for (const r of rows) {                            // rows capped/throttled — A2
    const { subject, body } = fillMessage({ subject: tplSubject, body: tplBody }, r); // lib/core/fill.ts:46
    const res = await sendOne({ transport, from, to: testAddr, subject, body });      // lib/core/send.ts:125
    res.ok ? sent++ : (failed++, errors.push(res.error.message));  // message-only, never raw Error (D-06)
    if (!isLastRowOfChunk) await throttle(TEST_SEND_DELAY_MS); // lib/core/send.ts:143 — throttle BETWEEN sends only (9x500ms per 10-row chunk, matches 05-02 budget rationale)
  }
  return { ok: true, data: { sent, failed, errors } };
} finally {
  transport.close();                                 // actions.ts:157-160 — never leak the socket
}
```

**Confirm-summary seam (TEST-02)** — server-authoritative; follows `previewCampaignCore`'s resolve→read→parse (`lib/compose/actions-core.ts:114-133`), then adds sender identity (DTO) + one merged sample + warning aggregates:
```typescript
const set = await getRecipientSetForUser(userId, recipientSetId);   // IDOR-safe (compose actions-core.ts:114)
if (!set) return { ok: false, error: { kind: "not_found" } };
const { columns, rows } = parseCsv(readUpload(set.storage_path));    // server-side only (actions-core.ts:120-121)
const emailColumn = set.email_column ?? detectEmailColumn(columns, rows);        // actions-core.ts:130
const invalidEmailCount = emailColumn ? countInvalidEmails(rows, emailColumn) : 0; // actions-core.ts:131-133
const cfg = await getSmtpConfigForUser(userId);
if (!cfg) return { ok: false, error: { kind: "no_smtp_config" } };
const dto = toSmtpConfigDto(cfg);                                    // redacted — no password triple (lib/data/smtp.ts:122)
const senderIdentity = dto.from_name ? `${dto.from_name} <${dto.from_addr}>` : dto.from_addr;
const sample = fillMessage({ subject, body }, rows[0]);              // one merged sample (lib/core/fill.ts:46)
// merge-gap aggregates via analyzeMerge(subject+"\n"+body, row, columns) over rows (lib/core/merge.ts:48)
```

**Enqueue seam (TEST-03)** — see Shared Pattern: Atomic enqueue guard. The seam calls the DAL's `enqueueCampaign` and maps `changes !== 1` to `{ kind: "already_queued" }`.

**No "use server" directive in this file.** (See Shared Pattern: actions split.)

---

### `lib/campaign/schema.ts` (config, validation)

**Analog:** `lib/compose/schema.ts` (whole file) + the id coercion in `lib/compose/actions-core.ts:84`

zod 4 idioms only: exported schema object + `export type X = z.infer<typeof schema>`, top-level validators. Reuse the exact id + email coercions:
```typescript
// campaignId / recipientSetId — coerce FormData string to positive int (compose/actions-core.ts:84)
export const campaignIdSchema = z.coerce.number().int().positive();
// test address — mirror the top-level z.email() idiom (smtp/schema.ts:76)
export const testAddressSchema = z.email("Enter a valid email address");
```
A NaN/0/negative id fails as `validation` rather than resolving a bogus row.

---

### `lib/campaign/index.ts` (config, barrel)

**Analog:** `lib/compose/index.ts` (whole file)

Re-export the shared schema + erased types ONLY. Do NOT re-export the Server Actions themselves — a runtime re-export through a barrel that client code imports drags the `"use server"` module into the client bundle. The UI imports actions directly from `@/lib/campaign/actions` (`lib/compose/index.ts:8-13` documents this exact rule).

---

### `lib/data/campaigns.ts` (model, CRUD + atomic UPDATE)

**Analog:** `lib/data/templates.ts` (whole file) for create/get; `lib/data/smtp.ts:106-114` for the UPDATE shape

**createDraftCampaign** — copy `createTemplate` (`lib/data/templates.ts:40-45`) exactly. `userId` LAST in the spread (ownership wins; the a906a8f fix). The `values` type is a `Pick<NewCampaign,...>` that OMITS `userId`:
```typescript
export type PersistableCampaign = Pick<NewCampaign, "recipient_set_id" | "template_id" | "smtp_config_id">;
export function createDraftCampaign(userId: string, values: PersistableCampaign) {
  return db.insert(campaigns).values({ ...values, userId }).returning();  // userId LAST (templates.ts:43)
}
```
Note: all three FKs are NOT NULL (`lib/db/schema.ts:108-116`) — the draft can only be created once template + recipient set + smtp config all exist (Pitfall 2 / A1).

**getCampaignForUser** — copy `getTemplateForUser` (`lib/data/templates.ts:62-65`). `and(eq(id), eq(userId))`, never `eq(id)` alone (IDOR defense).

**enqueueCampaign (TEST-03 atomic guard)** — see Shared Pattern: Atomic enqueue guard. This is the one function without a verbatim analog; its WHERE clause is modeled on `lib/data/smtp.ts:106-114`'s `.update().set().where()` plus the compound `and()` from `getTemplateForUser`.

Import from `@/lib/db` (the sole SQLite opener) — never construct a Database (`lib/data/templates.ts:25`).

---

### `lib/campaign/actions-core.test.ts` (test, batch/transform)

**Analog:** `lib/smtp/actions.test.ts` (whole file — the harness header lines 17-117 and the stub transport lines 76-102)

Copy verbatim: set `DATABASE_PATH` + `CREDENTIAL_ENC_KEY` to temp values BEFORE any DB import (`actions.test.ts:24-29`), then dynamic-import modules + migrator (`:32-37`), `migrate()` in `before()` (`:104-112`), cleanup in `after()` (`:114-117`). Inject the `stubTransport` (`:76-102`) that counts `verify`/`send`.

Phase-5 assertions:
- TEST-01: every row filled; ALL `sendMail` `to` === testAddr; `verify` called once BEFORE any `send` (mirror `:275-285`).
- Redaction: `!JSON.stringify(result).includes(MARKER_PASSWORD)` (`:130`, `:240`) and closed-union key check (`:308-313`).
- TEST-02: summary has correct count, redacted sender (no password), one merged sample, warning aggregates.

---

### `lib/data/campaigns.test.ts` (test, CRUD)

**Analog:** `lib/data/templates.test.ts` (header lines 1-40)

Copy the temp-DB header (`:22-30`), `USER_A`/`USER_B` cross-tenant seeding. Phase-5 assertions:
- `createDraftCampaign` + `getCampaignForUser` IDOR: A's campaign id returns undefined when queried as B.
- Atomic enqueue: call `enqueueCampaign` twice → 1st returns `changes===1`/row, 2nd is a no-op (0 rows) → the double-submit guard (Pitfall 3). A non-owner id is refused.

---

### `components/campaign/test-send-panel.tsx` (component, request-response)

**Analog:** `components/smtp/step-test-send.tsx` (whole file)

Exact pattern: `"use client"`, `useState` for `to`/`sending`/`failure`, a recipient `Input`, a `Button` disabled while `sending` with `Loader2` spinner (`step-test-send.tsx:141-153`), `toast.success` on ok (`:73`), and a `failureFor(error)` switch mapping `ActionError.kind` → human copy with a `Collapsible` "technical details" for `raw` (`:33-53`, `:118-132`). Import the action + `ActionError` type directly from `@/lib/campaign/actions`.

---

### `components/campaign/confirm-send-dialog.tsx` (component, request-response)

**Analog:** `components/ui/dialog.tsx` (exports: `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogFooter`, `DialogClose`) + the async-action + `useState(sending)` + `toast` flow from `components/smtp/step-test-send.tsx:66-78`

Renders the server-authoritative summary (recipient count, sender identity, merged sample, warnings). The confirm `Button` in `DialogFooter` is `disabled={submitting}` (first line of double-submit defense — the real guard is the DB, Shared Pattern below). On confirm: call `enqueueCampaign`, then handle `{ kind:"already_queued" }` as a benign "already sending" toast, not a destructive error. Structure (from `dialog.tsx`):
```tsx
<Dialog open={open} onOpenChange={setOpen}>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Send to {recipientCount} recipients?</DialogTitle>
      <DialogDescription>{senderIdentity}</DialogDescription>
    </DialogHeader>
    {/* merged sample + warnings */}
    <DialogFooter>
      <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
      <Button disabled={submitting} onClick={confirm}>{submitting ? <Loader2 className="animate-spin"/> : null} Send now</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```
`Dialog` is installed; `AlertDialog` is NOT (A4). Use `Dialog`.

---

### `app/(app)/compose/page.tsx` (route wire-in, A6)

**Analog:** itself (`app/(app)/compose/page.tsx:27-36`)

The RSC already re-derives `userId` and lists sets. Phase 5's surface is reachable from here (A6). If the panel/dialog need the saved SMTP config presence or template, load them server-side with the userId-scoped DALs (`getSmtpConfigForUser`, `listTemplatesForUser`) and pass redacted props down — never pass secrets. Follow the existing `auth() → DAL → map to plain props` shape (`:28-36`).

---

## Shared Patterns

### The actions.ts / actions-core.ts split (MANDATORY)
**Source:** `lib/smtp/actions-core.ts:1-13` (rationale) + `lib/smtp/actions.ts:22-34`
**Apply to:** `lib/campaign/actions.ts` + `lib/campaign/actions-core.ts`

Every runtime export of a `"use server"` module is a client-invocable endpoint. So `actions.ts` (has `"use server"`) exports ONLY auth wrappers; ALL userId-accepting logic lives in `actions-core.ts` (NO directive), importable by tests but never wire-callable. Non-negotiable (AUTH-02 / T-*-IDOR / T-*-ENDPOINT).

### userId-scoped DAL + server-injected ownership
**Source:** `lib/data/templates.ts:40-45` (create, userId LAST) + `:62-65` (get, `and(eq(id),eq(userId))`)
**Apply to:** every function in `lib/data/campaigns.ts`

`userId` is the required FIRST param and is filtered on. No fetch-by-id-alone path. On insert, `{ ...values, userId }` with userId LAST so a smuggled `userId` key in `values` can never win (the a906a8f ownership-wins fix). The `values` type OMITS `userId` via `Pick<>`.

### Atomic enqueue guard (TEST-03)
**Source:** RESEARCH.md Pattern 2 (ARCHITECTURE.md claim adapted) + `lib/data/smtp.ts:106-114` (update/set/where shape)
**Apply to:** `lib/data/campaigns.ts::enqueueCampaign` and its `actions-core` caller

One statement flips `draft`→`queued` only if still `draft`; the affected-row count IS the idempotency signal. `user_id` in the WHERE makes the guard simultaneously the IDOR defense.
```typescript
import { and, eq } from "drizzle-orm";
const flipped = await db.update(campaigns)
  .set({ status: "queued" })
  .where(and(eq(campaigns.id, id), eq(campaigns.userId, userId), eq(campaigns.status, "draft")))
  .returning({ id: campaigns.id });
if (flipped.length !== 1) return { ok: false, error: { kind: "already_queued" } };
```
NEVER `SELECT` status then `UPDATE` (TOCTOU race a double-click slips through).

### Credential handling (decrypt transient, DTO redact)
**Source:** `lib/smtp/actions.ts:139-143` (decrypt) + `lib/data/smtp.ts:122-132` (`toSmtpConfigDto`)
**Apply to:** the test-send seam (decrypt) + the confirm-summary seam (DTO for sender identity)

Decrypt the AES-256-GCM triple server-side ONLY; the plaintext lives transiently in a local and never reaches an ActionResult, a throw, or a log (SMTP-04 / D-06 / T-*-LOG). The client only ever receives `toSmtpConfigDto` output, which structurally cannot carry the password triple.

### Reused pure primitives (do NOT re-implement)
**Source / Apply:** `fillMessage` (`lib/core/fill.ts:46`), `sendOne`/`createSmtpTransport`/`verifyTransport`/`throttle` (`lib/core/send.ts:85,111,125,143`), `decrypt` (`lib/crypto`), `parseCsv`/`detectEmailColumn`/`countInvalidEmails` (`lib/core/csv.ts:44,88,119`), `analyzeMerge`/`extractTokens` (`lib/core/merge.ts:33,48`), `readUpload` (`lib/csv/storage.ts:50`). Any new merge/send/crypto/transport code in Phase 5 is a review flag (RESEARCH.md "Key insight").

### node:test harness header
**Source:** `lib/smtp/actions.test.ts:17-117` / `lib/data/templates.test.ts:16-30`
**Apply to:** both Phase-5 test files. Set env BEFORE dynamic imports; `migrate()` onto a throwaway temp DB; inject a stub transport (no live socket). Run via `npm test` (`node --import tsx --test "lib/**/*.test.ts"`).

---

## No Analog Found

None. Every Phase-5 file has a strong in-repo analog. The single function without a verbatim analog — `enqueueCampaign`'s atomic UPDATE — is fully specified by the composition of `lib/data/smtp.ts`'s update shape and the compound-`and()` owner filter from `getTemplateForUser`, per Shared Pattern "Atomic enqueue guard".

## Metadata

**Analog search scope:** `lib/smtp/`, `lib/compose/`, `lib/data/`, `lib/core/`, `lib/csv/`, `lib/db/`, `components/smtp/`, `components/compose/`, `components/ui/`, `app/(app)/`
**Files scanned:** ~20 read in full; full source-tree listed
**Pattern extraction date:** 2026-07-13
