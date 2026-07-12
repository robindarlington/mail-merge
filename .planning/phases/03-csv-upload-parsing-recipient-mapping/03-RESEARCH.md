# Phase 3: CSV Upload + Parsing + Recipient Mapping - Research

**Researched:** 2026-07-13
**Domain:** Browser CSV upload → robust parse → email-column mapping → per-user recipient-set persistence (Next.js 16 App Router + Server Actions + Drizzle/SQLite)
**Confidence:** HIGH — this phase composes already-built, already-tested primitives (`lib/core/csv.ts`, the userId-scoped DAL pattern, the actions/actions-core seam, shadcn form stack). The only genuinely new engineering is email-column auto-detection and the file-storage resolver, both small and well-bounded.

## Summary

Phase 3 does **not** introduce a new technology domain. Every dependency it needs is already installed and proven in the repo: `papaparse` (5.5.4) already parses CSV robustly in `lib/core/csv.ts` (BOM strip, quoted fields, CRLF, invalid-email count — nine passing tests), the `recipient_sets` table already exists in `lib/db/schema.ts` with exactly the columns the success criteria name (`columns_json`, `row_count`, `storage_path`), and Phase 2 established the exact patterns to reuse: a userId-first DAL (`lib/data/smtp.ts`), a `"use server"` action file wrapping a testable non-`"use server"` `actions-core` seam (`lib/smtp/actions*.ts`), a shared zod schema, and a shadcn/react-hook-form client component.

The work is therefore **composition + two new pure functions**: (1) generalize email handling beyond the hardcoded literal `"email"` column — add `detectEmailColumn(columns, rows)` (header-name heuristic + content-sampling fallback) and `countInvalidEmails(rows, column)` to `lib/core/csv.ts` without breaking its existing tested contract; (2) a storage resolver (`lib/csv/storage.ts`) that writes the uploaded bytes to `<UPLOADS_DIR>/<uuid>.csv` under an env-configured directory mirroring `lib/db/client.ts`'s `DATABASE_PATH` pattern, using `crypto.randomUUID()` so the user-supplied filename never touches the filesystem path (traversal-proof by construction).

**Primary recommendation:** Upload via a Next.js **Server Action taking `FormData`** (not a Route Handler — the payloads are tiny, 100–1000 rows ≈ tens of KB), wrapped in the established `actions.ts` → `actions-core.ts` seam. Raise `experimental.serverActions.bodySizeLimit` in `next.config.ts` (default is 1 MB — [VERIFIED: nextjs.org]). Auto-detect the email column server-side, return a parse summary (columns, detected email column, row count, invalid count) to a shadcn client form that lets the user confirm/override the email column, then a second action call persists the file + `recipient_sets` row via a new userId-scoped `lib/data/recipients.ts`.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| File selection + confirm/override UI | Browser / Client | — | shadcn client component; needs interactivity for the email-column override |
| Upload transport | Frontend Server (Server Action) | — | Server Action receives `FormData`; re-derives `userId` via Clerk `auth()` server-side |
| CSV parse / BOM / quoting | API / Backend (lib/core) | — | Pure `parseCsv` in `lib/core/csv.ts`; no DOM, no DB |
| Email-column auto-detection | API / Backend (lib/core) | — | Pure function over parsed columns+rows; testable in isolation |
| Email validation + invalid count | API / Backend (lib/core) | — | Pure function on the *confirmed* column (CSV-04) |
| Ownership / tenancy scoping | API / Backend (DAL) | — | `lib/data/recipients.ts` — userId-first, mirrors `lib/data/smtp.ts` (AUTH-02) |
| CSV file persistence | Database / Storage (/data volume) | — | Bytes on disk at `<uuid>.csv`; DB stores only the path (ARCHITECTURE.md) |
| Recipient-set metadata | Database (SQLite) | — | `recipient_sets` row: filename, columns_json, row_count, storage_path |

## Standard Stack

