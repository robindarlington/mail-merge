---
phase: quick-260718-tdl
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - lib/compose/actions-core.ts
  - lib/compose/actions-core.test.ts
  - components/templates/template-library.tsx
  - app/(app)/compose/page.tsx
  - components/compose/compose-editor.tsx
  - components/compose/loaded-template-delete.tsx
autonomous: true
requirements: [TDL-01, TDL-02]
must_haves:
  truths:
    - "Clicking a saved template on /lists/[id] opens /compose with that template's list preselected and subject/body populated"
    - "A foreign or bogus ?template= id is silently ignored (no data leak, no crash) — compose renders its normal empty editor"
    - "When a saved template is loaded in /compose (deep link, reuse picker, or just-saved), a delete affordance is shown"
    - "Confirming delete removes the template, clears the editor subject/body, and toasts success"
    - "An in_use template (referenced by a campaign) surfaces the friendly in_use message and still offers a local clear-fields action"
  artifacts:
    - path: "lib/compose/actions-core.ts"
      provides: "resolveInitialTemplateCore owner-scoped deep-link resolver seam"
      contains: "resolveInitialTemplateCore"
    - path: "components/compose/loaded-template-delete.tsx"
      provides: "In-compose loaded-template delete AlertDialog affordance"
    - path: "app/(app)/compose/page.tsx"
      provides: "searchParams.template resolution wired into ComposeEditor initialTemplate"
  key_links:
    - from: "components/templates/template-library.tsx"
      to: "/compose?template=<id>"
      via: "next/link href"
      pattern: "compose\\?template="
    - from: "app/(app)/compose/page.tsx"
      to: "resolveInitialTemplateCore"
      via: "server-side owner-scoped resolve"
      pattern: "resolveInitialTemplateCore"
    - from: "components/compose/loaded-template-delete.tsx"
      to: "deleteTemplate"
      via: "server action call"
      pattern: "deleteTemplate\\("
---

<objective>
Add two seams on top of yesterday's list-scoped template library (260717-tpl):

1. **One-click open** — a template on `/lists/[id]` becomes a deep link to
   `/compose?template=<id>`; the compose RSC resolves the id OWNER-SCOPED
   server-side (reusing the already-tested `getTemplateForUser` DAL), then hands
   the editor an `initialTemplate` that preselects the template's list and
   populates subject/body — reusing the exact client load path the reuse picker
   already uses (`savedTemplateId` + form field fill).

2. **In-compose delete** — when a template is loaded in `/compose` (via deep link,
   reuse picker, or a fresh save — all of which set `savedTemplateId`), show a
   delete affordance that calls the existing `deleteTemplate` action, clears the
   editor on success, and on `in_use` surfaces the existing friendly error while
   still offering a local clear-fields escape hatch.

Purpose: close the loop between the template library and compose — browse a
template, open it in one click, and manage (delete) it from where it is used.
Output: one new tested server seam, one new client affordance, and thin wiring
into the existing compose RSC + editor + library components. No duplication of
the DAL, action, or AlertDialog idiom — extend the established seams.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/quick/260717-tpl-template-library-list-scoped/260717-tpl-SUMMARY.md

<interfaces>
<!-- Existing seams the executor extends — DO NOT re-derive or duplicate. -->

From lib/data/templates.ts (owner-scoped DAL, already exported via @/lib/data):
```typescript
// findFirst filtered by AND(id, userId) — the IDOR-safe fetch-by-id path.
export function getTemplateForUser(userId: string, id: number):
  Promise<{ id: number; subject: string; body: string; recipient_set_id: number | null; created_at: number } | undefined>;
```

From lib/compose/actions.ts (server actions — the client-invocable surface):
```typescript
export async function deleteTemplate(id: unknown): Promise<DeleteTemplateResult>;
// DeleteTemplateResult = { ok: true } | { ok: false; error: DeleteTemplateError }
// DeleteTemplateError kinds: unauthenticated | validation | not_found | in_use | unknown
```

From components/compose/compose-editor.tsx (client editor — existing state to reuse):
- `selectedId: string` — the preselected recipient list (String(set.id)); already initialized from sets[0].
- `savedTemplateId: number | null` — set by loadTemplate() (reuse picker) AND onSave(); this IS the "currently loaded template id" the delete affordance keys off.
- `form` (react-hook-form): `form.setValue("subject" | "body", value, { shouldValidate, shouldDirty })`.
- `loadTemplate(templateId)` fills subject/body + sets savedTemplateId — the client load path to mirror for deep links.

