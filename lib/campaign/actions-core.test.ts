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
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";

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

// A small, deliberately-non-trivial fixture for the confirm-summary aggregates
// (TEST-02). Three rows:
//   1) alice@example.com,Alice,C1  — valid email, all merge values present
//   2) not-an-email,Bob,C2         — INVALID email (drives invalidEmailCount)
//   3) carol@example.com,,C3        — valid email but BLANK name (drives rowsWithGaps)
// Paired with a template referencing a {{typo}} token that is NOT a column, so the
// unknown-token union is non-empty. Together: recipientCount 3, invalidEmailCount 1,
// rowsWithGaps 1, unknownTokens ["typo"], sendableCount 2.
const SUMMARY_CSV_NAME = "summary-fixture.csv";
const SUMMARY_ROW_COUNT = 3;
const SUMMARY_INVALID = 1;
const SUMMARY_ROWS_WITH_GAPS = 1;
const SUMMARY_ROW1_EMAIL = "alice@example.com";
{
  const lines = [
    "email,name,code",
    `${SUMMARY_ROW1_EMAIL},Alice,C1`,
    "not-an-email,Bob,C2",
    "carol@example.com,,C3",
  ];
  writeFileSync(join(UPLOADS_DIR, SUMMARY_CSV_NAME), lines.join("\n"), "utf8");
}

// --- Per-row attachment fixtures (Plan 03) -----------------------------------
// A CSV that DESIGNATES an `attachment` column (auto-detected by name). Three rows:
//   1) alice@…,Alice,alice.pdf  — references an uploaded, on-disk file (a match)
//   2) bob@…,Bob,(empty)        — empty cell → send WITHOUT attachment (not a miss)
//   3) carol@…,Carol,ghost.pdf  — references a file that is never uploaded (a MISS)
const ATTACH_CSV_NAME = "attach-fixture.csv";
{
  const lines = [
    "email,name,attachment",
    "alice@example.com,Alice,alice.pdf",
    "bob@example.com,Bob,",
    "carol@example.com,Carol,ghost.pdf",
  ];
  writeFileSync(join(UPLOADS_DIR, ATTACH_CSV_NAME), lines.join("\n"), "utf8");
}

// A single-row CSV referencing report.pdf — the enqueue-block fixture: enqueue is
// blocked until report.pdf is uploaded (Task 2).
const ATTACH_BLOCK_CSV_NAME = "attach-block-fixture.csv";
{
  const lines = ["email,name,attachment", "dave@example.com,Dave,report.pdf"];
  writeFileSync(join(UPLOADS_DIR, ATTACH_BLOCK_CSV_NAME), lines.join("\n"), "utf8");
}

// A single-row CSV referencing big.pdf — the oversize fixture: big.pdf is present on
// disk but recorded with size_bytes over the per-message cap, so enqueue is blocked.
const ATTACH_OVERSIZE_CSV_NAME = "attach-oversize-fixture.csv";
{
  const lines = ["email,name,attachment", "erin@example.com,Erin,big.pdf"];
  writeFileSync(join(UPLOADS_DIR, ATTACH_OVERSIZE_CSV_NAME), lines.join("\n"), "utf8");
}

// A CSV with an unterminated quote — a genuine structural misparse (MissingQuotes)
// that drives buildConfirmSummaryCore to `parse_error`. The enqueue gate (WR-04)
// must BLOCK the draft→queued flip on this, never fall through to the DAL flip.
const PARSE_ERROR_CSV_NAME = "parse-error-fixture.csv";
{
  const lines = ["email,name", 'alice@example.com,"Alice', "bob@example.com,Bob"];
  writeFileSync(join(UPLOADS_DIR, PARSE_ERROR_CSV_NAME), lines.join("\n"), "utf8");
}

// Dynamic imports so the env vars above are in effect at module-eval time.
const { db, connection } = await import("@/lib/db");
const { campaigns, send_records, attachments } = await import("@/lib/db/schema");
const {
  sendTestBatchChunkCore,
  prepareCampaignCore,
  buildConfirmSummaryCore,
  enqueueCampaignCore,
  getCampaignProgressCore,
  deleteCampaignCore,
} = await import("./actions-core");
const { TEST_SEND_CHUNK_SIZE } = await import("./schema");
const { createRecipientSet } = await import("../data/recipients");
const { createTemplate } = await import("../data/templates");
const { createSmtpConfig } = await import("../data/smtp");
const { getCampaignForUser, createDraftCampaign } = await import(
  "../data/campaigns"
);
const { createAttachment } = await import("../data/attachments");
const { writeAttachment, MAX_MESSAGE_BYTES } = await import("@/lib/attachments");
const { encrypt } = await import("../crypto");
const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
type MailTransport = import("../core").MailTransport;