Everything here is **already in `package.json` and installed** — no new runtime dependency is required for this phase. Versions confirmed via `npm ls`.

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| papaparse | 5.5.4 (installed; latest) | RFC-4180 CSV parse (header mode, BOM, quotes, CRLF) | Already the engine in `lib/core/csv.ts` with passing tests; PITFALLS #12 "never hand-roll" [VERIFIED: npm ls + STACK.md] |
| zod | 4.4.3 (installed) | Validate the upload (mime/extension/size/row-cap) and the confirm-column input | Same schema pattern as `lib/smtp/schema.ts`; zod-4 idioms already in use [VERIFIED: npm ls] |
| drizzle-orm | 0.45 (installed) | `recipient_sets` insert/select via the shared `db` | Table already defined; DAL pattern already established [VERIFIED: schema.ts] |
| node:crypto `randomUUID` | Node 24 builtin | Opaque on-disk filename (traversal-proof) | No dependency; used instead of the user's filename in the storage path |
| node:fs / node:path | Node 24 builtin | Write bytes to `/data/uploads`, resolve dir | Mirrors `lib/db/client.ts` `mkdirSync`/`resolve` pattern |

### Supporting (shadcn/ui — scaffolded into repo, not runtime deps)
| Component | Present? | Purpose | Action |
|-----------|----------|---------|--------|
| `form`, `input`, `button`, `card`, `alert`, `label` | ✅ present | Upload form shell, validation messaging | Reuse |
| `sonner` (Toaster) | ✅ present (mounted in app layout) | Success/error toasts | Reuse |
| `select` | ❌ **missing** | Email-column confirm/override dropdown | `npx shadcn@latest add select` (or reuse existing `radio-group` if ≤ ~5 columns) |
| `table` | ❌ missing | Optional: preview first N parsed rows | `npx shadcn@latest add table` **only if** a row preview is in scope this phase |