From lib/compose/actions-core.test.ts (test harness pattern to reuse):
- Dynamic imports AFTER setting DATABASE_PATH/UPLOADS_PATH; `seedSet(userId, csv, emailColumn)`; `createTemplate(userId, {...})`; USER_A / USER_B constants for IDOR assertions.
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Owner-scoped deep-link resolver seam + one-click open wiring</name>
  <files>lib/compose/actions-core.ts, lib/compose/actions-core.test.ts, components/templates/template-library.tsx, app/(app)/compose/page.tsx, components/compose/compose-editor.tsx</files>
  <behavior>
    resolveInitialTemplateCore(userId, rawParam):
    - Test 1: a template owned by USER_A resolves for USER_A → returns { id, subject, body, recipientSetId } matching the seeded row.
    - Test 2 (IDOR): USER_A's template id resolved for USER_B → returns null (never leaks another tenant's subject/body).
    - Test 3: a non-numeric / 0 / negative / absent rawParam → returns null (no DB touch beyond the guard).
    - Test 4: a valid-but-nonexistent id → returns null.
    - Test 5: an unscoped template (recipient_set_id null) resolves → returns null recipientSetId (still loads subject/body; the page/editor default the list).
  </behavior>
  <action>
    Add `resolveInitialTemplateCore(userId: string, rawParam: unknown)` to
    lib/compose/actions-core.ts (plain userId-accepting seam, NO server-action
    directive — same rationale as the other *Core seams in this file). Validate
    rawParam with the existing `templateIdSchema`-style positive-int coercion
    (reuse/mirror the local `recipientSetIdSchema` pattern already in the file);
    on failure return null. Call the already-imported `getTemplateForUser(userId,
    id)`; if undefined return null; else return
    `{ id, subject, body, recipientSetId: row.recipient_set_id }`. Export a
    `ResolvedInitialTemplate` type for the projection. This reuses the tested DAL
    for all owner-scoping — no new fetch-by-id path.

    Extend lib/compose/actions-core.test.ts: add `resolveInitialTemplateCore` to
    the dynamic import from ./actions-core, then add the tests in <behavior> using
    the existing seedSet/createTemplate/USER_A/USER_B harness.

    Wire the compose RSC (app/(app)/compose/page.tsx): add
    `searchParams: Promise<{ template?: string }>` to the page props, await it,
    and when a userId + template param are present call
    `resolveInitialTemplateCore(userId, template)` (import it from
    "@/lib/compose/actions-core"). Pass the result (or null) to `<ComposeEditor
    initialTemplate={...} />`. Silently ignore a null result (foreign/bogus id) —
    no redirect, no error.

    Make TemplateLibrary rows a link (components/templates/template-library.tsx):
    wrap the subject span in a `next/link` `<Link href={\`/compose?template=${template.id}\`}>`
    (keep the TemplateDelete affordance as the trailing control, OUTSIDE the link so
    its click never navigates). Keep all text escaped JSX (T-tpl-XSS); add a hover
    affordance class consistent with the existing list styling.

    Teach ComposeEditor (components/compose/compose-editor.tsx) to accept an
    optional `initialTemplate?: ResolvedInitialTemplate | null` prop and consume it
    via LAZY state initializers (no mount effect, no flash):
    - Compute `initialSet` = the set whose id === initialTemplate.recipientSetId if
      present in `sets`, else `sets[0]`.
    - `selectedId` initial = String(initialSet.id) (was always sets[0]).
    - `attachmentColumn` initial = initialSet.attachment_column (keep it in sync
      with the preselected set, not hard-coded to sets[0]).
    - form `defaultValues` subject/body = initialTemplate?.subject/body ?? "".
    - `savedTemplateId` initial = initialTemplate?.id ?? null (so the loaded
      template is immediately previewable/sendable AND — Task 2 — deletable).
    Do NOT introduce a parallel load path; this reuses the same savedTemplateId +
    field-fill contract loadTemplate() already establishes.
  </action>
  <verify>
    <automated>npm test 2>&1 | tail -5 && npx tsc --noEmit && npm run build 2>&1 | tail -5</automated>
  </verify>
  <done>resolveInitialTemplateCore tests pass (owned resolve, cross-tenant null, bad-id null, unscoped null); /lists/[id] template rows link to /compose?template=<id>; loading /compose?template=<owned-id> preselects the template's list and populates subject/body; a foreign/bogus id renders the normal editor; tsc + build clean.</done>
</task>

