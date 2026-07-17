---
phase: quick-260717-tpl
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - lib/db/schema.ts
  - drizzle/0007_*.sql
  - drizzle/meta/_journal.json
  - lib/data/templates.ts
  - lib/data/recipients.ts
  - lib/data/index.ts
  - lib/data/templates.test.ts
  - lib/data/recipients.test.ts
  - lib/compose/schema.ts
  - lib/compose/actions-core.ts
  - lib/compose/actions.ts
  - lib/compose/actions-core.test.ts
  - components/compose/compose-editor.tsx
  - components/templates/template-library.tsx
  - components/templates/template-delete.tsx
  - app/(app)/compose/page.tsx
  - app/(app)/lists/[id]/page.tsx
autonomous: true
requirements: [TPL-LIB]
must_haves:
  truths:
    - "Saving a template from compose (with a list selected) stamps that list's id onto the template row"
    - "The list detail page (/lists/[id]) shows the templates saved for that list, newest first"
    - "A user can delete a saved template from the list detail page behind an AlertDialog confirm"
    - "Deleting a template that a campaign references is blocked (in_use) and preserves campaign history"
    - "Deleting a list removes its saved templates in the same transaction; a campaign-referenced template blocks the list delete"
    - "In compose, once a list is selected, a picker lists that list's saved templates and loading one fills subject/body and makes it immediately sendable"
    - "Legacy/unscoped templates (recipient_set_id IS NULL) never surface in any list's library"
  artifacts:
    - path: "lib/data/templates.ts"
      provides: "list-scoped template DAL: recipient_set_id stamping, list listing, campaign-reference count, owner-scoped delete"
      contains: "listTemplatesForRecipientSet"
    - path: "components/templates/template-library.tsx"
      provides: "per-list saved-template browse + delete surface"
    - path: "drizzle/0007_*.sql"
      provides: "templates.recipient_set_id nullable FK migration"
  key_links:
    - from: "components/compose/compose-editor.tsx"
      to: "saveTemplate"
      via: "FormData carries recipientSetId (selectedId)"
      pattern: "recipientSetId"
    - from: "lib/compose/actions-core.ts saveTemplateCore"
      to: "createTemplate"
      via: "owner-scoped recipient_set_id stamp"
      pattern: "recipient_set_id"
    - from: "app/(app)/lists/[id]/page.tsx"
      to: "listTemplatesForRecipientSet"
      via: "RSC read for the TemplateLibrary card"
      pattern: "listTemplatesForRecipientSet"
    - from: "components/templates/template-delete.tsx"
      to: "deleteTemplate"
      via: "AlertDialog confirm → owner-scoped server action"
      pattern: "deleteTemplate"
---

<objective>
Turn write-only saved templates into a browsable, reusable, deletable library scoped
to a recipient list.

Rob (operator) reports templates are persisted by compose Save (`saveTemplate` / EDIT-04)
but no UI ever lists, reuses, or deletes them. Locked design decision: **templates are
scoped to a recipient list (one-to-many: recipient_set → templates)** because a template's
`{{column}}` merge fields only make sense against a specific list's columns.

Purpose: close the template lifecycle (create → browse → reuse → delete) with full owner
scoping and campaign-history integrity.
Output: a nullable `recipient_set_id` FK on `templates` + migration, a list-scoped DAL,
save-time stamping, an owner-scoped delete seam/action, a per-list library on the list
detail page, and a reuse picker in compose.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@./CLAUDE.md

<interfaces>
<!-- Contracts already in the codebase the executor builds against. No exploration needed. -->

templates schema today (lib/db/schema.ts) — NO recipient_set_id yet:
```ts
export const templates = sqliteTable("templates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  created_at: integer("created_at").notNull().default(unixNow),
});
```

templates DAL (lib/data/templates.ts) — owner-scoped idiom to mirror:
```ts
export type PersistableTemplate = Pick<NewTemplate, "subject" | "body">;
export function createTemplate(userId: string, values: PersistableTemplate) { /* {...values, userId} LAST */ }
export function listTemplatesForUser(userId: string) { /* eq(userId), desc(created_at) */ }
export function getTemplateForUser(userId: string, id: number) { /* and(eq(id), eq(userId)) */ }
```

