---
phase: 03-csv-upload-parsing-recipient-mapping
reviewed: 2026-07-13T00:00:00Z
depth: standard
files_reviewed: 21
files_reviewed_list:
  - lib/core/csv.ts
  - lib/core/csv.test.ts
  - lib/core/index.ts
  - lib/csv/schema.ts
  - lib/csv/schema.test.ts
  - lib/csv/storage.ts
  - lib/csv/storage.test.ts
  - lib/csv/actions.ts
  - lib/csv/actions-core.ts
  - lib/csv/actions-core.test.ts
  - lib/csv/index.ts
  - lib/data/recipients.ts
  - lib/data/recipients.test.ts
  - lib/data/index.ts
  - components/recipients/csv-uploader.tsx
  - components/ui/select.tsx
  - components/ui/table.tsx
  - app/(app)/recipients/page.tsx
  - components/app-sidebar.tsx
  - next.config.ts
  - docker-compose.yml
findings:
  critical: 1
  warning: 10
  info: 4
  total: 15
status: issues_found
---

# Phase 3: Code Review Report

**Reviewed:** 2026-07-13T00:00:00Z
**Depth:** standard
**Files Reviewed:** 21
**Status:** issues_found

## Summary

Reviewed the CSV upload → parse → confirm → persist slice: the pure parser
(`lib/core/csv.ts`), shared zod guards, traversal-proof storage writer, the
Server Action pair and its testable core, the userId-scoped DAL, the uploader
client component, the recipients RSC page, the hand-authored shadcn scaffolds,
and the config/compose files.

The stated security focus areas hold up well: storage paths are server-generated
UUIDs (no user string ever becomes a path component), every DAL function is
userId-first with an `and(id, userId)` read path, the actions module exports
only `auth()`-gated wrappers while the userId-accepting seams live in a
non-action module, and the 4 MB / 5,000-row caps are enforced at both parse and
save. Tests structurally prove the IDOR and traversal invariants.

However, the phase's core deliverable has a hole: **the user-confirmed email
column is validated, counted — and then thrown away.** `recipient_sets` has no
`email_column` field and nothing persists the confirmation, so the CSV-03/05
outcome ("recipient set with a confirmed email column", ROADMAP line 109) is
not actually saved. Beyond that, the error-handling story around the actions
contradicts its own "never rejects" contract, the exact-4MB boundary between
the zod guard and the platform body limit fails ungracefully, and a
trailing-comma header (an extremely common Excel/Sheets export shape) leaks an
empty-named column into the UI and into the persisted `columns_json`.

## Critical Issues

### CR-01: Confirmed email column is never persisted — the confirm/override step's output is discarded

**File:** `lib/csv/actions-core.ts:217-226`, `lib/data/recipients.ts:32-35`, `lib/db/schema.ts:71-80`
**Issue:** `saveRecipientSetCore` validates the confirmed `emailColumn` against the header set, counts invalid rows on it, and inserts the recipient set — but neither the confirmed column name nor the invalid count is written anywhere. `recipient_sets` (schema.ts:71-80) has columns `filename / columns_json / row_count / storage_path` only; `PersistableRecipientSet` matches. The confirmed column exists solely in the `SaveResult` return, which the client uses for a toast and discards. The Phase 3 goal (ROADMAP: "a correctly parsed, validated recipient set with a confirmed email column") and CSV-05 ("Parsed recipients and detected columns are saved as a recipient set for the campaign") are therefore not met: when Phase 5/6 sends against this set, there is no record of which column holds the recipient address. Re-running `detectEmailColumn` at send time would silently ignore the user's override (the exact case CSV-03's confirm step exists to handle — e.g. the test at `actions-core.test.ts:183` where the user confirms `Contact` over the detected `Email`).
**Fix:**
```ts
// lib/db/schema.ts — add to recipient_sets (+ generate a migration):
email_column: text("email_column").notNull(),
// optionally also: invalid_count: integer("invalid_count").notNull().default(0),

// lib/data/recipients.ts:
export type PersistableRecipientSet = Pick<
  NewRecipientSet,
  "filename" | "columns_json" | "row_count" | "storage_path" | "email_column"
>;

// lib/csv/actions-core.ts (saveRecipientSetCore):
await createRecipientSet(userId, {
  filename: guard.file.name,
  columns_json: JSON.stringify(columns),
  row_count: rows.length,
  storage_path: storagePath,
  email_column: emailColumn,
});
```

