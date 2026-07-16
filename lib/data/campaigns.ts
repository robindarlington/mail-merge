/**
 * userId-scoped campaigns data-access layer (TEST-03 / AUTH-02).
 *
 * The durable unit both Phase-5 send surfaces operate against. The `campaigns`
 * table already exists on disk (Phase 1 migration `drizzle/0000`); this module
 * adds NO schema change — only the DAL functions. `status` defaults to `draft`.
 *
 *  - AUTH-02 (multi-tenant isolation): EVERY function here takes `userId` as its
 *    required FIRST parameter and filters on it. There is deliberately NO query
 *    path that fetches a campaign by id without an owner filter —
 *    `getCampaignForUser` uses `and(eq(id), eq(userId))`, never `eq(id)` alone.
 *    That structural rule is what prevents the IDOR threat (T-5-IDOR): User A can
 *    never read User B's campaign.
 *
 *  - Server-set ownership (T-5-TAMPER-OWNER): `createDraftCampaign` types its
 *    `values` param as a `Pick<>` that OMITS `userId`, then spreads
 *    `{ ...values, userId }` — userId LAST — so a caller cannot spoof ownership
 *    through the values object (the a906a8f ownership-wins fix).
 *
 *  - Atomic enqueue guard (TEST-03 / T-5-DUPE): `enqueueCampaign` flips
 *    draft→queued in a SINGLE statement whose WHERE requires `status='draft'` AND
 *    the owner's `user_id`. The affected-row count IS the idempotency signal — the
 *    first call returns exactly one row, a second call on an already-queued
 *    campaign returns zero (the double-submit no-op), and a cross-tenant caller is
 *    refused (zero rows). NEVER SELECT-then-UPDATE — that TOCTOU race would let a
 *    double-click slip a duplicate transition through.
 *
 * This module imports the shared `db` from `@/lib/db` (the SOLE SQLite opener,
 * D-04); it never constructs a Database.
 */

import { and, asc, desc, eq, gt, inArray, not, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  attachments,
  campaigns,
  send_records,
  type NewCampaign,
} from "@/lib/db/schema";

/**
 * The persistable fields for a draft-campaign insert. `userId` is deliberately
 * absent — it is server-injected inside `createDraftCampaign`, never supplied by
 * the caller. Derived from the insert model so the columns stay in lockstep with
 * the schema. All three FK ids are NOT NULL, so a draft can only be created once
 * the recipient set + template + SMTP config all exist.
 */
export type PersistableCampaign = Pick<
  NewCampaign,
  "recipient_set_id" | "template_id" | "smtp_config_id"
>;

/**
 * Insert a draft campaign owned by `userId` and return the created row (with its
 * generated id and `status='draft'`). `userId` is spread in LAST server-side; the
 * `values` type cannot carry it, so a caller cannot spoof ownership
 * (T-5-TAMPER-OWNER).
 */
export function createDraftCampaign(userId: string, values: PersistableCampaign) {
  return db
    .insert(campaigns)
    .values({ ...values, userId }) // userId LAST — ownership wins (a906a8f)
    .returning();
}

/**
 * Fetch a single campaign by id, but ONLY if it belongs to `userId`. The
 * `and(eq(id), eq(userId))` filter is the structural IDOR defense — there is no
 * fetch-by-id-alone path, so an id owned by another tenant returns undefined
 * (T-5-IDOR / AUTH-02).
 */
export function getCampaignForUser(userId: string, id: number) {
  // findFirst filtered by AND(id, userId) — never fetch-by-id alone.
  return db.query.campaigns.findFirst({
    where: and(eq(campaigns.id, id), eq(campaigns.userId, userId)),
  });
}

/**
 * Atomically flip a draft campaign to `queued` (TEST-03). A SINGLE statement
 * updates only when the row is still `draft` AND owned by `userId`; the returned
 * row array's length IS the "did I win the transition?" signal — 1 on the first
 * enqueue, 0 on any subsequent call (the double-submit no-op) and 0 for a
 * cross-tenant caller (the IDOR defense). SQLite's single-writer model makes this
 * affected-row count authoritative. NEVER SELECT-then-UPDATE.
 */
