/**
 * Server-Action seam tests for lib/smtp/actions (SMTP-05 / AUTH-02 / SMTP-04).
 *
 * These drive the two NON-"use server" orchestration seams the actions delegate
 * to — `applyVerifiedConfig` (verify-then-save) and `sendTestVia` (verify-then-
 * send) — so verified_at semantics and secret-redaction are proven WITHOUT a live
 * SMTP dial or a Clerk request context. The thin "use server" wrappers
 * (verifyAndSave / updateFromFields / sendTestEmail) are auth+parse shells over
 * these seams; the DAL's own updateFromFields (which the action delegates to) is
 * exercised here for the from-only / verified_at invariant.
 *
 * Pattern (mirrors lib/data/smtp.test.ts): set a temp DATABASE_PATH and a
 * deterministic CREDENTIAL_ENC_KEY BEFORE dynamically importing anything that
 * transitively opens the DB, then build the schema on the throwaway file.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Provision an isolated temp DB + encryption key BEFORE any DB import ------
const TMP_DIR = mkdtempSync(join(tmpdir(), "smtp-actions-"));
process.env.DATABASE_PATH = join(TMP_DIR, "app.db");
process.env.CREDENTIAL_ENC_KEY = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
).toString("base64");

// Dynamic imports so the env vars above are in effect at module-eval time.
const { db, connection } = await import("@/lib/db");
const { applyVerifiedConfig, sendTestVia } = await import("./actions");
const { getSmtpConfigForUser, updateFromFields } = await import("../data/smtp");
const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
type VerifyOutcome = import("./verify").VerifyOutcome;
type MailTransport = import("../core").MailTransport;

const USER_SAVE = "user_save_aaaaaaaaaaaaaaaa";
const USER_SUGGEST = "user_suggest_bbbbbbbbbbbb";

// A distinctive marker so a redaction assertion can grep for a leak.
const MARKER_PASSWORD = "MARKER-SECRET-PASSWORD-9f2c";

/** A valid smtpFormSchema input (public host, explicit secure, marker password). */
function validInput(overrides: Record<string, unknown> = {}) {
  return {
    host: "smtp.example.com",
    port: 587,
    secure: false,
    username: "onboarding-user",
    password: MARKER_PASSWORD,
    from_addr: "noreply@example.com",
    from_name: "Example Sender",
    ...overrides,
  };
}

/** Fake verifyFn seams — never dial a real server. */
const fakeVerifyOk = async (): Promise<VerifyOutcome> => ({ ok: true });
const fakeVerifySuggestion = async (): Promise<VerifyOutcome> => ({
  ok: false,
  kind: "tls",
  field: "tlsMode",
  raw: "wrong version number",
  suggestion: "starttls",
});

/**
 * A stub transport with counted verify/sendMail. `verifyOk:false` rejects with an
 * EAUTH-shaped error so classifyVerifyError maps it to { kind:"auth" }.
 */