const USER = "user_campaign_aaaaaaaaaaaa";
// A SECOND tenant used to prove IDOR isolation on prepare / summary / enqueue, and
// (having NO saved SMTP config) the no_smtp_config path of prepareCampaignCore.
const USER_B = "user_campaign_bbbbbbbbbbbb";
const TEST_ADDRESS = "inbox@test.example.com";

let recipientSetId: number;
let templateId: number;
// USER's chosen verified SMTP server (06.1 multi-server): threaded into every
// prepare / test-send call and asserted as the stamped campaign FK.
let smtpConfigId: number;
// Confirm-summary fixture ids (owned by USER): the 3-row set + a {{typo}} template.
let summarySetId: number;
let summaryTemplateId: number;
// USER_B's own set + template + its OWN verified server — used to prove IDOR
// isolation: USER proposing USER_B's smtpConfigId must resolve to not_found.
let userBSetId: number;
let userBTemplateId: number;
let userBSmtpConfigId: number;

// Count campaign rows owned by a user directly (bypasses the userId-scoped DAL) so
// a test can assert prepareCampaignCore created NOTHING on a rejected path.
function campaignCountFor(userId: string): number {
  const row = connection
    .prepare("SELECT COUNT(*) AS n FROM campaigns WHERE user_id = ?")
    .get(userId) as { n: number };
  return row.n;
}

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
  // The committed 0003/0004 migrations promote smtp_configs to many-rows-per-user
  // (drop the single-row unique index, add label/is_default/deleted_at, add the
  // partial one-default-per-user index). createSmtpConfig is a plain insert now, so
  // no manual conflict-target index is needed (06.1 multi-server).
  migrate(db, { migrationsFolder: "./drizzle" });
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
  const [cfg] = await createSmtpConfig(USER, {
    label: "Primary",
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
  smtpConfigId = cfg.id;

  // Confirm-summary fixture (owned by USER): the 3-row set with a bad email + a
  // blank merge value, and a template whose body references an unknown {{typo}}.
  const [summarySet] = await createRecipientSet(USER, {
    filename: "summary-fixture.csv",
    columns_json: JSON.stringify(["email", "name", "code"]),
    row_count: SUMMARY_ROW_COUNT,
    storage_path: SUMMARY_CSV_NAME,
    email_column: "email",
  });
  summarySetId = summarySet.id;

  const [summaryTpl] = await createTemplate(USER, {
    subject: "Hi {{name}}",
    body: "Your code {{code}} {{typo}}",
  });
  summaryTemplateId = summaryTpl.id;

  // USER_B's own set + template + its OWN verified server — used to prove
  // cross-tenant isolation on prepare/summary/enqueue AND that USER cannot send
  // through USER_B's smtpConfigId (owner re-resolve → not_found).
  const [setB] = await createRecipientSet(USER_B, {
    filename: "summary-fixture.csv",
    columns_json: JSON.stringify(["email", "name", "code"]),
    row_count: SUMMARY_ROW_COUNT,
    storage_path: SUMMARY_CSV_NAME,
    email_column: "email",
  });
  userBSetId = setB.id;
  const [tplB] = await createTemplate(USER_B, {
    subject: "Hi {{name}}",
    body: "Your code {{code}}",
  });
  userBTemplateId = tplB.id;

  const bCred = encrypt("USER-B-SECRET");
  const [cfgB] = await createSmtpConfig(USER_B, {
    label: "B Primary",
    host: "smtp.b.example.com",
    port: 587,
    secure: false,
    username: "sender-b",
    password_enc: bCred.enc,
    password_iv: bCred.iv,
    password_tag: bCred.tag,
    from_addr: "noreply@b.example.com",
    from_name: "B Sender",
  });
  userBSmtpConfigId = cfgB.id;

  assert.ok(recipientSetId > 0);
  assert.ok(templateId > 0);
  assert.ok(smtpConfigId > 0);
  assert.ok(summarySetId > 0);
  assert.ok(summaryTemplateId > 0);
  assert.ok(userBSetId > 0);
  assert.ok(userBTemplateId > 0);
  assert.ok(userBSmtpConfigId > 0);
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
    { recipientSetId, templateId, smtpConfigId, testAddress: TEST_ADDRESS, offset: 0 },
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
    { recipientSetId, templateId, smtpConfigId, testAddress: TEST_ADDRESS, offset: 0 },
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
    { recipientSetId, templateId, smtpConfigId, testAddress: TEST_ADDRESS, offset: 0 },
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
      smtpConfigId,
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
    { recipientSetId, templateId, smtpConfigId, testAddress: TEST_ADDRESS, offset: 0 },
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
      { recipientSetId, templateId, smtpConfigId, testAddress: TEST_ADDRESS, offset },
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
    { recipientSetId, templateId, smtpConfigId, testAddress: TEST_ADDRESS, offset: 0 },
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
    { recipientSetId, templateId, smtpConfigId, testAddress: TEST_ADDRESS, offset: 0 },
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
    { recipientSetId: 0, templateId, smtpConfigId, testAddress: TEST_ADDRESS, offset: 0 },
    stubTransport({ verifyOk: true }),
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.kind === "validation");
});

