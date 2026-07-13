# Phase 3: CSV Upload + Parsing + Recipient Mapping - Pattern Map

**Mapped:** 2026-07-13
**Files analyzed:** 15 (11 new, 4 modified)
**Analogs found:** 15 / 15 (every new file has an in-repo analog — this phase is composition, not greenfield)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `lib/core/csv.ts` (EXTEND) | utility (pure) | transform | itself (`lib/core/csv.ts`) | exact (same file) |
| `lib/core/csv.test.ts` (EXTEND) | test | transform | itself (`lib/core/csv.test.ts`) | exact (same file) |
| `lib/csv/schema.ts` (NEW) | config (zod) | validation | `lib/smtp/schema.ts` | exact (role + zod-4 idioms) |
| `lib/csv/storage.ts` (NEW) | utility (file I/O) | file-I/O | `lib/db/client.ts` | role-match (env-path resolver + mkdirSync) |
| `lib/csv/storage.test.ts` (NEW) | test | file-I/O | `lib/data/smtp.test.ts` (tmpdir harness) | role-match |
| `lib/csv/actions.ts` (NEW) | controller (Server Action) | request-response | `lib/smtp/actions.ts` | exact (`"use server"` + `auth()` seam) |
| `lib/csv/actions-core.ts` (NEW) | service (testable seam) | request-response | `lib/smtp/actions-core.ts` | exact (no-`"use server"` core, userId injection) |
| `lib/csv/actions-core.test.ts` (NEW) | test | request-response | `lib/data/smtp.test.ts` (dyn-import + tmp DB) | role-match |
| `lib/data/recipients.ts` (NEW) | model (DAL) | CRUD | `lib/data/smtp.ts` | exact (userId-first DAL) |
| `lib/data/recipients.test.ts` (NEW) | test | CRUD | `lib/data/smtp.test.ts` | exact (IDOR isolation harness) |
| `lib/data/index.ts` (EDIT) | config (barrel) | — | itself | exact (append exports) |
| `app/(app)/recipients/page.tsx` (NEW) | route (RSC) | request-response | `app/(app)/settings/smtp/page.tsx` + `app/(app)/dashboard/page.tsx` | exact (auth→DAL→DTO; empty-state list) |
| `components/recipients/csv-uploader.tsx` (NEW) | component (client) | request-response | `components/smtp/smtp-wizard.tsx` + `components/smtp/step-test-send.tsx` | exact (RHF+zod shell; action-call+pending) |
| `components/app-sidebar.tsx` (EDIT) | component (client) | — | itself (documented placeholder) | exact (add NAV_ITEMS slot) |
| `next.config.ts` (EDIT) | config | — | itself | exact (add experimental key) |

**Barrel note:** RESEARCH.md's structure omits `lib/csv/index.ts`; `lib/smtp/index.ts` and `lib/data/index.ts` both exist as barrels. Add a `lib/csv/index.ts` barrel and extend `lib/data/index.ts` to match the established import-surface convention (see Shared Pattern: Barrel exports).

---

## Pattern Assignments

### `lib/core/csv.ts` (utility, transform) — EXTEND

**Analog:** itself (`lib/core/csv.ts` lines 1-69) — the two new functions are **additive**; keep `parseCsv`'s signature and its literal-`"email"` `invalidEmailCount` intact so the 9 existing tests still pass (RESEARCH.md line 297).

**Existing exports to preserve** (lines 17-33): `type Row = Record<string, string>`, `interface ParsedCsv`, and the module-level `EMAIL_RE` regex:
```typescript
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;  // line 33 — REUSE, do not redeclare
export type Row = Record<string, string>;        // line 17 — the shared row shape
```

**Purity contract to honor** (lines 11-13 docblock): imports only papaparse — no `node:fs`, DB, Clerk, or Next. The new `detectEmailColumn` / `countInvalidEmails` are pure functions over already-parsed `columns`/`rows` (RESEARCH.md lines 265-296 gives the full implementations to copy).

**Detection function to add** (RESEARCH.md lines 271-289): two-stage — normalized header-name match (`NAME_HINTS`), then content-sampling fallback (first 50 rows, `EMAIL_RE` hit-rate > 0.7). Reuse the file's existing `EMAIL_RE`.

