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
 *    param as a `Pick<>` that OMITS `userId`, then spreads `{ userId, ...values }`
 *    so ownership is injected by the server and can never be spoofed through the
 *    caller's values object.
 *
 * This module imports the shared `db` from `@/lib/db` (the SOLE SQLite opener,
 * D-04); it never constructs a Database.
 */

import { and, eq, desc } from "drizzle-orm";

import { db } from "@/lib/db";
import { templates, type NewTemplate } from "@/lib/db/schema";

/**
 * The persistable fields for a template insert. `userId` is deliberately absent —
 * it is server-injected inside `createTemplate`, never supplied by the caller.
 * Derived from the insert model so the columns stay in lockstep with the schema.
 */
export type PersistableTemplate = Pick<NewTemplate, "subject" | "body">;

/**
 * Insert a template owned by `userId` and return the created row (with its
 * generated id). `userId` is spread in server-side; the `values` type cannot carry
 * it, so a caller cannot spoof ownership (T-4-TAMPER-OWNER).
 */
export function createTemplate(userId: string, values: PersistableTemplate) {
  return db
    .insert(templates)
    .values({ userId, ...values })
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
