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
import { eq } from "drizzle-orm";

// --- Provision an isolated temp DB + encryption key BEFORE any DB import ------
const TMP_DIR = mkdtempSync(join(tmpdir(), "campaigns-dal-"));
process.env.DATABASE_PATH = join(TMP_DIR, "app.db");
process.env.CREDENTIAL_ENC_KEY = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
).toString("base64");

// Dynamic imports so the env vars above are in effect at module-eval time.
const { db, connection } = await import("@/lib/db");
const { campaigns, send_records, attachments } = await import("@/lib/db/schema");
const {
  createDraftCampaign,
  getCampaignForUser,
  enqueueCampaign,
  deleteCampaignForUser,
  listCampaignsForUser,
  getSendRecordsForCampaign,
  getCampaignProgressRow,
} = await import("./campaigns");
const { createRecipientSet } = await import("./recipients");
const { createTemplate } = await import("./templates");
const { createSmtpConfig } = await import("./smtp");
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
  const [cfg] = await createSmtpConfig(USER_A, {
    label: "Default",
    host: "smtp.example.com",
    port: 587,
    secure: false,
    username: "onboarding-user",
    password_enc: secret.enc,
    password_iv: secret.iv,
    password_tag: secret.tag,
    from_addr: "noreply@example.com",
    from_name: "Example Sender",
    is_default: true,
  });
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

// --- Phase-6 read layer (Plan 03): list / drill-down / progress -------------
//
// The history + live-progress surfaces (Plan 05) and the CSV export route
// (Plan 06) are all VIEWS over the persisted send_records state machine. Every
// read is userId-scoped: a guessed campaign id owned by another tenant must
// yield nothing (T-06-08 / AUTH-02). send_records carry NO userId column —
// their tenancy is inherited through campaign_id, so the ownership guard is
// getCampaignForUser BEFORE any send_records query.

test("listCampaignsForUser returns only the caller's campaigns, newest first, excludes other tenants", async () => {
  const [older] = await createDraftCampaign(USER_A, draftValues());
  const [newer] = await createDraftCampaign(USER_A, draftValues());
  const [bOwned] = await createDraftCampaign(USER_B, draftValues());

  const mine = await listCampaignsForUser(USER_A);
  assert.ok(mine.every((c) => c.userId === USER_A), "every returned row is the caller's");
  const myIds = mine.map((c) => c.id);
  assert.ok(myIds.includes(older.id) && myIds.includes(newer.id), "the caller's campaigns are present");
  assert.ok(!myIds.includes(bOwned.id), "another tenant's campaign is excluded");
  // Newest first: the later-created row (higher autoincrement id) precedes the earlier one.
  assert.ok(
    myIds.indexOf(newer.id) < myIds.indexOf(older.id),
    "campaigns are ordered newest first",
  );

  const theirs = await listCampaignsForUser(USER_B);
  assert.ok(theirs.every((c) => c.userId === USER_B), "USER_B sees only its own campaigns");
  assert.ok(!theirs.some((c) => c.id === older.id), "USER_B never sees USER_A's campaigns");
});

test("getSendRecordsForCampaign returns an owned campaign's records ordered by id; cross-tenant → []", async () => {
  const [camp] = await createDraftCampaign(USER_A, draftValues());
  await db.insert(send_records).values([
    { campaign_id: camp.id, to_addr: "a@example.com", merged_subject: "S1", merged_body: "B1", status: "sent" },
    { campaign_id: camp.id, to_addr: "b@example.com", merged_subject: "S2", merged_body: "B2", status: "sending" },
    { campaign_id: camp.id, to_addr: "c@example.com", merged_subject: "S3", merged_body: "B3", status: "pending" },
  ]);

  const records = await getSendRecordsForCampaign(USER_A, camp.id);
  assert.equal(records.length, 3, "the owner reads all of their campaign's send_records");
  const ids = records.map((r) => r.id);
  assert.deepEqual(ids, [...ids].sort((x, y) => x - y), "records are ordered by ascending id");
  assert.deepEqual(
    records.map((r) => r.to_addr),
    ["a@example.com", "b@example.com", "c@example.com"],
    "insertion order is preserved by the id sort",
  );

  const leaked = await getSendRecordsForCampaign(USER_B, camp.id);
  assert.deepEqual(leaked, [], "a cross-tenant drill-down returns an empty array (ownership guard first)");
});

test("getCampaignProgressRow derives counts + the current 'sending' recipient for the owner; cross-tenant → undefined", async () => {
  const [camp] = await createDraftCampaign(USER_A, draftValues());
  // Force a mixed running state on the campaign counters.
  await db
    .update(campaigns)
    .set({ status: "running", total: 5, sent_count: 2, failed_count: 1 })
    .where(eq(campaigns.id, camp.id));
  await db.insert(send_records).values([
    { campaign_id: camp.id, to_addr: "done@example.com", merged_subject: "S", merged_body: "B", status: "sent" },
    { campaign_id: camp.id, to_addr: "current@example.com", merged_subject: "S", merged_body: "B", status: "sending" },
  ]);

  const progress = await getCampaignProgressRow(USER_A, camp.id);
  assert.ok(progress, "the owner reads their campaign's progress");
  assert.equal(progress!.status, "running");
  assert.equal(progress!.total, 5);
  assert.equal(progress!.sent_count, 2);
  assert.equal(progress!.failed_count, 1);
  assert.equal(
    progress!.current,
    "current@example.com",
    "current recipient = the lone row in status 'sending'",
  );

  const leaked = await getCampaignProgressRow(USER_B, camp.id);
  assert.equal(leaked, undefined, "a cross-tenant progress read returns undefined");
});