---

### `lib/core/csv.test.ts` (test, transform) — EXTEND

**Analog:** itself (`lib/core/csv.test.ts` lines 1-67).

**Test-file conventions to copy** (lines 1-8):
```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
const { parseCsv } = await import("./csv");   // dynamic import, extensionless — tsx resolver
```
Note the extensionless `./csv` import + top-level `await import` — this is why the suite runs under `tsx --test`, not bare `node --test` (RESEARCH.md line 375). One `test(name, () => {...})` per behavior with `assert.deepEqual`/`assert.equal` (lines 10-66). Add cases per RESEARCH.md Wave 0: name-match, substring-reject (`mailing_city`), content-sampling fallback, no-email→null, and `countInvalidEmails` on an arbitrary column.

---

### `lib/csv/schema.ts` (config, validation) — NEW

**Analog:** `lib/smtp/schema.ts` (lines 1-94).

**Imports + zod-4 idioms** (line 22): `import { z } from "zod";` — top-level `z.email()`, `z.coerce.number()`, no zod-3 chained `.string().email()` (RESEARCH.md line 36, schema.ts docblock lines 16-19).

**Exported-const + inferred-type pattern** (lines 57-93): export the schema object AND `export type X = z.infer<typeof schema>` so client (RHF resolver) and server (action parse) share ONE schema and can never diverge (docblock lines 4-5):
```typescript
export const smtpFormSchema = z.object({ /* ... */ });
export type SmtpFormValues = z.infer<typeof smtpFormSchema>;
```

**Field-message convention** (lines 58-77): every rule carries a sentence-case user message, e.g. `.min(1, "Host is required")`, matching the UI-SPEC copy contract. For Phase 3 use RESEARCH.md lines 300-308: `MAX_UPLOAD_BYTES = 4*1024*1024`, `MAX_ROWS = 5000`, and `confirmColumnSchema = z.object({ emailColumn: z.string().min(1, "Choose the email column") })`. Add mime/extension/size guards mirroring the field-message style.

---

### `lib/csv/storage.ts` (utility, file-I/O) — NEW

**Analog:** `lib/db/client.ts` (lines 15-47) — the env-configured path resolver + `mkdirSync` pattern.

**Imports + env-path resolution** (client.ts lines 15-27):
```typescript
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
// Prod: Coolify secret sets the path; dev falls back to ./data/*
const DATABASE_PATH = resolve(process.env.DATABASE_PATH ?? "./data/app.db");
```
Mirror this exactly for `UPLOADS_DIR = resolve(process.env.UPLOADS_PATH ?? "./data/uploads")` (RESEARCH.md lines 190-198).

**mkdir-before-write** (client.ts line 39): `mkdirSync(dirname(PATH), { recursive: true })` before opening/writing. Full `writeUpload(bytes)` implementation with `randomUUID()` filename + **relative** return path is in RESEARCH.md lines 193-198 — copy verbatim. Security rationale: user filename never touches the path (traversal-proof), store `<uuid>.csv` relative and resolve at read time (RESEARCH.md Pitfall 4, lines 255-257).

---

### `lib/csv/storage.test.ts` (test, file-I/O) — NEW

**Analog:** `lib/data/smtp.test.ts` (lines 14-27, 76-79) — the tmpdir provisioning harness.

**Temp-dir + env-before-import harness** (smtp.test.ts lines 16-27):
```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const TMP_DIR = mkdtempSync(join(tmpdir(), "smtp-dal-"));
process.env.DATABASE_PATH = join(TMP_DIR, "app.db");  // set env BEFORE dynamic import
```
For storage: set `process.env.UPLOADS_PATH` to a fresh `mkdtempSync` dir, then `await import("./storage")`. **Cleanup** in `after()` (lines 76-79): `rmSync(TMP_DIR, { recursive: true, force: true })`. Assert `writeUpload` returns a relative `<uuid>.csv` (not the user filename), the dir is created, and bytes round-trip (RESEARCH.md line 395).

---

### `lib/csv/actions.ts` (controller / Server Action, request-response) — NEW

**Analog:** `lib/smtp/actions.ts` (lines 1-100).

