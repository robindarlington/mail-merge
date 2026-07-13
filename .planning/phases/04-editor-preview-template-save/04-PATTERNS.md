# Phase 4: Editor + Preview + Template Save - Pattern Map

**Mapped:** 2026-07-13
**Files analyzed:** 18 (14 new, 4 modified)
**Analogs found:** 18 / 18 (every new file has a same-repo analog — this is a composition-over-invention phase)

## File Classification

| New/Modified File | New/Mod | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|---------|------|-----------|----------------|---------------|
| `lib/core/merge.ts` | NEW | utility (pure engine) | transform | `lib/core/fill.ts` | exact |
| `lib/core/merge.test.ts` | NEW | test | transform | `lib/core/fill.test.ts` | exact |
| `lib/core/index.ts` | MOD | barrel | — | `lib/core/index.ts` (self) | exact |
| `lib/csv/storage.ts` (add `readUpload`) | MOD | utility | file-I/O | `lib/csv/storage.ts` `writeUpload` (self) | exact |
| `lib/csv/storage.test.ts` (extend) | MOD | test | file-I/O | `lib/csv/storage.test.ts` (self) | exact |
| `lib/data/templates.ts` | NEW | model / DAL | CRUD | `lib/data/recipients.ts` | exact |
| `lib/data/templates.test.ts` | NEW | test | CRUD | `lib/data/recipients.test.ts` | exact |
| `lib/data/index.ts` | MOD | barrel | — | `lib/data/index.ts` (self) | exact |
| `lib/compose/schema.ts` | NEW | config / validation | — | `lib/csv/schema.ts` | role-match |
| `lib/compose/schema.test.ts` | NEW | test | — | `lib/csv/schema.test.ts` | role-match |
| `lib/compose/actions.ts` | NEW | controller (Server Action) | request-response | `lib/csv/actions.ts` | exact |
| `lib/compose/actions-core.ts` | NEW | service (testable seam) | request-response + CRUD | `lib/csv/actions-core.ts` | exact |
| `lib/compose/index.ts` | NEW | barrel | — | `lib/csv/index.ts` | exact |
| `app/(app)/compose/page.tsx` | NEW | route (RSC page) | request-response | `app/(app)/recipients/page.tsx` | exact |
| `components/compose/compose-editor.tsx` | NEW | component (client) | event-driven | `components/recipients/csv-uploader.tsx` | exact |
| `components/compose/merge-field-menu.tsx` | NEW | component (client) | event-driven | `components/recipients/csv-uploader.tsx` (Select block) | role-match |
| `components/compose/preview-stepper.tsx` | NEW | component (client) | event-driven | `components/recipients/csv-uploader.tsx` (review block) | partial |
| `components/app-sidebar.tsx` (add nav slot) | MOD | nav | — | `components/app-sidebar.tsx` (self) | exact |

---

## Pattern Assignments

### `lib/core/merge.ts` (utility, transform)

**Analog:** `lib/core/fill.ts` — same purity contract (no DB/Clerk/Next imports; browser-safe). Reuse its exact `TOKEN` regex.

**Header/purity comment + TOKEN regex** (`lib/core/fill.ts` lines 22-24):
```typescript
// Matches `{{column}}` with optional inner whitespace, e.g. `{{name}}` or
// `{{ name }}`. The captured group is the trimmed-around column key.
const TOKEN = /\{\{\s*([\w.-]+)\s*\}\}/g;
```

**Pure-function shape to copy** (`lib/core/fill.ts` lines 36-40): callback-based `.replace`, typed `Row = Record<string, string>`, JSDoc stating the pass-through rule. The new `extractTokens`/`analyzeMerge` (RESEARCH lines 271-299) follow the same "takes text + row, returns typed value, mutates nothing" style.

**Key classification rule (Pitfall 1):** `fill` leaves an unknown token literal (`fill.ts` lines 26-40). `analyzeMerge` must distinguish `empty` (key IS a column, value blank) from `unknown` (key NOT a column) — see RESEARCH lines 280-299 for the exact target signature. This classification powers BOTH the per-row gap highlight AND the client-side report aggregates in `preview-stepper.tsx` (Plan 05).