export function enqueueCampaign(userId: string, id: number) {
  return db
    .update(campaigns)
    .set({ status: "queued" })
    .where(
      and(
        eq(campaigns.id, id),
        eq(campaigns.userId, userId),
        eq(campaigns.status, "draft"),
      ),
    )
    .returning({ id: campaigns.id });
}

/** The campaign statuses that mean "committed to a real send" — the window during
 *  which a recipient set's attachment inputs must NOT be mutated (CR-01). */
const ACTIVE_CAMPAIGN_STATUSES = ["queued", "running"] as const;

/**
 * Count the caller's queued/running campaigns that reference a given recipient set
 * (CR-01 mutation-window guard). Owner-scoped. A non-zero count means an in-flight
 * campaign is depending on this set, so its attachment column must not change and
 * its uploads must not be deleted between enqueue and materialize.
 */
export async function countActiveCampaignsForRecipientSet(
  userId: string,
  recipientSetId: number,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.userId, userId),
        eq(campaigns.recipient_set_id, recipientSetId),
        inArray(campaigns.status, [...ACTIVE_CAMPAIGN_STATUSES]),
      ),
    );
  return row?.n ?? 0;
}

/** The result of a delete attempt: `ok:false` when the status guard (or owner
 *  scope) blocked it, plus the removed attachments' storage paths for the caller
 *  to unlink POST-commit (row-first discipline — never unlink inside the txn). */
export type DeleteCampaignResult = { ok: boolean; storagePaths: string[] };

/**
 * Delete one of the caller's campaigns together with its dependents, transactionally
 * (mdt). foreign_keys=ON with NO onDelete cascade anywhere, so the cascade is manual
 * and in FK-safe order: send_records → attachments → campaign.
 *
 * STATUS GUARD (T-mdt-02 TOCTOU): the campaign DELETE re-asserts owner scope AND
 * "not actively sending" — `NOT (status='running' AND lease alive)` — INSIDE the
 * transaction. If it affects !==1 row (a worker holds a live lease, OR a cross-tenant
 * / unknown id), a sentinel throw rolls the WHOLE cascade back — nothing is removed —
 * and the function returns `{ ok:false, storagePaths: [] }`. Everything else deletes:
 * draft/completed/failed, `queued` (nothing sent yet; a concurrent claim flips it to
 * running+live-lease under the write lock and this guard then refuses), and abandoned
 * `running` with an expired/NULL lease (a dead worker must not make campaigns
 * immortal; a stalled worker that wakes later hits its ownership-checked heartbeat,
 * matches zero rows, and aborts via LeaseLostError without finalizing).
 *
 * ROW-FIRST (mirrors lib/worker/maintenance.ts): files are NOT unlinked here. The
 * removed attachments' `storage_path` values are collected FIRST (before the rows go)
 * and returned so the core seam can unlink them AFTER the DB commit — a failed unlink
 * then leaves only a harmless disk-only file, never an orphaned row.
 */