**`"use server"` + lazy-Clerk `auth()` gate** (actions.ts lines 1, 63-73):
```typescript
"use server";
export async function parseUploadedCsv(formData: FormData): Promise<ActionResult> {
  // Lazy import: @clerk/nextjs/server resolves only under the Next server runtime,
  // so importing it lazily keeps the module loadable under the plain test runner.
  const { auth } = await import("@clerk/nextjs/server");
  const { userId } = await auth();
  if (!userId) return { ok: false, error: { kind: "unauthenticated" } };
  return parseUploadedCsvCore(userId, formData);  // delegate to actions-core
}
```

**Endpoint-surface discipline** (actions.ts docblock lines 22-27): this file exports ONLY client-invocable actions; each re-derives `userId` server-side and passes it down. The `userId`-accepting seams live in `actions-core.ts` (no `"use server"`) so a client can't bypass `auth()`. Type-only re-exports are erased and safe (actions.ts lines 52-54): `export type { ActionError, ActionResult } from "./actions-core";`

**FormData File-bytes read** (RESEARCH.md lines 202-208):
```typescript
const file = formData.get("file");
if (!(file instanceof File)) return { ok: false, error: { kind: "validation" } };
const bytes = Buffer.from(await file.arrayBuffer());
const parsed = parseCsv(bytes);   // lib/core/csv.ts accepts Buffer
```

---

### `lib/csv/actions-core.ts` (service / testable seam, request-response) — NEW

**Analog:** `lib/smtp/actions-core.ts` (lines 1-147).

**No-`"use server"` core rationale** (docblock lines 1-13): plain server-side functions taking a caller-supplied `userId` for test injection; importable by `actions.ts` and tests, never wire-callable.

**Typed closed-union result contract** (lines 28-41) — copy this shape exactly so the client can pattern-match:
```typescript
export type ActionError =
  | { kind: "unauthenticated" }
  | { kind: "validation"; issues: unknown }
  | { kind: "unknown"; field: string; raw: string }
  /* ...phase-3 kinds: "too_large" | "too_many_rows" | "parse_error" | "wrong_type" ... */ ;
export type ActionResult = { ok: true; data?: ... } | { ok: false; error: ActionError };
```

**Injectable-seam signature** (lines 78-82): `export async function applyVerifiedConfig(userId, input, verifyFn = realFn)` — the core takes `userId` first, then input, then any injectable dependency with a real default. For Phase 3: `parseUploadedCsvCore(userId, formData)` and `saveRecipientSetCore(userId, formData, deps?)`.

**Parse-then-guard-then-persist flow** (lines 86-146): `schema.safeParse(input)` → on `!success` return `{ ok: false, error: { kind: "validation", issues: parsed.error.issues } }` → do work → return `{ ok: true }`. The save seam should re-validate + re-count on the CONFIRMED column, then call `writeUpload` and `createRecipientSet` (RESEARCH.md lines 97-107). **Orphan avoidance** (RESEARCH.md Pitfall 5): write bytes ONLY in the save step, after validation passes, in the same call that inserts the row.

---

### `lib/csv/actions-core.test.ts` (test, request-response) — NEW

**Analog:** `lib/data/smtp.test.ts` (lines 14-38) — dynamic-import + tmp-DB harness (there is no `smtp/actions-core.test.ts`; the DAL test is the closest injection-style harness; `lib/smtp/actions.test.ts` also exists for reference).

**Harness** (smtp.test.ts lines 14-38): `node:test` + `node:assert/strict`, set `process.env.DATABASE_PATH`/`UPLOADS_PATH` to tmp dirs BEFORE `await import(...)`, run committed migrations in `before()`. Test the seam by calling `parseUploadedCsvCore(USER_A, formData)` / `saveRecipientSetCore(...)` directly with an injected `userId` — covers CSV-01/CSV-03: userId injection, mime/size/row-cap rejection, override honored (RESEARCH.md line 394).

---

### `lib/data/recipients.ts` (model / DAL, CRUD) — NEW

**Analog:** `lib/data/smtp.ts` (lines 29-98) — the userId-first DAL. RESEARCH.md lines 141-166 gives the ready-to-copy implementation.