**Barrel update** (`lib/core/index.ts` lines 9-13): add alongside the `fill` export:
```typescript
export { fill, fillMessage } from "./fill";
export type { Row as FillRow, MessageTemplate } from "./fill";
// ADD:
export { extractTokens, analyzeMerge } from "./merge";
export type { MergeAnalysis } from "./merge";
```

---

### `lib/core/merge.test.ts` (test, transform)

**Analog:** `lib/core/fill.test.ts` — verbatim structure.

**Test harness pattern** (`lib/core/fill.test.ts` lines 1-8):
```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
const { fill, fillMessage } = await import("./fill");
```
Pure-logic tests use a top-level dynamic import and one `test(...)` per behavior with `assert.equal`/`assert.deepEqual` (lines 10-48). Cover: token extraction/de-dup/order, `empty` vs `unknown` vs `present` classification (PREV-02/03), whitespace-in-braces tolerance.

---

### `lib/csv/storage.ts` — add `readUpload` (utility, file-I/O)

**Analog:** the existing `writeUpload` in the SAME file (`lib/csv/storage.ts`). Mirror its `UPLOADS_DIR` resolver exactly; add the traversal-escape prefix check.

**Existing env-path resolver to reuse (do NOT redeclare a second one)** (`lib/csv/storage.ts` lines 25, 31-36):
```typescript
const UPLOADS_DIR = resolve(process.env.UPLOADS_PATH ?? "./data/uploads");

export function writeUpload(bytes: Buffer): { storagePath: string } {
  mkdirSync(UPLOADS_DIR, { recursive: true });
  const name = `${randomUUID()}.csv`; // opaque — user filename never in the path
  writeFileSync(resolve(UPLOADS_DIR, name), bytes);
  return { storagePath: name }; // store RELATIVE; resolve at read time (Pitfall 4)
}
```

**`readUpload` to add** (RESEARCH Pattern 4, lines 194-204) — add `readFileSync` + `sep` to the existing `node:fs` / `node:path` imports:
```typescript
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
export function readUpload(storagePath: string): Buffer {
  const full = resolve(UPLOADS_DIR, storagePath);
  if (full !== UPLOADS_DIR && !full.startsWith(UPLOADS_DIR + sep)) {
    throw new Error("resolved upload path escaped the uploads directory");
  }
  return readFileSync(full);
}
```
**Critical (Pitfall 3 / IDOR):** `storagePath` MUST come from a userId-scoped `getRecipientSetForUser` row, never from the client. Also re-export from `lib/csv/index.ts` line 24 next to `writeUpload`.

---

### `lib/csv/storage.test.ts` — extend for `readUpload` (test, file-I/O)

**Analog:** the same file. Reuse its module-load-order idiom (`lib/csv/storage.test.ts` lines 20-29):
```typescript
const TMP_DIR = mkdtempSync(join(tmpdir(), "csv-storage-"));
const UPLOADS_DIR = join(TMP_DIR, "uploads");
process.env.UPLOADS_PATH = UPLOADS_DIR;   // set BEFORE the dynamic import
const { writeUpload } = await import("./storage");  // → add readUpload here
after(() => { rmSync(TMP_DIR, { recursive: true, force: true }); });
```
Add: write→read round-trip returns original bytes (mirror lines 54-59), and a traversal-escape case (`readUpload("../../etc/passwd")` throws).

---

### `lib/data/templates.ts` (model / DAL, CRUD)

**Analog:** `lib/data/recipients.ts` — copy its shape verbatim; the `templates` table already exists (`lib/db/schema.ts` lines 92-98, standalone userId/subject/body).

