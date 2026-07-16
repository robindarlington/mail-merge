/**
 * Seam tests for the worker's materialization step (SEND-06).
 *
 * `materializeSendRecords` turns a claimed campaign's stored CSV + template into
 * one `pending` `send_record` per UNIQUE recipient address, idempotently. These
 * tests prove the two correctness properties without a socket or a Clerk context:
 *
 *  - Duplicate-address collapse (Pitfall 2 / A3): two CSV rows with the same
 *    address materialize to ONE send_record (UNIQUE(campaign_id,to_addr)); the
 *    campaign `total` is reconciled to the materialized count, NOT the raw row
 *    count, so "remaining" math stays honest.
 *  - Idempotent resume (Pattern 2): a second materialize call inserts ZERO new
 *    rows (onConflictDoNothing) — a re-claimed campaign never duplicates rows.
 *
 * Harness mirrors lib/data/campaigns.test.ts + lib/campaign/actions-core.test.ts:
 * set DATABASE_PATH + CREDENTIAL_ENC_KEY + UPLOADS_PATH BEFORE any DB/uploads
 * import, migrate a throwaway DB, and write a CSV fixture to the temp uploads dir.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Provision an isolated temp DB + key + uploads dir BEFORE any import -------
const TMP_DIR = mkdtempSync(join(tmpdir(), "worker-materialize-"));
process.env.DATABASE_PATH = join(TMP_DIR, "app.db");
process.env.CREDENTIAL_ENC_KEY = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
).toString("base64");
const UPLOADS_DIR = join(TMP_DIR, "uploads");
process.env.UPLOADS_PATH = UPLOADS_DIR;
mkdirSync(UPLOADS_DIR, { recursive: true });

// A 4-row CSV whose row 3 repeats row 1's address (different merge data). The
// UNIQUE(campaign_id,to_addr) constraint collapses the two "alice" rows to one,
// so 4 raw rows materialize to 3 unique send_records.
const CSV_NAME = "recipients.csv";
const RAW_ROW_COUNT = 4;
const UNIQUE_ADDR_COUNT = 3;
{
  const lines = [
    "email,name",
    "alice@example.com,Alice",
    "bob@example.com,Bob",
    "alice@example.com,AliceDuplicate",
    "carol@example.com,Carol",
  ];
  writeFileSync(join(UPLOADS_DIR, CSV_NAME), lines.join("\n"), "utf8");
}

// Dynamic imports so the env vars above are in effect at module-eval time.
const { db, connection, send_records } = await import("@/lib/db");
const { materializeSendRecords } = await import("./materialize");
const { createRecipientSet } = await import("@/lib/data");
const { createTemplate } = await import("@/lib/data");
const { createSmtpConfig } = await import("@/lib/data");
const { createDraftCampaign } = await import("@/lib/data");
const { createAttachment } = await import("@/lib/data");
const { stampCampaignOnPendingAttachments } = await import("@/lib/data");
const { setAttachmentColumnForUser } = await import("@/lib/data");
const { encrypt } = await import("@/lib/crypto");
const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
const { eq } = await import("drizzle-orm");

const USER = "user_worker_mat_aaaaaaaaaaaa";

type Campaign = import("@/lib/db").Campaign;
let campaign: Campaign;

function sendRecordCount(campaignId: number): number {
  const row = connection
    .prepare("SELECT COUNT(*) AS n FROM send_records WHERE campaign_id = ?")
    .get(campaignId) as { n: number };
  return row.n;
}

function campaignTotal(campaignId: number): number {
  const row = connection
    .prepare("SELECT total AS t FROM campaigns WHERE id = ?")
    .get(campaignId) as { t: number };
  return row.t;
}

before(async () => {
  migrate(db, { migrationsFolder: "./drizzle" });

  const [set] = await createRecipientSet(USER, {
    filename: "recipients.csv",
    columns_json: JSON.stringify(["email", "name"]),
    row_count: RAW_ROW_COUNT,
    storage_path: CSV_NAME,
    email_column: "email",
  });

  const [tpl] = await createTemplate(USER, {
    subject: "Hi {{name}}",
    body: "Welcome {{name}}",
  });

  const secret = encrypt("MARKER-MAT-PASSWORD");
  const [cfg] = await createSmtpConfig(USER, {
    label: "Default",
    host: "smtp.example.com",
    port: 587,
    secure: false,
    username: "sender",
    password_enc: secret.enc,
    password_iv: secret.iv,
    password_tag: secret.tag,
    from_addr: "noreply@example.com",
    from_name: "Example Sender",
  });

  const [created] = await createDraftCampaign(USER, {
    recipient_set_id: set.id,
    template_id: tpl.id,
    smtp_config_id: cfg.id,
  });
  campaign = created;
});

after(() => {
  connection.close();
  rmSync(TMP_DIR, { recursive: true, force: true });
});

test("materialize inserts one pending send_record per UNIQUE address (dup collapse)", async () => {
  const result = await materializeSendRecords(campaign);

  // Two "alice" rows collapse to one → 3 unique addresses from 4 raw rows.
  assert.equal(result.inserted, UNIQUE_ADDR_COUNT, "one insert per unique address");
  assert.equal(sendRecordCount(campaign.id), UNIQUE_ADDR_COUNT);
  assert.ok(
    UNIQUE_ADDR_COUNT < RAW_ROW_COUNT,
    "send_records count is below the raw CSV row count (dedup happened)",
  );
});

test("materialize reconciles campaigns.total to the send_records count, not raw rows", async () => {
  // Re-uses the state from the first test (same campaign): total must equal the
  // materialized count, never the 4 raw rows — otherwise 'remaining' never hits 0.
  assert.equal(result_total(campaign.id), UNIQUE_ADDR_COUNT);
  assert.notEqual(result_total(campaign.id), RAW_ROW_COUNT);
});

// Helper reads the persisted campaign.total (kept out of the assertion body).
function result_total(campaignId: number): number {
  return campaignTotal(campaignId);
}

test("materialize is idempotent on resume: a second call inserts ZERO rows", async () => {
  const before = sendRecordCount(campaign.id);
  const second = await materializeSendRecords(campaign);

  assert.equal(second.inserted, 0, "re-run inserts nothing (onConflictDoNothing)");
  assert.equal(sendRecordCount(campaign.id), before, "row count unchanged on resume");
  assert.equal(second.total, before, "total still equals the materialized count");
});

test("skips blank cells and materializes invalid addresses as failed records (WR-05)", async () => {
  const MIXED = "mixed.csv";
  writeFileSync(
    join(UPLOADS_DIR, MIXED),
    [
      "email,name",
      "good@example.com,Good",
      "not-an-email,Bad",
      ",Blank",
      "  ,Spaces",
      "another@example.com,AlsoGood",
    ].join("\n"),
    "utf8",
  );

  const [set] = await createRecipientSet(USER, {
    filename: MIXED,
    columns_json: JSON.stringify(["email", "name"]),
    row_count: 5,
    storage_path: MIXED,
    email_column: "email",
  });
  const [c] = await createDraftCampaign(USER, {
    recipient_set_id: set.id,
    template_id: campaign.template_id,
    smtp_config_id: campaign.smtp_config_id,
  });

  const result = await materializeSendRecords(c);

  // 2 valid + 1 malformed materialized; the 2 blank/whitespace rows are skipped.
  assert.equal(result.inserted, 3, "2 valid + 1 invalid inserted; blanks skipped");
  assert.equal(result.total, 3, "total counts only materialized rows");

  const rows = await db
    .select()
    .from(send_records)
    .where(eq(send_records.campaign_id, c.id));
  const failed = rows.filter((r) => r.status === "failed");
  const pending = rows.filter((r) => r.status === "pending");

  assert.equal(pending.length, 2, "the two valid addresses are pending");
  assert.equal(failed.length, 1, "the malformed address is a terminal failed record");
  assert.equal(failed[0].to_addr, "not-an-email");
  assert.equal(failed[0].error, "rejected: invalid address");
  assert.ok(!rows.some((r) => r.to_addr === ""), "no blank-address record was created");

  // failed_count is bumped so remaining = total - sent - failed stays honest.
  assert.equal(
    campaignFailedCount(c.id),
    1,
    "failed_count reflects the materialized invalid row",
  );
});

function campaignFailedCount(campaignId: number): number {
  const row = connection
    .prepare("SELECT failed_count AS f FROM campaigns WHERE id = ?")
    .get(campaignId) as { f: number };
  return row.f;
}

test("stamps send_records.attachment_id per matched row — a SHARED file links EVERY referencing row (inverted FK)", async () => {
  const ATT_CSV = "attach.csv";
  writeFileSync(
    join(UPLOADS_DIR, ATT_CSV),
    [
      "email,file",
      "amy@example.com,welcome.pdf",
      "ben@example.com,welcome.pdf", // SAME file as amy — both rows must link it
      "cat@example.com,other.pdf",
      "dan@example.com,", // blank cell → attachment_id stays null
      "eve@example.com,missing.pdf", // no matching upload → row un-linked (null)
    ].join("\n"),
    "utf8",
  );

  const [set] = await createRecipientSet(USER, {
    filename: ATT_CSV,
    columns_json: JSON.stringify(["email", "file"]),
    row_count: 5,
    storage_path: ATT_CSV,
    email_column: "email",
  });
  // The user-confirmed attachment column wins at materialize (SEND path).
  await setAttachmentColumnForUser(USER, set.id, "file");

  const [c] = await createDraftCampaign(USER, {
    recipient_set_id: set.id,
    template_id: campaign.template_id,
    smtp_config_id: campaign.smtp_config_id,
  });

  // Two campaign attachments: welcome.pdf (shared by amy + ben) and other.pdf (cat).
  await createAttachment(USER, {
    filename: "welcome.pdf",
    storage_path: "w.bin",
    size_bytes: 10,
  });
  await createAttachment(USER, {
    filename: "other.pdf",
    storage_path: "o.bin",
    size_bytes: 20,
  });
  const stamped = await stampCampaignOnPendingAttachments(USER, c.id);
  const welcome = stamped.find((a) => a.filename === "welcome.pdf")!;
  const other = stamped.find((a) => a.filename === "other.pdf")!;

  await materializeSendRecords(c);

  const rows = await db
    .select()
    .from(send_records)
    .where(eq(send_records.campaign_id, c.id));
  const byAddr = new Map(rows.map((r) => [r.to_addr, r]));

  assert.equal(
    byAddr.get("amy@example.com")!.attachment_id,
    welcome.id,
    "amy links welcome.pdf",
  );
  assert.equal(
    byAddr.get("ben@example.com")!.attachment_id,
    welcome.id,
    "ben ALSO links the SAME welcome.pdf — a shared file links every referencing row",
  );
  assert.equal(
    byAddr.get("cat@example.com")!.attachment_id,
    other.id,
    "cat links other.pdf",
  );
  assert.equal(
    byAddr.get("dan@example.com")!.attachment_id,
    null,
    "a blank attachment cell leaves attachment_id null (sends without one)",
  );
  assert.equal(
    byAddr.get("eve@example.com")!.attachment_id,
    null,
    "a cell with no matching upload leaves the row un-linked (defense-in-depth)",
  );
});

test("each send_record snapshots the per-row merged subject and body", async () => {
  const rows = await db
    .select()
    .from(send_records)
    .where(eq(send_records.campaign_id, campaign.id));

  const alice = rows.find((r) => r.to_addr === "alice@example.com");
  assert.ok(alice, "alice row materialized");
  // The FIRST alice row wins the insert; onConflictDoNothing drops the duplicate.
  assert.equal(alice!.merged_subject, "Hi Alice");
  assert.equal(alice!.merged_body, "Welcome Alice");
  assert.equal(alice!.status, "pending", "materialized rows start pending");
});
