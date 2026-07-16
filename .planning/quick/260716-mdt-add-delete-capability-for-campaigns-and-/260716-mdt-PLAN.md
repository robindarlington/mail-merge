---
phase: quick-260716-mdt
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - lib/data/campaigns.ts
  - lib/data/recipients.ts
  - lib/data/index.ts
  - lib/csv/storage.ts
  - lib/attachments/storage.ts
  - lib/data/campaigns.test.ts
  - lib/data/recipients.test.ts
  - lib/campaign/actions-core.ts
  - lib/campaign/actions.ts
  - lib/csv/actions-core.ts
  - lib/csv/actions.ts
  - lib/csv/actions-core.test.ts
  - components/campaign/delete-campaign-button.tsx
  - components/recipients/list-delete.tsx
  - app/(app)/campaigns/[id]/page.tsx
  - app/(app)/lists/page.tsx
  - app/(app)/lists/[id]/page.tsx
autonomous: true
requirements:
  - QUICK-260716-mdt

must_haves:
  truths:
    - "A Delete affordance appears on the campaign detail page and on the Lists page (and list detail)."
    - "Clicking Delete opens a shadcn AlertDialog confirm before anything is removed."
    - "Confirming a campaign delete removes the campaign, its send_records, its attachment rows, and unlinks the attachment files; the user is returned to /campaigns."
    - "A campaign whose status is queued or running is blocked from deletion with a clear in-use message; nothing is removed."
    - "Confirming a list delete removes the recipient_set row and unlinks its stored CSV file; the Lists surface refreshes."
    - "A list referenced by any campaign is blocked from deletion with a clear in-use message; nothing is removed."
    - "Every deletion is owner-scoped: a cross-tenant or unknown id removes zero rows and no files."
  artifacts:
    - path: "lib/data/campaigns.ts"
      provides: "deleteCampaignForUser transactional cascade (send_records -> attachments -> campaign, status-guarded)"
      contains: "deleteCampaignForUser"
    - path: "lib/data/recipients.ts"
      provides: "countCampaignsForRecipientSet (all statuses) + deleteRecipientSetForUser"
      contains: "deleteRecipientSetForUser"
    - path: "lib/csv/storage.ts"
      provides: "deleteUpload traversal-guarded CSV unlink"
      contains: "deleteUpload"
    - path: "lib/attachments/storage.ts"
      provides: "deleteAttachment traversal-guarded file unlink"
      contains: "deleteAttachment"
    - path: "lib/campaign/actions.ts"
      provides: "deleteCampaign server action (auth + owner-scope + revalidate)"
      contains: "deleteCampaign"
    - path: "lib/csv/actions.ts"
      provides: "deleteList server action (auth + owner-scope + revalidate)"
      contains: "deleteList"
    - path: "components/campaign/delete-campaign-button.tsx"
      provides: "AlertDialog confirm island for campaign deletion"
      contains: "AlertDialog"
    - path: "components/recipients/list-delete.tsx"
      provides: "AlertDialog confirm island for list deletion"
      contains: "AlertDialog"
  key_links:
    - from: "components/campaign/delete-campaign-button.tsx"
      to: "lib/campaign/actions.ts:deleteCampaign"
      via: "server action call"
      pattern: "deleteCampaign"
    - from: "lib/campaign/actions-core.ts:deleteCampaignCore"
      to: "lib/data/campaigns.ts:deleteCampaignForUser"
      via: "DAL cascade + post-commit unlink"
      pattern: "deleteCampaignForUser"
    - from: "components/recipients/list-delete.tsx"
      to: "lib/csv/actions.ts:deleteList"
      via: "server action call"
      pattern: "deleteList"
    - from: "lib/csv/actions-core.ts:deleteRecipientSetCore"
      to: "lib/data/recipients.ts:deleteRecipientSetForUser"
      via: "count-guard + delete + unlink CSV"
      pattern: "deleteRecipientSetForUser"
---

<objective>
Add operator-facing delete for two entities the staging operator (Rob) needs: a
campaign (from its detail page) and an uploaded list / CSV (from the Lists page and
list detail). Both gate on a shadcn AlertDialog confirm, both are owner-scoped
exactly like every existing mutation, and both clean up dependent DB rows and
on-disk files safely.

