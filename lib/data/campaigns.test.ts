/**
 * Cross-tenant isolation + atomic-enqueue tests for the campaigns DAL
 * (TEST-03 / AUTH-02 / T-5-IDOR / T-5-DUPE / T-5-TAMPER-OWNER).
 *
 * These prove the Phase-5 durability seam structurally, WITHOUT a live SMTP dial
 * or a Clerk request context:
 *
 *  - Ownership on write is server-injected: a smuggled `userId` in the values
 *    object can never win (userId spread LAST — the a906a8f ownership-wins fix).
 *  - `getCampaignForUser` has no fetch-by-id-alone path, so an id owned by User A
 *    returns undefined when queried as User B (the IDOR assertion).
 *  - `enqueueCampaign` is the TEST-03 idempotency primitive: a single-statement
 *    `UPDATE ... WHERE status='draft'` flips draft→queued exactly once; a second
 *    call on an already-queued row is a 0-row no-op (the double-submit guard), and
 *    a cross-tenant caller is refused (0 rows, status unchanged).
 *
 * Pattern (mirrors lib/data/templates.test.ts + lib/smtp/actions.test.ts): set a
 * temp `DATABASE_PATH` and a deterministic `CREDENTIAL_ENC_KEY` BEFORE dynamically
 * importing anything that transitively opens the DB or the crypto key, then build
 * the schema on that throwaway file via the committed migrations. The seeded SMTP
 * password exists ONLY as the encrypted triple — it is never logged.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Provision an isolated temp DB + encryption key BEFORE any DB import ------
const TMP_DIR = mkdtempSync(join(tmpdir(), "campaigns-dal-"));
process.env.DATABASE_PATH = join(TMP_DIR, "app.db");
process.env.CREDENTIAL_ENC_KEY = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
).toString("base64");

// Dynamic imports so the env vars above are in effect at module-eval time.
const { db, connection } = await import("@/lib/db");
const { createDraftCampaign, getCampaignForUser, enqueueCampaign } =
  await import("./campaigns");
const { createRecipientSet } = await import("./recipients");
const { createTemplate } = await import("./templates");
const { upsertSmtpConfig, getSmtpConfigForUser } = await import("./smtp");
const { encrypt } = await import("../crypto");
const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");

const USER_A = "user_aaaaaaaaaaaaaaaaaaaaaa";
const USER_B = "user_bbbbbbbbbbbbbbbbbbbbbb";

// A distinctive marker so a redaction check can grep the source for a plaintext leak.
const MARKER_PASSWORD = "MARKER-SECRET-PASSWORD-5f3a";

// FK ids captured during seeding — all three campaign FKs are NOT NULL.
let RECIPIENT_SET_ID = 0;
let TEMPLATE_ID = 0;
let SMTP_CONFIG_ID = 0;

before(async () => {
  // Build all tables (and indexes) on the temp DB from committed migrations.
  migrate(db, { migrationsFolder: "./drizzle" });
  // The single-row-per-user UNIQUE index backs upsertSmtpConfig's conflict target.
  connection
    .prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS smtp_configs_user_uq ON smtp_configs(user_id)",
    )
    .run();

  const [set] = await createRecipientSet(USER_A, {
    filename: "recipients.csv",
    columns_json: JSON.stringify(["email", "name"]),
    row_count: 3,
    storage_path: "/data/uploads/recipients.csv",
    email_column: "email",
  });
  RECIPIENT_SET_ID = set.id;

  const [tpl] = await createTemplate(USER_A, {
    subject: "Hi {{name}}",
    body: "Welcome aboard.",
  });
  TEMPLATE_ID = tpl.id;

  // Seed the SMTP config as encrypted bytes only — the plaintext password never
  // touches the DB and is never logged (SMTP-04 / T-5-LOG).
  const secret = encrypt(MARKER_PASSWORD);
  await upsertSmtpConfig(USER_A, {
    host: "smtp.example.com",
    port: 587,
    secure: false,
    username: "onboarding-user",
    password_enc: secret.enc,
    password_iv: secret.iv,
    password_tag: secret.tag,
    from_addr: "noreply@example.com",
    from_name: "Example Sender",
  });
  const cfg = await getSmtpConfigForUser(USER_A);
  assert.ok(cfg, "seeded SMTP config exists");
  SMTP_CONFIG_ID = cfg.id;
});

after(() => {
  connection.close();
  rmSync(TMP_DIR, { recursive: true, force: true });
});

/** A valid PersistableCampaign referencing the seeded FKs. */
function draftValues() {
  return {
    recipient_set_id: RECIPIENT_SET_ID,
    template_id: TEMPLATE_ID,
    smtp_config_id: SMTP_CONFIG_ID,
  };
}

