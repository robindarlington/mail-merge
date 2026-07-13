# Phase 4: Editor + Preview + Template Save - Research

**Researched:** 2026-07-13
**Domain:** In-browser plain-text compose editor with `{{merge-field}}` autocomplete, live merged preview against real CSV rows, pre-send validation report, and template persistence — all inside an existing Next.js 16 / React 19 App Router + Drizzle/SQLite codebase.
**Confidence:** HIGH (this phase is overwhelmingly a codebase-integration exercise; nearly all findings are verified by reading the actual repo, not from external sources)

## Summary

Phase 4 is a **composition-over-invention** phase. The two hardest primitives already exist and are tested: `lib/core/fill.ts` (`fill` + `fillMessage`) already substitutes arbitrary `{{column}}` tokens across BOTH subject and body (EDIT-03 is genuinely done and covered by passing tests `[VERIFIED: lib/core/fill.test.ts read]`), and `lib/core/csv.ts` (`parseCsv`, `detectEmailColumn`, `countInvalidEmails`) already turns CSV bytes into ordered columns + row objects with invalid-email counting. The phase's real work is: (1) a small new **pure merge-analysis helper** in `lib/core` that reports, per row, which template tokens are empty or unknown (the engine that powers PREV-02 and PREV-03); (2) a **storage read seam** (`readUpload`) that does not yet exist — `lib/csv/storage.ts` only writes; (3) a **templates DAL** (`lib/data/templates.ts`) that does not yet exist; (4) a **preview/save Server Action pair** following the established `actions.ts` + `actions-core.ts` split; and (5) the **editor + preview UI** on a new authenticated route, following the SMTP-wizard / CSV-uploader component patterns verbatim.

Two design decisions have no CONTEXT.md to anchor them (this is an autonomous run) and are flagged `[ASSUMED]` for planner/user confirmation: **the editor autocomplete mechanism** and **the template↔recipient-set association model**. For the editor, the codebase's consistent bias toward zero/minimal new dependencies (papaparse and nodemailer are the only runtime engine deps; `registries: {}` means official-shadcn-only) points strongly to a **plain `<textarea>` + click-to-insert field chips + a `{{`-triggered fixed-position suggestion list** built on the already-installed `radix-ui` Popover — avoiding a caret-coordinate library entirely. For the template model, the `templates` table is currently standalone (userId-scoped `subject`/`body`, no recipient-set FK), and `campaigns.template_id` is the join point that Phase 5 wires up — so Phase 4 should persist a **standalone userId-scoped template** and leave campaign association to Phase 5.

**Primary recommendation:** Add one pure core helper (`analyzeMerge`/token-extraction, fully unit-tested), one storage read seam, one templates DAL module, and one `compose` Server Action pair — then build a `<textarea>`-based editor + row-stepping preview UI on a new `/compose` route, reusing `fill`/`fillMessage` unchanged and computing the authoritative validation aggregate server-side (mirroring how Phase 3 made the server the source of truth for counts).

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| `{{field}}` substitution (subject + body) | Pure lib/core (`fill`/`fillMessage`) | Client (per-row preview render) | Already built, dependency-free, browser-safe; runs identically client- or server-side |
| Merge-gap analysis (empty/unknown tokens) | Pure lib/core (NEW helper) | — | New pure function; the engine behind PREV-02/03; must be unit-tested like `fill` |
| Read stored CSV back from disk | API/Backend (NEW `readUpload` in lib/csv/storage) | — | Filesystem access; server-only; must be gated behind a userId-scoped recipient-set lookup |
| Template persistence | API/Backend (NEW `lib/data/templates.ts` DAL) | — | Tenant-owned write; userId-first, mirrors `recipients.ts` |
| Compose/preview/save orchestration | API/Backend (Server Action `actions.ts` + testable `actions-core.ts`) | — | Auth boundary; re-derives `userId`; never trusts a client-supplied storage_path |
| Autocomplete trigger + insertion | Browser/Client (`<textarea>` + Popover) | — | Pure UI interaction; no server round-trip to suggest a column already known from `columns_json` |
| Row stepping / highlight rendering | Browser/Client | — | View over server-returned rows; React escapes text (no `dangerouslySetInnerHTML`) |
| Validation aggregate (invalid emails + missing values) | API/Backend (Server Action, authoritative) | Client (visual echo) | Phase-3 precedent: the server computes the authoritative count; the client never re-derives it from a sample |

## Standard Stack

This phase adds **no new runtime npm dependencies** under the recommended approach. Everything needed is already installed and verified in `package.json` `[VERIFIED: package.json + npm ls read]`.

