---
phase: quick-260718-tdl
plan: 01
subsystem: ui
tags: [templates, compose, deep-link, next-link, alert-dialog, idor, react-hook-form]

requires:
  - phase: 260717-tpl
    provides: list-scoped template library (getTemplateForUser DAL, deleteTemplate action, TemplateLibrary + TemplateDelete idiom, savedTemplateId + loadTemplate contract)
provides:
  - resolveInitialTemplateCore owner-scoped deep-link resolver seam (userId-scoped via getTemplateForUser)
  - /compose?template=<id> one-click open from the list template library
  - ComposeEditor initialTemplate prop (lazy state initializers preselect list + fill subject/body)
  - LoadedTemplateDelete in-compose delete affordance with in_use clear-fields escape hatch
affects: [compose, templates]

tech-stack:
  added: []
  patterns:
    - "Deep-link resolver seam: raw query param → positive-int guard → tested userId-scoped DAL → editor projection or null (no fetch-by-id-alone path)"
    - "Lazy state initializers to consume a server-resolved initialTemplate with no mount effect / no flash"

key-files:
  created:
    - components/compose/loaded-template-delete.tsx
  modified:
    - lib/compose/actions-core.ts
    - lib/compose/actions-core.test.ts
    - lib/compose/actions.ts
    - app/(app)/compose/page.tsx
    - components/templates/template-library.tsx
    - components/compose/compose-editor.tsx

key-decisions:
  - "Reuse getTemplateForUser for all deep-link owner-scoping — no new fetch-by-id path (T-tdl-IDOR-1)"
  - "Consume initialTemplate via lazy useState initializers + form defaultValues, reusing the existing savedTemplateId + field-fill contract rather than a parallel load path"
  - "in_use delete surfaces the friendly Alert AND a 'Clear fields anyway' escape hatch that blanks the editor without deleting"

patterns-established:
  - "Query-param deep-link → server RSC resolve → editor prop, with a foreign/bogus id silently falling back to the normal empty editor"

requirements-completed: [TDL-01, TDL-02]

duration: 18min
completed: 2026-07-18
---

# Quick Task 260718-tdl: Template Deep-Link + In-Compose Delete Summary

**A saved template on /lists/[id] is now a one-click deep link that opens /compose with that template's list preselected and subject/body populated (owner-scoped server-side), and a template loaded in /compose gains a delete affordance that clears the editor on success and offers a clear-fields escape hatch when the template is in use.**

## Performance

- **Duration:** ~18 min
- **Tasks:** 2 completed
- **Files modified:** 6 (1 created, 5 modified)

## Accomplishments
- Added `resolveInitialTemplateCore` — a userId-scoped deep-link resolver seam that reuses the tested `getTemplateForUser` DAL; a cross-tenant or bogus `?template=` id resolves to null with no data leak (T-tdl-IDOR-1).
- Wired one-click open end-to-end: TemplateLibrary rows link to `/compose?template=<id>`, the compose RSC resolves it server-side, and ComposeEditor preselects the template's list and fills subject/body via lazy state initializers (no flash, no parallel load path).
- Added the in-compose `LoadedTemplateDelete` affordance (shown only when a template is loaded) that reuses the existing `deleteTemplate` action, clears the editor + hides itself on success, and on `in_use` shows the friendly Alert plus a "Clear fields anyway" escape hatch.

## Task Commits

Each task was committed atomically:

1. **Task 1: Owner-scoped deep-link resolver seam + one-click open wiring (TDD)** - `ee0b964` (feat) — RED (5 failing seam tests) → GREEN implemented in the same commit set
2. **Task 2: In-compose loaded-template delete affordance** - `e11c7e3` (feat)

_Task 1 followed the TDD flow: the 5 `resolveInitialTemplateCore` tests were written and confirmed RED (`resolveInitialTemplateCore is not a function`) before the seam was implemented to turn them GREEN._

## Files Created/Modified
- `lib/compose/actions-core.ts` - Added `resolveInitialTemplateCore(userId, rawParam)` + `ResolvedInitialTemplate` type; positive-int guard before any DB touch, then userId-scoped `getTemplateForUser`.
- `lib/compose/actions-core.test.ts` - Added 5 seam tests: owned resolve, cross-tenant null (IDOR), non-numeric/0/negative/absent null, valid-but-nonexistent null, unscoped null recipientSetId.
- `lib/compose/actions.ts` - Re-exported the `ResolvedInitialTemplate` type for client type-only import.
- `app/(app)/compose/page.tsx` - Added `searchParams.template`, awaited it, resolved owner-scoped, and passed `initialTemplate` to ComposeEditor.
- `components/templates/template-library.tsx` - Wrapped the subject in a `next/link` to `/compose?template=<id>`; TemplateDelete kept outside the link so a delete click never navigates. Subject stays escaped JSX (T-tdl-XSS).
- `components/compose/compose-editor.tsx` - Added the `initialTemplate` prop; lazy initializers for `selectedId`, `attachmentColumn`, `savedTemplateId`, and form `defaultValues`; rendered `LoadedTemplateDelete` when `savedTemplateId !== null` with an `onCleared` callback that blanks subject/body and hides the affordance.
- `components/compose/loaded-template-delete.tsx` - New client AlertDialog island mirroring template-delete.tsx: double-submit guard, `e.preventDefault()` keeps an in_use dialog open, sonner toasts, `router.refresh()`, and the in_use clear-fields escape hatch.

## Deviations from Plan

None - plan executed exactly as written.

## Threat Model Coverage
- **T-tdl-IDOR-1** (deep-link info disclosure): mitigated — resolver goes strictly through userId-scoped `getTemplateForUser`; cross-tenant test asserts null (no subject/body leak).
- **T-tdl-IDOR-2** (delete elevation): mitigated — reuses `deleteTemplate`, which re-derives userId via `auth()` and owner-scopes; the client only proposes `savedTemplateId`.
- **T-tdl-XSS**: mitigated — subject renders as escaped JSX inside the Link; template subject/body load into controlled form inputs (no dangerouslySetInnerHTML).
- **T-tdl-VAL**: mitigated — positive-int coercion before any DB touch; non-numeric/0/negative/absent → null (covered by the bad-id test).

## Verification
- `npm test` — 385 pass / 0 fail (was 380; +5 new resolveInitialTemplateCore tests).
- `npx tsc --noEmit` — clean.
- `npm run build` — Compiled successfully; all routes compile.

## Self-Check: PASSED