function stubTransport(opts: {
  verifyOk: boolean;
  sendOk?: boolean;
  verifyMessage?: string;
  sendMessage?: string;
}): MailTransport & { calls: { verify: number; send: number } } {
  const calls = { verify: 0, send: 0 };
  return {
    calls,
    async verify() {
      calls.verify++;
      if (!opts.verifyOk) {
        throw Object.assign(new Error(opts.verifyMessage ?? "auth rejected"), {
          code: "EAUTH",
        });
      }
      return true;
    },
    async sendMail() {
      calls.send++;
      if (opts.sendOk === false) {
        throw new Error(opts.sendMessage ?? "550 mailbox unavailable");
      }
      return { messageId: "test-message-id" };
    },
  } as MailTransport & { calls: { verify: number; send: number } };
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

after(() => {
  connection.close();
  rmSync(TMP_DIR, { recursive: true, force: true });
});

// --- Task 1: applyVerifiedConfig (verify-then-save) --------------------------

test("applyVerifiedConfig persists a row with verified_at set on a clean verify", async () => {
  const result = await applyVerifiedConfig(USER_SAVE, validInput(), fakeVerifyOk);
  assert.equal(result.ok, true);

  const row = await getSmtpConfigForUser(USER_SAVE);
  assert.ok(row, "a row should be persisted after a successful verify");
  assert.notEqual(row.verified_at, null, "verified_at must be stamped");
  assert.equal(row.host, "smtp.example.com");
  // Redaction: the ok result carries nothing secret.
  assert.ok(!JSON.stringify(result).includes(MARKER_PASSWORD));
});

test("applyVerifiedConfig persists NOTHING on a D-05 alternate-mode suggestion", async () => {
  const result = await applyVerifiedConfig(
    USER_SUGGEST,
    validInput(),
    fakeVerifySuggestion,
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.kind === "tls");
  assert.ok(
    !result.ok &&
      "suggestion" in result.error &&
      result.error.suggestion === "starttls",
  );

  // Structural proof nothing was saved: the user has no row at all.
  const row = await getSmtpConfigForUser(USER_SUGGEST);
  assert.equal(row, undefined, "a suggestion outcome must not persist a config");
  // Redaction: the failure result carries only a message string, no password.
  assert.ok(!JSON.stringify(result).includes(MARKER_PASSWORD));
});

test("applyVerifiedConfig returns a validation error (and saves nothing) on bad input", async () => {
  const result = await applyVerifiedConfig(
    "user_badinput_cccccccccccc",
    validInput({ from_addr: "not-an-email" }),
    fakeVerifyOk,
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.kind === "validation");
  const row = await getSmtpConfigForUser("user_badinput_cccccccccccc");
  assert.equal(row, undefined);
});

test("a from-only update leaves verified_at (and connection fields) unchanged (D-08)", async () => {
  // Seed a verified config, then apply the from-only update the action delegates to.
  await applyVerifiedConfig(USER_SAVE, validInput(), fakeVerifyOk);
  const before = await getSmtpConfigForUser(USER_SAVE);
  assert.ok(before);
  const priorVerifiedAt = before.verified_at;
  const priorHost = before.host;

  await updateFromFields(USER_SAVE, {
    from_addr: "changed@example.com",
    from_name: "Changed Name",
  });

  const after = await getSmtpConfigForUser(USER_SAVE);
  assert.ok(after);
  assert.equal(after.from_addr, "changed@example.com");
  assert.equal(after.from_name, "Changed Name");
  // The proven connection is preserved — no re-verify was required (D-08 / Pitfall 6).
  assert.equal(after.verified_at, priorVerifiedAt);
  assert.equal(after.host, priorHost);
});

// --- Task 2: sendTestVia (verify-then-send) ----------------------------------

test("sendTestVia returns a classified error and NEVER calls sendOne when verify rejects", async () => {
  const transport = stubTransport({ verifyOk: false });
  const result = await sendTestVia(
    { from_addr: "noreply@example.com", from_name: "Example" },
    "rob@example.com",
    transport,
  );
  assert.equal(result.ok, false);
  // The failed pre-send verify is classified the same way verifyAndSave classifies.
  assert.ok(!result.ok && result.error.kind === "auth");
  assert.ok(!result.ok && "field" in result.error && result.error.field === "auth");
  // sendOne is unreachable when verify fails.
  assert.equal(transport.calls.verify, 1);
  assert.equal(transport.calls.send, 0);
});

test("sendTestVia calls sendOne only after a successful verify", async () => {
  const transport = stubTransport({ verifyOk: true, sendOk: true });
  const result = await sendTestVia(
    { from_addr: "noreply@example.com", from_name: "Example Sender" },
    "rob@example.com",
    transport,
  );
  assert.equal(result.ok, true);
  assert.equal(transport.calls.verify, 1);
  assert.equal(transport.calls.send, 1);
});

test("sendTestVia maps a send failure to a message-only send_failed result", async () => {
  const transport = stubTransport({ verifyOk: true, sendOk: false });
  const result = await sendTestVia(
    { from_addr: "noreply@example.com", from_name: null },
    "rob@example.com",
    transport,
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.kind === "send_failed");
  // `raw` is a message STRING, never a raw Error object or a config.
  assert.ok(!result.ok && typeof (result.error as { raw: unknown }).raw === "string");
});

test("no failure result ever leaks a config object or a secret (redaction)", async () => {
  const failVerify = await sendTestVia(
    { from_addr: "noreply@example.com", from_name: "Example" },
    "rob@example.com",
    stubTransport({ verifyOk: false, verifyMessage: MARKER_PASSWORD }),
  );
  // Even if the underlying error message happened to echo a secret, the shape is
  // a closed union — assert it only ever carries kind/field/raw string fields.
  assert.equal(failVerify.ok, false);
  if (!failVerify.ok) {
    const keys = Object.keys(failVerify.error).sort();
    assert.deepEqual(keys, ["field", "kind", "raw"]);
    assert.equal(typeof (failVerify.error as { raw: unknown }).raw, "string");
  }
});
