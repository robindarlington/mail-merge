/**
 * Terminal-transition (finalize) seam tests (Pattern 5 / Pitfall 5 / A5).
 *
 * Once the send loop drains all `pending` rows the campaign is `completed` — even
 * if some rows `failed`, because a partial failure is still a completed RUN
 * (success criterion: "failures don't abort the batch"). Campaign `status='failed'`
 * is reserved for a whole-campaign abort (e.g. transport.verify()/decrypt/config
 * failure BEFORE any row sends). Both transitions stamp `finished_at` and release
 * the lease (`worker_id`/`lease_expires_at` → NULL) so a finished campaign is never
 * re-claimed by the stalled-lease branch.
 *
 * These prove:
 *  - markCompleted → status='completed', finished_at set, lease cleared, EVEN when
 *    failed_count > 0;
 *  - markFailed → status='failed', finished_at set, lease cleared.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Provision an isolated temp DB + encryption key BEFORE any DB import ------
const TMP_DIR = mkdtempSync(join(tmpdir(), "worker-finalize-"));
process.env.DATABASE_PATH = join(TMP_DIR, "app.db");
process.env.CREDENTIAL_ENC_KEY = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
).toString("base64");

const { db, connection, campaigns } = await import("@/lib/db");
const { markCompleted, markFailed } = await import("./finalize");
const { createDraftCampaign } = await import("@/lib/data/campaigns");
const { createRecipientSet } = await import("@/lib/data/recipients");
const { createTemplate } = await import("@/lib/data/templates");
const { createSmtpConfig } = await import("@/lib/data/smtp");
const { encrypt } = await import("@/lib/crypto");
const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
const { eq } = await import("drizzle-orm");

const USER = "user_finalize_tenant_aaaaa";

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

  const secret = encrypt("MARKER-SECRET-PASSWORD-finalize");
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

/** Create a `running`, leased campaign so we can prove the lease is released. */
async function runningLeasedCampaign(failedCount = 0): Promise<number> {
  const [d] = await createDraftCampaign(USER, {
    recipient_set_id: RECIPIENT_SET_ID,
    template_id: TEMPLATE_ID,
    smtp_config_id: SMTP_CONFIG_ID,
  });
  connection
    .prepare(
      "UPDATE campaigns SET status='running', worker_id='worker-x', " +
        "lease_expires_at = unixepoch() + 300, failed_count=? WHERE id=?",
    )
    .run(failedCount, d.id);
  return d.id;
}

const byId = (id: number) =>
  db.select().from(campaigns).where(eq(campaigns.id, id)).all()[0];

test("markCompleted → completed, finished_at set, lease released, even with failed_count>0", async () => {
  const id = await runningLeasedCampaign(3);

  const rows = markCompleted(id, "worker-x");
  assert.equal(rows, 1, "the owning worker's terminal write lands");

  const c = byId(id);
  assert.equal(c.status, "completed", "a drained run is completed");
  assert.equal(c.failed_count, 3, "partial failures are preserved (still 'completed')");
  assert.ok(c.finished_at, "finished_at stamped");
  assert.equal(c.worker_id, null, "worker_id cleared (lease released)");
  assert.equal(c.lease_expires_at, null, "lease_expires_at cleared");
});

test("markFailed → failed, finished_at set, lease released", async () => {
  const id = await runningLeasedCampaign(0);

  const rows = markFailed(id, "smtp verify failed before any send", "worker-x");
  assert.equal(rows, 1, "the owning worker's terminal write lands");

  const c = byId(id);
  assert.equal(c.status, "failed", "a whole-campaign abort is failed");
  assert.ok(c.finished_at, "finished_at stamped");
  assert.equal(c.worker_id, null, "worker_id cleared (lease released)");
  assert.equal(c.lease_expires_at, null, "lease_expires_at cleared");
});

test("markCompleted is a no-op when the lease was stolen (worker_id mismatch, CR-01)", async () => {
  const id = await runningLeasedCampaign(0);
  // A stale worker whose lease was reclaimed by 'worker-x' tries to finalize.
  const rows = markCompleted(id, "stale-worker");
  assert.equal(rows, 0, "the stale worker's terminal write matches zero rows");

  const c = byId(id);
  assert.equal(c.status, "running", "the campaign is left running for the new owner");
  assert.equal(c.worker_id, "worker-x", "the new owner's claim is untouched");
});

test("markFailed is a no-op when the lease was stolen (worker_id mismatch, CR-01)", async () => {
  const id = await runningLeasedCampaign(0);
  const rows = markFailed(id, "stale abort", "stale-worker");
  assert.equal(rows, 0, "the stale worker's terminal write matches zero rows");

  const c = byId(id);
  assert.equal(c.status, "running", "the campaign is left running for the new owner");
  assert.equal(c.worker_id, "worker-x", "the new owner's claim is untouched");
});