test("test-send is IDOR-safe on smtpConfigId: another tenant's server → not_found, nothing sent", async () => {
  // USER proposes USER_B's smtpConfigId — owner re-resolve → undefined → not_found
  // BEFORE any decrypt/verify/send (T-061-09).
  const stub = stubTransport({ verifyOk: true });
  const result = await sendTestBatchChunkCore(
    USER,
    {
      recipientSetId,
      templateId,
      smtpConfigId: userBSmtpConfigId,
      testAddress: TEST_ADDRESS,
      offset: 0,
    },
    stub,
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.kind === "not_found");
  assert.equal(stub.calls.verify, 0, "a cross-tenant server choice never dials");
  assert.equal(stub.calls.send, 0, "a cross-tenant server choice never sends");
});

// --- TEST-02 / TEST-03 confirmation-gate seam assertions ---------------------

test("prepareCampaignCore creates a draft campaign from the caller's FKs (A1/U7 timing)", async () => {
  const before = campaignCountFor(USER);
  const result = await prepareCampaignCore(USER, { recipientSetId, templateId, smtpConfigId });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.ok(result.data.campaignId > 0, "returns the created campaign id");
    // The row exists, is owned by the caller, wires the caller's FKs, and is draft.
    const row = await getCampaignForUser(USER, result.data.campaignId);
    assert.ok(row, "the draft campaign is readable by its owner");
    assert.equal(row!.status, "draft", "a freshly prepared campaign is a draft");
    assert.equal(row!.recipient_set_id, recipientSetId);
    assert.equal(row!.template_id, templateId);
    assert.equal(
      row!.smtp_config_id,
      smtpConfigId,
      "the stamped smtp_config_id equals the SELECTED verified server (06.1)",
    );
  }
  assert.equal(campaignCountFor(USER), before + 1, "exactly one draft was created");
});

test("prepareCampaignCore with a missing/invalid smtpConfigId fails as validation and creates nothing", async () => {
  const before = campaignCountFor(USER_B);
  // A missing server selection (0 fails the positive-int coercion) → validation,
  // NOT a bogus resolve. Under 06.1 the choice is required up front (SC2).
  const result = await prepareCampaignCore(USER_B, {
    recipientSetId: userBSetId,
    templateId: userBTemplateId,
    smtpConfigId: 0,
  });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.kind === "validation");
  assert.equal(campaignCountFor(USER_B), before, "no draft is created for an invalid server selection");
});

test("prepareCampaignCore is IDOR-safe on smtpConfigId: another tenant's server → not_found, no row created", async () => {
  const before = campaignCountFor(USER);
  // USER proposes USER_B's smtpConfigId — owner re-resolve returns undefined → not_found (T-061-09).
  const result = await prepareCampaignCore(USER, {
    recipientSetId,
    templateId,
    smtpConfigId: userBSmtpConfigId,
  });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.kind === "not_found");
  assert.equal(campaignCountFor(USER), before, "a cross-tenant server choice creates nothing");
});

