---
phase: quick-260714-dxm
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - app/(app)/lists/page.tsx
  - app/(app)/recipients/page.tsx
  - app/(app)/lists/[id]/page.tsx
  - components/app-sidebar.tsx
  - app/(app)/compose/page.tsx
autonomous: true
requirements: [QUICK-260714-dxm]
user_setup: []

must_haves:
  truths:
    - "Sidebar shows a 'Lists' nav item that routes to /lists"
    - "Visiting /recipients redirects to /lists (no dead bookmark)"
    - "The /lists page lists each uploaded CSV; each row links to a detail page"
    - "The detail page shows the CSV's columns and its rows (first 100, capped with a count note)"
    - "A user can only open their own uploads; another tenant's id returns notFound"
    - "CSV cell values render as escaped text (no HTML injection from cell content)"
  artifacts:
    - path: "app/(app)/lists/page.tsx"
      provides: "Renamed Lists index page (moved from recipients), rows link to detail"
      contains: "listRecipientSetsForUser"
    - path: "app/(app)/recipients/page.tsx"
      provides: "Redirect stub /recipients -> /lists"
      contains: "redirect"
    - path: "app/(app)/lists/[id]/page.tsx"
      provides: "CSV contents viewer: metadata + columns + rows table"
      contains: "getRecipientSetForUser"
    - path: "components/app-sidebar.tsx"
      provides: "Nav item titled Lists pointing at /lists"
      contains: "/lists"
  key_links:
    - from: "app/(app)/lists/page.tsx"
      to: "app/(app)/lists/[id]/page.tsx"
      via: "next/link href to /lists/${set.id}"
      pattern: "/lists/\\$\\{"
    - from: "app/(app)/lists/[id]/page.tsx"
      to: "getRecipientSetForUser"
      via: "userId-scoped DAL read then notFound() on miss"
      pattern: "getRecipientSetForUser"
    - from: "app/(app)/lists/[id]/page.tsx"
      to: "readUpload + parseCsv"
      via: "read stored bytes then parse to columns/rows"
      pattern: "parseCsv\\(readUpload"
---

<objective>
Rename the user-facing "Recipients" surface to "Lists" and add a per-upload CSV
contents viewer so a signed-in user can open any uploaded CSV and inspect its
columns and rows in the browser.

Purpose: The page currently only confirms an upload happened; users can't see
what's actually inside a saved CSV (columns, odd header names, row values). This
makes each upload inspectable/debuggable and clarifies that the page holds CSV
data, not just "recipients".

Output: `/lists` index (renamed from `/recipients`, old URL still works via a
redirect stub), a `/lists/[id]` detail page rendering upload metadata + column
list + a capped rows table, and updated sidebar/compose navigation copy.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@./CLAUDE.md

<interfaces>
<!-- Contracts the executor needs. Extracted from the codebase — no exploration required. -->

From lib/data (barrel, @/lib/data) — all reads are userId-scoped (AUTH-02 / IDOR):
```typescript
// listRecipientSetsForUser(userId): rows newest-first
// getRecipientSetForUser(userId: string, id: number): single row or undefined
// row shape (recipient_sets): {
//   id: number; userId: string; filename: string;
//   columns_json: string;      // JSON array of header names
//   row_count: number;         // stored count
//   storage_path: string;      // relative <uuid>.csv on the /data volume
//   email_column: string | null;
//   created_at: number;        // unixepoch seconds
// }
```

From lib/csv/storage.ts:
```typescript
export function readUpload(storagePath: string): Buffer; // traversal-guarded read
```

From lib/core/csv.ts:
```typescript
export interface ParsedCsv {
  columns: string[];          // BOM-stripped, ordered header names
  rows: Record<string,string>[];
  invalidEmailCount: number;
  parseErrors: Papa.ParseError[];
}
export function parseCsv(input: string | Buffer): ParsedCsv;
```

UI primitives available: components/ui/{card,table,badge,separator}.tsx.
The shadcn `Table` primitive's default wrapper is `<div class="relative w-full
overflow-x-auto">`, so wide tables scroll horizontally INSIDE the shell's 640px
(`max-w-2xl`) content column — no shell/layout change (06-UI-SPEC Assumption U6).

Existing list page already defines a private `formatRelativeDate(unixSeconds)`
helper (RelativeTimeFormat) — reuse it verbatim after the move.
</interfaces>

<!-- 06-UI-SPEC copy/design discipline (inherited): verb+noun CTAs, actionable
     empty states, Label text at text-sm (14px), muted metadata via
     text-muted-foreground, one-accent discipline (never render an accent button
     per row — a neutral clickable row / link is the pattern). -->
