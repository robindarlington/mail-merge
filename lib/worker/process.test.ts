/**
 * Seam tests for the worker's send loop, `runCampaign` (SEND-02/03/04/06).
 *
 * These drive the whole per-recipient state machine WITHOUT a live SMTP socket or
 * a Clerk request context, by injecting a stub `MailTransport` (mirrors the
 * pattern in lib/campaign/actions-core.test.ts). They prove:
 *
 *  - verify-once-before-send; a verify failure aborts the whole run (no rows sent)
 *  - pending → sending → sent|failed transitions with message_id / error / sent_at
 *  - a per-row failure does NOT abort the batch (SEND-04); failed_count bumps
 *  - only 'pending' rows are processed, so a resume never re-sends (SEND-06)
 *  - throttle is applied BETWEEN sends only, never after the last row
 *  - the decrypted SMTP password never leaks into the result or any send_record
 *
 * Harness: temp DATABASE_PATH + CREDENTIAL_ENC_KEY set BEFORE any DB import, a
 * migrated throwaway DB, send_records seeded directly (this seam consumes rows the
 * materialize step produced), and a stub transport injected via transportOverride.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Provision an isolated temp DB + key BEFORE any DB import ------------------
const TMP_DIR = mkdtempSync(join(tmpdir(), "worker-process-"));
process.env.DATABASE_PATH = join(TMP_DIR, "app.db");
process.env.CREDENTIAL_ENC_KEY = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
).toString("base64");

// A distinctive marker so a redaction assertion can grep for a credential leak.
const MARKER_PASSWORD = "MARKER-SECRET-PASSWORD-06-02";

// Dynamic imports so the env vars above are in effect at module-eval time.
const { db, connection, send_records, campaigns } = await import("@/lib/db");
const { runCampaign, WORKER_TRANSPORT_TIMEOUTS } = await import("./process");
const { createRecipientSet } = await import("@/lib/data");
const { createTemplate } = await import("@/lib/data");
const { createSmtpConfig } = await import("@/lib/data");
const { createDraftCampaign } = await import("@/lib/data");
const { encrypt } = await import("@/lib/crypto");
const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
const { eq } = await import("drizzle-orm");

type MailTransport = import("@/lib/core").MailTransport;
type Campaign = import("@/lib/db").Campaign;

const USER = "user_worker_proc_aaaaaaaaaa";

let recipientSetId = 0;
let templateId = 0;
let smtpConfigId = 0;

/**
 * A stub transport that counts + records every verify/sendMail without dialing a
 * real server. `failOnSend` throws on that 0-based send index so the per-row
 * failure branch can be driven. `order` proves verify-before-send.
 */
