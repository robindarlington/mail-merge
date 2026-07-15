---
phase: quick-260715-r8d
plan: 01
status: complete
subsystem: web-ui
tags: [lists, rename, label, idor, drizzle-migration, rsc, client-island]
requires:
  - recipient_sets table (lib/db/schema)
  - getRecipientSetForUser (lib/data) — owner-scoping idiom
  - listRecipientSetsForUser (lib/data)
  - ActionError union (lib/csv/actions-core)
provides:
  - recipient_sets.label nullable column (migration 0005)
  - renameRecipientSet owner-scoped DAL (lib/data)
  - renameList validated server action (lib/csv/actions)
  - ListRename inline-edit client island (components/recipients)
affects:
  - app/(app)/lists/page.tsx
  - app/(app)/lists/[id]/page.tsx
  - app/(app)/compose/page.tsx
tech-stack:
  added: []
  patterns:
    - nullable additive column + committed drizzle migration (test harness migrate picks it up)
    - owner-scoped UPDATE AND(id, userId) — cross-tenant id is a silent zero-row no-op (T-r8d-01/IDOR)
    - zod trim+min(1)+max(60) label validation before any write (T-r8d-02)
    - display name everywhere as `label ?? filename`, original filename preserved
    - client island isolated OUTSIDE the whole-row <Link> anchor
key-files:
  created:
    - drizzle/0005_list_label.sql
    - components/recipients/list-rename.tsx
  modified:
    - lib/db/schema.ts
    - lib/data/recipients.ts
    - lib/data/index.ts
    - lib/data/recipients.test.ts
    - lib/csv/schema.ts
    - lib/csv/actions-core.ts
    - lib/csv/actions.ts
    - app/(app)/lists/page.tsx
    - app/(app)/lists/[id]/page.tsx
    - app/(app)/compose/page.tsx
decisions:
  - Mirrored the 06.1 smtp_configs.label precedent (nullable, additive, no backfill) rather than a notNull column with a data migration — existing rows fall back to filename
  - Added an optional showName prop to ListRename during the walkthrough so the detail header can render the editable name without duplicating the H1 (non-blocking, no security impact)
metrics:
  tasks: 2
  files: 11
  completed: 2026-07-15
---

# Phase quick-260715-r8d Plan 01: Make List Info Editable Summary

Made an uploaded list's display name editable inline — from the Lists page rows and
the list detail header — backed by a nullable `recipient_sets.label` column, an
owner-scoped `renameRecipientSet` DAL, and a zod-validated `renameList` server action.
Every list name now renders as `label ?? filename`, so friendly names replace raw CSV
filenames in the UI while the original filename stays preserved and visible on the
detail page.

## What Was Built

### Task 1 — label column, migration, owner-scoped rename DAL + action (commit 60eb0fe)
- Added a nullable `label` column to `recipient_sets` in `lib/db/schema.ts`, copying the
  `smtp_configs.label` idiom (nullable, additive, no backfill — NULL rows fall back to
  filename).
- Generated and committed drizzle migration `0005_list_label.sql`
  (`ALTER TABLE recipient_sets ADD label text;`) plus the updated `drizzle/meta/` journal,
  so the test-harness `migrate()` on the throwaway temp DB sees the new column.
- `renameRecipientSet(userId, id, label)` in `lib/data/recipients.ts`:
  `db.update(...).set({ label }).where(and(eq(id), eq(userId))).returning()` — the SAME
  AND(id, userId) owner filter as `getRecipientSetForUser`, no update-by-id-alone path
  (T-r8d-01 / AUTH-02). Exported from `lib/data/index.ts`.
- `renameListSchema` in `lib/csv/schema.ts`: `z.string().trim().min(1).max(60)`, mirroring
  smtpFormSchema.label (T-r8d-02).
