---
phase: 07-per-row-attachments
reviewed: 2026-07-16T00:00:00Z
depth: standard
files_reviewed: 26
files_reviewed_list:
  - app/(app)/campaigns/[id]/export/route.ts
  - app/(app)/campaigns/[id]/page.tsx
  - app/(app)/compose/page.tsx
  - components/campaign/confirm-send-dialog.tsx
  - components/campaign/recipient-results-table.tsx
  - components/compose/attachments-card.tsx
  - components/compose/compose-editor.tsx
  - drizzle/0006_attachments_per_row.sql
  - lib/attachments/actions-core.test.ts
  - lib/attachments/actions-core.ts
  - lib/attachments/actions.ts
  - lib/attachments/index.ts
  - lib/attachments/match.test.ts
  - lib/attachments/match.ts
  - lib/attachments/schema.ts
  - lib/attachments/storage.test.ts
  - lib/attachments/storage.ts
  - lib/campaign/actions-core.ts
  - lib/campaign/results-csv.ts
  - lib/core/attachment-column.ts
  - lib/core/send.ts
  - lib/data/attachments.ts
  - lib/db/schema.ts
  - lib/worker/materialize.ts
  - lib/worker/process.ts
  - next.config.ts
findings:
  critical: 1
  warning: 7
  info: 5
  total: 13
status: issues_found
---

# Phase 07: Code Review Report

**Reviewed:** 2026-07-16
**Depth:** standard
**Files Reviewed:** 26
**Status:** issues_found

## Summary

The core security posture of this phase is solid: attachment bytes are stored under opaque `randomUUID().bin` names with a prefix-checked traversal guard shared by resolver and existence check (verified by tests); every pre-campaign DAL path is `AND(id, userId)`-scoped; the stamp predicate cannot cross tenants or claim queued/running campaigns' rows; the worker resolves attachments strictly via `send_records.attachment_id` → DB `storage_path`, never a CSV-provided path; the export route and campaign page resolve filenames owner-scoped and run them through the formula-injection-safe CSV serializer. Per-file size is validated server-side before the duplicate check and before any disk write, and FKs are ON in the shared connection (`lib/db/client.ts:45`), so a dangling `send_records.attachment_id` cannot be created by a post-materialize delete.

However, the phase's central guarantee — "an enqueue-gated campaign either attaches the promised file or fails that row visibly" — has a hole. The gate is enforced only at enqueue time, while the row↔attachment link is created later at materialize, and `materializeSendRecords` **silently un-links** any non-empty attachment cell that no longer matches. Two client-invocable actions (`deleteAttachment`, `confirmAttachmentColumn`) have no in-flight-campaign guard, so a user can mutate the inputs in the queued→materialize window and cause real emails to be delivered **without** their promised attachment, recorded as `sent`. That is the one BLOCKER. Beyond it: the prepare-time stamp makes pending uploads vanish from /compose after a cancelled review, there is no upload quota or orphan cleanup, and the compose-card matcher diverges from the confirm gate's auto-detect (despite three comments claiming "zero divergence").

## Critical Issues

### CR-01: Silent no-attachment send — materialize un-links unmatched rows instead of failing them, and the queued→materialize window is mutable

**Fixed:** 8f68823

**File:** `lib/worker/materialize.ts:148` (root), `lib/data/attachments.ts:80-86` (`deleteAttachmentForUser`), `lib/attachments/actions-core.ts:208-222` (`confirmAttachmentColumnCore`), `lib/worker/process.ts:196-205` (contributing)

**Issue:** `enqueueCampaignCore` blocks enqueue when any referenced file is missing (`lib/campaign/actions-core.ts:577-583`) — that is the promise shown to the user ("Nothing was sent" / "Every attachment matched"). But the actual row↔attachment link is stamped later, when the worker claims the campaign and runs `materializeSendRecords`. In that linking loop, a non-empty attachment cell with no matching upload is simply skipped:

```ts
const matchedId = byName.get(cell.toLowerCase());
if (matchedId === undefined) continue; // no matching upload → row un-linked
```

An un-linked row has `attachment_id = null`, which the send loop treats as a legitimate "send without attachment" — the email is delivered to a real recipient **missing the file the gate verified**, and the record says `sent` with no error. Concrete, user-reachable paths into this state between enqueue and materialize (seconds to minutes, longer if the worker is down):

