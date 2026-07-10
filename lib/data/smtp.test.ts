/**
 * Cross-tenant isolation tests for the SMTP DAL (AUTH-02 / T-2-IDOR).
 *
 * These prove the tenancy invariant structurally: User A can never read User B's
 * config, and an upsert performed as User A never mutates User B's row.
 *
 * Pattern (mirrors lib/crypto/crypto.test.ts): set a temp `DATABASE_PATH` and a
 * deterministic `CREDENTIAL_ENC_KEY` BEFORE dynamically importing anything that
 * transitively opens the DB (lib/db/client.ts resolves DATABASE_PATH at module
 * load), then build the schema on that throwaway file via the committed
 * migrations.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Provision an isolated temp DB + encryption key BEFORE any DB import ------
const TMP_DIR = mkdtempSync(join(tmpdir(), "smtp-dal-"));
process.env.DATABASE_PATH = join(TMP_DIR, "app.db");
// 32-byte key so encrypt() works for seeding the encrypted password triple.
process.env.CREDENTIAL_ENC_KEY = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
).toString("base64");

// Dynamic imports so the env vars above are in effect at module-eval time.
const { db, connection } = await import("@/lib/db");
const {
  getSmtpConfigForUser,
  upsertSmtpConfig,
  updateFromFields,
  toSmtpConfigDto,
} = await import("./smtp");
const { encrypt } = await import("@/lib/crypto");
const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");

const USER_A = "user_aaaaaaaaaaaaaaaaaaaaaa";
const USER_B = "user_bbbbbbbbbbbbbbbbbbbbbb";

/** Build a PersistableConfig with an encrypted marker password for `host`. */
function persistable(host: string, password: string) {
  const { enc, iv, tag } = encrypt(password);
  return {
    host,
    port: 587,
    secure: false,
    username: `${host}-user`,
    password_enc: enc,
    password_iv: iv,
    password_tag: tag,
    from_addr: `noreply@${host}`,
    from_name: host,
  };
}

before(async () => {
  // Build all six tables (and indexes) on the temp DB from committed migrations.
  migrate(db, { migrationsFolder: "./drizzle" });
  // The single-row-per-user UNIQUE index is what makes onConflictDoUpdate(target
  // userId) a valid conflict target. It is authored as a committed migration in
  // this same plan (Task 2); ensure it idempotently so this test is order- and
  // migration-generation-independent.
  connection
    .prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS smtp_configs_user_uq ON smtp_configs(user_id)",
    )
    .run();

  await upsertSmtpConfig(USER_A, persistable("host-a.example", "A-secret"));
  await upsertSmtpConfig(USER_B, persistable("host-b.example", "B-secret"));
});

after(() => {
  connection.close();
  rmSync(TMP_DIR, { recursive: true, force: true });
});

test("getSmtpConfigForUser returns only the caller's own row", async () => {
  const a = await getSmtpConfigForUser(USER_A);
  const b = await getSmtpConfigForUser(USER_B);
  assert.ok(a, "User A should have a config");
  assert.ok(b, "User B should have a config");
  assert.equal(a.host, "host-a.example");
  assert.equal(b.host, "host-b.example");
  // Structural isolation: A's row is never B's row.
  assert.notEqual(a.userId, b.userId);
});

test("a user with no config gets undefined, never another tenant's row", async () => {
  const none = await getSmtpConfigForUser("user_nonexistent_zzzzzzzzzz");
  assert.equal(none, undefined);
});

test("upsert as User A leaves User B's row completely unchanged", async () => {
  const before = await getSmtpConfigForUser(USER_B);
  assert.ok(before);

  // Mutate A repeatedly with new values.
  await upsertSmtpConfig(USER_A, persistable("host-a2.example", "A-rotated"));

  const a = await getSmtpConfigForUser(USER_A);
  const after = await getSmtpConfigForUser(USER_B);
  assert.ok(a);
  assert.ok(after);

  // A changed...
  assert.equal(a.host, "host-a2.example");
  // ...B did not: same row id, same host, same encrypted password bytes.
  assert.equal(after.id, before.id);
  assert.equal(after.host, before.host);
  assert.deepEqual(
    Buffer.from(after.password_enc as Uint8Array),
    Buffer.from(before.password_enc as Uint8Array),
  );
});

test("upsert is single-row-per-user (no duplicate row created)", async () => {
  const rows = connection
    .prepare("SELECT COUNT(*) AS n FROM smtp_configs WHERE user_id = ?")
    .get(USER_A) as { n: number };
  assert.equal(rows.n, 1, "exactly one row per user");
});

test("updateFromFields updates only from_* and never touches verified_at", async () => {
  const before = await getSmtpConfigForUser(USER_A);
  assert.ok(before);
  const priorVerifiedAt = before.verified_at;
  const priorHost = before.host;

  await updateFromFields(USER_A, {
    from_addr: "changed@host-a2.example",
    from_name: "Changed Name",
  });

  const after = await getSmtpConfigForUser(USER_A);
  assert.ok(after);
  assert.equal(after.from_addr, "changed@host-a2.example");
  assert.equal(after.from_name, "Changed Name");
  // verified_at is untouched (D-08) and connection fields are unchanged.
  assert.equal(after.verified_at, priorVerifiedAt);
  assert.equal(after.host, priorHost);
});

test("updateFromFields for User A does not affect User B", async () => {
  const before = await getSmtpConfigForUser(USER_B);
  assert.ok(before);
  await updateFromFields(USER_A, {
    from_addr: "again@host-a2.example",
    from_name: "Again",
  });
  const after = await getSmtpConfigForUser(USER_B);
  assert.ok(after);
  assert.equal(after.from_addr, before.from_addr);
  assert.equal(after.from_name, before.from_name);
});

test("toSmtpConfigDto exposes no password material for a real stored row", async () => {
  const row = await getSmtpConfigForUser(USER_B);
  assert.ok(row);
  const dto = toSmtpConfigDto(row);
  const keys = Object.keys(dto);
  assert.ok(!keys.some((k) => k.startsWith("password")));
  assert.ok(!JSON.stringify(dto).includes("B-secret"));
});
