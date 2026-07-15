/**
 * Behavioral + cross-tenant isolation tests for the id-scoped SMTP DAL
 * (AUTH-02 / T-061-01 IDOR, T-061-02 DTO redaction, T-061-04 one-default,
 * 06.1 multi-server + soft-delete).
 *
 * These prove the tenancy + safety invariants structurally: a config is fetchable
 * ONLY when owner-scoped and not soft-deleted, multiple configs per user coexist,
 * exactly one default per user survives a setDefault, a soft-deleted row vanishes
 * from reads while its row persists, and the DTO never carries the ciphertext.
 *
 * Pattern (mirrors lib/crypto/crypto.test.ts): set a temp `DATABASE_PATH` and a
 * deterministic `CREDENTIAL_ENC_KEY` BEFORE dynamically importing anything that
 * transitively opens the DB (lib/db/client.ts resolves DATABASE_PATH at module
 * load), then build the schema on that throwaway file via the committed
 * migrations (0000–0004, which now yield the new columns + partial unique index).
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
  listSmtpConfigsForUser,
  getSmtpConfigByIdForUser,
  createSmtpConfig,
  updateSmtpConfigById,
  setDefaultSmtpConfig,
  softDeleteSmtpConfig,
  countActiveSendsForConfig,
  updateSmtpConfigMeta,
  toSmtpConfigDto,
} = await import("./smtp");
const { encrypt } = await import("@/lib/crypto");
const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");

const USER_A = "user_aaaaaaaaaaaaaaaaaaaaaa";
const USER_B = "user_bbbbbbbbbbbbbbbbbbbbbb";

/** Build a PersistableConfig with an encrypted marker password for `host`. */
function persistable(host: string, password: string, label = host) {
  const { enc, iv, tag } = encrypt(password);
  return {
    label,
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

before(() => {
  // Build all six tables (and indexes) on the temp DB from committed migrations.
  // The 0003/0004 migrations supply label/is_default/deleted_at + the partial
  // one-default-per-user unique index — no manual index creation needed.
  migrate(db, { migrationsFolder: "./drizzle" });
});

after(() => {
  connection.close();
  rmSync(TMP_DIR, { recursive: true, force: true });
});

test("createSmtpConfig sets userId server-side, stamps verified_at, and allows multiple rows", async () => {
  const [first] = await createSmtpConfig(USER_A, persistable("host-a.example", "A-secret", "Primary"));
  assert.equal(first.userId, USER_A);
  assert.equal(first.label, "Primary");
  assert.ok(first.verified_at, "verified_at should be stamped on create");
  assert.equal(first.is_default, false, "is_default defaults to false");

  // A SECOND config for the SAME user succeeds — multi-row model.
  const [second] = await createSmtpConfig(USER_A, persistable("host-a2.example", "A2-secret", "Secondary"));
  assert.notEqual(second.id, first.id);

  const list = await listSmtpConfigsForUser(USER_A);
  assert.equal(list.length, 2, "both configs belong to USER_A");
});

test("getSmtpConfigByIdForUser refuses a cross-tenant id (IDOR → undefined)", async () => {
  const [bRow] = await createSmtpConfig(USER_B, persistable("host-b.example", "B-secret", "B-Primary"));

  // User A asking for User B's id gets nothing back.
  const stolen = await getSmtpConfigByIdForUser(USER_A, bRow.id);
  assert.equal(stolen, undefined);

  // The owner still resolves their own row.
  const own = await getSmtpConfigByIdForUser(USER_B, bRow.id);
  assert.ok(own);
  assert.equal(own.host, "host-b.example");
});

test("listSmtpConfigsForUser returns default row first, only for the owner", async () => {
  const list = await listSmtpConfigsForUser(USER_A);
  // Make the second config the default, then re-list.
  await setDefaultSmtpConfig(USER_A, list[1].id);
  const ordered = await listSmtpConfigsForUser(USER_A);
  assert.equal(ordered[0].id, list[1].id, "default row sorts first");
  assert.ok(ordered[0].is_default, "first row is the default");
  assert.ok(!ordered[1].is_default, "non-default row follows");
  // No USER_B rows leak into USER_A's list.
  assert.ok(ordered.every((r) => r.userId === USER_A));
});

test("setDefaultSmtpConfig keeps exactly one default and is a no-op cross-tenant", async () => {
  const list = await listSmtpConfigsForUser(USER_A);
  // Flip the default to the OTHER row.
  const target = list.find((r) => !r.is_default)!;
  const won = await setDefaultSmtpConfig(USER_A, target.id);
  assert.equal(won.length, 1, "setDefault reports the winning row");

  const after = await listSmtpConfigsForUser(USER_A);
  const defaults = after.filter((r) => r.is_default);
  assert.equal(defaults.length, 1, "exactly one default per user");
  assert.equal(defaults[0].id, target.id);

  // Cross-tenant setDefault changes nothing and returns length 0.
  const bList = await listSmtpConfigsForUser(USER_B);
  const noop = await setDefaultSmtpConfig(USER_A, bList[0].id);
  assert.equal(noop.length, 0, "cross-tenant setDefault is a no-op");
  const bAfter = await getSmtpConfigByIdForUser(USER_B, bList[0].id);
  assert.equal(bAfter!.is_default, bList[0].is_default, "USER_B row untouched");

  // CR-01: a failed set-default (bogus/cross-tenant id) MUST roll back the
  // clear-all-defaults step — the caller's ORIGINAL default must survive.
  const before = await listSmtpConfigsForUser(USER_A);
  const priorDefault = before.find((r) => r.is_default);
  assert.ok(priorDefault, "USER_A has a default going into the failed call");
  // (a) cross-tenant id and (b) a definitely-nonexistent id both no-op.
  assert.equal((await setDefaultSmtpConfig(USER_A, bList[0].id)).length, 0);
  assert.equal((await setDefaultSmtpConfig(USER_A, 9_999_999)).length, 0);
  const afterFailed = await listSmtpConfigsForUser(USER_A);
  const stillDefault = afterFailed.filter((r) => r.is_default);
  assert.equal(stillDefault.length, 1, "USER_A still has exactly one default");
  assert.equal(
    stillDefault[0].id,
    priorDefault.id,
    "USER_A's ORIGINAL default row is intact after the failed set-default (CR-01)",
  );
});

test("updateSmtpConfigById updates only the owner's row and re-stamps verified_at", async () => {
  const list = await listSmtpConfigsForUser(USER_A);
  const row = list[0];
  const won = await updateSmtpConfigById(USER_A, row.id, persistable("host-a-updated.example", "rotated", "Renamed"));
  assert.equal(won.length, 1);
  const reread = await getSmtpConfigByIdForUser(USER_A, row.id);
  assert.equal(reread!.host, "host-a-updated.example");
  assert.equal(reread!.label, "Renamed");

  // Cross-tenant update is refused (length 0).
  const bList = await listSmtpConfigsForUser(USER_B);
  const refused = await updateSmtpConfigById(USER_A, bList[0].id, persistable("hax.example", "hax", "hax"));
  assert.equal(refused.length, 0);
});

test("softDeleteSmtpConfig hides the row from reads but preserves it for history", async () => {
  const [victim] = await createSmtpConfig(USER_A, persistable("host-a-del.example", "del-secret", "Disposable"));
  const won = await softDeleteSmtpConfig(USER_A, victim.id);
  assert.equal(won.length, 1);

  // Invisible to owner-scoped reads.
  assert.equal(await getSmtpConfigByIdForUser(USER_A, victim.id), undefined);
  const list = await listSmtpConfigsForUser(USER_A);
  assert.ok(!list.some((r) => r.id === victim.id), "deleted row absent from list");

  // But the row SURVIVES on disk (history) with deleted_at set and is_default cleared.
  const raw = connection
    .prepare("SELECT deleted_at, is_default FROM smtp_configs WHERE id = ?")
    .get(victim.id) as { deleted_at: number | null; is_default: number };
  assert.ok(raw.deleted_at, "deleted_at stamped, row persists");
  assert.equal(raw.is_default, 0, "is_default cleared on soft-delete");

  // A second soft-delete of the same id is a no-op (already deleted).
  const again = await softDeleteSmtpConfig(USER_A, victim.id);
  assert.equal(again.length, 0);
});

test("countActiveSendsForConfig counts only the owner's queued/running campaigns", async () => {
  const [cfg] = await createSmtpConfig(USER_A, persistable("host-a-inuse.example", "inuse", "InUse"));

  // Seed the FK prerequisites (recipient_set + template) for a campaign.
  const rsId = (
    connection
      .prepare(
        "INSERT INTO recipient_sets (user_id, filename, columns_json, row_count, storage_path) VALUES (?, ?, ?, ?, ?) RETURNING id",
      )
      .get(USER_A, "r.csv", "[]", 1, "/tmp/r.csv") as { id: number }
  ).id;
  const tplId = (
    connection
      .prepare(
        "INSERT INTO templates (user_id, subject, body) VALUES (?, ?, ?) RETURNING id",
      )
      .get(USER_A, "Subj", "Body") as { id: number }
  ).id;

  const insertCampaign = (status: string) =>
    connection
      .prepare(
        "INSERT INTO campaigns (user_id, recipient_set_id, template_id, smtp_config_id, status) VALUES (?, ?, ?, ?, ?)",
      )
      .run(USER_A, rsId, tplId, cfg.id, status);

  // No campaigns yet → zero.
  assert.equal(countActiveSendsForConfig(USER_A, cfg.id), 0);

  insertCampaign("queued");
  insertCampaign("running");
  insertCampaign("completed"); // terminal — must NOT be counted
  insertCampaign("draft"); // not yet enqueued — must NOT be counted

  assert.equal(countActiveSendsForConfig(USER_A, cfg.id), 2, "only queued+running count");
  // Cross-tenant caller sees none of USER_A's active sends.
  assert.equal(countActiveSendsForConfig(USER_B, cfg.id), 0);
});

test("updateSmtpConfigMeta updates label + from_* on ONE owned row, never touching verified_at", async () => {
  const list = await listSmtpConfigsForUser(USER_A);
  const before = list[0];
  const priorVerifiedAt = before.verified_at;

  const updated = await updateSmtpConfigMeta(USER_A, before.id, {
    label: "Changed Label",
    from_addr: "changed@example.com",
    from_name: "Changed Name",
  });
  assert.equal(updated.length, 1, "the owned row is updated");

  const after = await getSmtpConfigByIdForUser(USER_A, before.id);
  assert.ok(after);
  assert.equal(after.label, "Changed Label");
  assert.equal(after.from_addr, "changed@example.com");
  assert.equal(after.from_name, "Changed Name");
  assert.equal(after.verified_at, priorVerifiedAt, "verified_at untouched (D-08)");
});

test("updateSmtpConfigMeta is id-scoped: a cross-tenant id updates ZERO rows (IDOR)", async () => {
  const [ownedByB] = await listSmtpConfigsForUser(USER_B);
  assert.ok(ownedByB);
  const priorAddr = ownedByB.from_addr;

  // USER_A attempts to edit USER_B's row by id — the AND(id, userId) filter matches
  // nothing, so nothing is updated and B's row is untouched.
  const updated = await updateSmtpConfigMeta(USER_A, ownedByB.id, {
    label: "Hijacked",
    from_addr: "intruder@example.com",
    from_name: "Intruder",
  });
  assert.equal(updated.length, 0, "no cross-tenant row is updated");

  const after = await getSmtpConfigByIdForUser(USER_B, ownedByB.id);
  assert.ok(after);
  assert.equal(after.from_addr, priorAddr, "B's sender identity is untouched");
});

test("toSmtpConfigDto carries id/label/is_default and never the encrypted triple", async () => {
  const list = await listSmtpConfigsForUser(USER_B);
  const row = list[0];
  const dto = toSmtpConfigDto(row);
  const keys = Object.keys(dto);
  assert.ok(keys.includes("id"));
  assert.ok(keys.includes("label"));
  assert.ok(keys.includes("is_default"));
  assert.ok(!keys.some((k) => k.startsWith("password")), "no password material");
  assert.ok(!JSON.stringify(dto).includes("B-secret"));
});