## Warnings

### WR-01: Save/parse seams document "never rejects" but throw on I/O and DB failure; the `unknown` error variant is dead code

**File:** `lib/csv/actions-core.ts:64-75, 121-161, 169-232`
**Issue:** Both result-type docstrings say the seams "never reject", and the `ActionError` union carries `{ kind: "unknown"; raw: string }` for exactly this purpose — but no code path ever constructs it, and several awaited calls can throw: `guard.file.arrayBuffer()` (lines 130/187), `writeUpload` (line 220 — `mkdirSync`/`writeFileSync` throw on permission/disk-full), and `createRecipientSet` (line 221 — any SQLite error). Any of these rejects the Server Action promise, breaking the typed contract the UI pattern-matches over and (per T-3-CRED / D-06 intent) letting Next surface a raw server error instead of the sanitized `raw` string the design promises.
**Fix:** Wrap the body of each seam (after the pure guards) in try/catch and return the dead variant:
```ts
try {
  // ... arrayBuffer / parse / write / insert
} catch (e) {
  return { ok: false, error: { kind: "unknown", raw: (e as Error).message } };
}
```

### WR-02: Client action calls have no try/catch — a rejected action leaves the spinner stuck and the form disabled forever

**File:** `components/recipients/csv-uploader.tsx:225, 269`
**Issue:** `await parseUploadedCsv(fd)` and `await saveRecipientSet(fd)` are not wrapped in try/catch. Server Actions reject on network failure, on any server-side throw (see WR-01), and on the platform 413 body-limit rejection (see WR-03). When that happens, `setParsing(false)` / `setSaving(false)` never run: the button stays disabled showing "Reading your file…" / "Saving…" until a full page reload, with no error surfaced to the user.
**Fix:**
```ts
setParsing(true);
let res: ParseResult;
try {
  res = await parseUploadedCsv(fd);
} catch {
  setParsing(false);
  setUploadError("Something went wrong uploading the file. Check your connection and try again.");
  return;
}
```
Apply the same pattern in `onSave` (or use `finally` to clear the pending flags).

### WR-03: bodySizeLimit equals MAX_UPLOAD_BYTES with zero multipart headroom — files near exactly 4 MB fail with an opaque platform error

**File:** `next.config.ts:13`, `lib/csv/schema.ts:21,44-49`
**Issue:** `bodySizeLimit: "4mb"` parses to 4,194,304 bytes — the exact value of `MAX_UPLOAD_BYTES`, and zod's `.max()` is inclusive. A file of, say, 4,194,000 bytes passes the client zod pre-check (so it IS sent), but the multipart envelope (boundary lines, content-disposition headers, the `emailColumn` field on save) pushes the request body over the platform limit. Next rejects with a 413 before the action runs, so the user never sees the friendly "larger than 4 MB" message — the config comment's claim that the zod guard rejects "BEFORE the platform body limit bites" is false in this boundary band. Combined with WR-02 this currently presents as a permanently stuck spinner.
**Fix:** Give the platform limit headroom over the semantic limit:
```ts
experimental: { serverActions: { bodySizeLimit: "5mb" } }, // zod's 4 MB stays the real gate
```

### WR-04: MIME allow-list rejects legitimate CSVs whose browser/OS reports a different or empty content type

**File:** `lib/csv/schema.ts:27, 41-43`
**Issue:** `type` must be exactly `text/csv` or `application/vnd.ms-excel`. In practice the `File.type` for a `.csv` is whatever the client OS mime registry says: Windows machines without a CSV association report `""`, Linux browsers commonly report `text/plain` or `application/csv`. Those users get "That file isn't a CSV" for a perfectly valid file. The mime string is client-supplied and spoofable anyway, so it adds no security over the extension check plus the server-side parse (the real gates) — it only adds false rejections.
**Fix:** Loosen the type check to advisory:
```ts
const CSV_MIME_TYPES = ["text/csv", "application/vnd.ms-excel", "application/csv", "text/plain", "application/octet-stream", ""];
```
or drop the `type` refinement entirely and rely on extension + structural parse.

### WR-05: Trailing comma in the header row produces an empty-named column that reaches the Select and is persisted into columns_json

