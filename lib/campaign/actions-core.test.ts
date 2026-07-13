/**
 * Server-Action seam tests for lib/campaign/actions-core (TEST-01, Phase 5).
 *
 * These drive the NON-"use server" orchestration seam the campaign action
 * delegates to — `sendTestBatchChunkCore` (decrypt → verify → fill → send, as a
 * bounded, client-drivable chunk) — so the whole-batch test-send semantics and
 * secret-redaction are proven WITHOUT a live SMTP dial or a Clerk request context.
 * The thin "use server" wrapper (`sendTestBatchChunk`) is an auth shell over this
 * seam; the seam accepts an injected `MailTransport` so no real socket is opened.
 *
 * Pattern (mirrors lib/smtp/actions.test.ts): set a temp DATABASE_PATH, a
 * deterministic CREDENTIAL_ENC_KEY, and a temp UPLOADS_PATH BEFORE dynamically
 * importing anything that transitively opens the DB or resolves the uploads dir,
 * then build the schema on the throwaway file and write a CSV fixture.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Provision an isolated temp DB + key + uploads dir BEFORE any import -------
const TMP_DIR = mkdtempSync(join(tmpdir(), "campaign-actions-"));
process.env.DATABASE_PATH = join(TMP_DIR, "app.db");
process.env.CREDENTIAL_ENC_KEY = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
).toString("base64");
const UPLOADS_DIR = join(TMP_DIR, "uploads");
process.env.UPLOADS_PATH = UPLOADS_DIR;
mkdirSync(UPLOADS_DIR, { recursive: true });

// A distinctive marker so a redaction assertion can grep for a credential leak.
const MARKER_PASSWORD = "MARKER-SECRET-PASSWORD-9f2c";

// A 12-row CSV fixture spanning more than one chunk (CHUNK_SIZE 10 → 2 chunks).
const CSV_NAME = "fixture.csv";
const ROW_COUNT = 12;
{
  const header = "email,name,code";
  const lines = [header];
  for (let i = 0; i < ROW_COUNT; i++) {
    lines.push(`row${i}@example.com,name${i},code${i}`);
  }
  writeFileSync(join(UPLOADS_DIR, CSV_NAME), lines.join("\n"), "utf8");
}

// Dynamic imports so the env vars above are in effect at module-eval time.
const { db, connection } = await import("@/lib/db");
const { sendTestBatchChunkCore } = await import("./actions-core");
const { TEST_SEND_CHUNK_SIZE } = await import("./schema");
const { createRecipientSet } = await import("../data/recipients");
const { createTemplate } = await import("../data/templates");
const { upsertSmtpConfig } = await import("../data/smtp");
const { encrypt } = await import("../crypto");
const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
type MailTransport = import("../core").MailTransport;

const USER = "user_campaign_aaaaaaaaaaaa";
const TEST_ADDRESS = "inbox@test.example.com";

let recipientSetId: number;
let templateId: number;

/**
 * A stub transport that counts + records every verify/sendMail. It never dials a
 * real server. `failOnSend` throws on that 0-based send index (per transport) so a
 * per-row-failure branch can be driven. `order` proves verify-before-send.
 */
function stubTransport(opts: {
  verifyOk?: boolean;
  failOnSend?: number;
  sendMessage?: string;
}): MailTransport & {
  calls: { verify: number; send: number };
  sent: { from: string; to: string; subject: string; text: string }[];
  order: string[];
} {
  const calls = { verify: 0, send: 0 };
  const sent: { from: string; to: string; subject: string; text: string }[] = [];
  const order: string[] = [];
  return {
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
        throw new Error(opts.sendMessage ?? "550 mailbox unavailable");
      }
      return { messageId: `test-message-id-${idx}` };
    },
  } as MailTransport & {
    calls: { verify: number; send: number };
    sent: { from: string; to: string; subject: string; text: string }[];
    order: string[];
  };
}

before(() => {
  migrate(db, { migrationsFolder: "./drizzle" });
  // The single-row-per-user UNIQUE index backs upsertSmtpConfig's conflict target.
  connection
    .prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS smtp_configs_user_uq ON smtp_configs(user_id)",
    )
    .run();
});

// The async DAL seeding runs as the FIRST test so the awaited inserts complete
// (and populate recipientSetId/templateId) before the seam assertions run.
test("seed: recipient set, template, and smtp config", async () => {
  const [set] = await createRecipientSet(USER, {
    filename: "fixture.csv",
    columns_json: JSON.stringify(["email", "name", "code"]),
    row_count: ROW_COUNT,
    storage_path: CSV_NAME,
    email_column: "email",
  });
  recipientSetId = set.id;

  const [tpl] = await createTemplate(USER, {
    subject: "Hi {{name}}",
    body: "Your code {{code}}",
  });
  templateId = tpl.id;

  const { enc, iv, tag } = encrypt(MARKER_PASSWORD);
  await upsertSmtpConfig(USER, {
    host: "smtp.example.com",
    port: 587,
    secure: false,
    username: "sender",
    password_enc: enc,
    password_iv: iv,
    password_tag: tag,
    from_addr: "noreply@example.com",
    from_name: "Example Sender",
  });

  assert.ok(recipientSetId > 0);
  assert.ok(templateId > 0);
});

after(() => {
  connection.close();
  rmSync(TMP_DIR, { recursive: true, force: true });
});

// --- TEST-01 seam assertions -------------------------------------------------

