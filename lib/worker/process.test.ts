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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Provision an isolated temp DB + key + uploads dir BEFORE any DB import ----
const TMP_DIR = mkdtempSync(join(tmpdir(), "worker-process-"));
process.env.DATABASE_PATH = join(TMP_DIR, "app.db");
process.env.CREDENTIAL_ENC_KEY = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
).toString("base64");
const UPLOADS_DIR = join(TMP_DIR, "uploads");
process.env.UPLOADS_PATH = UPLOADS_DIR;
mkdirSync(UPLOADS_DIR, { recursive: true });

// A distinctive marker so a redaction assertion can grep for a credential leak.
const MARKER_PASSWORD = "MARKER-SECRET-PASSWORD-06-02";

// Dynamic imports so the env vars above are in effect at module-eval time.
const { db, connection, send_records, campaigns, attachments } = await import(
  "@/lib/db"
);
const { runCampaign, WORKER_TRANSPORT_TIMEOUTS } = await import("./process");
const { createAttachment } = await import("@/lib/data");
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
  const sent: {
    from: string;
    to: string;
    subject: string;
    text: string;
    attachments?: { filename: string; path: string }[];
  }[] = [];
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
    async sendMail(m: {
      from: string;
      to: string;
      subject: string;
      text: string;
      attachments?: { filename: string; path: string }[];
    }) {
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

/**
 * Seed a campaign-scoped attachment. Writes real bytes to UPLOADS_DIR unless
 * `onDisk:false` (the send-time missing-file case). Returns the attachment id +
 * relative storage path so a caller can stamp send_records.attachment_id.
 */
async function seedAttachment(
  campaignId: number,
  filename: string,
  onDisk = true,
): Promise<{ id: number; storage_path: string }> {
  const storage_path = `${filename}-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`;
  if (onDisk) writeFileSync(join(UPLOADS_DIR, storage_path), "PDF-BYTES");
  const [row] = await createAttachment(USER, {
    filename,
    storage_path,
    size_bytes: 9,
  });
  // Stamp campaign_id directly (mirrors what prepare/stamp does) so the worker's
  // getAttachmentByIdForCampaign resolves the inverted link.
  await db
    .update(attachments)
    .set({ campaign_id: campaignId })
    .where(eq(attachments.id, row.id));
  return { id: row.id, storage_path };
}

/** Point a seeded send_record at an attachment (the inverted FK materialize stamps). */
async function linkAttachment(sendRecordId: number, attachmentId: number) {
  await db
    .update(send_records)
    .set({ attachment_id: attachmentId })
    .where(eq(send_records.id, sendRecordId));
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

test("shouldStop drains between rows: remaining rows stay pending, run reports stopped (WR-03)", async () => {
  const c = await freshCampaign();
  await seedPending(c.id, ["a@ex.com", "b@ex.com", "c@ex.com"]);
  const stub = stubTransport({ verifyOk: true });

  // shouldStop is checked at the head of each iteration. Trip it once the first
  // row has been processed so the loop drains before row b — leaving b and c
  // pending for the reclaim path to resume.
  let processed = 0;
  const result = await runCampaign(c, {
    transportOverride: stub,
    delayMs: 0,
    onHeartbeat: () => {
      processed++;
    },
    shouldStop: () => processed >= 1,
  });

  assert.deepEqual(result, { ok: true, sent: 1, failed: 0, stopped: true });
  assert.equal(stub.calls.send, 1, "only the first row was sent before the drain");

  const rows = await recordsFor(c.id);
  const pending = rows.filter((r) => r.status === "pending");
  assert.equal(pending.length, 2, "the remaining rows are left pending for resume");
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

test("a linked, on-disk attachment is forwarded to sendMail (filename + resolved path) and the row sends (ATCH-01)", async () => {
  const c = await freshCampaign();
  const [idPlain, idWithAtt] = await seedPending(c.id, [
    "plain@ex.com", // no attachment_id → unchanged send
    "att@ex.com", // linked to a real on-disk file
  ]);
  const att = await seedAttachment(c.id, "welcome.pdf", true);
  await linkAttachment(idWithAtt, att.id);

  const stub = stubTransport({ verifyOk: true });
  const result = await runCampaign(c, { transportOverride: stub, delayMs: 0 });

  assert.deepEqual(result, { ok: true, sent: 2, failed: 0 });

  const plainSent = stub.sent.find((m) => m.to === "plain@ex.com")!;
  assert.equal(
    plainSent.attachments,
    undefined,
    "a row with no attachment_id sends with NO attachments key (byte-for-byte unchanged)",
  );

  const attSent = stub.sent.find((m) => m.to === "att@ex.com")!;
  assert.ok(attSent.attachments, "the linked row carries an attachments array");
  assert.equal(attSent.attachments!.length, 1);
  assert.equal(
    attSent.attachments![0].filename,
    "welcome.pdf",
    "the ORIGINAL filename is forwarded to nodemailer",
  );
  assert.ok(
    attSent.attachments![0].path.endsWith(att.storage_path),
    "the resolved absolute path (from the opaque storage path) is forwarded, never a CSV path",
  );

  const rows = await recordsFor(c.id);
  assert.ok(rows.every((r) => r.status === "sent"), "both rows delivered");
});

test("a dangling attachment_id (DB row gone) fails only that row and never sends attachment-less (CR-01)", async () => {
  const c = await freshCampaign();
  const ids = await seedPending(c.id, [
    "dangling@ex.com", // attachment_id points at a row that does not exist
    "after@ex.com", // must STILL send after the dangling row
  ]);
  // Point the first row at an attachment id that has no DB row (a deleted upload /
  // dangling FK — reachable when foreign_keys isn't enforced). FK enforcement is ON
  // in the shared connection, so toggle it OFF just for this write to reproduce the
  // manually-opened-DB deployment the review calls out. getAttachmentByIdForCampaign
  // then resolves it to undefined, which must FAIL the row, not fall through to a send.
  connection.pragma("foreign_keys = OFF");
  await linkAttachment(ids[0], 987654);
  connection.pragma("foreign_keys = ON");

  const stub = stubTransport({ verifyOk: true });
  const result = await runCampaign(c, { transportOverride: stub, delayMs: 0 });

  assert.deepEqual(result, { ok: true, sent: 1, failed: 1 });
  assert.equal(stub.calls.send, 1, "the dangling row was NOT dialed; only the next row sent");
  assert.deepEqual(
    stub.sent.map((m) => m.to),
    ["after@ex.com"],
    "the campaign continued past the dangling-id row, and it was never sent attachment-less",
  );

  const rows = await recordsFor(c.id);
  const dangling = rows.find((r) => r.to_addr === "dangling@ex.com")!;
  assert.equal(dangling.status, "failed");
  assert.equal(dangling.error, "rejected: attachment missing", "fenced dangling-id failure");
  assert.equal(dangling.attempts, 1, "attempts incremented on the graceful fail");
  assert.equal(rows.find((r) => r.to_addr === "after@ex.com")!.status, "sent");

  const camp = await campaignRow(c.id);
  assert.equal(camp!.failed_count, 1, "failed_count bumped for the dangling-id row");
  assert.equal(camp!.sent_count, 1, "sent_count bumped only for the delivered row");
});

test("an attachment whose file is MISSING on disk fails only that row (rejected: attachment missing) and the campaign continues (ATCH-02 / poison-pill)", async () => {
  const c = await freshCampaign();
  const ids = await seedPending(c.id, [
    "gone@ex.com", // linked to a DB attachment whose file was never written
    "next@ex.com", // must STILL send after the missing-file row
  ]);
  // onDisk:false → the DB row exists but the file is absent at send time.
  const missing = await seedAttachment(c.id, "gone.pdf", false);
  await linkAttachment(ids[0], missing.id);

  const stub = stubTransport({ verifyOk: true });
  const result = await runCampaign(c, { transportOverride: stub, delayMs: 0 });

  assert.deepEqual(result, { ok: true, sent: 1, failed: 1 });
  // sendOne is NEVER called for the missing-file row — only the next row is sent.
  assert.equal(stub.calls.send, 1, "the missing-file row was NOT dialed; only the next row sent");
  assert.deepEqual(
    stub.sent.map((m) => m.to),
    ["next@ex.com"],
    "the campaign continued past the poison-pill row",
  );

  const rows = await recordsFor(c.id);
  const gone = rows.find((r) => r.to_addr === "gone@ex.com")!;
  const next = rows.find((r) => r.to_addr === "next@ex.com")!;
  assert.equal(gone.status, "failed");
  assert.equal(gone.error, "rejected: attachment missing", "fenced missing-file failure");
  assert.equal(gone.attempts, 1, "attempts incremented on the graceful fail");
  assert.equal(next.status, "sent", "the following row still delivered");

  const camp = await campaignRow(c.id);
  assert.equal(camp!.failed_count, 1, "failed_count bumped for the missing-file row");
  assert.equal(camp!.sent_count, 1, "sent_count bumped only for the delivered row");
});
