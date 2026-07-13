---
phase: 04-editor-preview-template-save
reviewed: 2026-07-13T12:40:29Z
depth: standard
files_reviewed: 21
files_reviewed_list:
  - lib/core/merge.ts
  - lib/core/merge.test.ts
  - lib/core/index.ts
  - lib/csv/storage.ts
  - lib/csv/storage.test.ts
  - lib/csv/index.ts
  - lib/data/templates.ts
  - lib/data/templates.test.ts
  - lib/data/index.ts
  - lib/compose/schema.ts
  - lib/compose/schema.test.ts
  - lib/compose/actions.ts
  - lib/compose/actions-core.ts
  - lib/compose/actions-core.test.ts
  - lib/compose/index.ts
  - components/compose/compose-editor.tsx
  - components/compose/merge-field-menu.tsx
  - components/compose/preview-stepper.tsx
  - components/ui/textarea.tsx
  - components/ui/popover.tsx
  - app/(app)/compose/page.tsx
findings:
  critical: 0
  warning: 7
  info: 6
  total: 13
status: issues_found
---

# Phase 4: Code Review Report

**Reviewed:** 2026-07-13T12:40:29Z
**Depth:** standard
**Files Reviewed:** 21
**Status:** issues_found

## Summary

Reviewed the compose/preview/template-save slice: the pure merge engine, traversal-proof CSV storage, the templates DAL, the shared compose schema, the two server actions plus their testable core, and the client editor/stepper/menu components. The security architecture holds up under adversarial tracing: templates and recipient-set lookups are structurally userId-scoped (`and(eq(id), eq(userId))` with no fetch-by-id-alone path), both server actions re-derive `userId` from Clerk before delegating, `readUpload` prefix-checks resolved paths, merged preview output renders exclusively as escaped JSX text (no `dangerouslySetInnerHTML`, no HTML injection path for CSV cell values), and the RSC page never leaks `storage_path` to the client. The deliberate server/client authority split (server-authoritative `emailColumn`/`invalidEmailCount` vs client-reactive gap aggregates) and the deliberate deep imports of `@/lib/core/fill`/`merge` in client components were verified as documented and are not flagged.

No critical issues were found. Seven warnings were found: a spread-order flaw that undermines the documented server-injected-ownership guarantee in the templates DAL, two unhandled-rejection paths in the compose editor (one of which permanently disables the Save button), a broken retry path for a failed preview fetch, a false "all emails valid" success claim when no email column exists, server-internal error messages (including absolute filesystem paths) returned to the client, and an unintended template save triggered by Enter while the autocomplete popover is open with no matches.

## Narrative Findings (AI reviewer)

No structural pre-pass (`<structural_findings>`) was provided; all findings below are from direct review.

## Critical Issues

None found.

## Warnings

### WR-01: Spread order lets a runtime `userId` in `values` override server-injected ownership

**File:** `lib/data/templates.ts:40-45`
**Issue:** The header comment claims ownership "is injected by the server and can never be spoofed through the caller's values object" (T-4-TAMPER-OWNER). That guarantee does not hold at runtime. The insert spreads `values` **after** the server-injected `userId`:

```ts
.values({ userId, ...values })
```