test("prepareCampaignCore is IDOR-safe: another tenant's recipient set returns not_found, no row created", async () => {
  const before = campaignCountFor(USER);
  // USER tries to prepare against USER_B's recipient set → not_found (userId-scoped resolve).
  const result = await prepareCampaignCore(USER, {
    recipientSetId: userBSetId,
    templateId,
    smtpConfigId,
  });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.kind === "not_found");
  assert.equal(campaignCountFor(USER), before, "a cross-tenant prepare creates nothing");
});

test("buildConfirmSummaryCore recomputes every aggregate server-side from the campaign's FKs (TEST-02)", async () => {
  const prepared = await prepareCampaignCore(USER, {
    recipientSetId: summarySetId,
    templateId: summaryTemplateId,
    smtpConfigId,
  });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  const campaignId = prepared.data.campaignId;

  // The client passes ONLY the campaignId — no counts, no CSV, no template.
  const result = await buildConfirmSummaryCore(USER, { campaignId });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const s = result.data;

  assert.equal(s.campaignId, campaignId);
  assert.equal(s.recipientCount, SUMMARY_ROW_COUNT, "count === rows.length");
  assert.equal(s.invalidEmailCount, SUMMARY_INVALID, "server counts the one bad email");
  assert.equal(s.rowsWithGaps, SUMMARY_ROWS_WITH_GAPS, "server counts the blank-merge row");
  assert.deepEqual(s.unknownTokens, ["typo"], "the {{typo}} token is surfaced as unknown");
  assert.equal(
    s.sendableCount,
    SUMMARY_ROW_COUNT - SUMMARY_INVALID,
    "sendable === recipients − invalid",
  );

  // Sender identity comes from the REDACTED DTO (from_name <from_addr>).
  assert.equal(s.senderIdentity, "Example Sender <noreply@example.com>");

  // One merged sample for row 1: To is row1's email-column value; subject/body merged.
  assert.equal(s.sample.to, SUMMARY_ROW1_EMAIL, "sample To is row 1's email");
  assert.equal(s.sample.subject, "Hi Alice", "sample subject is merged for row 1");
  assert.equal(
    s.sample.body,
    "Your code C1 {{typo}}",
    "sample body is merged; the unknown token is left intact",
  );
});

test("buildConfirmSummaryCore is server-authoritative: a known-bad email is counted even though the client sends only an id", async () => {
  const prepared = await prepareCampaignCore(USER, {
    recipientSetId: summarySetId,
    templateId: summaryTemplateId,
    smtpConfigId,
  });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  const result = await buildConfirmSummaryCore(USER, {
    campaignId: prepared.data.campaignId,
  });
  assert.equal(result.ok, true);
  assert.ok(result.ok && result.data.invalidEmailCount >= 1, "the bad row is counted server-side");
});

test("buildConfirmSummaryCore redaction: the summary never carries the SMTP password (T-5-CRED)", async () => {
  const prepared = await prepareCampaignCore(USER, {
    recipientSetId: summarySetId,
    templateId: summaryTemplateId,
    smtpConfigId,
  });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  const result = await buildConfirmSummaryCore(USER, {
    campaignId: prepared.data.campaignId,
  });
  assert.ok(
    !JSON.stringify(result).includes(MARKER_PASSWORD),
    "the serialized summary must never contain the SMTP password",
  );
});

test("buildConfirmSummaryCore IDOR: another tenant's campaignId returns not_found", async () => {
  const prepared = await prepareCampaignCore(USER, {
    recipientSetId: summarySetId,
    templateId: summaryTemplateId,
    smtpConfigId,
  });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  // USER_B (a different tenant) cannot summarize USER's campaign.
  const result = await buildConfirmSummaryCore(USER_B, {
    campaignId: prepared.data.campaignId,
  });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.kind === "not_found");
});

// --- Plan 03: attachment presence/size in the confirm gate (Task 1) ----------
//
// buildConfirmSummaryCore must recompute the attachment aggregates server-side via
// the SHARED computeAttachmentMatch (never trusting the client), and prepare must
// IDEMPOTENTLY stamp the user's uploads onto the fresh draft (BLOCKER-1) so
// re-opening the send dialog never strands files on an abandoned draft.