recipients DAL (lib/data/recipients.ts) — the delete-guard idiom to mirror for templates,
and the list-delete function to extend:
```ts
export async function countCampaignsForRecipientSet(userId: string, setId: number): Promise<number>
export function deleteRecipientSetForUser(userId: string, id: number) // plain DELETE by and(id, userId), returning()
```

Campaign FK reality (lib/db/schema.ts): `campaigns.template_id` is NOT NULL,
`.references(() => templates.id)`, NO cascade. `PRAGMA foreign_keys = ON` (lib/db/client.ts).
=> a template referenced by any campaign physically cannot be deleted without an FK throw.
=> `send_records` store `merged_subject`/`merged_body` snapshots, so sent content is
   preserved independently of the template row.

Compose save flow today: ComposeEditor `onSave` posts FormData{subject, body} to
`saveTemplate`; on success sets `savedTemplateId`, which SendCard passes as `templateId`
to prepareCampaign. So a library row IS the row a campaign references (no per-campaign
snapshot row exists). The editor already holds `selectedId` (the chosen list id string)
and `activeSet`/`columns`.

Established delete-UI idiom: components/recipients/list-delete.tsx — AlertDialog +
`deleting` in-flight flag (double-submit guard) + `e.preventDefault()` on the action so an
`in_use` result keeps the dialog open + sonner toast + router.refresh().

Migration precedent (drizzle/0006): `ALTER TABLE send_records ADD attachment_id integer
REFERENCES attachments(id);` — a nullable FK column added via plain ALTER. Migrations are
generated by `npm run db:generate` and applied by `npm run db:migrate` (scripts/migrate.ts).
</interfaces>
</context>

<decisions>
Locked/derived design decisions (implement exactly; evidence in <context>):

- **D1 — recipient_set_id is a NULLABLE FK on templates.** Nullable mirrors the additive
  `email_column`/`attachment_column` idiom: existing template rows predate the column.
  Legacy/unscoped rows (`recipient_set_id IS NULL`) are **hidden from every list's library**
  (a null-scoped row belongs to no list and has no known column context) but remain reachable
  by campaigns via `template_id`. No "unassigned" bucket.

- **D2 — Template delete is BLOCKED (in_use) when any campaign references it, else deleted.**
  Direct mirror of the list in-use guard. `campaigns.template_id` NOT NULL + no cascade + FK ON
  means blocking is the only history-preserving option; the campaign keeps its `template_id`
  and send_records keep the merged snapshots, so campaign history stays intact.

- **D3 — Deleting a list cascades its templates transactionally.** The existing
  `countCampaignsForRecipientSet` guard already blocks list deletion whenever a campaign
  references the list, so its list-scoped templates are unsent drafts in the common case →
  safe to delete. Edge case (a template scoped to this list but referenced by a campaign whose
  own recipient_set is a different list): the templates DELETE throws an FK violation → the
  transaction rolls back → the core maps it to `in_use`. Integrity holds either way, consistent
  with the "history-referenced rows block, draft rows cascade" philosophy.