**Imports** (smtp.ts lines 29-36):
```typescript
import { and, eq, desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { recipient_sets, type NewRecipientSet } from "@/lib/db/schema";
```
(`recipient_sets`, `RecipientSet`, `NewRecipientSet` already exist — schema.ts lines 71-80, 170-171.)

**userId-first rule** (smtp.ts lines 75-81, 90-98): EVERY function takes `userId` as required first param and filters on it; there is NO fetch-by-id path without an owner filter (docblock lines 5-11). For a by-id read use `and(eq(id), eq(userId))` — never `eq(id)` alone (RESEARCH.md lines 161-166, the structural IDOR defense):
```typescript
export function getRecipientSetForUser(userId: string, id: number) {
  return db.query.recipient_sets.findFirst({
    where: and(eq(recipient_sets.id, id), eq(recipient_sets.userId, userId)),
  });
}
```

**`Pick<NewModel, ...>` value-typing** (smtp.ts lines 43-54): type the insert `values` param as `Pick<NewRecipientSet, "filename" | "columns_json" | "row_count" | "storage_path">` so columns stay in lockstep with the schema (RESEARCH.md lines 147-152). Persist `userId` inside the DAL, never from the client.

---

### `lib/data/recipients.test.ts` (test, CRUD) — NEW

**Analog:** `lib/data/smtp.test.ts` (lines 1-167) — near-verbatim template.

**Two-tenant IDOR harness** (lines 40-41, 59-95): define `USER_A`/`USER_B`, seed a set for each in `before()` (after `migrate(db, { migrationsFolder: "./drizzle" })`, line 61), then assert User A's reads NEVER return User B's row and A's writes never mutate B (lines 81-125). Covers CSV-05 / AUTH-02 (RESEARCH.md line 396). Env-before-import + `after()` cleanup exactly as lines 20-27 / 76-79.

---

### `app/(app)/recipients/page.tsx` (route / RSC, request-response) — NEW

**Analog:** `app/(app)/settings/smtp/page.tsx` (lines 1-45) for the auth→DAL→client-props shape; `app/(app)/dashboard/page.tsx` (lines 33-59) for the empty-state-vs-list branch.

**RSC auth + scoped load** (smtp/page.tsx lines 1-21):
```typescript
import { auth } from "@clerk/nextjs/server";
export default async function RecipientsPage() {
  const { userId } = await auth();
  const sets = userId ? await listRecipientSetsForUser(userId) : [];
  // ...pass server-loaded data to the client component
}
```

**Page-heading + spacing contract** (smtp/page.tsx lines 29-40, dashboard lines 40-41): outer `<div className="flex flex-col gap-8">`, `<h1 className="text-[28px] font-semibold leading-[1.2]">Recipients</h1>`, muted `<p className="text-base text-muted-foreground">`. Matches UI-SPEC Typography (Display 28px, once per page) and Spacing (`gap-8`).

**Empty-state callout** (dashboard lines 38-58): when `sets.length === 0`, render the dominant `<Card className="py-12">` with centered `CardHeader`/`CardTitle`/`CardDescription` and a single accent `<Button asChild><Link ...>` CTA. Use UI-SPEC copy: heading "Upload your first recipient list", CTA "Upload CSV". When sets exist, render the saved-set list (newest first) + the uploader.

---

### `components/recipients/csv-uploader.tsx` (component / client, request-response) — NEW

**Analog:** `components/smtp/smtp-wizard.tsx` (lines 1-149) for the RHF+zod client shell; `components/smtp/step-details.tsx` (FormField blocks) for field markup; `components/smtp/step-test-send.tsx` (lines 62-78) for the action-call + pending + failure pattern; `step-verify.tsx` line 150 for the success toast.

**Client shell + RHF+zod resolver** (smtp-wizard.tsx lines 1-16, 85-106):
```typescript
"use client";
import { useForm, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Form } from "@/components/ui/form";
const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: {...} });
```

**FormField field-anchored markup** (step-details.tsx lines 65-79) — the wrapper for each control, with `<FormMessage />` giving field-anchored errors (UI-SPEC: field-anchored validation):
```typescript
<FormField control={form.control} name="..." render={({ field }) => (
  <FormItem>
    <FormControl>{/* Input / Select */}</FormControl>
    <FormMessage />
  </FormItem>
)} />
```