**Note:** `radio-group.tsx` IS present and is a viable zero-install alternative to `select` for the email-column override when the column count is small. Prefer it if you want to avoid adding a component.

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Server Action + FormData | Route Handler (`app/api/.../route.ts`) with streaming | Route Handlers are the right call for multi-MB uploads; at 100–1000 CSV rows (tens of KB) they add a hand-rolled endpoint + manual `auth()` for no benefit. Server Action reuses the proven seam. |
| Persist file to `/data/uploads` | Store parsed rows as JSON in SQLite | ARCHITECTURE.md explicitly rejects blobs-in-SQLite (WAL bloat, checkpoint stalls). Schema already commits to `storage_path`. |
| `crypto.randomUUID()` filename | Sanitized user filename | Any user-filename-derived path is a traversal vector (PITFALLS #11). Store the display name in the `filename` column instead. |
| Custom encoding detection (iconv-lite/chardet) | UTF-8 + BOM strip only (current) | See Assumptions A1 — MVP treats input as UTF-8; full transcoding is deferred. |

**Installation:** No `npm install` required. Optionally: `npx shadcn@latest add select` (and `table` if row preview is in scope).

## Package Legitimacy Audit

No new external packages are introduced by this phase — every recommended library is already present in `package.json` and was vetted in Phase 1/2. `slopcheck` not run because there is nothing new to install.

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| papaparse | npm | mature (10+ yrs) | ~5M/wk | github.com/mholt/PapaParse | not run (pre-installed) | Approved (already in use) |
| zod | npm | mature | ~30M/wk | github.com/colinhacks/zod | not run (pre-installed) | Approved (already in use) |
| drizzle-orm | npm | mature | ~2M/wk | github.com/drizzle-team/drizzle-orm | not run (pre-installed) | Approved (already in use) |

**Packages removed due to slopcheck [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none
**shadcn components** (`select`/`table`) are code scaffolded into the repo via the pinned `shadcn` CLI (already a devDependency), not npm runtime installs — no registry-legitimacy risk.

## Architecture Patterns

### System Architecture Diagram

```
 Browser (client component, shadcn form)
   │  1. user picks .csv file
   ▼
 FormData(file) ──POST──▶ Server Action  parseUploadedCsv(formData)   [lib/csv/actions.ts, "use server"]
                              │  auth() → userId (never trust client)
                              │  zod: mime/extension/size/row-cap guard
                              ▼
                          parseCsv(bytes)            [lib/core/csv.ts — existing]
                              │  columns, rows, parseErrors
                              ▼
                          detectEmailColumn(cols,rows)  ┐ NEW pure fns
                          countInvalidEmails(rows,col)  ┘ in lib/core/csv.ts
                              │
                              ▼
   ◀── returns { columns, detectedEmailColumn, rowCount, invalidCount, token/bytes-ref } ──
   │
   ▼  2. user confirms/overrides email column (shadcn select/radio)
 FormData(file + emailColumn) ──POST──▶ Server Action  saveRecipientSet(formData)
                              │  auth() → userId
                              │  re-validate + re-count on CONFIRMED column
                              ▼
                          storage.writeUpload(bytes) → <UPLOADS_DIR>/<uuid>.csv   [lib/csv/storage.ts NEW]
                              │  storage_path = "<uuid>.csv" (relative)
                              ▼
                          createRecipientSet(userId, {...})   [lib/data/recipients.ts NEW, userId-first]
                              │  INSERT recipient_sets (columns_json, row_count, storage_path)
                              ▼
                     SQLite (shared /data/app.db)  +  /data/uploads/<uuid>.csv
```

Later phases (Editor, Worker) re-open the file by `storage_path` and re-`parseCsv` it — the parsed rows are **not** stored in the DB (only `columns_json`, `row_count`, `storage_path`).

### Recommended Project Structure (new files, following established seams)
```
app/(app)/
  recipients/            # NEW route — upload + list (see Assumption A3 on route naming)
    page.tsx             # RSC: lists caller's recipient sets (userId-scoped), renders uploader
components/
  recipients/
    csv-uploader.tsx     # "use client" — file input, calls parse action, shows summary + column override
lib/
  core/
    csv.ts               # EXTEND: add detectEmailColumn(), countInvalidEmails(); keep parseCsv contract
    csv.test.ts          # EXTEND: tests for the two new pure fns
  csv/
    actions.ts           # "use server" — parseUploadedCsv, saveRecipientSet (auth() → userId)
    actions-core.ts      # NO "use server" — testable seams taking userId + bytes
    actions-core.test.ts # unit tests for the seam
    schema.ts            # zod: upload guard (mime/ext/size/max-rows) + confirm-column input
    storage.ts           # UPLOADS_DIR resolver + writeUpload(bytes) → relative path
    storage.test.ts
  data/
    recipients.ts        # NEW userId-first DAL: createRecipientSet, listRecipientSetsForUser, getRecipientSetForUser
    recipients.test.ts
components/app-sidebar.tsx  # EDIT: add "Recipients" nav slot (placeholder already documented in file)
next.config.ts             # EDIT: add experimental.serverActions.bodySizeLimit
```

### Pattern 1: userId-first DAL (copy from `lib/data/smtp.ts`)
**What:** Every DAL function takes `userId` as its required first parameter and filters on it; there is no lookup-by-id path without an owner filter. This is the structural AUTH-02 / IDOR defense.
**When to use:** All `recipient_sets` access.
```typescript
// Source: mirrors lib/data/smtp.ts (in-repo, proven pattern)
import { and, eq, desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { recipient_sets, type NewRecipientSet } from "@/lib/db/schema";

export function createRecipientSet(
  userId: string,
  values: Pick<NewRecipientSet, "filename" | "columns_json" | "row_count" | "storage_path">,
) {
  return db.insert(recipient_sets).values({ userId, ...values }).returning();
}

export function listRecipientSetsForUser(userId: string) {
  return db.query.recipient_sets.findMany({
    where: eq(recipient_sets.userId, userId),
    orderBy: desc(recipient_sets.created_at),
  });
}

// NOTE the AND(id, userId) — never fetch by id alone (IDOR).
export function getRecipientSetForUser(userId: string, id: number) {
  return db.query.recipient_sets.findFirst({
    where: and(eq(recipient_sets.id, id), eq(recipient_sets.userId, userId)),
  });
}
```

### Pattern 2: `"use server"` action wraps a testable non-server core (copy from `lib/smtp/actions*.ts`)
**What:** `actions.ts` has `"use server"` and exports ONLY client-invocable endpoints; each re-derives `userId` via `auth()`. The parameterized logic (taking `userId`/bytes for test injection) lives in `actions-core.ts` **without** `"use server"` so it is importable by tests but never wire-callable.
**Why:** In Next, every runtime export of a `"use server"` module is a public endpoint; putting a `userId`-accepting seam there would let a client bypass `auth()`.
```typescript
// lib/csv/actions.ts — Source: mirrors lib/smtp/actions.ts
"use server";
export async function parseUploadedCsv(formData: FormData) {
  const { auth } = await import("@clerk/nextjs/server");
  const { userId } = await auth();
  if (!userId) return { ok: false as const, error: { kind: "unauthenticated" as const } };
  return parseUploadedCsvCore(userId, formData); // from ./actions-core
}
```

### Pattern 3: env-configured storage dir (copy from `lib/db/client.ts`)
```typescript
// lib/csv/storage.ts — Source: mirrors DATABASE_PATH logic in lib/db/client.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

// Prod: Coolify sets UPLOADS_PATH → /data/uploads. Dev falls back to ./data/uploads.
const UPLOADS_DIR = resolve(process.env.UPLOADS_PATH ?? "./data/uploads");

export function writeUpload(bytes: Buffer): { storagePath: string } {
  mkdirSync(UPLOADS_DIR, { recursive: true });
  const name = `${randomUUID()}.csv`;              // opaque — user filename never in the path
  writeFileSync(resolve(UPLOADS_DIR, name), bytes);
  return { storagePath: name };                    // store RELATIVE; resolve at read time (see Pitfall 4)
}
```

### Reading FormData File bytes in a Server Action
```typescript
// Source: Web platform File API (Next.js Server Action receives real File objects)
const file = formData.get("file");
if (!(file instanceof File)) return { ok: false, error: { kind: "validation" } };
const bytes = Buffer.from(await file.arrayBuffer());
const parsed = parseCsv(bytes);           // existing lib/core/csv.ts accepts Buffer
```

### Anti-Patterns to Avoid
- **Route Handler + manual multipart parsing** for a tiny CSV — unnecessary surface; use a Server Action.
- **Naming the on-disk file from `file.name`** — traversal vector; use `randomUUID()` and keep `file.name` only as the `filename` DB column.
- **Storing an absolute path in `storage_path`** — breaks across dev/prod containers; store the relative `<uuid>.csv` and join to `UPLOADS_DIR` at read time.
- **Trusting a client-supplied recipient-set id** in later reads — always `AND userId`.
- **Persisting the parsed rows into SQLite** — schema deliberately stores only path + metadata.
- **Re-implementing CSV parsing** — extend `lib/core/csv.ts`, don't fork it.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| CSV parsing | `split(",")` / regex splitter | `parseCsv` (papaparse) — already built | Quoted fields, embedded commas/newlines, BOM, CRLF (PITFALLS #12) |
| Opaque filenames | counter / timestamp / sanitized user name | `crypto.randomUUID()` | Collision-free + traversal-proof |
| Form validation | manual `if` checks | zod schema (as `lib/smtp/schema.ts`) | One schema, client+server, no drift |
| Multi-tenant scoping | ad-hoc `where id=` | userId-first DAL (Pattern 1) | Structural IDOR defense (AUTH-02) |
| Toasts / form state | custom | shadcn `sonner` + react-hook-form (already wired) | Consistent with SMTP wizard |

**Key insight:** The email-column **detection** heuristic is the one piece with no off-the-shelf library — but it's a ~20-line pure function (header-name match, then content-sampling by `EMAIL_RE` hit-rate), not a dependency. Everything else in this phase is assembly of proven parts.

## Common Pitfalls

### Pitfall 1: The 1 MB Server Action body limit rejects real CSVs
**What goes wrong:** Next.js Server Actions cap the request body at **1 MB by default**; a moderately large CSV (or one near the medium-scale 1000-row target with wide rows) throws "Body exceeded 1mb limit" only in some environments, and silently in others.
**Why it happens:** The limit is separate from the API-route body parser and easy to miss.
**How to avoid:** Set it explicitly in `next.config.ts`:
```typescript
// next.config.ts — add to the existing NextConfig
experimental: { serverActions: { bodySizeLimit: "4mb" } },
```
Also enforce your own size + row cap in the zod guard so you reject with a *clear* message before the platform limit bites. [VERIFIED: nextjs.org/docs/app/api-reference/config/next-config-js/serverActions]
**Warning signs:** Upload works for 3-row test files, fails for real exports.

### Pitfall 2: Email column mis-detection ships to the wrong field
**What goes wrong:** Auto-detecting the email column by header name alone fails on files whose email column is called `Contact`, `Work Email`, `E-Mail`, or is unlabeled — or picks a column that merely *contains* "mail" (e.g. `mailing_city`).
**Why it happens:** Real spreadsheet exports have inconsistent headers.
**How to avoid:** Two-stage detection — (1) header-name heuristic (normalized: lowercase/trim; match `email`, `e-mail`, `mail`, `email address`, `recipient`), (2) **content-sampling fallback**: score each column by the fraction of non-empty cells matching `EMAIL_RE` over a sample (e.g. first 50 rows); pick the highest scorer above a threshold (e.g. >0.7). Then **always let the user confirm/override** (CSV-03 requires this). Detection is a hint, the human is the gate.
**Warning signs:** Invalid-count is suspiciously high (detected a non-email column).

### Pitfall 3: BOM / encoding (carried from PITFALLS #12)
**What goes wrong:** A UTF-8 BOM glues onto the first header → `{{email}}` never matches. Non-UTF-8 (Windows-1252) files mangle accented names (mojibake). CRLF splits rows.
**Why it happens:** Messy real-world exports.
**How to avoid:** BOM strip + quoting + CRLF are **already handled** by `lib/core/csv.ts` (tested). Non-UTF-8 transcoding is **not** handled — see Assumption A1. For MVP: treat input as UTF-8; surface a clear warning if `parseErrors` is non-empty rather than silently persisting a misparse.
**Warning signs:** Headers render literally; names show `Ã©`.

### Pitfall 4: storage_path portability
**What goes wrong:** Storing an absolute dev path (`/Users/.../data/uploads/x.csv`) that doesn't exist in the container.
**How to avoid:** Store the **relative** `<uuid>.csv`; resolve against `UPLOADS_DIR` at read time. Keep the resolver in one module (`lib/csv/storage.ts`) exactly as `lib/db/client.ts` centralizes the DB path.

### Pitfall 5: Orphaned files on abandoned uploads
**What goes wrong:** A two-step flow (parse then save) can write a file that never gets a `recipient_sets` row, or re-uploads leak files.
**How to avoid (MVP):** Write the file **only** in the save step, after validation passes, in the same action that inserts the row. Don't persist bytes during the parse/preview step — re-send the file in the confirm step, or hold it client-side. Full lifecycle cleanup (delete file on set/campaign delete) is a later-phase concern (noted in PITFALLS #10).

## Code Examples

### Email-column detection (new pure function to add to lib/core/csv.ts)
```typescript
// Source: new — pattern derived from PITFALLS #12 guidance ("preview/confirm is the gate")
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; // already in csv.ts
const NAME_HINTS = ["email", "e-mail", "mail", "email address", "recipient"];

export function detectEmailColumn(columns: string[], rows: Row[]): string | null {
  // 1) header-name heuristic (exact/normalized match preferred over substring)
  const norm = (s: string) => s.trim().toLowerCase();
  const byName =
    columns.find((c) => NAME_HINTS.includes(norm(c))) ??
    columns.find((c) => norm(c).includes("email"));
  if (byName) return byName;

  // 2) content sampling fallback: highest EMAIL_RE hit-rate over a sample
  const sample = rows.slice(0, 50);
  let best: { col: string; score: number } | null = null;
  for (const col of columns) {
    const vals = sample.map((r) => (r[col] ?? "").trim()).filter(Boolean);
    if (!vals.length) continue;
    const score = vals.filter((v) => EMAIL_RE.test(v)).length / vals.length;
    if (!best || score > best.score) best = { col, score };
  }
  return best && best.score > 0.7 ? best.col : null;
}

export function countInvalidEmails(rows: Row[], column: string): number {
  let n = 0;
  for (const r of rows) if (!EMAIL_RE.test((r[column] ?? "").trim())) n++;
  return n;
}
```
> Keep `parseCsv`'s existing signature and its `invalidEmailCount` (hardcoded to literal `"email"`) intact so the nine existing tests still pass — these two functions are *additive*.

### Upload guard schema (new lib/csv/schema.ts)
```typescript
// Source: mirrors lib/smtp/schema.ts zod-4 idioms
import { z } from "zod";
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // keep in step with bodySizeLimit
export const MAX_ROWS = 5000;                     // DoS / medium-scale guard
export const confirmColumnSchema = z.object({
  emailColumn: z.string().min(1, "Choose the email column"),
});
```

## State of the Art

| Old Approach (CLI) | Current Approach (this phase) | When Changed | Impact |
|--------------------|-------------------------------|--------------|--------|
| Hardcoded `email,password` header, split-at-first-comma | papaparse header mode (`lib/core/csv.ts`) | Phase 1 | Handles quoted fields/BOM/CRLF; CSV-02 done |
| Column named literally `email` | Auto-detect + user confirm/override | This phase | CSV-03 — arbitrary column names supported |
| No email validation | `countInvalidEmails` on the confirmed column | This phase | CSV-04 |
| No persistence | `recipient_sets` row + file on /data volume | This phase | CSV-05; feeds Phase 4 editor autocomplete via `columns_json` |

**Deprecated/outdated:** none relevant.

## Assumptions Log

No CONTEXT.md exists for this phase (user opted out of discuss-phase). The following are design decisions a discussion would normally have locked — flagged for the planner / user confirmation.

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | **Encoding = UTF-8 only for MVP.** Success criterion #1 says "encoding handled"; the built parser handles UTF-8 + BOM + CRLF but NOT Windows-1252/Latin-1 transcoding. Recommend accepting UTF-8, stripping BOM (done), and warning on `parseErrors` rather than adding `iconv-lite`/`chardet`. | Standard Stack / Pitfall 3 | Accented names from Excel/Windows exports show mojibake; may not satisfy a strict reading of "encoding handled". Adding `iconv-lite` + `chardet` later is non-breaking. |
| A2 | **Upload via Server Action + FormData** (not a Route Handler). Payloads are tens of KB at the 100–1000 row target. | Summary / Pattern 2 | If very large files become in-scope, a streaming Route Handler is the correct tool — but that contradicts the "medium scale" requirement boundary. |
| A3 | **Route/nav named `recipients`** (`app/(app)/recipients/`). The sidebar reserves "Campaigns"/"History"; a recipient set is standalone from a campaign in the schema. | Project Structure | May be re-parented under a `campaigns/new` flow in Phase 4/5; low cost to move. |
| A4 | **Two-step UX** (parse/preview, then confirm-column + save) with the file re-sent on save; bytes are persisted only at save time to avoid orphans. | Pitfall 5 | A one-step "upload + auto-save then edit" flow is also valid; affects orphan-file handling. |
| A5 | **`storage_path` stores the relative `<uuid>.csv`**, resolved against `UPLOADS_PATH` (env, default `./data/uploads`). | Pattern 3 / Pitfall 4 | If a later phase assumes an absolute path, reads break; centralizing the resolver mitigates. |
| A6 | **The uploaded CSV file persists on the volume** until a later cleanup phase. The "Out of Scope: long-term storage of sensitive cell values" note creates mild tension; MVP follows ARCHITECTURE.md (file on disk, DB holds path). | Pitfall 5 | If sensitive-data retention is a hard constraint, may need at-rest handling / TTL sooner. |
| A7 | **Row cap ≈ 5000, per-file cap ≈ 4 MB.** Chosen to bound DoS while covering the stated 100–1000 target with headroom. | Code Examples | If users legitimately exceed these, uploads reject; easy to tune. |

## Open Questions (RESOLVED)

All three questions were answered during planning by the Assumptions Log recommendations and are locked into the phase plans below.

1. **Does "encoding handled" (success criterion #1) require non-UTF-8 transcoding?** **(RESOLVED — per A1)**
   - What we knew: parser handles UTF-8/BOM/CRLF/quoting (tested).
   - What was unclear: whether Windows-1252 exports must render accents correctly for this phase to pass.
   - **Resolution:** Ship UTF-8 + a clear parse-error warning (A1); a non-empty papaparse `parseErrors` surfaces as a `parse_error` kind rather than silently persisting a misparse. `iconv-lite`+`chardet` are deferred (non-breaking to add later). Locked in 03-01 (`lib/csv/schema.ts` / `lib/core/csv.ts`) and 03-03 (`parse_error` handling).

2. **Is a parsed-row preview table in scope, or just the summary (columns + counts + email-column picker)?** **(RESOLVED — per Open-Question-2 recommendation / A4 / U4)**
   - What we knew: PITFALLS #12 argues the preview is the human safety net; full row-stepping preview is a Phase 4 (PREV-01) requirement.
   - **Resolution:** Phase 3 shows columns + detected email column + row/invalid counts + up to 5 client-read sample rows (cosmetic aid only); full row-stepping deferred to Phase 4. shadcn `table` IS added this phase (03-04). Note: the invalid COUNT is server-computed per-column (`invalidCounts`), not derived from the 5 sample rows.

3. **Where does the "Recipients" flow live in the IA** — standalone, or the first step of campaign creation? (A3) **(RESOLVED — per A3)**
   - **Resolution:** Standalone `/recipients` page + a new "Recipients" sidebar nav slot this phase (03-04); Phase 5 wires recipient-set selection into campaign creation.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | everything | ✓ | 24.9.0 | — |
| papaparse | CSV parse | ✓ | 5.5.4 | — |
| zod | validation | ✓ | 4.4.3 | — |
| drizzle-orm + better-sqlite3 | persistence | ✓ | 0.45 / 12.11 | — |
| `recipient_sets` table on disk | CSV-05 | ✓ | migrated in Phase 1 (drizzle/0000) | — |
| shadcn `select` component | email-column override UI | ✗ | — | reuse installed `radio-group` (no install) |
| shadcn `table` component | optional row preview | ✗ | — | omit preview / use plain markup |
| Writable `./data/uploads` (dev) / `/data/uploads` (prod volume) | file storage | dev ✓ (mkdir on demand) | — | prod requires the Coolify named volume (Phase 8) |

**Missing dependencies with no fallback:** none.
**Missing dependencies with fallback:** shadcn `select`/`table` — either scaffold via the pinned `shadcn` CLI or use `radio-group`/plain markup.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Node built-in `node:test` + `node:assert/strict`, run through `tsx` |
| Config file | none — no test config; conventions only |
| Quick run command | `npx tsx --test lib/csv/*.test.ts lib/core/csv.test.ts` |
| Full suite command | `npx tsx --test "lib/**/*.test.ts"` |

> **Verified this session:** `npx tsx --test "lib/**/*.test.ts"` → 87 pass / 0 fail (~10.8s; the slow part is the SMTP verify suite). Plain `node --test` FAILS on these files because tests import extensionless (`./csv`) and rely on tsx's resolver + type stripping — **use `tsx`, not bare `node --test`.** There is no `test` script in `package.json` (Wave 0 gap below).

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CSV-01 | File upload accepted through the browser | integration (action) | `npx tsx --test lib/csv/actions-core.test.ts` | ❌ Wave 0 |
| CSV-02 | Robust parse (BOM/quotes/CRLF/header) | unit | `npx tsx --test lib/core/csv.test.ts` | ✅ (9 passing) |
| CSV-03 | Auto-detect email column + override honored | unit + integration | `npx tsx --test lib/core/csv.test.ts` (detect) + actions-core | ❌ Wave 0 (detect fn + tests) |
| CSV-04 | Invalid-email count on the confirmed column | unit | `npx tsx --test lib/core/csv.test.ts` (`countInvalidEmails`) | ❌ Wave 0 |
| CSV-05 | recipient_sets persisted, userId-scoped | integration (DAL) | `npx tsx --test lib/data/recipients.test.ts` | ❌ Wave 0 |
| (SC-5) | Deploys to staging URL on Coolify and works | manual smoke | manual — staging URL check | manual-only (VPS) |

### Sampling Rate
- **Per task commit:** `npx tsx --test lib/csv/*.test.ts lib/core/csv.test.ts lib/data/recipients.test.ts`
- **Per wave merge:** `npx tsx --test "lib/**/*.test.ts"` (full suite green)
- **Phase gate:** Full suite green before `/gsd:verify-work`; plus the Coolify staging smoke (SC-5, manual).

### Wave 0 Gaps
- [ ] `lib/core/csv.test.ts` — ADD cases for `detectEmailColumn` (name match, substring reject `mailing_city`, content-sampling fallback, no-email→null) and `countInvalidEmails` (arbitrary column) — covers CSV-03/CSV-04
- [ ] `lib/csv/actions-core.test.ts` — parse + save seams (userId injection, mime/size/row-cap rejection, override honored) — covers CSV-01/CSV-03
- [ ] `lib/csv/storage.test.ts` — `writeUpload` returns relative path, uses uuid (not user filename), creates dir
- [ ] `lib/data/recipients.test.ts` — create/list/get scoped to userId; IDOR (user B cannot read user A's set) — covers CSV-05/AUTH-02
- [ ] `lib/csv/schema.test.ts` — upload guard accept/reject
- [ ] **Add a `"test"` script to `package.json`**: `"test": "tsx --test \"lib/**/*.test.ts\""` (currently absent; only `cli:test` exists)

## Security Domain

`security_enforcement` is not present in `.planning/config.json` → treated as **enabled**.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V4 Access Control | **yes** | userId-first DAL (`lib/data/recipients.ts`), `AND userId` on every read — no fetch-by-id-alone (AUTH-02 / IDOR). Action re-derives `userId` via Clerk `auth()`; client-supplied id never trusted. |
| V5 Input Validation | **yes** | zod guard on upload: enforce `.csv`/`text/csv` extension+mime, `MAX_UPLOAD_BYTES`, `MAX_ROWS`; papaparse `parseErrors` surfaced, not silently accepted. Confirm-column input validated (`z.string().min(1)`, must be a known column). |
| V12 Files & Resources | **yes** | On-disk name = `crypto.randomUUID()` — user filename never in the path (traversal-proof). `storage_path` relative, resolved only under `UPLOADS_DIR`. Size + row caps bound DoS. |
| V6 Cryptography | no | No new secrets in this phase (SMTP creds are Phase 2; CSV content is not encrypted at rest for MVP — see A6). |
| V2 Authentication / V3 Session | no (inherited) | Clerk middleware from Phase 2 gates all `(app)` routes. |

### Known Threat Patterns for {Next.js Server Action + file upload + SQLite}

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Path traversal via uploaded filename | Tampering | `randomUUID()` on-disk name; never `path.join(dir, file.name)`; store display name in DB column only (PITFALLS #11) |
| IDOR — read another user's recipient set | Info Disclosure / Elevation | userId-first DAL, `AND userId` filter, `auth()`-derived userId (PITFALLS #13 / AUTH-02) |
| Oversized / row-bomb upload | Denial of Service | `bodySizeLimit` + zod `MAX_UPLOAD_BYTES` + `MAX_ROWS`; reject early with clear message |
| CSV formula injection (`=`,`+`,`-`,`@` leading cell) | Tampering | **Not an upload risk** — only matters on *export*. Deferred to Phase 6 (HIST-03 send-report download); note carried forward (PITFALLS #12). |
| Silent misparse → wrong-recipient data | Tampering / Integrity | RFC-4180 parser (done) + surface `parseErrors` + user confirms detected column before save |
| Orphaned files leaking disk / sensitive cell values | Info Disclosure | Write bytes only on successful save; lifecycle cleanup deferred (A6 / PITFALLS #10) |

## Sources

### Primary (HIGH confidence)
- In-repo code (read this session): `lib/core/csv.ts` + `csv.test.ts`, `lib/db/schema.ts`, `lib/db/client.ts`, `lib/data/smtp.ts`, `lib/smtp/actions.ts` + `actions-core.ts` + `schema.ts`, `components/smtp/smtp-wizard.tsx`, `app/(app)/layout.tsx`, `components/app-sidebar.tsx`, `next.config.ts`, `package.json` — the authoritative patterns this phase composes.
- `.planning/research/ARCHITECTURE.md` — `recipient_sets` model, `/data/uploads/<uuid>.csv` storage decision, upload data flow (§"Upload + map CSV").
- `.planning/research/PITFALLS.md` — #11 (path traversal), #12 (CSV parsing/encoding), #13 (IDOR), #10 (file lifecycle/size).
- `.planning/research/STACK.md` — papaparse/zod versions and roles.
- `npm ls` / `npm view` (this session) — papaparse 5.5.4, next 16.2.9, zod 4.4.3 installed & current.
- Test run (this session) — `npx tsx --test "lib/**/*.test.ts"` → 87/87 pass; `node --test` incompatible.

### Secondary (MEDIUM confidence)
- nextjs.org — `serverActions.bodySizeLimit` default 1 MB and how to raise it (config location under `experimental`), cross-checked with multiple community write-ups. [VERIFIED: nextjs.org/docs/app/api-reference/config/next-config-js/serverActions]

### Tertiary (LOW confidence)
- Email-column detection heuristic (header-match + content-sampling) — no authoritative source; a small custom pure function, flagged for tests. [ASSUMED]

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all deps installed, versions verified, patterns already in-repo.
- Architecture: HIGH — reuses Phase 2 seams verbatim; storage/table model pre-committed in ARCHITECTURE.md + schema.
- Pitfalls: HIGH — carried from PITFALLS.md + one platform limit VERIFIED against Next docs.
- Email detection + encoding scope: MEDIUM — custom heuristic (testable) and one open scope question (A1).

**Research date:** 2026-07-13
**Valid until:** ~2026-08-13 (stable stack; no fast-moving deps introduced)

Sources:
- [next.config.js: serverActions | Next.js](https://nextjs.org/docs/app/api-reference/config/next-config-js/serverActions)
</content>
</invoke>
