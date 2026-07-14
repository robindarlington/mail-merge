/**
 * userId-scoped, id-addressed SMTP-config data-access layer (AUTH-02 / SMTP-04 /
 * 06.1 multi-server).
 *
 * This is the tenancy + secrecy backbone of the multi-SMTP model. As of 06.1 a
 * user may hold MANY named configs, so every by-id path is owner-re-resolved:
 *
 *  - AUTH-02 / IDOR (T-061-01): the ONLY by-id lookup is
 *    `getSmtpConfigByIdForUser`, which filters `and(eq(id), eq(userId),
 *    isNull(deleted_at))`. There is deliberately NO `eq(id)`-alone query path, so
 *    a client-supplied `smtp_config_id` can never cross tenants and a soft-deleted
 *    row is invisible to reads.
 *
 *  - SMTP-04 (credentials never leave the server): `toSmtpConfigDto` is the ONLY
 *    shape permitted to cross the server→client boundary. It EXPLICITLY enumerates
 *    the safe fields; it structurally cannot reference `password_enc/_iv/_tag`, so
 *    the encrypted triple cannot leak by omission (T-061-02).
 *
 *  - One-default-per-user (T-061-04): `setDefaultSmtpConfig` clears every default
 *    for the user then sets the target in a single transaction; the partial unique
 *    index `smtp_configs_user_default_uq` is the structural backstop.
 *
 *  - Soft-delete: `softDeleteSmtpConfig` stamps `deleted_at` and clears
 *    `is_default`, so the row disappears from list/by-id reads but survives for
 *    campaign history. `countActiveSendsForConfig` is the in-use guard the action
 *    layer consults before deleting.
 *
 * The password is persisted ONLY as the AES-256-GCM triple produced by
 * lib/crypto `encrypt()` — no plaintext password column exists (T-2-CRYPTO).
 *
 * This module imports the shared `db` from `@/lib/db` (the SOLE SQLite opener,
 * D-04); it never constructs a Database.
 */

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  smtp_configs,
  campaigns,
  type SmtpConfig,
  type NewSmtpConfig,
} from "@/lib/db/schema";

/**
 * The persistable connection fields for a create/update. The password is supplied
 * ONLY as the encrypted triple (password_enc/_iv/_tag) — there is no plaintext
 * field. `label` is the user-facing name for the server. Derived from the insert
 * model so the columns stay in lockstep with the schema.
 */
export type PersistableConfig = Pick<
  NewSmtpConfig,
  | "label"
  | "host"
  | "port"
  | "secure"
  | "username"
  | "password_enc"
  | "password_iv"
  | "password_tag"
  | "from_addr"
  | "from_name"
>;

/**
 * The ONLY shape that may cross to the client. Explicit — the encrypted triple
 * is absent by construction, not by filtering. Mirrors `toSmtpConfigDto`.
 */
export type SmtpConfigDto = {
  id: number;
  label: string | null;
  is_default: boolean;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  from_addr: string;
  from_name: string | null;
  verified_at: number | null;
};

/**
 * Fetch a single SMTP config by id, but ONLY if it belongs to `userId` and is not
 * soft-deleted. The `and(eq(id), eq(userId), isNull(deleted_at))` filter is the
 * structural IDOR defense (T-061-01) — this is the sole by-id path, so an id owned
 * by another tenant, or a deleted row, resolves to undefined.
 */
export function getSmtpConfigByIdForUser(
  userId: string,
  id: number,
): Promise<SmtpConfig | undefined> {
  // findFirst filtered by AND(id, userId, not-deleted) — never fetch-by-id alone.
  return db.query.smtp_configs.findFirst({
    where: and(
      eq(smtp_configs.id, id),
      eq(smtp_configs.userId, userId),
      isNull(smtp_configs.deleted_at),
    ),
  });
}

/**
 * List the caller's non-deleted SMTP configs, default row first then oldest→newest
 * (CONTEXT ordering). Scoped to `userId`, so User B's configs can never surface in
 * User A's list (AUTH-02).
 */
export function listSmtpConfigsForUser(
  userId: string,
): Promise<SmtpConfig[]> {
  // findMany scoped to userId + not-deleted (owner-filter, AUTH-02 grep gate).
  return db.query.smtp_configs.findMany({
    where: and(
      eq(smtp_configs.userId, userId),
      isNull(smtp_configs.deleted_at),
    ),
    orderBy: [desc(smtp_configs.is_default), smtp_configs.created_at],
  });
}

/**
 * Insert a new SMTP config owned by `userId` and return the created row. `userId`
 * is spread in LAST server-side; `PersistableConfig` cannot carry it, so a caller
 * cannot spoof ownership. `verified_at` is stamped because this path is only
 * reached after a successful `transport.verify()`. Multiple configs per user are
 * allowed — `is_default` is opt-in and defaults to false.
 */