**userId-first DAL pattern** (`lib/data/recipients.ts` lines 21-70):
```typescript
import { and, eq, desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { templates, type NewTemplate } from "@/lib/db/schema";

// userId deliberately OMITTED — server-injected, never caller-supplied (T-3-TAMPER-OWNER)
export type PersistableTemplate = Pick<NewTemplate, "subject" | "body">;

export function createTemplate(userId: string, values: PersistableTemplate) {
  return db.insert(templates).values({ userId, ...values }).returning();
}

export function listTemplatesForUser(userId: string) {
  return db.query.templates.findMany({
    where: eq(templates.userId, userId),
    orderBy: desc(templates.created_at),
  });
}

// IDOR defense: and(eq(id), eq(userId)) — NEVER eq(id) alone (T-3-IDOR / AUTH-02)
export function getTemplateForUser(userId: string, id: number) {
  return db.query.templates.findFirst({
    where: and(eq(templates.id, id), eq(templates.userId, userId)),
  });
}
```
**Barrel update** (`lib/data/index.ts` lines 20-25): add a `createTemplate`/`getTemplateForUser`/`listTemplatesForUser` + `PersistableTemplate` export block mirroring the recipients block.

---

### `lib/data/templates.test.ts` (test, CRUD)

**Analog:** `lib/data/recipients.test.ts` — copy the cross-tenant isolation harness verbatim.

**Temp-DB-before-import + migrate pattern** (`lib/data/recipients.test.ts` lines 15-29, 49-51):
```typescript
const TMP_DIR = mkdtempSync(join(tmpdir(), "templates-dal-"));
process.env.DATABASE_PATH = join(TMP_DIR, "app.db");  // BEFORE any DB import
const { db, connection } = await import("@/lib/db");
const { createTemplate, listTemplatesForUser, getTemplateForUser } = await import("./templates");
const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
// before(): migrate(db, { migrationsFolder: "./drizzle" });
```
Required cases (mirror lines 86-140): create persists server-supplied userId; list is owner-scoped + newest-first; `getTemplateForUser` returns the owner's row; **cross-tenant get returns `undefined` (IDOR)** — the EDIT-04 security assertion. Use two user ids `USER_A`/`USER_B` (lines 31-32).

---

### `lib/compose/schema.ts` (config / validation)

**Analog:** `lib/csv/schema.ts` — the shared-zod-object + `z.infer` idiom, one schema parsed on BOTH client resolver and server.

**Shared-schema idiom** (`lib/csv/schema.ts` lines 18, 35-52, 58-62):
```typescript
import { z } from "zod";
export const composeFormSchema = z.object({
  subject: z.string().trim().min(1, "Add a subject before saving.").max(998, /* RFC 5322 line cap, A7 */),
  body: z.string().trim().min(1, "Write a message before saving."),
});
export type ComposeFormValues = z.infer<typeof composeFormSchema>;
```
Notes: sentence-case messages sourced from UI-SPEC lines 136-137 ("Add a subject before saving." / "Write a message before saving."). `zod` `^4.4` idioms only (top-level validators, no chained zod-3 string forms — see `lib/smtp/schema.ts` header). Length caps per RESEARCH A7 (line 346).

---

### `lib/compose/schema.test.ts` (test)

**Analog:** `lib/csv/schema.test.ts`. Standard `node:test` + `assert` unit tests over `composeFormSchema.safeParse(...)`: non-empty subject/body pass, blank fails with the anchored message, over-cap subject fails.

---

### `lib/compose/actions.ts` (controller / Server Action, request-response)

**Analog:** `lib/csv/actions.ts` — verbatim auth-boundary pattern. This is the ONLY `"use server"` file in the subsystem.