**Action-call + pending + failure-map** (step-test-send.tsx lines 30-78):
```typescript
const [pending, setPending] = useState(false);
const [failure, setFailure] = useState<Failure | null>(null);
async function submit() {
  setPending(true); setFailure(null);
  const res = await parseUploadedCsv(formData);   // or saveRecipientSet(...)
  setPending(false);
  if (res.ok) { toast.success("Recipient list saved — ..."); return; }
  setFailure(failureFor(res.error));   // switch over res.error.kind
}
```
Buttons disable while `pending` (no double-submit — UI-SPEC Interaction rules); in-flight copy swaps to "Reading your file…" / "Saving…" with `<Loader2>`.

**Toast host is already mounted** (`app/(app)/layout.tsx` line 40) — `import { toast } from "sonner"` and call `toast.success(...)` directly (step-verify.tsx line 150). Do NOT mount another Toaster.

**New shadcn components** (UI-SPEC line 133): run `npx shadcn@latest add select table` — `select`/`table` are absent (`components/ui/` currently: alert, badge, button, card, collapsible, dialog, form, input, label, radio-group, separator, sheet, sidebar, skeleton, sonner, tooltip). Both are official shadcn blocks — no vetting gate.

---

### `components/app-sidebar.tsx` (component / client) — EDIT

**Analog:** itself — the file documents this exact placeholder (lines 62-67).

**Add a NAV_ITEMS slot** (lines 5, 30-33): import the `Users` lucide icon and append `{ title: "Recipients", href: "/recipients", icon: Users }` to the `NAV_ITEMS` array. The existing `.map` + `isActive` accent logic (lines 47-61) renders it automatically — no structural change (UI-SPEC line 138, RESEARCH.md line 134).

---

### `next.config.ts` (config) — EDIT

**Analog:** itself (lines 3-10) — add one key to the existing `NextConfig` object.

**Add the Server Action body limit** (RESEARCH.md lines 236-240, Pitfall 1) beside the existing `output`/`serverExternalPackages`:
```typescript
experimental: { serverActions: { bodySizeLimit: "4mb" } },
```
Keep in step with `MAX_UPLOAD_BYTES` (4 MB) so the zod guard rejects with a clear message before the platform limit bites silently.

---

## Shared Patterns

### Authentication / tenancy (userId-first)
**Source:** `lib/smtp/actions.ts` lines 63-73 (`auth()` gate) + `lib/data/smtp.ts` lines 75-98 (userId-first DAL).
**Apply to:** `lib/csv/actions.ts`, `lib/data/recipients.ts`, `app/(app)/recipients/page.tsx`.
Every Server Action re-derives `userId` via `await auth()` server-side and returns `{ ok: false, error: { kind: "unauthenticated" } }` when absent; the DAL always filters on that server-derived `userId`; a client-supplied id is never trusted (structural IDOR defense, AUTH-02).

### Server-Action seam split (`actions.ts` ⇄ `actions-core.ts`)
**Source:** `lib/smtp/actions.ts` docblock lines 22-27 + `lib/smtp/actions-core.ts` docblock lines 1-13.
**Apply to:** all of `lib/csv/actions*.ts`.
`"use server"` file exports ONLY client-invocable actions (each `auth()`-gated); the `userId`-accepting, dependency-injectable logic lives in a no-`"use server"` core so tests can drive it without a live runtime and clients can't reach it. Lazy-import `@clerk/nextjs/server` inside the action (keeps the module test-loadable). Re-export types with `export type { ... }` (erased, not registered as endpoints).

### Typed ActionResult contract
**Source:** `lib/smtp/actions-core.ts` lines 28-41.
**Apply to:** `lib/csv/actions-core.ts` + consumed by `components/recipients/csv-uploader.tsx`.
A closed discriminated union: `{ ok: true } | { ok: false; error: ActionError }`, where `ActionError` is a union of `{ kind: ... }` shapes and any `raw` is ALWAYS a string (never a raw Error or file bytes). The client switches over `error.kind` (step-test-send.tsx `failureFor`, lines 33-53) to map to copy.

