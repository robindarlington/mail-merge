/**
 * Seam tests for the worker's composed `tick()` (SEND-01 / SEND-06).
 *
 * `tick` is the single-poll unit of work: it claims the next campaign, then (in
 * order) recovers orphans → materializes → runs the send loop → finalizes. These
 * tests drive the WHOLE crash-safe lifecycle with NO live SMTP socket and NO
 * Clerk context, by injecting a stub `MailTransport`. They prove three paths:
 *
 *  - Happy path: a queued campaign is claimed, materialized, fully sent, and ends
 *    'completed' with sent_count == recipient count and failed_count 0.
 *  - Verify-abort: a stub whose verify() throws aborts the WHOLE campaign to
 *    'failed' with zero rows sent (markFailed).
 *  - Resume (no double-send): a stalled 'running' campaign with an already-'sent'
 *    row and an orphaned 'sending' row is re-claimed → recover sweeps the orphan to
 *    'failed'(interrupted), materialize is a no-op, only the still-'pending' row is
 *    sent, and the campaign ends 'completed' — the already-sent row is NEVER re-sent.
 *
 * Harness mirrors materialize.test.ts + process.test.ts: set DATABASE_PATH +
 * CREDENTIAL_ENC_KEY + UPLOADS_PATH BEFORE any DB/uploads import, migrate a
 * throwaway DB, write a CSV fixture, and park all campaigns terminal before each
 * test so the GLOBAL claim queue is empty at the start of every test.
 */

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Provision an isolated temp DB + key + uploads dir BEFORE any import -------
const TMP_DIR = mkdtempSync(join(tmpdir(), "worker-loop-"));
process.env.DATABASE_PATH = join(TMP_DIR, "app.db");
process.env.CREDENTIAL_ENC_KEY = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
).toString("base64");
const UPLOADS_DIR = join(TMP_DIR, "uploads");
process.env.UPLOADS_PATH = UPLOADS_DIR;
mkdirSync(UPLOADS_DIR, { recursive: true });

// A 3-row CSV: three unique addresses the send loop must deliver to.
const CSV_NAME = "recipients.csv";
const ADDRS = ["a@example.com", "b@example.com", "c@example.com"];
{
  const lines = [
    "email,name",
    "a@example.com,Alice",
    "b@example.com,Bob",
    "c@example.com,Carol",
  ];
  writeFileSync(join(UPLOADS_DIR, CSV_NAME), lines.join("\n"), "utf8");
}

// A distinctive marker so a redaction assertion could grep for a credential leak.
const MARKER_PASSWORD = "MARKER-SECRET-PASSWORD-06-04";

// Dynamic imports so the env vars above are in effect at module-eval time.
const { db, connection, send_records, campaigns } = await import("@/lib/db");
const { tick } = await import("./loop");
const { createRecipientSet } = await import("@/lib/data");
const { createTemplate } = await import("@/lib/data");
const { createSmtpConfig } = await import("@/lib/data");
const { createDraftCampaign, enqueueCampaign } = await import("@/lib/data");
const { encrypt } = await import("@/lib/crypto");
const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
const { eq } = await import("drizzle-orm");

type MailTransport = import("@/lib/core").MailTransport;

const USER = "user_worker_loop_aaaaaaaaaa";

let recipientSetId = 0;
let templateId = 0;
let smtpConfigId = 0;

/**
 * A stub transport that counts + records every verify/sendMail without dialing a
 * real server. `verifyOk:false` throws on verify so the abort path can be driven.
 */
function stubTransport(opts: { verifyOk?: boolean } = {}) {
  const calls = { verify: 0, send: 0 };
  const sent: { from: string; to: string; subject: string; text: string }[] = [];
  const transport = {
    calls,
    sent,
    async verify() {
      calls.verify++;
      if (opts.verifyOk === false) {
        throw Object.assign(new Error("auth rejected"), { code: "EAUTH" });
      }
      return true;
    },
    async sendMail(m: { from: string; to: string; subject: string; text: string }) {
      const idx = calls.send;
      calls.send++;
      sent.push(m);
      return { messageId: `msg-${idx}` };
    },
  };
  return transport as typeof transport & MailTransport;
}

before(async () => {
  migrate(db, { migrationsFolder: "./drizzle" });

  const [set] = await createRecipientSet(USER, {
    filename: "recipients.csv",
    columns_json: JSON.stringify(["email", "name"]),
    row_count: ADDRS.length,
    storage_path: CSV_NAME,
    email_column: "email",
  });
  recipientSetId = set.id;

  const [tpl] = await createTemplate(USER, {
    subject: "Hi {{name}}",
    body: "Welcome {{name}}",
  });
  templateId = tpl.id;

  const secret = encrypt(MARKER_PASSWORD);
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
  smtpConfigId = cfg.id;
});