function stubTransport(opts: { verifyOk?: boolean; failOnSend?: number } = {}) {
  const calls = { verify: 0, send: 0 };
  const sent: { from: string; to: string; subject: string; text: string }[] = [];
  const order: string[] = [];
  const transport = {
    calls,
    sent,
    order,
    async verify() {
      calls.verify++;
      order.push("verify");
      if (opts.verifyOk === false) {
        throw Object.assign(new Error("auth rejected"), { code: "EAUTH" });
      }
      return true;
    },
    async sendMail(m: { from: string; to: string; subject: string; text: string }) {
      const idx = calls.send;
      calls.send++;
      order.push("send");
      sent.push(m);
      if (opts.failOnSend === idx) {
        throw new Error("550 mailbox unavailable");
      }
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
    row_count: 3,
    storage_path: "recipients.csv",
    email_column: "email",
  });
  recipientSetId = set.id;

  const [tpl] = await createTemplate(USER, {
    subject: "Hi {{name}}",
    body: "Welcome",
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

/** Create a fresh campaign owned by USER, wired to the seeded FKs. */
async function freshCampaign(): Promise<Campaign> {
  const [created] = await createDraftCampaign(USER, {
    recipient_set_id: recipientSetId,
    template_id: templateId,
    smtp_config_id: smtpConfigId,
  });
  return created;
}

/** Seed `addrs.length` pending send_records for a campaign; returns their ids. */
async function seedPending(campaignId: number, addrs: string[]): Promise<number[]> {
  const ids: number[] = [];
  for (const to of addrs) {
    const [row] = await db
      .insert(send_records)
      .values({
        campaign_id: campaignId,
        to_addr: to,
        merged_subject: "Hi there",
        merged_body: "Welcome",
      })
      .returning({ id: send_records.id });
    ids.push(row.id);
  }
  return ids;
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

test("verify runs once, then every pending row transitions pending -> sent", async () => {
  const c = await freshCampaign();
  await seedPending(c.id, ["a@ex.com", "b@ex.com", "c@ex.com"]);
  const stub = stubTransport({ verifyOk: true });

  const result = await runCampaign(c, { transportOverride: stub, delayMs: 0 });

  assert.deepEqual(result, { ok: true, sent: 3, failed: 0 });
  assert.equal(stub.calls.verify, 1, "verify runs exactly once before sending");
  assert.equal(stub.calls.send, 3, "one send per pending row");
  assert.equal(stub.order[0], "verify", "verify precedes the first send");

  const rows = await recordsFor(c.id);
  for (const r of rows) {
    assert.equal(r.status, "sent");
    assert.ok(r.message_id, "message_id persisted on success");
    assert.ok(r.sent_at && r.sent_at > 0, "sent_at timestamp persisted");
    assert.equal(r.error, null);
  }
  const camp = await campaignRow(c.id);
  assert.equal(camp!.sent_count, 3);
  assert.equal(camp!.failed_count, 0);
});

test("a per-row send failure does NOT abort the batch (SEND-04)", async () => {
  const c = await freshCampaign();
  await seedPending(c.id, ["a@ex.com", "b@ex.com", "c@ex.com"]);
  // Fail the SECOND row (index 1) — rows 1 and 3 must still send.
  const stub = stubTransport({ verifyOk: true, failOnSend: 1 });

  const result = await runCampaign(c, { transportOverride: stub, delayMs: 0 });

  assert.equal(result.ok, true);
  assert.deepEqual(result, { ok: true, sent: 2, failed: 1 });
  assert.equal(stub.calls.send, 3, "the loop kept going past the failed row");

  const rows = await recordsFor(c.id);
  const failed = rows.filter((r) => r.status === "failed");
  const sent = rows.filter((r) => r.status === "sent");
  assert.equal(failed.length, 1);
  assert.equal(sent.length, 2);
  assert.equal(failed[0].to_addr, "b@ex.com");
  assert.equal(failed[0].error, "550 mailbox unavailable", "error is the message STRING");
  assert.equal(failed[0].attempts, 1, "attempts incremented on failure");

  const camp = await campaignRow(c.id);
  assert.equal(camp!.failed_count, 1);
  assert.equal(camp!.sent_count, 2);
});

test("resume sends ONLY pending rows — an already-sent recipient is never re-sent (SEND-06)", async () => {
  const c = await freshCampaign();
  const ids = await seedPending(c.id, ["a@ex.com", "b@ex.com", "c@ex.com"]);
  // Pre-mark the first row as already 'sent' (a prior run delivered it).
  await db
    .update(send_records)
    .set({ status: "sent", message_id: "prior", sent_at: 111 })
    .where(eq(send_records.id, ids[0]));

  const stub = stubTransport({ verifyOk: true });
  const result = await runCampaign(c, { transportOverride: stub, delayMs: 0 });

  assert.equal(result.ok, true);
  assert.deepEqual(result, { ok: true, sent: 2, failed: 0 });
  assert.equal(stub.calls.send, 2, "only the 2 still-pending rows were sent");
  const toAddrs = stub.sent.map((m) => m.to).sort();
  assert.deepEqual(toAddrs, ["b@ex.com", "c@ex.com"], "the already-sent row was skipped");
});

test("a verify failure aborts the whole run with a reason and sends NOTHING", async () => {
  const c = await freshCampaign();
  await seedPending(c.id, ["a@ex.com", "b@ex.com"]);
  const stub = stubTransport({ verifyOk: false });

  const result = await runCampaign(c, { transportOverride: stub, delayMs: 0 });

  assert.equal(result.ok, false);
  assert.ok(!result.ok && typeof result.reason === "string" && result.reason.length > 0);
  assert.equal(stub.calls.send, 0, "no row was sent after a verify failure");

  const rows = await recordsFor(c.id);
  assert.ok(rows.every((r) => r.status === "pending"), "all rows remain pending");
});

test("an unknown/deleted SMTP config resolves to a whole-campaign abort", async () => {
  // Owner-scoped resolution of a non-existent smtp_config_id → undefined → abort.
  // The campaign carries a bogus stamped FK that no owned config matches.
  const [created] = await createDraftCampaign(USER, {
    recipient_set_id: recipientSetId,
    template_id: templateId,
    smtp_config_id: smtpConfigId,
  });
  const bogus = { ...created, smtp_config_id: 999999 } as Campaign;
  await seedPending(created.id, ["a@ex.com"]);

  const result = await runCampaign(bogus, { transportOverride: stubTransport(), delayMs: 0 });
  assert.deepEqual(result, { ok: false, reason: "no SMTP config" });
});

test("the decrypted SMTP password never leaks into the result or any send_record", async () => {
  const c = await freshCampaign();
  // One row that FAILS, so an error string is actually written — the redaction
  // guarantee must hold even on the error path.
  await seedPending(c.id, ["a@ex.com", "b@ex.com"]);
  const stub = stubTransport({ verifyOk: true, failOnSend: 0 });

  const result = await runCampaign(c, { transportOverride: stub, delayMs: 0 });

  const resultJson = JSON.stringify(result);
  assert.ok(
    !resultJson.includes(MARKER_PASSWORD),
    "marker password absent from the serialized result",
  );
  const rows = await recordsFor(c.id);
  for (const r of rows) {
    assert.ok(
      !JSON.stringify(r).includes(MARKER_PASSWORD),
      "marker password absent from every send_record",
    );
    if (r.error) {
      assert.ok(!r.error.includes(MARKER_PASSWORD), "error string carries no password");
    }
  }
});

test("throttle is applied BETWEEN sends only, never after the last row", async () => {
  const c = await freshCampaign();
  await seedPending(c.id, ["a@ex.com", "b@ex.com", "c@ex.com"]);
  const stub = stubTransport({ verifyOk: true });
  const DELAY = 25;

  const started = Date.now();
  const result = await runCampaign(c, { transportOverride: stub, delayMs: DELAY });
  const elapsed = Date.now() - started;

  assert.equal(result.ok, true);
  // 3 rows → exactly 2 inter-send gaps. If throttle also ran after the last row
  // there would be 3 gaps (>= 75ms). Assert 2 gaps happened but not 3.
  assert.ok(elapsed >= DELAY * 2 * 0.8, `expected >= ~${DELAY * 2}ms of throttle, got ${elapsed}ms`);
  assert.ok(elapsed < DELAY * 3, `expected < ${DELAY * 3}ms (no throttle after last row), got ${elapsed}ms`);
});

test("a row delivered by another worker mid-run is fenced out and never re-sent (CR-01)", async () => {
  const c = await freshCampaign();
  const ids = await seedPending(c.id, ["a@ex.com", "b@ex.com", "c@ex.com"]);
  const stub = stubTransport({ verifyOk: true });

  // The pending snapshot captures all three rows. After the FIRST row is processed
  // a concurrent worker "delivers" the LAST row (flips it 'sending' snapshot →
  // 'sent'). The pending→sending fence (AND status='pending') must then SKIP it so
  // it is never re-sent — the no-double-send guarantee under a stolen lease.
  let beats = 0;
  const result = await runCampaign(c, {
    transportOverride: stub,
    delayMs: 0,
    onHeartbeat: () => {
      beats++;
      if (beats === 1) {
        db.update(send_records)
          .set({ status: "sent", message_id: "other-worker", sent_at: 222 })
          .where(eq(send_records.id, ids[2]))
          .run();
      }
    },
  });

  assert.deepEqual(result, { ok: true, sent: 2, failed: 0 });
  assert.equal(stub.calls.send, 2, "the row taken by another worker was skipped, not re-sent");

  const rows = await recordsFor(c.id);
  const cRow = rows.find((r) => r.id === ids[2])!;
  assert.equal(cRow.status, "sent", "the concurrently-delivered row stays sent");
  assert.equal(cRow.message_id, "other-worker", "the other worker's delivery is untouched");

  // sent_count bumps only for rows THIS run actually delivered (a@, b@) — the
  // fenced-out c@ never bumped it, so the counter stays honest under contention.
  const camp = await campaignRow(c.id);
  assert.equal(camp!.sent_count, 2, "counter bumped only for rows this run delivered");
});

test("worker transport timeouts are capped below the default lease (CR-01)", () => {
  const DEFAULT_LEASE_MS = 300_000;
  const maxTimeout = Math.max(
    WORKER_TRANSPORT_TIMEOUTS.connectionTimeout,
    WORKER_TRANSPORT_TIMEOUTS.greetingTimeout,
    WORKER_TRANSPORT_TIMEOUTS.socketTimeout,
  );
  assert.ok(
    maxTimeout < DEFAULT_LEASE_MS,
    `every SMTP dial phase (max ${maxTimeout}ms) must finish before the ${DEFAULT_LEASE_MS}ms lease can be stolen`,
  );
  // Guard against a regression back to nodemailer's 600s socket default.
  assert.ok(WORKER_TRANSPORT_TIMEOUTS.socketTimeout <= 120_000);
});

test("onHeartbeat fires once per processed row", async () => {
  const c = await freshCampaign();
  await seedPending(c.id, ["a@ex.com", "b@ex.com", "c@ex.com"]);
  const stub = stubTransport({ verifyOk: true });
  let beats = 0;
  const seen: number[] = [];

  await runCampaign(c, {
    transportOverride: stub,
    delayMs: 0,
    onHeartbeat: (id) => {
      beats++;
      seen.push(id);
    },
  });

  assert.equal(beats, 3, "heartbeat fires once per row");
  assert.ok(seen.every((id) => id === c.id), "heartbeat carries the campaign id");
});
