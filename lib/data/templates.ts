/**
 * userId-scoped templates data-access layer (EDIT-04 / AUTH-02).
 *
 * A verbatim-shape sibling of lib/data/recipients.ts against the already-existing
 * `templates` table — the tenancy backbone of the compose/save-template phase:
 *
 *  - AUTH-02 (multi-tenant isolation): EVERY function here takes `userId` as its
 *    required FIRST parameter and filters on it. There is deliberately NO query
 *    path that fetches a template by id without an owner filter —
 *    `getTemplateForUser` uses `and(eq(id), eq(userId))`, never `eq(id)` alone.
 *    That structural rule is what prevents the IDOR threat (T-4-IDOR-TPL): User A
 *    can never read User B's template.
 *
 *  - Server-set ownership (T-4-TAMPER-OWNER): `createTemplate` types its `values`
 *    param as a `Pick<>` that OMITS `userId`, then spreads `{ ...values, userId }` — userId LAST — 
 *    so ownership is injected by the server and can never be spoofed through the
 *    caller's values object.
 *
 * This module imports the shared `db` from `@/lib/db` (the SOLE SQLite opener,
 * D-04); it never constructs a Database.
 */

import { and, eq, desc, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { campaigns, templates, type NewTemplate } from "@/lib/db/schema";

/**
 * The persistable fields for a template insert. `userId` is deliberately absent —
 * it is server-injected inside `createTemplate`, never supplied by the caller.
 * Derived from the insert model so the columns stay in lockstep with the schema.
 * `recipient_set_id` is OPTIONAL (nullable additive column): a save from compose
 * with a list selected stamps it, while a legacy/unscoped save leaves it null.
 */
export type PersistableTemplate = Pick<
  NewTemplate,
  "subject" | "body" | "recipient_set_id"
>;

/**
 * Insert a template owned by `userId` and return the created row (with its
 * generated id). `userId` is spread in LAST server-side; the `values` type cannot carry
 * it, so a caller cannot spoof ownership (T-4-TAMPER-OWNER).
 */
export function createTemplate(userId: string, values: PersistableTemplate) {
  return db
    .insert(templates)
    .values({ ...values, userId })
    .returning();
}

/**
 * List the caller's templates, newest first. Scoped to `userId` — the only lookup
 * path, so User B's templates can never surface in User A's list (AUTH-02).
 */
export function listTemplatesForUser(userId: string) {
  // findMany scoped to userId on this line (owner-filter, AUTH-02 grep gate).
  return db.query.templates.findMany({ where: eq(templates.userId, userId), orderBy: desc(templates.created_at) });
}

/**
 * Fetch a single template by id, but ONLY if it belongs to `userId`. The
 * `and(eq(id), eq(userId))` filter is the structural IDOR defense — there is no
 * fetch-by-id-alone path, so an id owned by another tenant returns undefined
 * (T-4-IDOR-TPL / AUTH-02).
 */
export function getTemplateForUser(userId: string, id: number) {
  // findFirst filtered by AND(id, userId) on this line — never fetch-by-id alone.
  return db.query.templates.findFirst({ where: and(eq(templates.id, id), eq(templates.userId, userId)) });
}

/**
 * List the caller's templates SCOPED to one recipient list, newest first (tpl).
 * The `and(eq(userId), eq(recipient_set_id, setId))` filter is BOTH the owner scope
 * (AUTH-02: User B never sees User A's list) AND the structural D1 rule — a NULL
 * `recipient_set_id` can never equal `setId`, so legacy/unscoped rows are excluded
 * from every list's library. This is the ONLY list-library read path.
 */
export function listTemplatesForRecipientSet(userId: string, setId: number) {
  // findMany filtered by AND(userId, recipient_set_id) — owner + list scope (AUTH-02 grep gate).
  return db.query.templates.findMany({
    where: and(eq(templates.userId, userId), eq(templates.recipient_set_id, setId)),
    orderBy: desc(templates.created_at),
  });
}

/**
 * Count the caller's campaigns that reference a template, across ALL statuses —
 * the delete-guard for a template (D2). Mirrors countCampaignsForRecipientSet:
 * `campaigns.template_id` is NOT NULL with no cascade and PRAGMA foreign_keys=ON,
 * so a referenced template physically cannot be deleted; blocking (in_use) is the
 * only history-preserving option (send_records keep their merged snapshots). Owner
 * scoped: a cross-tenant template counts zero (AUTH-02).
 */
export async function countCampaignsForTemplate(
  userId: string,
  templateId: number,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(campaigns)
    .where(
      and(eq(campaigns.userId, userId), eq(campaigns.template_id, templateId)),
    );
  return row?.n ?? 0;
}

/**
 * Delete one of the caller's templates and return the removed row(s). The DELETE
 * is scoped by AND(id, userId) — a cross-tenant (or absent) id removes ZERO rows
 * and returns an empty array (T-tpl-IDOR-2). There is deliberately NO
 * delete-by-id-alone path. The caller MUST first consult
 * {@link countCampaignsForTemplate} to refuse deleting a template any campaign
 * references (the FK block above, D2).
 */
export function deleteTemplateForUser(userId: string, id: number) {
  // DELETE filtered by AND(id, userId) on this line — never delete-by-id alone (owner-filter, AUTH-02 grep gate).
  return db
    .delete(templates)
    .where(and(eq(templates.id, id), eq(templates.userId, userId)))
    .returning();
}