export function deleteCampaignForUser(
  userId: string,
  id: number,
): DeleteCampaignResult {
  try {
    return db.transaction((tx) => {
      // Collect the attachment paths BEFORE deleting the rows (they vanish next).
      const atts = tx
        .select({ storage_path: attachments.storage_path })
        .from(attachments)
        .where(eq(attachments.campaign_id, id))
        .all();
      const storagePaths = atts.map((a) => a.storage_path);

      // FK-safe order: children first, parent last (no onDelete cascade exists).
      tx.delete(send_records).where(eq(send_records.campaign_id, id)).run();
      tx.delete(attachments).where(eq(attachments.campaign_id, id)).run();

      // Owner-scoped + guarded parent DELETE — the affected-row count IS the
      // "am I allowed?" signal. Blocked ONLY while a worker is provably sending
      // this campaign right now: status 'running' with a LIVE lease (the worker
      // heartbeats the lease every row). Everything else is deletable, including
      // `queued` (nothing sent yet; if the worker claims it concurrently, this
      // guard sees the fresh live lease under SQLite's write lock and refuses)
      // and abandoned `running` with an expired/NULL lease (dead worker — the
      // old queued/running blanket block made such campaigns immortal). If a
      // stalled worker later wakes, its ownership-checked heartbeat matches zero
      // rows and aborts the run (LeaseLostError) without finalizing.
      const removed = tx
        .delete(campaigns)
        .where(
          and(
            eq(campaigns.id, id),
            eq(campaigns.userId, userId),
            not(
              and(
                eq(campaigns.status, "running"),
                gt(
                  sql`coalesce(${campaigns.lease_expires_at}, 0)`,
                  sql`unixepoch()`,
                ),
              )!,
            ),
          ),
        )
        .returning({ id: campaigns.id })
        .all();

      // 0 rows = active OR cross-tenant/unknown → roll the whole cascade back.
      if (removed.length !== 1) throw new Error("CAMPAIGN_DELETE_BLOCKED");
      return { ok: true, storagePaths };
    });
  } catch (e) {
    if ((e as Error).message === "CAMPAIGN_DELETE_BLOCKED") {
      return { ok: false, storagePaths: [] };
    }
    throw e;
  }
}

// --- Phase-6 read layer (HIST-01 / HIST-02 / SEND-05) -----------------------
//
// Every web surface onto the send — the history list, the per-recipient
// drill-down, and the live-progress poll — is a VIEW over the persisted state,
// and each read is userId-scoped so a guessed campaign id can never leak another
// tenant's data (T-06-08 / AUTH-02). send_records carry NO userId column: their
// tenancy is inherited through campaign_id, so any send_records read is gated
// behind `getCampaignForUser` FIRST — there is deliberately no fetch-by-
// campaign_id-alone path.

/**
 * List every campaign owned by `userId`, newest first (HIST-01). The `userId`
 * filter is the tenant scope; the secondary `desc(id)` tiebreaks campaigns
 * created within the same unixepoch SECOND (created_at has 1s resolution), so
 * "newest first" is deterministic rather than order-of-insert-dependent.
 */
export function listCampaignsForUser(userId: string) {
  return db.query.campaigns.findMany({
    where: eq(campaigns.userId, userId),
    orderBy: [desc(campaigns.created_at), desc(campaigns.id)],
  });
}

/**
 * The per-recipient drill-down for one campaign (HIST-02). Ownership is proven
 * FIRST via `getCampaignForUser` — send_records have no userId of their own, so
 * an id owned by another tenant (or a bogus one) short-circuits to `[]` BEFORE
 * any send_records query runs (T-06-08). Owned rows come back ordered by id
 * (materialization order = recipient order).
 */
export async function getSendRecordsForCampaign(userId: string, campaignId: number) {
  // Ownership guard BEFORE the send_records read — never fetch by campaign_id alone.
  const owned = await getCampaignForUser(userId, campaignId);
  if (!owned) return [];
  return db.query.send_records.findMany({
    where: eq(send_records.campaign_id, campaignId),
    orderBy: asc(send_records.id),
  });
}

/**
 * The live-progress row for one campaign (SEND-05). Ownership is proven FIRST
 * via `getCampaignForUser` (cross-tenant/bogus id → undefined). Returns the
 * campaign's own counters plus the `current` recipient = the `to_addr` of the
 * single send_record in status 'sending' (sends are sequential, so there is at
 * most one), or `null` when the campaign is between rows / terminal. The caller
 * (getCampaignProgressCore) derives `remaining` from these counters.
 */
export async function getCampaignProgressRow(userId: string, campaignId: number) {
  const campaign = await getCampaignForUser(userId, campaignId);
  if (!campaign) return undefined;
  // The lone in-flight row, if any — the current recipient the UI highlights.
  const sending = await db.query.send_records.findFirst({
    where: and(
      eq(send_records.campaign_id, campaignId),
      eq(send_records.status, "sending"),
    ),
  });
  return {
    status: campaign.status,
    total: campaign.total,
    sent_count: campaign.sent_count,
    failed_count: campaign.failed_count,
    current: sending?.to_addr ?? null,
  };
}
