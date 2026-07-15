/**
 * Orphan-recovery sweep tests (SEND-06 / T-06-02 / Pattern 5).
 *
 * The highest-stakes crash-safety guarantee: a send_record left in `sending` when
 * the worker died has an UNKNOWN delivery outcome (the SMTP server may have
 * accepted it before the crash). recoverOrphanedSending makes every such row
 * TERMINAL — `failed` with a distinct interrupted-marker error — and bumps
 * `failed_count`, so the send loop (which processes `pending` only) never
 * re-sends it. This trades a possible false-negative for the non-negotiable
 * "no double-send ever" guarantee. It MUST never reset `sending`→`pending`.
 *
 * These prove:
 *  - a `sending` row becomes `failed` with the exact interrupted marker;
 *  - `sent` / already-`failed` / `pending` rows are untouched;
 *  - `failed_count` rises by EXACTLY the swept count (return value == bump);
 *  - a campaign with zero `sending` rows is a no-op returning 0.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Provision an isolated temp DB + encryption key BEFORE any DB import ------
const TMP_DIR = mkdtempSync(join(tmpdir(), "worker-recover-"));
process.env.DATABASE_PATH = join(TMP_DIR, "app.db");
process.env.CREDENTIAL_ENC_KEY = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
).toString("base64");

const { db, connection, send_records, campaigns } = await import("@/lib/db");
const { recoverOrphanedSending } = await import("./recover");
const { createDraftCampaign } = await import("@/lib/data/campaigns");
const { createRecipientSet } = await import("@/lib/data/recipients");
const { createTemplate } = await import("@/lib/data/templates");
const { createSmtpConfig } = await import("@/lib/data/smtp");
const { encrypt } = await import("@/lib/crypto");
const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
const { eq } = await import("drizzle-orm");

const USER = "user_recover_tenant_aaaaaa";

let RECIPIENT_SET_ID = 0;
let TEMPLATE_ID = 0;
let SMTP_CONFIG_ID = 0;

before(async () => {
  migrate(db, { migrationsFolder: "./drizzle" });

  const [set] = await createRecipientSet(USER, {
    filename: "recipients.csv",
    columns_json: JSON.stringify(["email", "name"]),
    row_count: 3,
    storage_path: "/data/uploads/recipients.csv",
    email_column: "email",
  });
  RECIPIENT_SET_ID = set.id;

  const [tpl] = await createTemplate(USER, {
    subject: "Hi {{name}}",
    body: "Welcome aboard.",
  });
  TEMPLATE_ID = tpl.id;

  const secret = encrypt("MARKER-SECRET-PASSWORD-recover");
  const [cfg] = await createSmtpConfig(USER, {
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
  SMTP_CONFIG_ID = cfg.id;
});

after(() => {
  connection.close();
  rmSync(TMP_DIR, { recursive: true, force: true });
});

/** Create a fresh campaign row (draft is fine — recover ignores campaign status). */
async function newCampaign(): Promise<number> {
  const [d] = await createDraftCampaign(USER, {
    recipient_set_id: RECIPIENT_SET_ID,
    template_id: TEMPLATE_ID,
    smtp_config_id: SMTP_CONFIG_ID,
  });
  return d.id;
}

/** Insert one send_record with a given status; returns its id. */
function insertRecord(campaignId: number, toAddr: string, status: string): number {
  const [row] = db
    .insert(send_records)
    .values({
      campaign_id: campaignId,
      to_addr: toAddr,
      merged_subject: "s",
      merged_body: "b",
      status,
    })
    .returning({ id: send_records.id })
    .all();
  return row.id;
}

const INTERRUPTED = "interrupted: delivery status unknown";

test("sweeps sending→failed(interrupted) and leaves sent/failed/pending untouched", async () => {
  const id = await newCampaign();
  const sendingA = insertRecord(id, "a@example.com", "sending");
  const sendingB = insertRecord(id, "b@example.com", "sending");
  const alreadySent = insertRecord(id, "c@example.com", "sent");
  const alreadyFailed = insertRecord(id, "d@example.com", "failed");
  const stillPending = insertRecord(id, "e@example.com", "pending");

  const swept = recoverOrphanedSending(id);
  assert.equal(swept, 2, "returns the count of rows swept");

  const byId = (rid: number) =>
    db.select().from(send_records).where(eq(send_records.id, rid)).all()[0];

  assert.equal(byId(sendingA).status, "failed", "sending → failed");
  assert.equal(byId(sendingA).error, INTERRUPTED, "exact interrupted marker");
  assert.equal(byId(sendingB).status, "failed");
  assert.equal(byId(alreadySent).status, "sent", "sent row untouched");
  assert.equal(byId(alreadySent).error, null, "sent row error not overwritten");
  assert.equal(byId(alreadyFailed).status, "failed", "pre-existing failed untouched");
  assert.equal(byId(stillPending).status, "pending", "pending row NOT reset/touched");

  const campaign = db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, id))
    .all()[0];
  assert.equal(campaign.failed_count, 2, "failed_count rose by exactly the swept count");
});

test("sweep + failed_count bump commit together — counter matches row states (WR-04)", async () => {
  const id = await newCampaign();
  insertRecord(id, "s1@example.com", "sending");
  insertRecord(id, "s2@example.com", "sending");
  insertRecord(id, "s3@example.com", "sending");

  const swept = recoverOrphanedSending(id);
  assert.equal(swept, 3);

  // The row transition and the counter bump are one transaction, so the counter
  // can never disagree with the row states (no torn/partial write on a crash).
  const rows = db
    .select()
    .from(send_records)
    .where(eq(send_records.campaign_id, id))
    .all();
  const interrupted = rows.filter((r) => r.error === INTERRUPTED).length;
  const campaign = db.select().from(campaigns).where(eq(campaigns.id, id)).all()[0];

  assert.equal(interrupted, 3, "every sending row is now failed(interrupted)");
  assert.equal(
    campaign.failed_count,
    interrupted,
    "failed_count is exactly the swept-row count — committed atomically with the sweep",
  );
});

test("a campaign with zero sending rows is a no-op returning 0", async () => {
  const id = await newCampaign();
  insertRecord(id, "only-pending@example.com", "pending");
  insertRecord(id, "only-sent@example.com", "sent");

  const swept = recoverOrphanedSending(id);
  assert.equal(swept, 0, "no sending rows → nothing swept");

  const campaign = db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, id))
    .all()[0];
  assert.equal(campaign.failed_count, 0, "failed_count not bumped on a no-op sweep");
});

test("only sweeps the target campaign's sending rows (tenant/campaign isolation)", async () => {
  const target = await newCampaign();
  const other = await newCampaign();
  const targetSending = insertRecord(target, "t@example.com", "sending");
  const otherSending = insertRecord(other, "o@example.com", "sending");

  const swept = recoverOrphanedSending(target);
  assert.equal(swept, 1, "only the target campaign's sending row is swept");

  const byId = (rid: number) =>
    db.select().from(send_records).where(eq(send_records.id, rid)).all()[0];
  assert.equal(byId(targetSending).status, "failed");
  assert.equal(byId(otherSending).status, "sending", "other campaign's row is left alone");
});