<task type="auto">
  <name>Task 2: In-compose loaded-template delete affordance</name>
  <files>components/compose/loaded-template-delete.tsx, components/compose/compose-editor.tsx</files>
  <action>
    Create components/compose/loaded-template-delete.tsx — a client AlertDialog
    affordance mirroring components/templates/template-delete.tsx VERBATIM in
    structure (deleting in-flight double-submit guard, e.preventDefault() on the
    action so an in_use result keeps the dialog open, inline destructive Alert for
    in_use, sonner toast). Props: `{ templateId: number; onCleared: () => void }`.
    Behavior:
    - Calls the existing `deleteTemplate(templateId)` action (import from
      "@/lib/compose/actions") — do NOT add a new action.
    - On { ok: true }: toast.success("Template deleted."), call onCleared(), close
      the dialog, and router.refresh() so the reuse picker drops the removed row.
    - On error.kind === "in_use": show the inline destructive Alert (reuse the
      existing friendly copy) AND render a secondary "Clear fields anyway" button
      inside the dialog that calls onCleared() + closes WITHOUT deleting — the
      escape hatch so the user can start from scratch even though the template is
      referenced by a campaign.
    - On any other error: toast.error("We couldn't delete this template. Try again.").
    Trigger is a labelled button (e.g. a small "Delete template" outline/ghost
    button) suited to the compose surface — not the icon-only list variant.

    Wire it into ComposeEditor (components/compose/compose-editor.tsx): render
    `<LoadedTemplateDelete>` only when `savedTemplateId !== null` (place it near the
    "Saved templates" picker block so the loaded-template controls sit together).
    Pass `templateId={savedTemplateId}` and an `onCleared` callback that:
      - form.setValue("subject", "", { shouldValidate: true, shouldDirty: true })
      - form.setValue("body", "", { shouldValidate: true, shouldDirty: true })
      - setSavedTemplateId(null)
      - setAutocomplete(null)
    so both a successful delete AND the in_use clear-fields path blank the editor and
    hide the affordance. router.refresh() (from the child) reconciles the server-fetched
    picker; the cleared client fields persist across that refresh.
  </action>
  <verify>
    <automated>npx tsc --noEmit && npm run build 2>&1 | tail -5</automated>
  </verify>
  <done>Delete affordance renders only when a template is loaded (savedTemplateId set); confirm deletes via deleteTemplate, clears subject/body, and hides the affordance; an in_use template shows the friendly Alert plus a working "Clear fields anyway" button that blanks the editor without deleting; tsc + build clean.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| client → compose RSC (?template= param) | untrusted template id in the URL query string |
| client → deleteTemplate action | untrusted template id proposed for deletion |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-tdl-IDOR-1 | Information Disclosure | resolveInitialTemplateCore (?template= deep link) | mitigate | Resolve strictly via userId-scoped getTemplateForUser; a foreign/bogus id → null → normal empty editor. Never fetch-by-id-alone. Covered by cross-tenant test. |
| T-tdl-IDOR-2 | Elevation of Privilege | deleteTemplate from compose | mitigate | Reuse the existing deleteTemplate action which re-derives userId via auth() and owner-scopes the delete + in_use guard; the client only proposes savedTemplateId. |
| T-tdl-XSS | Tampering | TemplateLibrary link + compose fields | mitigate | Subject renders as escaped JSX inside the Link; template subject/body load into controlled form inputs (no dangerouslySetInnerHTML). |
| T-tdl-VAL | Tampering | resolveInitialTemplateCore param | mitigate | Positive-int coercion before any DB touch; non-numeric/0/negative/absent → null. Covered by bad-id test. |
</threat_model>

<verification>
- `npm test` passes (new resolveInitialTemplateCore tests green; existing 380 stay green).
- `npx tsc --noEmit` clean.
- `npm run build` succeeds (all routes compile).
- Manual sanity (optional): open a template from /lists/[id] → /compose loads it; delete it from compose → fields clear.
</verification>

<success_criteria>
- A saved template on /lists/[id] is a one-click link to /compose?template=<id>.
- /compose resolves the id owner-scoped server-side and preselects the list + fills subject/body; a foreign/bogus id is silently ignored.
- A loaded template (deep link, reuse picker, or fresh save) shows a delete affordance.
- Delete removes the template, clears the editor, and toasts; in_use surfaces the friendly error and still offers clear-fields.
- No duplicated DAL/action/idiom — the deep-link resolver reuses getTemplateForUser and the delete reuses deleteTemplate.
</success_criteria>

<output>
Create `.planning/quick/260718-tdl-template-deep-link-and-compose-delete/260718-tdl-SUMMARY.md` when done
</output>