export function createSmtpConfig(
  userId: string,
  values: PersistableConfig & { is_default?: boolean },
) {
  return db
    .insert(smtp_configs)
    .values({ ...values, userId, verified_at: sql`(unixepoch())` }) // userId LAST
    .returning();
}

/**
 * Update the connection fields of one owned, non-deleted config. Re-stamps
 * `verified_at` (this path runs only after a fresh `transport.verify()`). The
 * `and(eq(id), eq(userId), isNull(deleted_at))` WHERE is the IDOR defense; the
 * returned `{ id }[]` length is the "did I own+update it?" signal.
 */
export function updateSmtpConfigById(
  userId: string,
  id: number,
  values: PersistableConfig,
) {
  return db
    .update(smtp_configs)
    .set({ ...values, verified_at: sql`(unixepoch())` })
    .where(
      and(
        eq(smtp_configs.id, id),
        eq(smtp_configs.userId, userId),
        isNull(smtp_configs.deleted_at),
      ),
    )
    .returning({ id: smtp_configs.id });
}

/**
 * Update ONLY the sender-identity fields (from_addr / from_name) for the caller.
 * Deliberately does NOT touch `verified_at`: changing the display name/address
 * does not invalidate a proven connection (D-08 / Pitfall 6). Scoped to `userId`.
 */
export function updateFromFields(
  userId: string,
  values: { from_addr: string; from_name: string | null },
) {
  return db
    .update(smtp_configs)
    .set({ from_addr: values.from_addr, from_name: values.from_name })
    .where(eq(smtp_configs.userId, userId));
}

/**
 * Make one owned, non-deleted config the user's default, atomically. Inside a
 * single transaction: clear `is_default` on every row for the user, then set it on
 * the target. Doing the clear FIRST keeps the partial unique index
 * `smtp_configs_user_default_uq` satisfied at commit. The returned `{ id }[]`
 * length is the did-I-win signal — 0 for a cross-tenant / deleted / missing id
 * (nothing changes, because the target update matched no row) (T-061-04).
 */
export function setDefaultSmtpConfig(userId: string, id: number) {
  return db.transaction((tx) => {
    tx.update(smtp_configs)
      .set({ is_default: false })
      .where(eq(smtp_configs.userId, userId))
      .run();
    return tx
      .update(smtp_configs)
      .set({ is_default: true })
      .where(
        and(
          eq(smtp_configs.id, id),
          eq(smtp_configs.userId, userId),
          isNull(smtp_configs.deleted_at),
        ),
      )
      .returning({ id: smtp_configs.id })
      .all();
  });
}

/**
 * Soft-delete one owned, non-deleted config: stamp `deleted_at` and clear
 * `is_default` (a deleted row can never be the default). The row then vanishes from
 * `listSmtpConfigsForUser` / `getSmtpConfigByIdForUser` but SURVIVES for campaign
 * history. The returned `{ id }[]` length is the did-I-win signal. Callers should
 * first consult `countActiveSendsForConfig` to refuse deleting an in-use config.
 */
export function softDeleteSmtpConfig(userId: string, id: number) {
  return db
    .update(smtp_configs)
    .set({ deleted_at: sql`(unixepoch())`, is_default: false })
    .where(
      and(
        eq(smtp_configs.id, id),
        eq(smtp_configs.userId, userId),
        isNull(smtp_configs.deleted_at),
      ),
    )
    .returning({ id: smtp_configs.id });
}

/**
 * Count the caller's campaigns that are actively using this config (status queued
 * or running). The action layer calls this BEFORE `softDeleteSmtpConfig` and
 * refuses the delete when the count is non-zero — a config mid-send must not be
 * yanked out from under the worker. Scoped to `userId` so the guard is itself
 * tenant-safe.
 */
export function countActiveSendsForConfig(
  userId: string,
  id: number,
): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.smtp_config_id, id),
        eq(campaigns.userId, userId),
        inArray(campaigns.status, ["queued", "running"]),
      ),
    )
    .get();
  return row?.n ?? 0;
}

/**
 * Project a stored row down to the client-safe DTO. This is the single
 * server→client redaction boundary (SMTP-04 / T-061-02): it enumerates safe
 * fields explicitly and CANNOT reference the encrypted password triple, so the
 * password can never leak to the wire or a JSON response.
 */
export function toSmtpConfigDto(row: SmtpConfig): SmtpConfigDto {
  return {
    id: row.id,
    label: row.label,
    is_default: row.is_default,
    host: row.host,
    port: row.port,
    secure: row.secure,
    username: row.username,
    from_addr: row.from_addr,
    from_name: row.from_name,
    verified_at: row.verified_at,
  };
}