test("fill is preserved per row: subject AND body are merged with the row's values", async () => {
  const stub = stubTransport({ verifyOk: true });
  const result = await sendTestBatchChunkCore(
    USER,
    { recipientSetId, templateId, testAddress: TEST_ADDRESS, offset: 0 },
    stub,
  );
  assert.equal(result.ok, true);
  // Chunk 0 sends the first CHUNK_SIZE rows.
  assert.equal(stub.sent.length, TEST_SEND_CHUNK_SIZE);
  stub.sent.forEach((m, i) => {
    assert.equal(m.subject, `Hi name${i}`, "subject must be filled per row (EDIT-03)");
    assert.equal(m.text, `Your code code${i}`, "body must be filled per row");
  });
});

test("every message is redirected to the ONE test address (CLI --test parity)", async () => {
  const stub = stubTransport({ verifyOk: true });
  const result = await sendTestBatchChunkCore(
    USER,
    { recipientSetId, templateId, testAddress: TEST_ADDRESS, offset: 0 },
    stub,
  );
  assert.equal(result.ok, true);
  assert.ok(stub.sent.length > 0);
  for (const m of stub.sent) {
    assert.equal(m.to, TEST_ADDRESS, "each send must go to the test address, not the row email");
  }
});

test("verify runs ONCE before any send on the first chunk (offset 0)", async () => {
  const stub = stubTransport({ verifyOk: true });
  const result = await sendTestBatchChunkCore(
    USER,
    { recipientSetId, templateId, testAddress: TEST_ADDRESS, offset: 0 },
    stub,
  );
  assert.equal(result.ok, true);
  assert.equal(stub.calls.verify, 1, "verify must run exactly once on chunk 0");
  assert.equal(stub.calls.send, TEST_SEND_CHUNK_SIZE);
  assert.equal(stub.order[0], "verify", "verify must precede every send");
  assert.ok(
    stub.order.slice(1).every((o) => o === "send"),
    "no send may occur before verify",
  );
});

test("a later chunk (offset === CHUNK_SIZE) skips verify and still sends its slice", async () => {
  const stub = stubTransport({ verifyOk: true });
  const result = await sendTestBatchChunkCore(
    USER,
    {
      recipientSetId,
      templateId,
      testAddress: TEST_ADDRESS,
      offset: TEST_SEND_CHUNK_SIZE,
    },
    stub,
  );
  assert.equal(result.ok, true);
  assert.equal(stub.calls.verify, 0, "connectivity already proven on chunk 0");
  assert.equal(stub.calls.send, ROW_COUNT - TEST_SEND_CHUNK_SIZE, "sends the final slice");
});

test("cursor: chunk 0 reports more, the final chunk reports done; looping covers every row once", async () => {
  // Chunk 0 cursor.
  const first = await sendTestBatchChunkCore(
    USER,
    { recipientSetId, templateId, testAddress: TEST_ADDRESS, offset: 0 },
    stubTransport({ verifyOk: true }),
  );
  assert.equal(first.ok, true);
  if (first.ok) {
    assert.equal(first.data.total, ROW_COUNT);
    assert.equal(first.data.nextOffset, TEST_SEND_CHUNK_SIZE);
    assert.equal(first.data.done, false);
  }

  // Drive the whole batch the way the client will, collecting every merged subject.
  const seenNames = new Set<string>();
  let offset = 0;
  let done = false;
  let guard = 0;
  while (!done && guard++ < 100) {
    const stub = stubTransport({ verifyOk: true });
    const res = await sendTestBatchChunkCore(
      USER,
      { recipientSetId, templateId, testAddress: TEST_ADDRESS, offset },
      stub,
    );
    assert.equal(res.ok, true);
    if (!res.ok) break;
    for (const m of stub.sent) seenNames.add(m.subject);
    offset = res.data.nextOffset;
    done = res.data.done;
  }
  assert.equal(seenNames.size, ROW_COUNT, "every row is sent exactly once across the loop");
  for (let i = 0; i < ROW_COUNT; i++) {
    assert.ok(seenNames.has(`Hi name${i}`), `row ${i} must be covered`);
  }
});

test("a per-row send failure is isolated: the row lands in failed/errors, the rest still send", async () => {
  // Throw on the 4th send (index 3) of chunk 0.
  const stub = stubTransport({ verifyOk: true, failOnSend: 3, sendMessage: "550 nope" });
  const result = await sendTestBatchChunkCore(
    USER,
    { recipientSetId, templateId, testAddress: TEST_ADDRESS, offset: 0 },
    stub,
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.sent, TEST_SEND_CHUNK_SIZE - 1, "the other rows still send");
    assert.equal(result.data.failed, 1);
    assert.equal(result.data.errors.length, 1);
    assert.equal(typeof result.data.errors[0], "string", "errors are message strings, never raw Errors");
  }
  // Every row was still attempted — one failure does not abort the chunk.
  assert.equal(stub.calls.send, TEST_SEND_CHUNK_SIZE);
});

test("redaction: no result field ever carries the decrypted password (T-5-CRED)", async () => {
  const stub = stubTransport({ verifyOk: true, failOnSend: 0, sendMessage: "550 fail" });
  const result = await sendTestBatchChunkCore(
    USER,
    { recipientSetId, templateId, testAddress: TEST_ADDRESS, offset: 0 },
    stub,
  );
  assert.ok(
    !JSON.stringify(result).includes(MARKER_PASSWORD),
    "the serialized result must never contain the SMTP password",
  );
});

test("a NaN/0/negative id fails as a validation error (never resolves a bogus row)", async () => {
  const result = await sendTestBatchChunkCore(
    USER,
    { recipientSetId: 0, templateId, testAddress: TEST_ADDRESS, offset: 0 },
    stubTransport({ verifyOk: true }),
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.kind === "validation");
});