</decisions>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Schema migration + list-scoped templates DAL</name>
  <files>lib/db/schema.ts, drizzle/0007_*.sql, drizzle/meta/_journal.json, lib/data/templates.ts, lib/data/recipients.ts, lib/data/index.ts, lib/data/templates.test.ts, lib/data/recipients.test.ts</files>
  <behavior>
    - createTemplate stamps recipient_set_id when supplied; userId still spread LAST (ownership un-spoofable).
    - listTemplatesForRecipientSet(userId, setId) returns ONLY rows with that userId AND recipient_set_id = setId, newest first; NULL-scoped and cross-tenant rows excluded (D1).
    - countCampaignsForTemplate(userId, templateId) counts the caller's campaigns referencing the template across all statuses (mirrors countCampaignsForRecipientSet).
    - deleteTemplateForUser(userId, id) deletes by AND(id, userId) and returns removed rows; a cross-tenant/absent id removes zero.
    - deleteRecipientSetForUser runs a transaction: delete the set's templates (recipient_set_id = id AND user_id), then the set; an FK throw (a list-scoped template a campaign references) rolls back the whole transaction (D3).
  </behavior>
  <action>
    Add `recipient_set_id: integer("recipient_set_id").references(() => recipient_sets.id)` (NULLABLE — no .notNull()) to the `templates` table in lib/db/schema.ts, placed after `body`. Per D1.

    Generate the migration: run `npm run db:generate`. Inspect the emitted `drizzle/0007_*.sql`.
    Expect a plain `ALTER TABLE templates ADD recipient_set_id integer REFERENCES recipient_sets(id);`
    (the 0006 send_records.attachment_id precedent). A drizzle 12-step table-rebuild is also
    acceptable if it preserves existing rows — verify the INSERT...SELECT copies id/user_id/subject/body/created_at.

    In lib/data/templates.ts:
    - Extend `PersistableTemplate` to `Pick<NewTemplate, "subject" | "body" | "recipient_set_id">`
      (recipient_set_id optional). `createTemplate` still spreads `{ ...values, userId }` — userId LAST (T-TAMPER-OWNER).
    - Add `listTemplatesForRecipientSet(userId, setId)`: `findMany` where `and(eq(userId), eq(recipient_set_id, setId))`,
      `orderBy: desc(created_at)`. This is the library read; the recipient_set_id filter structurally hides NULL-scoped rows (D1).
    - Add `countCampaignsForTemplate(userId, templateId)`: copy the shape of `countCampaignsForRecipientSet`
      but count `campaigns` where `and(eq(campaigns.userId, userId), eq(campaigns.template_id, templateId))`.
    - Add `deleteTemplateForUser(userId, id)`: `db.delete(templates).where(and(eq(id), eq(userId))).returning()`.
      Keep the AUTH-02 owner-filter comment idiom (grep gate).

    In lib/data/recipients.ts: convert `deleteRecipientSetForUser` to run inside `db.transaction((tx) => { ... })`:
    first `tx.delete(templates).where(and(eq(templates.recipient_set_id, id), eq(templates.userId, userId)))`,
    then the existing `tx.delete(recipient_sets)...returning()`; return the set rows. Import `templates` from schema.
    Update the JSDoc to note the cascade + FK-throw-rolls-back behavior (D3). Do NOT swallow the throw here — let it
    propagate so the delete core maps it to in_use.

    Export the three new template functions from lib/data/index.ts alongside the existing templates exports.
  </action>
  <verify>
    <automated>cp data/app.db /tmp/tpl-mig-check.db 2>/dev/null; DATABASE_PATH=/tmp/tpl-mig-check.db npm run db:migrate && npm test -- lib/data/templates.test.ts lib/data/recipients.test.ts 2>&1 | tail -20</automated>
  </verify>
  <done>Migration applies cleanly against a DB copy; new DAL functions pass owner-scoped + list-scoped + cascade tests; recipient_set_id column present on templates.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Save-time stamping + owner-scoped delete seam/action</name>
  <files>lib/compose/schema.ts, lib/compose/actions-core.ts, lib/compose/actions.ts, lib/compose/actions-core.test.ts</files>
  <behavior>
    - saveTemplateCore reads recipientSetId from FormData, owner-scoped resolves it (getRecipientSetForUser); a cross-tenant/bogus id → not_found (never stamps a foreign list); a valid id is stamped as recipient_set_id on the created template.
    - A missing/absent recipientSetId still saves an unscoped template (backward-compatible) — but the compose UI always supplies one.
    - deleteTemplateCore(userId, id): getTemplateForUser first (cross-tenant/bogus → not_found); countCampaignsForTemplate > 0 → in_use (D2); else deleteTemplateForUser; a 0-row delete → not_found.
    - deleteTemplate server action re-derives userId via auth(), rejects unauthenticated, delegates to the core, revalidates the list detail path on success.
  </behavior>
  <action>
    In lib/compose/actions-core.ts `saveTemplateCore`: after the existing composeFormSchema guard, parse
    `formData.get("recipientSetId")` with the positive-int coercion idiom (reuse the `recipientSetIdSchema`
    already defined in this file). If present and valid, call `getRecipientSetForUser(userId, id)`; undefined → return
    `{ ok:false, error:{ kind:"not_found" } }` (never stamp a list the caller does not own — T-IDOR). Pass
    `recipient_set_id: id` into `createTemplate(userId, { ...parsed.data, recipient_set_id })`. If recipientSetId
    is absent, save unscoped as today (recipient_set_id undefined). Per D1.

    Add the delete seam to lib/compose/actions-core.ts (mirror deleteCampaignCore's shape and the DeleteCampaignError union):
    - `export type DeleteTemplateError = { kind:"unauthenticated" } | { kind:"validation"; issues:unknown } | { kind:"not_found" } | { kind:"in_use" } | { kind:"unknown"; raw?:string }`
    - `export type DeleteTemplateResult = { ok:true } | { ok:false; error:DeleteTemplateError }`
    - `deleteTemplateCore(userId, id)`: getTemplateForUser → not_found; `await countCampaignsForTemplate(userId, id)` > 0 → in_use (D2);
      else `deleteTemplateForUser(userId, id)`; if the returned array is empty → not_found; else `{ ok:true }`. Wrap the delete in
      try/catch mapping a thrown error to `{ kind:"unknown", raw:String(...) }` (D-06: raw is always a string).
    Import getTemplateForUser, countCampaignsForTemplate, deleteTemplateForUser from @/lib/data.

    Add the `deleteTemplate` server action to lib/compose/actions.ts (mirror deleteList / the existing saveTemplate wrapper):
    validate `id` via a coerced positive-int schema, auth() → unauthenticated, delegate to `deleteTemplateCore`, and on
    `{ ok:true }` call `revalidatePath("/lists/[id]", "page")` (lazy `next/cache` import, matching the file's lazy-import idiom).
    Re-export DeleteTemplateResult/DeleteTemplateError types.

    No change to lib/compose/schema.ts is required if recipientSetId is parsed inline in the core; if you prefer a shared
    schema, add an exported `saveTemplateInputSchema` there and reuse it — either is acceptable, keep it zod-4 idiomatic.
  </action>
  <verify>
    <automated>npm test -- lib/compose/actions-core.test.ts 2>&1 | tail -20</automated>
  </verify>
  <done>saveTemplateCore stamps an owned list and rejects a foreign one; deleteTemplateCore blocks campaign-referenced templates as in_use and deletes unreferenced ones owner-scoped; deleteTemplate action rejects unauthenticated callers.</done>
</task>

<task type="auto">
  <name>Task 3: Per-list library UI + compose reuse picker</name>
  <files>components/templates/template-library.tsx, components/templates/template-delete.tsx, app/(app)/lists/[id]/page.tsx, app/(app)/compose/page.tsx, components/compose/compose-editor.tsx</files>
  <action>
    Create components/templates/template-delete.tsx ("use client") by mirroring
    components/recipients/list-delete.tsx VERBATIM in structure: AlertDialog + `deleting` in-flight flag
    (double-submit guard), `e.preventDefault()` on AlertDialogAction so an `in_use` result keeps the dialog open,
    an inline destructive Alert for the in_use case ("A campaign used this template, so it can't be deleted
    while that send history exists."), sonner toast on success, and router.refresh(). It calls `deleteTemplate(id)`
    from @/lib/compose/actions and takes `{ id, subject }` props (show a truncated subject as the item label).

    Create components/templates/template-library.tsx (server-friendly presentational, no client hooks needed):
    render the list's templates (props: `templates: { id, subject, body, created_at }[]`) as a Card with one row per
    template — truncated subject + relative date + a <TemplateDelete> affordance. Empty state: a muted "No saved
    templates for this list yet — compose an email and Save to add one." Escape all cell text as JSX (no raw HTML).

    In app/(app)/lists/[id]/page.tsx: after resolving `set`, call
    `listTemplatesForRecipientSet(userId, set.id)` and render <TemplateLibrary templates={...} /> below the CSV
    contents Card (D1: only this list's templates show; NULL-scoped legacy rows never appear).

    Compose reuse picker:
    - In app/(app)/compose/page.tsx: for each editor set, fetch its templates via
      `listTemplatesForRecipientSet(userId, set.id)` and include a `templates` array (id/subject/body) on each
      `editorSets` entry passed to <ComposeEditor>.
    - In components/compose/compose-editor.tsx: add `templates` to the EditorSet type. Render a "Saved templates"
      shadcn Select above the subject field, populated from `activeSet.templates` (only shows when the active set has
      templates). On select, load the chosen template: `form.setValue("subject", t.subject)`, `form.setValue("body", t.body)`,
      and `setSavedTemplateId(t.id)` so the loaded template is immediately previewable/sendable without re-saving.
      Also add `recipientSetId: selectedId` to the FormData built in `onSave` so saves stamp the current list (key_link).
      After a successful save, call `router.refresh()` so the picker (server-fetched) picks up the new row — import
      useRouter from next/navigation.
  </action>
  <verify>
    <automated>npm run build 2>&1 | tail -15</automated>
  </verify>
  <done>List detail page shows the list's saved templates with a working delete confirm; compose shows a saved-templates picker for the selected list that loads subject/body and makes the template sendable; Save stamps recipientSetId; build passes.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| client → server action (saveTemplate/deleteTemplate) | untrusted ids (recipientSetId, template id) cross here |
| app → SQLite | template/list deletes must respect campaign FK integrity |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-tpl-IDOR-1 | Information disclosure | listTemplatesForRecipientSet / getTemplateForUser | mitigate | every read filters on `and(eq(userId), ...)`; no fetch-by-id-alone; library RSC re-derives userId via auth() |
| T-tpl-IDOR-2 | Elevation | deleteTemplate action | mitigate | client sends only `id`; deleteTemplateCore re-resolves owner via getTemplateForUser and deletes by AND(id, userId) |
| T-tpl-TAMPER | Tampering | saveTemplateCore recipient_set_id stamp | mitigate | recipientSetId owner-resolved via getRecipientSetForUser before stamping; foreign/bogus id → not_found, never stamped; userId spread LAST in createTemplate |
| T-tpl-INTEG | Repudiation/Integrity | template + list delete vs campaign history | mitigate | template delete blocked (in_use) when countCampaignsForTemplate>0 (D2); list delete cascade rolls back on FK throw (D3); send_records retain merged snapshots |
| T-tpl-XSS | Tampering | template subject/body render in library | mitigate | rendered as escaped JSX text only (no dangerouslySetInnerHTML) |
</threat_model>

<verification>
- `npm test` passes (all existing + new DAL/action tests).
- Migration applies cleanly against a copy of data/app.db.
- `npm run build` succeeds.
- Manual smoke (staging): save a template with a list selected → it appears on /lists/[id]; open compose, pick the list, load the template → subject/body fill; delete it from /lists/[id]; a template used by a campaign shows in_use on delete; deleting a list with only draft templates succeeds.
</verification>

<success_criteria>
- templates.recipient_set_id nullable FK exists and is stamped on save when a list is selected.
- The list detail page lists that list's templates; NULL-scoped legacy rows never appear.
- Templates are reusable from compose (load subject/body, immediately sendable) and deletable behind the AlertDialog idiom.
- Campaign history is never broken: campaign-referenced templates block delete; list delete cascades draft templates and rolls back on an FK-referenced one.
- All mutations owner-scoped (Clerk userId) across the actions / actions-core / lib/data seams, with tests at each seam.
</success_criteria>

<output>
Create `.planning/quick/260717-tpl-template-library-list-scoped/260717-tpl-SUMMARY.md` when done.
</output>