test("getCampaignProgressRow reports a null current recipient when no row is 'sending'", async () => {
  const [camp] = await createDraftCampaign(USER_A, draftValues());
  await db.insert(send_records).values([
    { campaign_id: camp.id, to_addr: "x@example.com", merged_subject: "S", merged_body: "B", status: "sent" },
  ]);

  const progress = await getCampaignProgressRow(USER_A, camp.id);
  assert.ok(progress);
  assert.equal(progress!.current, null, "no 'sending' row → current is null");
});

// --- deleteCampaignForUser (mdt): transactional cascade + status/owner guards ---
//
// The cascade is manual and FK-ordered (send_records → attachments → campaign,
// foreign_keys=ON with no onDelete). The status-guarded parent DELETE is the
// TOCTOU defense (T-mdt-02): an active campaign the worker may claim is refused,
// leaving every dependent intact; a cross-tenant id removes zero rows (T-mdt-01).

test("deleteCampaignForUser removes a draft campaign, its send_records + attachments, and returns their storage paths", async () => {
  const [camp] = await createDraftCampaign(USER_A, draftValues());
  await db.insert(send_records).values([
    { campaign_id: camp.id, to_addr: "one@example.com", merged_subject: "S", merged_body: "B", status: "sent" },
    { campaign_id: camp.id, to_addr: "two@example.com", merged_subject: "S", merged_body: "B", status: "failed" },
  ]);
  await db.insert(attachments).values([
    { userId: USER_A, campaign_id: camp.id, filename: "a.pdf", storage_path: "att-a.bin", size_bytes: 10 },
    { userId: USER_A, campaign_id: camp.id, filename: "b.pdf", storage_path: "att-b.bin", size_bytes: 20 },
  ]);

  const res = deleteCampaignForUser(USER_A, camp.id);
  assert.equal(res.ok, true, "a draft campaign is deletable");
  assert.deepEqual(
    [...res.storagePaths].sort(),
    ["att-a.bin", "att-b.bin"],
    "the removed attachments' storage paths come back for the caller to unlink",
  );

  // The campaign, its send_records, and its attachment rows are all gone.
  assert.equal(await getCampaignForUser(USER_A, camp.id), undefined, "campaign removed");
  const leftoverRecords = await db.query.send_records.findMany({
    where: eq(send_records.campaign_id, camp.id),
  });
  assert.equal(leftoverRecords.length, 0, "send_records cascaded");
  const leftoverAtts = await db.query.attachments.findMany({
    where: eq(attachments.campaign_id, camp.id),
  });
  assert.equal(leftoverAtts.length, 0, "attachment rows cascaded");
});

test("deleteCampaignForUser BLOCKS an active (queued/running) campaign and leaves every dependent intact", async () => {
  const [camp] = await createDraftCampaign(USER_A, draftValues());
  await db.insert(send_records).values([
    { campaign_id: camp.id, to_addr: "live@example.com", merged_subject: "S", merged_body: "B", status: "sending" },
  ]);
  await db.insert(attachments).values([
    { userId: USER_A, campaign_id: camp.id, filename: "live.pdf", storage_path: "att-live.bin", size_bytes: 30 },
  ]);
  // Flip to running — the window in which the worker may be processing it.
  await db.update(campaigns).set({ status: "running" }).where(eq(campaigns.id, camp.id));

  const res = deleteCampaignForUser(USER_A, camp.id);
  assert.equal(res.ok, false, "an active campaign is refused");
  assert.deepEqual(res.storagePaths, [], "a blocked delete returns no paths to unlink");

  // Nothing was removed — the transaction rolled the whole cascade back.
  const still = await getCampaignForUser(USER_A, camp.id);
  assert.ok(still, "the active campaign survives");
  assert.equal(still.status, "running");
  const records = await db.query.send_records.findMany({
    where: eq(send_records.campaign_id, camp.id),
  });
  assert.equal(records.length, 1, "send_records are intact after a blocked delete");
  const atts = await db.query.attachments.findMany({
    where: eq(attachments.campaign_id, camp.id),
  });
  assert.equal(atts.length, 1, "attachment rows are intact after a blocked delete");
});

test("deleteCampaignForUser is owner-scoped: a cross-tenant id removes zero rows (IDOR)", async () => {
  const [camp] = await createDraftCampaign(USER_A, draftValues());
  await db.insert(send_records).values([
    { campaign_id: camp.id, to_addr: "owned@example.com", merged_subject: "S", merged_body: "B", status: "sent" },
  ]);

  const res = deleteCampaignForUser(USER_B, camp.id);
  assert.equal(res.ok, false, "a cross-tenant delete is refused");
  assert.deepEqual(res.storagePaths, []);

  // USER_A's campaign and its records are untouched.
  const still = await getCampaignForUser(USER_A, camp.id);
  assert.ok(still, "the owner's campaign survives a cross-tenant delete");
  const records = await db.query.send_records.findMany({
    where: eq(send_records.campaign_id, camp.id),
  });
  assert.equal(records.length, 1, "the owner's send_records are intact");
});

test("deleteCampaignForUser deletes a completed campaign that has no attachments (empty storagePaths)", async () => {
  const [camp] = await createDraftCampaign(USER_A, draftValues());
  await db.update(campaigns).set({ status: "completed" }).where(eq(campaigns.id, camp.id));

  const res = deleteCampaignForUser(USER_A, camp.id);
  assert.equal(res.ok, true, "a completed campaign is deletable");
  assert.deepEqual(res.storagePaths, [], "no attachments → no paths to unlink");
  assert.equal(await getCampaignForUser(USER_A, camp.id), undefined);
});