- `renameRecipientSetCore(userId, id, rawLabel)` in `lib/csv/actions-core.ts`: safeParse
  label + validate id as positive int (validation errors), call the DAL, and treat a
  zero-row result (cross-tenant / unknown id) as a non-mutating `unknown` result — no throw,
  no leak.
- `renameList(id, label)` "use server" action in `lib/csv/actions.ts`: lazy `auth()`,
  reject unauthenticated, delegate to the core, revalidate on success.
- Extended `lib/data/recipients.test.ts` with two owner-scoped tests: owner rename reads
  back; User B renaming User A's set updates zero rows / label unchanged.

### Task 2 — inline rename island wired into both surfaces (commit cdc7a49)
- `components/recipients/list-rename.tsx` "use client" island (mirrors csv-uploader seams:
  useRouter, useState for value/pending/error, sonner toast). Display mode shows the name
  with a lucide `Pencil` ghost icon button; edit mode shows a shadcn `Input` prefilled with
  the current name plus Save/Cancel. Save trims client-side, blocks empty inline (keeps old
  name, no action call), disables Save while in flight (double-submit guard), calls
  `renameList(id, value)`, and on `{ ok:true }` toasts + `router.refresh()`.
- `app/(app)/lists/page.tsx`: per-row display now `set.label ?? set.filename`; each row
  restructured so `<ListRename>` sits as a flex sibling OUTSIDE the whole-row `<Link>`
  (which becomes `flex-1`), preserving the FileSpreadsheet icon, count, and relative date
  inside the anchor.
- `app/(app)/lists/[id]/page.tsx`: header renders the label-aware name with the inline
  rename control; the "Filename" field still shows the ORIGINAL `set.filename`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing functionality] Renamed labels not shown in /compose recipient selector**
- **Found during:** Task 3 human-verify walkthrough
- **Issue:** After renaming a list, the /compose recipient selector still displayed the raw
  filename, so the friendly name was not applied everywhere a list is chosen.
- **Fix:** Compose page threads the label through; the selector now shows
  "Label (filename) — N recipients", keeping `label ?? filename` consistent across surfaces.
- **Files modified:** app/(app)/compose/page.tsx
- **Commit:** b3dae53

**2. [Executor deviation] Optional showName prop on ListRename**
- **Found during:** Task 2 / detail-header wiring
- **Issue:** The detail header needed the editable name without duplicating the H1.
- **Fix:** Added an optional `showName` prop to ListRename so the header can render the
  name inline through the same island. Non-blocking; no security impact.
- **Files modified:** components/recipients/list-rename.tsx
- **Commit:** cdc7a49

## Human Verification — APPROVED 2026-07-15

User verified rename works on Lists rows and the detail header, persists across refresh,
and the original filename is preserved on the detail page. The one follow-up surfaced
during verification (labels missing from the /compose selector) was fixed same-day in
commit b3dae53. Final state: `npx tsc --noEmit` clean, `npm test` 212/212 pass,
`npm run build` passes.

## Verification

- `npx tsc --noEmit` — PASS
- `npm test` — PASS (212/212)
- `npm run build` — PASS
- Migration `0005_list_label.sql` committed under drizzle/ and picked up by the test-harness migrate()
- Renaming persists across refresh; original filename preserved on the detail page
- Empty/whitespace submit blocked inline; over-60-char rejected; UPDATE scoped by AND(id, userId)

## Known Stubs

None. The label column and rename path wire real owner-scoped data end to end.

## Self-Check: PASSED

- Created files present: drizzle/0005_list_label.sql, components/recipients/list-rename.tsx
- Modified files present: lib/db/schema.ts, lib/data/recipients.ts, lib/data/index.ts, lib/data/recipients.test.ts, lib/csv/schema.ts, lib/csv/actions-core.ts, lib/csv/actions.ts, app/(app)/lists/page.tsx, app/(app)/lists/[id]/page.tsx, app/(app)/compose/page.tsx
- Commits present in git log: 60eb0fe (Task 1), cdc7a49 (Task 2), b3dae53 (compose selector follow-up)
