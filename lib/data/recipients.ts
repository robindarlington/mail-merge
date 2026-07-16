/**
 * userId-scoped recipient_sets data-access layer (CSV-05 / AUTH-02).
 *
 * This is the tenancy backbone of the CSV-upload phase, mirroring lib/data/smtp.ts:
 *
 *  - AUTH-02 (multi-tenant isolation): EVERY function here takes `userId` as its
 *    required FIRST parameter and filters on it. There is deliberately NO query
 *    path that fetches a set by id without an owner filter — `getRecipientSetForUser`
 *    uses `and(eq(id), eq(userId))`, never `eq(id)` alone. That structural rule is
 *    what prevents the IDOR threat (T-3-IDOR): User A can never read User B's set.
 *
 *  - Server-set ownership (T-3-TAMPER-OWNER): `createRecipientSet` types its
 *    `values` param as a `Pick<>` that OMITS `userId`, then spreads
 *    `{ ...values, userId }` — userId LAST — so server-injected ownership wins even
 *    if a runtime values object smuggles a userId key.
 *
 * This module imports the shared `db` from `@/lib/db` (the SOLE SQLite opener,
 * D-04); it never constructs a Database.
 */

import { and, eq, desc, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  campaigns,
  recipient_sets,
  type NewRecipientSet,
} from "@/lib/db/schema";

/**
 * The persistable fields for a recipient-set insert. `userId` is deliberately
 * absent — it is server-injected inside `createRecipientSet`, never supplied by
 * the caller. Derived from the insert model so the columns stay in lockstep with
 * the schema.
 */
export type PersistableRecipientSet = Pick<
  NewRecipientSet,
  "filename" | "columns_json" | "row_count" | "storage_path" | "email_column"
>;

/**
 * Insert a recipient set owned by `userId` and return the created row (with its
 * generated id). `userId` is spread in LAST server-side; the `values` type cannot
 * carry it, so a caller cannot spoof ownership (T-3-TAMPER-OWNER).
 */
export function createRecipientSet(
  userId: string,
  values: PersistableRecipientSet,
) {
  return db
    .insert(recipient_sets)
    .values({ ...values, userId })
    .returning();
}

/**
 * List the caller's recipient sets, newest first. Scoped to `userId` — the only
 * lookup path, so User B's sets can never surface in User A's list (AUTH-02).
 */
export function listRecipientSetsForUser(userId: string) {
  // findMany scoped to userId on this line (owner-filter, AUTH-02 grep gate).
  return db.query.recipient_sets.findMany({ where: eq(recipient_sets.userId, userId), orderBy: desc(recipient_sets.created_at) });
}

/**
 * Fetch a single recipient set by id, but ONLY if it belongs to `userId`.
 * The `and(eq(id), eq(userId))` filter is the structural IDOR defense — there is
 * no fetch-by-id-alone path, so an id owned by another tenant returns undefined
 * (T-3-IDOR / AUTH-02).
 */
export function getRecipientSetForUser(userId: string, id: number) {
  // findFirst filtered by AND(id, userId) on this line — never fetch-by-id alone.
  return db.query.recipient_sets.findFirst({ where: and(eq(recipient_sets.id, id), eq(recipient_sets.userId, userId)) });
}

/**
 * Set the user-facing `label` on one of the caller's recipient sets and return
 * the updated row(s). The UPDATE is scoped by AND(id, userId) — the SAME structural
 * owner-filter as getRecipientSetForUser, so a cross-tenant id (or a non-existent
 * one) updates ZERO rows and returns an empty array (T-r8d-01 / IDOR / AUTH-02).
 * There is deliberately NO update-by-id-alone path.
 */
export function renameRecipientSet(userId: string, id: number, label: string) {
  // UPDATE filtered by AND(id, userId) on this line — never update-by-id alone (owner-filter, AUTH-02 grep gate).
  return db
    .update(recipient_sets)
    .set({ label })
    .where(and(eq(recipient_sets.id, id), eq(recipient_sets.userId, userId)))
    .returning();
}

/**
 * Persist the user-confirmed attachment-filename column on one of the caller's
 * recipient sets and return the updated row(s). Same owner-filter as
 * renameRecipientSet — the UPDATE is scoped by AND(id, userId), so a cross-tenant
 * (or non-existent) id updates ZERO rows and returns an empty array (ATCH-01 /
 * IDOR / AUTH-02). Persisting the column here means the send path uses the column
 * the user chose, never a re-run of detectAttachmentColumn that would silently
 * drop an override (mirrors email_column's "save path always writes it" contract).
 */
export function setAttachmentColumnForUser(
  userId: string,
  id: number,
  attachmentColumn: string,
) {
  // UPDATE filtered by AND(id, userId) on this line — never update-by-id alone (owner-filter, AUTH-02 grep gate).
  return db
    .update(recipient_sets)
    .set({ attachment_column: attachmentColumn })
    .where(and(eq(recipient_sets.id, id), eq(recipient_sets.userId, userId)))
    .returning();
}

/**
 * Count the caller's campaigns that reference a recipient set, across ALL statuses
 * (draft, queued, running, completed, failed) — the delete-guard for a list (mdt).
 * DISTINCT from `countActiveCampaignsForRecipientSet` (queued/running only): a list
 * referenced by ANY campaign cannot be deleted, because `campaigns.recipient_set_id`
 * is NOT NULL with no cascade, so a raw delete would violate the FK and nulling the
 * reference is impossible — blocking is the only safe, history-preserving option.
 * Owner-scoped: a cross-tenant set counts zero (AUTH-02).
 */
export async function countCampaignsForRecipientSet(
  userId: string,
  setId: number,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.userId, userId),
        eq(campaigns.recipient_set_id, setId),
      ),
    );
  return row?.n ?? 0;
}

/**
 * Delete one of the caller's recipient sets and return the removed row(s). The
 * DELETE is scoped by AND(id, userId) — a cross-tenant (or absent) id removes ZERO
 * rows and returns an empty array (T-mdt-01 / IDOR). There is deliberately NO
 * delete-by-id-alone path. The caller MUST first consult
 * {@link countCampaignsForRecipientSet} to refuse deleting a list any campaign
 * references (the FK block above), and unlink the stored CSV only on a non-empty
 * result (row-first).
 */
export function deleteRecipientSetForUser(userId: string, id: number) {
  // DELETE filtered by AND(id, userId) on this line — never delete-by-id alone (owner-filter, AUTH-02 grep gate).
  return db
    .delete(recipient_sets)
    .where(and(eq(recipient_sets.id, id), eq(recipient_sets.userId, userId)))
    .returning();
}