</context>

<tasks>

<task type="auto">
  <name>Task 1: Rename /recipients route to /lists with a redirect stub and nav/compose plumbing</name>
  <files>app/(app)/lists/page.tsx, app/(app)/recipients/page.tsx, components/app-sidebar.tsx, app/(app)/compose/page.tsx</files>
  <action>
    Move the existing list page to the new route and leave a redirect behind at the old URL:
    - `git mv "app/(app)/recipients/page.tsx" "app/(app)/lists/page.tsx"` (preserves history; keeps the `formatRelativeDate` helper and the userId-scoped `listRecipientSetsForUser` load intact).
    - In the moved `app/(app)/lists/page.tsx`: rename the component to `ListsPage`, change the `<h1>` from "Recipients" to "Lists", and update the empty-state copy so it reads as CSV lists, not only recipients — e.g. title "Upload your first list" and a description noting that uploaded CSVs appear here to open and view (keep verb+noun CTA / actionable empty-state discipline; do NOT add merge-field-spaces copy — out of scope). Do NOT wire the row-to-detail links here; Task 2 owns that (it re-touches this file).
    - Update the top JSDoc route reference from `/recipients` to `/lists`.
    - Create a new `app/(app)/recipients/page.tsx` redirect stub: a default-exported component that calls `redirect("/lists")` from `next/navigation` (route-level stub — do NOT touch next.config). Keep it minimal with a one-line JSDoc explaining the rename kept the old URL alive.
    - In `components/app-sidebar.tsx` NAV_ITEMS: change the `{ title: "Recipients", href: "/recipients", icon: Users }` entry to `{ title: "Lists", href: "/lists", icon: Users }` (keep the `Users` icon — a fitting, low-churn choice; leave the import as-is). The existing `pathname.startsWith(`${item.href}/`)` active-detection already lights the nav for `/lists/[id]`.
    - In `app/(app)/compose/page.tsx`: update the empty-state link at ~line 66 from `<Link href="/recipients">Go to recipients</Link>` to `<Link href="/lists">Go to lists</Link>`, and update the JSDoc/empty-state prose that says "points the user at /recipients" to "/lists". Keep verb+noun CTA style ("Go to lists").
  </action>
  <verify>
    <automated>cd /Users/rob/Desktop/projects/Apps/mail-merge && npx tsc --noEmit && grep -rn "href=\"/recipients\"" app components || echo "no stale /recipients links"</automated>
  </verify>
  <done>`/lists` renders the upload list with the "Lists" heading; visiting `/recipients` redirects to `/lists`; sidebar shows "Lists" -> /lists; compose empty-state links to /lists with "Go to lists". `tsc --noEmit` passes and no stale `href="/recipients"` remains.</done>
</task>