**Auth-wrapper pattern** (`lib/csv/actions.ts` lines 1, 25-71):
```typescript
"use server";

import {
  previewCampaignCore,
  saveTemplateCore,
  type PreviewResult,
  type SaveResult,
} from "./actions-core";

// Type-only re-exports are erased — NOT registered as server actions.
export type { PreviewReport, PreviewResult, SaveResult, ActionError } from "./actions-core";

export async function previewCampaign(formData: FormData): Promise<PreviewResult> {
  // Lazy import keeps the module loadable under the plain node:test runner.
  const { auth } = await import("@clerk/nextjs/server");
  const { userId } = await auth();
  if (!userId) return { ok: false, error: { kind: "unauthenticated" } };
  return previewCampaignCore(userId, formData);
}

export async function saveTemplate(formData: FormData): Promise<SaveResult> {
  const { auth } = await import("@clerk/nextjs/server");
  const { userId } = await auth();
  if (!userId) return { ok: false, error: { kind: "unauthenticated" } };
  return saveTemplateCore(userId, formData);
}
```
**Critical:** export ONLY the two async actions at runtime (every runtime export of a `"use server"` module is a client-callable endpoint). All types are type-only re-exports.

---

### `lib/compose/actions-core.ts` (service / testable seam, request-response + CRUD)

**Analog:** `lib/csv/actions-core.ts` — the no-directive, userId-injected seam layer, plus its typed result union.

**Typed result union** (`lib/csv/actions-core.ts` lines 54-75; extend for preview per RESEARCH §"Server action seam" PreviewReport (updated for be94f9c)):
```typescript
export type ActionError =
  | { kind: "unauthenticated" }
  | { kind: "validation"; issues: unknown }
  | { kind: "not_found" }        // recipientSet not owned by caller (IDOR → undefined)
  | { kind: "parse_error" }
  | { kind: "unknown"; raw: string };  // raw is ALWAYS a string, never Error/bytes (D-06)

export type PreviewReport = {
  columns: string[];
  rows: Record<string, string>[];   // fetch-once, step client-side (A4); the client computes template-dependent aggregates from these
  totalRows: number;
  emailColumn: string | null;       // server-resolved To: column (row.email_column ?? detectEmailColumn) — SAME column used for invalidEmailCount
  invalidEmailCount: number;        // server-authoritative, template-INDEPENDENT (Pattern 3 / PREV-03)
};
// NOTE: unknownTokens + rowsWithEmptyValues are NOT here — they depend on the composed subject/body,
// so freezing them at fetch time goes stale as the user types (the natural flow is select-list-first,
// then type). The client (Plan 05) computes them reactively from `rows` via analyzeMerge, over ALL rows.
// Only invalidEmailCount + emailColumn are server-authoritative (both independent of template content).
export type PreviewResult = { ok: true; data: PreviewReport } | { ok: false; error: ActionError };
export type SaveResult = { ok: true; data: { id: number } } | { ok: false; error: ActionError };
```

**Seam body pattern — userId-scoped resolve → read → parse** (`lib/csv/actions-core.ts` lines 121-161, 169-235). `previewCampaignCore` must:
1. `void`-guard/validate `recipientSetId` from FormData (Zod, like lines 173-181).
2. `getRecipientSetForUser(userId, id)` → if `undefined`, return `{ kind: "not_found" }` — **never trust a client path** (Pitfall 3).
3. `readUpload(row.storage_path)` → `parseCsv(bytes)` (server-side; papaparse never ships to browser).
4. Read the persisted `row.email_column` (schema line 84) and fall back to `detectEmailColumn` only if null; compute `countInvalidEmails(rows, emailColumn)` for the authoritative count (`lib/core/csv.ts` line 119). **Do not re-detect when `email_column` is set** — honor the user's confirmed column. Return `emailColumn` + `invalidEmailCount` in the report.
5. Return `{ columns, rows, totalRows, emailColumn, invalidEmailCount }` — the report is template-INDEPENDENT. Do NOT read subject/body and do NOT compute `unknownTokens`/`rowsWithEmptyValues` here; those are template-DEPENDENT and computed client-side (Plan 05) from `rows`, so they never go stale against the composed template.

`saveTemplateCore` mirrors `saveRecipientSetCore` (lines 169-235): validate with `composeFormSchema`, then `createTemplate(userId, { subject, body })` — write only after guards pass.

