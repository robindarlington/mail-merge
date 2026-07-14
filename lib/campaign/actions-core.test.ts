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

// Dynamic imports so the env vars above are in effect at module-eval time.
const { db, connection } = await import("@/lib/db");
const {
  sendTestBatchChunkCore,
  prepareCampaignCore,
  buildConfirmSummaryCore,
  enqueueCampaignCore,
} = await import("./actions-core");
const { TEST_SEND_CHUNK_SIZE } = await import("./schema");
const { createRecipientSet } = await import("../data/recipients");
const { createTemplate } = await import("../data/templates");
const { createSmtpConfig } = await import("../data/smtp");
const { getCampaignForUser } = await import("../data/campaigns");
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