after(() => {
  connection.close();
  rmSync(TMP_DIR, { recursive: true, force: true });
});

// Park every existing campaign into a terminal, non-claimable state so each test
// starts from an empty GLOBAL claim queue (the claim query is not per-test).
beforeEach(() => {
  connection
    .prepare("UPDATE campaigns SET status='completed', lease_expires_at=NULL")
    .run();
});

/** Create + enqueue a fresh campaign wired to the seeded FKs; returns its id. */
async function queuedCampaign(): Promise<number> {
  const [created] = await createDraftCampaign(USER, {
    recipient_set_id: recipientSetId,
    template_id: templateId,
    smtp_config_id: smtpConfigId,
  });
  await enqueueCampaign(USER, created.id);
  return created.id;
}

function recordsFor(campaignId: number) {
  return db
    .select()
    .from(send_records)
    .where(eq(send_records.campaign_id, campaignId))
    .orderBy(send_records.id);
}

function campaignRow(campaignId: number) {
  return db.query.campaigns.findFirst({ where: eq(campaigns.id, campaignId) });
}

test("no claimable work → tick returns { claimed:false } with no side effects", async () => {
  const stub = stubTransport({ verifyOk: true });
  const result = await tick({ workerId: "w1", leaseSec: 300, delayMs: 0, transportOverride: stub });
  assert.deepEqual(result, { claimed: false });
  assert.equal(stub.calls.verify, 0, "nothing verified when there is no work");
  assert.equal(stub.calls.send, 0, "nothing sent when there is no work");
});

test("happy path: claim → materialize → send all → completed", async () => {
  const id = await queuedCampaign();
  const stub = stubTransport({ verifyOk: true });

  const result = await tick({ workerId: "w1", leaseSec: 300, delayMs: 0, transportOverride: stub });

  assert.ok(result.claimed, "tick claimed the queued campaign");
  assert.equal(result.campaignId, id);
  assert.equal(result.outcome, "completed");
  if (result.outcome !== "completed") throw new Error("unreachable — asserted above");
  assert.equal(result.sent, ADDRS.length);
  assert.equal(result.failed, 0);

  assert.equal(stub.calls.verify, 1, "verify runs once");
  assert.equal(stub.calls.send, ADDRS.length, "one send per recipient");

  const rows = await recordsFor(id);
  assert.equal(rows.length, ADDRS.length, "one send_record per unique CSV address");
  assert.ok(rows.every((r) => r.status === "sent"), "every row ended sent");

  const camp = await campaignRow(id);
  assert.equal(camp!.status, "completed");
  assert.equal(camp!.sent_count, ADDRS.length);
  assert.equal(camp!.failed_count, 0);
});

test("verify-abort: a verify failure marks the campaign 'failed' with ZERO sent", async () => {
  const id = await queuedCampaign();
  const stub = stubTransport({ verifyOk: false });

  const result = await tick({ workerId: "w1", leaseSec: 300, delayMs: 0, transportOverride: stub });

  assert.equal(result.claimed, true);
  assert.equal(result.claimed && result.campaignId, id);
  assert.equal(result.claimed && result.outcome, "failed");
  assert.equal(stub.calls.send, 0, "sendMail was NEVER called after a verify failure");

  const camp = await campaignRow(id);
  assert.equal(camp!.status, "failed", "the whole campaign is failed");
  assert.equal(camp!.sent_count, 0, "no rows sent");
});

test("a materialize failure marks the campaign failed — no infinite reclaim loop (CR-02)", async () => {
  // A recipient set whose stored CSV does not exist → readUpload (inside
  // materialize) throws. Before CR-02 that propagated out of tick, leaving the
  // campaign 'running' to be reclaimed → throw → reclaimed forever. Now it is
  // caught and the campaign is driven to a terminal 'failed' state.
  const [badSet] = await createRecipientSet(USER, {
    filename: "gone.csv",
    columns_json: JSON.stringify(["email", "name"]),
    row_count: 1,
    storage_path: "does-not-exist.csv",
    email_column: "email",
  });
  const [created] = await createDraftCampaign(USER, {
    recipient_set_id: badSet.id,
    template_id: templateId,
    smtp_config_id: smtpConfigId,
  });
  await enqueueCampaign(USER, created.id);

  const stub = stubTransport({ verifyOk: true });
  const result = await tick({ workerId: "w1", leaseSec: 300, delayMs: 0, transportOverride: stub });

  assert.equal(result.claimed, true);
  assert.equal(result.claimed && result.campaignId, created.id);
  assert.equal(result.claimed && result.outcome, "failed", "a materialize failure is terminal");
  assert.equal(stub.calls.send, 0, "nothing sent when materialize fails");

  const camp = await campaignRow(created.id);
  assert.equal(camp!.status, "failed", "the campaign reaches a terminal state (not stuck running)");
  assert.equal(camp!.worker_id, null, "the lease is released so it is never reclaimed again");
  assert.equal(camp!.lease_expires_at, null);
});