**Imports to reuse:** `import { parseCsv, detectEmailColumn, countInvalidEmails } from "@/lib/core";` and `import { getRecipientSetForUser, createTemplate } from "@/lib/data";` (mirrors lines 26-27). Do NOT import `extractTokens`/`analyzeMerge` into the preview seam — the server never analyzes the composed template.

**Test analog:** `lib/csv/actions-core.test.ts` lines 20-66 — temp `DATABASE_PATH` + `UPLOADS_PATH` before dynamic import, `migrate`, FormData helper. Cover the `invalidEmailCount` + `emailColumn` correctness (persisted + null-fallback), all-rows-returned, the `not_found` cross-tenant path, and save happy/failure (EDIT-04/PREV-03).

---

### `lib/compose/index.ts` (barrel)

**Analog:** `lib/csv/index.ts` lines 1-31. Re-export the schema, `readUpload` helper if needed, and the ERASED types — but **NOT** the `"use server"` actions (a runtime re-export would drag the server module into a client bundle; the UI imports actions directly from `@/lib/compose/actions`). See the explicit note at `lib/csv/index.ts` lines 9-14.

---

### `app/(app)/compose/page.tsx` (route / RSC page, request-response)

**Analog:** `app/(app)/recipients/page.tsx` — RSC that re-derives `userId` and lists via the userId-scoped DAL.

**RSC auth + list pattern** (`app/(app)/recipients/page.tsx` lines 1-6, 39-45):
```typescript
import { auth } from "@clerk/nextjs/server";
import { listRecipientSetsForUser } from "@/lib/data";

export default async function ComposePage() {
  const { userId } = await auth();
  const sets = userId ? await listRecipientSetsForUser(userId) : [];
  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-[28px] font-semibold leading-[1.2]">Compose</h1>
      {/* empty-state Card when sets.length === 0 (UI-SPEC lines 104-106); else <ComposeEditor .../> */}
    </div>
  );
}
```
Pass `sets` (id, filename, `row_count`, `columns_json`) to the client editor as props — the columns feed autocomplete without a round-trip. Empty-state Card mirrors lines 47-59 (`Card className="py-12"`, accent CTA "Go to recipients" → `/recipients`, UI-SPEC line 106).

---

### `components/compose/compose-editor.tsx` (client component, event-driven)

**Analog:** `components/recipients/csv-uploader.tsx` — the definitive client-shell pattern for this repo (RHF + zod resolver, action call, pending state, typed-failure mapping, sonner toast, destructive Alert).

**Client boilerplate + imports** (`csv-uploader.tsx` lines 1-46; resolver from `smtp-wizard.tsx` lines 1-6):
```typescript
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";  // ← smtp-wizard.tsx line 5
import { toast } from "sonner";
import { AlertCircle, AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Loader2, Save } from "lucide-react";
import { previewCampaign, saveTemplate } from "@/lib/compose/actions";
import { composeFormSchema, type ComposeFormValues } from "@/lib/compose/schema";
import { fillMessage, analyzeMerge } from "@/lib/core";  // browser-safe, no deps
```

**RHF form wiring + zodResolver** (`smtp-wizard.tsx` lines 3-5; `csv-uploader.tsx` lines 187-189):
```typescript
const form = useForm<ComposeFormValues>({
  resolver: zodResolver(composeFormSchema),
  defaultValues: { subject: "", body: "" },
});
```

**Action-call + pending + typed-failure mapping** (`csv-uploader.tsx` lines 261-284) — copy the `setSaving(true)` → `await saveTemplate(fd)` → `setSaving(false)` → `res.ok ? toast.success(...) : setSaveError(...)` flow. Field-anchored errors use `form.setError`; server failures use a destructive `Alert` (lines 366-372). The preview fetch (`previewCampaign`) runs ONCE per recipient-list change with FormData carrying only `{ recipientSetId }` — it does NOT send subject/body (the server report is template-independent).