### Core (already installed — reuse)
| Library | Version (installed) | Purpose | Why Standard |
|---------|---------------------|---------|--------------|
| `next` | 16.2.9 | App Router, RSC pages, Server Actions | Project framework (D-01) |
| `react` / `react-dom` | 19.2.7 | Client components, form state | Project framework |
| `react-hook-form` | ^7.81 | Editor form state (subject/body), save flow | Established seam (SMTP wizard, CSV uploader) |
| `@hookform/resolvers` + `zod` | ^5.4 / ^4.4 | Shared client+server validation schema | Established pattern (`lib/*/schema.ts`) |
| `drizzle-orm` | 0.45.x | `templates` table access via DAL | Project ORM (D-04) |
| `better-sqlite3` | ^12.11 | Underlying store (via the single `lib/db` opener) | Project DB |
| `radix-ui` (unified) | ^1.6 | Popover for the `{{` suggestion list | Already installed; `require('radix-ui').Popover` confirmed present `[VERIFIED: node -e require check]` |
| `lucide-react` | ^1.21 | Icons (consistency with UI-SPEC) | Established icon set |
| `sonner` | ^2.0.7 | Save-success toast | Established toast pattern |
| **`lib/core/fill`** | in-repo | `fill` / `fillMessage` — arbitrary `{{column}}` in subject AND body | Already built + tested; EDIT-03 done |
| **`lib/core/csv`** | in-repo | `parseCsv` / `detectEmailColumn` / `countInvalidEmails` | Already built + tested; powers preview + validation |

### Supporting (shadcn source components to `add` — NOT npm deps)
| Component | Source | Purpose | When to Use |
|-----------|--------|---------|-------------|
| `textarea` | official shadcn (`registries: {}`) | Multi-line body (and optionally subject) editor | The compose fields; official block, no vetting gate |
| `popover` | official shadcn (wraps already-installed `radix-ui`) | Anchor for the `{{`-triggered field suggestion list | The autocomplete surface; adds NO new npm dependency |

`shadcn add textarea popover` copies source files that import the already-present `radix-ui` package. This is the same "official-shadcn-only" path Phase 3 used for `select`/`table` — `components.json` `registries: {}` confirmed `[VERIFIED: components.json read]`, so the third-party vetting gate does not apply.

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Plain `<textarea>` + fixed-position Popover list | shadcn `command` (cmdk) inside a Popover | Adds `cmdk` npm dependency (needs slopcheck/vetting) for keyboard-navigable fuzzy filtering; nicer UX but violates the zero-new-dep bias and adds a real 3rd-party package. Defer unless the planner wants richer filtering. |
| Fixed-position suggestion list (below the field) | Caret-anchored popover following the `{{` position | Pixel-accurate caret coordinates in a `<textarea>` require the "mirror div" hack or a library like `textarea-caret`. High complexity for marginal MVP value. **Do not hand-roll caret geometry.** |
| Plain `<textarea>` | `contenteditable` / rich editor (Tiptap, Lexical, Slate) | Explicitly out of scope — CLAUDE.md + REQUIREMENTS "Out of Scope" mandate plain text only; a rich editor fights the plain-text contract and adds large deps. Reject. |
| Merge preview client-side via `fill` | Server-rendered merged preview | `fill.ts` is dependency-free and browser-safe, so per-row merge can run client-side over server-returned rows — keeps papaparse off the client bundle while avoiding a round-trip per step. |

**Installation:**
```bash
# No npm install needed. Only shadcn source components:
npx shadcn@latest add textarea popover
```

**Version verification:** All libraries above are already in `package.json` and resolved in `node_modules` (confirmed via `npm ls` — next@16.2.9, react@19.2.7). No registry lookup for new packages is required because no new packages are proposed.

## Package Legitimacy Audit

**No external packages are installed by this phase** under the recommended approach. `shadcn add textarea popover` copies source files that depend only on the already-installed, already-vetted `radix-ui`.

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| *(none — zero new dependencies)* | — | — | — | — | — | N/A |

