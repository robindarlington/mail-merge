---
phase: quick-260717-tpl
plan: 01
subsystem: compose/templates
tags: [templates, recipient-lists, dal, migration, compose, delete-guard, auth-02]
requires:
  - templates table + createTemplate/getTemplateForUser/listTemplatesForUser DAL
  - recipient_sets table + getRecipientSetForUser/deleteRecipientSetForUser DAL
  - campaigns.template_id FK (NOT NULL, no cascade), PRAGMA foreign_keys=ON
  - saveTemplateCore / previewCampaignCore seams + saveTemplate/previewCampaign actions
  - components/recipients/list-delete.tsx AlertDialog idiom
provides:
  - templates.recipient_set_id nullable FK (drizzle/0007)
  - listTemplatesForRecipientSet / countCampaignsForTemplate / deleteTemplateForUser DAL
  - saveTemplateCore list stamping + deleteTemplateCore in_use guard + deleteTemplate action
  - TemplateLibrary + TemplateDelete UI; per-list library on /lists/[id]; compose reuse picker
affects:
  - lib/db/schema.ts, lib/data/{templates,recipients,index}.ts
  - lib/compose/{actions-core,actions}.ts
  - app/(app)/lists/[id]/page.tsx, app/(app)/compose/page.tsx
  - components/compose/compose-editor.tsx
tech-stack:
  added: []
  patterns:
    - "Nullable additive FK column via plain ALTER (0006 precedent), NULL-scoped rows excluded structurally (D1)"
    - "Transactional cascade delete with FK-throw rollback mapped to in_use (mirrors deleteCampaignForUser)"
    - "Owner-scoped delete seam (getX pre-check -> count guard -> AND(id,userId) DELETE) mirroring deleteCampaignCore"
key-files:
  created:
    - drizzle/0007_new_ben_urich.sql
    - drizzle/meta/0007_snapshot.json
    - components/templates/template-library.tsx
    - components/templates/template-delete.tsx
  modified:
    - lib/db/schema.ts
    - lib/data/templates.ts
    - lib/data/recipients.ts
    - lib/data/index.ts
    - lib/data/templates.test.ts
    - lib/data/recipients.test.ts
    - lib/compose/actions-core.ts
    - lib/compose/actions.ts
    - lib/compose/actions-core.test.ts
    - app/(app)/lists/[id]/page.tsx
    - app/(app)/compose/page.tsx
    - components/compose/compose-editor.tsx
decisions:
  - "D1: recipient_set_id is a nullable FK; NULL-scoped legacy rows are hidden from every list's library via the eq(recipient_set_id, setId) filter (they can never equal a real setId)."
  - "D2: template delete is BLOCKED (in_use) when any campaign references it (countCampaignsForTemplate>0); campaign history + send_records snapshots stay intact."
  - "D3: list delete cascades its templates in one transaction; an FK-referenced list template throws and rolls the whole delete back, propagating so the core maps it to in_use."
metrics:
  duration_min: 10
  tasks: 3
  files_changed: 17
  completed: 2026-07-17
---

# Phase quick-260717-tpl Plan 01: List-Scoped Template Library Summary

Turned write-only saved templates into a browsable, reusable, deletable library scoped to a recipient list — a nullable `recipient_set_id` FK, save-time owner-resolved stamping, an owner-scoped delete seam with a campaign-reference `in_use` guard, a per-list library card on `/lists/[id]`, and a reuse picker in compose that loads subject/body and makes a template immediately sendable.

## What Was Built

### Task 1 — Schema migration + list-scoped templates DAL (TDD)
- Added `templates.recipient_set_id` (nullable FK → `recipient_sets.id`) to `lib/db/schema.ts`; generated `drizzle/0007_new_ben_urich.sql` as a plain `ALTER TABLE templates ADD recipient_set_id integer REFERENCES recipient_sets(id)` (matching the 0006 additive-column precedent). Migration applies cleanly against a copy of `data/app.db`.
- `PersistableTemplate` now carries optional `recipient_set_id`; `createTemplate` still spreads `{ ...values, userId }` with userId LAST (un-spoofable ownership).
- New DAL functions: `listTemplatesForRecipientSet(userId, setId)` (filters `and(eq(userId), eq(recipient_set_id, setId))`, newest first — structurally excludes NULL-scoped rows, D1); `countCampaignsForTemplate(userId, templateId)` (mirrors `countCampaignsForRecipientSet`); `deleteTemplateForUser(userId, id)` (owner-scoped `AND(id,userId)` DELETE returning rows).
- `deleteRecipientSetForUser` converted to a `db.transaction`: deletes the list's templates first, then the set; an FK throw on a campaign-referenced template rolls the whole transaction back (D3) — the throw is not swallowed.