**Live client-side merge (never a server round-trip per step, never `dangerouslySetInnerHTML`):**
```typescript
const merged = fillMessage({ subject, body }, rows[i]);   // { subject, body }
const gaps = analyzeMerge(subject + "\n" + body, rows[i], columns);  // highlight if gaps.empty.length
// render merged.body inside <div className="whitespace-pre-wrap"> — JSX auto-escapes (XSS defense)
```

**Save button (in-flight guard + one accent CTA)** (`csv-uploader.tsx` lines 383-399): disabled while `saving || subject/body empty`, swaps to `<Loader2 className="animate-spin" /> Saving…`. Success toast copy "Template saved." (UI-SPEC line 139).

**Recipient-list Select** (reuse `csv-uploader.tsx` lines 305-316 Select block) drives which set's rows/columns load (calls `previewCampaign` on change).

---

### `components/compose/merge-field-menu.tsx` (client component, event-driven)

**Analog:** the Select block in `csv-uploader.tsx` lines 31-37, 305-316 (import surface) + shadcn `popover` (NEW — `npx shadcn@latest add textarea popover`, wraps already-installed `radix-ui`). RESEARCH A1 (line 340): plain click-to-insert chips (`Button variant="secondary/outline"` or `Badge`) + a `{{`-triggered fixed-position `Popover` list — **NO cmdk, NO caret-geometry** (RESEARCH lines 59, 221). Chips insert `{{column}}` at the focused field's caret. "No matching fields." empty copy (UI-SPEC line 121).

---

### `components/compose/preview-stepper.tsx` (client component, event-driven)

**Analog (partial):** the review-block layout in `csv-uploader.tsx` lines 286-404 (Card + inline `AlertCircle`/`CheckCircle2` status lines + button row). New behavior — row stepping — has no exact analog; build fresh:
- Stepper counter "Recipient {i} of {total}" with `ChevronLeft`/`ChevronRight` outline/ghost `Button`s, disabled at bounds (UI-SPEC lines 125-126).
- Merged To/Subject header + `Separator` + `whitespace-pre-wrap` body.
- Validation report status lines reuse the EXACT Phase-3 invalid-email treatment (`csv-uploader.tsx` lines 324-338): neutral `AlertCircle` + `text-muted-foreground` for empty values/invalid emails, `text-success` + `CheckCircle2` for all-clear. Unknown tokens use `AlertTriangle` + `text-foreground` at the TOP (UI-SPEC lines 92-93, 130).
- **Report aggregates: "server is authority" applies ONLY to `invalidEmailCount` + `emailColumn` (both template-INDEPENDENT — passed as props from the previewCampaign result).** The template-DEPENDENT aggregates are computed CLIENT-side here so they track the composed template as the user types (never frozen at fetch time — that stale-vs-typed freeze was the bug): `unknownTokens` = de-duplicated union of `analyzeMerge(subject + "\n" + body, rows[0] ?? {}, columns).unknown` (template-level — unknowns are the tokens NOT in `columns`, independent of row values); `rowsWithEmptyValues` = count over ALL fetched `rows` where `analyzeMerge(subject + "\n" + body, row, columns).empty.length > 0`. Recompute both in a `useMemo` on `[subject, body, columns, rows]`; iterate the FULL row set, never a sample; debounce for ≈1,000+ row lists. Do NOT accept `unknownTokens`/`rowsWithEmptyValues` as props and do NOT re-detect the email column client-side (`emailColumn` comes from the server).
- `Skeleton` while rows load (UI-SPEC line 183).

---

### `components/app-sidebar.tsx` — add "Compose" nav slot (nav)

**Analog:** the same file. Add one entry to `NAV_ITEMS` (`components/app-sidebar.tsx` lines 30-34) — the file already documents this exact extension point (lines 63-68):
```typescript
import { LayoutDashboard, PenLine, Settings, Users } from "lucide-react";  // add PenLine
const NAV_ITEMS = [
  { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { title: "Recipients", href: "/recipients", icon: Users },
  { title: "Compose", href: "/compose", icon: PenLine },   // ← NEW (UI-SPEC line 156)
  { title: "SMTP Settings", href: "/settings/smtp", icon: Settings },
] as const;
```
The `isActive` accent detection (lines 49-51) already handles the new route with no other change.