1. **`deleteAttachment(id)`** is a wire-callable action with no campaign-status guard — the DAL filters only `AND(id, userId)`. Before materialize no `send_records.attachment_id` exists yet, so the FK does not protect the row: the delete succeeds, unlinks the bytes, and materialize silently un-links every row that referenced that filename. (After materialize the FK throws and the delete maps to `unknown` — inconsistent but safe.)
2. **`confirmAttachmentColumn(setId, column)`** has no guard either — changing the set's attachment column (or setting it to a column full of unmatched values) after enqueue makes materialize link against a column the gate never validated.

Additionally, in `lib/worker/process.ts:196-199`, an undefined result from `getAttachmentByIdForCampaign` (dangling FK — reachable in any deployment where `foreign_keys` isn't enforced, e.g. a manually-opened DB) falls through to a **silent attachment-less send** rather than failing the row like the missing-on-disk branch does.

**Fix:** Close the guarantee at the point the link is created — in `materializeSendRecords`, treat a non-empty cell with no match as a terminal failure, mirroring the invalid-address idiom:

```ts
if (matchedId === undefined) {
  await db.update(send_records)
    .set({ status: "failed", error: "rejected: attachment missing",
           attempts: sql`${send_records.attempts} + 1` })
    .where(and(eq(send_records.campaign_id, campaign.id),
               eq(send_records.to_addr, addr),
               eq(send_records.status, "pending")));
  continue; // and bump failed_count in the reconcile step, as for invalid addresses
}
```

And in `process.ts`, fail the row when `rec.attachment_id != null` but the DB row is gone:

```ts
if (rec.attachment_id != null && !att) { /* same fenced 'sending'→'failed' path as ATTACHMENT_MISSING_ERROR */ }
```

Defense-in-depth (recommended alongside, not instead): scope `deleteAttachmentForUser` to pending rows only — `and(eq(id), eq(userId), isNull(attachments.campaign_id))` — and reject `confirmAttachmentColumnCore` when the set is referenced by a queued/running campaign.

## Warnings

### WR-01: Prepare-time stamp makes pending uploads vanish from /compose after a cancelled review

**Fixed:** 2a64759

**File:** `lib/campaign/actions-core.ts:394-399`, `lib/data/attachments.ts:66-72`, `app/(app)/compose/page.tsx:54-56`, `lib/attachments/actions-core.ts:140-144, 260`
**Issue:** Opening the confirm dialog runs `prepareCampaign`, which stamps **all** of the user's pending uploads onto the fresh draft. If the user cancels and reloads /compose: (a) `listPendingAttachmentsForUser` (filters `campaign_id IS NULL`) returns nothing — the uploaded-files list renders empty; (b) `matchAttachmentsCore` matches against the now-empty pending set, so the compose card shows a destructive "Some attachments are missing … you can't send" alert for files that exist; (c) the `duplicate_filename` guard only checks pending rows, so re-uploading the "lost" file succeeds and creates a second row with the same filename — the next prepare re-claims both, and the `byName` maps in the matcher and materialize resolve the collision arbitrarily (Map last-write-wins). The stamped files are only recovered by opening the dialog again (draft re-claim), which a user who cancelled has no reason to do.
**Fix:** Either (1) include the user's draft-stamped attachments in the compose-surface reads (`campaign_id IS NULL OR campaign_id IN (user's draft campaigns)` — the exact predicate `stampCampaignOnPendingAttachments` already uses) for `listPendingAttachmentsForUser`-backed list/match/duplicate paths, or (2) move stamping from prepare to enqueue (the moment the files are truly committed), keeping the confirm summary matched against pending + draft rows.

### WR-02: No per-user upload quota and no orphan/consumed-upload cleanup (disk-exhaustion DoS)

**Fixed:** 479d6be (per-user count + byte quota; orphan/consumed-upload sweep is deferred ops work)

**File:** `lib/attachments/actions-core.ts:128-159`, `lib/data/attachments.ts` (no counting query exists), `next.config.ts:18`
**Issue:** The 10 MB per-file cap is enforced, but nothing limits **how many** files a user can upload: an authenticated tenant can loop `uploadAttachment` and write 10 MB per call to the shared `UPLOADS_PATH` volume indefinitely (the same volume that holds every tenant's CSVs — filling it takes the whole app down). There is also no cleanup path: pending uploads never expire, and uploads consumed by an enqueued campaign (including *unreferenced* ones — the stamp claims all pending rows whether or not any CSV row names them) sit on disk forever with no UI to remove them. The raised global `serverActions.bodySizeLimit: "11mb"` widens the per-request write for every action.
**Fix:** Add a cheap server-side gate in `uploadAttachmentCore` before writing, e.g. cap pending count and total pending bytes per user (`SELECT count(*), sum(size_bytes) FROM attachments WHERE user_id = ? AND campaign_id IS NULL`) and return a typed `quota_exceeded` error. Only stamp attachments that the campaign's CSV actually references, and add an ops-level sweep (or delete-on-campaign-completion policy) for consumed files.

### WR-03: Compose matcher and worker diverge from the confirm gate's email-column exclusion in auto-detect

**Fixed:** e17da86

**File:** `lib/attachments/actions-core.ts:259`, `lib/worker/materialize.ts:129-130` vs `lib/campaign/actions-core.ts:481-483`
**Issue:** `buildConfirmSummaryCore` deliberately nulls a detected attachment column when it equals the email column (its own comment explains emails end in ".com", which is filename-shaped, so `detectAttachmentColumn`'s content heuristic false-positives on the email column). But the compose-time `matchAttachmentsCore` uses bare `set.attachment_column ?? detectAttachmentColumn(columns, rows)`, and so does `materializeSendRecords`. For a CSV with no attachment-ish header and no confirmed column, the compose card can auto-detect the email column and render a blocking "Some attachments are missing: a@x.com, b@x.com…" destructive alert for a perfectly ordinary no-attachment list — while the confirm gate (correctly) lets the send through. Worse, `runMatch` then syncs `setAttachmentColumn(res.data.attachmentColumn)` so the email column is displayed as the selected attachment column, one click away from being persisted. This directly contradicts the three "SHARED matcher / ZERO divergence" comments.
**Fix:** Extract the resolution into one helper and use it in all three call sites:
```ts
export function resolveAttachmentColumn(set, columns, rows) {
  if (set.attachment_column) return set.attachment_column;
  const emailColumn = set.email_column ?? detectEmailColumn(columns, rows);
  const detected = detectAttachmentColumn(columns, rows);
  return detected === emailColumn ? null : detected;
}
```

### WR-04: Enqueue's attachment gate is skipped whenever the summary errors

**Fixed:** 159a261

**File:** `lib/campaign/actions-core.ts:577-589`
**Issue:** The gate only fires when `summary.ok`. The comment justifies falling through for `not_found` (so the atomic flip yields the canonical `already_queued` for cross-tenant callers), but the fall-through also covers `parse_error` and `unknown` (e.g. a transient `readUpload`/`listAttachmentsForCampaign` failure): the campaign is enqueued with the attachment gate never having run, and (per CR-01) materialize then silently un-links whatever doesn't match. Combined with CR-01 this converts a transient read error into attachment-less deliveries.
**Fix:** Only fall through on `not_found`; for any other summary failure return the failure instead of flipping:
```ts
if (!summary.ok && summary.error.kind !== "not_found") return summary;
```

### WR-05: Migration 0006's data-copy INSERT violates NOT NULL on any pre-existing attachment row

**Fixed:** bb20d02

**File:** `drizzle/0006_attachments_per_row.sql:13`
**Issue:** The rebuild copies `("id","campaign_id","filename","storage_path","created_at")` from the old table, but the new table declares `user_id text NOT NULL` and `size_bytes integer NOT NULL` with no defaults. Any row in the pre-0006 `attachments` table (schema existed since 0000) makes the migration abort with a NOT NULL constraint failure, and because the drizzle migrator runs migrations inside a transaction the `PRAGMA foreign_keys=OFF` on line 1 is a no-op anyway. It only succeeds because the table happens to be empty in every current environment — a silent landmine for any deployment where a row ever landed.
**Fix:** Make the copy total (e.g. `SELECT "id", "campaign_id", "filename", "storage_path", '' AS user_id, 0 AS size_bytes, "created_at"` with matching column list), or make it an explicit drop-and-recreate with a comment stating the pre-0006 table is guaranteed empty and a `DELETE FROM attachments` first.

### WR-06: Original filename forwarded into MIME headers with no control-character sanitization

**Fixed:** 41d7ce4

**File:** `lib/attachments/schema.ts:39-47`, `lib/worker/process.ts:248-252`
**Issue:** `uploadAttachmentSchema` requires only `min(1)` on the name, and the worker forwards the stored original filename verbatim into nodemailer's `attachments: [{ filename }]`, where it becomes the `Content-Disposition`/`Content-Type name` header parameter of an outbound message. A `File.name` is fully attacker-controlled (a scripted FormData can carry `\r\n`, quotes, or other control bytes). Current nodemailer versions encode/fold header parameter values, so this is not an exploitable injection today — but the app's only defense is an undocumented third-party behavior, and the same raw name also drives matching and display.
**Fix:** Normalize at the trust boundary — strip control characters in the schema (defense-in-depth, one line):
```ts
name: z.string().min(1, "That file has no name.")
  .transform((s) => s.replace(/[\r\n\t\x00-\x1f\x7f]/g, "").trim())
  .pipe(z.string().min(1, "That file has no name.")),