Purpose: the app can currently create campaigns and lists but never remove them —
staging accretes test data with no way to prune it, and orphaned CSV/attachment
files pile up under UPLOADS_PATH.

Output: two new server actions with tested core seams, three new DAL functions,
two storage-layer unlink helpers, two AlertDialog client islands, and the page
wiring that surfaces them.

Policy decisions (grounded in the actual schema — foreign_keys=ON, NO onDelete
cascade on any FK):
- Campaign delete is BLOCKED while status is `queued` or `running` (mirrors the
  SMTP in-use guard, SC5) — never delete a campaign the worker may be processing.
  `draft`, `completed`, and `failed` campaigns are deletable. Deletion cascades
  manually in FK order: send_records -> attachments -> campaign.
- List delete is BLOCKED when ANY campaign references the recipient set (all
  statuses). `campaigns.recipient_set_id` is NOT NULL with no cascade, so nulling
  the reference is impossible and a raw delete would violate the FK; blocking is
  the only safe, history-preserving option and matches the existing FK design.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@CLAUDE.md

<interfaces>
<!-- Contracts the executor builds against. Extracted from the codebase — no exploration needed. -->

Schema FKs (lib/db/schema.ts), foreign_keys=ON, NO onDelete anywhere:
- campaigns.recipient_set_id -> recipient_sets.id   (NOT NULL)
- campaigns.template_id      -> templates.id         (NOT NULL)
- campaigns.smtp_config_id   -> smtp_configs.id      (NOT NULL)
- send_records.campaign_id   -> campaigns.id         (NOT NULL)
- send_records.attachment_id -> attachments.id       (NULLABLE)
- attachments.campaign_id    -> campaigns.id         (NULLABLE)
Each attachment row owns a unique on-disk file (writeAttachment mints a per-upload
uuid), so unlinking an attachment's file affects no other row.

Existing DAL (lib/data), all owner-scoped by userId-first AND(id, userId):
- getCampaignForUser(userId, id)                    -> campaign row | undefined
- countActiveSendsForConfig(userId, id)             -> number (queued|running) — the SC5 guard shape to mirror
- getRecipientSetForUser(userId, id)                -> recipient_set row | undefined
- deleteAttachmentForUser(userId, id)               -> deleted rows[] (owner-scoped DELETE pattern to copy)
- shared `db` from "@/lib/db"; `db.transaction((tx) => ...)` is synchronous (better-sqlite3)

Storage modules (the ONLY writers to UPLOADS_PATH; both already export a
traversal guard resolving against UPLOADS_DIR):
- lib/csv/storage.ts        : writeUpload / readUpload  (add deleteUpload)
- lib/attachments/storage.ts: guardedResolve / resolveAttachmentPath / attachmentExists (add deleteAttachment)

Action layer three-file pattern (per feature):
- lib/{f}/actions.ts       "use server" — exports ONLY client-callable actions; each
    re-derives userId via lazy `const { auth } = await import("@clerk/nextjs/server")`,
    validates the id with a private `z.coerce.number().int().positive()` schema, then
    delegates to a userId-accepting core seam; on success calls revalidatePath.
- lib/{f}/actions-core.ts  no directive — testable seams accepting userId; typed
    ActionResult unions (ok:true | ok:false with a closed error kind union).
- Precedents to copy verbatim in shape: lib/smtp/actions.ts:deleteServer +
    lib/smtp/actions-core.ts:softDeleteConfigCore (in_use / not_found classification).