**File:** `lib/csv/actions-core.ts:136,144-146,223`, `components/recipients/csv-uploader.tsx:310-315`
**Issue:** Verified against the installed papaparse 5.5.4: `"email,name,\n..."` parses with zero errors and `meta.fields = ["email","name",""]`. This is the standard Excel/Sheets trailing-comma export shape, so it will happen in the field. Consequences: (a) the review Select renders a blank `<SelectItem value="">`; under the installed radix react-select 2.3.1 an empty-string value means "clear selection / show placeholder", so clicking the blank item silently deselects and disables Save — it also collides with the component's own use of `""` as the "nothing chosen" sentinel (`csv-uploader.tsx:197,289`); (b) `columns_json` persists `["email","name",""]`, which the schema doc says "drives editor autocomplete" — a blank `{{}}` merge field will surface in Phase 4; (c) `invalidCounts` carries a meaningless `""` key.
**Fix:** Drop empty-named headers from the summary and the persisted column list in both seams:
```ts
const { columns: rawColumns, rows, parseErrors } = parseCsv(bytes);
const columns = rawColumns.filter((c) => c !== "");
```
(Note: the cosmetic sample table indexes rows positionally by `data.columns` order — after filtering, either map sample cells by header name or filter the same indices client-side so the preview stays aligned.)

### WR-06: DB insert failure after writeUpload leaves an orphan file on disk, contradicting the stated orphan-avoidance invariant

**File:** `lib/csv/actions-core.ts:219-226`, `lib/csv/storage.ts:31-36`
**Issue:** The module doc and inline comments repeatedly promise "a rejected upload never leaves an orphan file on disk (Pitfall 5)" — but that only covers guard failures. If `createRecipientSet` throws (constraint violation, locked DB, disk-full on the shared volume), the bytes written by `writeUpload` one line earlier are stranded: no `recipient_sets` row references `storagePath`, and nothing ever cleans it up. Over time failed saves accumulate unreferenced 4 MB files on the same volume as the SQLite DB.
**Fix:** Unlink on insert failure (dovetails with the WR-01 try/catch):
```ts
const { storagePath } = writeUpload(bytes);
try {
  await createRecipientSet(userId, { ... });
} catch (e) {
  rmSync(resolveUpload(storagePath), { force: true }); // expose a delete helper from storage.ts
  return { ok: false, error: { kind: "unknown", raw: (e as Error).message } };
}
```

### WR-07: onSave discards the typed error kind — an expired session shows a misleading "Try again" message that can never succeed

**File:** `components/recipients/csv-uploader.tsx:281-284`
**Issue:** The save path collapses every `res.error` into one generic string: "We couldn't save that recipient list. Try again…". For `kind: "unauthenticated"` (the most likely save-time failure, since the same file just parsed successfully) retrying is guaranteed to fail — the user needs to sign in again, and `parseFailureFor` (line 77) already has the correct copy for it, but is only wired to the upload step. `too_many_rows` / `wrong_type` / `validation` save failures get equally wrong advice.
**Fix:**
```ts
if (!res.ok) {
  setSaveError(
    res.error.kind === "unauthenticated"
      ? parseFailureFor(res.error).message
      : "We couldn't save that recipient list. Try again, and if it keeps failing, re-upload the file.",
  );
}
```
(or route all kinds through `parseFailureFor` with a save-flavored fallback).

### WR-08: worker service in docker-compose lacks UPLOADS_PATH — the Phase-6 worker will resolve the wrong uploads directory

**File:** `docker-compose.yml:59-74`, `lib/csv/storage.ts:25`
**Issue:** The `web` service sets `UPLOADS_PATH: /data/uploads` with a comment explicitly promising the CSVs are "reachable by the Phase-6 worker" — but the `worker` service's environment block only sets `DATABASE_PATH` and `CREDENTIAL_ENC_KEY`. `lib/csv/storage.ts` resolves `UPLOADS_PATH ?? "./data/uploads"` at module load, so when the worker starts reading `storage_path` values it will resolve them against `<container-cwd>/data/uploads` on the ephemeral container FS instead of the shared volume, and every read will ENOENT. This file declares the topology now; the omission is a latent misconfiguration that will surface as a confusing Phase-6 failure.
**Fix:** Add to the worker service environment:
```yaml
      UPLOADS_PATH: /data/uploads
```