test("a stolen lease mid-run aborts the tick without finalizing (CR-01)", async () => {
  const id = await queuedCampaign();

  // A transport that, on the FIRST delivery, simulates another worker reclaiming
  // the stalled campaign by overwriting worker_id. The ownership-checked heartbeat
  // that fires after that row then matches zero rows → LeaseLostError → the run
  // aborts BEFORE sending another row (no double-send under a stolen lease).
  const calls = { verify: 0, send: 0 };
  const transport = {
    async verify() {
      calls.verify++;
      return true;
    },
    async sendMail(m: { from: string; to: string; subject: string; text: string }) {
      void m;
      calls.send++;
      connection.prepare("UPDATE campaigns SET worker_id='thief' WHERE id=?").run(id);
      return { messageId: `msg-${calls.send}` };
    },
  } as unknown as MailTransport;

  const result = await tick({
    workerId: "w1",
    leaseSec: 300,
    delayMs: 0,
    transportOverride: transport,
  });

  assert.equal(result.claimed, true);
  assert.equal(result.claimed && result.outcome, "aborted", "the run aborts on a stolen lease");
  assert.equal(calls.send, 1, "no further rows are sent once the lease is lost");

  const camp = await campaignRow(id);
  assert.equal(camp!.status, "running", "the campaign is NOT finalized — the new owner drives it");
  assert.equal(camp!.worker_id, "thief", "the reclaiming worker's ownership is left intact");
});

test("resume: re-claim a stalled campaign → orphan swept, only pending sent, no double-send", async () => {
  // Build a campaign that a prior worker started and crashed mid-batch:
  //   a@ = already 'sent' (delivered before the crash — must NOT be re-sent)
  //   b@ = orphaned 'sending' (in-flight at crash — recover sweeps → failed)
  //   c@ = still 'pending' (the only row this resume must actually send)
  const id = await queuedCampaign();
  for (const to of ADDRS) {
    await db
      .insert(send_records)
      .values({ campaign_id: id, to_addr: to, merged_subject: "Hi", merged_body: "Welcome" });
  }
  const rowsBefore = await recordsFor(id);
  const aId = rowsBefore.find((r) => r.to_addr === "a@example.com")!.id;
  const bId = rowsBefore.find((r) => r.to_addr === "b@example.com")!.id;

  await db
    .update(send_records)
    .set({ status: "sent", message_id: "prior", sent_at: 111 })
    .where(eq(send_records.id, aId));
  await db.update(send_records).set({ status: "sending" }).where(eq(send_records.id, bId));

  // Simulate the crashed worker: a 'running' campaign with an EXPIRED lease so the
  // claim's stalled-reclaim branch re-selects it.
  connection
    .prepare(
      "UPDATE campaigns SET status='running', worker_id='dead', lease_expires_at = unixepoch() - 10 WHERE id = ?",
    )
    .run(id);

  const stub = stubTransport({ verifyOk: true });
  const result = await tick({ workerId: "w2", leaseSec: 300, delayMs: 0, transportOverride: stub });

  assert.equal(result.claimed, true);
  assert.equal(result.claimed && result.campaignId, id);
  assert.equal(result.claimed && result.outcome, "completed");

  // Only the ONE still-pending row (c@) was sent — a@ (sent) and b@ (orphan) were not.
  assert.equal(stub.calls.send, 1, "exactly one send on resume");
  assert.deepEqual(
    stub.sent.map((m) => m.to),
    ["c@example.com"],
    "only the pending row was sent — the already-sent row was never re-sent",
  );

  const rows = await recordsFor(id);
  const a = rows.find((r) => r.to_addr === "a@example.com")!;
  const b = rows.find((r) => r.to_addr === "b@example.com")!;
  const c = rows.find((r) => r.to_addr === "c@example.com")!;
  assert.equal(a.status, "sent", "the already-sent row is untouched");
  assert.equal(a.message_id, "prior", "the already-sent row keeps its original message_id");
  assert.equal(b.status, "failed", "the orphaned 'sending' row is swept terminal");
  assert.equal(
    b.error,
    "interrupted: delivery status unknown",
    "the orphan carries the interrupted marker",
  );
  assert.equal(c.status, "sent", "the pending row was delivered on resume");

  const camp = await campaignRow(id);
  assert.equal(camp!.status, "completed", "the resumed campaign ends completed");
});