UI precedent to copy: components/smtp/server-list.tsx — AlertDialog with a
destructive AlertDialogAction, a `deleting` in-flight guard, e.preventDefault() so
an in_use result keeps the dialog open, sonner toast + router.refresh() on success.
Small-island precedent: components/recipients/list-rename.tsx.
</interfaces>
</context>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| client -> server action | Untrusted campaign/list id crosses here; client only proposes an id |
| server -> UPLOADS_PATH | Stored relative storage_path crosses into a filesystem unlink |
| worker <-> web (shared SQLite) | Worker may claim a queued campaign concurrently with a delete |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-mdt-01 | Elevation (IDOR) | deleteCampaign / deleteList actions | mitigate | Re-derive userId via auth(); every DAL DELETE filters AND(id, userId); a cross-tenant id deletes zero rows/files |
| T-mdt-02 | Tampering (TOCTOU) | campaign delete vs worker claim | mitigate | Campaign-row DELETE re-asserts `status NOT IN ('queued','running')` inside the transaction; changes!==1 rolls back the whole cascade and returns in_use |
| T-mdt-03 | Tampering (path traversal) | deleteUpload / deleteAttachment | mitigate | Unlink only through the storage modules' existing guardedResolve against UPLOADS_DIR; a traversal path throws before any unlink |
| T-mdt-04 | Denial of Service (double-submit) | AlertDialog confirm | mitigate | `deleting` flag disables the confirm/cancel buttons in flight; server delete is idempotent (0 rows on a second call) |
| T-mdt-05 | Info disclosure | action returns / logs | mitigate | Returns carry a message-only typed error kind; no filenames, storage paths, or userIds are logged (matches maintenance.ts sweep discipline) |
| T-mdt-SC | Tampering | npm/pip/cargo installs | accept | No new packages are added by this plan; nothing to audit |
</threat_model>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Deletion data + storage layer (cascade, guards, file unlink)</name>
  <files>lib/data/campaigns.ts, lib/data/recipients.ts, lib/data/index.ts, lib/csv/storage.ts, lib/attachments/storage.ts, lib/data/campaigns.test.ts, lib/data/recipients.test.ts</files>
  <behavior>
    - deleteCampaignForUser(userId, id): a draft/completed/failed campaign owned by the user is removed together with all its send_records and attachment rows; returns { ok:true, storagePaths:[...] } listing the removed attachments' storage_path values.
    - deleteCampaignForUser blocks an active campaign: with status 'queued' or 'running' it deletes NOTHING (send_records + attachments still present) and returns { ok:false } (the status-guarded campaign DELETE affects 0 rows -> transaction rolls back).
    - deleteCampaignForUser is owner-scoped: another user's id removes zero rows and returns { ok:false }.
    - countCampaignsForRecipientSet(userId, setId): returns the count of the user's campaigns referencing the set across ALL statuses (draft, queued, running, completed, failed); zero for a set with no campaigns and for a cross-tenant set.
    - deleteRecipientSetForUser(userId, id): owner-scoped DELETE returning the removed row(s) (empty array for a cross-tenant/unknown id).
    - deleteUpload(storagePath) / deleteAttachment(storagePath): unlink the resolved file; a traversal path throws; a missing file is tolerated (no throw) so callers can treat it as best-effort.
  </behavior>
  <action>In lib/data/campaigns.ts add deleteCampaignForUser(userId, id). Run everything inside one synchronous db.transaction((tx) => ...). FIRST collect the attachment storage_path values for AND(campaign_id=id, matching the owner via the campaign) — select storage_path from attachments where campaign_id=id (the campaign ownership is proven by the guarded campaign DELETE below and by the caller's pre-check). Then, in FK-safe order: delete send_records where campaign_id=id; delete attachments where campaign_id=id; finally delete campaigns where AND(id, userId, notInArray(status, ['queued','running'])) and read the returned/changes count. If the campaign DELETE affected !==1 row, throw a private sentinel Error to roll the whole transaction back (nothing removed) and map it to { ok:false, storagePaths: [] }; on success return { ok:true, storagePaths }. Catch the sentinel outside the transaction and return the ok:false result; re-throw anything else. Do NOT unlink files here — return the paths for the core seam to unlink post-commit (row-first discipline, mirrors lib/worker/maintenance.ts). Mirror the existing ACTIVE_CAMPAIGN_STATUSES constant already in this file.

In lib/data/recipients.ts add countCampaignsForRecipientSet(userId, setId) — a count(*) over campaigns filtered AND(userId, recipient_set_id=setId) across ALL statuses (no status filter; distinct from the existing countActiveCampaignsForRecipientSet). Add deleteRecipientSetForUser(userId, id) — a DELETE filtered AND(id, userId) with .returning(), copying the owner-filter idiom + the AUTH-02 grep-gate comment style from deleteAttachmentForUser.

In lib/csv/storage.ts add deleteUpload(storagePath: string): void — resolve via the SAME prefix guard readUpload uses (resolve(UPLOADS_DIR, storagePath) + startsWith check; throw on escape), then fs.unlinkSync inside a try/catch that swallows ENOENT only (rethrow other errors). In lib/attachments/storage.ts add deleteAttachment(storagePath: string): void — reuse the existing guardedResolve(storagePath), then unlinkSync with the same ENOENT-tolerant try/catch. Import unlinkSync from node:fs in both.

Export deleteCampaignForUser, countCampaignsForRecipientSet, and deleteRecipientSetForUser from lib/data/index.ts.

Extend lib/data/campaigns.test.ts and lib/data/recipients.test.ts (node --test + tsx, temp-DB pattern already used in these files) to cover the behaviors above, including the active-campaign block leaving dependents intact and the cross-tenant no-op.</action>
  <verify>
    <automated>npm test -- 2>&1 | tail -20; npx tsc --noEmit</automated>
  </verify>
  <done>New DAL + storage functions exist and are exported; campaigns/recipients tests cover cascade, active-block, all-status count, and cross-tenant no-op; `npm test` and `tsc --noEmit` pass.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Server actions + tested core seams</name>
  <files>lib/campaign/actions-core.ts, lib/campaign/actions.ts, lib/csv/actions-core.ts, lib/csv/actions.ts, lib/csv/actions-core.test.ts</files>
  <behavior>
    - deleteCampaignCore(userId, id): pre-checks getCampaignForUser -> undefined returns { ok:false, error:{ kind:'not_found' } }; status queued|running returns { ok:false, error:{ kind:'in_use' } } and deletes nothing. Otherwise calls deleteCampaignForUser; on { ok:true } unlinks each returned attachment path via deleteAttachment (best-effort, failures swallowed) and returns { ok:true }; on the rare guarded-rollback { ok:false } returns { kind:'in_use' } (the TOCTOU race).
    - deleteRecipientSetCore(userId, id): if countCampaignsForRecipientSet > 0 returns { ok:false, error:{ kind:'in_use' } } and deletes nothing; else fetches the set (for its storage_path), deletes via deleteRecipientSetForUser, and on a non-empty result unlinks the CSV via deleteUpload; a zero-length delete maps to { kind:'not_found' }.
    - Both actions reject unauthenticated callers with { kind:'unauthenticated' } and coerce/validate the id before any DB touch.
  </behavior>
  <action>In lib/campaign/actions-core.ts add deleteCampaignCore(userId: string, id: number): Promise<Result> with a typed union { ok:true } | { ok:false; error: { kind: 'not_found' | 'in_use' | 'unknown'; raw?: string } }, following softDeleteConfigCore's shape in lib/smtp/actions-core.ts. Order: getCampaignForUser first (not_found / in_use classification), then deleteCampaignForUser, then post-commit deleteAttachment on each storagePath wrapped so a unlink failure never fails the action. In lib/campaign/actions.ts add the "use server" deleteCampaign(id: unknown) wrapper: lazy-import auth(), reject unauthenticated, coerce the id with a private z.coerce.number().int().positive() schema (copy the campaignIdSchema idiom already used in this feature), delegate to deleteCampaignCore, and on success call revalidatePath('/campaigns') via lazy `const { revalidatePath } = await import('next/cache')`. Re-export the Result type for the UI.

In lib/csv/actions-core.ts add deleteRecipientSetCore(userId, rawId) mirroring renameRecipientSetCore (validate id with the existing listIdSchema, count-guard, fetch for storage_path via getRecipientSetForUser, delete, unlink). Reuse the existing ActionError union (add an 'in_use' kind if not present) and RenameResult-style shape or a new DeleteResult. In lib/csv/actions.ts add the "use server" deleteList(id) wrapper following renameList: auth, delegate, revalidatePath('/lists') on success.

Extend lib/csv/actions-core.test.ts (and add campaign action-core coverage if a test file exists for it; otherwise create lib/campaign/actions-core.test.ts following lib/smtp/actions.test.ts's stubbing style) to cover in_use, not_found, unauthenticated, and the happy path with a stubbed/temp DB. Do NOT hit a real filesystem for unlink assertions beyond the temp UPLOADS dir the storage tests already use.</action>
  <verify>
    <automated>npm test -- 2>&1 | tail -20; npx tsc --noEmit</automated>
  </verify>
  <done>deleteCampaign and deleteList server actions exist, are the only new client-callable exports, re-derive userId, and classify in_use/not_found/unauthenticated; core-seam tests pass; `tsc --noEmit` clean.</done>
</task>

<task type="auto">
  <name>Task 3: AlertDialog confirm islands + page wiring</name>
  <files>components/campaign/delete-campaign-button.tsx, components/recipients/list-delete.tsx, app/(app)/campaigns/[id]/page.tsx, app/(app)/lists/page.tsx, app/(app)/lists/[id]/page.tsx</files>
  <action>Create components/campaign/delete-campaign-button.tsx ("use client") — a destructive Button that opens an AlertDialog, following components/smtp/server-list.tsx's delete block: `deleting` in-flight state disabling both dialog buttons, AlertDialogAction with variant="destructive" and e.preventDefault() so an in_use result keeps the dialog open, sonner toast on outcomes. On { ok:true } call router.push('/campaigns') (the campaign is gone, so refresh-in-place would 404). Render an in_use Alert inside the dialog ("This campaign is sending right now — wait for it to finish, then delete it."). Props: { campaignId: number }.

Create components/recipients/list-delete.tsx ("use client") — a small destructive island mirroring list-rename.tsx's footprint (accept { id, name, showName? } so it can sit inline in the Lists row and on the detail header). AlertDialog confirm; on success toast + router.refresh(); on in_use show a message that the list is used by a campaign and can't be deleted while that history exists. Calls deleteList(id).

Wire delete-campaign-button into app/(app)/campaigns/[id]/page.tsx — place it in the header actions row (near the Back link or the results-header action area); it is a client island rendered from the RSC, passing campaign.id. Wire list-delete into app/(app)/lists/page.tsx (each row, beside the existing ListRename affordance, passing set.id and set.label ?? set.filename, showName=false) and into app/(app)/lists/[id]/page.tsx header (beside the ListRename). Keep the one-accent discipline noted in the page comments — delete is a muted/ghost destructive affordance, not a primary accent.</action>
  <verify>
    <automated>npx tsc --noEmit && npm run build 2>&1 | tail -25</automated>
  </verify>
  <done>Both islands exist and compile; the campaign detail page shows a Delete affordance and the Lists page + list detail show a Delete affordance; production build succeeds with no type errors.</done>
</task>

</tasks>

<verification>
- `npm test` passes (existing + new DAL and action-core tests).
- `npx tsc --noEmit` is clean.
- `npm run build` succeeds.
- Manual staging smoke (operator): delete a completed campaign -> it disappears from /campaigns and its attachment files are gone; delete a queued/running campaign -> blocked with the in-use message; delete an unused list -> gone with its CSV file removed; delete a list used by a campaign -> blocked with the in-use message.
- No attribution to Claude/AI anywhere in new files or comments.
</verification>

<success_criteria>
- An operator can delete a campaign (draft/completed/failed) from its detail page behind an AlertDialog confirm; send_records + attachment rows + attachment files are removed; queued/running campaigns are blocked.
- An operator can delete an uploaded list from the Lists page or list detail behind an AlertDialog confirm; the CSV file is removed; a list referenced by any campaign is blocked.
- Every deletion is owner-scoped and cannot touch another tenant's data.
- All new logic is covered by tests consistent with the existing route/DAL test patterns; build and typecheck pass.
</success_criteria>

<output>
Create `.planning/quick/260716-mdt-add-delete-capability-for-campaigns-and-/260716-mdt-SUMMARY.md` when done.
</output>