test("createDraftCampaign persists the server-supplied userId with status draft", async () => {
  const [row] = await createDraftCampaign(USER_A, draftValues());
  assert.ok(row.id, "returned row carries a generated id");
  assert.equal(row.userId, USER_A, "userId is the server-supplied caller id");
  assert.equal(row.status, "draft", "a new campaign starts as a draft");
  assert.equal(row.recipient_set_id, RECIPIENT_SET_ID);
  assert.equal(row.template_id, TEMPLATE_ID);
  assert.equal(row.smtp_config_id, SMTP_CONFIG_ID);
});

test("createDraftCampaign ignores a smuggled userId in the values object (ownership wins)", async () => {
  // Cast around the Pick<> type to smuggle a userId key at runtime — the server
  // spreads userId LAST, so the smuggled owner must never win (a906a8f).
  const spoofed = { ...draftValues(), userId: USER_B } as ReturnType<
    typeof draftValues
  >;
  const [row] = await createDraftCampaign(USER_A, spoofed);
  assert.equal(
    row.userId,
    USER_A,
    "owner is the function arg, never the smuggled values.userId",
  );
});

test("getCampaignForUser returns the row for its owner but blocks cross-tenant reads (IDOR)", async () => {
  const [created] = await createDraftCampaign(USER_A, draftValues());

  const mine = await getCampaignForUser(USER_A, created.id);
  assert.ok(mine, "owner can read their own campaign");
  assert.equal(mine.id, created.id);
  assert.equal(mine.userId, USER_A);

  const leaked = await getCampaignForUser(USER_B, created.id);
  assert.equal(leaked, undefined, "cross-tenant read returns undefined");
});

test("enqueueCampaign flips draft→queued exactly once and returns one row", async () => {
  const [created] = await createDraftCampaign(USER_A, draftValues());

  const flipped = await enqueueCampaign(USER_A, created.id);
  assert.equal(flipped.length, 1, "the winning transition affects exactly one row");

  const after = await getCampaignForUser(USER_A, created.id);
  assert.ok(after);
  assert.equal(after.status, "queued", "the campaign is now queued");
});

test("enqueueCampaign on an already-queued campaign is a 0-row no-op (TEST-03 double-submit guard)", async () => {
  const [created] = await createDraftCampaign(USER_A, draftValues());

  const first = await enqueueCampaign(USER_A, created.id);
  assert.equal(first.length, 1, "first enqueue wins");

  const second = await enqueueCampaign(USER_A, created.id);
  assert.equal(
    second.length,
    0,
    "a second enqueue on an already-queued row affects zero rows",
  );
});

test("enqueueCampaign refuses a campaign owned by another user (0 rows, status unchanged)", async () => {
  const [created] = await createDraftCampaign(USER_A, draftValues());

  const refused = await enqueueCampaign(USER_B, created.id);
  assert.equal(refused.length, 0, "cross-tenant enqueue affects zero rows");

  const after = await getCampaignForUser(USER_A, created.id);
  assert.ok(after);
  assert.equal(
    after.status,
    "draft",
    "the refused enqueue left the owner's campaign untouched",
  );
});