```

### WR-07: `confirmAttachmentColumnCore` persists any arbitrary string as the attachment column

**Fixed:** 3909bd1

**File:** `lib/attachments/actions-core.ts:208-222`
**Issue:** The column is persisted without validating it against the set's actual `columns_json`. A direct action call can store any string (including one that is not a CSV column). Downstream code degrades safely (`computeAttachmentMatch` requires `columns.includes(attachmentColumn)` → zero-case; materialize's `row[col] ?? ""` → no links) — but "safely" here means the matcher reports **no attachment column at all** while the confirm summary and compose card show a green no-attachment state, silently disabling attachments the user configured, and the divergent zero-case masks the bad value forever. Cheap to validate, and consistent with how `email_column` confirmation validates on save.
**Fix:** In `confirmAttachmentColumnCore`, load the set first (already owner-scoped via `getRecipientSetForUser`), parse `columns_json`, and return `{ kind: "validation" }`-style failure when `!columns.includes(column)`.

## Info

### IN-01: Full attachment rows (storage_path, userId) serialized to the client

**File:** `app/(app)/compose/page.tsx:54-56`, `lib/attachments/actions-core.ts:155`
**Issue:** `listPendingAttachmentsForUser` returns unprojected rows; they cross the wire as `initialAttachments` and as every action's returned list. `storage_path` (opaque UUID) and `userId` are not directly exploitable, but the rest of the codebase pointedly redacts via DTOs (`toSmtpConfigDto`).
**Fix:** Project to `{ id, filename, size_bytes }` in the DAL or the core before returning.

### IN-02: Per-row 15 MB check is unreachable with default caps, and no summing exists despite comments claiming it

**File:** `lib/attachments/match.ts:129`, `lib/attachments/schema.ts:29-31`, `lib/db/schema.ts:201-202`
**Issue:** The model attaches at most one file per row, and the per-file cap (10 MB) is below the per-message cap (15 MB), so `oversizeRowCount` can never be non-zero unless env vars invert the caps. Meanwhile schema comments say the validation "sums a row's attachment sizes." Not a bug today, but the UI's "15 MB per email" promise ignores ~37% base64 MIME inflation (a 10 MB file is a ~13.7 MB message).
**Fix:** Either document the single-attachment-per-row invariant where "sums" is claimed, or compare against an encoded-size estimate (`size_bytes * 4 / 3`).

### IN-03: Upload race and post-write insert failure can violate the "no orphan / no duplicate" claims

**File:** `lib/attachments/actions-core.ts:140-153`
**Issue:** The duplicate-name check and the insert are not atomic — two concurrent uploads of the same filename both pass the pending check and both persist. And if `createAttachment` throws after `writeAttachment` succeeded, the UUID file is orphaned on disk (the "no orphaned file" guarantee only covers guard failures).
**Fix:** Add a partial unique index on `(user_id, lower(trim(filename)))` where `campaign_id IS NULL`, and unlink the written file in a catch around `createAttachment`.

### IN-04: `runMatch` has no stale-response guard; `handleColumnChange` ignores persist failure

**File:** `components/compose/compose-editor.tsx:221-233, 250-256`
**Issue:** Unlike the preview effect (which uses an `ignore` flag), rapid recipient-list switches can let an earlier `matchAttachments` response land last and display the previous list's match summary/column. `handleColumnChange` also discards the result of `confirmAttachmentColumn`, so a failed persist (expired session) leaves the UI showing a column the server never saved.
**Fix:** Mirror the preview effect's `ignore` flag in the match effect, and surface a toast/alert when `confirmAttachmentColumn` returns `!ok`.

### IN-05: `guardedResolve` accepts "" / "." (resolves to UPLOADS_DIR itself)

**File:** `lib/attachments/storage.ts:41-47`
**Issue:** `full !== UPLOADS_DIR` is an allow, not a deny: `attachmentExists("")` returns `true` (the directory exists) and `resolveAttachmentPath("")` returns the directory. Only DB-sourced paths reach it today, but an empty `storage_path` row would pass the presence gate and then hand nodemailer a directory path.
**Fix:** Invert the boundary: `if (!full.startsWith(UPLOADS_DIR + sep)) throw ...` (drop the `full !== UPLOADS_DIR` escape hatch) so the resolved path must be strictly inside the directory.

---

_Reviewed: 2026-07-16_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