**Packages removed due to slopcheck [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

> If the planner elects the richer autocomplete path, `cmdk` becomes a new npm dependency and MUST go through the Package Legitimacy Gate (slopcheck + `npm view cmdk`) and a `checkpoint:human-verify` before install. Under the recommended zero-dep path this section is a no-op.

## Architecture Patterns

### System Architecture Diagram

```
                         ┌──────────────────────────────────────────────┐
  User selects a         │  /compose  (RSC page, app/(app)/compose/)     │
  recipient set  ───────►│  auth() → listRecipientSetsForUser(userId)    │
                         │  passes {id, filename, columns_json} to client│
                         └───────────────┬──────────────────────────────┘
                                         │ props (columns[], recipientSetId)
                                         ▼
        ┌────────────────────────────────────────────────────────────────┐
        │  <ComposeEditor> (client component)                             │
        │                                                                 │
        │  subject <textarea> ─┐                                          │
        │  body    <textarea> ─┼─► `{{`-trigger → Popover suggestion list │
        │  field chips (click-to-insert) ◄─ columns[] from columns_json   │
        │                      │                                          │
        │                      ▼  (subject, body, recipientSetId)         │
        │            ┌─────────────────────────────┐                      │
        │            │ previewCampaign() action ───►│ auth()               │
        │            └─────────────┬───────────────┘  getRecipientSetForUser
        │                          │ returns rows[] +   (userId-scoped!)  │
        │                          │ validation report  readUpload(path)  │
        │                          │                    parseCsv(bytes)   │
        │                          ▼                                       │
        │   Row stepper: fillMessage(tpl, rows[i])  ──► merged subject/body│
        │   analyzeMerge(tpl, row) ──► highlight empty/unknown tokens      │
        │   Validation report card: Σ invalid emails, Σ missing values     │
        │                                                                 │
        │            ┌─────────────────────────────┐                      │
        │            │ saveTemplate() action ──────►│ auth()               │
        │            └─────────────────────────────┘  createTemplate(uid) │
        │                                              → templates row     │
        └────────────────────────────────────────────────────────────────┘

  Pure engine (browser-safe, no deps):  lib/core/fill (exists) + lib/core/merge-analysis (NEW)
  Server-only:                          lib/csv/storage.readUpload (NEW) + lib/data/templates (NEW)
```

### Recommended Project Structure (additive — mirrors existing layout)
```
lib/core/
  merge.ts                # NEW: extractTokens() + analyzeMerge() (pure, tested like fill.ts)
  merge.test.ts           # NEW: node:test unit tests
  index.ts                # extend barrel with new exports
lib/csv/
  storage.ts              # ADD readUpload(storagePath): Buffer (traversal-safe resolve)
  storage.test.ts         # extend
lib/data/
  templates.ts            # NEW: createTemplate/getTemplateForUser/listTemplatesForUser (userId-first)
  templates.test.ts       # NEW
  index.ts                # extend barrel
lib/compose/              # NEW subsystem (mirrors lib/csv/)
  schema.ts               # shared zod: subject/body length caps, non-empty
  actions.ts              # "use server" — previewCampaign() + saveTemplate() (auth wrappers)
  actions-core.ts         # testable seams (userId-injected, no "use server")
  index.ts                # barrel (types + schema + storage helpers only; NOT the actions)
app/(app)/compose/
  page.tsx                # RSC: auth + list recipient sets, render editor
components/compose/
  compose-editor.tsx      # client: textarea + chips + {{ popover
  merge-field-menu.tsx    # the suggestion list (optional split)
  preview-stepper.tsx     # row stepping + highlight + validation report
```

### Pattern 1: actions.ts + actions-core.ts split (auth boundary)
**What:** Public Server Actions live in `actions.ts` (`"use server"`), re-derive `userId` via Clerk `auth()`, and delegate to `actions-core.ts` seams that accept an injected `userId` and carry NO server directive (so they are never client-invocable endpoints).
**When to use:** Every action in this phase (`previewCampaign`, `saveTemplate`).
**Example:**
```typescript
// Source: lib/csv/actions.ts (verbatim established pattern) [VERIFIED: read]
// actions.ts
export async function saveTemplate(fd: FormData): Promise<SaveResult> {
  const { auth } = await import("@clerk/nextjs/server"); // lazy: keeps testable under node:test
  const { userId } = await auth();
  if (!userId) return { ok: false, error: { kind: "unauthenticated" } };
  return saveTemplateCore(userId, fd);
}
// actions-core.ts (no "use server") — importable by tests, never wire-callable
export async function saveTemplateCore(userId: string, fd: FormData): Promise<SaveResult> { /* ... */ }
```

### Pattern 2: userId-first DAL with server-injected ownership
**What:** Every DAL function takes `userId` as the required first parameter; inserts type their `values` as a `Pick<>` that OMITS `userId` and spread `{ userId, ...values }` server-side; single-row reads use `and(eq(id), eq(userId))` — never `eq(id)` alone.
**When to use:** The new `lib/data/templates.ts`, verbatim copy of `lib/data/recipients.ts` shape.
**Example:**
```typescript
// Source: lib/data/recipients.ts (established pattern) [VERIFIED: read]
export type PersistableTemplate = Pick<NewTemplate, "subject" | "body">;
export function createTemplate(userId: string, values: PersistableTemplate) {
  return db.insert(templates).values({ userId, ...values }).returning();
}
export function getTemplateForUser(userId: string, id: number) {
  return db.query.templates.findFirst({
    where: and(eq(templates.id, id), eq(templates.userId, userId)), // IDOR defense
  });
}
```

### Pattern 3: Server is the authority for validation counts
**What:** Phase 3 established that the server computes the authoritative invalid-email count and the client never re-derives it from a sample. Phase 4 extends this: the preview action re-reads the CSV, computes the full validation aggregate (invalid emails across all rows + missing-value tallies), and returns it. The client renders it; it does not recompute over a subset.
**When to use:** The `previewCampaign` action's validation report (PREV-03).
**Why:** Prevents "the preview said 0 invalid but the send found 12" divergence.

### Pattern 4: Traversal-safe storage read (mirror of the write seam)
**What:** `readUpload(storagePath)` resolves the RELATIVE `<uuid>.csv` against `UPLOADS_DIR` and reads bytes. The `storagePath` MUST come from a userId-scoped `getRecipientSetForUser` lookup — never from the client. Defensively confirm the resolved path stays within `UPLOADS_DIR`.
**Example:**
```typescript
// Source: derived from lib/csv/storage.ts writeUpload() [VERIFIED: read — only writeUpload exists today]
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
const UPLOADS_DIR = resolve(process.env.UPLOADS_PATH ?? "./data/uploads");
export function readUpload(storagePath: string): Buffer {
  const full = resolve(UPLOADS_DIR, storagePath);
  if (full !== UPLOADS_DIR && !full.startsWith(UPLOADS_DIR + sep)) {
    throw new Error("resolved upload path escaped the uploads directory");
  }
  return readFileSync(full);
}
```

### Anti-Patterns to Avoid
- **Accepting `storage_path` (or raw file bytes) from the client.** The client passes a `recipientSetId`; the server resolves the path via the userId-scoped DAL. A client-supplied path is a path-traversal + IDOR vector.
- **`dangerouslySetInnerHTML` for merged preview.** The email is plain text; render merged output as text (JSX auto-escapes). Injecting CSV cell values as HTML is a stored-XSS vector in the preview.
- **Re-implementing `{{}}` substitution.** `fill`/`fillMessage` are done and tested. Import them; do not fork the regex.
- **Shipping papaparse to the browser.** Parsing stays server-side (in the preview action); only parsed row objects cross the wire — the same discipline Phase 3 applied.
- **Caret-coordinate autocomplete via a hand-rolled mirror div.** Fiddly and fragile; use the fixed-position suggestion approach for MVP.
- **Silently blanking an unknown token.** `fill` deliberately leaves an unknown `{{typo}}` intact (pass-through). The preview/validation must SURFACE unknown tokens as an authoring error, not hide them.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| CSV parsing | A split-on-comma reader | `parseCsv` (`lib/core/csv.ts`) | Quoted fields, BOM, CRLF already handled + tested |
| `{{field}}` substitution | A new regex replacer | `fill` / `fillMessage` (`lib/core/fill.ts`) | `$`-safe callback replace, whitespace-tolerant, pass-through rule — all tested |
| Caret-following autocomplete popup | Mirror-div caret geometry | Fixed-position Popover list (or `cmdk` if approved) | Textarea caret pixel coords are notoriously brittle across fonts/wrapping |
| Rich text editing | contenteditable state machine | Plain `<textarea>` | Plain-text-only is a hard product constraint (CLAUDE.md + Out of Scope) |
| Email validity check | New RFC regex | `countInvalidEmails` / `EMAIL_RE` (`lib/core/csv.ts`) | Consistent, deliberately permissive check reused across the app |
| Tenant scoping | Ad-hoc `where id=?` | `getRecipientSetForUser` / new `getTemplateForUser` | Structural IDOR defense (AUTH-02) |

**Key insight:** The only genuinely NEW logic this phase should own is the **merge-gap analysis** (which tokens in a template are empty vs. unknown for a given row). It is small and pure — build it as a tested `lib/core` helper alongside `fill`, not inline in a component.

## Common Pitfalls

### Pitfall 1: Conflating "empty value" with "unknown token" (breaks PREV-02/03)
**What goes wrong:** `fill("Hi {{name}}", { name: "" })` returns `"Hi "` (empty substituted), while `fill("Hi {{nme}}", { name: "Ada" })` returns `"Hi {{nme}}"` (unknown token left literal). Treating them the same produces a misleading validation report.
**Why it happens:** `fill`'s pass-through rule (verified in `fill.test.ts`: "leaves an unmatched token intact") is intentional but subtle.
**How to avoid:** The new `analyzeMerge(template, row, columns)` must classify each token as `present` / `empty` (column exists in the header set, value is blank) / `unknown` (token key not in columns). PREV-02 highlights rows with `empty` tokens; PREV-03 additionally surfaces `unknown` tokens as a template-level authoring error (affects every row).
**Warning signs:** A preview that shows literal `{{typo}}` to the user with no warning, or a "0 missing values" report on a template with a misspelled field.

### Pitfall 2: The storage read seam does not exist yet
**What goes wrong:** Planning assumes you can read a saved CSV back, but `lib/csv/storage.ts` only exports `writeUpload` (confirmed — no `readUpload`). Preview has nothing to read.
**Why it happens:** Phase 3 only needed the write path.
**How to avoid:** Add `readUpload` (Pattern 4) as an explicit, tested task before the preview action.
**Warning signs:** A plan task that says "read the CSV for preview" with no task that creates the read function.

### Pitfall 3: IDOR / path traversal through the preview action
**What goes wrong:** A preview action that accepts a `storagePath` or `recipientSetId` without a userId-scoped lookup lets User A preview User B's CSV (and possibly read arbitrary files).
**Why it happens:** Preview needs a file path; the tempting shortcut is to pass it from the client.
**How to avoid:** Client sends only `recipientSetId`; server calls `getRecipientSetForUser(userId, id)` (returns `undefined` for another tenant), then `readUpload(row.storage_path)`. Never trust a client path.
**Warning signs:** The action signature takes `storagePath: string` from the client.

### Pitfall 4: Next.js Server Action returning 5,000 rows is heavy but the wire is the bottleneck, not parsing
**What goes wrong:** Returning every parsed row for stepping can be a multi-MB payload for a 5,000-row CSV, and it re-parses on every preview call.
**Why it happens:** The naive contract returns all rows so the client can step.
**How to avoid (MVP):** Returning all rows once is acceptable at the 100–1,000 target scale (Out-of-Scope caps bulk at <1,000). Prefer: compute the validation AGGREGATE server-side (small payload), and return either all rows (simple) or a bounded window + total count for stepping. Do not re-read/re-parse on every single step — fetch once, step client-side. Flag row-count strategy for the planner.
**Warning signs:** A `previewRow(recipientSetId, index)` action that re-reads the file per arrow-key press.

### Pitfall 5: shadcn `textarea`/`popover` are not installed
**What goes wrong:** The editor assumes a `Textarea` component that isn't in `components/ui/`.
**Why it happens:** Phase 3 added `select`/`table` but not `textarea`/`popover`.
**How to avoid:** `npx shadcn@latest add textarea popover` as an early task (official registry, no vetting gate). `radix-ui` (Popover's dependency) is already installed — confirmed.
**Warning signs:** An import from `@/components/ui/textarea` with no add task.

### Pitfall 6: Template model ambiguity (standalone vs. per-campaign)
**What goes wrong:** Adding a `recipient_set_id` FK to `templates` (or trying to create a campaign row) in Phase 4 pre-empts Phase 5's job and may require a migration the schema didn't plan for.
**Why it happens:** "save as a template for the campaign" reads like it needs a campaign link.
**How to avoid:** The `templates` table is standalone (userId, subject, body) — confirmed in `schema.ts`. `campaigns.template_id` is the join, wired in Phase 5. Phase 4 persists a standalone userId-scoped template; the editor associates it with a recipient set only ephemerally (via the route/props) for preview. Flag as `[ASSUMED A2]`.
**Warning signs:** A plan task that adds a column to `templates` or inserts a `campaigns` row.

## Code Examples

### Merge-gap analysis (the one genuinely new pure helper)
```typescript
// Source: NEW lib/core/merge.ts — derived from lib/core/fill.ts TOKEN regex [CITED: fill.ts]
const TOKEN = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** Ordered, de-duplicated token keys referenced by a template string. */
export function extractTokens(template: string): string[] {
  const seen = new Set<string>();
  for (const m of template.matchAll(TOKEN)) seen.add(m[1]);
  return [...seen];
}

export interface MergeAnalysis {
  empty: string[];    // token references a real column, value is blank for THIS row
  unknown: string[];  // token key is not a column in the CSV (authoring typo)
}

/** Classify each token in `template` against one row + the known column set. */
export function analyzeMerge(
  template: string,
  row: Record<string, string>,
  columns: string[],
): MergeAnalysis {
  const cols = new Set(columns);
  const empty: string[] = [];
  const unknown: string[] = [];
  for (const key of extractTokens(template)) {
    if (!cols.has(key)) unknown.push(key);
    else if ((row[key] ?? "").trim() === "") empty.push(key);
  }
  return { empty, unknown };
}
```

### Preview action contract (typed result union, mirrors ParseResult)
```typescript
// Source: pattern from lib/csv/actions-core.ts ParseResult/ActionError [VERIFIED: read]
export type PreviewReport = {
  columns: string[];
  rows: Record<string, string>[];       // fetch-once; step client-side
  totalRows: number;
  invalidEmailCount: number;            // authoritative, server-computed (PREV-03)
  unknownTokens: string[];              // template-level authoring errors (subject ∪ body)
  rowsWithEmptyValues: number;          // aggregate for the report (PREV-02/03)
};
export type PreviewResult =
  | { ok: true; data: PreviewReport }
  | { ok: false; error: ActionError };  // reuse/extend the closed ActionError union
```

### Client per-step merge (browser-safe, no deps)
```typescript
// fill.ts imports nothing — safe to call in a client component
import { fillMessage } from "@/lib/core"; // { subject, body } → merged
import { analyzeMerge } from "@/lib/core";
const merged = fillMessage({ subject, body }, rows[i]);
const gaps = analyzeMerge(subject + "\n" + body, rows[i], columns); // highlight if gaps.empty.length
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| CLI hard-coded `{{email}}`/`{{password}}`, body-only | `fill`/`fillMessage` over arbitrary columns, subject+body | Phase 1 | EDIT-03 already satisfied; Phase 4 just consumes it |
| Rich WYSIWYG email editors (industry default for mail-merge tools) | Plain-text editor whose value is merge tokens + preview | Product decision | Out-of-scope by design; smaller surface, better deliverability |

**Deprecated/outdated:** Nothing in this phase's stack is deprecated. Note: `radix-ui` is now shipped as a single unified package (installed `^1.6`) rather than per-primitive `@radix-ui/react-*` packages — use `import { Popover } from "radix-ui"` (shadcn's current `popover` block targets this).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Editor autocomplete = plain `<textarea>` + click-to-insert chips + `{{`-triggered fixed-position Popover list (no caret-coordinate lib, no `cmdk`) | Standard Stack / Alternatives | Medium — if richer keyboard-nav filtering is required, add `cmdk` (new dep, needs vetting); UI rework but not a data-model change |
| A2 | Templates persist as STANDALONE userId-scoped rows (subject/body only); campaign↔template link is Phase 5's job | Pitfall 6 | Low — matches existing schema; if wrong, Phase 5 adds the FK usage it already owns |
| A3 | New route is `/compose` (with a recipient set selected via prop/query), added as a sidebar nav slot | Project Structure | Low — nav slot + route move; the sidebar already documents future "Campaigns" slots |
| A4 | Preview fetches all parsed rows once and steps client-side (acceptable at ≤1,000-row target scale) | Pitfall 4 | Low–Medium — for very large CSVs a windowed contract is better; changing later is an action-signature edit |
| A5 | Subject is ALSO editable with merge fields in the same editor (not a plain input) | Architecture | Low — `fillMessage` already fills subject; UI just needs `{{` support on both fields |
| A6 | PREV-03's "missing attachment files" clause is N/A this phase (attachments are Phase 7) | Requirements mapping | Low — the report is structured to add that dimension later |
| A7 | Subject/body length caps enforced via a shared zod schema (values TBD, e.g. subject ≤ 998 chars per RFC 5322 line limit, body ≤ a sane cap) | Security V5 | Low — a copy/limit tweak |

## Open Questions (RESOLVED)

1. **Autocomplete richness (A1)**
   - What we know: A plain textarea + chips + Popover satisfies "click-to-insert / autocomplete triggered on `{{`" with zero new deps.
   - What's unclear: Whether the user wants keyboard-navigable fuzzy filtering (which points to `cmdk`).
   - Recommendation: Ship the zero-dep version; note `cmdk` as a low-cost future upgrade behind a vetting checkpoint.
   - RESOLVED: Ship the zero-dep textarea + chips + `{{`-triggered fixed-position Popover (assumption A1). Carried into UI-SPEC U3 (chip/popover UX) and the 04-04 plan (merge-field-menu.tsx, "no cmdk" grep gate). `cmdk` deferred behind a future vetting checkpoint.

2. **Preview row-fetch strategy (A4)**
   - What we know: Fetch-once + client stepping is simplest and fine at target scale.
   - What's unclear: Whether the planner wants a windowed contract now for headroom.
   - Recommendation: Fetch-once for MVP; document the windowed alternative in the action's typed contract.
   - RESOLVED: Fetch-once, step client-side (assumption A4). Carried into UI-SPEC U5 (fetch-once preview) and the 04-03/04-05 plans (PreviewReport.rows returned once; stepper walks them with no per-step round-trip). Windowed contract documented as the later action-signature edit if scale grows.

3. **Does "save a template" also create/associate a draft campaign (A2)?**
   - What we know: `campaigns` requires `recipient_set_id` + `template_id` + `smtp_config_id` — the SMTP part isn't chosen until send-time flows, so a full campaign row can't be completed in Phase 4.
   - What's unclear: Whether Phase 4 should stub a draft campaign.
   - Recommendation: No — persist a standalone template; leave campaign creation to Phase 5 where SMTP selection + the draft→queued transition live.
   - RESOLVED: No draft campaign this phase — persist a STANDALONE userId-scoped template (assumption A2). Carried into UI-SPEC U8 (standalone template, no campaign/recipient-set FK) and the 04-03 plan (saveTemplateCore → createTemplate(userId, {subject, body}) only). Campaign creation is Phase 5's job.

## Environment Availability

This phase is code + config only (a new editor UI, pure helpers, one DAL, one Server Action pair, two shadcn source components). No new external tools, services, runtimes, or databases are introduced beyond what Phases 1–3 already provisioned (Node 24, npm, SQLite via `better-sqlite3`, the `/data` uploads volume). Success Criterion #5 (deploy to the standing Coolify staging URL) reuses the already-established deploy path from prior phases.

**Step 2.6: effectively SKIPPED** — no external dependencies beyond the already-verified toolchain.

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Everything | ✓ | 24.x (engines `>=24`) | — |
| npm | shadcn add | ✓ | 11.x | — |
| `radix-ui` (Popover) | `{{` suggestion list | ✓ | ^1.6 (installed) | shadcn `popover` add pulls from it |
| SQLite `/data` volume | templates table | ✓ | provisioned Phase 1 | — |
| Uploads `/data/uploads` volume | reading saved CSV back | ✓ | provisioned Phase 3 (`UPLOADS_PATH`) | — |

**Missing dependencies with no fallback:** none
**Missing dependencies with fallback:** none

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `node:test` (built-in) via `tsx` loader |
| Config file | none — glob in `package.json` `test` script |
| Quick run command | `npm test` (runs `node --import tsx --test "lib/**/*.test.ts"`) |
| Full suite command | `npm test` |

Note: the test glob is `lib/**/*.test.ts` — pure logic (helpers, DAL, action-core seams) is where automated coverage lives; client components are validated via the UI checker + staging, consistent with Phases 2–3.

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| EDIT-01 | Compose plain-text subject + body | manual/UI | staging + UI checker | ❌ (UI) |
| EDIT-02 | `{{`-triggered / click-to-insert field autocomplete | manual/UI + unit (insertion helper) | `npm test` (if insertion logic extracted) | ❌ Wave 0 |
| EDIT-03 | Merge fields in BOTH subject + body | unit (already green) | `npm test` (`lib/core/fill.test.ts`) | ✅ |
| EDIT-04 | Save composed subject+body as template | unit (DAL + action-core) | `npm test` (`lib/data/templates.test.ts`, `lib/compose/actions-core.test.ts`) | ❌ Wave 0 |
| PREV-01 | Step through merged rows vs real CSV | unit (fillMessage over rows) + UI | `npm test` (`lib/core/merge.test.ts`) | ❌ Wave 0 |
| PREV-02 | Highlight rows with empty merge values | unit (`analyzeMerge`) | `npm test` (`lib/core/merge.test.ts`) | ❌ Wave 0 |
| PREV-03 | Aggregate validation report (invalid emails + missing values) | unit (action-core aggregate) | `npm test` (`lib/compose/actions-core.test.ts`) | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npm test`
- **Per wave merge:** `npm test`
- **Phase gate:** full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `lib/core/merge.test.ts` — `extractTokens` + `analyzeMerge` (present/empty/unknown classification) → PREV-02/03
- [ ] `lib/csv/storage.test.ts` — extend for `readUpload` (round-trip + traversal-escape rejection) → PREV-01/03
- [ ] `lib/data/templates.test.ts` — userId-scoped create/get/list, IDOR (cross-tenant get returns undefined) → EDIT-04
- [ ] `lib/compose/actions-core.test.ts` — preview aggregate correctness + save happy/failure paths + auth-injection → EDIT-04/PREV-03
- [ ] `lib/compose/schema.test.ts` — subject/body zod caps (non-empty, max length)
- [ ] shadcn: `npx shadcn@latest add textarea popover` (source components, not a test)

## Security Domain

`security_enforcement` is not disabled in `.planning/config.json` — treated as enabled.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Every Server Action re-derives `userId` via Clerk `auth()`; unauthenticated → typed `{ kind: "unauthenticated" }` (established pattern) |
| V3 Session Management | no (delegated) | Clerk owns sessions; nothing new here |
| V4 Access Control | yes | userId-scoped DAL (`getRecipientSetForUser`, new `getTemplateForUser`) — the ONLY read paths; no fetch-by-id-alone. Preview resolves `storage_path` server-side from a userId-scoped row, never from the client (IDOR + path-traversal defense) |
| V5 Input Validation | yes | Shared zod schema for subject/body (non-empty, length caps); `recipientSetId` validated as a number owned by the caller |
| V6 Cryptography | no | No secrets handled this phase (SMTP creds are Phase 2; not touched) |
| V12 File Resources | yes | `readUpload` resolves the relative UUID name against `UPLOADS_DIR` and rejects any path escaping it (mirror of the write seam's traversal defense) |

### Known Threat Patterns for Next.js RSC + Server Actions + SQLite

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| IDOR — preview/read another tenant's CSV or template | Information Disclosure / Elevation | userId-scoped DAL lookup; client passes only `recipientSetId`; never a `storage_path` |
| Path traversal via storage path | Tampering | Server-generated UUID names + `resolve`+prefix-check in `readUpload` |
| Stored XSS in merged preview (CSV cell → HTML) | Tampering | Render merged text as text (JSX escaping); never `dangerouslySetInnerHTML`; plain-text email contract |
| Server Action used as an unauthenticated endpoint | Spoofing / Elevation | Only `actions.ts` wrappers are `"use server"`; `actions-core.ts` seams carry no directive and are not wire-callable |
| DoS via oversized preview payload | Denial of Service | Row cap already enforced at upload (`MAX_ROWS` 5000); preview inherits it; consider a windowed fetch for headroom |
| SQL injection | Tampering | Drizzle parameterized queries only (never string-built SQL) |

## Sources

### Primary (HIGH confidence — read directly this session)
- `lib/core/fill.ts` + `lib/core/fill.test.ts` — merge engine already generalizes to arbitrary tokens over subject+body (EDIT-03 done)
- `lib/core/csv.ts` — `parseCsv`/`detectEmailColumn`/`countInvalidEmails` contracts
- `lib/db/schema.ts` — `templates` (standalone, userId/subject/body), `campaigns.template_id` FK, `recipient_sets.columns_json`/`storage_path`
- `lib/csv/storage.ts` — confirmed ONLY `writeUpload` exists; no read seam (grep-verified)
- `lib/data/recipients.ts` + `lib/data/index.ts` — userId-first DAL pattern; confirmed no templates DAL (grep-verified)
- `lib/csv/actions.ts` + `lib/csv/actions-core.ts` — the actions/core split + typed `ActionError`/`ParseResult` contract
- `components/recipients/csv-uploader.tsx`, `app/(app)/recipients/page.tsx`, `components/app-sidebar.tsx` — RSC-page + client-component + nav patterns
- `.planning/phases/03-csv-upload-parsing-recipient-mapping/03-UI-SPEC.md` — inherited design system (8-pt spacing, 4 sizes/2 weights, single accent, official-shadcn-only)
- `package.json` + `npm ls` — installed versions (next@16.2.9, react@19.2.7, radix-ui ^1.6, zod ^4.4); `radix-ui` exports Popover (node require check)
- `next.config.ts` — Server Action `bodySizeLimit: "4mb"`, `serverExternalPackages` for better-sqlite3
- `CLAUDE.md`, `.planning/REQUIREMENTS.md`, `.planning/STATE.md`, `.planning/ROADMAP.md` — constraints, requirement IDs, decisions

### Secondary (MEDIUM confidence)
- `components.json` `registries: {}` — official-shadcn-only; `textarea`/`popover` are official blocks (Phase 3 precedent with `select`/`table`)

### Tertiary (LOW confidence)
- None — this phase's findings are codebase-internal and directly verified; no unverified web claims were relied upon.

## Project Constraints (from CLAUDE.md)

- **Plain text only** — the editor's value is merge tokens + live preview, NOT rich formatting. No WYSIWYG/HTML. (Reinforced by REQUIREMENTS "Out of Scope".)
- **Tech stack fixed:** Next.js + Clerk + Tailwind + shadcn/ui; SQLite backend; nodemailer BYO-SMTP (not exercised this phase).
- **Naming/style:** camelCase functions/vars, PascalCase types, SCREAMING_SNAKE_CASE module constants; 2-space indent, double quotes, semicolons, trailing commas; ESM (`"type": "module"`).
- **Security carry-forward:** per-user data scoped to the signed-in user on EVERY access (AUTH-02); nothing sensitive logged. (Applies to templates + CSV read-back here.)
- **GSD workflow enforcement:** file edits go through a GSD command; this research feeds the planner.
- **Attribution:** no Claude attribution in-repo; skip the co-author trailer on commits (per project memory).

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries already installed and verified; no new npm deps proposed
- Architecture: HIGH — every pattern is copied from an existing, tested subsystem in this repo
- Pitfalls: HIGH — the two structural gaps (no `readUpload`, no templates DAL) are grep-confirmed, not assumed
- Editor autocomplete choice: MEDIUM — no CONTEXT.md; a defensible zero-dep recommendation flagged `[ASSUMED A1]`

**Research date:** 2026-07-13
**Valid until:** 2026-08-12 (stable — internal-codebase-driven; only shifts if the schema or the actions/DAL conventions change)
