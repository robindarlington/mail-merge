---
phase: quick-260714-dxm
plan: 01
subsystem: web-ui
tags: [lists, csv-viewer, rename, idor, rsc]
requires:
  - listRecipientSetsForUser (lib/data)
  - getRecipientSetForUser (lib/data)
  - readUpload (lib/csv/storage)
  - parseCsv (lib/core/csv)
provides:
  - /lists index route (renamed from /recipients)
  - /lists/[id] CSV contents viewer
  - /recipients redirect stub -> /lists
affects:
  - components/app-sidebar.tsx
  - app/(app)/compose/page.tsx
tech-stack:
  added: []
  patterns:
    - userId-scoped DAL read + notFound() as structural IDOR gate
    - integer-validate dynamic [id] param before any DAL touch
    - escaped JSX text for untrusted CSV cell values (no raw-HTML sink)
    - shadcn Table built-in overflow-x-auto keeps 640px shell fixed
key-files:
  created:
    - app/(app)/lists/[id]/page.tsx
    - app/(app)/recipients/page.tsx (redirect stub)
  modified:
    - app/(app)/lists/page.tsx (moved from recipients, rows link to detail)
    - components/app-sidebar.tsx
    - app/(app)/compose/page.tsx
decisions:
  - Reused formatRelativeDate inline in the detail page rather than lifting a shared helper (keep it simple, one small duplication over premature abstraction)
  - Kept the Users sidebar icon for the renamed Lists item (low churn, still fitting)
metrics:
  tasks: 2
  files: 5
  completed: 2026-07-14
---

# Phase quick-260714-dxm Plan 01: Rename Recipients to Lists + CSV Viewer Summary

Renamed the user-facing "Recipients" surface to "Lists" (with a redirect stub keeping
`/recipients` alive) and added a per-upload CSV contents viewer at `/lists/[id]` that
renders upload metadata, column badges, and a rows table capped at 100 — all reads
userId-scoped with `notFound()` on miss and cell values escaped as plain JSX text.

## What Was Built

### Task 1 — Rename /recipients to /lists (commit 868d492)
- `git mv` moved `app/(app)/recipients/page.tsx` to `app/(app)/lists/page.tsx`
  (history preserved); component renamed `RecipientsPage` -> `ListsPage`, heading
  "Recipients" -> "Lists", empty-state copy reworded to CSV-list framing, JSDoc route
  reference updated to `/lists`.
- New `app/(app)/recipients/page.tsx` redirect stub server-redirects to `/lists` so old
  bookmarks/links never dead-end (route-level; no next.config change).
- Sidebar NAV_ITEMS entry changed to `{ title: "Lists", href: "/lists", icon: Users }`;
  existing `startsWith(\`${item.href}/\`)` active-detection already lights the nav on
  `/lists/[id]`.
- Compose empty-state link + JSDoc updated from `/recipients` to `/lists` ("Go to lists").

### Task 2 — CSV contents viewer at /lists/[id] (commit ae7e18d)
- New RSC `app/(app)/lists/[id]/page.tsx`: awaits `params` (Next 16 Promise), parses `id`
  with `Number.parseInt` + `Number.isInteger` guard -> `notFound()` on a bad param before
  any DAL touch (T-dxm-02).
- Auth-derives `userId`; reads exclusively via `getRecipientSetForUser(userId, id)` and
  `notFound()`s on `undefined` — the structural IDOR gate (T-dxm-01 / AUTH-02).
- Reads stored bytes via traversal-guarded `readUpload` and parses with `parseCsv`; renders
  metadata (filename, uploaded-relative, row count, column count), column `Badge` chips, and
  a shadcn `Table` of the first 100 rows. Cells render `row[col] ?? ""` as escaped JSX text
  only — no raw-HTML sink (T-dxm-03).
- "Showing first 100 of N rows" caption when capped; a clear "This CSV has no columns to
  display." message for the empty-CSV edge case.
- `/lists` index rows are now neutral clickable `next/link`s to `/lists/${set.id}` with a
  `hover:bg-muted` affordance (one-accent discipline — no per-row accent button).

## Verification

- `npx tsc --noEmit` — PASS (both tasks)
- `npm run build` — PASS; routes emitted: `/lists`, `/lists/[id]`, `/recipients` (redirect stub)
- `npm test` — PASS (189/189)
- No `href="/recipients"` remains in `app/` or `components/`
- No `dangerouslySetInnerHTML` in the detail page (grep gate clean)

### Manual browser check — VERIFIED 2026-07-14 (orchestrator-driven, Chrome on localhost:3000)

> /lists renders with sidebar "Lists"; reels-test.csv row links to /lists/2 which shows metadata (21 rows / 7 columns), column chips incl. spaced names, and the rows table with working horizontal scroll (Email column reachable); /recipients redirects to /lists. Original checklist follows.
Not performed by the executor. To verify: sidebar "Lists" navigates to `/lists`;
`/recipients` redirects to `/lists`; clicking an uploaded CSV opens `/lists/[id]` showing
columns + rows; a CSV with >100 rows shows the "Showing first 100 of N rows" note and the
table scrolls horizontally without widening the shell; a nonexistent id shows the 404.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] JSDoc comment tripped the raw-HTML grep gate**
- **Found during:** Task 2 verification
- **Issue:** The security JSDoc named the forbidden `dangerouslySetInnerHTML` API in prose,
  causing the plan's grep safety gate (`grep -q "dangerouslySetInnerHTML"`) to report a
  false positive "raw HTML present".
- **Fix:** Reworded the comment to "no raw-HTML injection sink" — same intent, no literal
  token — so the gate reads clean while the discipline note remains.
- **Files modified:** app/(app)/lists/[id]/page.tsx
- **Commit:** ae7e18d

## Known Stubs

None. `/recipients` is an intentional redirect stub (not a data stub); the detail page wires
real parsed CSV data.

## Self-Check: PASSED
- All 5 created/modified files present on disk.
- Both task commits (868d492, ae7e18d) present in git log.
