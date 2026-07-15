/**
 * Atomic-claim seam tests (SEND-01 / T-06-01 / T-06-03).
 *
 * Proves the DB-as-queue win signal structurally, with a temp SQLite file and
 * NO live worker process:
 *
 *  - claimNextCampaign flips exactly ONE queued campaign to `running`, stamps the
 *    worker_id + a fresh lease + started_at, and returns the typed row (the win).
 *  - A second call with nothing else claimable returns undefined — the single
 *    atomic UPDATE guarantees exactly one winner (no SELECT-then-UPDATE TOCTOU).
 *  - A `running` campaign whose lease has expired (crashed worker) is re-claimable
 *    — the stalled-reclaim branch — while a running row with a FUTURE lease is not.
 *  - started_at survives a reclaim via COALESCE (the original start time is kept).
 *  - When several are claimable, the oldest created_at wins first (FIFO fairness).
 *
 * Harness mirrors lib/data/campaigns.test.ts: set a temp DATABASE_PATH + a
 * deterministic CREDENTIAL_ENC_KEY BEFORE any dynamic import that opens the DB,
 * build the schema from the committed migrations, then seed the three NOT NULL
 * campaign FKs. beforeEach parks every existing campaign into a terminal,
 * non-claimable state so tests don't fight over the single global claim queue.
 */

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Provision an isolated temp DB + encryption key BEFORE any DB import ------
const TMP_DIR = mkdtempSync(join(tmpdir(), "worker-claim-"));
process.env.DATABASE_PATH = join(TMP_DIR, "app.db");
process.env.CREDENTIAL_ENC_KEY = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
).toString("base64");

// Dynamic imports so the env vars above are in effect at module-eval time.
const { db, connection } = await import("@/lib/db");
const { claimNextCampaign } = await import("./claim");
const { createDraftCampaign, enqueueCampaign } = await import("@/lib/data/campaigns");
const { createRecipientSet } = await import("@/lib/data/recipients");
const { createTemplate } = await import("@/lib/data/templates");
const { createSmtpConfig } = await import("@/lib/data/smtp");
const { encrypt } = await import("@/lib/crypto");
const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");

const USER = "user_claim_tenant_aaaaaaaa";

// FK ids captured during seeding — all three campaign FKs are NOT NULL.
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

  const secret = encrypt("MARKER-SECRET-PASSWORD-claim");
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

// Park every existing campaign into a terminal, non-claimable state so each test
// starts from an empty claim queue (the claim query is global, not per-test).
beforeEach(() => {
  connection
    .prepare("UPDATE campaigns SET status='completed', lease_expires_at=NULL")
    .run();
});

/** Create one `queued` campaign referencing the seeded FKs; return its id. */
async function queuedCampaign(): Promise<number> {
  const [d] = await createDraftCampaign(USER, {
    recipient_set_id: RECIPIENT_SET_ID,
    template_id: TEMPLATE_ID,
    smtp_config_id: SMTP_CONFIG_ID,
  });
  await enqueueCampaign(USER, d.id);
  return d.id;
}

test("claims a queued campaign: status→running with worker, lease, started_at set", async () => {
  const id = await queuedCampaign();
  const { now } = connection.prepare("SELECT unixepoch() AS now").get() as {
    now: number;
  };

  const claimed = claimNextCampaign("worker-1", 300);

  assert.ok(claimed, "a queued campaign is claimed");
  assert.equal(claimed.id, id);
  assert.equal(claimed.status, "running", "the claimed campaign is now running");
  assert.equal(claimed.worker_id, "worker-1", "worker_id stamped");
  assert.ok(claimed.userId === USER, "typed row carries the campaign owner (tenancy source)");
  assert.ok(
    claimed.lease_expires_at !== null &&
      claimed.lease_expires_at! >= now + 300,
    "lease_expires_at ≈ unixepoch()+leaseSec",
  );
  assert.ok(claimed.started_at, "started_at is set on first claim");
});

test("a second claim with nothing else claimable returns undefined (single winner)", async () => {
  await queuedCampaign();

  const first = claimNextCampaign("worker-1", 300);
  assert.ok(first, "first claim wins the only queued campaign");

  const second = claimNextCampaign("worker-2", 300);
  assert.equal(second, undefined, "nothing left to claim → undefined");
});

test("re-claims a running campaign whose lease expired (crash resume), preserving started_at", async () => {
  const id = await queuedCampaign();

  const first = claimNextCampaign("worker-1", 300);
  assert.ok(first, "initial claim");
  const originalStarted = first.started_at;

  // Simulate a crashed worker: force the lease into the past.
  connection
    .prepare("UPDATE campaigns SET lease_expires_at = unixepoch() - 10 WHERE id = ?")
    .run(id);

  const reclaimed = claimNextCampaign("worker-2", 300);
  assert.ok(reclaimed, "an expired-lease running row IS re-claimable");
  assert.equal(reclaimed.id, id);
  assert.equal(reclaimed.worker_id, "worker-2", "worker_id refreshed on reclaim");
  assert.equal(
    reclaimed.started_at,
    originalStarted,
    "started_at preserved via COALESCE across the reclaim",
  );
});

test("does NOT re-claim a running campaign that still holds a future lease", async () => {
  await queuedCampaign();

  const first = claimNextCampaign("worker-1", 300); // running, lease 300s in future
  assert.ok(first, "initial claim");

  const second = claimNextCampaign("worker-2", 300);
  assert.equal(
    second,
    undefined,
    "a future-lease running row is not claimable by another worker",
  );
});

test("claims the oldest created_at first when several are queued (FIFO)", async () => {
  const older = await queuedCampaign();
  const newer = await queuedCampaign();

  // Force a deterministic created_at ordering (seeding within one second ties).
  connection.prepare("UPDATE campaigns SET created_at = 1000 WHERE id = ?").run(older);
  connection.prepare("UPDATE campaigns SET created_at = 2000 WHERE id = ?").run(newer);

  const claimed = claimNextCampaign("worker-1", 300);
  assert.ok(claimed, "a campaign is claimed");
  assert.equal(claimed.id, older, "the oldest created_at is claimed first");
});