### Shared zod schema (client + server)
**Source:** `lib/smtp/schema.ts` lines 57-93.
**Apply to:** `lib/csv/schema.ts`, consumed by both `csv-uploader.tsx` (RHF resolver) and `actions-core.ts` (`safeParse`).
ONE exported schema object + `z.infer` type, zod-4 idioms, sentence-case field messages. Validation can never diverge between client and server.

### Env-configured path resolver + mkdir
**Source:** `lib/db/client.ts` lines 15-47.
**Apply to:** `lib/csv/storage.ts`.
`resolve(process.env.X_PATH ?? "./data/...")` at module load; `mkdirSync(dir, { recursive: true })` before writing. Centralize the resolver in one module so dev/prod path portability lives in a single place.

### Test harness (env-before-import + tmp dir + committed migrations)
**Source:** `lib/data/smtp.test.ts` lines 14-38, 59-79.
**Apply to:** `recipients.test.ts`, `storage.test.ts`, `actions-core.test.ts`.
`node:test` + `node:assert/strict`; set `process.env.*_PATH` to `mkdtempSync` dirs BEFORE any `await import(...)` that opens the DB/resolves a path; run `migrate(db, { migrationsFolder: "./drizzle" })` in `before()`; `rmSync(..., { recursive: true, force: true })` in `after()`. Run with `tsx --test`, NOT bare `node --test` (extensionless imports + type-stripping). No `test` script exists in `package.json` yet — RESEARCH.md line 398 asks to add `"test": "tsx --test \"lib/**/*.test.ts\""`.

### Barrel exports (import surface)
**Source:** `lib/data/index.ts` (full file) + `lib/smtp/index.ts`.
**Apply to:** add `lib/csv/index.ts`; extend `lib/data/index.ts` with the recipients DAL exports.
Modules re-export their public functions/types through an `index.ts` barrel so consumers import from `@/lib/data` / `@/lib/csv`, keeping the userId-scoped invariant behind one surface.

### UI design-system contract (page shell)
**Source:** `app/(app)/settings/smtp/page.tsx` lines 29-44 + `app/(app)/dashboard/page.tsx` lines 40-58.
**Apply to:** `app/(app)/recipients/page.tsx`, `components/recipients/csv-uploader.tsx`.
`flex flex-col gap-8` page container; `text-[28px] font-semibold leading-[1.2]` h1 once; Card-based layout; `text-sm text-muted-foreground` for muted labels; empty-state `Card className="py-12"`. Inherit 02-UI-SPEC tokens verbatim — do not add palette tokens. Invalid-row count is INFORMATIONAL (`text-muted-foreground` + `AlertCircle`), never destructive (UI-SPEC Color contract).

---

## No Analog Found

None. Every new file maps to an in-repo analog. The only genuinely new logic (per RESEARCH.md) is two small pure functions and a file resolver, all of which reuse existing primitives:

| File | New logic | Basis (not a full analog, but a proven primitive) |
|------|-----------|----------------------------------------------------|
| `lib/core/csv.ts` | `detectEmailColumn` heuristic | reuses existing `EMAIL_RE` + `Row` type; full impl in RESEARCH.md lines 271-289 |
| `lib/csv/storage.ts` | `writeUpload` | `randomUUID` + `mkdirSync`/`resolve` mirror `lib/db/client.ts`; full impl in RESEARCH.md lines 193-198 |

---

## Metadata

**Analog search scope:** `lib/core/`, `lib/smtp/`, `lib/data/`, `lib/db/`, `app/(app)/`, `components/`, `components/ui/`, `next.config.ts`, `package.json`.
**Files scanned (read in full or targeted):** `lib/core/csv.ts`, `lib/core/csv.test.ts`, `lib/data/smtp.ts`, `lib/data/smtp.test.ts`, `lib/data/index.ts`, `lib/db/client.ts`, `lib/db/schema.ts` (recipient_sets region), `lib/smtp/actions.ts`, `lib/smtp/actions-core.ts`, `lib/smtp/schema.ts`, `components/smtp/smtp-wizard.tsx`, `components/smtp/step-test-send.tsx`, `components/app-sidebar.tsx`, `app/(app)/settings/smtp/page.tsx`, `app/(app)/dashboard/page.tsx`, `next.config.ts`.
**Pattern extraction date:** 2026-07-13