<task type="auto">
  <name>Task 2: Add the CSV contents detail page and link list rows to it</name>
  <files>app/(app)/lists/[id]/page.tsx, app/(app)/lists/page.tsx</files>
  <action>
    Create `app/(app)/lists/[id]/page.tsx` as an RSC mirroring the auth pattern of the other (app) pages, with an exported-function JSDoc (per conventions):
    - Signature reads the dynamic segment via `params` (Next 16: `params` is a Promise — `const { id } = await params`). Parse the id with `Number.parseInt(id, 10)`; if `Number.isNaN` or `!Number.isInteger`, call `notFound()` immediately (never pass a bad id to the DAL).
    - `const { userId } = await auth()`. If no `userId`, `notFound()`. Then `const set = await getRecipientSetForUser(userId, parsedId)`; if `!set`, `notFound()`. This is the IDOR gate — an id owned by another tenant (or absent) resolves to notFound, never another user's data.
    - Read + parse the stored CSV: `const parsed = parseCsv(readUpload(set.storage_path))`. Derive `const columns = parsed.columns` and `const rows = parsed.rows`. Cap the table body: `const CAP = 100; const shown = rows.slice(0, CAP); const capped = rows.length > CAP`.
    - Render inside the standard `<div className="flex flex-col gap-8">` shell with an `<h1 className="text-[28px] font-semibold leading-[1.2]">` showing the upload name (`set.filename`), and a small back link to `/lists`.
    - Metadata block (a `Card` or a muted `text-sm` row): filename, uploaded date (reuse the same relative-date approach — you may lift `formatRelativeDate` into a tiny shared spot OR inline an equivalent; keep it simple, do NOT over-engineer), row count (`set.row_count`), and column count (`columns.length`).
    - Column list: render `columns` as a wrapped set of neutral `Badge` chips (or a comma-joined `text-sm` line) so odd/spaced header names are visible. Label text at `text-sm`, muted where it's metadata.
    - Rows table: use the shadcn `Table` primitive (its built-in `overflow-x-auto` wrapper keeps the shell's 640px column fixed and scrolls wide data horizontally — 06-UI-SPEC U6; do NOT add a layout escape hatch). Header row = `columns`; body = `shown.map(...)` with one `<TableCell>` per column rendering `row[col] ?? ""` as PLAIN escaped JSX text — NEVER `dangerouslySetInnerHTML` (stored-XSS discipline). Give each row/cell a stable key (row index + column name).
    - When `capped`, render a muted `text-sm` caption below the table: `Showing first 100 of {rows.length} rows`.
    - Empty CSV edge case: if `columns.length === 0`, render a muted "This CSV has no columns to display." line instead of an empty table (actionable/clear empty state).
    - Then edit `app/(app)/lists/page.tsx`: wrap each uploaded-set item in a `next/link` `<Link href={`/lists/${set.id}`}>` so the whole row is a neutral clickable link to its detail page (one-accent discipline — a clickable row, NOT an accent button per row). Add a subtle hover affordance (e.g. `hover:bg-muted rounded` on the row) consistent with the existing card styling.
  </action>
  <verify>
    <automated>cd /Users/rob/Desktop/projects/Apps/mail-merge && npx tsc --noEmit && grep -q "dangerouslySetInnerHTML" "app/(app)/lists/[id]/page.tsx" && echo "FAIL: raw HTML present" || echo "OK: no raw HTML"; grep -q "getRecipientSetForUser" "app/(app)/lists/[id]/page.tsx" && grep -q "notFound" "app/(app)/lists/[id]/page.tsx" && echo "OK: IDOR-scoped read + notFound"</automated>
  </verify>
  <done>Detail page at `/lists/[id]` shows metadata + column list + a rows table capped at 100 (with a "Showing first 100 of N rows" note when capped); a bad/foreign id returns notFound; cell values are escaped JSX text; each row on `/lists` links to its detail page. `tsc --noEmit` passes.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| client → RSC route param `[id]` | Untrusted id string; must be integer-validated and owner-scoped before any read |
| stored CSV bytes → rendered HTML | CSV cell content is attacker-influenced data; crosses into the DOM |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-dxm-01 | Information Disclosure | `/lists/[id]` read of another tenant's upload (IDOR) | mitigate | Read exclusively via `getRecipientSetForUser(userId, id)`; `notFound()` on `undefined` — no fetch-by-id-alone path (reuses AUTH-02 DAL invariant) |
| T-dxm-02 | Tampering | Non-integer/overflow `[id]` param | mitigate | `Number.parseInt` + `Number.isInteger` guard; `notFound()` before touching the DAL |
| T-dxm-03 | Elevation/Injection | Stored XSS via CSV cell values rendered to DOM | mitigate | Render cell values as escaped JSX text only; `dangerouslySetInnerHTML` forbidden (grep-gated in Task 2 verify) |
| T-dxm-04 | Information Disclosure | Path traversal via `storage_path` | accept | `readUpload` already prefix-checks against UPLOADS_DIR (V12); path originates from the userId-scoped row, never the client |
</threat_model>

<verification>
- `npx tsc --noEmit` passes (both tasks).
- `npm run build` succeeds (Next.js compiles the new dynamic route and redirect stub).
- `npm test` regression green (no new pure helper introduced; existing node:test suite unaffected).
- No `href="/recipients"` remains in `app/` or `components/`.
- No `dangerouslySetInnerHTML` in the detail page.
- Manual browser check (note for executor SUMMARY): sidebar "Lists" navigates to `/lists`; `/recipients` 308/redirects to `/lists`; clicking an uploaded CSV opens `/lists/[id]` showing columns + rows; a CSV with >100 rows shows the "Showing first 100 of N rows" note and the table scrolls horizontally without widening the shell; visiting a nonexistent id shows the 404.
</verification>

<success_criteria>
- The user-facing page is "Lists" (sidebar + heading + compose link), and the old `/recipients` URL still resolves via redirect.
- Each uploaded CSV on `/lists` opens a detail page showing its columns and rows (capped at 100 with a count note).
- Reads are userId-scoped with `notFound()` on miss; CSV cell values render as escaped text only.
- Zero new npm dependencies; DB/DAL/schema naming unchanged; `components/recipients/csv-uploader.tsx` left in place (no import churn).
</success_criteria>

<output>
Create `.planning/quick/260714-dxm-rename-recipients-page-to-lists-and-add-/260714-dxm-SUMMARY.md` when done.
</output>