---

## Shared Patterns

### Authentication / Auth Boundary
**Source:** `lib/csv/actions.ts` lines 46-71 + `app/(app)/recipients/page.tsx` lines 40-41
**Apply to:** `lib/compose/actions.ts` (both actions), `app/(app)/compose/page.tsx`
Every Server Action re-derives `userId` via a lazy `const { auth } = await import("@clerk/nextjs/server")` and returns `{ ok: false, error: { kind: "unauthenticated" } }` when absent. RSC pages do `const { userId } = await auth(); const x = userId ? await dalFn(userId) : []`. The lazy import keeps the action module loadable under `node:test`.

### Tenant Scoping (IDOR defense — AUTH-02)
**Source:** `lib/data/recipients.ts` lines 67-70
**Apply to:** `lib/data/templates.ts` (getTemplateForUser), `lib/compose/actions-core.ts` (recipient-set resolve)
Single-row reads ALWAYS use `and(eq(id), eq(userId))`, never `eq(id)` alone. Preview resolves the CSV `storage_path` server-side from a userId-scoped `getRecipientSetForUser` row; the client passes only a `recipientSetId`, never a path (Pitfall 3).

### Server-Injected Ownership (T-3-TAMPER-OWNER)
**Source:** `lib/data/recipients.ts` lines 32-50
**Apply to:** `lib/data/templates.ts`
Insert `values` typed as `Pick<New*, ...>` that OMITS `userId`; the DAL spreads `{ userId, ...values }` so a caller can never spoof ownership.

### Typed result union (never throws to the UI)
**Source:** `lib/csv/actions-core.ts` lines 54-75
**Apply to:** `lib/compose/actions-core.ts`
Actions resolve to `{ ok: true; data } | { ok: false; error: ActionError }` over a CLOSED `ActionError` union; a `raw` field is ALWAYS a string, never an Error or bytes (D-06). The client exhaustively `switch`es over `error.kind` (`csv-uploader.tsx` lines 77-125).

### Server vs client authority for the validation report (anti-divergence — PREV-03)
**Source:** RESEARCH Pattern 3 + the checker's staleness fix
**Apply to:** `lib/compose/actions-core.ts` (server) + `components/compose/preview-stepper.tsx` (client)
Split the report by what it depends on. **Template-INDEPENDENT** fields — `invalidEmailCount` and `emailColumn` — are server-authoritative (computed/resolved over ALL rows against the persisted `email_column`; the client never recomputes or re-detects them). **Template-DEPENDENT** aggregates — `unknownTokens` and `rowsWithEmptyValues` — are computed CLIENT-side over ALL fetched `rows` (never a sample) and reactively as the composed subject/body change, so they can never go stale against the template as typed. Do NOT ship the template-dependent aggregates in `PreviewReport` and do NOT freeze them at fetch time.

### Shared zod schema (client resolver == server guard)
**Source:** `lib/csv/schema.ts` lines 35-62 + `lib/smtp/schema.ts` header
**Apply to:** `lib/compose/schema.ts`
ONE exported schema object parsed by BOTH the RHF `zodResolver` (client) and the action-core (server), so validation can never diverge. `export type X = z.infer<typeof schema>`. zod `^4.4` idioms only.

### Traversal-safe filesystem access (V12)
**Source:** `lib/csv/storage.ts` lines 25, 31-36
**Apply to:** `lib/csv/storage.ts` new `readUpload`
Single `UPLOADS_DIR = resolve(process.env.UPLOADS_PATH ?? "./data/uploads")` resolver; relative `<uuid>.csv` names; resolve-then-prefix-check on read.