test("buildConfirmSummaryCore reports attachment aggregates via the shared matcher", async () => {
  // A recipient set whose CSV designates an `attachment` column (auto-detected).
  const [set] = await createRecipientSet(USER, {
    filename: ATTACH_CSV_NAME,
    columns_json: JSON.stringify(["email", "name", "attachment"]),
    row_count: 3,
    storage_path: ATTACH_CSV_NAME,
    email_column: "email",
  });
  // Upload ONLY alice.pdf (present on disk). ghost.pdf is never uploaded → a miss.
  const { storagePath } = writeAttachment(Buffer.from("PDF-BYTES-alice"));
  await createAttachment(USER, {
    filename: "alice.pdf",
    storage_path: storagePath,
    size_bytes: 15,
  });

  const prepared = await prepareCampaignCore(USER, {
    recipientSetId: set.id,
    templateId,
    smtpConfigId,
  });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;

  const result = await buildConfirmSummaryCore(USER, {
    campaignId: prepared.data.campaignId,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const s = result.data;

  assert.equal(s.attachmentColumn, "attachment", "the attachment column is auto-detected");
  assert.equal(s.rowsWithAttachment, 1, "one row references an uploaded file");
  assert.equal(s.attachmentTotal, 1, "that file is present on disk");
  assert.equal(s.missingAttachmentCount, 1, "the ghost.pdf reference is a blocking miss");
  assert.ok(
    s.missingAttachmentFilenames.includes("ghost.pdf"),
    "the missing filename is surfaced (capped) for the UI",
  );
  assert.equal(s.oversizeRowCount, 0, "no row exceeds the per-message cap");
  assert.equal(
    s.sample.attachment,
    "alice.pdf",
    "row 1's sample carries its matched attachment filename",
  );
});

test("re-prepare re-claims attachments onto the fresh draft (BLOCKER-1: nothing stranded)", async () => {
  const [set] = await createRecipientSet(USER, {
    filename: ATTACH_CSV_NAME,
    columns_json: JSON.stringify(["email", "name", "attachment"]),
    row_count: 3,
    storage_path: ATTACH_CSV_NAME,
    email_column: "email",
  });
  const { storagePath } = writeAttachment(Buffer.from("PDF-BYTES-alice-2"));
  await createAttachment(USER, {
    filename: "alice.pdf",
    storage_path: storagePath,
    size_bytes: 15,
  });

  // First dialog open — draft C1 claims the attachment.
  const c1 = await prepareCampaignCore(USER, {
    recipientSetId: set.id,
    templateId,
    smtpConfigId,
  });
  assert.equal(c1.ok, true);
  if (!c1.ok) return;

  // Re-open the dialog — a NEW draft C2. The idempotent stamp must re-claim the
  // still-draft attachment onto C2 rather than stranding it on C1.
  const c2 = await prepareCampaignCore(USER, {
    recipientSetId: set.id,
    templateId,
    smtpConfigId,
  });
  assert.equal(c2.ok, true);
  if (!c2.ok) return;
  assert.notEqual(c2.data.campaignId, c1.data.campaignId, "each open mints a new draft");

  const summary = await buildConfirmSummaryCore(USER, {
    campaignId: c2.data.campaignId,
  });
  assert.equal(summary.ok, true);
  if (!summary.ok) return;
  assert.equal(
    summary.data.rowsWithAttachment,
    1,
    "the fresh draft still sees its attachment (not stranded on the abandoned C1)",
  );
  assert.equal(summary.data.sample.attachment, "alice.pdf");
});

test("no attachment column → every attachment field is the zero/empty case", async () => {
  // The summary fixture has no attachment column and none is detectable.
  const prepared = await prepareCampaignCore(USER, {
    recipientSetId: summarySetId,
    templateId: summaryTemplateId,
    smtpConfigId,
  });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  const result = await buildConfirmSummaryCore(USER, {
    campaignId: prepared.data.campaignId,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const s = result.data;
  assert.equal(s.attachmentColumn, null, "no column chosen and none detectable");
  assert.equal(s.rowsWithAttachment, 0);
  assert.equal(s.attachmentTotal, 0);
  assert.equal(s.missingAttachmentCount, 0);
  assert.deepEqual(s.missingAttachmentFilenames, []);
  assert.equal(s.oversizeRowCount, 0);
  assert.equal(s.sample.attachment, undefined, "no sample attachment without a column");
});

test("enqueueCampaignCore flips a draft to queued exactly once; a second confirm is already_queued (TEST-03)", async () => {
  const prepared = await prepareCampaignCore(USER, { recipientSetId, templateId, smtpConfigId });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  const campaignId = prepared.data.campaignId;

  const first = await enqueueCampaignCore(USER, { campaignId });
  assert.equal(first.ok, true, "the first confirm wins the transition");

  const second = await enqueueCampaignCore(USER, { campaignId });
  assert.equal(second.ok, false);
  assert.ok(
    !second.ok && second.error.kind === "already_queued",
    "a second confirm is a benign already_queued, never a duplicate transition",
  );
});

test("enqueueCampaignCore cross-tenant: another tenant's id is refused (already_queued) and the status is unchanged", async () => {
  const prepared = await prepareCampaignCore(USER, { recipientSetId, templateId, smtpConfigId });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  const campaignId = prepared.data.campaignId;

  const result = await enqueueCampaignCore(USER_B, { campaignId });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.kind === "already_queued", "0-row guard refuses the cross-tenant caller");

  // The owner's campaign is still a draft — the cross-tenant call changed nothing.
  const row = await getCampaignForUser(USER, campaignId);
  assert.ok(row && row.status === "draft", "the cross-tenant enqueue left the status untouched");
});

// --- Plan 03: enqueue is blocked on missing / oversize attachments (Task 2) ---
//
// enqueueCampaignCore re-runs the attachment gate server-side (never a dimmed
// client button, ATCH-02 / T-07-08). A referenced-but-missing file or an oversize
// row blocks the draft→queued flip; once resolved, enqueue succeeds.

test("enqueueCampaignCore blocks when a referenced file is missing; resolving it allows enqueue", async () => {
  const [set] = await createRecipientSet(USER, {
    filename: ATTACH_BLOCK_CSV_NAME,
    columns_json: JSON.stringify(["email", "name", "attachment"]),
    row_count: 1,
    storage_path: ATTACH_BLOCK_CSV_NAME,
    email_column: "email",
  });

  // report.pdf is NOT uploaded yet → the confirm gate sees a missing file.
  const c1 = await prepareCampaignCore(USER, {
    recipientSetId: set.id,
    templateId,
    smtpConfigId,
  });
  assert.equal(c1.ok, true);
  if (!c1.ok) return;

  const blocked = await enqueueCampaignCore(USER, { campaignId: c1.data.campaignId });
  assert.equal(blocked.ok, false);
  assert.ok(
    !blocked.ok && blocked.error.kind === "attachments_blocked",
    "a missing referenced file blocks enqueue server-side",
  );
  const stillDraft = await getCampaignForUser(USER, c1.data.campaignId);
  assert.ok(stillDraft && stillDraft.status === "draft", "the blocked campaign stays draft");

  // Upload the referenced file, then re-open the dialog (a fresh draft re-claims it).
  const { storagePath } = writeAttachment(Buffer.from("PDF-BYTES-report"));
  await createAttachment(USER, {
    filename: "report.pdf",
    storage_path: storagePath,
    size_bytes: 20,
  });
  const c2 = await prepareCampaignCore(USER, {
    recipientSetId: set.id,
    templateId,
    smtpConfigId,
  });
  assert.equal(c2.ok, true);
  if (!c2.ok) return;

  const ok = await enqueueCampaignCore(USER, { campaignId: c2.data.campaignId });
  assert.equal(ok.ok, true, "once every referenced file is present, enqueue succeeds");
  const queued = await getCampaignForUser(USER, c2.data.campaignId);
  assert.ok(queued && queued.status === "queued", "the campaign flips to queued");
});

test("enqueueCampaignCore blocks (never flips) when the confirm summary errors, e.g. parse_error (WR-04)", async () => {
  const [set] = await createRecipientSet(USER, {
    filename: PARSE_ERROR_CSV_NAME,
    columns_json: JSON.stringify(["email", "name"]),
    row_count: 2,
    storage_path: PARSE_ERROR_CSV_NAME,
    email_column: "email",
  });
  const prepared = await prepareCampaignCore(USER, {
    recipientSetId: set.id,
    templateId,
    smtpConfigId,
  });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;

  // The CSV is a structural misparse → the gate must return the failure, NOT enqueue.
  const blocked = await enqueueCampaignCore(USER, { campaignId: prepared.data.campaignId });
  assert.equal(blocked.ok, false);
  assert.ok(
    !blocked.ok && blocked.error.kind === "parse_error",
    "a summary parse_error blocks enqueue rather than falling through to the flip",
  );
  const stillDraft = await getCampaignForUser(USER, prepared.data.campaignId);
  assert.ok(
    stillDraft && stillDraft.status === "draft",
    "the campaign never flipped to queued while the gate could not run",
  );
});

test("enqueueCampaignCore blocks when a row's attachment exceeds the per-message limit", async () => {
  const [set] = await createRecipientSet(USER, {
    filename: ATTACH_OVERSIZE_CSV_NAME,
    columns_json: JSON.stringify(["email", "name", "attachment"]),
    row_count: 1,
    storage_path: ATTACH_OVERSIZE_CSV_NAME,
    email_column: "email",
  });
  // big.pdf is present on disk but recorded OVER the per-message cap.
  const { storagePath } = writeAttachment(Buffer.from("small-on-disk"));
  await createAttachment(USER, {
    filename: "big.pdf",
    storage_path: storagePath,
    size_bytes: MAX_MESSAGE_BYTES + 1,
  });

  const prepared = await prepareCampaignCore(USER, {
    recipientSetId: set.id,
    templateId,
    smtpConfigId,
  });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;

  const blocked = await enqueueCampaignCore(USER, {
    campaignId: prepared.data.campaignId,
  });
  assert.equal(blocked.ok, false);
  assert.ok(
    !blocked.ok && blocked.error.kind === "attachments_blocked",
    "an oversize row blocks enqueue server-side",
  );
  const row = await getCampaignForUser(USER, prepared.data.campaignId);
  assert.ok(row && row.status === "draft", "the oversize campaign stays draft");
});

// --- SEND-05 live-progress service seam --------------------------------------
//
// getCampaignProgressCore is the userId-scoped read the polling UI (Plan 05) and
// the export route (Plan 06) consume. It lives in this NON-"use server" module so
// it can accept a caller-supplied userId without being registered as a
// client-invocable endpoint (T-06-09); actions.ts wraps it behind auth().

test("getCampaignProgressCore rejects an invalid campaignId as a validation error", async () => {
  for (const bad of [0, -1, Number.NaN, "abc"]) {
    const result = await getCampaignProgressCore(USER, { campaignId: bad });
    assert.equal(result.ok, false);
    assert.ok(
      !result.ok && result.error.kind === "validation",
      `campaignId ${String(bad)} must fail as validation`,
    );
  }
});

test("getCampaignProgressCore returns remaining = total − sent − failed + the current recipient (owned)", async () => {
  const prepared = await prepareCampaignCore(USER, { recipientSetId, templateId, smtpConfigId });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  const campaignId = prepared.data.campaignId;

  // Drive a mixed running state: 10 total, 4 sent, 2 failed → 4 remaining.
  await db
    .update(campaigns)
    .set({ status: "running", total: 10, sent_count: 4, failed_count: 2 })
    .where(eq(campaigns.id, campaignId));
  await db.insert(send_records).values([
    { campaign_id: campaignId, to_addr: "done@example.com", merged_subject: "S", merged_body: "B", status: "sent" },
    { campaign_id: campaignId, to_addr: "live@example.com", merged_subject: "S", merged_body: "B", status: "sending" },
  ]);

  const result = await getCampaignProgressCore(USER, { campaignId });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.status, "running");
  assert.equal(result.data.total, 10);
  assert.equal(result.data.sent, 4);
  assert.equal(result.data.failed, 2);
  assert.equal(result.data.remaining, 4, "remaining = total − sent − failed");
  assert.equal(result.data.current, "live@example.com", "current = the lone 'sending' row's to_addr");
});

test("getCampaignProgressCore reports a null current when nothing is 'sending'", async () => {
  const prepared = await prepareCampaignCore(USER, { recipientSetId, templateId, smtpConfigId });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  const result = await getCampaignProgressCore(USER, { campaignId: prepared.data.campaignId });
  assert.equal(result.ok, true);
  assert.ok(result.ok && result.data.current === null, "a fresh draft has no in-flight recipient");
});

test("getCampaignProgressCore is IDOR-safe: another tenant's campaignId → not_found", async () => {
  const prepared = await prepareCampaignCore(USER, { recipientSetId, templateId, smtpConfigId });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  const result = await getCampaignProgressCore(USER_B, { campaignId: prepared.data.campaignId });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.kind === "not_found", "USER_B cannot read USER's progress");
});

// --- deleteCampaignCore (mdt): cascade + status/owner guards + file unlink -----
//
// A draft/completed/failed campaign owned by the caller is removed together with
// its attachment rows (the DAL's transactional cascade) and its attachment FILES
// are unlinked post-commit. A queued/running campaign is BLOCKED (in_use); a
// cross-tenant / unknown id → not_found. Each test creates its OWN draft so the
// shared seeded fixtures are never disturbed.

test("deleteCampaignCore removes a draft campaign, its attachment rows, and unlinks the attachment files (happy path)", async () => {
  const [camp] = await createDraftCampaign(USER, {
    recipient_set_id: recipientSetId,
    template_id: templateId,
    smtp_config_id: smtpConfigId,
  });
  await db.insert(send_records).values([
    { campaign_id: camp.id, to_addr: "one@example.com", merged_subject: "S", merged_body: "B", status: "sent" },
  ]);

  // Write real attachment files, then link their rows to the campaign.
  const a = writeAttachment(Buffer.from("PDF-A", "utf8"));
  const b = writeAttachment(Buffer.from("PDF-B", "utf8"));
  await db.insert(attachments).values([
    { userId: USER, campaign_id: camp.id, filename: "a.pdf", storage_path: a.storagePath, size_bytes: 5 },
    { userId: USER, campaign_id: camp.id, filename: "b.pdf", storage_path: b.storagePath, size_bytes: 5 },
  ]);
  const fileA = resolve(UPLOADS_DIR, a.storagePath);
  const fileB = resolve(UPLOADS_DIR, b.storagePath);
  assert.ok(existsSync(fileA) && existsSync(fileB), "attachment files exist before delete");

  const res = await deleteCampaignCore(USER, camp.id);
  assert.equal(res.ok, true, "a draft campaign is deletable");

  assert.equal(await getCampaignForUser(USER, camp.id), undefined, "campaign removed");
  const attsLeft = await db.query.attachments.findMany({
    where: eq(attachments.campaign_id, camp.id),
  });
  assert.equal(attsLeft.length, 0, "attachment rows cascaded");
  const recordsLeft = await db.query.send_records.findMany({
    where: eq(send_records.campaign_id, camp.id),
  });
  assert.equal(recordsLeft.length, 0, "send_records cascaded");
  assert.ok(!existsSync(fileA), "attachment file A unlinked");
  assert.ok(!existsSync(fileB), "attachment file B unlinked");
});

test("deleteCampaignCore returns in_use for a running campaign and removes nothing", async () => {
  const [camp] = await createDraftCampaign(USER, {
    recipient_set_id: recipientSetId,
    template_id: templateId,
    smtp_config_id: smtpConfigId,
  });
  await db.update(campaigns).set({ status: "running" }).where(eq(campaigns.id, camp.id));
  await db.insert(send_records).values([
    { campaign_id: camp.id, to_addr: "live@example.com", merged_subject: "S", merged_body: "B", status: "sending" },
  ]);

  const res = await deleteCampaignCore(USER, camp.id);
  assert.equal(res.ok, false, "an active campaign is refused");
  assert.ok(!res.ok && res.error.kind === "in_use");

  const still = await getCampaignForUser(USER, camp.id);
  assert.ok(still, "the active campaign survives");
  const records = await db.query.send_records.findMany({
    where: eq(send_records.campaign_id, camp.id),
  });
  assert.equal(records.length, 1, "send_records intact after a blocked delete");
});

test("deleteCampaignCore returns not_found for a cross-tenant id and removes nothing (IDOR)", async () => {
  const [camp] = await createDraftCampaign(USER, {
    recipient_set_id: recipientSetId,
    template_id: templateId,
    smtp_config_id: smtpConfigId,
  });

  const res = await deleteCampaignCore(USER_B, camp.id);
  assert.equal(res.ok, false, "a cross-tenant delete is refused");
  assert.ok(!res.ok && res.error.kind === "not_found");

  const still = await getCampaignForUser(USER, camp.id);
  assert.ok(still, "the owner's campaign survives a cross-tenant delete");
});

test("deleteCampaignCore returns not_found for an unknown id", async () => {
  const res = await deleteCampaignCore(USER, 9_999_999);
  assert.equal(res.ok, false);
  assert.ok(!res.ok && res.error.kind === "not_found");
});
