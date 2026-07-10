/**
 * userId-scoped SMTP-config data-access layer (AUTH-02 / SMTP-04).
 *
 * This is the tenancy + secrecy backbone of the SMTP-onboarding phase:
 *
 *  - AUTH-02 (multi-tenant isolation): EVERY function here takes `userId` as its
 *    required FIRST parameter and filters on it. There is deliberately NO query
 *    path that fetches a config by id without an owner filter — that structural
 *    rule is what prevents the IDOR threat (T-2-IDOR / PITFALLS #13). User A can
 *    never read or overwrite User B's row.
 *
 *  - SMTP-04 (credentials never leave the server): `toSmtpConfigDto` is the ONLY
 *    shape permitted to cross the server→client boundary. It EXPLICITLY enumerates
 *    the safe fields; it structurally cannot reference `password_enc/_iv/_tag`, so
 *    the encrypted triple cannot leak by omission (T-2-CRED / D-07).
 *
 *  - Single-row-per-user (D-09): `upsertSmtpConfig` uses `onConflictDoUpdate`
 *    targeting the `smtp_configs.userId` UNIQUE index (authored alongside this
 *    plan in schema + migration), making the write race-safe rather than a
 *    read-then-insert race (T-2-DUPE / Pattern 5).
 *
 * The password is persisted ONLY as the AES-256-GCM triple produced by
 * lib/crypto `encrypt()` — no plaintext password column exists (T-2-CRYPTO).
 *
 * This module imports the shared `db` from `@/lib/db` (the SOLE SQLite opener,
 * D-04); it never constructs a Database.
 */

import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  smtp_configs,
  type SmtpConfig,
  type NewSmtpConfig,
} from "@/lib/db/schema";

/**
 * The persistable connection fields for an upsert. The password is supplied ONLY
 * as the encrypted triple (password_enc/_iv/_tag) — there is no plaintext field.
 * Derived from the insert model so the columns stay in lockstep with the schema.
 */
export type PersistableConfig = Pick<
  NewSmtpConfig,
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
  host: string;
  port: number;
  secure: boolean;
  username: string;
  from_addr: string;
  from_name: string | null;
  verified_at: number | null;
};

/**
 * Fetch the caller's single SMTP config, or undefined if they have none.
 * Scoped to `userId` — the only lookup path, so a cross-tenant read is
 * impossible (AUTH-02 / T-2-IDOR).
 */
export function getSmtpConfigForUser(
  userId: string,
): Promise<SmtpConfig | undefined> {
  return db.query.smtp_configs.findFirst({
    where: eq(smtp_configs.userId, userId),
  });
}

/**
 * Insert-or-update the caller's SMTP config (single row per user, D-09).
 * `onConflictDoUpdate` targets the `smtp_configs.userId` UNIQUE index so two
 * concurrent writes for the same user cannot create two rows (T-2-DUPE).
 * Sets `verified_at` on both insert and update — this path is only reached
 * after a successful `transport.verify()` during onboarding.
 */
export function upsertSmtpConfig(userId: string, values: PersistableConfig) {
  return db
    .insert(smtp_configs)
    .values({ userId, ...values, verified_at: sql`(unixepoch())` })
    .onConflictDoUpdate({
      target: smtp_configs.userId,
      set: { ...values, verified_at: sql`(unixepoch())` },
    });
}

/**
 * Update ONLY the sender-identity fields (from_addr / from_name) for the caller.
 * Deliberately does NOT touch `verified_at`: changing the display name/address
 * does not invalidate a proven connection, so re-verification is not required
 * (D-08 / Pitfall 6). Scoped to `userId`.
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
 * Project a stored row down to the client-safe DTO. This is the single
 * server→client redaction boundary (SMTP-04 / T-2-CRED): it enumerates safe
 * fields explicitly and CANNOT reference the encrypted password triple, so the
 * password can never leak to the wire or a JSON response.
 */
export function toSmtpConfigDto(row: SmtpConfig): SmtpConfigDto {
  return {
    host: row.host,
    port: row.port,
    secure: row.secure,
    username: row.username,
    from_addr: row.from_addr,
    from_name: row.from_name,
    verified_at: row.verified_at,
  };
}