### Task 2 — Save-time stamping + owner-scoped delete seam/action (TDD)
- `saveTemplateCore` now reads `recipientSetId` from FormData, owner-resolves it via `getRecipientSetForUser` before stamping (foreign/bogus → `not_found`, never stamps a list the caller doesn't own), and stamps `recipient_set_id` on the created template. An absent id still saves an unscoped template (backward-compatible).
- New `deleteTemplateCore(userId, id)` seam mirroring `deleteCampaignCore`: `getTemplateForUser` pre-check (→ not_found), `countCampaignsForTemplate > 0` → `in_use` (D2), else `deleteTemplateForUser`; 0-row delete → not_found; thrown error → `{ kind:"unknown", raw: <string> }`.
- New `deleteTemplate` server action in `lib/compose/actions.ts`: `auth()` → `templateIdSchema` coercion → `deleteTemplateCore` → `revalidatePath("/lists/[id]", "page")` on success. `DeleteTemplateResult`/`DeleteTemplateError` re-exported as types.

### Task 3 — Per-list library UI + compose reuse picker
- `components/templates/template-delete.tsx` — a client AlertDialog confirm mirroring `list-delete.tsx`: `deleting` in-flight double-submit guard, `e.preventDefault()` keeps the dialog open on `in_use`, inline destructive Alert for the in_use case, sonner toast + `router.refresh()` on success.
- `components/templates/template-library.tsx` — RSC-friendly presentational card rendering the list's templates (truncated subject + relative save date + `TemplateDelete`), all as escaped JSX; muted empty state.
- `/lists/[id]` fetches `listTemplatesForRecipientSet(userId, set.id)` and renders `<TemplateLibrary>` below the CSV contents card.
- Compose page fetches each set's templates in parallel and passes them on `editorSets`; `ComposeEditor` renders a "Saved templates" Select (shown only when the active set has templates) that fills subject/body and sets `savedTemplateId` (immediately previewable/sendable), stamps `recipientSetId` into the save FormData, and calls `router.refresh()` after a successful save so the server-fetched picker surfaces the new row.

## Deviations from Plan

None — plan executed exactly as written. The plan noted a possible drizzle 12-step table rebuild; drizzle emitted the simpler plain `ALTER TABLE` (the preferred outcome), so no rebuild verification was needed.

## Threat Model Adherence

- T-tpl-IDOR-1/2: every template read/delete filters on `and(eq(userId), ...)`; the library RSC and both server actions re-derive userId via `auth()`; the client only ever proposes ids.
- T-tpl-TAMPER: `recipientSetId` is owner-resolved via `getRecipientSetForUser` before stamping; a foreign id returns `not_found` and nothing is written; userId spread LAST in `createTemplate`.
- T-tpl-INTEG: campaign-referenced templates block delete (`in_use`, D2); list delete cascade rolls back on an FK throw (D3); `send_records` retain merged snapshots.
- T-tpl-XSS: subject/body render as escaped JSX text only (no `dangerouslySetInnerHTML`).

## Verification

- `npm test` — 380 tests pass, 0 fail (17 new tests across the templates DAL, recipients DAL cascade, and compose actions-core seams).
- `npx tsc --noEmit` — clean.
- `npm run build` — succeeds (all routes compiled).
- Migration applied cleanly against a copy of `data/app.db`.

## Known Stubs

None — all data is wired end-to-end (DAL → seam → action → RSC/client). No placeholder or hardcoded-empty rendering paths introduced.

## Commits

- `e4cec29` test: failing tests for list-scoped template DAL (RED)
- `191aa7c` feat: list-scoped templates schema + DAL (GREEN)
- `8965092` test: failing tests for save stamping + delete seam (RED)
- `01170cd` feat: save-time list stamping + owner-scoped template delete (GREEN)
- `2fc2c39` feat: per-list template library + compose reuse picker

## Self-Check: PASSED

All 4 created code/migration files present, SUMMARY present, and all 5 task commits verified in git log. Working tree clean except the uncommitted SUMMARY (the orchestrator handles the docs commit).
