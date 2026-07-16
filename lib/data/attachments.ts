/**
 * userId-scoped attachments data-access layer (ATCH-01 / ATCH-03 / AUTH-02).
 *
 * The tenancy backbone of the per-row attachments phase. Files are uploaded on
 * /compose BEFORE a campaign exists (the pre-campaign window), so `attachments`
 * carries a DIRECT `userId` owner column and a NULLABLE `campaign_id` — this DAL
 * scopes every pre-campaign read/write on `userId`, mirroring lib/data/recipients.ts:
 *
 *  - AUTH-02 (multi-tenant isolation / T-07-04 IDOR): every by-id path filters on
 *    the owner via `and(eq(id), eq(userId))`; there is deliberately NO fetch/delete/
 *    update-by-id-alone path for the pre-campaign functions, so USER_B can never
 *    touch USER_A's rows.
 *
 *  - Server-set ownership (T-07-05): `createAttachment` types its `values` param as
 *    a `Pick<>` that OMITS both `userId` and `campaign_id`, then spreads
 *    `{ ...values, userId }` — userId LAST — so a caller cannot spoof ownership.
 *
 *  - Idempotent stamp (T-07-17): `stampCampaignOnPendingAttachments` claims the
 *    user's UNSTAMPED rows OR rows still owned by one of THIS user's DRAFT
 *    campaigns, so re-opening the confirm dialog (which mints a fresh draft) never
 *    strands the files on an abandoned draft. It never touches a queued/running
 *    campaign's attachments (committed to a real send).
 *
 * Worker tenancy exception (PATTERNS): the worker has no Clerk session, so
 * `getAttachmentByIdForCampaign` scopes by `campaign_id` (the owner is derived
 * upstream from `campaign.userId`), following the send_records.attachment_id
 * inverted link.
 *
 * This module imports the shared `db` from `@/lib/db` (the SOLE SQLite opener,
 * D-04); it never constructs a Database.
 */

import { and, eq, or, desc, isNull, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { attachments, campaigns, type NewAttachment } from "@/lib/db/schema";

/**
 * The persistable fields for an attachment insert. `userId` is server-injected in
 * `createAttachment`; `campaign_id` is deliberately absent too — it is stamped
 * LATER at prepare time (never at insert, since the upload precedes the campaign).
 * Derived from the insert model so the columns stay in lockstep with the schema.
 */
export type PersistableAttachment = Pick<
  NewAttachment,
  "filename" | "storage_path" | "size_bytes"
>;

/**
 * Insert an attachment owned by `userId` and return the created row (with its
 * generated id and NULL campaign_id). `userId` is spread in LAST server-side; the
 * `values` type cannot carry it, so a caller cannot spoof ownership (T-07-05).
 */
export function createAttachment(userId: string, values: PersistableAttachment) {
  return db
    .insert(attachments)
    .values({ ...values, userId }) // userId LAST — ownership wins
    .returning();
}

/**
 * List the caller's PENDING uploads (campaign_id IS NULL), newest first. Scoped to
 * `userId` — the only pre-campaign list path, so USER_B's uploads never surface in
 * USER_A's compose window (AUTH-02).
 */
export function listPendingAttachmentsForUser(userId: string) {
  // findMany scoped to userId + unstamped on this line (owner-filter, AUTH-02 grep gate).
  return db.query.attachments.findMany({
    where: and(eq(attachments.userId, userId), isNull(attachments.campaign_id)),
    orderBy: desc(attachments.created_at),
  });
}

/**
 * Delete one of the caller's uploads and return the removed row(s). The DELETE is
 * scoped by AND(id, userId) — a cross-tenant (or absent) id removes ZERO rows and
 * returns an empty array (T-07-04 / IDOR). There is deliberately NO delete-by-id-
 * alone path.
 */
export function deleteAttachmentForUser(userId: string, id: number) {
  // DELETE filtered by AND(id, userId) on this line — never delete-by-id alone (owner-filter, AUTH-02 grep gate).
  return db
    .delete(attachments)
    .where(and(eq(attachments.id, id), eq(attachments.userId, userId)))
    .returning();
}

/**
 * List the attachments stamped to one campaign, owner-scoped. AND(campaign_id,
 * userId) so a cross-tenant caller sees nothing (AUTH-02).
 */
export function listAttachmentsForCampaign(userId: string, campaignId: number) {
  // findMany filtered by AND(campaign_id, userId) on this line (owner-filter, AUTH-02 grep gate).
  return db.query.attachments.findMany({
    where: and(
      eq(attachments.campaign_id, campaignId),
      eq(attachments.userId, userId),
    ),
  });
}

/**
 * Stamp `campaignId` onto the caller's attachments and return the stamped rows.
 * IDEMPOTENT across re-prepares — claim UNSTAMPED rows OR rows still owned by one
 * of THIS user's DRAFT campaigns; never a queued/running/completed campaign's
 * (those are committed to a real send). The whole predicate is userId-scoped, so a
 * second draft only re-claims the SAME user's rows (T-07-17). Re-opening the
 * confirm dialog mints a fresh draft, and this re-claims the prior draft's
 * attachments onto it instead of stranding them (BLOCKER-1 fix).
 */
export function stampCampaignOnPendingAttachments(userId: string, campaignId: number) {
  // The user's still-draft campaign ids — the re-claim window. A queued/running
  // campaign is absent here, so its attachments are never moved.
  const stillDraftCampaigns = db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(and(eq(campaigns.userId, userId), eq(campaigns.status, "draft")));

  return db
    .update(attachments)
    .set({ campaign_id: campaignId })
    .where(
      and(
        eq(attachments.userId, userId),
        // idempotent across re-prepares — claim unstamped OR still-draft-owned
        // rows; never a queued/running campaign's (owner-filter, AUTH-02 grep gate).
        or(
          isNull(attachments.campaign_id),
          inArray(attachments.campaign_id, stillDraftCampaigns),
        ),
      ),
    )
    .returning();
}

/**
 * Resolve a single attachment by id AND campaign_id — the worker's send-time path
 * for the inverted send_records.attachment_id link. The worker has no Clerk
 * session; ownership is derived upstream from campaign.userId, so this function
 * enforces the campaign_id scope (a mismatched campaign resolves to not-found).
 */
export function getAttachmentByIdForCampaign(campaignId: number, attachmentId: number) {
  // findFirst filtered by AND(id, campaign_id) — the worker tenancy exception.
  return db.query.attachments.findFirst({
    where: and(
      eq(attachments.id, attachmentId),
      eq(attachments.campaign_id, campaignId),
    ),
  });
}