### WR-09: lib/csv barrel runtime-exports writeUpload (node:fs) while positioning itself as the client-resolver import surface

**File:** `lib/csv/index.ts:24`
**Issue:** The barrel's doc says it exposes "only the pure helpers and the (erased) types" so consumers (including the client resolver path for the schemas) import from `@/lib/csv` — but `writeUpload` is a runtime re-export of a module that imports `node:fs`. Any client component that imports a *runtime* value from this barrel (e.g. `uploadFileSchema`, exactly what the doc invites) drags `node:fs` into the client graph and breaks the build. The uploader visibly dodged this trap already: it imports the schema from `@/lib/csv/schema` directly (csv-uploader.tsx:11) and only `import type` from the barrel. Meanwhile nothing imports `writeUpload` through the barrel (actions-core imports `./storage` directly), so the export is both unused and hazardous.
**Fix:** Remove `export { writeUpload } from "./storage";` from the barrel; server code keeps importing it from `@/lib/csv/storage`.

### WR-10: No per-user storage quota — an authenticated user can fill the shared /data volume (which also hosts the SQLite DB)

**File:** `lib/csv/actions-core.ts:220`, `lib/csv/storage.ts:31-36`
**Issue:** T-3-DOS is addressed per-request (4 MB / 5,000 rows) but not per-tenant: `saveRecipientSet` can be called in a loop, writing an unbounded number of 4 MB files with no cap on recipient sets per user and no cleanup path. The uploads live on the same volume as `app.db` (docker-compose.yml:42-47), so disk exhaustion by one authenticated user takes down writes for every tenant — availability plus potential data-loss blast radius (SQLite WAL on a full disk).
**Fix:** Enforce a per-user cap in `saveRecipientSetCore` before writing (e.g. reject or delete-oldest when `listRecipientSetsForUser(userId).length >= N`), and add a matching `too_many_sets`-style `ActionError` kind.

## Info

### IN-01: Unreachable trailing return in formatRelativeDate

**File:** `app/(app)/recipients/page.tsx:36`
**Issue:** The loop's `unit === "second"` arm guarantees a return on the last iteration, so `return "just now";` is dead code.
**Fix:** Delete the trailing return, or drop the `|| unit === "second"` special case and keep the fallback — one of the two.

### IN-02: Cosmetic sample reader disagrees with the server parser on blank lines

**File:** `components/recipients/csv-uploader.tsx:133-174`
**Issue:** `readSampleRecords` emits a `[""]` record for every blank line (including a trailing newline handled mid-file), while the server parses with `skipEmptyLines: true`. A file with blank separator lines shows empty rows in the preview that don't exist in the server's `rowCount`. Cosmetic only (the doc says so), but easy to align.
**Fix:** Skip records that are a single empty field: `if (record.length === 1 && record[0] === "") { field = ""; record = []; continue-equivalent; }` before pushing.

### IN-03: `Row = Record<string, string>` overstates what papaparse returns

**File:** `lib/core/csv.ts:17,44-68`
**Issue:** In header mode papaparse yields `undefined` for missing trailing fields (TooFewFields rows) and attaches `__parsed_extra: string[]` for TooManyFields rows — both violate the declared `Record<string, string>`. The action layer's structural-error gate rejects such files today, but `parseCsv` is exported from `@/lib/core` for the Phase-6 worker, which may consume rows without that gate; the `?? ""` guards inside this module show the type is already known to be loose.
**Fix:** Type honestly — `export type Row = Record<string, string | undefined>` (the existing `?? ""` call sites already handle it), or document the invariant that callers must reject files with `parseErrors` first.

### IN-04: User-supplied filename persisted and rendered without a length cap

**File:** `lib/csv/schema.ts:36-40`, `lib/csv/actions-core.ts:223`, `app/(app)/recipients/page.tsx:70`
**Issue:** `uploadFileSchema.name` only checks the `.csv` suffix; a multi-kilobyte or control-character-laden filename is stored verbatim in `recipient_sets.filename` and echoed into the list UI and toast. React escaping prevents XSS, but the layout and DB hygiene suffer.
**Fix:** Add `.max(255)` (and optionally a control-character strip) to the `name` field.

---

_Reviewed: 2026-07-13T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