### Test isolation (temp path before dynamic import)
**Source:** `lib/data/recipients.test.ts` lines 15-29 + `lib/csv/storage.test.ts` lines 20-29
**Apply to:** all new `*.test.ts` that touch DB or disk
Set `DATABASE_PATH` / `UPLOADS_PATH` to a `mkdtempSync` dir BEFORE the dynamic `await import(...)` (modules resolve those paths at load), `migrate(db, { migrationsFolder: "./drizzle" })` in `before()`, `rmSync` in `after()`.

### Client component shell (RHF + action + pending + toast)
**Source:** `components/recipients/csv-uploader.tsx` lines 1-46, 261-284, 383-399; resolver from `components/smtp/smtp-wizard.tsx` lines 3-5
**Apply to:** `components/compose/compose-editor.tsx`
`"use client"` + `useForm` + `zodResolver` + `useRouter`; action call wrapped in a `setPending(true/false)` pair; success → `toast.success`; failure → destructive `Alert`; submit button disabled while pending (no double-submit) — one accent CTA per view.

### Plain-text render (stored-XSS defense)
**Source:** RESEARCH anti-patterns (lines 209, 439) — no in-repo `dangerouslySetInnerHTML` exists (grep-clean, by design)
**Apply to:** `components/compose/preview-stepper.tsx`
Merged output renders as escaped text via JSX + `whitespace-pre-wrap`; a CSV cell value is NEVER injected as HTML and NEVER logged.

---

## No Analog Found

No file in this phase lacks an in-repo analog. Two areas are only PARTIAL matches — build the new behavior fresh while borrowing the surrounding layout:

| File | Role | Data Flow | Gap (no exact analog) |
|------|------|-----------|-----------------------|
| `components/compose/preview-stepper.tsx` | component | event-driven | Row-stepping (prev/next over fetched rows) + client-side reactive report aggregates (unknownTokens/rowsWithEmptyValues over ALL rows) have no precedent — borrow the review-card layout + status-line treatment from `csv-uploader.tsx` but write the stepper state + useMemo aggregates fresh |
| `components/compose/merge-field-menu.tsx` | component | event-driven | `{{`-triggered Popover suggestion list has no precedent; `shadcn add popover` is a new (official) source component. Chips reuse `Button`/`Badge` variants already in the repo |
| `lib/core/merge.ts` `analyzeMerge` | utility | transform | The empty-vs-unknown classification logic is the one genuinely NEW pure function — but its regex, purity contract, and test shape all copy `lib/core/fill.ts` |

---

## Metadata

**Analog search scope:** `lib/core/`, `lib/csv/`, `lib/data/`, `lib/db/`, `lib/smtp/`, `components/`, `components/recipients/`, `components/smtp/`, `app/(app)/`
**Files scanned:** 20 (11 read in full: fill.ts, fill.test.ts, storage.ts, storage.test.ts, recipients.ts, recipients.test.ts, actions.ts, actions-core.ts, schema.ts, csv-uploader.tsx, app-sidebar.tsx; + targeted reads of db/schema.ts, recipients/page.tsx, (app)/layout.tsx, smtp-wizard.tsx, smtp/schema.ts, csv/index.ts, data/index.ts, core/index.ts, actions-core.test.ts)
**Current-code note:** `recipient_sets.email_column` is persisted (schema.ts line 84; written by `saveRecipientSetCore` actions-core.ts lines 220-229). The Phase-4 preview MUST read `row.email_column` and only fall back to `detectEmailColumn` when it is null — do not re-detect over a persisted confirmed column.
**Revision note (iteration 2):** `unknownTokens` + `rowsWithEmptyValues` moved OFF the server `PreviewReport` and onto a client-side reactive computation in `preview-stepper.tsx`. Reason: those aggregates depend on the composed template, which the user types AFTER selecting a list; a server value computed at fetch time froze against a blank template and never surfaced a typed `{{typo}}`. Server authority now covers only the template-independent `invalidEmailCount` + `emailColumn`.
**Pattern extraction date:** 2026-07-13