`PersistableTemplate` is a `Pick<>` type, and TypeScript's excess-property check only applies to object literals — a widened object carrying a `userId` key is assignable via a variable, and at runtime the spread would silently overwrite the server's `userId` with the caller-supplied one. Today's only call path is safe by accident (zod's `composeFormSchema.safeParse` strips unknown keys), but the structural defense the module documents is inverted. The same inverted pattern exists in `lib/data/recipients.ts:48` (out of this phase's file list, but a verbatim sibling — fix both).
**Fix:**
```ts
.values({ ...values, userId })  // server value spread LAST — cannot be overridden
```

### WR-02: Preview fetch has no `.catch` — a rejected server action fails silently with an unhandled rejection

**File:** `components/compose/compose-editor.tsx:149-181`
**Issue:** `previewCampaign(fd).then(...).finally(...)` never attaches a rejection handler. Server actions reject on network failure / server crash (they only *resolve* to `{ ok: false }` for handled errors). On rejection: the `.finally` clears `previewLoading`, `report` stays `null`, `previewError` is never set — the stepper silently shows the idle "Choose a recipient list…" card with no indication anything failed, plus an unhandled promise rejection in the console.
**Fix:**
```ts
previewCampaign(fd)
  .then((res) => { /* existing handling */ })
  .catch(() => {
    if (ignore) return;
    setReport(null);
    setPreviewError({
      destructive: false,
      message: "We couldn't load a preview for that list. Try selecting it again.",
    });
  })
  .finally(() => { if (!ignore) setPreviewLoading(false); });
```

### WR-03: `onSave` lacks try/finally — a rejected `saveTemplate` permanently disables the Save button

**File:** `components/compose/compose-editor.tsx:259-267`
**Issue:** `setSaving(true)` is followed by `await saveTemplate(fd)` with no `try`/`finally`. If the action rejects (network failure), `setSaving(false)` on line 267 never runs: the button is stuck on "Saving…" (disabled) until a full page reload, and the rejection propagates unhandled through react-hook-form's `handleSubmit`. The user also gets no error message.
**Fix:**
```ts
setSaving(true);
let res: SaveResult;
try {
  res = await saveTemplate(fd);
} catch {
  setSaveError("We couldn't save your template. Check your connection and try again.");
  return;
} finally {
  setSaving(false);
}
```

### WR-04: Preview error copy says "Try selecting it again" but re-selecting the same list can never retry

**File:** `components/compose/compose-editor.tsx:171-177, 311-316`
**Issue:** The preview fetch effect is keyed solely on `[selectedId]`. After a transient failure, the suggested recovery ("Try selecting it again") is impossible: picking the same item leaves `selectedId` unchanged (and `setSelectedId(sameValue)` is a same-value state set even if Radix fires `onValueChange`), so the effect never re-runs. The user must switch to a *different* list and back — or reload — to retry.
**Fix:** Add a retry nonce to the effect deps and bump it from an explicit "Try again" affordance (or from `onValueChange` unconditionally):
```ts
const [previewAttempt, setPreviewAttempt] = useState(0);
useEffect(() => { ... }, [selectedId, previewAttempt]);
// in the non-destructive error UI:
<Button variant="link" onClick={() => setPreviewAttempt((n) => n + 1)}>Try again</Button>
```

### WR-05: Green "All N rows have a valid email address" is asserted when no email column exists at all

**File:** `components/compose/preview-stepper.tsx:224-236` (root: `lib/compose/actions-core.ts:130-133`)
**Issue:** When the server can neither read a persisted `email_column` nor detect one, it returns `emailColumn: null` and `invalidEmailCount: 0`. The stepper's validation report branches only on `invalidEmailCount > 0`, so the null-column case renders the success state — "All N rows have a valid email address" with a check icon — when in fact **zero** addresses were validated and a send would have no To: column. The To: line is correctly suppressed, but the report actively asserts a falsehood.
**Fix:** Branch on `emailColumn` first:
```tsx
{emailColumn === null ? (
  <div className="flex items-center gap-2 text-sm text-muted-foreground">
    <AlertTriangle className="size-4 shrink-0" />
    <span>We couldn&apos;t find an email column in this list. Confirm one on the recipients page.</span>
  </div>
) : invalidEmailCount > 0 ? ( /* existing warn */ ) : ( /* existing success */ )}
```

### WR-06: Server-internal error messages (including absolute filesystem paths) are returned to the client in `raw`

**File:** `lib/compose/actions-core.ts:141, 167`
**Issue:** Both catch blocks do `raw: String((e as Error)?.message ?? e)` and ship that string over the wire in the action result. Node `fs` errors embed absolute paths — e.g. a missing upload yields `ENOENT: no such file or directory, open '/data/uploads/<uuid>.csv'` — and SQLite errors embed table/constraint names. The module header claims T-4-LOG safety because `raw` "is always a string," but a string can still leak server filesystem layout and schema internals to any authenticated client. The UI never displays `raw`, so nothing is lost by sanitizing it.
**Fix:** Return a static or allowlisted message; keep details server-side only:
```ts
} catch {
  return { ok: false, error: { kind: "unknown", raw: "preview failed" } };
}
```
(If diagnostics are needed, map the deleted-file case explicitly to `not_found` before the generic catch: check `(e as NodeJS.ErrnoException).code === "ENOENT"`.)

### WR-07: Enter with the autocomplete popover open but zero matches submits the form and persists a template

**File:** `components/compose/compose-editor.tsx:248-257`
**Issue:** `handleKeyDown` only calls `e.preventDefault()` on Enter when `matches.length > 0`. When the popover is visibly open showing "No matching fields." and the user presses Enter in the **subject** input (e.g. expecting to dismiss it), the keydown falls through to the form's default submit — silently persisting a template with the dangling `{{partial` still in the text. Behavior diverges based on invisible state: matches > 0 → insert token; matches == 0 → unintended database write.
**Fix:** Swallow Enter whenever the autocomplete is active for this field:
```ts
} else if (e.key === "Enter") {
  e.preventDefault();
  if (matches.length > 0) selectSuggestion(matches[0]);
  else setAutocomplete(null);
}
```

## Info

### IN-01: `readUpload` guard permits the empty/`.` storage path resolving to UPLOADS_DIR itself

**File:** `lib/csv/storage.ts:52`
**Issue:** The traversal check throws only when `full !== UPLOADS_DIR && !full.startsWith(UPLOADS_DIR + sep)` — so `storagePath` of `""` or `"."` (resolving exactly to the uploads dir) passes the guard and reaches `readFileSync`, which fails with EISDIR whose message (containing the uploads dir absolute path) currently flows to the client via WR-06. No data is exposed, but the dir itself is not a valid read target and should be rejected by the boundary check.
**Fix:** `if (!full.startsWith(UPLOADS_DIR + sep)) throw new Error(...)` — drop the equality escape hatch.

### IN-02: Server-returned `PreviewReport.columns` is never consumed; stepper aggregates use upload-time `columns_json` against fresh-parse rows

**File:** `components/compose/compose-editor.tsx:463-472`, `lib/compose/actions-core.ts:137`
**Issue:** The server report carries `columns` from the fresh parse, but `ComposeEditor` passes the client-side `parseColumns(activeSet.columns_json)` (persisted at upload time) to `PreviewStepper`, whose `analyzeMerge` classifies unknown tokens against those columns while `rows` come from the server's re-parse. Both derive from the same `parseCsv` today so they match, but any future parse-config drift makes the unknown-token report wrong against the actual rows. The chips legitimately need `columns_json` (available before the fetch), but the stepper should prefer the report.
**Fix:** `columns={report?.columns ?? columns}` on the `PreviewStepper` prop.

### IN-03: Unstable `[]` fallback for `rows` re-fires the step-reset effect every render; brief stale-rows frame on list switch

**File:** `components/compose/preview-stepper.tsx:84-86`, `components/compose/compose-editor.tsx:467`
**Issue:** `rows={report?.rows ?? []}` constructs a fresh array each render while `report` is null, so `useEffect(() => setStep(0), [rows])` fires every render (harmless only because same-value `setStep` bails). Separately, on list switch there is one painted frame where the new list's `columns` render against the old list's `rows` (`previewLoading` flips true only after the effect runs post-paint), momentarily flashing wrong gap warnings.
**Fix:** Hoist a module-level `const NO_ROWS: Row[] = []` as the fallback; optionally clear `report` synchronously in the Select's `onValueChange`.

### IN-04: Traversal test is vacuous — `evil` is never fed into the code under test

**File:** `lib/csv/storage.test.ts:44-52`
**Issue:** The test "the user filename never appears in the returned path (V12 / T-3-TRAV)" declares `const evil = "../../etc/passwd"` but never passes it anywhere — `writeUpload` takes no filename parameter at all. The assertions only re-verify the UUID regex on an unrelated write, so the test proves nothing beyond the earlier format test and gives false confidence that a hostile-filename scenario is exercised. (The invariant is real — it holds by construction — but the test's framing overstates what it checks.)
**Fix:** Delete the unused `evil` binding and rename the test to state the structural claim (e.g., "storagePath is a bare UUID with no separators"), or move the hostile-filename assertion to the layer that actually receives a user filename.

### IN-05: `hasStructuralParseError` duplicated verbatim across two actions-core modules

**File:** `lib/compose/actions-core.ts:91-95` (duplicate of `lib/csv/actions-core.ts`)
**Issue:** The `UndetectableDelimiter` filter is security/correctness-relevant gate logic duplicated in two modules (the comment acknowledges the mirror). If the accepted-error list ever changes in one place, preview and upload will disagree on what counts as a misparse.
**Fix:** Export it once from `lib/core/csv.ts` (it depends only on papaparse types already exported there) and import in both.

### IN-06: `PopoverTitle` typed as `h2` but renders a `div`

**File:** `components/ui/popover.tsx:58-66`
**Issue:** `PopoverTitle` accepts `React.ComponentProps<"h2">` but renders a `<div>` — the type advertises heading semantics the DOM never gets. Unused in this phase, but the mismatch will surprise the first consumer expecting a heading for accessibility.
**Fix:** Render an `<h2>` (or retype as `ComponentProps<"div">`) so type and element agree.

---

_Reviewed: 2026-07-13T12:40:29Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
