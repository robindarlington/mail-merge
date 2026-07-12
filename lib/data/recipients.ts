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
 *    `{ userId, ...values }` so ownership is injected by the server and can never
 *    be spoofed through the caller's values object.
 *
 * This module imports the shared `db` from `@/lib/db` (the SOLE SQLite opener,
 * D-04); it never constructs a Database.
 */

import { and, eq, desc } from "drizzle-orm";

import { db } from "@/lib/db";
import { recipient_sets, type NewRecipientSet } from "@/lib/db/schema";

/**
 * The persistable fields for a recipient-set insert. `userId` is deliberately
 * absent — it is server-injected inside `createRecipientSet`, never supplied by
 * the caller. Derived from the insert model so the columns stay in lockstep with
 * the schema.
 */
export type PersistableRecipientSet = Pick<
  NewRecipientSet,
  "filename" | "columns_json" | "row_count" | "storage_path"
>;

/**
 * Insert a recipient set owned by `userId` and return the created row (with its
 * generated id). `userId` is spread in server-side; the `values` type cannot
 * carry it, so a caller cannot spoof ownership (T-3-TAMPER-OWNER).
 */
export function createRecipientSet(
  userId: string,
  values: PersistableRecipientSet,
) {
  return db
    .insert(recipient_sets)
    .values({ userId, ...values })
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
